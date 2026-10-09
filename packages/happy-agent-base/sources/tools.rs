use crate::{
    PendingCall, PermissionMode,
    persistence::{StorageError, Store, Tx},
};
use async_trait::async_trait;
use happy_providers::{Block, Message, ToolDefinition};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct ToolContext {
    pub agent_id: String,
    pub call: PendingCall,
    pub permission_mode: PermissionMode,
    pub cancel: CancellationToken,
    pub store: Store,
}
impl ToolContext {
    pub async fn commit(&self, result: ToolResult) -> Result<bool, StorageError> {
        let id = self.agent_id.clone();
        let call = self.call.clone();
        self.store
            .transact(move |ctx| ctx.commit_call(&id, &call, &result.message(&call)))
            .await
            .map(|(value, _)| value)
    }
    pub fn commit_in(&self, ctx: &Tx<'_>, result: ToolResult) -> Result<bool, StorageError> {
        ctx.commit_call(&self.agent_id, &self.call, &result.message(&self.call))
    }
}
#[derive(Clone, Debug)]
pub struct ToolResult {
    pub content: Vec<Block>,
    pub is_error: bool,
}
impl ToolResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![Block::text(text)],
            is_error: false,
        }
    }
    pub fn error(text: impl Into<String>) -> Self {
        Self {
            content: vec![Block::text(text)],
            is_error: true,
        }
    }
    pub fn message(&self, call: &PendingCall) -> Message {
        Message::Tool {
            call_id: call.provider_call_id.clone(),
            content: self.content.clone(),
            is_error: self.is_error,
            vendor: call.vendor.clone(),
        }
    }
}

pub enum PermissionDecision {
    Run,
    RunIn(PermissionMode),
    Answer(ToolResult),
}
/// Every tool owns its review decision. The loop never guesses from names.
#[async_trait]
pub trait Tool: Send + Sync {
    fn definition(&self) -> ToolDefinition;
    fn durable(&self) -> bool {
        false
    }
    fn reloadable(&self) -> bool {
        false
    }
    fn steerable(&self) -> bool {
        false
    }
    fn should_review_in_auto_mode(&self, arguments: &Value) -> bool;
    fn should_run_in_full_access_in_auto_mode(&self, _arguments: &Value) -> bool {
        false
    }
    async fn review(&self, _context: &ToolContext, _arguments: &Value) -> PermissionDecision {
        PermissionDecision::Answer(ToolResult::error(
            "Automatic review is unavailable for this action.",
        ))
    }
    async fn execute(&self, context: ToolContext, arguments: Value) -> anyhow::Result<ToolResult>;
}
