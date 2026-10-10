//! Source catalog reads stay inside the caller's database snapshot.
use super::{ProjectsModule, persistence};
use crate::product::runtime::Context;
use anyhow::{Result, ensure};
use serde_json::{Value, json};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

impl ProjectsModule {
    pub fn list_catalog_page(&self, ctx: &Context<'_>, query: &Value) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        ensure!(
            self.schemas.valid("ownerProjectPageQuery", query)?,
            "The project page query is invalid."
        );
        let limit = query["limit"].as_i64().unwrap_or(50);
        let offset = query["cursor"].as_str().unwrap_or("0").parse::<i64>()?;
        ensure!(
            offset <= MAX_SAFE_INTEGER,
            "The project cursor exceeds its bound."
        );
        let (projects, more) =
            persistence::query_catalog_page(ctx, &self.schemas, query, limit, offset)?;
        let mut page = json!({"projects": projects});
        if more {
            page["nextCursor"] = json!((offset + limit).to_string());
        }
        ensure!(
            self.schemas.valid("ownerProjectPage", &page)?,
            "The stored project page is invalid."
        );
        Ok(page)
    }

    pub fn list_agents(&self, ctx: &Context<'_>, project: &str) -> Result<Vec<Value>> {
        self.runtime.assert_context(ctx)?;
        ensure!(
            self.schemas.valid("ownerProjectId", &json!(project))?,
            "The project ID is invalid."
        );
        let agents = persistence::query_agent_orders(ctx, project)?;
        ensure!(
            self.schemas
                .valid("ownerProjectAgentOrders", &json!(agents))?,
            "The stored project agent order is invalid."
        );
        Ok(agents)
    }

    pub fn find_by_path(
        &self,
        ctx: &Context<'_>,
        path: &str,
        runner: Option<&str>,
    ) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        ensure!(
            self.schemas
                .valid("ownerProjectRepositoryRef", &json!(path))?,
            "The project path is invalid."
        );
        if let Some(runner) = runner {
            ensure!(
                self.schemas.valid("ownerProjectRunnerId", &json!(runner))?,
                "The project runner ID is invalid."
            );
        }
        persistence::query_by_path(ctx, &self.schemas, path, runner)
    }

    /// A cached runner home remains usable in the catalog while its machine is away.
    pub fn compute(&self, ctx: &Context<'_>, project: &Value) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        persistence::validate(&self.schemas, project)?;
        let owners = self.owners()?;
        let compute = if project["kind"] == "home" && owners.runners.enabled() {
            if let Some(runner) = owners.runners.default_runner_id() {
                let machine = owners.runners.known_machine(ctx, &runner)?;
                json!({"type":"runner", "runnerId":runner, "path":machine.as_ref().and_then(|machine| machine["home"].as_str())})
            } else {
                stored_compute(project)
            }
        } else {
            stored_compute(project)
        };
        ensure!(
            self.schemas.valid("ownerCatalogCompute", &compute)?,
            "The project compute metadata is invalid."
        );
        Ok(compute)
    }
}

fn stored_compute(project: &Value) -> Value {
    match project["runnerId"].as_str() {
        Some(runner) => {
            json!({"type":"runner", "runnerId":runner, "path":project["repositoryRef"]})
        }
        None => json!({"type":"host", "path":project["repositoryRef"]}),
    }
}
