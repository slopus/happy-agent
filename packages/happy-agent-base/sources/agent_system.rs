use crate::{DatabaseContext, RuntimeSchemas, SqliteDatabase};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use happy_providers::{
    Accumulator, Block, Event, Message, Outcome, RunRequest, Session, SessionContext,
    ToolDefinition,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
};
use tokio_util::sync::CancellationToken;

/// The immutable agent data a feature hook is serving. External capabilities
/// remain on each module's own explicit feature dependencies.
pub struct AgentScope<'a> {
    pub id: &'a str,
    pub configuration: &'a Value,
    pub settings: &'a Value,
}
pub struct AcceptedInput {
    pub input: Value,
    pub requested_call: Option<Value>,
}
pub struct Inference<'a> {
    pub id: &'a str,
    pub started_at: u64,
    pub finished_at: u64,
    pub outcome: &'a Outcome,
}

/// Actual feature modules extend the single durable loop through their hooks.
/// No hook receives an application host or a collection of ambient services.
#[async_trait]
pub trait AgentModule: Send + Sync {
    fn name(&self) -> &'static str;
    fn shutdown(&self) -> Option<CancellationToken> {
        None
    }
    fn draining(&self) -> bool {
        false
    }
    fn stage(&self, _id: &str, _stage: Option<&str>) {}
    fn compatible(&self, _previous: &Value, _next: &Value) -> Option<Result<bool>> {
        None
    }
    fn model_changed(
        &self,
        _ctx: &DatabaseContext<'_>,
        _scope: &AgentScope<'_>,
        _previous: &Value,
    ) -> Result<Option<Message>> {
        Ok(None)
    }
    fn history_erased(&self, _ctx: &DatabaseContext<'_>, _scope: &AgentScope<'_>) -> Result<()> {
        Ok(())
    }
    fn accepted(
        &self,
        _ctx: &DatabaseContext<'_>,
        _scope: &AgentScope<'_>,
        _inputs: &[AcceptedInput],
        _steering: bool,
    ) -> Result<()> {
        Ok(())
    }
    fn record(
        &self,
        _ctx: &DatabaseContext<'_>,
        _scope: &AgentScope<'_>,
        _record: &Value,
    ) -> Result<()> {
        Ok(())
    }
    fn before_tools(&self, _ctx: &DatabaseContext<'_>, _scope: &AgentScope<'_>) -> Result<()> {
        Ok(())
    }
    fn before_inference(
        &self,
        _ctx: &DatabaseContext<'_>,
        _scope: &AgentScope<'_>,
        _inference: &str,
    ) -> Result<()> {
        Ok(())
    }
    fn block(
        &self,
        _ctx: &DatabaseContext<'_>,
        _scope: &AgentScope<'_>,
        _inference: &str,
        _block: &Block,
        _base_id: Option<&str>,
    ) -> Result<()> {
        Ok(())
    }
    fn after_inference(
        &self,
        _ctx: &DatabaseContext<'_>,
        _scope: &AgentScope<'_>,
        _inference: &Inference<'_>,
    ) -> Result<()> {
        Ok(())
    }
    fn inference_event(
        &self,
        _ctx: &DatabaseContext<'_>,
        _scope: &AgentScope<'_>,
        _inference: &Inference<'_>,
        _event: &Event,
    ) -> Result<()> {
        Ok(())
    }
    fn tool_result(
        &self,
        _ctx: &DatabaseContext<'_>,
        _scope: &AgentScope<'_>,
        _call: &Value,
        _result: &Message,
    ) -> Result<()> {
        Ok(())
    }
    fn settlement_status(
        &self,
        _ctx: &DatabaseContext<'_>,
        _scope: &AgentScope<'_>,
    ) -> Result<Option<(String, String)>> {
        Ok(None)
    }
    fn settled(
        &self,
        _ctx: &DatabaseContext<'_>,
        _scope: &AgentScope<'_>,
        _status: &str,
        _reason: &str,
    ) -> Result<()> {
        Ok(())
    }
    fn tools(&self, _scope: &AgentScope<'_>) -> Vec<ToolDefinition> {
        Vec::new()
    }
    fn reloadable(&self, _call: &Value) -> Option<bool> {
        None
    }
    async fn instructions(&self, _scope: &AgentScope<'_>) -> Result<String> {
        Ok(String::new())
    }
    async fn session(
        &self,
        _scope: &AgentScope<'_>,
        _tools: Vec<ToolDefinition>,
    ) -> Option<Result<Box<dyn Session>>> {
        None
    }
    async fn execute_tool(
        &self,
        _scope: &AgentScope<'_>,
        _call: &Value,
        _cancel: CancellationToken,
    ) -> Option<Message> {
        None
    }
    async fn permission_changed(&self, _agent: &str, _previous: &str, _next: &str) {}
    async fn close(&self) {}
}

