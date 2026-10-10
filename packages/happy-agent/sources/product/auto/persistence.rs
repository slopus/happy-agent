use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::Result;
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

pub(super) fn cursor(ctx: &Context<'_>, schemas: &Schemas, reviewer: &str) -> Result<Option<Value>> {
    let stored: Option<String> = ctx.database().query_row("SELECT value_json FROM happy_agent_values WHERE owner_id='' AND key=?1", [format!("agentSystem.autoCursor.{reviewer}")], |row| row.get(0)).optional()?;
    stored.map(|encoded| { let value = serde_json::from_str(&encoded)?; anyhow::ensure!(schemas.valid("autoReviewerCursor", &value)?, "The stored private reviewer cursor is invalid."); Ok(value) }).transpose()
}
pub(super) fn write_cursor(ctx: &Context<'_>, schemas: &Schemas, reviewer: &str, value: &Value) -> Result<()> {
    anyhow::ensure!(schemas.valid("autoReviewerCursor", value)?, "The private reviewer cursor is invalid.");
    ctx.database().execute("INSERT INTO happy_agent_values VALUES('',?1,?2) ON CONFLICT(owner_id,key) DO UPDATE SET value_json=excluded.value_json", params![format!("agentSystem.autoCursor.{reviewer}"), value.to_string()])?;
    Ok(())
}
pub(super) fn result(ctx: &Context<'_>, schemas: &Schemas, agent: &str, call: &str) -> Result<Option<Value>> {
    let stored: Option<String> = ctx.database().query_row("SELECT result_json FROM happy_agent_auto_native_reviews WHERE agent_id=?1 AND call_id=?2", params![agent, call], |row| row.get(0)).optional()?;
    stored.map(|encoded| { let value = serde_json::from_str(&encoded)?; anyhow::ensure!(schemas.valid("nativeAutoOutcome", &value)?, "The stored automatic review outcome is invalid."); Ok(value) }).transpose()
}
pub(super) fn save_result(ctx: &Context<'_>, schemas: &Schemas, agent: &str, call: &str, review: &str, result: &Value) -> Result<()> {
    anyhow::ensure!(schemas.valid("nativeAutoOutcome", result)?, "The automatic review outcome is invalid.");
    if let Some(existing) = self::result(ctx, schemas, agent, call)? { anyhow::ensure!(existing == *result, "The tool call already has a different durable review."); return Ok(()); }
    let (rows, bytes): (usize, usize) = ctx.database().query_row("SELECT count(*),coalesce(sum(length(CAST(result_json AS BLOB))),0) FROM happy_agent_auto_native_reviews", [], |row| Ok((row.get(0)?,row.get(1)?)))?;
    let encoded = result.to_string();
    anyhow::ensure!(rows < 10_000 && bytes + encoded.len() <= 64 * 1024 * 1024, "The automatic review outcomes exceed their retention bound.");
    ctx.database().execute("INSERT INTO happy_agent_auto_native_reviews VALUES(?1,?2,?3,?4)", params![agent,call,review,encoded])?;
    Ok(())
}
pub(super) fn remove_result(ctx: &Context<'_>, agent: &str, call: &str) -> Result<()> {
    ctx.database().execute("DELETE FROM happy_agent_auto_native_reviews WHERE agent_id=?1 AND call_id=?2", params![agent,call])?;
    Ok(())
}