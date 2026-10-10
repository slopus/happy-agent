//! A local MCP server spoken to over its standard input and output.
//!
//! The server is a child of the daemon. It inherits only the small environment the original's
//! SDK considered safe, plus what its configuration sets: the daemon's environment can hold
//! provider credentials, and an MCP server is outside the agent's sandbox. Each line of output is
//! one message; lines that are not JSON are skipped. Closing ends its input, then asks it to stop,
//! then stops it.

use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{Mutex, Notify, mpsc};

use super::protocol::{McpError, Transport, TransportEvent};

/// The variables a server inherits from the daemon, as the original's SDK chose them.
const INHERITED_ENVIRONMENT: [&str; 6] = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

const CLOSE_GRACE: Duration = Duration::from_secs(2);

pub(super) struct StdioTransport {
    stdin: Mutex<Option<ChildStdin>>,
    pid: Option<u32>,
    exited: Arc<AtomicBool>,
    exit: Arc<Notify>,
}

/// The way Node reported a failed spawn: `spawn <command> <code>`.
fn spawn_error(command: &str, error: &std::io::Error) -> String {
    let code = match error.raw_os_error() {
        Some(libc::ENOENT) => "ENOENT".to_string(),
        Some(libc::EACCES) => "EACCES".to_string(),
        Some(libc::ENOTDIR) => "ENOTDIR".to_string(),
        Some(libc::EPERM) => "EPERM".to_string(),
        _ => error.to_string(),
    };
    format!("spawn {command} {code}")
}

impl StdioTransport {
    pub fn spawn(config: &Value) -> Result<(Arc<StdioTransport>, mpsc::UnboundedReceiver<TransportEvent>), String> {
        let command_name = config["command"].as_str().unwrap_or_default();
        let mut command = Command::new(command_name);
        if let Some(args) = config.get("args").and_then(Value::as_array) {
            command.args(args.iter().filter_map(Value::as_str));
        }
        if let Some(cwd) = config.get("cwd").and_then(Value::as_str) {
            command.current_dir(cwd);
        }
        command.env_clear();
        for key in INHERITED_ENVIRONMENT {
            if let Ok(value) = std::env::var(key) {
                if !value.starts_with("()") {
                    command.env(key, value);
                }
            }
        }
        if let Some(environment) = config.get("env").and_then(Value::as_object) {
            for (key, value) in environment {
                if let Some(value) = value.as_str() {
                    command.env(key, value);
                }
            }
        }
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| spawn_error(command_name, &error))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let pid = child.id();
        let (events, receiver) = mpsc::unbounded_channel();
        let exited = Arc::new(AtomicBool::new(false));
        let exit = Arc::new(Notify::new());
        let reader = tokio::spawn({
            let events = events.clone();
            async move {
                let Some(stdout) = stdout else { return };
                let mut lines = BufReader::new(stdout);
                let mut line = Vec::new();
                loop {
                    line.clear();
                    match lines.read_until(b'\n', &mut line).await {
                        Ok(0) | Err(_) => return,
                        Ok(_) => {
                            let text = String::from_utf8_lossy(&line);
                            let text = text.strip_suffix('\n').unwrap_or(&text);
                            let text = text.strip_suffix('\r').unwrap_or(text);
                            if let Ok(message) = serde_json::from_str::<Value>(text) {
                                let _ = events.send(TransportEvent::Message(message));
                            }
                        }
                    }
                }
            }
        });
        if let Some(mut stderr) = stderr {
            tokio::spawn(async move {
                let mut buffer = [0u8; 8192];
                while matches!(stderr.read(&mut buffer).await, Ok(count) if count > 0) {}
            });
        }
        {
            let (exited, exit) = (exited.clone(), exit.clone());
            tokio::spawn(async move {
                let _ = child.wait().await;
                exited.store(true, Ordering::SeqCst);
                exit.notify_waiters();
                let _ = reader.await;
                let _ = events.send(TransportEvent::Closed);
            });
        }
        Ok((Arc::new(StdioTransport { stdin: Mutex::new(stdin), pid, exited, exit }), receiver))
    }

    async fn wait_for_exit(&self, within: Duration) -> bool {
        let notified = self.exit.notified();
        if self.exited.load(Ordering::SeqCst) {
            return true;
        }
        let _ = tokio::time::timeout(within, notified).await;
        self.exited.load(Ordering::SeqCst)
    }

    fn signal(&self, stop: Stop) {
        if self.exited.load(Ordering::SeqCst) {
            return;
        }
        let Some(pid) = self.pid else { return };
        #[cfg(unix)]
        {
            let signal = match stop {
                Stop::Terminate => libc::SIGTERM,
                Stop::Kill => libc::SIGKILL,
            };
            // The exit flag above narrows the window in which the pid could already be reaped.
            unsafe { libc::kill(pid as libc::pid_t, signal) };
        }
        #[cfg(windows)]
        {
            // Windows has no polite stop for a console child; Node's `kill` terminates it outright too.
            let _ = stop;
            let _ = std::process::Command::new("taskkill.exe").args(["/PID", &pid.to_string(), "/F"]).status();
        }
    }
}

#[derive(Clone, Copy)]
enum Stop {
    Terminate,
    Kill,
}

#[async_trait]
impl Transport for StdioTransport {
    async fn send(&self, message: Value) -> Result<(), McpError> {
        let mut stdin = self.stdin.lock().await;
        let Some(input) = stdin.as_mut() else { return Err(McpError::plain("Not connected")) };
        let mut line = super::super::text::js_json_stringify(&message).into_bytes();
        line.push(b'\n');
        input.write_all(&line).await.map_err(|error| McpError::plain(error.to_string()))?;
        input.flush().await.map_err(|error| McpError::plain(error.to_string()))
    }

    async fn close(&self) {
        let input = self.stdin.lock().await.take();
        let Some(mut input) = input else { return };
        let _ = input.shutdown().await;
        drop(input);
        if self.wait_for_exit(CLOSE_GRACE).await {
            return;
        }
        self.signal(Stop::Terminate);
        if self.wait_for_exit(CLOSE_GRACE).await {
            return;
        }
        self.signal(Stop::Kill);
    }
}
