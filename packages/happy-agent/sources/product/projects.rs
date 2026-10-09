use super::{
    identity::{now, resource_version},
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::Result;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::sync::Arc;

pub struct ProjectsModule {
    runtime: Arc<RuntimeModule>,
    schemas: Schemas,
}
impl ProjectsModule {
    pub fn new(runtime: Arc<RuntimeModule>) -> Result<Self> {
        Ok(Self {
            runtime,
            schemas: Schemas::new()?,
        })
    }
    pub fn root_workspace(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        let exists:bool=ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='happy_agent_module_projects')",[],|row|row.get(0))?;
        if !exists {
            return Ok(None);
        }
        let value=ctx.database().query_row("SELECT id,repository_ref,status,runner_id,updated_at,version FROM happy_agent_module_projects WHERE id=?1",[id],|row|Ok(json!({"id":row.get::<_,String>(0)?,"root":row.get::<_,String>(1)?,"status":row.get::<_,String>(2)?,"runnerId":row.get::<_,String>(3)?,"updatedAt":row.get::<_,i64>(4)?,"version":row.get::<_,i64>(5)?}))).optional()?;
        if let Some(value) = &value {
            anyhow::ensure!(
                self.schemas.valid("projectScope", value)?,
                "The stored project workspace is invalid."
            );
        }
        Ok(value)
    }
    pub fn attach_agent(&self, ctx: &Context<'_>, project: &str, agent: &str) -> Result<Value> {
        let before = self
            .root_workspace(ctx, project)?
            .ok_or_else(|| anyhow::anyhow!("The project workspace does not exist."))?;
        anyhow::ensure!(
            before["status"] == "active",
            "The project workspace is not active."
        );
        let last: Option<String> = ctx.database().query_row(
            "SELECT max(order_key) FROM happy_agent_module_project_root_agents WHERE project_id=?1",
            [project],
            |row| row.get(0),
        )?;
        let mut prefix = String::new();
        let key = loop {
            let digit = last
                .as_deref()
                .unwrap_or("")
                .as_bytes()
                .get(prefix.len())
                .copied()
                .unwrap_or(b'0');
            if digit < b'9' {
                prefix.push(char::from(digit + (b'9' + 1 - digit) / 2));
                break prefix;
            }
            prefix.push('9');
            anyhow::ensure!(
                prefix.len() < 128,
                "Project agent order key space is exhausted."
            );
        };
        anyhow::ensure!(
            self.schemas.valid("projectOrderKey", &json!(key))?,
            "The agent order key is invalid."
        );
        let updated = i64::try_from(now())?;
        ctx.database().execute("INSERT INTO happy_agent_module_project_root_agents(project_id,agent_id,order_key) VALUES(?1,?2,?3)",params![project,agent,key])?;
        ctx.database().execute("UPDATE happy_agent_module_projects SET version=version+1,updated_at=?2 WHERE id=?1 AND version=?3",params![project,updated,before["version"].as_i64()])?;
        let mut statement=ctx.database().prepare("SELECT agent_id FROM happy_agent_module_project_root_agents WHERE project_id=?1 ORDER BY order_key,agent_id LIMIT 10001")?;
        let ids = statement
            .query_map([project], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        anyhow::ensure!(
            ids.len() <= 10000,
            "The project's root-agent series exceeds its snapshot bound."
        );
        Ok(
            json!({"projectId":project,"agentIds":ids,"previousVersion":resource_version(before["updatedAt"].as_u64().unwrap_or(0),before["version"].as_u64().unwrap_or(1),project),"version":resource_version(updated as u64,before["version"].as_u64().unwrap_or(1)+1,project),"updatedAt":updated}),
        )
    }
    pub fn agent_association(
        &self,
        ctx: &Context<'_>,
        agent: &str,
    ) -> Result<Option<(String, String)>> {
        self.runtime.assert_context(ctx)?;
        let exists:bool=ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='happy_agent_module_project_root_agents')",[],|row|row.get(0))?;
        if !exists {
            return Ok(None);
        }
        Ok(ctx.database().query_row("SELECT project_id,order_key FROM happy_agent_module_project_root_agents WHERE agent_id=?1",[agent],|row|Ok((row.get(0)?,row.get(1)?))).optional()?)
    }
}
