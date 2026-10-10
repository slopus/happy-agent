//! A runner-owned MCP program, with bounded framing and immediate connection closure.
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::super::owners::{RunnerProgram, RunnersModule};
use super::protocol::{McpError, Transport, TransportEvent, TransportEvents};

const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const QUEUED_MESSAGES: usize = 8;

pub(super) struct RunnerStdioTransport {
    program: Arc<RunnerProgram>,
    lifetime: CancellationToken,
    closed: CancellationToken,
}

fn program_options(config: &Value) -> Value {
    let mut options = json!({"command":config["command"],"args":config.get("args").cloned().unwrap_or_else(|| json!([]))});
    if let Some(cwd) = config.get("cwd") {
        options["cwd"] = cwd.clone();
    }
    if let Some(environment) = config.get("env") {
        options["environment"] = environment.clone();
    }
    options
}

impl RunnerStdioTransport {
    pub async fn start(
        runners: &Arc<RunnersModule>,
        runner: &str,
        config: &Value,
        lifetime: &CancellationToken,
    ) -> Result<(Arc<Self>, TransportEvents), String> {
        let program = runners
            .product_process(runner, &program_options(config), lifetime)
            .await
            .map_err(|error| error.to_string())?;
        let mut stdout = match program.take_stdout() {
            Ok(stdout) => stdout,
            Err(error) => {
                let _ = program.close().await;
                return Err(error.to_string());
            }
        };
        let closed = CancellationToken::new();
        let (events, messages) = mpsc::channel(QUEUED_MESSAGES);
        tokio::spawn({
            let (program, closed, lifetime) = (program.clone(), closed.clone(), lifetime.clone());
            async move {
                let read = async {
                    let mut pending = Vec::new();
                    while let Ok(Some(chunk)) = stdout.recv().await {
                        for part in chunk.split_inclusive(|byte| *byte == b'\n') {
                            if pending.len() + part.len() > MAX_LINE_BYTES {
                                return;
                            }
                            pending.extend_from_slice(part);
                            if part.last() != Some(&b'\n') {
                                continue;
                            }
                            let text = String::from_utf8_lossy(&pending[..pending.len() - 1]);
                            let text = text.strip_suffix('\r').unwrap_or(&text);
                            if let Ok(message) = serde_json::from_str::<Value>(text) {
                                if events.send(TransportEvent::Message(message)).await.is_err() {
                                    return;
                                }
                            }
                            pending.clear();
                        }
                    }
                    // Exit, not just stdout EOF, ends a server's connection.
                    let _ = program.wait().await;
                };
                let cancelled = tokio::select! {
                    biased;
                    _ = closed.cancelled() => true,
                    _ = lifetime.cancelled() => true,
                    _ = read => false,
                };
                if cancelled {
                    closed.cancel();
                }
                // Natural exit preserves replies already queued before EOF. Explicit close
                // cancels above, so pending calls still fail before bounded process cleanup.
                drop(events);
                let _ = program.close().await;
            }
        });
        let transport = Arc::new(Self {
            program,
            lifetime: lifetime.clone(),
            closed: closed.clone(),
        });
        Ok((transport, TransportEvents::Bounded { messages, closed }))
    }
}

#[async_trait]
impl Transport for RunnerStdioTransport {
    async fn send(&self, message: Value) -> Result<(), McpError> {
        if self.closed.is_cancelled() {
            return Err(McpError::plain("The MCP server has exited."));
        }
        let mut line = super::super::text::js_json_stringify(&message).into_bytes();
        line.push(b'\n');
        match self.program.write(&line, &self.lifetime).await {
            Ok(true) => Ok(()),
            Ok(false) => Err(McpError::plain("The MCP server has exited.")),
            Err(error) => Err(McpError::plain(error.to_string())),
        }
    }

    async fn close(&self) {
        // Pending RPCs end before the runner's bounded process cleanup can wait for a reconnect.
        self.closed.cancel();
        let _ = self.program.close().await;
    }
}
