//! A private controller socket inherited into the service network namespace.
use crate::service_policy::ServicePolicy;
use crate::{SupervisorResult, invalid_input};
use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

pub(super) struct ServiceBridge {
    listener: UnixListener,
    token: [u8; 64],
    port: u16,
    workload_started: fs::File,
}

impl ServiceBridge {
    pub(super) fn bind(policy: &ServicePolicy) -> SupervisorResult<Self> {
        let parent = policy
            .bridge_socket
            .parent()
            .ok_or_else(|| invalid_input("missing bridge parent"))?;
        let metadata = fs::symlink_metadata(parent)?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || parent.canonicalize()? != parent
        {
            return Err(invalid_input(
                "the service bridge directory must be private and owned by the daemon",
            )
            .into());
        }
        // Persist stable process identity before acquiring any service runtime resource.
        // A new daemon can distinguish this execution from a reused numeric PID.
        let mut identity = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(parent.join("process.json"))?;
        identity.write_all(lifetime_record(false, &[])?.to_string().as_bytes())?;
        identity.sync_all()?;
        let workload_started = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(parent.join("started"))?;
        let listener = UnixListener::bind(&policy.bridge_socket)?;
        fs::set_permissions(&policy.bridge_socket, fs::Permissions::from_mode(0o600))?;
        let token = policy
            .bridge_token
            .as_bytes()
            .try_into()
            .map_err(|_| invalid_input("invalid bridge token"))?;
        Ok(Self {
            listener,
            token,
            port: policy.port,
            workload_started,
        })
    }

    /// This descriptor is controller-private and close-on-exec; application output cannot
    /// impersonate the marker. Empty means setup never completed, 1 means command admission,
    /// and E means exec itself failed (distinct from the application's eventual exit code).
    pub(super) fn mark_workload(&self, value: u8) -> std::io::Result<()> {
        self.workload_started.write_all_at(&[value], 0)
    }

    /// Commit every mount/bridge-owning native process before releasing namespace setup.
    /// A crash before this atomic replacement leaves executionReady=false, which recovery
    /// must treat as incomplete evidence rather than proof that no children exist.
    pub(super) fn record_children(
        policy: &ServicePolicy,
        children: &[libc::pid_t],
    ) -> SupervisorResult<()> {
        let parent = policy
            .bridge_socket
            .parent()
            .ok_or_else(|| invalid_input("missing bridge parent"))?;
        let staging = parent.join("process-ready.json");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&staging)?;
        file.write_all(lifetime_record(true, children)?.to_string().as_bytes())?;
        file.sync_all()?;
        fs::rename(staging, parent.join("process.json"))?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    }

    /// Start after the workload has forked. Its exec closes the listener descriptor.
    pub(super) fn serve(self) -> SupervisorResult<()> {
        std::thread::Builder::new()
            .name("service-bridge".into())
            .spawn(move || {
                let active = Arc::new(AtomicUsize::new(0));
                for incoming in self.listener.incoming() {
                    let Ok(stream) = incoming else {
                        break;
                    };
                    if active.fetch_add(1, Ordering::AcqRel) >= 64 {
                        active.fetch_sub(1, Ordering::AcqRel);
                        drop(stream);
                        continue;
                    }
                    let count = Arc::clone(&active);
                    let token = self.token;
                    let port = self.port;
                    let worker = std::thread::Builder::new()
                        .name("service-connection".into())
                        .spawn(move || {
                            let _ = relay(stream, &token, port);
                            count.fetch_sub(1, Ordering::AcqRel);
                        });
                    if worker.is_err() {
                        active.fetch_sub(1, Ordering::AcqRel);
                    }
                }
            })?;
        Ok(())
    }
}

fn lifetime_record(ready: bool, children: &[libc::pid_t]) -> SupervisorResult<serde_json::Value> {
    let mut identity = process_identity(std::process::id() as libc::pid_t)?;
    identity["executionReady"] = serde_json::json!(ready);
    identity["children"] = serde_json::json!(
        children
            .iter()
            .map(|pid| process_identity(*pid))
            .collect::<SupervisorResult<Vec<_>>>()?
    );
    Ok(identity)
}

fn process_identity(pid: libc::pid_t) -> SupervisorResult<serde_json::Value> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let start_time = stat
        .rsplit_once(')')
        .and_then(|(_, fields)| fields.split_whitespace().nth(19))
        .ok_or_else(|| invalid_input("cannot record service native process lifetime"))?;
    Ok(serde_json::json!({ "pid": pid, "startTime": start_time }))
}

fn relay(mut controller: UnixStream, token: &[u8; 64], port: u16) -> std::io::Result<()> {
    controller.set_read_timeout(Some(Duration::from_secs(5)))?;
    controller.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut presented = [0; 64];
    controller.read_exact(&mut presented)?;
    let difference = presented
        .iter()
        .zip(token)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        });
    if difference != 0 {
        return Err(std::io::Error::other(
            "service bridge authentication failed",
        ));
    }
    let target = SocketAddr::from(([127, 0, 0, 1], port));
    let mut application = match TcpStream::connect_timeout(&target, Duration::from_secs(2)) {
        Ok(socket) => socket,
        Err(error) => {
            controller.write_all(&[0])?;
            return Err(error);
        }
    };
    controller.write_all(&[1])?;
    controller.set_read_timeout(None)?;
    controller.set_write_timeout(None)?;
    let mut outgoing = application.try_clone()?;
    let mut incoming = controller.try_clone()?;
    // Bounded buffers and blocking backpressure; no message accumulation.
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let _ = std::io::copy(&mut incoming, &mut outgoing);
            let _ = outgoing.shutdown(Shutdown::Both);
            let _ = incoming.shutdown(Shutdown::Both);
        });
        let _ = std::io::copy(&mut application, &mut controller);
        let _ = application.shutdown(Shutdown::Both);
        let _ = controller.shutdown(Shutdown::Both);
    });
    Ok(())
}
