//! Source catalog reads stay inside the caller's database snapshot.
use super::{ProjectsModule, persistence};
use crate::product::runtime::Context;
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};
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
        let mut projects = Vec::new();
        let mut more = false;
        if persistence::available(ctx)? {
            let sql = format!(
                "SELECT {} FROM happy_agent_module_projects \
                 WHERE (?1 IS NULL OR status=?1) \
                 AND (?1 IS NOT NULL OR ?2=1 OR status<>'archived') \
                 ORDER BY order_key,id LIMIT ?3 OFFSET ?4",
                persistence::PROJECT_COLUMNS
            );
            let mut statement = ctx.database().prepare(&sql)?;
            let mut rows = statement.query(params![
                query["status"].as_str(),
                query["includeArchived"].as_bool().unwrap_or(false),
                limit + 1,
                offset
            ])?;
            while let Some(row) = rows.next()? {
                if projects.len() == limit as usize {
                    more = true;
                    break;
                }
                let project = persistence::from_row(row)?;
                persistence::validate(&self.schemas, &project)?;
                projects.push(project);
            }
        }
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
        if !persistence::available(ctx)? {
            return Ok(Vec::new());
        }
        let agents = ctx
            .database()
            .prepare(
                "SELECT agent_id,order_key FROM happy_agent_module_project_root_agents \
             WHERE project_id=?1 ORDER BY order_key,agent_id LIMIT 10001",
            )?
            .query_map([project], |row| {
                Ok(json!({
                    "agentId": row.get::<_, String>(0)?,
                    "orderKey": row.get::<_, String>(1)?
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            agents.len() <= 10000,
            "The project's root-agent series exceeds its snapshot bound."
        );
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
        if !persistence::available(ctx)? {
            return Ok(None);
        }
        let project = ctx.database().query_row(
            &format!("SELECT {} FROM happy_agent_module_projects WHERE repository_ref=?1 AND runner_id=?2 LIMIT 1", persistence::PROJECT_COLUMNS),
            params![path, runner.unwrap_or("")],
            persistence::from_row,
        ).optional()?;
        if let Some(project) = &project {
            persistence::validate(&self.schemas, project)?;
        }
        Ok(project)
    }

    /// A cached runner home remains usable in the catalog while its machine is away.
    pub fn compute(&self, ctx: &Context<'_>, project: &Value) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        persistence::validate(&self.schemas, project)?;
        let owners = self.owners()?;
        let compute = if project["kind"] == "home" && owners.runners.enabled() {
            if let Some(runner) = owners.runners.place(None)? {
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
