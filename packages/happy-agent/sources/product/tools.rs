use super::{config::ConfigModule, history::HistoryModule, schemas::Schemas};
use anyhow::{Context, Result};
use happy_providers::{Block, Message, ToolDefinition};
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::Arc, time::Instant};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

pub struct ToolsModule {
    config: Arc<ConfigModule>,
    history: Arc<HistoryModule>,
    schemas: Schemas,
    vendor: Vec<NativeTool>,
    common: Vec<NativeTool>,
}
struct NativeTool {
    definition: ToolDefinition,
    implementation: Implementation,
}
enum Implementation {
    ExecCommand,
    ReadHistory,
}
pub struct ToolOutcome {
    pub message: Message,
}
impl ToolsModule {
    pub fn new(config: Arc<ConfigModule>, history: Arc<HistoryModule>) -> Result<Self> {
        let definitions: std::collections::BTreeMap<String, Vec<ToolDefinition>> =
            serde_json::from_str(include_str!("tool_definitions.json"))?;
        Ok(Self {
            config,
            history,
            schemas: Schemas::new()?,
            vendor: vec![NativeTool {
                definition: definitions
                    .get("codex")
                    .and_then(|tools| tools.first())
                    .context("The native command definition is missing.")?
                    .clone(),
                implementation: Implementation::ExecCommand,
            }],
            common: vec![NativeTool {
                definition: definitions
                    .get("common")
                    .and_then(|tools| tools.first())
                    .context("The common history definition is missing.")?
                    .clone(),
                implementation: Implementation::ReadHistory,
            }],
        })
    }
    pub fn vendor_tools(&self) -> Vec<ToolDefinition> {
        self.vendor
            .iter()
            .map(|tool| tool.definition.clone())
            .collect()
    }
    pub fn common_tools(&self) -> Vec<ToolDefinition> {
        self.common
            .iter()
            .map(|tool| tool.definition.clone())
            .collect()
    }
    pub fn tools(&self) -> Vec<ToolDefinition> {
        let mut tools = self.vendor_tools();
        tools.extend(self.common_tools());
        tools
    }
    fn definition(&self, call: &Value) -> Option<&NativeTool> {
        self.vendor.iter().chain(&self.common).find(|tool| {
            call["call"]["name"] == tool.definition.name
                && call["call"]["namespace"].as_str() == tool.definition.namespace.as_deref()
        })
    }
    pub fn reloadable(&self, call: &Value) -> bool {
        self.definition(call)
            .is_some_and(|tool| matches!(tool.implementation, Implementation::ReadHistory))
    }
    pub async fn execute(
        &self,
        agent: &str,
        configuration: &Value,
        settings: &Value,
        call: &Value,
        cancel: CancellationToken,
    ) -> ToolOutcome {
        let result = match self
            .history
            .validate_requested_arguments(
                agent,
                call["id"].as_str().unwrap_or(""),
                call["call"]["arguments"].as_str().unwrap_or(""),
            )
            .await
        {
            Err(error) => Err(error),
            Ok(()) => match self.definition(call).map(|tool| &tool.implementation) {
                Some(Implementation::ExecCommand) => {
                    self.exec_command(configuration, settings, call, cancel)
                        .await
                }
                Some(Implementation::ReadHistory) => {
                    match serde_json::from_str(call["call"]["arguments"].as_str().unwrap_or("")) {
                        Ok(arguments) => self
                            .history
                            .read_tool(agent, arguments)
                            .await
                            .map(|result| (result.to_string(), false)),
                        Err(error) => Err(error.into()),
                    }
                }
                _ => Err(anyhow::anyhow!("The requested tool is unavailable.")),
            },
        };
        let (output, is_error) = match result {
            Ok(value) => value,
            Err(error) => (format!("{error:#}"), true),
        };
        ToolOutcome {
            message: Message::Tool {
                call_id: call["id"].as_str().unwrap_or("").to_owned(),
                content: vec![Block::text(&output)],
                is_error,
                vendor: None,
            },
        }
    }
    async fn exec_command(
        &self,
        configuration: &Value,
        settings: &Value,
        call: &Value,
        cancel: CancellationToken,
    ) -> Result<(String, bool)> {
        let arguments: Value = serde_json::from_str(
            call["call"]["arguments"]
                .as_str()
                .context("The tool arguments are missing.")?,
        )?;
        anyhow::ensure!(
            self.schemas.valid("execCommand", &arguments)?,
            "The command arguments are invalid."
        );
        let mode = settings["permissionMode"].as_str().unwrap_or("auto");
        anyhow::ensure!(
            self.schemas.valid("permissionMode", &json!(mode))?,
            "The permission mode is invalid."
        );
        // This is the tool definition's own review policy. Review does not grant
        // host access, and a restricted mode never honors an elevation argument.
        let review = arguments["sandbox_permissions"] == "require_escalated"
            || arguments["secrets"]
                .as_array()
                .is_some_and(|secrets| !secrets.is_empty());
        anyhow::ensure!(
            mode != "auto" || !review,
            "Automatic review is unavailable for this action; it has not been proven safe to execute."
        );
        anyhow::ensure!(
            arguments["secrets"]
                .as_array()
                .is_none_or(|secrets| secrets.is_empty()),
            "Secret environment provisioning has not been migrated yet."
        );
        anyhow::ensure!(
            arguments["tty"] != true,
            "PTY command execution has not been migrated yet."
        );
        let environment = self
            .config
            .execution_environment(configuration, &arguments)?;
        let (root, cwd, shell) = (environment.root, environment.cwd, environment.shell);
        if mode != "full_access" {
            anyhow::ensure!(
                cwd.starts_with(&root),
                "The command's working directory is outside its workspace."
            );
        }
        let cmd = arguments["cmd"]
            .as_str()
            .context("The shell command is missing.")?;
        let policy = json!({"mode":mode,"allowedReadPaths":[],"allowedWritePaths":if mode=="workspace_write"||mode=="auto"{vec![root.clone()]}else{vec![]},"deniedReadPaths":[],"deniedWritePaths":if mode=="full_access"{vec![]}else{vec![root.join(".git"),root.join("AGENTS.md"),root.join("AGENTS_SECURITY.md"),root.join("happy.toml")]},"network":{"egress":mode=="full_access","allowedHosts":[],"localBinding":mode=="full_access"}});
        #[cfg(unix)]
        let command = happy_agent_supervisor::command()?;
        #[cfg(windows)]
        anyhow::bail!("Native Windows command execution has not been migrated yet.");
        #[cfg(unix)]
        {
            let mut command = Command::from(command);
            command
                .arg("--policy")
                .arg(policy.to_string())
                .arg("--")
                .arg(shell)
                .arg("-lc")
                .arg(cmd)
                .current_dir(&cwd)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            use std::os::unix::process::CommandExt;
            unsafe {
                command.as_std_mut().pre_exec(|| {
                    if libc::setsid() < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    #[cfg(target_os = "linux")]
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let began = Instant::now();
            let mut child = command.spawn()?;
            let pid = child
                .id()
                .context("The command process identity is unavailable.")?;
            let stdout = child
                .stdout
                .take()
                .context("The command output pipe is unavailable.")?;
            let stderr = child
                .stderr
                .take()
                .context("The command error pipe is unavailable.")?;
            let capture =
                tokio::spawn(async move { tokio::join!(capture(stdout), capture(stderr)) });
            let status = tokio::select! {
                status=child.wait()=>status?,
                _=cancel.cancelled()=>{
                    unsafe {libc::kill(-(pid as i32),libc::SIGKILL);}
                    let _=child.kill().await;let _=child.wait().await;
                    capture.abort();
                    anyhow::bail!("The command was interrupted.");
                },
            };
            let (stdout, stderr) = capture.await?;
            let (stdout, stdout_dropped) = stdout?;
            let (stderr, stderr_dropped) = stderr?;
            let produced = [stdout, stderr]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            let dropped = stdout_dropped + stderr_dropped;
            let output = if dropped > 0 {
                format!(
                    "[The machine dropped {dropped} bytes of this session's output as it ran.]\n{produced}"
                )
            } else {
                produced
            };
            let max = arguments["max_output_tokens"]
                .as_f64()
                .unwrap_or(10000.0)
                .min(10000.0)
                * 4.0;
            let max = (max.floor() as usize).max(4000);
            let output = truncate(&output, max);
            let output = format!(
                "Wall time: {:.4} seconds\nProcess exited with code {}\nOutput:\n{}",
                began.elapsed().as_secs_f64(),
                status
                    .code()
                    .map_or_else(|| "unknown".into(), |code| code.to_string()),
                if output.is_empty() {
                    "(no new output)"
                } else {
                    &output
                }
            );
            Ok((output, !status.success()))
        }
    }
}

async fn capture(mut reader: impl AsyncRead + Unpin) -> Result<(String, usize)> {
    let mut bytes = VecDeque::new();
    let mut dropped = 0;
    let mut buffer = [0; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        bytes.extend(&buffer[..count]);
        while bytes.len() > 1024 * 1024 {
            bytes.pop_front();
            dropped += 1;
        }
    }
    Ok((
        String::from_utf8_lossy(&bytes.into_iter().collect::<Vec<_>>()).into_owned(),
        dropped,
    ))
}
fn truncate(text: &str, limit: usize) -> String {
    if text.encode_utf16().count() <= limit {
        return text.into();
    }
    let mut head = String::new();
    let mut units = 0;
    for character in text.chars() {
        units += character.len_utf16();
        if units > limit / 2 {
            break;
        }
        head.push(character);
    }
    let mut tail = Vec::new();
    units = 0;
    for character in text.chars().rev() {
        units += character.len_utf16();
        if units > limit / 2 {
            break;
        }
        tail.push(character);
    }
    format!(
        "Warning: truncated output (original token count: {})\n{head}\n… output truncated …\n{}",
        text.len().div_ceil(4),
        tail.into_iter().rev().collect::<String>()
    )
}
