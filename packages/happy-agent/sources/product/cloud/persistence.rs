//! Original owner-only Cloud state and immutable migration sequence.
use crate::product::{
    identity::{Versions, now},
    runtime::Context,
    schemas::Schemas,
};
use anyhow::{Result, ensure};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

pub(super) const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-cloud-state",
        "CREATE TABLE IF NOT EXISTS happy_agent_cloud_state(singleton_id INTEGER PRIMARY KEY,state_json TEXT NOT NULL);",
    ),
    (
        "002-cloud-social-state",
        "CREATE TABLE IF NOT EXISTS happy_agent_cloud_social_state(singleton_id INTEGER PRIMARY KEY,state_json TEXT NOT NULL);",
    ),
    (
        "003-cloud-keys",
        "CREATE TABLE IF NOT EXISTS happy_agent_cloud_keys(environment TEXT NOT NULL,user_id TEXT NOT NULL,state_json TEXT NOT NULL,PRIMARY KEY(environment,user_id));UPDATE happy_agent_cloud_state SET state_json=json_set(state_json,'$.session.keys',json('{\"status\":\"restore_required\"}')) WHERE json_type(state_json,'$.session')='object' AND json_type(state_json,'$.session.keys') IS NULL;",
    ),
    (
        "004-cloud-murmur-store",
        "CREATE TABLE IF NOT EXISTS happy_agent_cloud_murmur_store(environment TEXT NOT NULL,user_id TEXT NOT NULL,store_key TEXT NOT NULL COLLATE BINARY,value_bytes BLOB NOT NULL,PRIMARY KEY(environment,user_id,store_key));",
    ),
    (
        "005-cloud-enrollment",
        "UPDATE happy_agent_cloud_state SET state_json=CASE WHEN json_type(state_json,'$.session.enrollment')='object' AND json_type(state_json,'$.session.enrollment.status') IS NULL THEN json_set(state_json,'$.session.enrollment.status','enrolled') ELSE json_set(state_json,'$.session.enrollment',json('{\"status\":\"checking\"}')) END WHERE json_type(state_json,'$.session')='object' AND(json_type(state_json,'$.session.enrollment') IS NULL OR json_type(state_json,'$.session.enrollment')='null' OR(json_type(state_json,'$.session.enrollment')='object' AND json_type(state_json,'$.session.enrollment.status') IS NULL));",
    ),
    (
        "006-cloud-disconnect",
        "CREATE TABLE IF NOT EXISTS happy_agent_cloud_disconnect(singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),environment TEXT NOT NULL,user_id TEXT NOT NULL,generation TEXT NOT NULL);",
    ),
    (
        "007-cloud-disconnect-refresh-token",
        "ALTER TABLE happy_agent_cloud_disconnect ADD COLUMN refresh_token TEXT;",
    ),
    (
        "008-cloud-workos-only",
        "DROP TABLE IF EXISTS happy_agent_cloud_social_state;DROP TABLE IF EXISTS happy_agent_cloud_keys;DROP TABLE IF EXISTS happy_agent_cloud_murmur_store;DROP TABLE IF EXISTS happy_agent_cloud_disconnect;UPDATE happy_agent_cloud_state SET state_json=json_remove(state_json,'$.session.enrollment','$.session.keys','$.session.keysReconciliationCallId') WHERE json_type(state_json,'$.session')='object';",
    ),
];

pub(super) fn read(ctx: &Context<'_>, schemas: &Schemas) -> Result<Option<Value>> {
    let encoded: Option<String> = ctx
        .database()
        .query_row(
            "SELECT state_json FROM happy_agent_cloud_state WHERE singleton_id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| anyhow::anyhow!("The Cloud authentication state could not be read."))?;
    encoded
        .map(|encoded| {
            ensure!(
                !encoded.is_empty() && encoded.encode_utf16().count() <= 65536,
                "The Cloud state table contains a row Happy Agent cannot read."
            );
            let state: Value = serde_json::from_str(&encoded).map_err(|_| {
                anyhow::anyhow!("Happy Agent could not read the stored Cloud authentication state.")
            })?;
            ensure!(
                schemas.valid("cloudStoredState", &state)?,
                "The stored Cloud authentication state is invalid."
            );
            Ok(state)
        })
        .transpose()
}
pub(super) fn replace(ctx: &Context<'_>, schemas: &Schemas, value: &Value) -> Result<Value> {
    ensure!(
        schemas.valid("cloudStoredValue", value)?,
        "The Cloud authentication state is invalid."
    );
    let current = read(ctx, schemas)?;
    let mut versions = Versions::new();
    if let Some(previous) = current.as_ref().and_then(|state| state["version"].as_str()) {
        versions.observe(
            uuid::Uuid::parse_str(previous)
                .map_err(|_| anyhow::anyhow!("The Cloud version is invalid."))?,
        );
    }
    let timestamp = now();
    ensure!(
        timestamp <= 0xffffffffffff,
        "The system clock is outside the UUIDv7 timestamp range."
    );
    let mut state = value.clone();
    state["updatedAt"] = json!(timestamp);
    state["version"] = json!(versions.next());
    write(ctx, schemas, &state)?;
    Ok(state)
}
pub(super) fn rotate(
    ctx: &Context<'_>,
    schemas: &Schemas,
    expected: &str,
    replacement: &str,
) -> Result<Value> {
    let mut state = read(ctx, schemas)?.ok_or_else(|| {
        anyhow::anyhow!("The Cloud session changed while its token was refreshing.")
    })?;
    ensure!(
        !state["session"].is_null(),
        "The Cloud session changed while its token was refreshing."
    );
    ensure!(
        state["session"]["refreshToken"] == expected,
        "The Cloud refresh token changed while it was refreshing."
    );
    state["session"]["refreshToken"] = json!(replacement);
    write(ctx, schemas, &state)?;
    Ok(state)
}
fn write(ctx: &Context<'_>, schemas: &Schemas, state: &Value) -> Result<()> {
    ensure!(
        schemas.valid("cloudStoredState", state)?,
        "The Cloud authentication state is invalid."
    );
    ctx.database().execute("INSERT INTO happy_agent_cloud_state(singleton_id,state_json) VALUES(1,?1) ON CONFLICT(singleton_id) DO UPDATE SET state_json=excluded.state_json",[state.to_string()]).map_err(|_|anyhow::anyhow!("The Cloud authentication state could not be stored."))?;
    Ok(())
}
