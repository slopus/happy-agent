use super::runtime::{Context, RuntimeModule};
use anyhow::Result;
use rusqlite::OptionalExtension;
use std::sync::Arc;

pub struct WorkspacesModule {
    runtime: Arc<RuntimeModule>,
}
impl WorkspacesModule {
    pub fn new(runtime: Arc<RuntimeModule>) -> Self {
        Self { runtime }
    }
    pub fn agent_association(
        &self,
        ctx: &Context<'_>,
        agent: &str,
    ) -> Result<Option<(String, String)>> {
        self.runtime.assert_context(ctx)?;
        let exists:bool=ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='happy_agent_module_workspace_agents')",[],|row|row.get(0))?;
        if !exists {
            return Ok(None);
        }
        Ok(ctx.database().query_row("SELECT workspace_id,order_key FROM happy_agent_module_workspace_agents WHERE agent_id=?1",[agent],|row|Ok((row.get(0)?,row.get(1)?))).optional()?)
    }
}