pub struct AgentSystem {
    database: Arc<SqliteDatabase>,
    modules: Vec<Arc<dyn AgentModule>>,
    schemas: RuntimeSchemas,
    shutdown: CancellationToken,
    workers: Mutex<BTreeMap<String, Worker>>,
}
struct Worker {
    handle: tokio::task::JoinHandle<()>,
    wake: u64,
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
impl Snapshot {
    fn scope<'a>(&'a self, id: &'a str) -> AgentScope<'a> {
        AgentScope {
            id,
            configuration: &self.configuration,
            settings: &self.settings,
        }
    }
}
impl AgentSystem {
    pub fn new(database: Arc<SqliteDatabase>, modules: Vec<Arc<dyn AgentModule>>) -> Result<Self> {
        static SCHEMAS: OnceLock<std::result::Result<RuntimeSchemas, String>> = OnceLock::new();
        let schemas = SCHEMAS
            .get_or_init(|| {
                RuntimeSchemas::compile(include_str!("agent_schemas.json"))
                    .map_err(|error| format!("{error:#}"))
            })
            .as_ref()
            .map_err(|error| anyhow::anyhow!("{error}"))?
            .clone();
        let shutdown = modules
            .iter()
            .find_map(|module| module.shutdown())
            .context("The agent system has no owning lifetime.")?;
        let mut names = std::collections::BTreeSet::new();
        for module in &modules {
            anyhow::ensure!(
                names.insert(module.name()),
                "The agent system contains duplicate modules."
            );
        }
        Ok(Self {
            database,
            modules,
            schemas,
            shutdown,
            workers: Mutex::new(BTreeMap::new()),
        })
    }
    pub fn configuration(&self, ctx: &DatabaseContext<'_>, id: &str) -> Result<Option<Value>> {
        self.database.assert_context(ctx)?;
        let root = read(ctx, "", &format!("agentSystem.config.{id}"))?;
        if root.is_none() {
            return Ok(None);
        }
        Ok(read(ctx, id, "agentConfig")?.or(root))
    }
    pub fn owed(&self, ctx: &DatabaseContext<'_>, id: &str) -> Result<Option<Value>> {
        Ok(read(ctx, id, "owed")?
            .filter(|value| self.schemas.valid("owed", value).unwrap_or(false)))
    }
    pub fn create(&self, ctx: &DatabaseContext<'_>, id: &str, configuration: &Value) -> Result<()> {
        self.database.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("cuid2", &json!(id))?
                && self.schemas.valid("agentConfig", configuration)?,
            "The new agent configuration is invalid."
        );
        if self.configuration(ctx, id)?.is_some() {
            return Ok(());
        }
        write(ctx, "", &format!("agentSystem.config.{id}"), configuration)?;
        write(ctx, id, "agentConfig", configuration)
    }
    pub fn enqueue(
        self: &Arc<Self>,
        ctx: &DatabaseContext<'_>,
        agent: &str,
        input: &Value,
        steering: bool,
    ) -> Result<()> {
        self.database.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("queuedInput", input)?,
            "The queued input is invalid."
        );
        anyhow::ensure!(
            self.configuration(ctx, agent)?.is_some(),
            "The agent does not exist."
        );
        let id = input["id"]
            .as_str()
            .context("The queued input has no identity.")?;
        let prefix = if steering { "steering." } else { "send." };
        let last: Option<String> = ctx.database().query_row("SELECT max(key) FROM happy_agent_values WHERE owner_id=?1 AND substr(key,1,length(?2))=?2", params![agent, prefix], |row| row.get(0))?;
        let timestamp = format!("{:014}", now());
        let (mut slot, mut sequence) = (timestamp.clone(), 0u64);
        if let Some(last) = last {
            let parts = last
                .strip_prefix(prefix)
                .context("The queue key is invalid.")?
                .split_once('.')
                .context("The queue key is invalid.")?;
            if timestamp.as_str() <= parts.0 {
                slot = parts.0.into();
                sequence = parts.1.parse::<u64>()? + 1;
            }
        }
        ctx.database().execute(
            "INSERT INTO happy_agent_values(owner_id,key,value_json) VALUES(?1,?2,'true')",
            params![agent, format!("message.{id}")],
        )?;
        ctx.database().execute(
            "INSERT INTO happy_agent_values(owner_id,key,value_json) VALUES(?1,?2,?3)",
            params![
                agent,
                format!("{prefix}{slot}.{sequence:06}"),
                input.to_string()
            ],
        )?;
        if self.owed(ctx, agent)?.is_none() {
            write(
                ctx,
                agent,
                "owed",
                &json!({"stage":"inference","loopId":cuid2::create_id()}),
            )?;
        }
        let system = self.clone();
        let agent = agent.to_owned();
        ctx.after_commit(move || system.start_worker(agent))
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        let system = self.clone();
        let active = self.database.transact(move |ctx| {
            let mut statement = ctx.database().prepare("SELECT substr(key,20) FROM happy_agent_values WHERE owner_id='' AND key GLOB 'agentSystem.config.*' ORDER BY key LIMIT 10001")?;
            let ids = statement.query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            anyhow::ensure!(ids.len() <= 10000, "The agent catalog exceeds its restoration bound.");
            let mut active = Vec::new();
            for id in ids {
                anyhow::ensure!(system.schemas.valid("cuid2", &json!(id))?, "The stored agent identity is invalid.");
                let configuration = system.configuration(ctx, &id)?.context("A catalogued agent has no configuration.")?;
                anyhow::ensure!(system.schemas.valid("agentConfig", &configuration)?, "A stored agent configuration is invalid.");
                if let Some(owed) = system.owed(ctx, &id)? { active.push((id, owed["stage"].as_str().unwrap_or("inference").to_owned())); }
            }
            Ok(active)
        }).await?;
        for (id, stage) in active {
            self.stage(&id, Some(&stage));
            self.start_worker(id);
        }
        Ok(())
    }
    fn stage(&self, id: &str, stage: Option<&str>) {
        for module in &self.modules {
            module.stage(id, stage);
        }
    }
    pub fn start_worker(self: &Arc<Self>, id: String) {
        let mut workers = self
            .workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(worker) = workers.get_mut(&id)
            && !worker.handle.is_finished()
        {
            worker.wake = worker.wake.saturating_add(1);
            return;
        }
        workers.retain(|_, worker| !worker.handle.is_finished());
        let system = self.clone();
        let worker_id = id.clone();
        workers.insert(
            id,
            Worker {
                wake: 0,
                handle: tokio::spawn(async move {
                    loop {
                        let generation = system
                            .workers
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .get(&worker_id)
                            .map_or(0, |worker| worker.wake);
                        let result = system.work(&worker_id).await;
                        if let Err(error) = &result {
                            eprintln!(
                                "Agent {worker_id} stopped with durable work retained: {error:#}"
                            );
                        }
                        system.stage(&worker_id, None);
                        let mut workers = system
                            .workers
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let again = result.is_ok()
                            && !system.shutdown.is_cancelled()
                            && !system.modules.iter().any(|module| module.draining())
                            && workers
                                .get(&worker_id)
                                .is_some_and(|worker| worker.wake != generation);
                        if !again {
                            workers.remove(&worker_id);
                            return;
                        }
                    }
                }),
            },
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
            let _ = worker.handle.await;
        }
        for module in &self.modules {
            module.close().await;
        }
    }
    fn snapshot(&self, ctx: &DatabaseContext<'_>, id: &str) -> Result<Snapshot> {
        let configuration = self
            .configuration(ctx, id)?
            .context("The agent no longer exists.")?;
        let settings = read(ctx, id, "settings")?.unwrap_or(json!({}));
        let mut calls = ctx.database().prepare("SELECT key,value_json FROM happy_agent_values WHERE owner_id=?1 AND key GLOB 'tool.*' ORDER BY key LIMIT 2049")?;
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
            if self.shutdown.is_cancelled() {
                return Ok(());
            }
            let system = self.clone();
            let agent = id.to_owned();
            let snapshot = self
                .database
                .transact(move |ctx| system.snapshot(ctx, &agent))
                .await?;
            let Some(owed) = snapshot.owed.as_ref() else {
                return Ok(());
            };
            let stage = owed["stage"]
                .as_str()
                .context("The owed work has no stage.")?;
            self.stage(id, Some(stage));
            if self.modules.iter().any(|module| module.draining()) {
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
            let can_accept_send = stage == "settlement"
                || snapshot
                    .context
                    .messages
                    .last()
                    .is_none_or(|message| matches!(message, Message::Assistant { .. }));
            if self.accept_queue(id, can_accept_send).await? {
                restored = false;
                continue;
            }
            match stage {
                "settlement" => {
                    let system = self.clone();
                    let agent = id.to_owned();
                    let (status, reason) = self
                        .database
                        .transact(move |ctx| {
                            let snapshot = system.snapshot(ctx, &agent)?;
                            for module in &system.modules {
                                if let Some(status) =
                                    module.settlement_status(ctx, &snapshot.scope(&agent))?
                                {
                                    return Ok(status);
                                }
                            }
                            let outcome =
                                read(ctx, &agent, &format!("kv.{agent}.run.core.outcome"))?;
                            Ok(match outcome.as_ref().and_then(Value::as_str) {
                                Some("error") => ("failed".into(), "error".into()),
                                Some("aborted") => ("aborted".into(), "abort".into()),
                                _ => ("completed".into(), "completed".into()),
                            })
                        })
                        .await?;
                    self.settle(id, &status, &reason).await?;
                    return Ok(());
                }
                "inference" | "tools" => self.infer(id, snapshot).await?,
                "compaction" => {
                    anyhow::bail!("Durable compaction execution has not been migrated yet.")
                }
                _ => unreachable!("validated owed stage"),
            }
            restored = false;
        }
    }
    async fn accept_queue(self: &Arc<Self>, id: &str, can_accept_send: bool) -> Result<bool> {
        let system = self.clone();
        let agent = id.to_owned();
        let (accepted, permission) = self.database.transact(move |ctx| {
            let prefix = if ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM happy_agent_values WHERE owner_id=?1 AND key GLOB 'steering.*')", [&agent], |row| row.get::<_, bool>(0))? { "steering." } else if can_accept_send { "send." } else { return Ok((false, None)); };
            let mut statement = ctx.database().prepare("SELECT key,value_json FROM happy_agent_values WHERE owner_id=?1 AND substr(key,1,length(?2))=?2 ORDER BY key LIMIT 513")?;
            let rows = statement.query_map(params![agent, prefix], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            anyhow::ensure!(rows.len() <= 512, "The pending input queue exceeds its restoration bound.");
            if rows.is_empty() { return Ok((false, None)); }
            let mut batch = Vec::new();
            for (key, encoded) in rows {
                let input: Value = serde_json::from_str(&encoded)?;
                anyhow::ensure!(system.schemas.valid("queuedInput", &input)?, "A durable queued input is invalid.");
                let requested = input["message"]["content"].as_array().into_iter().flatten().any(|block| block["type"] == "tool_call_request");
                batch.push((key, input)); if requested { break; }
            }
            let mut settings = read(ctx, &agent, "settings")?.unwrap_or(json!({"profile":null,"permissionMode":"auto"}));
            let previous = settings.clone();
            for (_, input) in &batch {
                for field in ["provider", "model", "effort", "permissionMode"] { if let Some(value) = input["options"].get(field) { settings[field] = value.clone(); } }
                if let Some(tier) = input["options"].get("serviceTier") { if tier.is_null() { settings.as_object_mut().context("Agent settings are invalid.")?.remove("serviceTier"); } else { settings["serviceTier"] = tier.clone(); } }
                settings["profile"] = Value::Null;
            }
            let configuration = system.configuration(ctx, &agent)?.context("The accepting agent is missing.")?;
            let scope = AgentScope { id: &agent, configuration: &configuration, settings: &settings };
            system.adopt_model(ctx, &scope, &previous)?;
            let mut accepted = Vec::new();
            for (key, input) in batch {
                let id = input["id"].as_str().context("The accepted message identifier is missing.")?;
                let metadata = input.get("metadata").cloned().unwrap_or(json!({}));
                let content = input["message"]["content"].as_array().context("The queued input content is invalid.")?;
                let mut private = input["message"].clone();
                private["content"] = json!(content.iter().filter(|block| block["type"] != "tool_call_request").cloned().collect::<Vec<_>>());
                system.append_record(ctx, &scope, &json!({"type":"user","id":id,"message":private,"metadata":metadata}))?;
                delete(ctx, &agent, &key)?;
                let requested_call = if let Some(request) = content.iter().find(|block| block["type"] == "tool_call_request") {
                    let call = cuid2::create_id(); let arguments = request.get("arguments").cloned().unwrap_or(json!({}));
                    system.append_record(ctx, &scope, &json!({"type":"block","id":call,"block":{"type":"tool_call","callId":call,"name":request["name"],"arguments":arguments.to_string()}}))?;
                    Some(json!({"id":call,"name":request["name"],"arguments":arguments}))
                } else { None };
                accepted.push(AcceptedInput { input, requested_call });
            }
            write(ctx, &agent, "settings", &settings)?;
            let mut owed = system.owed(ctx, &agent)?.context("Acceptance has no owed loop identity.")?;
            owed["stage"] = json!("inference"); owed["turnId"] = json!(cuid2::create_id());
            for field in ["inferenceId", "settlementId"] { owed.as_object_mut().context("The owed work is invalid.")?.remove(field); }
            write(ctx, &agent, "owed", &owed)?;
            for module in &system.modules { module.accepted(ctx, &scope, &accepted, prefix == "steering.")?; }
            let previous = previous["permissionMode"].as_str().unwrap_or("auto"); let next = settings["permissionMode"].as_str().unwrap_or("auto");
            Ok((true, (previous != next).then(|| (previous.to_owned(), next.to_owned()))))
        }).await?;
        if let Some((previous, next)) = permission {
            for module in &self.modules {
                module.permission_changed(id, &previous, &next).await;
            }
        }
        Ok(accepted)
    }
    fn adopt_model(
        &self,
        ctx: &DatabaseContext<'_>,
        scope: &AgentScope<'_>,
        previous: &Value,
    ) -> Result<()> {
        if previous["provider"] == scope.settings["provider"]
            && previous["model"] == scope.settings["model"]
        {
            return Ok(());
        }
        let compatible = self
            .modules
            .iter()
            .find_map(|module| module.compatible(previous, scope.settings))
            .transpose()?
            .unwrap_or(false);
        if compatible {
            return Ok(());
        }
        let mut notice = None;
        for module in &self.modules {
            if notice.is_none() {
                notice = module.model_changed(ctx, scope, previous)?;
            }
        }
        ctx.database().execute("DELETE FROM happy_agent_values WHERE owner_id=?1 AND key IN(SELECT 'message.'||json_extract(record_json,'$.id') FROM happy_agent_records WHERE owner_id=?1 AND json_extract(record_json,'$.type')='user')", [scope.id])?;
        ctx.database().execute(
            "DELETE FROM happy_agent_records WHERE owner_id=?1",
            [scope.id],
        )?;
        delete_scope(ctx, scope.id, &format!("kv.{}.history.", scope.id))?;
        for module in &self.modules {
            module.history_erased(ctx, scope)?;
        }
        if let Some(message) = notice {
            self.append_record(ctx, scope, &json!({"type":"system","message":message}))?;
        }
        Ok(())
    }
    fn append_record(
        &self,
        ctx: &DatabaseContext<'_>,
        scope: &AgentScope<'_>,
        record: &Value,
    ) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid("privateRecord", record)?,
            "The private agent record is invalid."
        );
        ctx.database().execute("INSERT INTO happy_agent_records(owner_id,position,record_json) SELECT ?1,coalesce(max(position),-1)+1,?2 FROM happy_agent_records WHERE owner_id=?1", params![scope.id, record.to_string()])?;
        for module in &self.modules {
            module.record(ctx, scope, record)?;
        }
        Ok(())
    }
    async fn dispatch(self: &Arc<Self>, id: &str, snapshot: &Snapshot) -> Result<()> {
        let system = self.clone();
        let id = id.to_owned();
        let settings = snapshot.settings.clone();
        let configuration = snapshot.configuration.clone();
        let calls = snapshot.open_calls.clone();
        let mut owed = snapshot
            .owed
            .clone()
            .context("Dispatch has no owed loop identity.")?;
        self.database
            .transact(move |ctx| {
                let scope = AgentScope {
                    id: &id,
                    settings: &settings,
                    configuration: &configuration,
                };
                for module in &system.modules {
                    module.before_tools(ctx, &scope)?;
                }
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
                write(ctx, &id, "owed", &owed)
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
            if self.shutdown.is_cancelled() {
                return Ok(());
            }
            let message = if let Some(committed) = call.get("committed") {
                serde_json::from_value(committed.clone())?
            } else if restored
                && !self
                    .modules
                    .iter()
                    .find_map(|module| module.reloadable(call))
                    .unwrap_or(false)
            {
                tool_error(
                    call,
                    "The tool call was interrupted by a restart and was not retried.",
                )
            } else {
                let mut result = None;
                for module in &self.modules {
                    if let Some(message) = module
                        .execute_tool(&snapshot.scope(id), call, self.shutdown.child_token())
                        .await
                    {
                        result = Some(message);
                        break;
                    }
                }
                result.unwrap_or_else(|| tool_error(call, "The requested tool is unavailable."))
            };
            if self.shutdown.is_cancelled() {
                return Ok(());
            }
            let system = self.clone();
            let agent = id.to_owned();
            let key = key.clone();
            let call = call.clone();
            let native = snapshot
                .native_ids
                .get(call["id"].as_str().unwrap_or(""))
                .cloned()
                .context("The tool call has no provider correlation identity.")?;
            let settings = snapshot.settings.clone();
            let configuration = snapshot.configuration.clone();
            self.database.transact(move |ctx| {
                let scope = AgentScope { id: &agent, settings: &settings, configuration: &configuration };
                for module in &system.modules { module.before_tools(ctx, &scope)?; }
                let id = call["id"].as_str().context("The tool identity is missing.")?;
                let claim = format!("toolResult.{id}");
                let result = read(ctx, &agent, &claim)?.unwrap_or(serde_json::to_value(&message)?);
                write(ctx, &agent, &claim, &result)?;
                let mut committed = call.clone(); committed["committed"] = result.clone(); write(ctx, &agent, &key, &committed)?;
                let result: Message = serde_json::from_value(result)?;
                let mut private = serde_json::to_value(&result)?; private["callId"] = json!(native);
                system.append_record(ctx, &scope, &json!({"type":"tool","id":id,"message":private}))?;
                for module in &system.modules { module.tool_result(ctx, &scope, &call, &result)?; }
                delete(ctx, &agent, &key)?; delete(ctx, &agent, &claim)?;
                delete_scope(ctx, &agent, &format!("kv.{agent}.call.{id}."))?;
                delete_scope(ctx, &agent, &format!("kv.{agent}.run.call.{id}."))?;
                let remaining: i64 = ctx.database().query_row("SELECT count(*) FROM happy_agent_values WHERE owner_id=?1 AND key GLOB 'tool.*'", [&agent], |row| row.get(0))?;
                if remaining == 0 { let mut owed = system.owed(ctx, &agent)?.context("The tools lost their owed loop identity.")?; owed["stage"] = json!("inference"); owed.as_object_mut().context("The owed work is invalid.")?.remove("inferenceId"); write(ctx, &agent, "owed", &owed)?; }
                Ok(())
            }).await?;
        }
        Ok(())
    }
    async fn infer(self: &Arc<Self>, id: &str, mut snapshot: Snapshot) -> Result<()> {
        let inference = cuid2::create_id();
        let began = now();
        let system = self.clone();
        let agent = id.to_owned();
        let identity = inference.clone();
        let settings = snapshot.settings.clone();
        let configuration = snapshot.configuration.clone();
        self.database
            .transact(move |ctx| {
                let scope = AgentScope {
                    id: &agent,
                    settings: &settings,
                    configuration: &configuration,
                };
                for module in &system.modules {
                    module.before_inference(ctx, &scope, &identity)?;
                }
                let mut owed = system
                    .owed(ctx, &agent)?
                    .context("Inference has no owed loop identity.")?;
                owed["stage"] = json!("inference");
                owed["inferenceId"] = json!(identity);
                write(ctx, &agent, "owed", &owed)
            })
            .await?;
        let mut instructions = Vec::new();
        let mut tools = Vec::new();
        for module in &self.modules {
            let instruction = module.instructions(&snapshot.scope(id)).await?;
            if !instruction.is_empty() {
                instructions.push(instruction);
            }
            tools.extend(module.tools(&snapshot.scope(id)));
        }
        snapshot.context.instructions = instructions.join("\n\n");
        let mut selected = None;
        for module in &self.modules {
            if let Some(session) = module.session(&snapshot.scope(id), tools.clone()).await {
                selected = Some(session);
                break;
            }
        }
        let mut session = match selected.context("The agent has no inference provider.")? {
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
        let cancel = self.shutdown.child_token();
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
                let system = self.clone();
                let agent = id.to_owned();
                let identity = inference.clone();
                let settings = snapshot.settings.clone();
                let configuration = snapshot.configuration.clone();
                self.database
                    .transact(move |ctx| {
                        let scope = AgentScope {
                            id: &agent,
                            settings: &settings,
                            configuration: &configuration,
                        };
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
                            system.append_record(ctx, &scope, &record)?;
                            for module in &system.modules {
                                module.block(ctx, &scope, &identity, &block, base_id.as_deref())?;
                            }
                        }
                        Ok(())
                    })
                    .await?;
            }
        }
        task.await?;
        if self.shutdown.is_cancelled() {
            return Ok(());
        }
        let outcome = outcome.context("The provider ended without an inference outcome.")?;
        let system = self.clone();
        let agent = id.to_owned();
        let identity = inference;
        let settings = snapshot.settings;
        let configuration = snapshot.configuration;
        let ended = now().max(began);
        self.database
            .transact(move |ctx| {
                let scope = AgentScope {
                    id: &agent,
                    settings: &settings,
                    configuration: &configuration,
                };
                write(
                    ctx,
                    &agent,
                    &format!("kv.{agent}.run.core.outcome"),
                    &json!(match &outcome {
                        Outcome::Error { .. } => "error",
                        Outcome::Cancelled => "aborted",
                        Outcome::Length { .. } => "length",
                        _ => "stop",
                    }),
                )?;
                let inference = Inference {
                    id: &identity,
                    started_at: began,
                    finished_at: ended,
                    outcome: &outcome,
                };
                for module in &system.modules {
                    module.after_inference(ctx, &scope, &inference)?;
                }
                for module in &system.modules {
                    module.inference_event(
                        ctx,
                        &scope,
                        &inference,
                        &Event::Done {
                            outcome: outcome.clone(),
                        },
                    )?;
                }
                let snapshot = system.snapshot(ctx, &agent)?;
                let mut owed = system
                    .owed(ctx, &agent)?
                    .context("Inference lost its owed loop identity.")?;
                if !snapshot.open_calls.is_empty() {
                    owed["stage"] = json!("inference");
                } else {
                    owed["stage"] = json!("settlement");
                    owed["settlementId"] = json!(cuid2::create_id());
                }
                write(ctx, &agent, "owed", &owed)
            })
            .await
    }
    async fn settle(self: &Arc<Self>, id: &str, status: &str, reason: &str) -> Result<()> {
        let system = self.clone();
        let id = id.to_owned();
        let status = status.to_owned();
        let reason = reason.to_owned();
        self.database
            .transact(move |ctx| {
                let snapshot = system.snapshot(ctx, &id)?;
                for module in &system.modules {
                    module.settled(ctx, &snapshot.scope(&id), &status, &reason)?;
                }
                delete(ctx, &id, "owed")?;
                delete_scope(ctx, &id, &format!("kv.{id}.run."))
            })
            .await
    }
}

