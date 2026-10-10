//! Lifecycle reads include message-less maintenance and reject overlapping running rows.
use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::Result;
use serde_json::{Value, json};

pub(super) fn query_running_run(
    ctx: &Context<'_>,
    schemas: &Schemas,
    agent: &str,
) -> Result<Option<Value>> {
    let mut statement = ctx.database().prepare("SELECT run_id,status,reason,started_at,ended_at FROM happy_agent_module_history_runs WHERE agent_id=?1 AND status='running' ORDER BY sequence DESC LIMIT 2")?;
    let rows = statement.query_map([agent], |row| Ok(json!({
        "id":row.get::<_,String>(0)?, "agentId":agent, "status":row.get::<_,String>(1)?,
        "reason":row.get::<_,Option<String>>(2)?, "startedAt":row.get::<_,i64>(3)?, "endedAt":row.get::<_,Option<i64>>(4)?,
    })))?.collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        rows.len() <= 1,
        "The history contains multiple running runs for one agent."
    );
    if let Some(row) = rows.into_iter().next() {
        anyhow::ensure!(
            schemas.valid("ownerHistoryRunState", &row)?,
            "The stored running-run state is invalid."
        );
        Ok(Some(row))
    } else {
        Ok(None)
    }
}
