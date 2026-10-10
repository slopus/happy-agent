use super::{
    config::{ConfigModule, ToolVendor},
    history::HistoryModule,
    lifecycle::LifecycleModule,
    schemas::Schemas,
};
use anyhow::{Context, Result, ensure};
use happy_providers::{Block, Message, ToolDefinition};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
mod commands;
mod files;
pub use files::ComputeFilesystem;
mod surface;
use commands::CommandSessions;
pub use commands::{ProcessEventListener, ProcessSubscription};

pub struct ToolsModule {
    config: Arc<ConfigModule>,
    lifecycle: Arc<LifecycleModule>,
    history: Arc<HistoryModule>,
    schemas: Schemas,
    vendor: Vec<VendorTools>,
    common: Vec<NativeTool>,
    commands: Arc<CommandSessions>,
    runtime: Arc<super::runtime::RuntimeModule>,
    secrets: Arc<super::secrets::SecretsModule>,
    services: Arc<super::services::ServicesModule>,
    events: Arc<super::events::EventsModule>,
    runners: Arc<super::owners::RunnersModule>,
    files: files::Files,
    prepared_reads:
        Arc<std::sync::Mutex<std::collections::BTreeMap<(String, String), PreparedFile>>>,
    prompted_abort_notices: std::sync::Mutex<std::collections::BTreeMap<String, String>>,
}
struct NativeTool {
    definition: ToolDefinition,
    implementation: Implementation,
    vendor: Option<ToolVendor>,
    durable: bool,
    reloadable: bool,
    steerable: bool,
}

