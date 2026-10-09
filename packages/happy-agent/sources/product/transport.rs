use super::{api::ApiModule, config::ConfigModule};
use anyhow::{Context, Result, bail};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio::task::JoinSet;

pub struct TransportModule {
    config: Arc<ConfigModule>,
    api: Arc<ApiModule>,
    controls: Controls,
    #[cfg(unix)]
    listener: tokio::net::UnixListener,
    #[cfg(unix)]
    socket_identity: (u64, u64),
    #[cfg(windows)]
    listener: tokio::net::windows::named_pipe::NamedPipeServer,
}

impl TransportModule {
    pub async fn bind(config: Arc<ConfigModule>, api: Arc<ApiModule>) -> Result<Self> {
        config.prepare()?;
        if config.team_enabled() {
            super::filesystem::remove_missing_ok(&config.paths.token)?;
            bail!("The Rust team authentication and TCP transport migration is not yet complete.");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
            if config.paths.socket.as_os_str().as_encoded_bytes().len() > 103 {
                bail!("The Happy Agent socket path exceeds the supported Unix socket length.");
            }
            match std::fs::symlink_metadata(&config.paths.socket) {
                Ok(metadata) => {
                    if !metadata.file_type().is_socket()
                        || metadata.uid() != unsafe { libc::geteuid() }
                    {
                        bail!(
                            "Refusing to replace a socket path not owned by Happy Agent: {}",
                            config.paths.socket.display()
                        );
                    }
                    if tokio::net::UnixStream::connect(&config.paths.socket)
                        .await
                        .is_ok()
                    {
                        bail!("The Happy Agent socket is already in use.");
                    }
                    std::fs::remove_file(&config.paths.socket)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let listener = tokio::net::UnixListener::bind(&config.paths.socket)?;
            std::fs::set_permissions(&config.paths.socket, std::fs::Permissions::from_mode(0o600))?;
            let metadata = std::fs::symlink_metadata(&config.paths.socket)?;
            let transport = Self {
                config,
                api,
                listener,
                socket_identity: (metadata.dev(), metadata.ino()),
                controls: Controls::new()?,
            };
            transport.api.prepare_token()?;
            Ok(transport)
        }
        #[cfg(windows)]
        {
            let listener = tokio::net::windows::named_pipe::ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .create(&config.paths.socket)?;
            let transport = Self {
                config,
                api,
                listener,
                controls: Controls::new()?,
            };
            transport.api.prepare_token()?;
            Ok(transport)
        }
    }

    pub async fn serve(mut self) -> Result<()> {
        let mut connections = JoinSet::new();
        let limit = Arc::new(tokio::sync::Semaphore::new(256));
        loop {
            tokio::select! {
                biased;
                _=self.api.lifecycle.shutdown.cancelled()=>break,
                control=self.controls.next()=>{
                    if control==Control::Drain {self.api.begin_drain()?;}else{self.api.lifecycle.begin_shutdown();}
                },
                connection=accept(&mut self.listener,&self.config)=>{
                    let stream=connection?;
                    let Ok(permit)=limit.clone().try_acquire_owned()else{drop(stream);continue;};
                    let api=self.api.clone();
                    let shutdown=api.lifecycle.shutdown.clone();
                    connections.spawn(async move {
                        let _permit=permit;
                        let mut builder=hyper::server::conn::http1::Builder::new();
                        builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10)).max_headers(100);
                        let service=service_fn(move |request|api.clone().handle(request));
                        let connection=builder.serve_connection(TokioIo::new(stream),service).with_upgrades();
                        tokio::pin!(connection);
                        tokio::select! {
                            result=&mut connection=>{if let Err(error)=result{eprintln!("API connection ended: {error}");}},
                            _=shutdown.cancelled()=>{
                                connection.as_mut().graceful_shutdown();
                                let _=tokio::time::timeout(Duration::from_secs(5),connection).await;
                            },
                        }
                    });
                },
                _=connections.join_next(),if !connections.is_empty()=>{},
            }
        }
        while connections.join_next().await.is_some() {}
        Ok(())
    }
}

#[cfg(unix)]
async fn accept(
    listener: &mut tokio::net::UnixListener,
    _config: &ConfigModule,
) -> Result<tokio::net::UnixStream> {
    Ok(listener.accept().await?.0)
}
#[cfg(windows)]
async fn accept(
    listener: &mut tokio::net::windows::named_pipe::NamedPipeServer,
    config: &ConfigModule,
) -> Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    listener.connect().await?;
    let next = tokio::net::windows::named_pipe::ServerOptions::new()
        .reject_remote_clients(true)
        .create(&config.paths.socket)?;
    Ok(std::mem::replace(listener, next))
}

#[derive(PartialEq)]
enum Control {
    Drain,
    Shutdown,
}

struct Controls {
    #[cfg(unix)]
    interrupt: tokio::signal::unix::Signal,
    #[cfg(unix)]
    terminate: tokio::signal::unix::Signal,
    #[cfg(unix)]
    drain: tokio::signal::unix::Signal,
}
impl Controls {
    fn new() -> Result<Self> {
        Ok(Self {
            #[cfg(unix)]
            interrupt: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?,
            #[cfg(unix)]
            terminate: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?,
            #[cfg(unix)]
            drain: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::user_defined2())?,
        })
    }
    async fn next(&mut self) -> Control {
        #[cfg(unix)]
        {
            tokio::select! {
                _=self.interrupt.recv()=>Control::Shutdown,
                _=self.terminate.recv()=>Control::Shutdown,
                _=self.drain.recv()=>Control::Drain,
            }
        }
        #[cfg(windows)]
        {
            let _ = tokio::signal::ctrl_c().await;
            Control::Shutdown
        }
    }
}

impl Drop for TransportModule {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if std::fs::symlink_metadata(&self.config.paths.socket)
                .is_ok_and(|metadata| (metadata.dev(), metadata.ino()) == self.socket_identity)
            {
                let _ = std::fs::remove_file(&self.config.paths.socket);
            }
        }
    }
}

pub async fn request(
    config: &ConfigModule,
    token: &str,
    method: &str,
    path: &str,
) -> Result<(u16, Value)> {
    tokio::time::timeout(Duration::from_secs(2), async {
        #[cfg(unix)]
        let stream = tokio::net::UnixStream::connect(&config.paths.socket).await?;
        #[cfg(windows)]
        let stream =
            tokio::net::windows::named_pipe::ClientOptions::new().open(&config.paths.socket)?;
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
        let driver = tokio::spawn(async move {
            let _ = connection.await;
        });
        struct Driver(tokio::task::JoinHandle<()>);
        impl Drop for Driver {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let _driver = Driver(driver);
        let request = hyper::Request::builder()
            .method(method)
            .uri(path)
            .header("Host", "happy")
            .header("Authorization", format!("Bearer {token}"))
            .header("Connection", "close")
            .body(Full::new(Bytes::new()))?;
        let response = sender.send_request(request).await?;
        let status = response.status().as_u16();
        let bytes = http_body_util::Limited::new(response.into_body(), 1024 * 1024)
            .collect()
            .await
            .map_err(anyhow::Error::from_boxed)?
            .to_bytes();
        Ok((status, serde_json::from_slice(&bytes)?))
    })
    .await
    .context("The daemon did not respond within two seconds.")?
}
