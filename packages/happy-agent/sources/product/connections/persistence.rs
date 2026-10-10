use crate::product::{identity::now, runtime::Context, schemas::Schemas};
use anyhow::{Context as _, Result, bail};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

const ORIGINAL_CREATE: &str = "CREATE TABLE happy_agent_connections_snapshot(singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),snapshot_json TEXT NOT NULL);";
pub const MIGRATIONS: &[happy_agent_base::NativeMigration] = &[
    happy_agent_base::NativeMigration { key: "001-connections-snapshot", apply: create },
    happy_agent_base::NativeMigration { key: "002-connection-order-keys", apply: order_keys },
];

/// The second shipped migration is procedural: it validates the old projection,
/// sorts IDs and advances its UUIDv7 time before committing the migration key.
fn create(ctx: &Context<'_>) -> Result<()> { ctx.database().execute_batch(ORIGINAL_CREATE)?; Ok(()) }
fn order_keys(ctx: &Context<'_>) -> Result<()> {
    let schemas = Schemas::new()?;
    if let Some(mut previous) = query_raw(ctx)? {
            anyhow::ensure!(schemas.valid("ownerConnectionPreviousSnapshot", &previous)?, "The stored remote connection roster is invalid.");
            let connections = previous["connections"].as_array_mut().context("The stored remote connection roster is invalid.")?;
            if !connections.is_empty() {
                connections.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
                for (index, connection) in connections.iter_mut().enumerate() { connection["orderKey"] = json!(format!("{:020}", index + 1)); }
                previous["version"] = json!(version(previous["version"].as_str())?);
                save(ctx, &schemas, &previous)?;
            }
    }
    Ok(())
}
fn query_raw(ctx: &Context<'_>) -> Result<Option<Value>> {
    let row: Option<String> = ctx.database().query_row("SELECT snapshot_json FROM happy_agent_connections_snapshot WHERE singleton_id=1", [], |row| row.get(0)).optional()?;
    row.map(|text| { anyhow::ensure!(text.len() <= 1024 * 1024, "The stored remote roster exceeds its restoration bound."); Ok(serde_json::from_str(&text)?) }).transpose()
}
pub fn query(ctx: &Context<'_>, schemas: &Schemas) -> Result<Option<Value>> {
    let value = query_raw(ctx)?;
    if let Some(value) = &value { anyhow::ensure!(schemas.valid("ownerConnectionSnapshot", value)?, "The stored remote connection roster is invalid."); }
    Ok(value)
}
pub fn save(ctx: &Context<'_>, schemas: &Schemas, value: &Value) -> Result<()> {
    anyhow::ensure!(schemas.valid("ownerConnectionSnapshot", value)?, "The remote connection roster is invalid.");
    ctx.database().execute("INSERT INTO happy_agent_connections_snapshot(singleton_id,snapshot_json) VALUES(1,?1) ON CONFLICT(singleton_id) DO UPDATE SET snapshot_json=excluded.snapshot_json", [value.to_string()])?;
    Ok(())
}
pub fn version(previous: Option<&str>) -> Result<String> {
    let prior = previous.map(|version| u64::from_str_radix(&version.replace('-', "")[..12], 16)).transpose()?.map_or(0, |time| time + 1);
    let time = now().max(prior);
    anyhow::ensure!(time <= 0xffffffffffff, "The remote roster version clock is exhausted.");
    let timestamp = format!("{time:012x}"); let random = uuid::Uuid::new_v4().to_string();
    Ok(format!("{}-{}-7{}", &timestamp[..8], &timestamp[8..], &random[15..]))
}
pub fn between(before: Option<&str>, after: Option<&str>) -> Result<String> {
    let lower = before.unwrap_or("");
    if after.is_some_and(|after| lower >= after) { bail!("Connection order keys are out of order."); }
    let lower = lower.as_bytes(); let upper = after.map(str::as_bytes);
    let mut prefix = String::new();
    for index in 0.. { let low = lower.get(index).map_or(0, |digit| digit - b'0'); let high = upper.and_then(|upper| upper.get(index)).map_or(10, |digit| digit - b'0');
        if high > low + 1 { prefix.push(char::from(b'0' + low + (high - low) / 2)); return Ok(prefix); }
        if high == low + 1 { prefix.push(char::from(b'0' + low)); let rest = lower.get(index + 1..).unwrap_or_default(); for position in 0.. { let digit = rest.get(position).map_or(0, |digit| digit - b'0'); if digit < 9 { prefix.push(char::from(b'0' + digit + (10 - digit) / 2)); return Ok(prefix); } prefix.push('9'); } }
        prefix.push(char::from(b'0' + low));
    }
    unreachable!()
}