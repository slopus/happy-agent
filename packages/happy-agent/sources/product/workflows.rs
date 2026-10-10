//! Sandboxed workflows and their durable collaborators belong to this feature.
use super::{
    agent_runtime::AgentRuntimeModule,
    collaboration::CollaborationModule,
    config::ConfigModule,
    durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration},
    identity::now,
    lifecycle::LifecycleModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
    tools::ToolsModule,
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope, Inference, ToolPermissionPolicy};
use happy_providers::{Block, Message};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
mod format;
mod persistence;
mod runner;
mod tools;
mod values;
pub(crate) mod worker;
pub type WorkflowEventListener = Arc<dyn Fn(&Value) + Send + Sync>;
pub type WorkflowTransactionalListener =
    Arc<dyn for<'a> Fn(&Context<'a>, &Value) -> Result<()> + Send + Sync>;
pub struct WorkflowSubscription {
    owner: Weak<WorkflowsModule>,
    id: u64,
    transactional: bool,
}
impl Drop for WorkflowSubscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            if self.transactional {
                owner
                    .transactional
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&self.id);
            } else {
                owner
                    .listeners
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&self.id);
            }
        }
    }
}
pub struct WorkflowsModule {
    config: Arc<ConfigModule>,
    collaboration: Arc<CollaborationModule>,
    tools: Arc<ToolsModule>,
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    agents: Arc<AgentRuntimeModule>,
    lifecycle: Arc<LifecycleModule>,
    schemas: Schemas,
    owner: Weak<Self>,
    listeners: Mutex<BTreeMap<u64, WorkflowEventListener>>,
    transactional: Mutex<BTreeMap<u64, WorkflowTransactionalListener>>,
    next: AtomicU64,
    live: Mutex<BTreeMap<(String, String), CancellationToken>>,
    changed: watch::Sender<u64>,
}
fn valid(schemas: &Schemas, name: &str, value: &Value, label: &str) -> Result<()> {
    anyhow::ensure!(schemas.valid(name, value)?, "The {label} is invalid.");
    Ok(())
}
impl WorkflowsModule {
    pub fn new(
        config: Arc<ConfigModule>,
        collaboration: Arc<CollaborationModule>,
        tools: Arc<ToolsModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        agents: Arc<AgentRuntimeModule>,
        lifecycle: Arc<LifecycleModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        let (changed, _) = watch::channel(0);
        let module = Arc::new_cyclic(|owner| Self {
            config,
            collaboration,
            tools,
            runtime,
            durable: durable.clone(),
            agents: agents.clone(),
            lifecycle,
            schemas,
            owner: owner.clone(),
            listeners: Mutex::new(BTreeMap::new()),
            transactional: Mutex::new(BTreeMap::new()),
            next: AtomicU64::new(1),
            live: Mutex::new(BTreeMap::new()),
            changed,
        });
        durable.register(Registration {
            name: "workflows.execute".to_owned(),
            arguments_schema: "ownerWorkflowExecute",
            result_schema: "ownerWorkflowExecuteResult",
            function: Arc::new(runner::Execute {
                owner: Arc::downgrade(&module),
            }),
        })?;
        agents.install(module.clone())?;
        Ok(module)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime
            .migrate("workflows", persistence::MIGRATIONS)
            .await
    }
    fn enabled(&self) -> Result<()> {
        anyhow::ensure!(
            self.config.workflows_enabled(),
            "Workflows are not enabled for this installation."
        );
        Ok(())
    }
    fn identities(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        valid(
            &self.schemas,
            "ownerWorkflowAgentId",
            &json!(agent),
            "workflow agent ID",
        )?;
        valid(&self.schemas, "ownerWorkflowId", &json!(id), "workflow ID")
    }
    fn require(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<Value> {
        self.enabled()?;
        self.identities(ctx, agent, id)?;
        persistence::read_run(ctx, &self.schemas, agent, id)?
            .with_context(|| format!("Workflow run \"{id}\" was not found."))
    }
    pub fn on_event(
        self: &Arc<Self>,
        listener: WorkflowEventListener,
    ) -> Result<WorkflowSubscription> {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The workflow listener bound was reached."
        );
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(WorkflowSubscription {
            owner: Arc::downgrade(self),
            id,
            transactional: false,
        })
    }
    pub fn on_event_transactional(
        self: &Arc<Self>,
        listener: WorkflowTransactionalListener,
    ) -> Result<WorkflowSubscription> {
        let mut listeners = self
            .transactional
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The workflow listener bound was reached."
        );
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(WorkflowSubscription {
            owner: Arc::downgrade(self),
            id,
            transactional: true,
        })
    }
    fn event(&self, ctx: &Context<'_>, kind: &str, run: &Value) -> Result<()> {
        let event = json!({"type":kind,"agentId":run["agentId"],"eventId":cuid2::create_id(),"at":now(),"run":run});
        valid(
            &self.schemas,
            "ownerWorkflowEvent",
            &event,
            "workflow event",
        )?;
        let transactional = self
            .transactional
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for listener in transactional {
            listener(ctx, &event)?;
        }
        let listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let changed = self.changed.clone();
        ctx.after_commit(move || {
            changed.send_modify(|version| *version = version.wrapping_add(1));
            for listener in listeners {
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(&event)))
                    .is_err()
                {
                    tracing::warn!("A workflow subscriber failed after commit.");
                }
            }
        })
    }
    fn intent(&self, ctx: &Context<'_>, agent: &str, id: &str, resume: Option<&str>) -> Result<()> {
        let mut arguments = json!({"agentId":agent,"runId":id});
        if let Some(resume) = resume {
            arguments["resumeFromRunId"] = json!(resume);
        }
        self.durable.invoke(ctx,&json!({"function":"workflows.execute","arguments":arguments,"operationId":format!("workflows.execute.{agent}.{id}"),"lockKeys":[format!("workflow.{agent}.{id}")]}))?;
        Ok(())
    }
    pub fn launch_resolved(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        input: &Value,
        id: &str,
        script: &str,
    ) -> Result<Value> {
        self.enabled()?;
        self.identities(ctx, agent, id)?;
        valid(
            &self.schemas,
            "ownerWorkflowLaunch",
            input,
            "workflow launch input",
        )?;
        if let Some(args) = input.get("args") {
            anyhow::ensure!(
                values::normalize(args.clone()).to_string().len() <= 65536,
                "Workflow arguments are limited to 65536 bytes."
            );
        }
        anyhow::ensure!(
            persistence::read_run(ctx, &self.schemas, agent, id)?.is_none(),
            "Workflow run \"{id}\" already exists."
        );
        anyhow::ensure!(
            format::length(script) <= 524288,
            "Workflow scripts are limited to 524288 characters."
        );
        let named = format::trim(input["name"].as_str().unwrap_or(""));
        let workflow = if !named.is_empty() {
            format::slice(named, 96)
        } else if input.get("script").is_some() {
            "dynamic-workflow".to_owned()
        } else {
            let leaf = input["scriptPath"]
                .as_str()
                .unwrap()
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("");
            let name = if leaf.to_ascii_lowercase().ends_with(".py") {
                &leaf[..leaf.len() - 3]
            } else {
                leaf
            };
            if name.is_empty() || format::length(name) > 96 {
                "dynamic-workflow".to_owned()
            } else {
                name.to_owned()
            }
        };
        let description = format::trim(input["description"].as_str().unwrap_or(""));
        let description = if description.is_empty() {
            format!("Run {workflow}")
        } else {
            description.to_owned()
        };
        let description = format::slice(&description, 1000);
        let mut request = json!({"id":id,"workflow":workflow,"description":description,"script":script.replace("\r\n","\n").replace('\r',"\n")});
        for key in ["args", "resumeFromRunId"] {
            if let Some(value) = input.get(key) {
                request[key] = value.clone();
            }
        }
        let at = now();
        let run = json!({"id":id,"agentId":agent,"workflow":workflow,"description":description,"status":"running","agentCount":0,"logs":[],"logsTruncated":false,"createdAt":at,"updatedAt":at,"startedAt":at});
        persistence::write_request(ctx, &self.schemas, agent, &request)?;
        persistence::write_run(ctx, &self.schemas, &run)?;
        self.event(ctx, "workflow_started", &run)?;
        self.intent(ctx, agent, id, input["resumeFromRunId"].as_str())?;
        Ok(run)
    }
    pub fn status(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<Option<Value>> {
        self.enabled()?;
        self.identities(ctx, agent, id)?;
        persistence::read_run(ctx, &self.schemas, agent, id)
    }
    pub fn list(&self, ctx: &Context<'_>, agent: &str, query: &Value) -> Result<Value> {
        self.enabled()?;
        self.runtime.assert_context(ctx)?;
        valid(
            &self.schemas,
            "ownerWorkflowAgentId",
            &json!(agent),
            "workflow agent ID",
        )?;
        valid(
            &self.schemas,
            "ownerWorkflowPageQuery",
            query,
            "workflow page query",
        )?;
        persistence::page(ctx, &self.schemas, agent, query)
    }
    pub fn logs(&self, ctx: &Context<'_>, agent: &str, query: &Value) -> Result<Value> {
        self.enabled()?;
        valid(
            &self.schemas,
            "ownerWorkflowLogQuery",
            query,
            "workflow log query",
        )?;
        let id = query["id"].as_str().unwrap();
        self.require(ctx, agent, id)?;
        persistence::logs(ctx, &self.schemas, agent, id, query)
    }
    pub fn cancel(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<Value> {
        let before = self.require(ctx, agent, id)?;
        if format::terminal(&before) {
            return Ok(before);
        }
        let working = persistence::unanswered(ctx, agent, id)?;
        let at = now();
        let mut run = format::base(&before);
        run["status"] = json!("cancelled");
        run["finishedAt"] = json!(at);
        run["updatedAt"] = json!(at);
        persistence::write_run(ctx, &self.schemas, &run)?;
        self.event(ctx, "workflow_finished", &run)?;
        self.durable
            .cancel(ctx, &format!("workflows.execute.{agent}.{id}"))?;
        let owner = self
            .owner
            .upgrade()
            .context("The workflow owner was closed.")?;
        let agent = agent.to_owned();
        let id = id.to_owned();
        ctx.after_commit(move||{if let Some(token)=owner.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&(agent.clone(),id)){token.cancel();}let runtime=owner.runtime.clone();tokio::spawn(async move{for target in working{let owner=owner.clone();let sender=agent.clone();if let Err(error)=runtime.transact(move|ctx|owner.collaboration.interrupt_agent(ctx,&sender,&target)).await{tracing::warn!(%error,"A cancelled workflow's collaborator could not be interrupted.");}}});})?;
        Ok(run)
    }
    pub fn resume(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<Value> {
        let before = self.require(ctx, agent, id)?;
        if before["status"] == "running" {
            return Ok(before);
        }
        anyhow::ensure!(
            before["status"] == "paused",
            "Workflow run \"{id}\" is {}.",
            format::status(&before)
        );
        anyhow::ensure!(
            persistence::read_request(ctx, &self.schemas, agent, id)?.is_some(),
            "Workflow run \"{id}\" no longer has its script."
        );
        let mut run = format::base(&before);
        run["status"] = json!("running");
        run["updatedAt"] = json!(now());
        persistence::write_run(ctx, &self.schemas, &run)?;
        self.event(ctx, "workflow_updated", &run)?;
        self.intent(ctx, agent, id, Some(id))?;
        Ok(run)
    }
    pub async fn wait(
        self: &Arc<Self>,
        agent: &str,
        id: &str,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let mut changed = self.changed.subscribe();
        loop {
            let owner = self.clone();
            let agent_owned = agent.to_owned();
            let id_owned = id.to_owned();
            let (run, queued) = self
                .runtime
                .transact(move |ctx| {
                    Ok((
                        owner.require(ctx, &agent_owned, &id_owned)?,
                        owner.durable.has_pending(
                            ctx,
                            &format!("workflows.execute.{agent_owned}.{id_owned}"),
                        )?,
                    ))
                })
                .await?;
            if format::terminal(&run)
                || (!queued
                    && !self
                        .live
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .contains_key(&(agent.to_owned(), id.to_owned())))
            {
                return Ok(run);
            }
            tokio::select! {_=cancel.cancelled()=>anyhow::bail!("The workflow wait was interrupted."),_=self.lifecycle.shutdown.cancelled()=>anyhow::bail!("The workflow wait was interrupted."),result=changed.changed()=>{result.context("The workflow owner was closed.")?;}}
        }
    }
    fn note_transactional(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        id: &str,
        log: Option<&str>,
        phase: Option<&str>,
        agent_started: bool,
    ) -> Result<()> {
        let Some(mut run) = persistence::read_run(ctx, &self.schemas, agent, id)? else {
            return Ok(());
        };
        if format::terminal(&run) {
            return Ok(());
        }
        if let Some(log) = log {
            let line = format::slice(&log.replace("\r\n", "\n").replace('\r', "\n"), 4000);
            persistence::append_log(ctx, agent, id, &line)?;
            let logs = run["logs"].as_array_mut().unwrap();
            logs.push(json!(line));
            if logs.len() > 500 {
                logs.remove(0);
                run["logsTruncated"] = json!(true);
            }
        }
        if let Some(phase) = phase {
            run["phase"] = json!(format::slice(phase, 96));
        }
        if agent_started {
            run["agentCount"] = json!(run["agentCount"].as_u64().unwrap() + 1);
        }
        run["updatedAt"] = json!(now());
        persistence::write_run(ctx, &self.schemas, &run)?;
        self.event(ctx, "workflow_updated", &run)
    }
    async fn note(
        self: &Arc<Self>,
        agent: &str,
        id: &str,
        log: Option<String>,
        phase: Option<String>,
    ) {
        let owner = self.clone();
        let agent = agent.to_owned();
        let id = id.to_owned();
        if let Err(error) = self
            .runtime
            .transact(move |ctx| {
                owner.note_transactional(ctx, &agent, &id, log.as_deref(), phase.as_deref(), false)
            })
            .await
        {
            tracing::warn!(%error,"Workflow progress could not be recorded.");
        }
    }
    async fn finish(self: &Arc<Self>, agent: &str, id: &str, outcome: Result<Value>) -> Result<()> {
        let owner = self.clone();
        let agent = agent.to_owned();
        let id = id.to_owned();
        self.runtime
            .transact(move |ctx| {
                let Some(before) = persistence::read_run(ctx, &owner.schemas, &agent, &id)? else {
                    return Ok(());
                };
                if format::terminal(&before) {
                    return Ok(());
                }
                let mut run = format::base(&before);
                let at = now();
                run["updatedAt"] = json!(at);
                run["finishedAt"] = json!(at);
                match outcome {
                    Ok(output) => {
                        run["status"] = json!("completed");
                        run["output"] = json!(format::slice(&format::serialize(&output)?, 20000));
                    }
                    Err(error) => {
                        run["status"] = json!("failed");
                        run["error"] = json!(format::slice(&error.to_string(), 4000));
                    }
                }
                persistence::write_run(ctx, &owner.schemas, &run)?;
                owner.event(ctx, "workflow_finished", &run)
            })
            .await
    }
    pub fn format_run_for_model(&self, run: &Value) -> Result<String> {
        persistence::validate_run(&self.schemas, run)?;
        Ok(format::run(run))
    }
    pub fn format_page_for_model(&self, page: &Value) -> Result<String> {
        valid(&self.schemas, "ownerWorkflowPage", page, "workflow page")?;
        Ok(format::page(page))
    }
    pub fn format_logs_for_model(&self, page: &Value) -> Result<String> {
        valid(
            &self.schemas,
            "ownerWorkflowLogPage",
            page,
            "workflow log page",
        )?;
        Ok(format::logs(page))
    }
}
#[async_trait]
impl AgentModule for WorkflowsModule {
    fn name(&self) -> &'static str {
        "workflows"
    }
    fn tools(&self, _: &AgentScope<'_>) -> Vec<happy_providers::ToolDefinition> {
        if self.config.workflows_enabled() {
            tools::definitions()
        } else {
            Vec::new()
        }
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        tools::lifetime(call, "durable")
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        tools::lifetime(call, "reloadable")
    }
    fn permission_policy(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<ToolPermissionPolicy>> {
        self.workflow_policy(scope, call)
    }
    fn execute_transactional_tool(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        self.workflow_transaction(ctx, scope, call)
    }
    async fn execute_tool(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        self.workflow_async(scope, call, cancel).await
    }
    fn block(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        _: &str,
        block: &Block,
        _: Option<&str>,
    ) -> Result<()> {
        if self.schemas.valid(
            "ownerWorkflowCollaboratorMetadata",
            &scope.configuration["metadata"],
        )? && let Block::Text { text } = block
        {
            let text = format::trim(text);
            if !text.is_empty() {
                ctx.put_value(
                    scope.id,
                    &format!("kv.{}.run.module.workflows.lastText", scope.id),
                    &json!(text),
                )?;
            }
        }
        Ok(())
    }
    fn after_inference(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        inference: &Inference<'_>,
    ) -> Result<()> {
        if self.schemas.valid(
            "ownerWorkflowCollaboratorMetadata",
            &scope.configuration["metadata"],
        )? && let happy_providers::Outcome::Error { error } = inference.outcome
        {
            let error = error.to_string();
            ctx.put_value(
                scope.id,
                &format!("kv.{}.run.module.workflows.lastError", scope.id),
                &json!(if format::trim(&error).is_empty() {
                    "The agent did not answer."
                } else {
                    format::trim(&error)
                }),
            )?;
        }
        Ok(())
    }
    fn loop_error(&self, ctx: &Context<'_>, scope: &AgentScope<'_>, error: &str) -> Result<()> {
        if self.schemas.valid(
            "ownerWorkflowCollaboratorMetadata",
            &scope.configuration["metadata"],
        )? {
            ctx.put_value(
                scope.id,
                &format!("kv.{}.run.module.workflows.lastError", scope.id),
                &json!(error),
            )?;
        }
        Ok(())
    }
    fn settled_detail(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        _: &str,
        _: &str,
        error: Option<&str>,
    ) -> Result<()> {
        if !self.schemas.valid(
            "ownerWorkflowCollaboratorMetadata",
            &scope.configuration["metadata"],
        )? {
            return Ok(());
        }
        let text = ctx
            .value(
                scope.id,
                &format!("kv.{}.run.module.workflows.lastText", scope.id),
            )?
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        let failure = ctx
            .value(
                scope.id,
                &format!("kv.{}.run.module.workflows.lastError", scope.id),
            )?
            .and_then(|value| value.as_str().map(str::to_owned))
            .or_else(|| error.map(str::to_owned))
            .unwrap_or_default();
        let (answer, failure) = if format::trim(&text).is_empty() {
            (
                None,
                Some(if format::trim(&failure).is_empty() {
                    "The agent finished without answering.".to_owned()
                } else {
                    format::trim(&failure).to_owned()
                }),
            )
        } else {
            (Some(json!(format::trim(&text)).to_string()), None)
        };
        ctx.database().execute("UPDATE happy_agent_module_workflow_agent_calls SET output_json=?1,error=?2 WHERE collaborator_id=?3",rusqlite::params![answer,failure,scope.id])?;
        let changed = self.changed.clone();
        ctx.after_commit(move || changed.send_modify(|version| *version = version.wrapping_add(1)))
    }
    async fn after_start(&self) -> Result<()> {
        if !self.config.workflows_enabled() {
            return Ok(());
        }
        let owner = self
            .owner
            .upgrade()
            .context("The workflow owner was closed.")?;
        self.runtime.transact(move|ctx|{let mut statement=ctx.database().prepare("SELECT agent_id,id FROM happy_agent_module_workflow_runs WHERE status='running' ORDER BY agent_id,id LIMIT 10001")?;let rows=statement.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;anyhow::ensure!(rows.len()<=10000,"The workflow restoration bound was reached.");drop(statement);for(agent,id)in rows{if persistence::read_request(ctx,&owner.schemas,&agent,&id)?.is_some(){owner.intent(ctx,&agent,&id,Some(&id))?;}else if let Some(mut run)=persistence::read_run(ctx,&owner.schemas,&agent,&id)?{let at=now();run["status"]=json!("paused");run["updatedAt"]=json!(at);run["pausedAt"]=json!(at);persistence::write_run(ctx,&owner.schemas,&run)?;}}Ok(())}).await
    }
}
