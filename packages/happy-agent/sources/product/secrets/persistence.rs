//! Original catalog storage. SQL failures never disclose value-bearing binds.
mod catalog;
mod grants;
mod migrations;
mod resolution;
use super::*;
pub(super) use catalog::*;
pub(super) use grants::*;
pub(super) use resolution::*;
use rusqlite::OptionalExtension;

pub(super) async fn migrate(runtime: &Arc<RuntimeModule>) -> Result<()> {
    runtime
        .migrate_native("secrets", migrations::MIGRATIONS)
        .await
}
fn storage_error() -> anyhow::Error {
    anyhow::anyhow!("The secret catalog could not be read or updated.")
}
pub(super) fn row(
    ctx: &Context<'_>,
    owner: &str,
    id: &str,
    schemas: &Schemas,
) -> Result<Option<Value>> {
    let row=ctx.database().query_row("SELECT owner_agent_id,id,description,environment_json,revision,available_to_model,kind,public_version,created_at,updated_at FROM happy_agent_secrets WHERE owner_agent_id=?1 AND id=?2",rusqlite::params![owner,id],|row|Ok(json!({"owner_agent_id":row.get::<_,String>(0)?,"id":row.get::<_,String>(1)?,"description":row.get::<_,String>(2)?,"environment_json":row.get::<_,String>(3)?,"revision":row.get::<_,String>(4)?,"available_to_model":row.get::<_,Option<i64>>(5)?,"kind":row.get::<_,Option<String>>(6)?,"public_version":row.get::<_,Option<String>>(7)?,"created_at":row.get::<_,Option<u64>>(8)?,"updated_at":row.get::<_,Option<u64>>(9)?}))).optional().map_err(|_|storage_error())?;
    if let Some(row) = &row {
        ensure!(
            schemas.valid("secretStoredRow", row)?,
            "The stored secret metadata is invalid."
        );
    }
    Ok(row)
}
fn environment(row: &Value, schemas: &Schemas, nonempty: bool) -> Result<Value> {
    let value: Value = serde_json::from_str(
        row["environment_json"]
            .as_str()
            .expect("validated stored environment"),
    )
    .map_err(|_| anyhow::anyhow!("The stored secret environment is invalid."))?;
    validate_environment(schemas, &value, nonempty)?;
    Ok(value)
}
fn public(row: &Value, schemas: &Schemas) -> Result<Option<Value>> {
    if row["public_version"].is_null()
        || row["created_at"].is_null()
        || row["updated_at"].is_null()
        || !schemas.valid("secretId", &row["id"])?
    {
        return Ok(None);
    }
    let environment = environment(row, schemas, true)?;
    let value = json!({"id":row["id"],"description":row["description"],"environmentVariables":names(&environment),"managed":!row["kind"].is_null(),"availableToAgents":row["available_to_model"]!=0&&row["available_to_model"]!="0","version":row["public_version"],"createdAt":row["created_at"],"updatedAt":row["updated_at"]});
    ensure!(
        schemas.valid("secretRecord", &value)?,
        "The stored secret catalog metadata is invalid."
    );
    Ok(Some(value))
}
fn revision(row: &Value) -> String {
    let value = row["revision"].as_str().expect("validated revision");
    let numeric = trim_text(value);
    let number = if numeric.is_empty() {
        Some(0.0)
    } else if numeric.starts_with("0x") || numeric.starts_with("0X") {
        u64::from_str_radix(&numeric[2..], 16)
            .ok()
            .map(|v| v as f64)
    } else if numeric.starts_with("0b") || numeric.starts_with("0B") {
        u64::from_str_radix(&numeric[2..], 2).ok().map(|v| v as f64)
    } else if numeric.starts_with("0o") || numeric.starts_with("0O") {
        u64::from_str_radix(&numeric[2..], 8).ok().map(|v| v as f64)
    } else {
        numeric.parse::<f64>().ok()
    };
    match number {
        Some(number)
            if number.is_finite()
                && number.fract() == 0.0
                && number >= 0.0
                && number <= 9_007_199_254_740_991.0 =>
        {
            format!("{:.0}", number + 1.0)
        }
        _ => format!("{value}:next"),
    }
}
fn version(previous: Option<&str>) -> Result<String> {
    ensure!(
        now() <= 0xffffffffffff,
        "The system clock is outside the UUIDv7 timestamp range."
    );
    let mut versions = Versions::new();
    if let Some(previous) = previous {
        ensure!(
            previous != "ffffffff-ffff-7fff-bfff-ffffffffffff",
            "The system clock is outside the UUIDv7 timestamp range."
        );
        versions.observe(uuid::Uuid::parse_str(previous)?);
    }
    Ok(versions.next())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_secret_version_at_uuidv7_timestamp_exhaustion_is_rejected() {
        let error = version(Some("ffffffff-ffff-7fff-bfff-ffffffffffff")).unwrap_err();
        assert_eq!(
            error.to_string(),
            "The system clock is outside the UUIDv7 timestamp range."
        );
    }
    #[test]
    fn original_revision_rules_cover_number_inputs_and_non_numeric_revisions() {
        for (input, output) in [
            ("1", "2"),
            ("0x10", "17"),
            ("0b10", "3"),
            ("0o10", "9"),
            (" ", "1"),
            ("9007199254740991", "9007199254740992"),
            ("opaque", "opaque:next"),
        ] {
            assert_eq!(revision(&json!({"revision":input})), output);
        }
    }
}
