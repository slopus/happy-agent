//! Complete workspace pages are independent of the model's prose budget.
use super::{WorkspacesModule, persistence};
use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::{Result, ensure};
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
        let mut workspaces = persistence::query_catalog_page(ctx, &schemas, query, limit, offset)?;
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
        let agents = persistence::query_agent_orders(ctx, workspace)?;
        ensure!(
            schemas.valid("ownerWorkspaceAgentOrders", &json!(agents))?,
            "The stored workspace agent order is invalid."
        );
        Ok(agents)
    }

    pub(super) fn assert_catalog_enabled(&self) -> Result<()> {
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
