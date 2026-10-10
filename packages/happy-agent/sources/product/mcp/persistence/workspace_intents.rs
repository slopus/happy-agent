use anyhow::{Result, bail};
use rusqlite::OptionalExtension;

use crate::product::runtime::Context;

/// One workspace change MCP still owes, keyed by workspace; `sequence` orders changes to
/// different workspaces as they committed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::product::mcp) struct WorkspaceIntent {
    pub workspace: String,
    pub change: String,
    pub sequence: i64,
}

/// Owe `change` for `workspace`. A later change to the same workspace replaces an earlier one
/// that has not been applied, so at most one row is owed per workspace.
pub(in crate::product::mcp) fn record_workspace_intent(ctx: &Context<'_>, workspace: &str, change: &str) -> Result<()> {
    if !matches!(change, "active" | "released") {
        bail!("The MCP workspace change is invalid.");
    }
    ctx.database().execute(
        "INSERT INTO mcp_workspace_intents (workspace, change, sequence)
         VALUES (?1, ?2, (SELECT coalesce(max(sequence), 0) + 1 FROM mcp_workspace_intents))
         ON CONFLICT(workspace) DO UPDATE SET change = excluded.change, sequence = excluded.sequence",
        [workspace, change],
    )?;
    Ok(())
}

/// The change owed longest, if any.
pub(in crate::product::mcp) fn query_next_workspace_intent(ctx: &Context<'_>) -> Result<Option<WorkspaceIntent>> {
    let intent = ctx
        .database()
        .query_row("SELECT workspace, change, sequence FROM mcp_workspace_intents ORDER BY sequence LIMIT 1", [], |row| {
            Ok(WorkspaceIntent { workspace: row.get(0)?, change: row.get(1)?, sequence: row.get(2)? })
        })
        .optional()?;
    if let Some(intent) = &intent
        && !matches!(intent.change.as_str(), "active" | "released")
    {
        bail!("A stored MCP workspace change is invalid.");
    }
    Ok(intent)
}

/// Settle `intent` unless a newer change to its workspace replaced it meanwhile.
pub(in crate::product::mcp) fn settle_workspace_intent(ctx: &Context<'_>, intent: &WorkspaceIntent) -> Result<()> {
    ctx.database().execute(
        "DELETE FROM mcp_workspace_intents WHERE workspace = ?1 AND sequence = ?2",
        rusqlite::params![intent.workspace, intent.sequence],
    )?;
    Ok(())
}