pub fn compute_regex_worker() -> std::process::ExitCode {
    files::compute_regex_worker()
}
struct VendorTools {
    vendor: ToolVendor,
    ordinary: Vec<NativeTool>,
    reviewer: Vec<NativeTool>,
}
#[derive(Clone)]
struct PreparedFile {
    reads: Vec<Value>,
    presentation: Option<Value>,
}
#[derive(Clone, Copy)]
enum Implementation {
    ExecCommand,
    WriteStdin,
    KillSession,
    ReadHistory,
    ReadFile,
    WriteFile,
    EditFile,
    Glob,
    Grep,
    ListDirectory,
    ApplyPatch,
    ViewImage,
    ClaudeBash,
    ClaudeOutput,
    ClaudeInput,
    ClaudeStop,
    GrokCommand,
    GrokOutput,
    GrokInput,
    GrokStop,
    KimiBash,
    KimiOutput,
    KimiInput,
    KimiStop,
    KimiMedia,
}
pub struct ToolOutcome {
    pub message: Message,
}
#[async_trait::async_trait]
impl happy_agent_base::AgentModule for ToolsModule {
    fn name(&self) -> &'static str {
        "compute"
    }
    fn tools(&self, scope: &happy_agent_base::AgentScope<'_>) -> Vec<ToolDefinition> {
        self.tools_for(scope.settings).unwrap_or_default()
    }
    async fn available_tools(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
    ) -> Result<Vec<ToolDefinition>> {
        self.tools_for(scope.settings)
    }
    fn before_tool_result(
        &self,
        ctx: &happy_agent_base::DatabaseContext<'_>,
        scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
        result: &Message,
    ) -> Result<()> {
        let key = (
            scope.id.to_owned(),
            call["id"]
                .as_str()
                .context("The tool identity is missing.")?
                .to_owned(),
        );
        let read = self
            .prepared_reads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&key)
            .cloned();
        if let Some(read) = read {
            if !matches!(result, Message::Tool { is_error: true, .. }) {
                for read in &read.reads {
                    self.files.record(ctx, scope.id, read)?;
                }
                if let Some(presentation) = &read.presentation {
                    self.history
                        .record_tool_presentation(ctx, scope.id, &key.1, presentation)?;
                }
            }
            let prepared = self.prepared_reads.clone();
            ctx.after_commit(move || {
                prepared
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&key);
            })?;
        }
        Ok(())
    }
    async fn instructions(&self, scope: &happy_agent_base::AgentScope<'_>) -> Result<String> {
        let id = scope.id.to_owned();
        let notice = self
            .runtime
            .transact(move |ctx| ctx.value("", &abort_notice_key(&id)))
            .await?;
        let Some(notice) = notice else {
            self.prompted_abort_notices
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(scope.id);
            return Ok(String::new());
        };
        anyhow::ensure!(
            self.schemas.valid("computeAbortNotice", &notice)?,
            "The stored compute abort notice is invalid."
        );
        self.prompted_abort_notices
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                scope.id.to_owned(),
                notice["id"].as_str().unwrap().to_owned(),
            );
        let count = notice["processTrees"].as_u64().unwrap();
        let sessions = notice["sessions"].as_array().unwrap();
        let mut lines = vec![format!(
            "The previous abort hard-killed {count} background process {} owned by this agent with SIGKILL.",
            if count == 1 { "tree" } else { "trees" }
        )];
        lines.extend(sessions.iter().map(|session| {
            format!(
                "- shell session {}: {}",
                session["sessionId"], session["command"]
            )
        }));
        let omitted = count.saturating_sub(sessions.len() as u64);
        if omitted > 0 {
            lines.push(format!(
                "- {omitted} additional process {}",
                if omitted == 1 { "tree" } else { "trees" }
            ));
        }
        Ok(lines.join("\n"))
    }
    fn before_inference(
        &self,
        ctx: &happy_agent_base::DatabaseContext<'_>,
        scope: &happy_agent_base::AgentScope<'_>,
        _inference: &str,
    ) -> Result<()> {
        let prompted = self
            .prompted_abort_notices
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(scope.id);
        if let Some(prompted) = prompted {
            let key = abort_notice_key(scope.id);
            if let Some(notice) = ctx.value("", &key)? {
                anyhow::ensure!(
                    self.schemas.valid("computeAbortNotice", &notice)?,
                    "The stored compute abort notice is invalid."
                );
                if notice["id"] == prompted {
                    ctx.database().execute(
                        "DELETE FROM happy_agent_values WHERE owner_id='' AND key=?1",
                        [&key],
                    )?;
                }
            }
        }
        Ok(())
    }
    fn created(
        &self,
        ctx: &happy_agent_base::DatabaseContext<'_>,
        scope: &happy_agent_base::AgentScope<'_>,
    ) -> Result<()> {
        ctx.database().execute(
            "DELETE FROM happy_agent_values WHERE owner_id='' AND key=?1",
            [abort_notice_key(scope.id)],
        )?;
        Ok(())
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        self.definition(call).map(|_| self.reloadable(call))
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        self.definition(call).map(|tool| tool.durable)
    }
    async fn before_tool(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
    ) -> Result<()> {
        if self
            .definition_for(scope.settings, call)?
            .is_some_and(|tool| !matches!(tool.implementation, Implementation::ReadHistory))
        {
            self.assert_local_compute(scope.configuration)?;
        }
        Ok(())
    }
    fn steerable(&self, call: &Value) -> Option<bool> {
        self.definition(call).map(|tool| tool.steerable)
    }
    fn permission_policy(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<happy_agent_base::ToolPermissionPolicy>> {
        match self.definition_for(scope.settings, call) {
            Ok(Some(tool)) => Some(self.policy(scope, call, tool)),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        }
    }
    async fn execute_tool(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        self.definition_for(scope.settings, call).ok().flatten()?;
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
    pub async fn skill_compute(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        cancel: &CancellationToken,
    ) -> Result<Option<ComputeFilesystem>> {
        ensure!(
            !scope.id.is_empty(),
            "The agent identity is unavailable for skill discovery."
        );
        let Some(configuration) = scope
            .configuration
            .get("modules")
            .and_then(|modules| modules.get("compute"))
        else {
            return Ok(None);
        };
        ensure!(
            self.schemas
                .valid("computeAgentConfiguration", configuration)?,
            "The agent's compute configuration is invalid."
        );
        if let Some(runner) = scope.configuration["modules"]["compute"]["runnerId"].as_str() {
            let compute = self
                .runners
                .agent_compute(runner, scope.id, scope.configuration, cancel)
                .await?;
            Ok(Some(ComputeFilesystem::runner(
                compute,
                self.mode(scope.settings)?,
            )?))
        } else {
            self.assert_local_compute(scope.configuration)?;
            Ok(Some(self.files.filesystem(
                scope.configuration,
                self.mode(scope.settings)?,
            )?))
        }
    }
    pub fn workflow_script_policy(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        path: &str,
    ) -> Result<happy_agent_base::ToolPermissionPolicy> {
        let remote = scope.configuration["modules"]["compute"]["runnerId"].is_string();
        let reviewed = remote || self.files.review(scope.configuration, path, false);
        Ok(happy_agent_base::ToolPermissionPolicy {
            should_review_in_auto_mode: reviewed,
            should_run_in_full_access_in_auto_mode: reviewed,
            requires_auto_or_full_access: false,
            action: if remote {
                format!(
                    "Reading workflow script {} on the agent's runner. Access: the runner's filesystem permissions; its canonical path has not yet been proven inside the workspace.",
                    json!(path)
                )
            } else {
                self.files.describe(
                    scope.configuration,
                    path,
                    "reading workflow script",
                    false,
                    false,
                )
            },
            instructions: None,
        })
    }
    pub async fn read_workflow_script(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        path: &str,
        cancel: &CancellationToken,
    ) -> Result<String> {
        if let Some(runner) = scope.configuration["modules"]["compute"]["runnerId"].as_str() {
            let compute = self
                .runners
                .agent_compute(runner, scope.id, scope.configuration, cancel)
                .await?;
            let path = compute.resolve(path)?;
            let permissions = compute.permissions(self.mode(scope.settings)?)?;
            let bytes = compute
                .read_file(&permissions, &path, 524_288 * 4, false, cancel)
                .await?;
            let text = String::from_utf8_lossy(&bytes).into_owned();
            ensure!(
                text.encode_utf16().count() <= 524_288,
                "The workflow script exceeds the character limit."
            );
            return Ok(text);
        }
        self.assert_local_compute(scope.configuration)?;
        self.files
            .read_workflow_script(
                scope.configuration,
                self.mode(scope.settings)?,
                path,
                cancel,
            )
            .await
    }
    pub fn new(
        config: Arc<ConfigModule>,
        history: Arc<HistoryModule>,
        lifecycle: Arc<LifecycleModule>,
        runtime: Arc<super::runtime::RuntimeModule>,
        secrets: Arc<super::secrets::SecretsModule>,
        services: Arc<super::services::ServicesModule>,
        events: Arc<super::events::EventsModule>,
        runners: Arc<super::owners::RunnersModule>,
    ) -> Result<Self> {
        let definitions: std::collections::BTreeMap<String, Vec<ToolDefinition>> =
            serde_json::from_str(include_str!("tool_definitions.json"))?;
        let vendor = surface::assemble(&definitions)?;
        let common = surface::common(&definitions)?;
        Ok(Self {
            config: config.clone(),
            lifecycle: lifecycle.clone(),
            history,
            schemas: Schemas::new()?,
            files: files::Files::new(config.clone(), runtime.clone())?,
            prepared_reads: Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::new())),
            commands: Arc::new(CommandSessions::new(
                config,
                lifecycle,
                runtime.clone(),
                secrets.clone(),
                events.clone(),
                runners.clone(),
            )?),
            runtime,
            secrets,
            services,
            events,
            runners,
            prompted_abort_notices: std::sync::Mutex::new(std::collections::BTreeMap::new()),
            vendor,
            common,
        })
    }
    pub fn reviewer(self: &Arc<Self>) -> Result<Arc<ReviewerToolsModule>> {
        Ok(Arc::new(ReviewerToolsModule {
            tools: Arc::new(Self::new(
                self.config.clone(),
                self.history.clone(),
                self.lifecycle.clone(),
                self.runtime.clone(),
                self.secrets.clone(),
                self.services.clone(),
                self.events.clone(),
                self.runners.clone(),
            )?),
        }))
    }
    pub async fn archive_agent(&self, agent: &str, cancel: &CancellationToken) -> Result<()> {
        self.prompted_abort_notices
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(agent);
        self.commands.archive_agent(agent, cancel).await?;
        self.runners.dispose_agent_compute(agent, cancel).await?;
        self.services.stop_owner_and_wait(agent, cancel).await
    }
    fn assert_local_compute(&self, configuration: &Value) -> Result<()> {
        ensure!(
            configuration["modules"]["compute"].get("docker").is_none()
                || configuration["modules"]["compute"]["runnerId"].is_string(),
            "Local Docker compute has not been migrated yet; this agent cannot execute on the host instead."
        );
        if let Some(runner) = configuration["modules"]["compute"]["runnerId"].as_str() {
            self.runners.place(Some(runner))?;
            anyhow::bail!(
                "The native tool cannot use this agent's runner until its owned compute connection is ready."
            );
        }
        anyhow::ensure!(
            !self.runners.enabled(),
            "Local execution is disabled while runners are configured."
        );
        Ok(())
    }
    pub fn list_processes(&self, agent: &str) -> Vec<Value> {
        self.commands.list_processes(agent)
    }
    pub fn running_processes(&self, agent: &str) -> usize {
        self.commands.running_processes(agent)
    }
    pub async fn stop_process(&self, agent: &str, id: &str) -> Result<Option<Value>> {
        self.commands.stop_process(agent, id).await
    }
    pub fn on_process_event(&self, listener: ProcessEventListener) -> Result<ProcessSubscription> {
        self.commands.on_process_event(listener)
    }
    pub fn process_agents(&self) -> Vec<String> {
        self.commands.process_agents()
    }
    pub fn record_abort_notice(
        &self,
        ctx: &super::runtime::Context<'_>,
        agent: &str,
    ) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        let sessions = self.commands.abort_snapshot(agent);
        let process_trees = self.commands.abort_process_trees(agent);
        if process_trees == 0 {
            return Ok(());
        }
        let notice = json!({"id":cuid2::create_id(),"killedAt":super::identity::now(),"processTrees":process_trees,"sessions":sessions.into_iter().take(16).map(|(id, command)| { let truncated = if command.encode_utf16().count() > 1000 { let mut units = 0; let mut prefix = String::new(); for character in command.chars() { if units + character.len_utf16() > 999 { break; } units += character.len_utf16(); prefix.push(character); } prefix.push('…'); prefix } else { command }; json!({"command":truncated,"sessionId":id}) }).collect::<Vec<_>>()});
        anyhow::ensure!(
            self.schemas.valid("computeAbortNotice", &notice)?,
            "The compute abort notice is invalid."
        );
        ctx.put_value("", &abort_notice_key(agent), &notice)
    }
    pub async fn hard_kill_agent_processes(&self, agent: &str) -> Result<()> {
        self.commands.hard_kill_agent(agent).await
    }
    fn policy(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
        tool: &NativeTool,
    ) -> Result<happy_agent_base::ToolPermissionPolicy> {
        if !matches!(
            tool.implementation,
            Implementation::ExecCommand
                | Implementation::WriteStdin
                | Implementation::KillSession
                | Implementation::ReadHistory
        ) {
            return self.surface_policy(scope, call, tool);
        }
        let mut review = false;
        let mut full = false;
        let action = match tool.implementation {
            Implementation::ExecCommand => {
                let arguments =
                    self.arguments(call, "execCommand", "The command arguments are invalid.")?;
                full = arguments["sandbox_permissions"] == "require_escalated";
                review = full
                    || arguments["secrets"]
                        .as_array()
                        .is_some_and(|secrets| !secrets.is_empty());
                let cmd = arguments["cmd"].to_string();
                let cwd = json!(
                    arguments["workdir"]
                        .as_str()
                        .or_else(|| scope.configuration["modules"]["compute"]["cwd"].as_str())
                        .or_else(|| scope.configuration["environment"]["workingDirectory"].as_str())
                        .context("The agent has no working directory.")?
                )
                .to_string();
                let shell = arguments.get("shell").map_or_else(
                    || json!("the machine's default shell").to_string(),
                    Value::to_string,
                );
                let mut action = format!(
                    "running {cmd}. Working directory: {cwd}. Shell: {shell}. Access: {}",
                    if full {
                        "unrestricted filesystem and network access outside the workspace sandbox"
                    } else {
                        "the current workspace sandbox"
                    }
                );
                if let Some(secrets) = arguments["secrets"]
                    .as_array()
                    .filter(|secrets| !secrets.is_empty())
                {
                    action.push_str(&format!(
                        ". Secret environment bundles: {}",
                        secrets
                            .iter()
                            .map(Value::to_string)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                } else {
                    action.push_str(". Secret environment bundles: none");
                }
                if let Some(reason) = arguments["justification"].as_str() {
                    action.push_str(&format!(". Reason given: {reason}"));
                }
                action
            }
            Implementation::WriteStdin => {
                let arguments = self.arguments(
                    call,
                    "writeStdin",
                    "The command input arguments are invalid.",
                )?;
                let chars = arguments["chars"].as_str().unwrap_or("");
                review = !chars.is_empty();
                format!(
                    "sending {} to shell session {}. Access: the session's existing execution boundary",
                    json!(chars),
                    arguments["session_id"]
                )
            }
            Implementation::KillSession => {
                self.arguments(
                    call,
                    "killSession",
                    "The command stop arguments are invalid.",
                )?;
                "stopping a shell session".into()
            }
            Implementation::ReadHistory => "reading saved agent history".into(),
            _ => unreachable!(),
        };
        Ok(happy_agent_base::ToolPermissionPolicy {
            should_review_in_auto_mode: review,
            should_run_in_full_access_in_auto_mode: full,
            requires_auto_or_full_access: false,
            action,
            instructions: self.guidance(tool),
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
            .find(|set| set.vendor == ToolVendor::Codex)
            .unwrap()
            .ordinary
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
    pub fn tools_for(&self, settings: &Value) -> Result<Vec<ToolDefinition>> {
        let vendor = self.config.compute_tool_vendor(settings)?;
        let mut tools = self
            .vendor
            .iter()
            .find(|set| set.vendor == vendor)
            .context("The compute vendor surface is missing.")?
            .ordinary
            .iter()
            .map(|tool| tool.definition.clone())
            .collect::<Vec<_>>();
        tools.extend(self.common_tools());
        Ok(tools)
    }
    fn definition_for(&self, settings: &Value, call: &Value) -> Result<Option<&NativeTool>> {
        let vendor = self.config.compute_tool_vendor(settings)?;
        Ok(self
            .vendor
            .iter()
            .find(|set| set.vendor == vendor)
            .context("The compute vendor surface is missing.")?
            .ordinary
            .iter()
            .chain(&self.common)
            .find(|tool| {
                call["call"]["name"] == tool.definition.name
                    && call["call"]["namespace"].as_str() == tool.definition.namespace.as_deref()
            }))
    }
    fn definition(&self, call: &Value) -> Option<&NativeTool> {
        self.vendor
            .iter()
            .flat_map(|set| &set.ordinary)
            .chain(&self.common)
            .find(|tool| {
                call["call"]["name"] == tool.definition.name
                    && call["call"]["namespace"].as_str() == tool.definition.namespace.as_deref()
            })
    }
    pub fn reloadable(&self, call: &Value) -> bool {
        self.definition(call).is_some_and(|tool| tool.reloadable)
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
            Ok(()) => match self.definition_for(settings, call) {
                Err(error) => Err(error),
                Ok(tool) => match tool.map(|tool| &tool.implementation) {
                    Some(Implementation::ExecCommand) => {
                        self.exec_command(agent, configuration, settings, call, cancel)
                            .await
                    }
                    Some(Implementation::WriteStdin) => {
                        self.write_stdin(agent, settings, call, cancel).await
                    }
                    Some(Implementation::KillSession) => self.kill_session(agent, call).await,
                    Some(Implementation::ReadHistory) => {
                        match serde_json::from_str(call["call"]["arguments"].as_str().unwrap_or(""))
                        {
                            Ok(arguments) => self
                                .history
                                .read_tool(agent, arguments)
                                .await
                                .map(|result| (result.to_string(), false)),
                            Err(error) => Err(error.into()),
                        }
                    }
                    Some(_) => {
                        let tool = tool.unwrap();
                        return self
                            .execute_surface(agent, configuration, settings, call, tool, cancel)
                            .await;
                    }
                    None => Err(anyhow::anyhow!("The requested tool is unavailable.")),
                },
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
        self.assert_local_compute(configuration)?;
        let arguments =
            self.arguments(call, "execCommand", "The command arguments are invalid.")?;
        let mode = self.mode(settings)?;
        // Each definition owns review and elevation independently. An escalation
        // argument never widens Read only or Workspace write.
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
        let mode = self.mode(settings)?;
        let result = self
            .commands
            .input_with_mode(agent, session, mode, &arguments, cancel)
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
fn abort_notice_key(agent: &str) -> String {
    format!("agentSystem.modules.compute.abort-notices.{agent}.pending")
}

pub struct ReviewerToolsModule {
    tools: Arc<ToolsModule>,
}
#[async_trait::async_trait]
impl happy_agent_base::AgentModule for ReviewerToolsModule {
    fn name(&self) -> &'static str {
        "autoReviewCompute"
    }
    fn tools(&self, scope: &happy_agent_base::AgentScope<'_>) -> Vec<ToolDefinition> {
        self.tools
            .reviewer_tools(scope.settings)
            .unwrap_or_default()
    }
    async fn available_tools(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
    ) -> Result<Vec<ToolDefinition>> {
        self.tools.reviewer_tools(scope.settings)
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        self.tools
            .vendor
            .iter()
            .flat_map(|set| &set.reviewer)
            .any(|tool| call["call"]["name"] == tool.definition.name)
            .then(|| self.tools.reloadable(call))
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        self.tools
            .vendor
            .iter()
            .flat_map(|set| &set.reviewer)
            .find(|tool| call["call"]["name"] == tool.definition.name)
            .map(|tool| tool.durable)
    }
    fn steerable(&self, call: &Value) -> Option<bool> {
        self.tools
            .vendor
            .iter()
            .flat_map(|set| &set.reviewer)
            .find(|tool| call["call"]["name"] == tool.definition.name)
            .map(|tool| tool.steerable)
    }
    async fn before_tool(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
    ) -> Result<()> {
        if self
            .tools
            .reviewer_definition(scope.settings, call)?
            .is_some()
        {
            self.tools.assert_local_compute(scope.configuration)?;
        }
        Ok(())
    }
    fn permission_policy(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<happy_agent_base::ToolPermissionPolicy>> {
        match self.tools.reviewer_definition(scope.settings, call) {
            Ok(Some(tool)) => Some(self.tools.policy(scope, call, tool)),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        }
    }
    fn before_tool_result(
        &self,
        ctx: &happy_agent_base::DatabaseContext<'_>,
        scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
        result: &Message,
    ) -> Result<()> {
        happy_agent_base::AgentModule::before_tool_result(
            self.tools.as_ref(),
            ctx,
            scope,
            call,
            result,
        )
    }
    async fn authorize_tool(
        &self,
        _scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
        policy: &happy_agent_base::ToolPermissionPolicy,
        _cancel: CancellationToken,
    ) -> Option<happy_agent_base::ToolAuthorization> {
        Some(if policy.requires_auto_or_full_access {
            happy_agent_base::ToolAuthorization::Denied {
                message: Message::Tool {
                    call_id: call["id"].as_str().unwrap_or("").into(),
                    content: vec![Block::text(
                        "This reviewer tool is unavailable in Read only mode.",
                    )],
                    is_error: true,
                    vendor: None,
                },
                stop_turn: false,
            }
        } else {
            happy_agent_base::ToolAuthorization::Continue { settings: None }
        })
    }
    async fn execute_tool(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        self.tools
            .reviewer_definition(scope.settings, call)
            .ok()
            .flatten()?;
        Some(
            self.tools
                .execute(scope.id, scope.configuration, scope.settings, call, cancel)
                .await
                .message,
        )
    }
    async fn close(&self) {
        self.tools.close().await;
    }
}
