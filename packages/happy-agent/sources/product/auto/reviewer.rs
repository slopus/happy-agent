use super::capture::Capture;
use crate::product::{config::ConfigModule, lifecycle::LifecycleModule};
use anyhow::{Context as _, Result};
use happy_agent_base::{AgentModule, AgentScope, DatabaseContext, Inference};
use happy_providers::{Block, Message, Session, ToolDefinition};
use std::{collections::BTreeMap, sync::{Arc, Mutex}};
use tokio_util::sync::CancellationToken;

struct ActiveReview { instructions: String, capture: Capture }

/// The private core installs only this runtime and its own read-only compute.
/// Public History, Usage and Events never receive its inference hooks.
pub(super) struct ReviewerRuntimeModule {
    config: Arc<ConfigModule>,
    shutdown: CancellationToken,
    reviews: Mutex<BTreeMap<String, ActiveReview>>,
}
impl ReviewerRuntimeModule {
    pub fn new(config: Arc<ConfigModule>, lifecycle: Arc<LifecycleModule>) -> Self {
        Self { config, shutdown: lifecycle.shutdown.child_token(), reviews: Mutex::new(BTreeMap::new()) }
    }
    pub fn begin(&self, reviewer: &str, instructions: String) -> Result<()> {
        let mut reviews = self.reviews.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(reviews.len() < 10_000 && !reviews.contains_key(reviewer), "The private reviewer has too many active reviews.");
        reviews.insert(reviewer.to_owned(), ActiveReview { instructions, capture: Capture::default() });
        Ok(())
    }
    pub fn take(&self, reviewer: &str) -> Result<Capture> {
        self.reviews.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(reviewer).map(|review| review.capture).context("The private reviewer capture is unavailable.")
    }
    pub fn stop(&self) { self.shutdown.cancel(); }
}
#[async_trait::async_trait]
impl AgentModule for ReviewerRuntimeModule {
    fn name(&self) -> &'static str { "autoReviewRuntime" }
    fn shutdown(&self) -> Option<CancellationToken> { Some(self.shutdown.clone()) }
    fn compatible(&self, previous: &serde_json::Value, next: &serde_json::Value) -> Option<Result<bool>> { Some(self.config.models_compatible(previous, next)) }
    async fn instructions(&self, scope: &AgentScope<'_>) -> Result<String> {
        self.reviews.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(scope.id).map(|review| review.instructions.clone()).context("The private reviewer instructions are unavailable.")
    }
    fn session_key(&self, scope: &AgentScope<'_>, tools: &[ToolDefinition]) -> Result<Option<String>> { Ok(Some(self.config.session_key(scope.settings, tools)?)) }
    async fn session(&self, scope: &AgentScope<'_>, tools: Vec<ToolDefinition>) -> Option<Result<Box<dyn Session>>> {
        Some(self.config.session(scope.id, scope.settings, tools).await)
    }
    fn block(&self, _ctx: &DatabaseContext<'_>, scope: &AgentScope<'_>, _inference: &str, block: &Block, _base_id: Option<&str>) -> Result<()> {
        if let Some(review) = self.reviews.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get_mut(scope.id) { review.capture.block(block); }
        Ok(())
    }
    fn after_inference(&self, _ctx: &DatabaseContext<'_>, scope: &AgentScope<'_>, inference: &Inference<'_>) -> Result<()> {
        if let Some(review) = self.reviews.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get_mut(scope.id) { review.capture.outcome(inference.outcome)?; }
        Ok(())
    }
    fn tool_result(&self, _ctx: &DatabaseContext<'_>, scope: &AgentScope<'_>, call: &serde_json::Value, result: &Message) -> Result<()> {
        if let Some(review) = self.reviews.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get_mut(scope.id) { review.capture.result(call, result); }
        Ok(())
    }
}