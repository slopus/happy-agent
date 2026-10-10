//! Docker's local Engine API. No shell, CLI configuration or ambient credentials
//! participate in reaching the explicitly selected Unix socket.
use anyhow::{Context as _, Result, ensure};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

const RESPONSE_LIMIT: usize = 1024 * 1024;
pub(super) const EXECUTABLE: &str = "/opt/happy-agent/compute";
pub(super) struct Engine {
    pub socket: PathBuf,
}
#[derive(Debug)]
pub(super) struct NotFound;
impl std::fmt::Display for NotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The selected Docker container does not exist.")
    }
}
impl std::error::Error for NotFound {}
impl Engine {
    #[cfg(unix)]
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: &Value,
        upgrade: bool,
    ) -> Result<hyper::Response<hyper::body::Incoming>> {
        let stream = tokio::net::UnixStream::connect(&self.socket)
            .await
            .with_context(|| {
                format!(
                    "The Docker engine socket {} is unavailable.",
                    self.socket.display()
                )
            })?;
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
        tokio::spawn(async move {
            let _ = connection.with_upgrades().await;
        });
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "localhost")
            .header("content-type", "application/json");
        if upgrade {
            request = request
                .header("connection", "Upgrade")
                .header("upgrade", "tcp");
        }
        let response = sender
            .send_request(request.body(Full::new(Bytes::from(serde_json::to_vec(body)?)))?)
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(NotFound.into());
        }
        // Engine diagnostics can include supplied environment values. Never relay
        // an arbitrary daemon response into the conversation or a public error.
        ensure!(
            response.status().is_success() || response.status() == StatusCode::SWITCHING_PROTOCOLS,
            "The Docker engine refused {method} {path} (HTTP {}).",
            response.status().as_u16()
        );
        Ok(response)
    }
    #[cfg(not(unix))]
    async fn request(
        &self,
        _: &str,
        _: &str,
        _: &Value,
        _: bool,
    ) -> Result<hyper::Response<hyper::body::Incoming>> {
        anyhow::bail!(
            "Native Docker compute requires a Linux executable and a local Docker Unix socket."
        )
    }
    pub async fn call(&self, method: &str, path: &str, body: &Value) -> Result<Value> {
        tokio::time::timeout(Duration::from_secs(20), async {
            let response = self.request(method, path, body, false).await?;
            let mut body = response.into_body();
            let mut bytes = Vec::new();
            while let Some(frame) = body.frame().await {
                let frame = frame?;
                if let Some(data) = frame.data_ref() {
                    ensure!(
                        bytes.len() + data.len() <= RESPONSE_LIMIT,
                        "The Docker engine response exceeds its byte bound."
                    );
                    bytes.extend_from_slice(data);
                }
            }
            Ok(if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes)?
            })
        })
        .await
        .context("The Docker engine request timed out; its outcome is unproven.")?
    }
    pub async fn attach(&self, exec: &str) -> Result<TokioIo<hyper::upgrade::Upgraded>> {
        let path = format!("/exec/{}/start", component(exec));
        tokio::time::timeout(Duration::from_secs(20), async {
            let response = self
                .request("POST", &path, &json!({"Detach":false,"Tty":false}), true)
                .await?;
            ensure!(
                response.status() == StatusCode::SWITCHING_PROTOCOLS,
                "The Docker engine did not supply its authenticated execution stream."
            );
            Ok(TokioIo::new(hyper::upgrade::on(response).await?))
        })
        .await
        .context("The Docker execution stream did not become available in time.")?
    }
    pub async fn create_worker(&self, container: &str) -> Result<String> {
        let request = json!({"AttachStdin":true,"AttachStdout":true,"AttachStderr":true,"Tty":false,"Cmd":[EXECUTABLE,"container-worker"],"Env":["HAPPY_CONTAINER_WORKER=1"],"WorkingDir":"/"});
        let exec = self
            .call(
                "POST",
                &format!("/containers/{}/exec", component(container)),
                &request,
            )
            .await?;
        let id = exec["Id"]
            .as_str()
            .context("The Docker engine did not return an execution identity.")?
            .to_owned();
        Ok(id)
    }
    pub async fn wait_worker(&self, exec: &str) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let details = self
                    .call(
                        "GET",
                        &format!("/exec/{}/json", component(exec)),
                        &Value::Null,
                    )
                    .await?;
                if details["Running"] == false {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .context("The Docker worker's process cleanup could not be confirmed.")?
    }
}
pub(super) fn component(text: &str) -> String {
    form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// Docker nonterminal output has an eight-byte multiplex header. Read exactly
/// the declared bytes, even when TCP splits one header or coalesces many chunks.
pub(super) async fn stdout<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    mut input: R,
    mut output: W,
    cancel: CancellationToken,
) -> Result<()> {
    let work = async {
        let mut diagnostics = 0usize;
        let mut buffer = [0u8; 65536];
        loop {
            let mut header = [0u8; 8];
            if input.read(&mut header[..1]).await? == 0 {
                return Ok(());
            }
            input.read_exact(&mut header[1..]).await?;
            ensure!(
                header[1..4] == [0, 0, 0] && matches!(header[0], 1 | 2),
                "The Docker engine sent an invalid output header."
            );
            let mut remaining = u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;
            ensure!(
                remaining <= 16 * 1024 * 1024,
                "The Docker engine output chunk exceeds its bound."
            );
            while remaining > 0 {
                let chunk = remaining.min(buffer.len());
                input.read_exact(&mut buffer[..chunk]).await?;
                if header[0] == 1 {
                    output.write_all(&buffer[..chunk]).await?;
                } else {
                    diagnostics = diagnostics.saturating_add(chunk);
                    ensure!(
                        diagnostics <= 64 * 1024,
                        "The container worker could not start. The selected image must run this Linux executable, including its required system libraries."
                    );
                }
                remaining -= chunk;
            }
        }
    };
    tokio::select! {result=work=>result,_=cancel.cancelled()=>Ok(())}
}
