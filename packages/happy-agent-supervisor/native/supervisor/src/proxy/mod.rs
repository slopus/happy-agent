//! The outgoing proxy the workload sees as ordinary loopback proxy endpoints.
//!
//! The supervisor owns both ends. Inside the jail, `http.rs` and `socks.rs` translate the proxy
//! protocols a client already speaks into `open_stream(host, port)` on a socketpair. Outside the
//! jail, `egress.rs` decides whether that destination is allowed, resolves it, and connects. No TLS
//! is unwrapped anywhere here and no certificate is ever minted here: the boundary is which host may
//! be reached, not what is sent to it.

pub(crate) mod egress;

mod bridge;
mod credential;
mod hosts;
mod http;
mod locks;
mod mux;
mod protocol;
mod socks;

pub(crate) use protocol::MAX_HOST_BYTES;

use crate::SupervisorResult;
use crate::exec::EnvironmentOverride;
use crate::policy::{OutgoingProxyPolicy, ProxyFrontEnd};
use credential::ProxyCredential;
use mux::Mux;
use std::ffi::OsString;
use std::fs::File;
use std::net::TcpListener;
use std::sync::Arc;

/// Listeners bound and the link greeted, but nothing serving yet.
///
/// Binding has to finish before the boundary that denies `bind` and `listen` is established, and
/// serving has to start after the workload is forked, so those two moments are separate.
pub(crate) struct OutgoingProxy {
    mux: Arc<Mux>,
    credential: Arc<ProxyCredential>,
    http: Option<TcpListener>,
    socks: Option<TcpListener>,
    environment: Vec<EnvironmentOverride>,
}

/// Binds the requested front-ends on loopback and greets the egress process.
///
/// An egress process that does not answer is an error, which stops the whole invocation. The
/// workload never falls back to reaching the network directly.
pub(crate) fn prepare(policy: &OutgoingProxyPolicy, link: File) -> SupervisorResult<OutgoingProxy> {
    let credential = Arc::new(ProxyCredential::generate()?);
    let http = bind_front_end(policy, ProxyFrontEnd::Http)?;
    let socks = bind_front_end(policy, ProxyFrontEnd::Socks5)?;
    let mux = Mux::connect(link)?;
    let environment = proxy_environment(&credential, http.as_ref(), socks.as_ref())?;
    Ok(OutgoingProxy {
        mux,
        credential,
        http,
        socks,
        environment,
    })
}

impl OutgoingProxy {
    /// The proxy variables the workload is executed with.
    pub(crate) fn environment(&self) -> &[EnvironmentOverride] {
        &self.environment
    }

    /// The loopback ports the workload is allowed to reach, for platforms whose policy is written
    /// in terms of addresses rather than namespaces.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn front_end_ports(&self) -> SupervisorResult<Vec<u16>> {
        let mut ports = Vec::new();
        for listener in [self.http.as_ref(), self.socks.as_ref()]
            .into_iter()
            .flatten()
        {
            ports.push(listener.local_addr()?.port());
        }
        Ok(ports)
    }

    /// Starts one accept loop per bound front-end. Each loop owns its listener until the process
    /// ends with the workload.
    pub(crate) fn serve(self) -> SupervisorResult<()> {
        self.serve_with_limit(usize::MAX)
    }

    pub(crate) fn serve_with_limit(self, max_connections: usize) -> SupervisorResult<()> {
        self.mux.start_reader()?;
        if let Some(listener) = self.http {
            let mux = Arc::clone(&self.mux);
            let credential = Arc::clone(&self.credential);
            spawn_accept_loop(
                "supervisor-proxy-http",
                listener,
                max_connections,
                move |stream| {
                    http::serve(&mux, &credential, stream);
                },
            )?;
        }
        if let Some(listener) = self.socks {
            let mux = Arc::clone(&self.mux);
            let credential = Arc::clone(&self.credential);
            spawn_accept_loop(
                "supervisor-proxy-socks",
                listener,
                max_connections,
                move |stream| {
                    socks::serve(&mux, &credential, stream);
                },
            )?;
        }
        Ok(())
    }
}

fn spawn_accept_loop(
    name: &str,
    listener: TcpListener,
    max_connections: usize,
    handle: impl Fn(std::net::TcpStream) + Send + Sync + 'static,
) -> SupervisorResult<()> {
    let handle = Arc::new(handle);
    let connection_name = format!("{name}-connection");
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            use std::sync::atomic::{AtomicUsize, Ordering};
            let active = Arc::new(AtomicUsize::new(0));
            loop {
                let Ok((stream, _)) = listener.accept() else {
                    // A listener that stops accepting cannot be repaired from inside the sandbox,
                    // and every front-end refusing is the safe end state.
                    return;
                };
                if active.fetch_add(1, Ordering::AcqRel) >= max_connections {
                    active.fetch_sub(1, Ordering::AcqRel);
                    drop(stream);
                    continue;
                }
                let count = Arc::clone(&active);
                let handle = Arc::clone(&handle);
                let spawned = std::thread::Builder::new()
                    .name(connection_name.clone())
                    .spawn(move || {
                        handle(stream);
                        count.fetch_sub(1, Ordering::AcqRel);
                    });
                if spawned.is_err() {
                    active.fetch_sub(1, Ordering::AcqRel);
                    return;
                }
            }
        })?;
    Ok(())
}

fn bind_front_end(
    policy: &OutgoingProxyPolicy,
    front_end: ProxyFrontEnd,
) -> SupervisorResult<Option<TcpListener>> {
    if !policy.exposes(front_end) {
        return Ok(None);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        std::io::Error::other(format!("bind the sandbox proxy front-end: {error}"))
    })?;
    Ok(Some(listener))
}

/// Every proxy variable the workload could act on, whether or not this policy offers a front-end
/// for it. A front-end that was not requested must arrive unset rather than inherited.
const HTTP_PROXY_VARIABLES: &[&str] = &["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"];
const SOCKS_PROXY_VARIABLES: &[&str] = &["ALL_PROXY", "all_proxy"];

fn proxy_environment(
    credential: &ProxyCredential,
    http: Option<&TcpListener>,
    socks: Option<&TcpListener>,
) -> SupervisorResult<Vec<EnvironmentOverride>> {
    let mut environment = Vec::new();
    // The secret travels with the address, so a client that can find the proxy can also
    // authenticate to it and nothing else on the machine can.
    let user_information = credential.url_user_information();
    let http_url = match http {
        Some(listener) => Some(format!(
            "http://{user_information}@127.0.0.1:{}",
            listener.local_addr()?.port()
        )),
        None => None,
    };
    for name in HTTP_PROXY_VARIABLES {
        environment.push((OsString::from(name), http_url.as_ref().map(OsString::from)));
    }
    environment.push((
        OsString::from("NODE_USE_ENV_PROXY"),
        http_url.as_ref().map(|_| OsString::from("1")),
    ));
    // `socks5h` keeps name resolution on the far side of the link.
    let socks_url = match socks {
        Some(listener) => Some(format!(
            "socks5h://{user_information}@127.0.0.1:{}",
            listener.local_addr()?.port()
        )),
        None => None,
    };
    for name in SOCKS_PROXY_VARIABLES {
        environment.push((OsString::from(name), socks_url.as_ref().map(OsString::from)));
    }
    // An inherited exemption list would carve a hole straight through the policy, so it is always
    // replaced rather than left alone.
    for name in ["NO_PROXY", "no_proxy"] {
        environment.push((OsString::from(name), Some(OsString::new())));
    }
    Ok(environment)
}
