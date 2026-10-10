//! Complete workspace pages are independent of the model's prose budget.
use super::{WorkspacesModule, persistence};
use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::{Result, ensure};
use rusqlite::params;
use serde_json::{Value, json};

impl WorkspacesModule {
    pub fn list_catalog_page(&self, ctx: &Context<'_>, query: &Value) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        self.assert_catalog_enabled()?;
        let schemas = Schemas::new()?;
        ensure!(
            schemas.valid("ownerWorkspacePageQuery", query)?,
            "The workspace page query is invalid."
        );
        let limit = query["limit"].as_i64().unwrap_or(50);
        let offset = query["cursor"].as_i64().unwrap_or(0);
        let mut workspaces = Vec::new();
        if persistence::available(ctx)? {
            let mut statement = ctx.database().prepare(&format!(
                "SELECT {} FROM happy_agent_module_workspaces \
                 WHERE (?1 IS NULL OR project_ref=?1) \
                 AND (?2=1 OR status NOT IN ('archived','archiving')) \
                 ORDER BY order_key,id LIMIT ?3 OFFSET ?4",
                persistence::COLUMNS
            ))?;
            workspaces = statement
                .query_map(
                    params![
                        query["projectRef"].as_str(),
                        query["includeArchived"].as_bool().unwrap_or(false),
                        limit + 1,
                        offset
                    ],
                    persistence::from_row,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for workspace in &workspaces {
                persistence::validate(&schemas, workspace)?;
            }
        }
        let more = workspaces.len() > limit as usize;
        workspaces.truncate(limit as usize);
        let mut page = json!({"workspaces":workspaces, "cursor":offset});
        if more {
            page["nextCursor"] = json!(offset + limit);
        }
        ensure!(
            schemas.valid("ownerWorkspacePage", &page)?,
            "The stored workspace page is invalid."
        );
        Ok(page)
    }

    pub fn list_agents(&self, ctx: &Context<'_>, workspace: &str) -> Result<Vec<Value>> {
        self.runtime.assert_context(ctx)?;
        self.assert_catalog_enabled()?;
        let schemas = Schemas::new()?;
        ensure!(
            schemas.valid("ownerWorkspaceId", &json!(workspace))?,
            "The workspace ID is invalid."
        );
        if !persistence::available(ctx)? {
            return Ok(Vec::new());
        }
        let agents = ctx
            .database()
            .prepare(
                "SELECT agent_id,order_key FROM happy_agent_module_workspace_agents \
             WHERE workspace_id=?1 ORDER BY order_key,agent_id LIMIT 10001",
            )?
            .query_map([workspace], |row| {
                Ok(json!({
                    "agentId":row.get::<_, String>(0)?,
                    "orderKey":row.get::<_, String>(1)?
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            agents.len() <= 10000,
            "The workspace's agent series exceeds its snapshot bound."
        );
        ensure!(
            schemas.valid("ownerWorkspaceAgentOrders", &json!(agents))?,
            "The stored workspace agent order is invalid."
        );
        Ok(agents)
    }

    fn assert_catalog_enabled(&self) -> Result<()> {
        if let Some(owners) = &self.owners {
            ensure!(
                owners.config.values["features"]["workspaces"]
                    .as_bool()
                    .unwrap_or(true),
                "Workspaces are disabled by configuration."
            );
        }
        Ok(())
    }
}
