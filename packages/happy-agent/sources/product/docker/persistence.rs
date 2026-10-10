//! Docker ownership intent composes with its caller's Runtime transaction.
use super::*;
use crate::product::runtime::Context;
pub(super) fn query_record(ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
    let record = ctx.value("", &format!("module.docker.environment.{id}"))?;
    if let Some(record) = &record {
        ensure!(
            crate::product::schemas::Schemas::new()?.valid("dockerEnvironmentRecord", record)?,
            "The stored Docker environment ownership is invalid."
        );
    }
    Ok(record)
}
pub(super) fn put_record(ctx: &Context<'_>, id: &str, record: &Value) -> Result<()> {
    ensure!(
        crate::product::schemas::Schemas::new()?.valid("dockerEnvironmentRecord", record)?,
        "The Docker environment ownership is invalid."
    );
    ctx.put_value("", &format!("module.docker.environment.{id}"), record)
}
pub(super) fn delete_record(ctx: &Context<'_>, id: &str) -> Result<()> {
    ctx.database().execute(
        "DELETE FROM happy_agent_values WHERE owner_id='' AND key=?1",
        [format!("module.docker.environment.{id}")],
    )?;
    Ok(())
}
pub(super) fn records(ctx: &Context<'_>) -> Result<Vec<(String, Value)>> {
    let mut statement=ctx.database().prepare("SELECT key,value_json FROM happy_agent_values WHERE owner_id='' AND key LIKE 'module.docker.environment.%' ORDER BY key LIMIT 513")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ensure!(
        rows.len() <= 512,
        "The bounded persisted Docker compute catalog is full."
    );
    rows.into_iter()
        .map(|(key, encoded)| {
            let record: Value = serde_json::from_str(&encoded)?;
            ensure!(
                crate::product::schemas::Schemas::new()?
                    .valid("dockerEnvironmentRecord", &record)?,
                "The stored Docker environment ownership is invalid."
            );
            Ok((key["module.docker.environment.".len()..].to_owned(), record))
        })
        .collect()
}
