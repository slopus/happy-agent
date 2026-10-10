use super::*;
use rusqlite::{OptionalExtension, params};

pub const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-presence",
        "CREATE TABLE IF NOT EXISTS happy_agent_presence(singleton_id INTEGER PRIMARY KEY,state_json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS happy_agent_presence_schedules(id TEXT PRIMARY KEY,schedule_json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS happy_agent_presence_receipts(operation_id TEXT PRIMARY KEY,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL);",
    ),
    (
        "002-remove-presence-receipts",
        "DROP TABLE IF EXISTS happy_agent_presence_receipts;",
    ),
    (
        "003-presence-catalog",
        "CREATE TABLE IF NOT EXISTS happy_agent_presence_catalog(id TEXT PRIMARY KEY,definition_json TEXT NOT NULL);",
    ),
];

pub fn read(ctx: &Context<'_>, schemas: &Schemas) -> Result<Option<Value>> {
    let stored = ctx
        .database()
        .query_row(
            "SELECT state_json FROM happy_agent_presence WHERE singleton_id=1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let stored = stored
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    if let Some(state) = &stored {
        validate_stored(schemas, state)?;
    }
    Ok(stored)
}
pub fn write(ctx: &Context<'_>, schemas: &Schemas, state: &Value) -> Result<()> {
    validate_stored(schemas, state)?;
    ctx.database().execute("INSERT INTO happy_agent_presence(singleton_id,state_json) VALUES(1,?1) ON CONFLICT(singleton_id) DO UPDATE SET state_json=excluded.state_json",[state.to_string()])?;
    Ok(())
}
pub fn catalog(ctx: &Context<'_>, schemas: &Schemas) -> Result<Vec<Value>> {
    rows(
        ctx,
        schemas,
        "SELECT definition_json FROM happy_agent_presence_catalog ORDER BY id LIMIT 65",
        "ownerPresenceDefinition",
        64,
    )
}
pub fn schedules(ctx: &Context<'_>, schemas: &Schemas) -> Result<Vec<Value>> {
    rows(
        ctx,
        schemas,
        "SELECT schedule_json FROM happy_agent_presence_schedules ORDER BY id LIMIT 65",
        "ownerPresenceSchedule",
        64,
    )
}
fn rows(
    ctx: &Context<'_>,
    schemas: &Schemas,
    sql: &str,
    schema: &str,
    maximum: usize,
) -> Result<Vec<Value>> {
    let encoded = ctx
        .database()
        .prepare(sql)?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        encoded.len() <= maximum,
        "The presence catalog exceeds its storage bound."
    );
    let mut bytes = 0;
    encoded
        .into_iter()
        .map(|text| {
            bytes += text.len();
            anyhow::ensure!(
                bytes <= 1024 * 1024,
                "The presence catalog exceeds its byte bound."
            );
            let value = serde_json::from_str(&text)?;
            anyhow::ensure!(
                schemas.valid(schema, &value)?,
                "The stored presence record is invalid."
            );
            Ok(value)
        })
        .collect()
}
pub fn write_definition(ctx: &Context<'_>, definition: &Value) -> Result<()> {
    ctx.database().execute("INSERT INTO happy_agent_presence_catalog(id,definition_json) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET definition_json=excluded.definition_json",params![definition["id"].as_str().unwrap(),definition.to_string()])?;
    Ok(())
}
pub fn write_schedule(ctx: &Context<'_>, schedule: &Value) -> Result<()> {
    ctx.database().execute("INSERT INTO happy_agent_presence_schedules(id,schedule_json) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET schedule_json=excluded.schedule_json",params![schedule["id"].as_str().unwrap(),schedule.to_string()])?;
    Ok(())
}
pub fn validate_stored(schemas: &Schemas, state: &Value) -> Result<()> {
    anyhow::ensure!(
        schemas.valid("ownerPresenceStored", state)?,
        "Stored presence state is invalid."
    );
    if let (Some(effective), Some(expires)) =
        (state["effectiveFrom"].as_u64(), state["expiresAt"].as_u64())
    {
        anyhow::ensure!(
            expires > effective,
            "Presence expiry must be after its effective time."
        );
    }
    Ok(())
}