fn tool_error(call: &Value, output: &str) -> Message {
    Message::Tool {
        call_id: call["id"].as_str().unwrap_or("").into(),
        content: vec![Block::text(output)],
        is_error: true,
        vendor: None,
    }
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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
impl DatabaseContext<'_> {
    pub fn value(&self, owner: &str, key: &str) -> Result<Option<Value>> {
        read(self, owner, key)
    }
    pub fn put_value(&self, owner: &str, key: &str, value: &Value) -> Result<()> {
        write(self, owner, key, value)
    }
}
fn read(ctx: &DatabaseContext<'_>, owner: &str, key: &str) -> Result<Option<Value>> {
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
fn write(ctx: &DatabaseContext<'_>, owner: &str, key: &str, value: &Value) -> Result<()> {
    ctx.database().execute("INSERT INTO happy_agent_values(owner_id,key,value_json) VALUES(?1,?2,?3) ON CONFLICT(owner_id,key) DO UPDATE SET value_json=excluded.value_json", params![owner, key, value.to_string()])?;
    Ok(())
}
fn delete(ctx: &DatabaseContext<'_>, owner: &str, key: &str) -> Result<()> {
    ctx.database().execute(
        "DELETE FROM happy_agent_values WHERE owner_id=?1 AND key=?2",
        params![owner, key],
    )?;
    Ok(())
}
fn delete_scope(ctx: &DatabaseContext<'_>, owner: &str, prefix: &str) -> Result<()> {
    ctx.database().execute(
        "DELETE FROM happy_agent_values WHERE owner_id=?1 AND substr(key,1,length(?2))=?2",
        params![owner, prefix],
    )?;
    Ok(())
}
