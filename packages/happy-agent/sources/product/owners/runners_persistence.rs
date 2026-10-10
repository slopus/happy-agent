use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::Result;
use rusqlite::OptionalExtension;
use serde_json::Value;

pub const MIGRATIONS: &[(&str, &str)] = &[(
    "001-runners-snapshot",
    "CREATE TABLE happy_agent_runners_snapshot(singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),snapshot_json TEXT NOT NULL);",
)];

pub fn read(ctx: &Context<'_>, schemas: &Schemas) -> Result<Option<Value>> {
    let text: Option<String> = ctx
        .database()
        .query_row(
            "SELECT snapshot_json FROM happy_agent_runners_snapshot WHERE singleton_id=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    text.map(|text| {
        let value = serde_json::from_str(&text)?;
        anyhow::ensure!(
            schemas.valid("ownerRunnerSnapshot", &value)?,
            "The stored runner list is invalid."
        );
        Ok(value)
    })
    .transpose()
}
pub fn save(ctx: &Context<'_>, schemas: &Schemas, value: &Value) -> Result<()> {
    anyhow::ensure!(
        schemas.valid("ownerRunnerSnapshot", value)?,
        "The runner list is invalid."
    );
    ctx.database().execute("INSERT INTO happy_agent_runners_snapshot VALUES(1,?1) ON CONFLICT(singleton_id) DO UPDATE SET snapshot_json=excluded.snapshot_json",[value.to_string()])?;
    Ok(())
}
