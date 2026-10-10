use anyhow::Result;
use serde_json::Value;

use crate::product::runtime::Context;

/// Replace one agent's indexed servers with `rows`, already checked against the index schema.
pub(in crate::product::mcp) fn replace_server_index(ctx: &Context<'_>, agent_id: &str, rows: &[Value]) -> Result<()> {
    ctx.database().execute("DELETE FROM mcp_module_index WHERE agent_id = ?1", [agent_id])?;
    for entry in rows {
        ctx.database().execute(
            "INSERT INTO mcp_module_index (agent_id, name, fingerprint, status, tool_count, error_message, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                agent_id,
                entry["name"].as_str(),
                entry["fingerprint"].as_str(),
                entry["status"].as_str(),
                entry["toolCount"].as_i64(),
                entry["errorMessage"].as_str(),
                entry["updatedAt"].as_i64(),
            ],
        )?;
    }
    Ok(())
}

/// One agent's indexed servers by name, as `replace_server_index` wrote them.
#[cfg(test)]
pub(in crate::product::mcp) fn query_server_index(ctx: &Context<'_>, agent_id: &str) -> Result<Vec<Value>> {
    let mut statement = ctx.database().prepare(
        "SELECT name, fingerprint, status, tool_count, error_message, updated_at FROM mcp_module_index WHERE agent_id = ?1 ORDER BY name",
    )?;
    let rows = statement.query_map([agent_id], |row| {
        let mut entry = serde_json::json!({
            "agentId": agent_id,
            "name": row.get::<_, String>(0)?,
            "status": row.get::<_, String>(2)?,
            "toolCount": row.get::<_, i64>(3)?,
            "updatedAt": row.get::<_, i64>(5)?,
        });
        if let Some(fingerprint) = row.get::<_, Option<String>>(1)? {
            entry["fingerprint"] = fingerprint.into();
        }
        if let Some(message) = row.get::<_, Option<String>>(4)? {
            entry["errorMessage"] = message.into();
        }
        Ok(entry)
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}
