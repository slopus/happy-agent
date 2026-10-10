//! Catalog filters apply before decoding bounded rows.
use super::{COLUMNS, available, from_row, validate};
use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::{Result, ensure};
use rusqlite::params;
use serde_json::{Value, json};

pub(in crate::product::workspaces) fn query_catalog_page(
    ctx: &Context<'_>,
    schemas: &Schemas,
    query: &Value,
    limit: i64,
    offset: i64,
) -> Result<Vec<Value>> {
    if !available(ctx)? {
        return Ok(Vec::new());
    }
    let mut statement=ctx.database().prepare(&format!("SELECT {COLUMNS} FROM happy_agent_module_workspaces WHERE (?1 IS NULL OR project_ref=?1) AND (?2=1 OR status NOT IN ('archived','archiving')) ORDER BY order_key,id LIMIT ?3 OFFSET ?4"))?;
    let rows = statement
        .query_map(
            params![
                query["projectRef"].as_str(),
                query["includeArchived"].as_bool().unwrap_or(false),
                limit + 1,
                offset
            ],
            from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for workspace in &rows {
        validate(schemas, workspace)?;
    }
    Ok(rows)
}

pub(in crate::product::workspaces) fn query_agent_orders(
    ctx: &Context<'_>,
    workspace: &str,
) -> Result<Vec<Value>> {
    if !available(ctx)? {
        return Ok(Vec::new());
    }
    let agents=ctx.database().prepare("SELECT agent_id,order_key FROM happy_agent_module_workspace_agents WHERE workspace_id=?1 ORDER BY order_key,agent_id LIMIT 10001")?.query_map([workspace],|row|Ok(json!({"agentId":row.get::<_,String>(0)?,"orderKey":row.get::<_,String>(1)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(
        agents.len() <= 10000,
        "The workspace's agent series exceeds its snapshot bound."
    );
    Ok(agents)
}
