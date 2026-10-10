mod capture;
mod entries;
mod evidence;
mod persistence;
mod prompt;
mod reviewer;
mod routes;
mod transcript;
mod verdict;

use crate::product::{config::ConfigModule, durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration}, lifecycle::LifecycleModule, runtime::{Context, RuntimeModule}, schemas::Schemas, system_prompt::SystemPromptModule, tools::ToolsModule};
use anyhow::{Context as _, Result};
use futures_util::future::BoxFuture;
use happy_agent_base::{AcceptedInput, AgentModule, AgentScope, AgentSystem, Inference, SqliteDatabase};
use happy_providers::{Block, Event, Message, Outcome};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::{Arc, Mutex}};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

pub struct AutoModule {
    config: Arc<ConfigModule>,
    system_prompt: Arc<SystemPromptModule>,
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    evidence: Arc<evidence::EvidenceStore>,
    private_database: Arc<SqliteDatabase>,
    private_system: Arc<AgentSystem>,
    private_runtime: Arc<reviewer::ReviewerRuntimeModule>,
    schemas: Schemas,
    routes: Mutex<BTreeMap<String, Value>>,
    completed: Arc<Notify>,
}
impl AutoModule {
    pub fn new(config: Arc<ConfigModule>, runtime: Arc<RuntimeModule>, durable: Arc<DurableFunctionsModule>, tools: Arc<ToolsModule>, lifecycle: Arc<LifecycleModule>, system_prompt: Arc<SystemPromptModule>) -> Result<Arc<Self>> {
        let private_database = Arc::new(SqliteDatabase::new());
        let private_runtime = Arc::new(reviewer::ReviewerRuntimeModule::new(config.clone(), lifecycle));
        let private_system = Arc::new(AgentSystem::new(private_database.clone(), vec![private_runtime.clone(), tools.reviewer()?])?);
        let module = Arc::new(Self { config, system_prompt, evidence: Arc::new(evidence::EvidenceStore::new(runtime.clone())?), runtime, durable: durable.clone(), private_database, private_system, private_runtime, schemas: Schemas::new()?, routes: Mutex::new(BTreeMap::new()), completed: Arc::new(Notify::new()) });
        durable.register(Registration { name: "auto.review".into(), arguments_schema: "nativeAutoArguments", result_schema: "nativeAutoOutcome", function: module.clone() })?;
        Ok(module)
    }
    pub async fn load(&self) -> Result<()> {
        self.evidence.load().await?;
        // Owed reviewer inference is never replayed on startup. A restarted
        // durable review returns unproven; a later call rebuilds its context.
        self.private_database.load(self.config.auto_database_location()).await
    }
    pub async fn review(self: &Arc<Self>, request: Value, configuration: Value, settings: &Value, cancel: CancellationToken) -> Result<Value> {
        anyhow::ensure!(!cancel.is_cancelled(), "Permission review was stopped.");
        anyhow::ensure!(self.schemas.valid("permissionRequest", &request)? && request["arguments"].to_string().len() <= 65_536, "The automatic permission review request is invalid.");
        let route = self.config.active_model_route(settings)?;
        let agent = request["agentId"].as_str().context("The reviewed agent identity is missing.")?.to_owned();
        let call = request["callId"].as_str().context("The reviewed tool identity is missing.")?.to_owned();
        let operation = format!("auto.review.{agent}.{call}");
        let input = json!({"function":"auto.review","arguments":{"request":request,"configuration":configuration,"route":route},"operationId":operation,"lockKeys":[format!("auto.review.{agent}")]});
        let module = self.clone();
        self.runtime.transact(move |ctx| module.durable.invoke(ctx, &input)).await?;
        loop {
            let notified = self.completed.notified();
            tokio::pin!(notified); notified.as_mut().enable();
            let module = self.clone(); let agent = agent.clone(); let call = call.clone();
            let result = self.runtime.transact(move |ctx| persistence::result(ctx, &module.schemas, &agent, &call)).await?;
            if let Some(result) = result {
                anyhow::ensure!(!cancel.is_cancelled(), "Permission review was stopped.");
                return Ok(result);
            }
            tokio::select! { _ = notified => {}, _ = cancel.cancelled() => {
                let module = self.clone();
                self.runtime.transact(move |ctx| module.durable.cancel(ctx, &operation)).await?;
                anyhow::bail!("Permission review was stopped.");
            } }
        }
    }
    pub fn record_human_answer(&self, ctx: &Context<'_>, agent: &str, call: &str, answer: &str) -> Result<()> {
        // The authenticated API checks the exact pending owner and atomically
        // records only the submitted human answer, never model question text.
        let result = self.evidence.answer(ctx, agent, call, &json!({"role":"user","blocks":[{"type":"text","text":answer}]}));
        if result.is_err() { self.evidence.poison(ctx, agent); }
        result
    }
    fn append(&self, ctx: &Context<'_>, agent: &str, evidence: Result<Option<Value>>) {
        let result = evidence.and_then(|evidence| evidence.map_or(Ok(()), |evidence| self.evidence.append(ctx, agent, &evidence)));
        if let Err(error) = result { self.evidence.poison(ctx, agent); eprintln!("Automatic permission evidence is incomplete: {error:#}"); }
    }
    async fn run_review(self: &Arc<Self>, arguments: &Value, cancel: &CancellationToken) -> Result<Value> {
        let request = &arguments["request"];
        let active = &arguments["route"];
        let provider = active["providerId"].as_str().context("The active review account is missing.")?;
        let models = self.config.reviewer_models(provider)?;
        let routes = routes::select(&models, active)?;
        let mut unavailable = Vec::new();
        for route in routes {
            match self.run_on_route(arguments, &route, cancel).await {
                Ok(decision) => return Ok(decision),
                Err(error) if error.downcast_ref::<RouteUnavailable>().is_some() && !cancel.is_cancelled() => unavailable.push(bounded(&error.to_string())),
                Err(error) => return Err(error),
            }
        }
        anyhow::bail!("No automatic permission reviewer route was available. {}", unavailable.join("; "))
    }
    async fn run_on_route(self: &Arc<Self>, arguments: &Value, route: &Value, cancel: &CancellationToken) -> Result<Value> {
        anyhow::ensure!(!cancel.is_cancelled(), "Permission review was stopped.");
        let request = &arguments["request"];
        let agent = request["agentId"].as_str().unwrap().to_owned();
        let reviewer = routes::reviewer_id(&agent);
        let module = self.clone(); let identity = agent.clone();
        let (state, entries, whole) = self.runtime.transact(move |ctx| {
            let (state, entries) = module.evidence.entries(ctx, &identity)?;
            let (_, transcript) = module.evidence.review_transcript(ctx, &identity)?;
            Ok((state, entries, transcript))
        }).await?;
        anyhow::ensure!(whole["userEvidenceOmitted"] != true, "The automatic permission review is missing required human evidence.");
        let module = self.clone(); let identity = reviewer.clone();
        let cursor = self.private_database.transact(move |ctx| persistence::cursor(ctx, &module.schemas, &identity)).await?;
        let previous_route = self.routes.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&agent).cloned();
        let first = previous_route.as_ref() != Some(route) || cursor.as_ref().is_none_or(|cursor| cursor["evidenceGeneration"] != state["generation"] || cursor["lastReviewNormal"] != true || cursor["reviewedPosition"].as_u64().is_none_or(|position| position > entries.len() as u64));
        let position = if first { 0 } else { cursor.as_ref().unwrap()["reviewedPosition"].as_u64().unwrap() as usize };
        let messages: Vec<_> = entries[position..].iter().map(|entry| entry["entry"].clone()).collect();
        let delta = if first { whole.clone() } else { transcript::create(&messages)? };
        let (security, _) = self.config.review_documents(&arguments["configuration"]).await?;
        let settings = json!({"permissionMode":"auto"});
        let scope = AgentScope { id: &agent, configuration: &arguments["configuration"], settings: &settings };
        let instructions = self.system_prompt.read_agents_md_instructions(&scope, cancel).await?.unwrap_or_default();
        let policy = prompt::policy(Some(&security));
        let instructions = if instructions.trim().is_empty() { policy } else { format!("{policy}\n\n{}", instructions.trim()) };
        if first { self.private_system.abort(&reviewer).await?; self.private_system.retire_session(&reviewer).await; }
        let configuration = self.reviewer_configuration(&reviewer)?;
        let system = self.private_system.clone(); let module = self.clone(); let identity = reviewer.clone(); let generation = state["generation"].clone();
        self.private_database.transact(move |ctx| {
            if first { system.remove(ctx, &identity)?; }
            system.create(ctx, &identity, &configuration)?;
            persistence::write_cursor(ctx, &module.schemas, &identity, &json!({"evidenceGeneration":generation,"reviewedPosition":0,"reportedOwnEntryCount":0,"lastReviewNormal":false}))
        }).await?;
        self.private_runtime.begin(&reviewer, instructions)?;
        let proposed = json!({"description":request["action"],"tool":qualified(&request["tool"]),"arguments":request["arguments"]}).to_string();
        let prompt = prompt::create(first, delta["text"].as_str().unwrap(), &proposed)?;
        let input = json!({"id":cuid2::create_id(),"message":{"role":"user","content":[{"type":"text","text":prompt}]},"metadata":{"messageOrigin":"agent"},"options":{"permissionMode":"read_only","provider":route["providerId"],"model":route["modelId"],"effort":route["effort"]}});
        let system = self.private_system.clone(); let identity = reviewer.clone();
        let sent = if cancel.is_cancelled() { Err(anyhow::anyhow!("Permission review was stopped.")) } else { self.private_database.transact(move |ctx| system.enqueue(ctx, &identity, &input, false)).await };
        let waited = match sent { Ok(()) => self.private_system.wait_for_idle(&reviewer, cancel).await, Err(error) => Err(error) };
        if waited.is_err() || cancel.is_cancelled() {
            self.discard(&agent, &reviewer, &state["generation"]).await?;
            let _ = self.private_runtime.take(&reviewer);
            anyhow::ensure!(!cancel.is_cancelled(), "Permission review was stopped.");
            return Err(waited.unwrap_err());
        }
        let capture = self.private_runtime.take(&reviewer)?;
        let decision = capture.decision(whole["userEvidenceOmitted"] == true);
        let mut decision = match decision {
            Ok(decision) => decision,
            Err(error) => {
                self.discard(&agent, &reviewer, &state["generation"]).await?;
                if capture.route_unavailable() { return Err(RouteUnavailable(error.to_string()).into()); }
                return Err(error);
            }
        };
        if let Some(transcript) = capture.transcript(route["modelId"].as_str().unwrap(), route["providerId"].as_str().unwrap())? { decision["transcript"] = transcript; }
        let module = self.clone(); let identity = reviewer.clone(); let generation = state["generation"].clone(); let count = entries.len(); let own_count = decision["transcript"]["entries"].as_array().map_or(0, Vec::len);
        self.private_database.transact(move |ctx| persistence::write_cursor(ctx, &module.schemas, &identity, &json!({"evidenceGeneration":generation,"reviewedPosition":count,"reportedOwnEntryCount":own_count,"lastReviewNormal":true}))).await?;
        let mut routes = self.routes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if routes.len() == 10_000 && !routes.contains_key(&agent) { routes.pop_first(); }
        routes.insert(agent, route.clone());
        anyhow::ensure!(!cancel.is_cancelled(), "Permission review was stopped.");
        Ok(decision)
    }
    fn reviewer_configuration(&self, reviewer: &str) -> Result<Value> {
        let mut configuration = self.config.agent_configuration(self.config.paths.public.to_str().context("The public working directory is not valid UTF-8.")?, reviewer, reviewer, Some("Automatic permission reviewer"))?;
        configuration["modules"] = json!({"autoReviewCompute":{},"autoReviewRuntime":{}});
        configuration["metadata"] = json!({"title":"Automatic permission reviewer"});
        Ok(configuration)
    }
    async fn discard(self: &Arc<Self>, agent: &str, reviewer: &str, generation: &Value) -> Result<()> {
        self.routes.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(agent);
        self.private_system.abort(reviewer).await?; self.private_system.retire_session(reviewer).await;
        let module = self.clone(); let reviewer = reviewer.to_owned(); let generation = generation.clone();
        self.private_database.transact(move |ctx| { module.private_system.remove(ctx, &reviewer)?; persistence::write_cursor(ctx, &module.schemas, &reviewer, &json!({"evidenceGeneration":generation,"reviewedPosition":0,"reportedOwnEntryCount":0,"lastReviewNormal":false})) }).await
    }
}
#[derive(Debug)]
struct RouteUnavailable(String);
impl std::fmt::Display for RouteUnavailable { fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { formatter.write_str(&self.0) } }
impl std::error::Error for RouteUnavailable {}
fn qualified(tool: &Value) -> String { tool["namespace"].as_str().map_or_else(|| tool["name"].as_str().unwrap_or("tool").into(), |namespace| format!("{namespace}/{}", tool["name"].as_str().unwrap_or("tool"))) }
fn bounded(text: &str) -> String { String::from_utf16_lossy(&text.encode_utf16().take(1024).collect::<Vec<_>>()) }
fn unproven(reason: &str) -> Value { json!({"outcome":"unproven","kind":"unavailable","reason":bounded(reason)}) }

