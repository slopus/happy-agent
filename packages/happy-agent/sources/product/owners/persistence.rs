use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::Result;
use rusqlite::OptionalExtension;
use serde_json::Value;

pub const NODE_MIGRATIONS: &[(&str, &str)] = &[(
    "001-node-state",
    "CREATE TABLE happy_agent_node (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), state_json TEXT NOT NULL)",
)];
pub const GLOBAL_SKILLS_MIGRATIONS: &[(&str, &str)] = &[(
    "001-global-skills",
    "CREATE TABLE happy_agent_global_skills (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), state_json TEXT NOT NULL)",
)];

pub fn query_node_state(ctx: &Context<'_>, schemas: &Schemas) -> Result<Option<Value>> {
    let encoded: Option<String> = ctx
        .database()
        .query_row(
            "SELECT state_json FROM happy_agent_node WHERE singleton_id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    encoded
        .map(|encoded| {
            let state: Value = serde_json::from_str(&encoded)?;
            anyhow::ensure!(
                schemas.valid("nodeState", &state)?,
                "The stored node configuration is invalid."
            );
            Ok(state)
        })
        .transpose()
}

pub fn save_node_state(ctx: &Context<'_>, schemas: &Schemas, state: &Value) -> Result<()> {
    anyhow::ensure!(
        schemas.valid("nodeState", state)?,
        "The node configuration is invalid."
    );
    ctx.database().execute(
        "INSERT INTO happy_agent_node (singleton_id,state_json) VALUES (1,?1) ON CONFLICT(singleton_id) DO UPDATE SET state_json=excluded.state_json",
        [state.to_string()],
    )?;
    Ok(())
}

pub fn query_global_skills_state(ctx: &Context<'_>, schemas: &Schemas) -> Result<Option<Value>> {
    let encoded: Option<String> = ctx
        .database()
        .query_row(
            "SELECT state_json FROM happy_agent_global_skills WHERE singleton_id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    encoded
        .map(|encoded| {
            let state: Value = serde_json::from_str(&encoded)?;
            anyhow::ensure!(
                schemas.valid("globalSkillsState", &state)?,
                "Stored global skill state is invalid."
            );
            Ok(state)
        })
        .transpose()
}

pub fn save_global_skills_state(ctx: &Context<'_>, schemas: &Schemas, state: &Value) -> Result<()> {
    anyhow::ensure!(
        schemas.valid("globalSkillsState", state)?,
        "Global skill state is invalid."
    );
    ctx.database().execute(
        "INSERT INTO happy_agent_global_skills (singleton_id,state_json) VALUES (1,?1) ON CONFLICT(singleton_id) DO UPDATE SET state_json=excluded.state_json",
        [state.to_string()],
    )?;
    Ok(())
}

#[cfg(test)]
pub fn query_pending_calls(ctx: &Context<'_>) -> Result<Vec<Value>> {
    let mut statement = ctx.database().prepare(
        "SELECT id,operation_id,\"function\",arguments_json,lock_keys_json FROM durable_function_calls ORDER BY created_at,id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    rows.map(|row| {
        let (id,operation,function,arguments,locks) = row?;
        Ok(serde_json::json!({"id":id,"operationId":operation,"function":function,"arguments":serde_json::from_str::<Value>(&arguments)?,"lockKeys":serde_json::from_str::<Value>(&locks)?}))
    }).collect()
}
