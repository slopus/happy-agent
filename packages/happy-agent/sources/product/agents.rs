use super::{
    config::ConfigModule,
    events::EventsModule,
    history::HistoryModule,
    identity::{now, resource_version},
    lifecycle::LifecycleModule,
    projects::ProjectsModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
    tools::ToolsModule,
    usage::UsageModule,
    workspaces::WorkspacesModule,
};
use anyhow::{Context as _, Result};
use happy_agent_base::AgentSystem;
use serde_json::{Value, json};
use std::sync::Arc;

pub struct AgentSystemModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    events: Arc<EventsModule>,
    history: Arc<HistoryModule>,
    usage: Arc<UsageModule>,
    projects: Arc<ProjectsModule>,
    workspaces: Arc<WorkspacesModule>,
    system: Arc<AgentSystem>,
    schemas: Schemas,
}
#[derive(Debug)]
pub struct AgentRequestError {
    pub status: u16,
    pub code: &'static str,
    pub message: &'static str,
}
impl std::fmt::Display for AgentRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for AgentRequestError {}
fn request_error(status: u16, code: &'static str, message: &'static str) -> anyhow::Error {
    AgentRequestError {
        status,
        code,
        message,
    }
    .into()
}
impl AgentSystemModule {
    #[expect(clippy::too_many_arguments)]
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        events: Arc<EventsModule>,
        history: Arc<HistoryModule>,
        tools: Arc<ToolsModule>,
        usage: Arc<UsageModule>,
        lifecycle: Arc<LifecycleModule>,
        projects: Arc<ProjectsModule>,
        workspaces: Arc<WorkspacesModule>,
    ) -> Result<Self> {
        let system = Arc::new(AgentSystem::new(
            runtime.database(),
            vec![
                config.clone(),
                lifecycle,
                history.clone(),
                tools,
                usage.clone(),
            ],
        )?);
        Ok(Self {
            config,
            runtime,
            events,
            history,
            usage,
            projects,
            workspaces,
            system,
            schemas: Schemas::new()?,
        })
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.system.load().await
    }
    pub async fn close(&self) {
        self.system.close().await;
    }
    pub fn configuration(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        self.system.configuration(ctx, id)
    }
    pub async fn focused(self: &Arc<Self>, id: String) -> Result<Option<Value>> {
        let agents = self.clone();
        self.runtime.transact(move |ctx| {
            agents.resource(ctx, &id)?.map(|agent| Ok(json!({"agent":agent,"profiles":[],"slashCommands":[{"description":"Summarize older messages to free context space.","hasArguments":false,"kind":"compaction","name":"compact"}]}))).transpose()
        }).await
    }
    pub async fn mode(self: &Arc<Self>, id: String) -> Result<Option<Value>> {
        let agents = self.clone();
        self.runtime.transact(move |ctx| Ok(agents.configuration(ctx, &id)?.map(|configuration| json!({"mode":configuration["metadata"].get("lastMode").cloned().unwrap_or(Value::Null)})))).await
    }
    pub async fn create(self: &Arc<Self>, body: Value) -> Result<Value> {
        if !self.schemas.valid("agentCreate", &body)? {
            return Err(request_error(
                400,
                "invalid_request",
                "The agent creation request is invalid.",
            ));
        }
        let id = body["id"]
            .as_str()
            .map_or_else(cuid2::create_id, str::to_owned);
        let agents = self.clone();
        let identity = id.clone();
        self.runtime.transact(move |ctx| {
            if agents.configuration(ctx, &identity)?.is_some() { return Ok(()); }
            let workspace = body["workspaceId"].as_str().context("The workspace identifier is missing.")?;
            let scope = agents.projects.root_workspace(ctx, workspace)?.ok_or_else(|| request_error(404, "not_found", "The workspace was not found."))?;
            if scope["status"] != "active" { return Err(request_error(409, "conflict", "The workspace is not available.")); }
            if scope["runnerId"] != "" { return Err(request_error(409, "not_initialized", "Native runner-backed agent creation has not been migrated yet.")); }
            let configuration = agents.config.agent_configuration(scope["root"].as_str().context("The workspace root is missing.")?, workspace, workspace, body["title"].as_str())?;
            agents.system.create(ctx, &identity, &configuration)?;
            let attached = agents.projects.attach_agent(ctx, workspace, &identity)?;
            let mut resources = Vec::new();
            for id in attached["agentIds"].as_array().context("The agent series is invalid.")? { if let Some(resource) = agents.resource(ctx, id.as_str().context("The series agent identifier is invalid.")?)? { resources.push(resource); } }
            for (kind, field) in [("project.updated", "projectId"), ("workspace.updated", "workspaceId")] {
                let mut payload = json!({field:workspace,"previousVersion":attached["previousVersion"],"version":attached["version"],"changes":{"agents":resources,"updatedAt":attached["updatedAt"]}});
                if let Some(mutation) = body.get("mutationId") { payload["mutationId"] = mutation.clone(); }
                agents.events.record(ctx, None, kind, payload)?;
            }
            let resource = agents.resource(ctx, &identity)?.context("The created agent disappeared.")?;
            agents.events.record_agent_created(ctx, &identity, resource, body.get("mutationId"))?;
            Ok(())
        }).await?;
        self.focused(id)
            .await?
            .context("The created agent disappeared.")
    }
    fn check_sendable(&self, ctx: &Context<'_>, id: &str) -> Result<()> {
        let agent = self
            .resource(ctx, id)?
            .ok_or_else(|| request_error(404, "not_found", "The agent was not found."))?;
        if agent["canSendMessages"] != true {
            return Err(request_error(
                409,
                "conflict",
                "The agent cannot accept user messages.",
            ));
        }
        Ok(())
    }
    pub async fn assert_sendable(self: &Arc<Self>, id: String) -> Result<()> {
        let agents = self.clone();
        self.runtime
            .transact(move |ctx| agents.check_sendable(ctx, &id))
            .await
    }
    pub async fn send(self: &Arc<Self>, agent: String, body: Value) -> Result<Value> {
        if !self.schemas.valid("agentSend", &body)? {
            return Err(request_error(
                400,
                "invalid_request",
                "The message request is invalid.",
            ));
        }
        let agents = self.clone();
        let cursor = self.events.cursor();
        self.runtime.transact(move |ctx| {
            agents.check_sendable(ctx, &agent)?;
            let id = body["id"].as_str().map_or_else(cuid2::create_id, str::to_owned);
            if let Some(message) = agents.history.existing(ctx, &agent, &id)? {
                if message["role"] != "user" { return Err(request_error(409, "conflict", "The message ID is already in use.")); }
                return Ok(json!({"message":agents.history.message_resource(&message,false),"cursor":cursor}));
            }
            if let Some(message) = agents.history.pending(ctx, &agent, &id)? { return Ok(json!({"message":agents.history.pending_resource(&message),"cursor":cursor})); }
            if !agents.config.mode_available(&body["mode"]) { return Err(request_error(400, "invalid_request", "The selected provider, model, effort, or service tier is unavailable.")); }
            let delivery = body["delivery"].as_str().unwrap_or("queue");
            let mut content = vec![json!({"type":"text","text":body["text"]})]; content.extend(body["content"].as_array().into_iter().flatten().cloned());
            let blocks = content.iter().map(|block| { let mut block = block.clone(); if block["type"] == "image" { block["mediaType"] = block["mimeType"].clone(); block.as_object_mut().expect("validated image block").remove("mimeType"); } block }).collect::<Vec<_>>();
            let mut pending = json!({"id":id,"agentId":agent,"role":"user","status":"pending","delivery":delivery,"createdAt":now(),"blocks":blocks,"mode":body["mode"],"profile":null,"runId":null});
            if let Some(metadata) = body.get("clientMetadata") { pending["clientMetadata"] = metadata.clone(); }
            agents.history.queue(ctx, &agent, &pending)?;
            let mut metadata = json!({"messageOrigin":"user","mode":body["mode"]});
            if let Some(client) = body.get("clientMetadata") { metadata["clientMetadata"] = client.clone(); }
            let options = json!({"provider":body["mode"]["providerId"],"model":body["mode"]["modelId"],"effort":body["mode"]["effort"],"serviceTier":body["mode"]["serviceTier"],"permissionMode":body["mode"]["permissionMode"],"profile":null});
            agents.system.enqueue(ctx, &agent, &json!({"id":id,"message":{"role":"user","content":content},"metadata":metadata,"options":options}), delivery == "steer")?;
            let mut configuration = agents.configuration(ctx, &agent)?.context("The agent disappeared during admission.")?;
            if !configuration["metadata"].is_object() { configuration["metadata"] = json!({}); }
            configuration["metadata"]["lastMode"] = body["mode"].clone(); configuration["metadata"]["updatedAt"] = json!(now());
            ctx.put_value(&agent, "agentConfig", &configuration)?;
            let public = agents.history.pending_resource(&pending);
            agents.events.record_history_message(ctx, &agent, "message.created", Value::Null, public.clone())?;
            Ok(json!({"message":public,"cursor":cursor}))
        }).await
    }
    pub async fn messages(
        self: &Arc<Self>,
        id: String,
        before: Option<String>,
        after: Option<String>,
        limit: usize,
        omit: bool,
    ) -> Result<Option<Value>> {
        if self.focused(id.clone()).await?.is_none() {
            return Ok(None);
        }
        Ok(Some(
            self.history
                .messages(id, before, after, limit, omit)
                .await?,
        ))
    }
    pub async fn usage(self: &Arc<Self>, id: String) -> Result<Option<Value>> {
        let agents = self.clone();
        self.runtime.transact(move |ctx| {
            if agents.configuration(ctx, &id)?.is_none() { return Ok(None); }
            Ok(Some(json!({"context":agents.usage.current_context(ctx,&id)?,"usage":agents.usage.model_totals(ctx,&id)?})))
        }).await
    }
    fn resource(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        let Some(configuration) = self.configuration(ctx, id)? else {
            return Ok(None);
        };
        let association = self
            .workspaces
            .agent_association(ctx, id)?
            .or(self.projects.agent_association(ctx, id)?);
        let parent = ctx
            .value("", &format!("agentSystem.parent.{id}"))?
            .and_then(|value| value.as_str().map(str::to_owned));
        let children: i64 = ctx.database().query_row("SELECT count(*) FROM happy_agent_values WHERE owner_id='' AND key GLOB 'agentSystem.parent.*' AND value_json=?1", [json!(id).to_string()], |row| row.get(0))?;
        let metadata = &configuration["metadata"];
        let created = configuration["provenance"]["createdAt"]
            .as_u64()
            .unwrap_or(0);
        let latest = self.events.latest(ctx, id)?;
        let updated = metadata["updatedAt"]
            .as_u64()
            .unwrap_or(created)
            .max(latest.as_ref().map_or(0, |event| event.1 as u64));
        let version = latest.as_ref().map_or_else(
            || resource_version(updated, metadata["version"].as_u64().unwrap_or(1), id),
            |event| event.0.clone(),
        );
        let owed = self.system.owed(ctx, id)?;
        let status = match owed.as_ref().and_then(|owed| owed["stage"].as_str()) {
            Some("inference") => "thinking",
            Some("tools") => "running_tools",
            Some(_) => "working",
            None => "idle",
        };
        let archived = metadata.get("archivedAt").cloned().unwrap_or(Value::Null);
        let order = association
            .as_ref()
            .map(|association| association.1.clone());
        Ok(Some(
            json!({"id":id,"workspaceId":association.map(|association|association.0).unwrap_or_default(),"parentAgentId":parent,"subtask":false,"subtasks":[],"subtaskOrderKey":null,"userVisible":order.is_some(),"managedByAnotherAgent":parent.is_some(),"canSendMessages":parent.is_none()&&archived.is_null(),"title":metadata.get("title").cloned().unwrap_or(Value::Null),"titleStatus":if metadata["title"].is_string(){"ready"}else{"idle"},"status":status,"subagents":{"total":children,"running":0},"processes":{"running":0},"pendingQuestionId":null,"unread":metadata.get("unread").cloned().unwrap_or(Value::Null),"orderKey":order,"lastCursor":self.events.agent_cursor(id),"version":version,"createdAt":created,"updatedAt":updated,"archivedAt":archived}),
        ))
    }
}
