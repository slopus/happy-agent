//! Bounded catalog queries use the caller's transaction snapshot.
use super::{PROJECT_COLUMNS, available, from_row, validate};
use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

pub(in crate::product::projects) fn query_catalog_page(
    ctx: &Context<'_>,
    schemas: &Schemas,
    query: &Value,
    limit: i64,
    offset: i64,
) -> Result<(Vec<Value>, bool)> {
    if !available(ctx)? {
        return Ok((Vec::new(), false));
    }
    let mut statement = ctx.database().prepare(&format!("SELECT {PROJECT_COLUMNS} FROM happy_agent_module_projects WHERE (?1 IS NULL OR status=?1) AND (?1 IS NOT NULL OR ?2=1 OR status<>'archived') ORDER BY order_key,id LIMIT ?3 OFFSET ?4"))?;
    let mut rows = statement.query(params![
        query["status"].as_str(),
        query["includeArchived"].as_bool().unwrap_or(false),
        limit + 1,
        offset
    ])?;
    let mut projects = Vec::new();
    while let Some(row) = rows.next()? {
        if projects.len() == limit as usize {
            return Ok((projects, true));
        }
        let project = from_row(row)?;
        validate(schemas, &project)?;
        projects.push(project);
    }
    Ok((projects, false))
}

pub(in crate::product::projects) fn query_agent_orders(
    ctx: &Context<'_>,
    project: &str,
) -> Result<Vec<Value>> {
    if !available(ctx)? {
        return Ok(Vec::new());
    }
    let agents = ctx.database().prepare("SELECT agent_id,order_key FROM happy_agent_module_project_root_agents WHERE project_id=?1 ORDER BY order_key,agent_id LIMIT 10001")?.query_map([project], |row| Ok(json!({"agentId":row.get::<_,String>(0)?,"orderKey":row.get::<_,String>(1)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(
        agents.len() <= 10000,
        "The project's root-agent series exceeds its snapshot bound."
    );
    Ok(agents)
}

pub(in crate::product::projects) fn query_by_path(
    ctx: &Context<'_>,
    schemas: &Schemas,
    path: &str,
    runner: Option<&str>,
) -> Result<Option<Value>> {
    if !available(ctx)? {
        return Ok(None);
    }
    let project = ctx.database().query_row(&format!("SELECT {PROJECT_COLUMNS} FROM happy_agent_module_projects WHERE repository_ref=?1 AND runner_id=?2 LIMIT 1"),params![path,runner.unwrap_or("")],from_row).optional()?;
    if let Some(project) = &project {
        validate(schemas, project)?;
    }
    Ok(project)
}

pub(in crate::product::projects) fn query_home_id(ctx: &Context<'_>) -> Result<Option<String>> {
    Ok(ctx.database().query_row("SELECT id FROM happy_agent_module_projects WHERE kind='home' ORDER BY order_key,id LIMIT 1",[],|row|row.get(0)).optional()?)
}

pub(in crate::product::projects) fn query_storage_key_exists(
    ctx: &Context<'_>,
    candidate: &str,
) -> Result<bool> {
    Ok(ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM happy_agent_module_projects WHERE lower(storage_key)=lower(?1))",[candidate],|row|row.get(0))?)
}

pub(in crate::product::projects) fn query_last_order(ctx: &Context<'_>) -> Result<Option<String>> {
    Ok(ctx.database().query_row("SELECT order_key FROM happy_agent_module_projects ORDER BY order_key DESC,id DESC LIMIT 1",[],|row|row.get(0)).optional()?)
}
