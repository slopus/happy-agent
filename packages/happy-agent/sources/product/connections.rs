mod persistence;
mod proxy;
pub use proxy::ProxyBody;
use crate::product::{agent_runtime::AgentRuntimeModule, bots::BotsModule, cloud::CloudModule, config::ConfigModule, durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration}, events::EventsModule, runtime::{Context, RuntimeModule}, schemas::Schemas, tailcat::TailcatModule};
use anyhow::{Context as _, Result};
use futures_util::future::BoxFuture;
use happy_agent_base::{AgentModule, AgentScope, ToolPermissionPolicy};
use happy_providers::{Block, Message, ToolDefinition};
use hyper::{Request, Response};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::{Arc, Weak, atomic::{AtomicBool, Ordering}}};
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub struct RemoteConnectionError { pub status: u16, pub code: &'static str, pub message: String, pub current: Option<Value> }
impl RemoteConnectionError { pub fn new(status: u16, code: &'static str, message: &str) -> Self { Self { status, code, message: message.into(), current: None } } }
impl std::fmt::Display for RemoteConnectionError { fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { formatter.write_str(&self.message) } }
impl std::error::Error for RemoteConnectionError {}
struct Record { configuration: Value, pool: Arc<proxy::RemoteProxyConnection> }
pub struct ConnectionsModule {
    config: Arc<ConfigModule>, bots: Arc<BotsModule>, cloud: Arc<CloudModule>, tailcat: Arc<TailcatModule>, durable: Arc<DurableFunctionsModule>, runtime: Arc<RuntimeModule>, events: Arc<EventsModule>,
    schemas: Schemas, tools: Vec<ToolDefinition>, pools: tokio::sync::Mutex<BTreeMap<String, Record>>, closed: AtomicBool, weak: Weak<Self>,
}
impl ConnectionsModule {
    #[expect(clippy::too_many_arguments)]
    pub fn new(config: Arc<ConfigModule>, bots: Arc<BotsModule>, cloud: Arc<CloudModule>, tailcat: Arc<TailcatModule>, durable: Arc<DurableFunctionsModule>, runtime: Arc<RuntimeModule>, events: Arc<EventsModule>, agents: Arc<AgentRuntimeModule>) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?; let tools = serde_json::from_str(include_str!("connections/tool_definitions.json"))?;
        let module = Arc::new_cyclic(|weak| Self { config, bots, cloud, tailcat, durable: durable.clone(), runtime, events, schemas, tools, pools: tokio::sync::Mutex::new(BTreeMap::new()), closed: AtomicBool::new(false), weak: weak.clone() });
        durable.register(Registration { name: "connections-reconcile".into(), arguments_schema: "ownerReconcileArgs", result_schema: "ownerNull", function: Arc::new(Reconcile(Arc::downgrade(&module))) })?;
        agents.install(module.clone())?; Ok(module)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime.migrate_native("connections", persistence::MIGRATIONS).await?;
        let module = self.clone(); self.runtime.transact(move |ctx| { module.snapshot(ctx)?; module.durable.invoke(ctx, &json!({"function":"connections-reconcile","arguments":{},"lockKeys":["connections"]}))?; Ok(()) }).await
    }
    pub fn snapshot(self: &Arc<Self>, ctx: &Context<'_>) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let previous = persistence::query(ctx, &self.schemas)?;
        let connections = self.roster(previous.as_ref().and_then(|previous| previous["connections"].as_array()).map_or(&[][..], Vec::as_slice))?;
        if let Some(previous) = &previous { if previous["connections"] == connections { return Ok(previous.clone()); } }
        let snapshot = json!({"connections":connections,"version":persistence::version(previous.as_ref().and_then(|previous| previous["version"].as_str()))?});
        self.save(ctx, &snapshot, None)?; Ok(snapshot)
    }
    fn roster(&self, previous: &[Value]) -> Result<Value> {
        let configuration = self.config.remote_connections()?;
        let keys = previous.iter().map(|connection| (connection["id"].as_str().unwrap_or(""), connection["orderKey"].as_str().unwrap_or(""))).collect::<BTreeMap<_, _>>();
        let mut last = previous.iter().filter(|connection| configuration.get(connection["id"].as_str().unwrap_or("")).is_some_and(|entry| entry["enabled"] != false)).next_back().and_then(|connection| connection["orderKey"].as_str()).map(str::to_owned);
        let mut roster = Vec::new();
        for (id, entry) in configuration { if entry["enabled"] == false { continue; } let key = match keys.get(id.as_str()) { Some(key) => (*key).to_owned(), None => { let key = persistence::between(last.as_deref(), None)?; last = Some(key.clone()); key } }; let mut connection = json!({"id":id,"name":entry["name"],"orderKey":key,"authentication":if entry.get("token").is_some(){"bearer"}else{"workos"}}); if let Some(organization) = entry.get("workos_organization_id") { connection["organizationId"] = organization.clone(); } roster.push(connection); }
        roster.sort_by(|left, right| left["orderKey"].as_str().cmp(&right["orderKey"].as_str()).then_with(|| left["id"].as_str().cmp(&right["id"].as_str()))); Ok(json!(roster))
    }
    fn save(&self, ctx: &Context<'_>, snapshot: &Value, mutation: Option<&Value>) -> Result<()> {
        persistence::save(ctx, &self.schemas, snapshot)?;
        let events = self.events.clone(); let mut snapshot = snapshot.clone(); if let Some(mutation) = mutation { snapshot["mutationId"] = mutation.clone(); }
        ctx.after_commit(move || { events.with_journal(|journal| { journal.append("connections.updated", snapshot, None); }); })
    }
    pub fn reorder(&self, ctx: &Context<'_>, id: &str, request: &Value, expected: &str) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        if !self.schemas.valid("ownerConnectionId", &json!(id))? || !self.schemas.valid("ownerConnectionReorder", request)? || !self.schemas.valid("ownerResourceVersion", &json!(expected))? { return Err(RemoteConnectionError::new(400,"invalid_request","Provide a valid connection, destination, and roster version.").into()); }
        let previous = persistence::query(ctx, &self.schemas)?.ok_or_else(|| RemoteConnectionError::new(503,"remote_unavailable","The connection roster is not ready."))?;
        if previous["version"] != expected { let mut error = RemoteConnectionError::new(409,"conflict","The connections have changed."); error.current = Some(previous); return Err(error.into()); }
        let connections = previous["connections"].as_array().context("The stored connection roster is invalid.")?;
        let index = connections.iter().position(|connection| connection["id"] == id).ok_or_else(|| RemoteConnectionError::new(404,"not_found","The remote connection was not found."))?;
        let current = connections[index].clone(); let after = request["afterId"].as_str();
        if after == Some(id) { return Err(RemoteConnectionError::new(400,"invalid_request","A connection cannot be placed after itself.").into()); }
        let mut remaining = connections.iter().filter(|connection| connection["id"] != id).cloned().collect::<Vec<_>>();
        let destination = match after { None => 0, Some(after) => remaining.iter().position(|connection| connection["id"] == after).map(|index| index + 1).ok_or_else(|| RemoteConnectionError::new(404,"not_found","The destination connection was not found."))? };
        if index == destination { return Ok(previous); }
        let before = destination.checked_sub(1).and_then(|index| remaining.get(index)).and_then(|connection| connection["orderKey"].as_str());
        let after = remaining.get(destination).and_then(|connection| connection["orderKey"].as_str());
        let mut current = current; current["orderKey"] = json!(persistence::between(before, after)?); remaining.insert(destination, current);
        let snapshot = json!({"connections":remaining,"version":persistence::version(previous["version"].as_str())?}); self.save(ctx, &snapshot, request.get("mutationId"))?; Ok(snapshot)
    }
    async fn require_admin(&self, agent: &str) -> Result<()> { anyhow::ensure!(self.is_admin(agent).await?, "Only an active admin bot can manage remote connections."); Ok(()) }
    async fn is_admin(&self, agent: &str) -> Result<bool> { let bots = self.bots.clone(); let agent = agent.to_owned(); self.runtime.transact(move |ctx| Ok(bots.for_agent(ctx, &agent)?.is_some_and(|bot| bot["isAdmin"] == true && bot["status"] == "active"))).await }
    pub async fn set(self: &Arc<Self>, agent: &str, id: &str, entry: &Value) -> Result<Value> {
        self.require_admin(agent).await?; let mut pools = self.pools.lock().await;
        anyhow::ensure!(!self.closed.load(Ordering::Acquire), "Remote connections have stopped.");
        if self.config.remote_connections()?.get(id) != Some(entry) { self.config.write_runtime_connection(id, entry).await?; reconcile_pool(&mut pools, id, Some(entry)).await?; let durable = self.durable.clone(); self.runtime.transact(move |ctx| { durable.invoke(ctx,&json!({"function":"connections-reconcile","arguments":{},"lockKeys":["connections"]}))?; Ok(()) }).await?; }
        let module = self.clone(); self.runtime.transact(move |ctx| Ok(json!({"connections":module.snapshot(ctx)?["connections"]}))).await
    }
    async fn record(&self, id: &str) -> Result<(Value, Arc<proxy::RemoteProxyConnection>)> {
        let configuration = self.config.remote_connections()?; let entry = configuration.get(id).filter(|entry| entry["enabled"] != false).ok_or_else(|| RemoteConnectionError::new(404,"not_found","The remote connection was not found."))?;
        let mut pools = self.pools.lock().await;
        if self.closed.load(Ordering::Acquire) { return Err(RemoteConnectionError::new(503,"remote_unavailable","Remote connections have stopped.").into()); }
        if !pools.contains_key(id) { let carrier = self.tailcat.open_remote(entry["address"].as_str().context("The remote address is invalid.")?)?; pools.insert(id.to_owned(), Record { configuration: entry.clone(), pool: proxy::RemoteProxyConnection::new(carrier, entry["port"].as_u64().unwrap_or(24779) as u16) }); }
        let record = pools.get(id).expect("the admitted remote pool"); Ok((record.configuration.clone(), record.pool.clone()))
    }
    pub async fn forward(&self, request: Request<ProxyBody>, id: &str, path: &str, cancel: CancellationToken) -> Result<Response<ProxyBody>> {
        let (entry, pool) = self.record(id).await?; let team = self.config.team_enabled(); let cloud = self.cloud.clone(); let bearer = request.headers().get("authorization").and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer ")).map(str::to_owned); let auth_cancel = cancel.clone();
        pool.request(request, path, async move { if let Some(token) = entry["token"].as_str() { return Ok(token.to_owned()); } if team { return bearer.ok_or_else(|| RemoteConnectionError::new(401,"unauthorized","Unauthorized").into()); } cloud.mint_for_organization(entry["workos_organization_id"].as_str().context("The destination organization is invalid.")?, auth_cancel).await }, cancel).await
    }
    pub async fn health(self: &Arc<Self>, agent: &str, id: &str, cancel: CancellationToken) -> Result<Value> {
        self.require_admin(agent).await?; let (entry, pool) = self.record(id).await?; let cloud = self.cloud.clone(); let auth_cancel = cancel.clone();
        let result = pool.health(async move { if let Some(token) = entry["token"].as_str() { Ok(token.to_owned()) } else { cloud.mint_for_organization(entry["workos_organization_id"].as_str().context("The destination organization is invalid.")?, auth_cancel).await } }, cancel).await;
        let mut status = match result { Ok(status) => status, Err(error) => json!({"reachable":false,"authenticated":false,"ready":false,"error":error.downcast_ref::<RemoteConnectionError>().map_or("The remote health check could not authenticate. Team checks require a connected Cloud account authorized for that organization.", |error| &error.message)}) };
        status["connectionId"] = json!(id); anyhow::ensure!(self.schemas.valid("ownerConnectionHealth", &status)?, "The remote health check produced an invalid status."); Ok(status)
    }
    async fn reconcile(self: &Arc<Self>) -> Result<()> {
        let configuration = self.config.remote_connections()?; let mut pools = self.pools.lock().await; let ids = pools.keys().cloned().collect::<Vec<_>>(); for id in ids { reconcile_pool(&mut pools, &id, configuration.get(&id)).await?; }
        let module = self.clone(); self.runtime.transact(move |ctx| { module.snapshot(ctx)?; Ok(()) }).await
    }
    pub async fn close(&self) -> Result<()> { self.closed.store(true,Ordering::Release); let mut pools = self.pools.lock().await; for record in pools.values() { record.pool.close().await?; } pools.clear(); Ok(()) }
    fn definition(&self, call: &Value) -> Option<&ToolDefinition> { self.tools.iter().find(|tool| call["call"]["name"] == tool.name && call["call"]["namespace"].as_str() == tool.namespace.as_deref()) }
    fn arguments(&self, call: &Value, tool: &ToolDefinition) -> Result<Value> { let value: Value = serde_json::from_str(call["call"]["arguments"].as_str().context("The remote connection tool arguments are missing.")?)?; anyhow::ensure!(self.schemas.valid(&format!("ownerTool_{}",tool.name),&value)?,"The remote connection tool arguments are invalid."); Ok(value) }
}
async fn reconcile_pool(pools: &mut BTreeMap<String,Record>, id: &str, entry: Option<&Value>) -> Result<()> {
    let Some(record) = pools.get_mut(id) else { return Ok(()); };
    if let Some(entry) = entry.filter(|entry| entry["enabled"] != false) { let mut previous = record.configuration.clone(); let mut next = entry.clone(); previous.as_object_mut().expect("validated remote entry").remove("name"); next.as_object_mut().expect("validated remote entry").remove("name"); if previous == next { record.configuration = entry.clone(); return Ok(()); } }
    record.pool.close().await?; pools.remove(id); Ok(())
}
#[async_trait::async_trait]
impl AgentModule for ConnectionsModule {
    fn name(&self) -> &'static str { "connections" }
    async fn available_tools(&self, scope: &AgentScope<'_>) -> Result<Vec<ToolDefinition>> { Ok(if self.is_admin(scope.id).await? { self.tools.clone() } else { vec![] }) }
    async fn before_tool(&self, scope: &AgentScope<'_>, call: &Value) -> Result<()> { if self.definition(call).is_some() { self.require_admin(scope.id).await?; } Ok(()) }
    fn reloadable(&self, call: &Value) -> Option<bool> { self.definition(call).map(|_| false) }
    fn permission_policy(&self, _scope: &AgentScope<'_>, call: &Value) -> Option<Result<ToolPermissionPolicy>> { self.definition(call).map(|tool| { self.arguments(call,tool)?; let reviewed = tool.name != "list_remote_connections"; let action = match tool.name.as_str() { "set_remote_connection" => "configuring a Tailcat remote and granting this installation's clients access to its authenticated API", "remove_remote_connection" => "removing a configured remote connection and closing its active streams", "check_remote_connection_health" => "contacting a configured remote Happy Agent health endpoint over Tailcat using its configured authentication", _ => "listing configured remote Happy Agent installations" }; Ok(ToolPermissionPolicy { should_review_in_auto_mode: reviewed, should_run_in_full_access_in_auto_mode: reviewed, requires_auto_or_full_access: reviewed, action: action.into(), instructions: (tool.name=="set_remote_connection").then(|| "Registers remote API authority for this installation's authenticated clients and writes private machine configuration. Credentials must not be repeated in output.".into()) }) }) }
    async fn execute_tool(&self, scope: &AgentScope<'_>, call: &Value, cancel: CancellationToken) -> Option<Message> { let tool = self.definition(call)?; let result = async { let args = self.arguments(call,tool)?; let module = self.weak.upgrade().context("The remote connection owner has stopped.")?; match tool.name.as_str() { "set_remote_connection" => module.set(scope.id,args["id"].as_str().unwrap(),&args["connection"]).await, "remove_remote_connection" => module.set(scope.id,args["id"].as_str().unwrap(),&json!({"enabled":false})).await, "check_remote_connection_health" => module.health(scope.id,args["id"].as_str().unwrap(),cancel).await, _ => { module.require_admin(scope.id).await?; module.runtime.clone().transact(move |ctx| Ok(json!({"connections":module.snapshot(ctx)?["connections"]}))).await } } }.await; let (output,is_error) = match result { Ok(value) => (value.to_string(),false),Err(error)=>(format!("{error:#}"),true) }; Some(Message::Tool { call_id:call["id"].as_str().unwrap_or("").into(),content:vec![Block::text(&output)],is_error,vendor:None }) }
}
struct Reconcile(Weak<ConnectionsModule>);
impl DurableFunction for Reconcile { fn execute(self: Arc<Self>, _call: Value, _kv: CallKv, cancel: CancellationToken) -> BoxFuture<'static,Result<Value>> { Box::pin(async move { anyhow::ensure!(!cancel.is_cancelled(),"Remote connection reconciliation was stopped."); self.0.upgrade().context("The remote connection owner has stopped.")?.reconcile().await?; Ok(Value::Null) }) } }