impl DurableFunction for AutoModule {
    fn execute(self: Arc<Self>, call: Value, kv: CallKv, cancel: CancellationToken) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            let first = kv.transact(|ctx, kv| { if kv.read(ctx, "inferenceClaimed")?.is_some() { return Ok(false); } kv.write(ctx, "inferenceClaimed", &json!(true))?; Ok(true) }).await?;
            if !first { return Ok(unproven("The private review was interrupted by a restart; its provider request was not replayed.")); }
            match self.run_review(&call["arguments"], &cancel).await { Ok(decision) => Ok(decision), Err(error) => Ok(unproven(&format!("The reviewer failed: {error:#}"))) }
        })
    }
    fn success(&self, ctx: &Context<'_>, call: &Value, result: &Value) -> Result<()> {
        let request = &call["arguments"]["request"];
        persistence::save_result(ctx, &self.schemas, request["agentId"].as_str().unwrap(), request["callId"].as_str().unwrap(), call["id"].as_str().unwrap(), result)?;
        let completed = self.completed.clone(); ctx.after_commit(move || completed.notify_waiters())
    }
}

#[async_trait::async_trait]
impl AgentModule for AutoModule {
    fn name(&self) -> &'static str { "auto" }
    fn created(&self, ctx: &Context<'_>, scope: &AgentScope<'_>) -> Result<()> { self.evidence.recreate(ctx, scope.id) }
    fn accepted(&self, ctx: &Context<'_>, scope: &AgentScope<'_>, inputs: &[AcceptedInput], _steering: bool) -> Result<()> {
        for accepted in inputs { if accepted.input["message"]["role"] == "user" { self.append(ctx, scope.id, entries::user(&accepted.input["message"], accepted.input.get("metadata"))); } }
        Ok(())
    }
    fn block(&self, ctx: &Context<'_>, scope: &AgentScope<'_>, _inference: &str, block: &Block, _base_id: Option<&str>) -> Result<()> {
        match block { Block::Text { text } => self.append(ctx, scope.id, Ok(Some(entries::text(text)))), Block::ToolCall { name, namespace, arguments, .. } => self.append(ctx, scope.id, Ok(Some(entries::call(&namespace.as_ref().map_or_else(|| name.clone(), |namespace| format!("{namespace}/{name}")), arguments)))), _ => {} }
        Ok(())
    }
    fn inference_event(&self, ctx: &Context<'_>, scope: &AgentScope<'_>, _inference: &Inference<'_>, event: &Event) -> Result<()> {
        match event { Event::Retrying { reason, .. } => self.append(ctx, scope.id, Ok(Some(entries::error(reason, true)))), Event::Done { outcome: Outcome::Error { error } } => self.append(ctx, scope.id, Ok(Some(entries::error(&error.to_string(), false)))), _ => {} }
        Ok(())
    }
    fn tool_result(&self, ctx: &Context<'_>, scope: &AgentScope<'_>, call: &Value, result: &Message) -> Result<()> {
        let evidence = (|| -> Result<Option<Value>> {
            let answer = self.evidence.consume_answer(ctx, scope.id, call["id"].as_str().unwrap())?;
            if let Message::Tool { content, is_error, .. } = result {
                let mut options = json!({"toolName":qualified(&call["call"]),"content":content,"isError":is_error});
                if let Some(answer) = answer { options["trustedUserAnswer"] = json!(answer["blocks"].as_array().unwrap().iter().filter(|block| block["type"] == "text").cloned().collect::<Vec<_>>()); }
                Ok(Some(entries::result(&options)?))
            } else { Ok(None) }
        })();
        self.append(ctx, scope.id, evidence);
        persistence::remove_result(ctx, scope.id, call["id"].as_str().unwrap())
    }
    async fn close(&self) { self.private_runtime.stop(); self.private_system.close().await; if let Err(error) = self.private_database.close().await { eprintln!("The private reviewer database could not close: {error:#}"); } }
}

#[cfg(test)]
fn goldens() -> serde_json::Value {
    serde_json::from_str(include_str!("../../tests/auto_goldens.json")).unwrap()
}

#[cfg(test)]
fn runtime_goldens() -> serde_json::Value {
    serde_json::from_str(include_str!("../../tests/auto_runtime_goldens.json")).unwrap()
}
