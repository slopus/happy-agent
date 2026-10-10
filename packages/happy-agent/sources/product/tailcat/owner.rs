use super::{TailcatConnection, TailcatExposure};
use crate::product::{agent_runtime::AgentRuntimeModule, bots::BotsModule, config::ConfigModule, durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration}, runtime::RuntimeModule, schemas::Schemas};
use anyhow::{Context as _, Result};
use futures_util::future::BoxFuture;
use happy_agent_base::{AgentModule, AgentScope, ToolPermissionPolicy};
use happy_providers::{Block, Message, ToolDefinition};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, Weak, atomic::{AtomicBool, Ordering}};
use tokio_util::sync::CancellationToken;

pub struct TailcatModule {
    config: Arc<ConfigModule>, bots: Arc<BotsModule>, runtime: Arc<RuntimeModule>, durable: Arc<DurableFunctionsModule>,
    schemas: Schemas, tools: Vec<ToolDefinition>, live: Mutex<Live>, execution: tokio::sync::Mutex<()>,
    outbound: Mutex<Vec<Weak<TailcatConnection>>>, closed: AtomicBool, weak: Weak<Self>,
}
struct Live { state: &'static str, error: Option<String>, target: Option<Value>, exposure: Option<Arc<TailcatExposure>> }
impl TailcatModule {
    pub fn open_runner_remote(config:&ConfigModule,address:&str)->Result<Arc<TailcatConnection>> {
        anyhow::ensure!(Schemas::new()?.valid("ownerTailcatAddress",&json!(address))?,"The runner's Tailcat address is invalid.");
        Ok(TailcatConnection::new(config.tailcat_executable(),address.to_owned()))
    }
    pub fn new(config: Arc<ConfigModule>, bots: Arc<BotsModule>, runtime: Arc<RuntimeModule>, durable: Arc<DurableFunctionsModule>, agents: Arc<AgentRuntimeModule>) -> Result<Arc<Self>> {
        let tools = serde_json::from_str(include_str!("tool_definitions.json"))?; let schemas = Schemas::new()?;
        let module = Arc::new_cyclic(|weak| Self { live: Mutex::new(Live { state: if config.tailcat_enabled() { "starting" } else { "disabled" }, error: None, target: None, exposure: None }), config, bots, runtime, durable: durable.clone(), schemas, tools, execution: tokio::sync::Mutex::new(()), outbound: Mutex::new(Vec::new()), closed: AtomicBool::new(false), weak: weak.clone() });
        durable.register(Registration { name: "tailcat-reconcile".into(), arguments_schema: "ownerReconcileArgs", result_schema: "ownerNull", function: Arc::new(Reconcile(Arc::downgrade(&module))) })?;
        agents.install(module.clone())?; Ok(module)
    }
    pub fn current_status(&self) -> Result<Value> {
        let live = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut status = json!({"enabled":self.config.tailcat_enabled(),"state":live.state});
        if let Some(exposure) = &live.exposure { status["address"] = json!(exposure.address); status["port"] = json!(exposure.port); }
        if let Some(error) = &live.error { status["error"] = json!(error); }
        anyhow::ensure!(self.schemas.valid("ownerTailcatStatus", &status)?, "Tailcat produced an invalid live status."); Ok(status)
    }
    pub async fn attach_transport(self: &Arc<Self>, target: Value) -> Result<Value> {
        anyhow::ensure!(self.schemas.valid("ownerTailcatTarget", &target)?, "The Tailcat API transport target is invalid.");
        let _execution = self.execution.lock().await;
        anyhow::ensure!(!self.closed.load(Ordering::Acquire), "Tailcat has already stopped.");
        { let mut live = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner); anyhow::ensure!(live.target.as_ref().is_none_or(|existing| existing == &target), "Tailcat is already attached to another API transport."); live.target = Some(target); }
        self.reconcile_locked().await
    }
    pub async fn is_admin(&self, agent: &str) -> Result<bool> {
        let bots = self.bots.clone(); let agent = agent.to_owned();
        self.runtime.transact(move |ctx| Ok(bots.for_agent(ctx, &agent)?.is_some_and(|bot| bot["isAdmin"] == true && bot["status"] == "active"))).await
    }
    async fn require_admin(&self, agent: &str, action: &str) -> Result<()> { anyhow::ensure!(self.is_admin(agent).await?, "Only an active admin bot can {action} Tailcat internet exposure."); Ok(()) }
    pub async fn set_enabled(self: &Arc<Self>, agent: &str, enabled: bool) -> Result<Value> {
        self.require_admin(agent, "manage").await?;
        let _execution = self.execution.lock().await;
        anyhow::ensure!(!self.closed.load(Ordering::Acquire), "Tailcat has already stopped.");
        self.config.write_runtime_tailcat_enabled(enabled).await?;
        let durable = self.durable.clone(); self.runtime.transact(move |ctx| { durable.invoke(ctx, &json!({"function":"tailcat-reconcile","arguments":{},"lockKeys":["tailcat-exposure"]}))?; Ok(()) }).await?;
        self.reconcile_locked().await
    }
    pub async fn status(&self, agent: &str) -> Result<Value> { self.require_admin(agent, "inspect").await?; self.current_status() }
    pub fn open_remote(&self, address: &str) -> Result<Arc<TailcatConnection>> {
        anyhow::ensure!(!self.closed.load(Ordering::Acquire) && self.schemas.valid("ownerTailcatAddress", &json!(address))?, "The remote Tailcat connection is unavailable.");
        let mut outbound = self.outbound.lock().unwrap_or_else(std::sync::PoisonError::into_inner); outbound.retain(|carrier| carrier.strong_count() > 0);
        anyhow::ensure!(outbound.len() < 100, "The remote Tailcat carrier catalog is full.");
        let connection = TailcatConnection::new(self.config.tailcat_executable(), address.to_owned()); outbound.push(Arc::downgrade(&connection)); Ok(connection)
    }
    async fn reconcile(self: &Arc<Self>) -> Result<Value> { let _execution = self.execution.lock().await; self.reconcile_locked().await }
    async fn reconcile_locked(&self) -> Result<Value> {
        if self.closed.load(Ordering::Acquire) { return self.current_status(); }
        if !self.config.tailcat_enabled() {
            let exposure = { let mut live = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner); if live.exposure.is_some() { live.state = "stopping"; } live.exposure.clone() };
            if let Some(exposure) = exposure { exposure.close().await?; }
            { let mut live = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner); live.exposure = None; live.state = "disabled"; live.error = None; }
            return self.current_status();
        }
        let target = { let mut live = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner); if live.exposure.is_some() { live.state = "open"; live.error = None; return drop_and_status(live, self); } live.state = "starting"; live.error = None; live.target.clone() };
        let Some(target) = target else { return self.current_status(); };
        match TailcatExposure::open(&self.config, target).await {
            Ok(exposure) => { let mut live = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner); live.exposure = Some(exposure); live.state = "open"; }
            Err(error) => { let text = format!("{error:#}"); let text = text.chars().scan(0, |units, character| { *units += character.len_utf16(); (*units <= 8192).then_some(character) }).collect::<String>(); let mut live = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner); live.exposure = None; live.state = "failed"; live.error = Some(if text.trim().is_empty() { "Tailcat failed without an error message.".into() } else { text }); return Err(error); }
        }
        self.current_status()
    }
    pub async fn close(&self) -> Result<()> {
        let _execution = self.execution.lock().await;
        self.closed.store(true, Ordering::Release);
        let outbound = self.outbound.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().filter_map(Weak::upgrade).collect::<Vec<_>>();
        for carrier in outbound { carrier.close().await?; }
        let exposure = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner).exposure.clone();
        if let Some(exposure) = exposure { exposure.close().await?; }
        self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner).exposure = None; Ok(())
    }
    fn definition(&self, call: &Value) -> Option<&ToolDefinition> { self.tools.iter().find(|tool| call["call"]["name"] == tool.name && call["call"]["namespace"].as_str() == tool.namespace.as_deref()) }
    fn arguments(&self, call: &Value, tool: &ToolDefinition) -> Result<Value> { let arguments: Value = serde_json::from_str(call["call"]["arguments"].as_str().context("The Tailcat tool arguments are missing.")?)?; anyhow::ensure!(self.schemas.valid(&format!("ownerTool_{}", tool.name), &arguments)?, "The Tailcat tool arguments are invalid."); Ok(arguments) }
}
fn drop_and_status(live: std::sync::MutexGuard<'_, Live>, module: &TailcatModule) -> Result<Value> { drop(live); module.current_status() }
#[async_trait::async_trait]
impl AgentModule for TailcatModule {
    fn name(&self) -> &'static str { "tailcat" }
    async fn available_tools(&self, scope: &AgentScope<'_>) -> Result<Vec<ToolDefinition>> { Ok(if self.is_admin(scope.id).await? { self.tools.clone() } else { vec![] }) }
    async fn before_tool(&self, scope: &AgentScope<'_>, call: &Value) -> Result<()> { if self.definition(call).is_some() { self.require_admin(scope.id, "manage").await?; } Ok(()) }
    fn reloadable(&self, call: &Value) -> Option<bool> { self.definition(call).map(|tool| tool.name == "get_tailcat_status") }
    fn permission_policy(&self, _scope: &AgentScope<'_>, call: &Value) -> Option<Result<ToolPermissionPolicy>> {
        self.definition(call).map(|tool| { let args = self.arguments(call, tool)?; let mutate = tool.name == "set_tailcat_enabled"; Ok(ToolPermissionPolicy { should_review_in_auto_mode: mutate, should_run_in_full_access_in_auto_mode: mutate, requires_auto_or_full_access: mutate, action: if mutate { if args["enabled"] == true { "opening account-free Tailcat internet exposure for this Happy Agent API" } else { "closing this Happy Agent installation's Tailcat internet exposure" } } else { "reading Tailcat internet exposure status" }.into(), instructions: mutate.then(|| "Enabling Tailcat makes this Happy Agent API reachable from the internet through an account-free tunnel. Disabling it closes that tunnel.".into()) }) })
    }
    async fn execute_tool(&self, scope: &AgentScope<'_>, call: &Value, _cancel: CancellationToken) -> Option<Message> {
        let tool = self.definition(call)?;
        let result = async { let args = self.arguments(call, tool)?; let module = self.weak.upgrade().context("The Tailcat owner has stopped.")?; if tool.name == "set_tailcat_enabled" { module.set_enabled(scope.id, args["enabled"].as_bool().context("The Tailcat setting is invalid.")?).await } else { module.status(scope.id).await } }.await;
        let (output, is_error) = match result { Ok(status) => (format_status(&status), false), Err(error) => (format!("{error:#}"), true) };
        Some(Message::Tool { call_id: call["id"].as_str().unwrap_or("").into(), content: vec![Block::text(&output)], is_error, vendor: None })
    }
}
fn format_status(status: &Value) -> String { match status["state"].as_str() { Some("open") if status["address"].is_string() => format!("Tailcat internet exposure is open at {}.", status["address"].as_str().unwrap()), Some("failed") => format!("Tailcat internet exposure is enabled but could not open: {}", status["error"].as_str().unwrap_or("unknown error")), Some("starting") => "Tailcat internet exposure is starting.".into(), Some("stopping") => "Tailcat internet exposure is stopping.".into(), _ => "Tailcat internet exposure is disabled.".into() } }
struct Reconcile(Weak<TailcatModule>);
impl DurableFunction for Reconcile {
    fn execute(self: Arc<Self>, _call: Value, _kv: CallKv, cancel: CancellationToken) -> BoxFuture<'static, Result<Value>> { Box::pin(async move { anyhow::ensure!(!cancel.is_cancelled(), "Tailcat reconciliation was stopped."); self.0.upgrade().context("The Tailcat owner has stopped.")?.reconcile().await?; Ok(Value::Null) }) }
}