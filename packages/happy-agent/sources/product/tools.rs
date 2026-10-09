use super::{
    config::ConfigModule, history::HistoryModule, lifecycle::LifecycleModule, schemas::Schemas,
};
use anyhow::{Context, Result};
use happy_providers::{Block, Message, ToolDefinition};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
mod commands;
use commands::CommandSessions;

pub struct ToolsModule {
    history: Arc<HistoryModule>,
    schemas: Schemas,
    vendor: Vec<NativeTool>,
    common: Vec<NativeTool>,
    commands: Arc<CommandSessions>,
}
struct NativeTool {
    definition: ToolDefinition,
    implementation: Implementation,
}
enum Implementation {
    ExecCommand,
    WriteStdin,
    KillSession,
    ReadHistory,
}
pub struct ToolOutcome {
    pub message: Message,
}
#[async_trait::async_trait]
impl happy_agent_base::AgentModule for ToolsModule {
    fn name(&self) -> &'static str {
        "compute"
    }
    fn tools(&self, _scope: &happy_agent_base::AgentScope<'_>) -> Vec<ToolDefinition> {
        self.tools()
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        self.definition(call).map(|_| self.reloadable(call))
    }
    async fn execute_tool(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        self.definition(call)?;
        Some(
            self.execute(scope.id, scope.configuration, scope.settings, call, cancel)
                .await
                .message,
        )
    }
    async fn permission_changed(&self, agent: &str, previous: &str, next: &str) {
        self.permission_changed(agent, previous, next).await;
    }
    async fn close(&self) {
        self.close().await;
    }
}
impl ToolsModule {
    pub fn new(
        config: Arc<ConfigModule>,
        history: Arc<HistoryModule>,
        lifecycle: Arc<LifecycleModule>,
    ) -> Result<Self> {
        let definitions: std::collections::BTreeMap<String, Vec<ToolDefinition>> =
            serde_json::from_str(include_str!("tool_definitions.json"))?;
        let codex = definitions
            .get("codex")
            .context("The native command definitions are missing.")?;
        anyhow::ensure!(
            codex.len() == 3,
            "The native command definitions are incomplete."
        );
        Ok(Self {
            history,
            schemas: Schemas::new()?,
            commands: Arc::new(CommandSessions::new(config, lifecycle)),
            vendor: [
                Implementation::ExecCommand,
                Implementation::WriteStdin,
                Implementation::KillSession,
            ]
            .into_iter()
            .zip(codex)
            .map(|(implementation, definition)| NativeTool {
                definition: definition.clone(),
                implementation,
            })
            .collect(),
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
    pub async fn close(&self) {
        self.commands.close().await;
    }
    pub async fn permission_changed(&self, agent: &str, previous: &str, next: &str) {
        let rank = |mode: &str| match mode {
            "read_only" => 0,
            "workspace_write" => 1,
            "auto" => 2,
            _ => 3,
        };
        if rank(next) < rank(previous) {
            self.commands.stop_agent(agent).await;
        }
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
                    self.exec_command(agent, configuration, settings, call, cancel)
                        .await
                }
                Some(Implementation::WriteStdin) => {
                    self.write_stdin(agent, settings, call, cancel).await
                }
                Some(Implementation::KillSession) => self.kill_session(agent, call).await,
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
    fn arguments(&self, call: &Value, schema: &str, message: &str) -> Result<Value> {
        let arguments: Value = serde_json::from_str(
            call["call"]["arguments"]
                .as_str()
                .context("The tool arguments are missing.")?,
        )?;
        anyhow::ensure!(self.schemas.valid(schema, &arguments)?, "{message}");
        Ok(arguments)
    }
    fn mode<'a>(&self, settings: &'a Value) -> Result<&'a str> {
        let mode = settings["permissionMode"].as_str().unwrap_or("auto");
        anyhow::ensure!(
            self.schemas.valid("permissionMode", &json!(mode))?,
            "The permission mode is invalid."
        );
        Ok(mode)
    }
    async fn exec_command(
        &self,
        agent: &str,
        configuration: &Value,
        settings: &Value,
        call: &Value,
        cancel: CancellationToken,
    ) -> Result<(String, bool)> {
        let arguments =
            self.arguments(call, "execCommand", "The command arguments are invalid.")?;
        let mode = self.mode(settings)?;
        // Each definition owns review and elevation independently. An escalation
        // argument never widens Read only or Workspace write.
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
        let result = self
            .commands
            .start(agent, configuration, mode, &arguments, cancel)
            .await?;
        self.output(&result)
    }
    async fn write_stdin(
        &self,
        agent: &str,
        settings: &Value,
        call: &Value,
        cancel: CancellationToken,
    ) -> Result<(String, bool)> {
        let arguments = self.arguments(
            call,
            "writeStdin",
            "The command input arguments are invalid.",
        )?;
        let session = self.session_id(&arguments)?;
        let typing = arguments["chars"]
            .as_str()
            .is_some_and(|chars| !chars.is_empty());
        anyhow::ensure!(
            self.mode(settings)? != "auto" || !typing,
            "Automatic review is unavailable for this action; it has not been proven safe to execute."
        );
        let result = self
            .commands
            .input(agent, session, &arguments, cancel)
            .await?;
        self.output(&result)
    }
    async fn kill_session(&self, agent: &str, call: &Value) -> Result<(String, bool)> {
        let arguments = self.arguments(
            call,
            "killSession",
            "The command stop arguments are invalid.",
        )?;
        let session = self.session_id(&arguments)?;
        let (command, stopped) = self.commands.stop(agent, session).await?;
        Ok((
            format!(
                "{} Session {session}: {command}",
                if stopped {
                    "The shell session was stopped."
                } else {
                    "The shell session had already ended by itself."
                }
            ),
            false,
        ))
    }
    fn session_id(&self, arguments: &Value) -> Result<u64> {
        anyhow::ensure!(
            self.schemas
                .valid("commandSessionId", &arguments["session_id"])?,
            "The shell session identifier must be a whole number above zero."
        );
        arguments["session_id"]
            .as_u64()
            .or_else(|| arguments["session_id"].as_f64().map(|value| value as u64))
            .context("The shell session identity is missing.")
    }
    fn output(&self, result: &Value) -> Result<(String, bool)> {
        anyhow::ensure!(
            self.schemas.valid("unifiedExecOutput", result)?,
            "The command result is invalid."
        );
        let mut sections = vec![format!(
            "Wall time: {:.4} seconds",
            result["wall_time_seconds"].as_f64().unwrap_or(0.0)
        )];
        if let Some(code) = result["exit_code"].as_i64() {
            sections.push(format!("Process exited with code {code}"));
        } else if let Some(session) = result["session_id"].as_u64() {
            sections.push(format!("Process running with session ID {session}"));
        } else {
            sections.push(
                "Process ended without an exit code, which is what a stopped session looks like"
                    .into(),
            );
        }
        if let Some(tokens) = result["original_token_count"].as_u64() {
            sections.push(format!("Original token count: {tokens}"));
        }
        sections.push("Output:".into());
        sections.push(
            result["output"]
                .as_str()
                .filter(|output| !output.is_empty())
                .unwrap_or("(no new output)")
                .into(),
        );
        Ok((
            sections.join("\n"),
            result["exit_code"].as_i64().is_some_and(|code| code != 0),
        ))
    }
}
