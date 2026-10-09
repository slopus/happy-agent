use super::{
    config::{ConfigModule, Document},
    events::EventsModule,
    history::HistoryModule,
    identity::{now, resource_version},
    lifecycle::LifecycleModule,
    projects::ProjectsModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
    tools::{ToolOutcome, ToolsModule},
    usage::UsageModule,
    workspaces::WorkspacesModule,
};
use anyhow::{Context as _, Result};
use happy_providers::{
    Accumulator, Block, Event, Message, Outcome, RunRequest, Session, SessionContext,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

pub struct AgentSystemModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    events: Arc<EventsModule>,
    history: Arc<HistoryModule>,
    tools: Arc<ToolsModule>,
    usage: Arc<UsageModule>,
    lifecycle: Arc<LifecycleModule>,
    projects: Arc<ProjectsModule>,
    workspaces: Arc<WorkspacesModule>,
    schemas: Schemas,
    workers: Mutex<BTreeMap<String, tokio::task::JoinHandle<()>>>,
}
struct Snapshot {
    configuration: Value,
    settings: Value,
    owed: Option<Value>,
    calls: Vec<(String, Value)>,
    context: SessionContext,
    open_calls: Vec<Value>,
    native_ids: BTreeMap<String, String>,
}
impl AgentSystemModule {
    // Keep the feature dependency graph explicit rather than injecting a host.
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
        Ok(Self {
            config,
            runtime,
            events,
            history,
            tools,
            usage,
            lifecycle,
            projects,
            workspaces,
            schemas: Schemas::new()?,
            workers: Mutex::new(BTreeMap::new()),
        })
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        let agents = self.clone();
        let active=self.runtime.transact(move|ctx|{
            let mut statement=ctx.database().prepare("SELECT substr(key,20) FROM happy_agent_values WHERE owner_id='' AND key GLOB 'agentSystem.config.*' ORDER BY key LIMIT 10001")?;
            let ids=statement.query_map([],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            anyhow::ensure!(ids.len()<=10000,"The agent catalog exceeds its restoration bound.");
            let mut active=Vec::new();
            for id in ids {
                anyhow::ensure!(agents.schemas.valid("cuid2",&json!(id))?,"The stored agent identity is invalid.");
                let configuration=agents.configuration(ctx,&id)?.context("A catalogued agent has no configuration.")?;
                anyhow::ensure!(agents.schemas.valid("agentConfig",&configuration)?,"A stored agent configuration is invalid.");
                if let Some(owed)=agents.owed(ctx,&id)? {active.push((id,owed["stage"].as_str().unwrap_or("inference").to_owned()));}
            }
            Ok(active)
        }).await?;
        // Restoration is a module barrier. Queued input without owed work stays idle.
        for (id, stage) in active {
            self.lifecycle.set_agent_stage(&id, Some(&stage));
            self.start_worker(id);
        }
        Ok(())
    }
    fn start_worker(self: &Arc<Self>, id: String) {
        let mut workers = self
            .workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if workers.get(&id).is_some_and(|worker| !worker.is_finished()) {
            return;
        }
        workers.retain(|_, worker| !worker.is_finished());
        let agents = self.clone();
        let worker_id = id.clone();
        workers.insert(
            id,
            tokio::spawn(async move {
                if let Err(error) = agents.work(&worker_id).await {
                    eprintln!("Agent {worker_id} stopped with durable work retained: {error:#}");
                }
                agents.lifecycle.set_agent_stage(&worker_id, None);
            }),
        );
    }
    pub async fn close(&self) {
        let workers = std::mem::take(
            &mut *self
                .workers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        for (_, worker) in workers {
            let _ = worker.await;
        }
    }
    pub fn configuration(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        let root = read(ctx, "", &format!("agentSystem.config.{id}"))?;
        if root.is_none() {
            return Ok(None);
        }
        Ok(read(ctx, id, "agentConfig")?.or(root))
    }
    fn owed(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        Ok(read(ctx, id, "owed")?
            .filter(|value| self.schemas.valid("owed", value).unwrap_or(false)))
    }
    pub async fn focused(self: &Arc<Self>, id: String) -> Result<Option<Value>> {
        let agents = self.clone();
        self.runtime.transact(move|ctx|{
            agents.resource(ctx,&id)?.map(|agent|Ok(json!({"agent":agent,"profiles":[],"slashCommands":[{"description":"Summarize older messages to free context space.","hasArguments":false,"kind":"compaction","name":"compact"}]}))).transpose()
        }).await
    }
    pub async fn mode(self: &Arc<Self>, id: String) -> Result<Option<Value>> {
        let agents = self.clone();
        self.runtime.transact(move|ctx|Ok(agents.configuration(ctx,&id)?.map(|configuration|json!({"mode":configuration["metadata"].get("lastMode").cloned().unwrap_or(Value::Null)})))).await
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
        self.runtime.transact(move|ctx|{
            if agents.configuration(ctx,&id)?.is_none(){return Ok(None);}
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
        let parent = read(ctx, "", &format!("agentSystem.parent.{id}"))?
            .and_then(|value| value.as_str().map(str::to_owned));
        let mut statement=ctx.database().prepare("SELECT count(*) FROM happy_agent_values WHERE owner_id='' AND key GLOB 'agentSystem.parent.*' AND value_json=?1")?;
        let children: i64 = statement.query_row([json!(id).to_string()], |row| row.get(0))?;
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
        let owed = self.owed(ctx, id)?;
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
            json!({"id":id,"workspaceId":association.map(|association|association.0).unwrap_or_default(),"parentAgentId":parent,"subtask":false,"subtasks":[],"subtaskOrderKey":null,"userVisible":order.is_some(),"managedByAnotherAgent":parent.is_some(),"canSendMessages":parent.is_none()&&archived.is_null(),"title":metadata.get("title").cloned().unwrap_or(Value::Null),"titleStatus":if metadata["title"].is_string(){"ready"}else{"idle"},"status":status,"subagents":{"total":children,"running":0},"processes":{"running":0},"pendingQuestionId":null,"unread":metadata.get("unread").cloned().unwrap_or(Value::Null),"orderKey":order,"lastCursor":latest.as_ref().map_or_else(||self.events.cursor(),|event|event.0.clone()),"version":version,"createdAt":created,"updatedAt":updated,"archivedAt":archived}),
        ))
    }
    fn snapshot(&self, ctx: &Context<'_>, id: &str) -> Result<Snapshot> {
        let configuration = self
            .configuration(ctx, id)?
            .context("The agent no longer exists.")?;
        let settings = read(ctx, id, "settings")?.unwrap_or(json!({}));
        let mut calls=ctx.database().prepare("SELECT key,value_json FROM happy_agent_values WHERE owner_id=?1 AND key GLOB 'tool.*' ORDER BY key LIMIT 2049")?;
        let calls = calls
            .query_map([id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .map(|row| {
                let (key, encoded) = row?;
                let value: Value = serde_json::from_str(&encoded)?;
                anyhow::ensure!(
                    self.schemas.valid("pendingCall", &value)?,
                    "A dispatched tool call is invalid."
                );
                Ok((key, value))
            })
            .collect::<Result<Vec<_>>>()?;
        anyhow::ensure!(
            calls.len() <= 2048,
            "The dispatched tool batch exceeds its allowed size."
        );
        let count: i64 = ctx.database().query_row(
            "SELECT count(*) FROM happy_agent_records WHERE owner_id=?1",
            [id],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            count <= 100000,
            "The private agent context exceeds its restoration bound."
        );
        let mut statement = ctx.database().prepare(
            "SELECT record_json FROM happy_agent_records WHERE owner_id=?1 ORDER BY position",
        )?;
        let mut bytes = 0;
        let mut records = Vec::new();
        for row in statement.query_map([id], |row| row.get::<_, String>(0))? {
            let encoded = row?;
            bytes += encoded.len();
            anyhow::ensure!(
                bytes <= 128 * 1024 * 1024,
                "The private context exceeds its restoration byte bound."
            );
            let value: Value = serde_json::from_str(&encoded)?;
            anyhow::ensure!(
                self.schemas.valid("privateRecord", &value)?,
                "A private agent context record is invalid."
            );
            records.push(value);
        }
        let (context, open_calls, native_ids) = restore_context(records)?;
        Ok(Snapshot {
            configuration,
            settings,
            owed: self.owed(ctx, id)?,
            calls,
            context,
            open_calls,
            native_ids,
        })
    }
    async fn work(self: &Arc<Self>, id: &str) -> Result<()> {
        let mut restored = true;
        loop {
            if self.lifecycle.shutdown.is_cancelled() {
                return Ok(());
            }
            let agents = self.clone();
            let agent = id.to_owned();
            let snapshot = self
                .runtime
                .transact(move |ctx| agents.snapshot(ctx, &agent))
                .await?;
            let Some(owed) = snapshot.owed.as_ref() else {
                return Ok(());
            };
            let stage = owed["stage"]
                .as_str()
                .context("The owed work has no stage.")?;
            self.lifecycle.set_agent_stage(id, Some(stage));
            if self.lifecycle.is_draining() {
                return Ok(());
            }
            if !snapshot.calls.is_empty() {
                self.execute_batch(id, snapshot, restored).await?;
                restored = false;
                continue;
            }
            if !snapshot.open_calls.is_empty() {
                self.dispatch(id, &snapshot).await?;
                restored = false;
                continue;
            }
            match stage {
                "settlement" => {
                    self.settle(id, "completed", "completed").await?;
                    return Ok(());
                }
                "inference" | "tools" => {
                    self.infer(id, snapshot).await?;
                }
                "compaction" => {
                    anyhow::bail!("Durable compaction execution has not been migrated yet.")
                }
                _ => unreachable!("validated owed stage"),
            }
            restored = false;
        }
    }
    fn flush_pending(&self, ctx: &Context<'_>, id: &str, settings: &Value) -> Result<()> {
        let prefix = format!("kv.{id}.run.module.history.");
        let blocks = read(ctx, id, &format!("{prefix}pending_blocks"))?.unwrap_or(json!([]));
        if blocks.as_array().is_none_or(Vec::is_empty) {
            return Ok(());
        }
        let inference = read(ctx, id, &format!("{prefix}pending_inference_id"))?
            .context("Pending history has no owning inference identity.")?;
        let inference = inference
            .as_str()
            .context("Pending history inference identity is invalid.")?;
        if self.history.existing(ctx, id, inference)?.is_none() {
            let mut message = json!({"role":"assistant","at":now(),"blocks":blocks,"recordId":inference,"runId":self.events.run_id(ctx,id)?});
            attribution(&mut message, settings);
            self.history.append(ctx, id, &message)?;
        }
        delete(ctx, id, &format!("{prefix}pending_blocks"))?;
        delete(ctx, id, &format!("{prefix}pending_inference_id"))?;
        Ok(())
    }
    async fn dispatch(self: &Arc<Self>, id: &str, snapshot: &Snapshot) -> Result<()> {
        let agents = self.clone();
        let id = id.to_owned();
        let settings = snapshot.settings.clone();
        let calls = snapshot.open_calls.clone();
        let mut owed = snapshot
            .owed
            .clone()
            .context("Dispatch has no owed loop identity.")?;
        self.runtime
            .transact(move |ctx| {
                agents.flush_pending(ctx, &id, &settings)?;
                for (index, call) in calls.iter().enumerate() {
                    write(
                        ctx,
                        &id,
                        &format!(
                            "tool.{index:06}.{}",
                            call["id"]
                                .as_str()
                                .context("A tool call has no identity.")?
                        ),
                        call,
                    )?;
                }
                owed["stage"] = json!("tools");
                write(ctx, &id, "owed", &owed)?;
                Ok(())
            })
            .await
    }
    async fn execute_batch(
        self: &Arc<Self>,
        id: &str,
        snapshot: Snapshot,
        restored: bool,
    ) -> Result<()> {
        for (key, call) in &snapshot.calls {
            if self.lifecycle.shutdown.is_cancelled() {
                return Ok(());
            }
            let outcome = if let Some(committed) = call.get("committed") {
                let message: Message = serde_json::from_value(committed.clone())?;
                ToolOutcome { message }
            } else if restored && !self.tools.reloadable(call) {
                interrupted(call)
            } else {
                self.tools
                    .execute(
                        &snapshot.configuration,
                        &snapshot.settings,
                        call,
                        self.lifecycle.shutdown.child_token(),
                    )
                    .await
            };
            if self.lifecycle.shutdown.is_cancelled() {
                return Ok(());
            }
            let agents = self.clone();
            let agent = id.to_owned();
            let key = key.clone();
            let call = call.clone();
            let native = snapshot
                .native_ids
                .get(call["id"].as_str().unwrap_or(""))
                .cloned()
                .context("The tool call has no provider correlation identity.")?;
            let settings = snapshot.settings.clone();
            self.runtime.transact(move|ctx|{
                agents.flush_pending(ctx,&agent,&settings)?;
                let id=call["id"].as_str().context("The tool identity is missing.")?;
                let claim=format!("toolResult.{id}");
                let result=read(ctx,&agent,&claim)?.unwrap_or(serde_json::to_value(&outcome.message)?);
                write(ctx,&agent,&claim,&result)?;
                let mut committed=call.clone();committed["committed"]=result.clone();write(ctx,&agent,&key,&committed)?;
                let result:Message=serde_json::from_value(result)?;
                let output=result.content().iter().filter_map(|block|if let Block::Text{text}=block{Some(text.as_str())}else{None}).collect::<Vec<_>>().join("\n");
                let mut private=serde_json::to_value(&result)?;private["callId"]=json!(native);
                agents.append_record(ctx,&agent,&json!({"type":"tool","id":id,"message":private}))?;
                agents.history.complete_tool(ctx,&agent,id,call["call"]["name"].as_str().unwrap_or(""),&output,matches!(result,Message::Tool{is_error:true,..}))?;
                delete(ctx,&agent,&key)?;delete(ctx,&agent,&claim)?;
                delete_scope(ctx,&agent,&format!("kv.{agent}.call.{id}."))?;
                delete_scope(ctx,&agent,&format!("kv.{agent}.run.call.{id}."))?;
                let remaining:i64=ctx.database().query_row("SELECT count(*) FROM happy_agent_values WHERE owner_id=?1 AND key GLOB 'tool.*'",[&agent],|row|row.get(0))?;
                if remaining==0 {let mut owed=agents.owed(ctx,&agent)?.context("The tools lost their owed loop identity.")?;owed["stage"]=json!("inference");owed.as_object_mut().context("The owed work is invalid.")?.remove("inferenceId");write(ctx,&agent,"owed",&owed)?;}
                Ok(())
            }).await?;
        }
        Ok(())
    }
    fn append_record(&self, ctx: &Context<'_>, agent: &str, record: &Value) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid("privateRecord", record)?,
            "The private agent record is invalid."
        );
        ctx.database().execute("INSERT INTO happy_agent_records(owner_id,position,record_json) SELECT ?1,coalesce(max(position),-1)+1,?2 FROM happy_agent_records WHERE owner_id=?1",params![agent,record.to_string()])?;
        Ok(())
    }
    async fn infer(self: &Arc<Self>, id: &str, mut snapshot: Snapshot) -> Result<()> {
        let inference = cuid2::create_id();
        let began = now();
        let agents = self.clone();
        let agent = id.to_owned();
        let identity = inference.clone();
        let settings = snapshot.settings.clone();
        self.runtime
            .transact(move |ctx| {
                agents.flush_pending(ctx, &agent, &settings)?;
                let mut active = agents
                    .events
                    .active_run(ctx, &agent)?
                    .context("Inference has no active public run.")?;
                active["inferenceId"] = json!(identity);
                active["blocks"] = json!([]);
                active["argumentBuffers"] = json!({});
                active["callIndexes"] = json!({});
                active["text"] = json!("");
                active["activeIndex"] = Value::Null;
                active["activeKind"] = Value::Null;
                active["hasProviderEvent"] = json!(false);
                agents.events.store_active(ctx, &agent, &active)?;
                let mut owed = agents
                    .owed(ctx, &agent)?
                    .context("Inference has no owed loop identity.")?;
                owed["stage"] = json!("inference");
                owed["inferenceId"] = json!(identity);
                write(ctx, &agent, "owed", &owed)?;
                write(
                    ctx,
                    &agent,
                    &format!("kv.{agent}.run.module.history.pending_inference_id"),
                    &json!(identity),
                )?;
                Ok(())
            })
            .await?;
        snapshot.context.instructions = self.config.read_document(Document::Instructions).await?;
        let session = self
            .config
            .session(id, &snapshot.settings, self.tools.codex_tools())
            .await;
        let mut session = match session {
            Ok(session) => session,
            Err(error) => {
                self.settle(id, "failed", "error").await?;
                return Err(error);
            }
        };
        let request = RunRequest {
            context: snapshot.context,
            model: snapshot.settings["model"].as_str().map(str::to_owned),
            effort: snapshot
                .settings
                .get("effort")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()?,
            service_tier: snapshot.settings["serviceTier"].as_str().map(str::to_owned),
            structured_output: None,
        };
        let (sender, mut receiver) = tokio::sync::mpsc::channel(64);
        let cancel = self.lifecycle.shutdown.child_token();
        let task = tokio::spawn(async move {
            session.run(request, cancel, sender).await;
            session.destroy().await;
        });
        let mut accumulator = Accumulator::default();
        let mut persisted = 0;
        let mut outcome = None;
        while let Some(event) = receiver.recv().await {
            accumulator.add(&event);
            if let Event::Done { outcome: finished } = &event {
                outcome = Some(finished.clone());
            }
            if matches!(event, Event::BlockStop) && accumulator.committed.len() > persisted {
                let blocks = accumulator.committed[persisted..].to_vec();
                persisted = accumulator.committed.len();
                let agents = self.clone();
                let agent = id.to_owned();
                let identity = inference.clone();
                self.runtime
                    .transact(move |ctx| {
                        let mut history = read(
                            ctx,
                            &agent,
                            &format!("kv.{agent}.run.module.history.pending_blocks"),
                        )?
                        .unwrap_or(json!([]));
                        let history = history
                            .as_array_mut()
                            .context("Pending inference blocks are invalid.")?;
                        for block in blocks {
                            let mut record = json!({"type":"block","block":block});
                            let base_id = if matches!(
                                block,
                                Block::ToolCall { .. } | Block::ToolResult { .. }
                            ) {
                                Some(cuid2::create_id())
                            } else {
                                None
                            };
                            if let Some(id) = &base_id {
                                record["id"] = json!(id);
                            }
                            agents.append_record(ctx, &agent, &record)?;
                            if let Some(block) = history_block(&block, base_id.as_deref()) {
                                history.push(block);
                            }
                        }
                        write(
                            ctx,
                            &agent,
                            &format!("kv.{agent}.run.module.history.pending_blocks"),
                            &json!(history),
                        )?;
                        write(
                            ctx,
                            &agent,
                            &format!("kv.{agent}.run.module.history.pending_inference_id"),
                            &json!(identity),
                        )?;
                        Ok(())
                    })
                    .await?;
            }
        }
        task.await?;
        if self.lifecycle.shutdown.is_cancelled() {
            return Ok(());
        }
        let outcome = outcome.context("The provider ended without an inference outcome.")?;
        let agents = self.clone();
        let agent = id.to_owned();
        let identity = inference;
        let settings = snapshot.settings;
        let ended = now().max(began);
        self.runtime.transact(move|ctx|{
            agents.flush_pending(ctx,&agent,&settings)?;
            let run=agents.events.run_id(ctx,&agent)?.context("Inference has no public run identity.")?;
            let (state,usage)=match &outcome {Outcome::Normal{usage}=>("normal",Some(usage)),Outcome::ToolCall{usage}=>("tool_call",Some(usage)),Outcome::Length{usage}=>("length",Some(usage)),Outcome::Cancelled=>("cancelled",None),Outcome::Error{..}=>("error",None)};
            if let Some(usage)=usage {
                let mut record=json!({"id":identity,"kind":"inference","agentId":agent,"runId":run,"provider":settings["provider"],"state":state,"tokens":{"input":usage.input,"output":usage.output,"cacheRead":usage.cache_read,"cacheWrite":usage.cache_write},"startedAt":began,"finishedAt":ended,"durationMs":ended-began});
                for field in ["model","effort"] {if let Some(value)=settings.get(field){record[field]=value.clone();}}
                if let Some(tier)=settings["serviceTier"].as_str(){record["tier"]=json!(tier);}
                agents.usage.record(ctx,&record)?;
            }
            let snapshot=agents.snapshot(ctx,&agent)?;
            let mut owed=agents.owed(ctx,&agent)?.context("Inference lost its owed loop identity.")?;
            if !snapshot.open_calls.is_empty(){owed["stage"]=json!("inference");}else{owed["stage"]=json!("settlement");owed["settlementId"]=json!(cuid2::create_id());}
            write(ctx,&agent,"owed",&owed)?;
            if let Outcome::Error{error}=outcome {
                let message=json!({"role":"error","at":ended,"blocks":[{"type":"text","text":error.to_string()}],"recordId":format!("{identity}-error"),"runId":run});agents.history.append(ctx,&agent,&message)?;
            }
            Ok(())
        }).await
    }
    async fn settle(self: &Arc<Self>, id: &str, status: &str, reason: &str) -> Result<()> {
        let agents = self.clone();
        let id = id.to_owned();
        let status = status.to_owned();
        let reason = reason.to_owned();
        self.runtime
            .transact(move |ctx| {
                let previous = agents
                    .resource(ctx, &id)?
                    .context("The settling agent no longer exists.")?["version"]
                    .as_str()
                    .context("The agent version is invalid.")?
                    .to_owned();
                let run = agents.events.settle(ctx, &id)?;
                let summary = agents
                    .history
                    .finish_run(ctx, &id, &run, &status, &reason)?;
                delete(ctx, &id, "owed")?;
                delete_scope(ctx, &id, &format!("kv.{id}.run."))?;
                let mut config = agents
                    .configuration(ctx, &id)?
                    .context("The settling configuration is missing.")?;
                if !config["metadata"].is_object() {
                    config["metadata"] = json!({});
                }
                config["metadata"]["unread"] = json!({"reason":"turn_finished","since":now()});
                config["metadata"]["updatedAt"] = json!(now());
                write(ctx, &id, "agentConfig", &config)?;
                agents.events.record(
                    ctx,
                    Some(&id),
                    "run.finished",
                    json!({"agentId":id,"run":summary}),
                )?;
                agents.events.record_versioned(
                    ctx,
                    &id,
                    &previous,
                    json!({"status":"idle","unread":config["metadata"]["unread"]}),
                )?;
                Ok(())
            })
            .await
    }
}
fn interrupted(call: &Value) -> ToolOutcome {
    let output = "The tool call was interrupted by a restart and was not retried.".to_owned();
    ToolOutcome {
        message: Message::Tool {
            call_id: call["id"].as_str().unwrap_or("").into(),
            content: vec![Block::text(&output)],
            is_error: true,
            vendor: None,
        },
    }
}
fn attribution(message: &mut Value, settings: &Value) {
    for field in ["provider", "model"] {
        if let Some(value) = settings.get(field) {
            message[field] = value.clone();
        }
    }
}
fn history_block(block: &Block, id: Option<&str>) -> Option<Value> {
    match block {
        Block::Text { text } => Some(json!({"type":"text","text":text})),
        Block::Reasoning {
            text: Some(text), ..
        } => Some(json!({"type":"thinking","thinking":text})),
        Block::Image { data, mime_type } => {
            Some(json!({"type":"image","data":data,"mediaType":mime_type}))
        }
        Block::ToolCall {
            name, arguments, ..
        } => Some(
            json!({"type":"tool_call","callId":id?,"name":name,"arguments":serde_json::from_str::<Value>(arguments).unwrap_or(json!(arguments))}),
        ),
        _ => None,
    }
}
fn restore_context(
    records: Vec<Value>,
) -> Result<(SessionContext, Vec<Value>, BTreeMap<String, String>)> {
    let mut messages = Vec::<Message>::new();
    let mut assistant = Vec::new();
    let mut open = BTreeMap::<String, Value>::new();
    let mut order = Vec::new();
    let mut native_ids = BTreeMap::new();
    for record in records {
        if record["type"] != "block" && !assistant.is_empty() {
            messages.push(Message::Assistant {
                content: std::mem::take(&mut assistant),
            });
        }
        match record["type"].as_str().unwrap_or("") {
            "user" | "system" => messages.push(serde_json::from_value(record["message"].clone())?),
            "block" => {
                let block: Block = serde_json::from_value(record["block"].clone())?;
                if let Block::ToolCall {
                    call_id,
                    server: false,
                    ..
                } = &block
                {
                    let id = record["id"]
                        .as_str()
                        .context("A persisted client tool call has no base identity.")?
                        .to_owned();
                    native_ids.insert(id.clone(), call_id.clone());
                    let mut call = record["block"].clone();
                    call.as_object_mut()
                        .context("The tool call is invalid.")?
                        .remove("callId");
                    call.as_object_mut()
                        .context("The tool call is invalid.")?
                        .remove("server");
                    open.insert(id.clone(), json!({"id":id,"call":call}));
                    order.push(id);
                }
                assistant.push(block);
            }
            "tool" => {
                let id = record["id"]
                    .as_str()
                    .context("The persisted tool result has no base identity.")?;
                open.remove(id);
                messages.push(serde_json::from_value(record["message"].clone())?);
            }
            "compaction" => {
                messages = serde_json::from_value(record["messages"].clone())?;
                open.clear();
                order.clear();
                native_ids.clear();
                for pair in record["contextToolIds"]
                    .as_array()
                    .context("The compaction correlation map is invalid.")?
                {
                    native_ids.insert(
                        pair[0]
                            .as_str()
                            .context("Invalid base correlation.")?
                            .into(),
                        pair[1]
                            .as_str()
                            .context("Invalid native correlation.")?
                            .into(),
                    );
                }
                for message in &mut messages {
                    rewrite_native(message, &native_ids);
                }
            }
            _ => anyhow::bail!("The private context record is invalid."),
        }
    }
    if !assistant.is_empty() {
        messages.push(Message::Assistant { content: assistant });
    }
    Ok((
        SessionContext {
            instructions: String::new(),
            messages,
        },
        order
            .into_iter()
            .filter_map(|id| open.remove(&id))
            .collect(),
        native_ids,
    ))
}
fn rewrite_native(message: &mut Message, ids: &BTreeMap<String, String>) {
    match message {
        Message::Assistant { content } => {
            for block in content {
                if let Block::ToolCall { call_id, .. } | Block::ToolResult { call_id, .. } = block
                    && let Some(native) = ids.get(call_id)
                {
                    *call_id = native.clone();
                }
            }
        }
        Message::Tool { call_id, .. } => {
            if let Some(native) = ids.get(call_id) {
                *call_id = native.clone();
            }
        }
        _ => {}
    }
}
fn read(ctx: &Context<'_>, owner: &str, key: &str) -> Result<Option<Value>> {
    let value: Option<String> = ctx
        .database()
        .query_row(
            "SELECT value_json FROM happy_agent_values WHERE owner_id=?1 AND key=?2",
            params![owner, key],
            |row| row.get(0),
        )
        .optional()?;
    value
        .map(|value| serde_json::from_str(&value).map_err(Into::into))
        .transpose()
}
fn write(ctx: &Context<'_>, owner: &str, key: &str, value: &Value) -> Result<()> {
    ctx.database().execute("INSERT INTO happy_agent_values(owner_id,key,value_json) VALUES(?1,?2,?3) ON CONFLICT(owner_id,key) DO UPDATE SET value_json=excluded.value_json",params![owner,key,value.to_string()])?;
    Ok(())
}
fn delete(ctx: &Context<'_>, owner: &str, key: &str) -> Result<()> {
    ctx.database().execute(
        "DELETE FROM happy_agent_values WHERE owner_id=?1 AND key=?2",
        params![owner, key],
    )?;
    Ok(())
}
fn delete_scope(ctx: &Context<'_>, owner: &str, prefix: &str) -> Result<()> {
    ctx.database().execute(
        "DELETE FROM happy_agent_values WHERE owner_id=?1 AND substr(key,1,length(?2))=?2",
        params![owner, prefix],
    )?;
    Ok(())
}
