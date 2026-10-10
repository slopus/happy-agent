use super::{auto::AutoModule, config::ConfigModule, events::EventsModule, history::HistoryModule, lifecycle::LifecycleModule, permissions::PermissionsModule, runtime::{Context, RuntimeModule}, tools::ToolsModule, usage::UsageModule};
use anyhow::{Context as _, Result};
use happy_agent_base::{AgentModule, AgentSystem};
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// Owns the original durable agent collection. Product catalogs depend on this
/// feature; it never receives paths, processes or application-host callbacks.
pub struct AgentRuntimeModule {
    runtime: Arc<RuntimeModule>,
    installation: Mutex<Option<Vec<Arc<dyn AgentModule>>>>,
    system: Mutex<Option<Arc<AgentSystem>>>,
}
impl AgentRuntimeModule {
    #[expect(clippy::too_many_arguments)]
    pub fn new(config: Arc<ConfigModule>, runtime: Arc<RuntimeModule>, history: Arc<HistoryModule>, tools: Arc<ToolsModule>, usage: Arc<UsageModule>, lifecycle: Arc<LifecycleModule>, auto: Arc<AutoModule>, permissions: Arc<PermissionsModule>, events: Arc<EventsModule>) -> Self {
        Self { runtime, installation: Mutex::new(Some(vec![config, lifecycle, history, auto, permissions, tools, usage, events])), system: Mutex::new(None) }
    }
    /// An owning feature installs its whole hook surface during construction.
    /// Startup freezes the resulting fixed module array before any agent runs.
    pub fn install(&self, module: Arc<dyn AgentModule>) -> Result<()> {
        let mut installation = self.installation.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        installation.as_mut().context("Agent module installation is closed after startup.")?.push(module);
        Ok(())
    }
    pub fn prepare(&self) -> Result<()> {
        let mut installation = self.installation.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut system = self.system.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if system.is_none() {
            *system = Some(Arc::new(AgentSystem::new(self.runtime.database(), installation.as_ref().context("The agent runtime has already closed.")?.clone())?));
            *installation = None;
        }
        Ok(())
    }
    fn system(&self) -> Result<Arc<AgentSystem>> { self.system.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone().context("The agent runtime is not prepared.") }
    pub fn configuration(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> { self.system()?.configuration(ctx, id) }
    pub fn owed(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> { self.system()?.owed(ctx, id) }
    pub fn create(&self, ctx: &Context<'_>, id: &str, configuration: &Value) -> Result<()> { self.system()?.create(ctx, id, configuration) }
    pub fn create_from(&self, ctx: &Context<'_>, id: &str, configuration: &Value, creator: Option<&str>) -> Result<()> { self.system()?.create_from(ctx, id, configuration, creator) }
    pub fn update_metadata(&self, ctx: &Context<'_>, id: &str, update: &Value) -> Result<()> { self.system()?.update_metadata(ctx, id, update) }
    pub fn enqueue(&self, ctx: &Context<'_>, id: &str, input: &Value, steering: bool) -> Result<()> { self.system()?.enqueue(ctx, id, input, steering) }
    pub fn enqueue_with_receipt(&self, ctx: &Context<'_>, id: &str, input: &Value, steering: bool) -> Result<bool> { self.system()?.enqueue_with_receipt(ctx, id, input, steering) }
    pub fn children(&self, ctx: &Context<'_>, id: &str) -> Result<Vec<String>> { self.system()?.children(ctx, id) }
    pub fn parent(&self, ctx: &Context<'_>, id: &str) -> Result<Option<String>> { self.system()?.parent(ctx, id) }
    pub fn set_parent(&self, ctx: &Context<'_>, id: &str, parent: &str) -> Result<()> { self.system()?.set_parent(ctx, id, parent) }
    pub fn abort(&self, ctx: &Context<'_>, id: &str) -> Result<()> { self.system()?.request_abort(ctx, id) }
    pub async fn wait_for_idle(&self, id: &str, cancel: &tokio_util::sync::CancellationToken) -> Result<()> { self.system()?.wait_for_idle(id, cancel).await }
    pub async fn load(&self) -> Result<()> { self.system()?.load().await }
    pub async fn close(&self) {
        let system = self.system.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        if let Some(system) = system { system.close().await; }
        *self.installation.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }
}