//! Interactive delegation is ordinary Core ancestry plus workspace and durable lifetimes.
use super::{
    agent_runtime::AgentRuntimeModule,
    bots::BotsModule,
    collaboration::CollaborationModule,
    config::ConfigModule,
    durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration},
    lifecycle::LifecycleModule,
    owners::AbortModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
    tools::ToolsModule,
    workspaces::WorkspacesModule,
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use futures_util::future::BoxFuture;
use happy_agent_base::{AgentModule, AgentScope, ToolPermissionPolicy};
use happy_providers::{Block, Message, ToolDefinition};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Weak},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
mod ordering;
mod tools;

pub struct SubtasksModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    agents: Arc<AgentRuntimeModule>,
    bots: Arc<BotsModule>,
    collaboration: Arc<CollaborationModule>,
    workspaces: Arc<WorkspacesModule>,
    durable: Arc<DurableFunctionsModule>,
    abort: Arc<AbortModule>,
    compute: Arc<ToolsModule>,
    owner: Weak<Self>,
    lifetime: CancellationToken,
    schemas: Schemas,
}
struct Procedure {
    owner: Weak<SubtasksModule>,
    archive: bool,
}
impl SubtasksModule {
    #[expect(clippy::too_many_arguments)]
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        agents: Arc<AgentRuntimeModule>,
        bots: Arc<BotsModule>,
        collaboration: Arc<CollaborationModule>,
        workspaces: Arc<WorkspacesModule>,
        durable: Arc<DurableFunctionsModule>,
        abort: Arc<AbortModule>,
        compute: Arc<ToolsModule>,
        lifecycle: Arc<LifecycleModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in [
            "ownerSubtaskId",
            "ownerSubtaskCreateInput",
            "ownerSubtaskResult",
            "ownerSubtaskStart",
            "ownerSubtaskMetadata",
            "ownerSubtaskWorkspaceMetadata",
            "ownerSubtaskArchivedMetadata",
            "ownerSubtaskRestoredMetadata",
            "ownerSubtaskVersionedMetadata",
            "ownerSubtaskOrderedMetadata",
            "ownerSubtaskArchive",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        let module = Arc::new_cyclic(|owner| Self {
            config,
            runtime,
            agents: agents.clone(),
            bots,
            collaboration,
            workspaces: workspaces.clone(),
            durable: durable.clone(),
            abort,
            compute,
            owner: owner.clone(),
            lifetime: lifecycle.shutdown.child_token(),
            schemas,
        });
        for (name, archive, args) in [
            ("subtasks.start", false, "ownerSubtaskStart"),
            ("subtasks.archive", true, "ownerSubtaskArchive"),
        ] {
            durable.register(Registration {
                name: name.to_owned(),
                arguments_schema: args,
                result_schema: "ownerNull",
                function: Arc::new(Procedure {
                    owner: Arc::downgrade(&module),
                    archive,
                }),
            })?;
        }
        workspaces.listen_subtasks(Arc::downgrade(&module))?;
        agents.install(module.clone())?;
        Ok(module)
    }
    pub fn is_subtask(&self, config: &Value) -> Result<bool> {
        self.schemas
            .valid("ownerSubtaskMetadata", &config["metadata"])
    }
    pub fn sibling_order_key<'a>(&self, config: &'a Value) -> Result<Option<&'a str>> {
        Ok(self
            .schemas
            .valid("ownerSubtaskOrderedMetadata", &config["metadata"])?
            .then(|| config["metadata"]["subtaskOrderKey"].as_str().unwrap()))
    }
    fn archived(&self, config: &Value) -> Result<bool> {
        self.schemas
            .valid("ownerSubtaskArchivedMetadata", &config["metadata"])
    }
    fn assert_id(&self, id: &str) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid("ownerSubtaskId", &json!(id))?,
            "The subtask identity is invalid."
        );
        Ok(())
    }
    pub fn sort_siblings(
        &self,
        mut siblings: Vec<(String, Value)>,
    ) -> Result<Vec<(String, Value)>> {
        let mut keys = std::collections::BTreeMap::new();
        for (id, config) in &siblings {
            keys.insert(
                id.clone(),
                self.sibling_order_key(config)?.map(str::to_owned),
            );
        }
        siblings.sort_by(|(a, ac), (b, bc)| {
            let ak = &keys[a];
            let bk = &keys[b];
            match (ak, bk) {
                (Some(a), Some(b)) if a != b => a.cmp(b),
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, None) => bc["provenance"]["createdAt"]
                    .as_u64()
                    .unwrap_or(0)
                    .cmp(&ac["provenance"]["createdAt"].as_u64().unwrap_or(0))
                    .then_with(|| a.cmp(b)),
                _ => a.cmp(b),
            }
        });
        Ok(siblings)
    }
    fn children(&self, ctx: &Context<'_>, parent: &str) -> Result<Vec<(String, Value)>> {
        let mut children = Vec::new();
        for id in self.agents.children(ctx, parent)? {
            if let Some(config) = self.agents.configuration(ctx, &id)?
                && self.is_subtask(&config)?
            {
                children.push((id, config));
            }
        }
        Ok(children)
    }
    pub fn reorder(&self, ctx: &Context<'_>, agent: &str, after: Option<&str>) -> Result<bool> {
        self.runtime.assert_context(ctx)?;
        self.assert_id(agent)?;
        if let Some(after) = after {
            self.assert_id(after)?;
        }
        let config = self
            .agents
            .configuration(ctx, agent)?
            .context("Only an active subtask can be reordered.")?;
        anyhow::ensure!(
            self.is_subtask(&config)? && !self.archived(&config)?,
            "Only an active subtask can be reordered."
        );
        let parent = self
            .agents
            .parent(ctx, agent)?
            .context("Only an active subtask can be reordered.")?;
        let siblings = self.sort_siblings(
            self.children(ctx, &parent)?
                .into_iter()
                .filter_map(|(id, config)| match self.archived(&config) {
                    Ok(false) => Some(Ok((id, config))),
                    Ok(true) => None,
                    Err(error) => Some(Err(error)),
                })
                .collect::<Result<Vec<_>>>()?,
        )?;
        anyhow::ensure!(
            after.is_none_or(|after| after != agent && siblings.iter().any(|(id, _)| id == after)),
            "A subtask can only be placed after an active sibling subtask."
        );
        let mut moved = siblings
            .iter()
            .filter(|(id, _)| id != agent)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let insertion = after
            .map(|after| moved.iter().position(|id| id == after).unwrap() + 1)
            .unwrap_or(0);
        moved.insert(insertion, agent.to_owned());
        if moved
            .iter()
            .zip(&siblings)
            .all(|(id, (current, _))| id == current)
        {
            return Ok(false);
        }
        let mut keys = siblings
            .iter()
            .map(|(id, config)| {
                Ok((
                    id.clone(),
                    self.sibling_order_key(config)?.map(str::to_owned),
                ))
            })
            .collect::<Result<std::collections::BTreeMap<_, _>>>()?;
        let strict = siblings.iter().enumerate().all(|(index, (id, _))| {
            keys[id].as_deref().is_some_and(|key| {
                index == 0
                    || keys[&siblings[index - 1].0]
                        .as_deref()
                        .is_some_and(|previous| previous < key)
            })
        });
        if !strict {
            let mut previous: Option<String> = None;
            for (id, _) in &siblings {
                let key = ordering::between(previous.as_deref(), None)?;
                keys.insert(id.clone(), Some(key.clone()));
                previous = Some(key);
            }
        }
        let key = ordering::between(
            insertion
                .checked_sub(1)
                .and_then(|index| keys[&moved[index]].as_deref()),
            moved.get(insertion + 1).and_then(|id| keys[id].as_deref()),
        )?;
        keys.insert(agent.to_owned(), Some(key));
        let timestamp = super::identity::now();
        for (id, config) in siblings {
            let key = keys[&id].as_ref().unwrap();
            if self.sibling_order_key(&config)? != Some(key) {
                self.update_versioned(
                    ctx,
                    &id,
                    &config,
                    timestamp,
                    json!({"subtaskOrderKey":key}),
                )?;
            }
        }
        if let Some(config) = self.agents.configuration(ctx, &parent)? {
            self.update_versioned(
                ctx,
                &parent,
                &config,
                timestamp,
                json!({"subtasksOrderedAt":timestamp}),
            )?;
        }
        Ok(true)
    }
    pub fn create(
        &self,
        ctx: &Context<'_>,
        parent: &str,
        input: &Value,
        id: &str,
        workspace_id: Option<&str>,
        current_provider: Option<&str>,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        self.assert_id(parent)?;
        self.assert_id(id)?;
        if let Some(workspace) = workspace_id {
            self.assert_id(workspace)?;
        }
        anyhow::ensure!(
            self.schemas.valid("ownerSubtaskCreateInput", input)?,
            "The subtask creation request is invalid."
        );
        anyhow::ensure!(
            input.get("workspace").is_some() == workspace_id.is_some(),
            "A workspace-bound subtask needs its own workspace identity."
        );
        if let Some(existing) = self.agents.configuration(ctx, id)? {
            anyhow::ensure!(
                self.is_subtask(&existing)?
                    && self.agents.parent(ctx, id)?.as_deref() == Some(parent)
                    && existing["metadata"]["subtaskWorkspaceId"].as_str() == workspace_id,
                "That agent identity already belongs to another task."
            );
            return Ok(result(id, workspace_id));
        }
        let parent_config = self.assert_can_create(ctx, parent)?;
        let mut task = input.clone();
        task.as_object_mut().unwrap().remove("workspace");
        let selection = self.collaboration.select_model(&task, current_provider)?;
        let mut resolved = input.clone();
        for (key, value) in selection.as_object().unwrap() {
            resolved[key] = value.clone();
        }
        let workspace = if let Some(request) = input.get("workspace") {
            let mut request = request.clone();
            let project = request
                .as_object_mut()
                .unwrap()
                .remove("projectId")
                .unwrap();
            request["id"] = json!(workspace_id.unwrap());
            request["nameConfigured"] = json!(true);
            Some(
                self.workspaces
                    .create_workspace(
                        ctx,
                        project.as_str().unwrap(),
                        &request,
                        Some(parent),
                        Some(id),
                    )?
                    .context("The subtask's project was not found.")?,
            )
        } else {
            None
        };
        let children = self.children(ctx, parent)?;
        let mut keys = Vec::new();
        for (_, config) in &children {
            if let Some(key) = self.sibling_order_key(config)? {
                keys.push(key);
            }
        }
        keys.sort();
        let key = ordering::between(None, keys.first().copied())?;
        let timestamp = super::identity::now();
        let mut config = json!({"metadata":{"title":input["title"],"subtask":true,"subtaskOrderKey":key,"updatedAt":timestamp,"version":1}});
        for field in ["environment", "modules"] {
            if let Some(value) = parent_config.get(field) {
                config[field] = value.clone();
            }
        }
        if let Some(workspace) = workspace.as_ref() {
            config["environment"] = parent_config
                .get("environment")
                .cloned()
                .map(Ok)
                .unwrap_or_else(|| self.config.current_agent_environment())?;
            config["environment"]["workingDirectory"] = workspace["path"].clone();
            if config.get("modules").is_none() {
                config["modules"] = json!({});
            }
            let mut compute = json!({"cwd":workspace["path"],"secretScope":{"projectId":workspace["projectRef"],"workspaceId":workspace["id"]}});
            if let Some(runner) = workspace.get("runnerId") {
                compute["runnerId"] = runner.clone();
            }
            if let Some(image) = workspace.get("dockerImage") {
                compute["docker"] = json!({"image":image});
            }
            config["modules"]["compute"] = compute;
        }
        if let Some(workspace) = workspace_id {
            config["metadata"]["subtaskWorkspaceId"] = json!(workspace);
        }
        self.agents.create_from(ctx, id, &config, Some(parent))?;
        self.agents.set_parent(ctx, id, parent)?;
        if let Some(workspace) = workspace.as_ref() {
            self.workspaces
                .attach_subtask_agent(ctx, workspace["id"].as_str().unwrap(), id)?;
        }
        let mut arguments = json!({"agentId":id,"parentAgentId":parent,"input":resolved});
        if let Some(workspace) = workspace_id {
            arguments["workspaceId"] = json!(workspace);
        }
        self.durable.invoke(ctx,&json!({"function":"subtasks.start","arguments":arguments,"operationId":format!("subtask-start:{id}"),"lockKeys":[format!("subtask:{id}")]}))?;
        Ok(result(id, workspace_id))
    }
    fn assert_can_create(&self, ctx: &Context<'_>, id: &str) -> Result<Value> {
        let parent = self
            .agents
            .configuration(ctx, id)?
            .context("The subtask's parent was not found.")?;
        let mut current = id.to_owned();
        for _ in 0..2 {
            let config = self
                .agents
                .configuration(ctx, &current)?
                .context("The subtask's ancestor was not found.")?;
            anyhow::ensure!(
                !self.archived(&config)?,
                "An archived agent cannot create subtasks."
            );
            if self
                .schemas
                .valid("ownerSubtaskWorkspaceMetadata", &config["metadata"])?
            {
                anyhow::ensure!(
                    self.workspaces
                        .get(
                            ctx,
                            config["metadata"]["subtaskWorkspaceId"].as_str().unwrap()
                        )?
                        .is_some_and(|workspace| workspace["status"] == "ready"),
                    "The parent subtask's workspace must be active and ready."
                );
            }
            if self
                .bots
                .for_agent(ctx, &current)?
                .is_some_and(|bot| bot["status"] == "active")
            {
                return Ok(parent);
            }
            anyhow::ensure!(
                self.is_subtask(&config)?,
                "Only a bot or another subtask can create a subtask."
            );
            current = self
                .agents
                .parent(ctx, &current)?
                .context("A subtask must belong to a bot.")?;
        }
        anyhow::bail!("Subtasks are limited to two levels below a bot.")
    }
    pub fn archive(&self, ctx: &Context<'_>, actor: &str, id: &str) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        self.assert_id(actor)?;
        self.assert_id(id)?;
        let actor_config = self
            .agents
            .configuration(ctx, actor)?
            .context("The coordinating agent was not found.")?;
        let target = self
            .agents
            .configuration(ctx, id)?
            .context("The subtask was not found.")?;
        let bot = self.bots.for_agent(ctx, actor)?;
        anyhow::ensure!(
            !self.archived(&actor_config)?
                && (self.is_subtask(&actor_config)?
                    || bot.is_some_and(|bot| bot["status"] == "active"))
                && self.is_subtask(&target)?
                && self.agents.parent(ctx, id)?.as_deref() == Some(actor),
            "Only a subtask's direct coordinating bot or subtask may archive it."
        );
        if !self.archived(&target)? {
            let timestamp = super::identity::now();
            self.update_versioned(ctx, id, &target, timestamp, json!({"archivedAt":timestamp}))?;
        }
        Ok(json!({"agentId":id}))
    }
    fn update_versioned(
        &self,
        ctx: &Context<'_>,
        id: &str,
        config: &Value,
        timestamp: u64,
        mut update: Value,
    ) -> Result<()> {
        let version = if self
            .schemas
            .valid("ownerSubtaskVersionedMetadata", &config["metadata"])?
        {
            config["metadata"]["version"].as_u64().unwrap()
        } else {
            1
        };
        update["updatedAt"] = json!(timestamp);
        update["version"] = json!(version + 1);
        self.agents.update_metadata(ctx, id, &update)
    }
    pub fn workspace_archived(&self, ctx: &Context<'_>, workspace: &Value) -> Result<()> {
        if let Some(id) = workspace["subtaskAgentId"].as_str()
            && let Some(config) = self.agents.configuration(ctx, id)?
            && self
                .schemas
                .valid("ownerSubtaskWorkspaceMetadata", &config["metadata"])?
            && config["metadata"]["subtaskWorkspaceId"] == workspace["id"]
            && !self.archived(&config)?
        {
            let timestamp = super::identity::now();
            self.update_versioned(ctx, id, &config, timestamp, json!({"archivedAt":timestamp}))?;
        }
        Ok(())
    }
    async fn start(self: &Arc<Self>, request: Value, cancel: &CancellationToken) -> Result<()> {
        let mut delay = Duration::from_millis(50);
        loop {
            let owner = self.clone();
            let request = request.clone();
            let readiness = self
                .runtime
                .transact(move |ctx| {
                    let Some(config) = owner
                        .agents
                        .configuration(ctx, request["agentId"].as_str().unwrap())?
                    else {
                        return Ok(Readiness::Superseded);
                    };
                    if owner.archived(&config)? {
                        return Ok(Readiness::Superseded);
                    }
                    // An unavailable parent is a final domain outcome; SQL/validation failures are errors.
                    if owner
                        .parent_available(ctx, request["parentAgentId"].as_str().unwrap())?
                        .is_none()
                    {
                        return Ok(Readiness::Superseded);
                    }
                    if let Some(id) = request["workspaceId"].as_str() {
                        return Ok(match owner.workspaces.get(ctx, id)? {
                            Some(workspace) if workspace["status"] == "ready" => Readiness::Ready,
                            Some(workspace) if workspace["status"] == "initializing" => {
                                Readiness::Waiting
                            }
                            _ => Readiness::Superseded,
                        });
                    }
                    Ok(Readiness::Ready)
                })
                .await?;
            match readiness {
                Readiness::Superseded => return Ok(()),
                Readiness::Ready => break,
                Readiness::Waiting => {
                    tokio::select! {_=cancel.cancelled()=>anyhow::bail!("The subtask startup was cancelled."),_=tokio::time::sleep(delay)=>{}}
                    delay = (delay * 2).min(Duration::from_secs(1));
                }
            }
        }
        anyhow::ensure!(!cancel.is_cancelled(), "The subtask startup was cancelled.");
        let owner = self.clone();
        self.runtime
            .transact(move |ctx| {
                let id = request["agentId"].as_str().unwrap();
                let parent = request["parentAgentId"].as_str().unwrap();
                let Some(config) = owner.agents.configuration(ctx, id)? else {
                    return Ok(());
                };
                if owner.archived(&config)? {
                    return Ok(());
                }
                owner.assert_can_create(ctx, parent)?;
                if let Some(workspace) = request["workspaceId"].as_str()
                    && owner
                        .workspaces
                        .get(ctx, workspace)?
                        .is_none_or(|workspace| workspace["status"] != "ready")
                {
                    return Ok(());
                }
                let mut task = request["input"].clone();
                task.as_object_mut().unwrap().remove("workspace");
                owner
                    .collaboration
                    .create_agent(ctx, parent, &task, id, &json!({}))?;
                Ok(())
            })
            .await
    }
    fn parent_available(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        let Some(parent) = self.agents.configuration(ctx, id)? else {
            return Ok(None);
        };
        let mut current = id.to_owned();
        for _ in 0..2 {
            let Some(config) = self.agents.configuration(ctx, &current)? else {
                return Ok(None);
            };
            if self.archived(&config)? {
                return Ok(None);
            }
            if self
                .schemas
                .valid("ownerSubtaskWorkspaceMetadata", &config["metadata"])?
                && self
                    .workspaces
                    .get(
                        ctx,
                        config["metadata"]["subtaskWorkspaceId"].as_str().unwrap(),
                    )?
                    .is_none_or(|workspace| workspace["status"] != "ready")
            {
                return Ok(None);
            }
            if self
                .bots
                .for_agent(ctx, &current)?
                .is_some_and(|bot| bot["status"] == "active")
            {
                return Ok(Some(parent));
            }
            if !self.is_subtask(&config)? {
                return Ok(None);
            }
            let Some(ancestor) = self.agents.parent(ctx, &current)? else {
                return Ok(None);
            };
            current = ancestor;
        }
        Ok(None)
    }
    async fn archive_compute(self: &Arc<Self>, id: &str, cancel: &CancellationToken) -> Result<()> {
        let mut delay = Duration::from_millis(50);
        loop {
            anyhow::ensure!(!cancel.is_cancelled(), "The subtask cleanup was cancelled.");
            let owner = self.clone();
            let id_owned = id.to_owned();
            let archived = self
                .runtime
                .transact(move |ctx| {
                    Ok(owner
                        .agents
                        .configuration(ctx, &id_owned)?
                        .map(|config| owner.archived(&config))
                        .transpose()?
                        .unwrap_or(false))
                })
                .await?;
            if !archived {
                return Ok(());
            }
            match self.compute.archive_agent(id, cancel).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    tracing::warn!(agent_id=id,%error,"Subtask cleanup remains owed.");
                    tokio::select! {_=cancel.cancelled()=>anyhow::bail!("The subtask cleanup was cancelled."),_=tokio::time::sleep(delay)=>{}}
                    delay = (delay * 2).min(Duration::from_secs(5));
                }
            }
        }
    }
}
enum Readiness {
    Ready,
    Waiting,
    Superseded,
}
fn result(id: &str, workspace: Option<&str>) -> Value {
    let mut value = json!({"agentId":id});
    if let Some(workspace) = workspace {
        value["workspaceId"] = json!(workspace);
    }
    value
}
impl DurableFunction for Procedure {
    fn execute(
        self: Arc<Self>,
        call: Value,
        _kv: CallKv,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            let owner = self
                .owner
                .upgrade()
                .context("The subtasks module was closed.")?;
            if self.archive {
                owner
                    .archive_compute(call["arguments"]["agentId"].as_str().unwrap(), &cancel)
                    .await?;
            } else {
                owner.start(call["arguments"].clone(), &cancel).await?;
            }
            Ok(Value::Null)
        })
    }
}
#[async_trait]
impl AgentModule for SubtasksModule {
    fn name(&self) -> &'static str {
        "subtasks"
    }
    fn tools(&self, scope: &AgentScope<'_>) -> Vec<ToolDefinition> {
        self.subtask_tools(scope)
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|_| false)
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|_| true)
    }
    fn permission_policy(
        &self,
        _scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<ToolPermissionPolicy>> {
        tools::definition(call).map(|definition|Ok(ToolPermissionPolicy{should_review_in_auto_mode:definition.name=="archive_subtask",should_run_in_full_access_in_auto_mode:false,requires_auto_or_full_access:false,action:if definition.name=="archive_subtask"{format!("archiving a direct subtask together with its own workspace, if it has one, and stopping its current work and running descendants, while preserving its conversation history. Arguments: {}",call["call"]["arguments"])}else{definition.description},instructions:None}))
    }
    fn execute_transactional_tool(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        self.execute_archive_tool(ctx, scope, call)
    }
    async fn execute_tool(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        self.execute_create_tool(scope, call, cancel).await
    }
    fn metadata_changed(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        change: &Value,
    ) -> Result<()> {
        if !self.is_subtask(scope.configuration)? {
            return Ok(());
        }
        if self
            .schemas
            .valid("ownerSubtaskArchivedMetadata", &change["update"])?
        {
            self.durable
                .cancel(ctx, &format!("subtask-start:{}", scope.id))?;
            self.abort.abort(ctx, scope.id)?;
            self.durable.invoke(ctx,&json!({"function":"subtasks.archive","arguments":{"agentId":scope.id},"operationId":format!("subtask-archive:{}",scope.id),"lockKeys":[format!("subtask:{}",scope.id)]}))?;
            if self
                .schemas
                .valid("ownerSubtaskWorkspaceMetadata", &change["metadata"])?
            {
                let id = change["metadata"]["subtaskWorkspaceId"].as_str().unwrap();
                if let Some(workspace) = self.workspaces.get(ctx, id)?
                    && workspace["subtaskAgentId"] == scope.id
                    && workspace["status"] != "archiving"
                    && workspace["status"] != "archived"
                {
                    self.workspaces.begin_archive(ctx, id)?;
                }
            }
        } else if self
            .schemas
            .valid("ownerSubtaskRestoredMetadata", &change["update"])?
            && self
                .schemas
                .valid("ownerSubtaskArchivedMetadata", &change["previousMetadata"])?
        {
            anyhow::bail!("An archived subtask cannot be restored.");
        }
        Ok(())
    }
    async fn before_loop(&self, scope: &AgentScope<'_>, cancel: CancellationToken) -> Result<()> {
        if !self.is_subtask(scope.configuration)? {
            return Ok(());
        }
        let owner = self
            .owner
            .upgrade()
            .context("The subtasks module was closed.")?;
        let mut current = scope.id.to_owned();
        let mut workspace = None;
        for _ in 0..3 {
            let module = owner.clone();
            let id = current.clone();
            let (config, parent) = self
                .runtime
                .transact(move |ctx| {
                    Ok((
                        module.agents.configuration(ctx, &id)?,
                        module.agents.parent(ctx, &id)?,
                    ))
                })
                .await?;
            if let Some(config) = config
                && self
                    .schemas
                    .valid("ownerSubtaskWorkspaceMetadata", &config["metadata"])?
            {
                workspace = config["metadata"]["subtaskWorkspaceId"]
                    .as_str()
                    .map(str::to_owned);
                break;
            }
            let Some(parent) = parent else {
                return Ok(());
            };
            current = parent;
        }
        let Some(workspace) = workspace else {
            return Ok(());
        };
        let mut delay = Duration::from_millis(50);
        loop {
            let module = owner.clone();
            let id = workspace.clone();
            let status = self
                .runtime
                .transact(move |ctx| {
                    Ok(module
                        .workspaces
                        .get(ctx, &id)?
                        .map(|workspace| workspace["status"].as_str().unwrap().to_owned()))
                })
                .await?;
            match status.as_deref() {
                Some("ready") => return Ok(()),
                Some("initializing") => {
                    tokio::select! {_=cancel.cancelled()=>anyhow::bail!("The subtask workspace wait was cancelled."),_=self.lifetime.cancelled()=>anyhow::bail!("The agent is shutting down."),_=tokio::time::sleep(delay)=>{}}
                    delay = (delay * 2).min(Duration::from_secs(1));
                }
                _ => anyhow::bail!("The subtask workspace is unavailable."),
            }
        }
    }
    async fn instructions(&self, scope: &AgentScope<'_>) -> Result<String> {
        let owner = self
            .owner
            .upgrade()
            .context("The subtasks module was closed.")?;
        let id = scope.id.to_owned();
        let config = self
            .runtime
            .transact(move |ctx| {
                Ok((
                    owner.agents.configuration(ctx, &id)?,
                    owner.bots.for_agent(ctx, &id)?.is_some(),
                ))
            })
            .await?;
        if config
            .0
            .as_ref()
            .map(|config| self.is_subtask(config))
            .transpose()?
            .unwrap_or(false)
        {
            Ok(include_str!("subtasks/subtask-instructions.txt")
                .trim()
                .to_owned())
        } else if config.1 {
            Ok(include_str!("subtasks/bot-instructions.txt")
                .trim()
                .to_owned())
        } else {
            Ok(String::new())
        }
    }
}
