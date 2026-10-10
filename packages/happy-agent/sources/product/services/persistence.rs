//! Original Services shared AgentKV catalog. Every operation uses its caller's transaction.
use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::{Context as _, Result, ensure};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

const PREFIX: &str = "agentSystem.modules.services.";
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

fn read(ctx: &Context<'_>, schemas: &Schemas, key: &str, schema: &str) -> Result<Option<Value>> {
    let encoded: Option<String> = ctx
        .database()
        .query_row(
            "SELECT value_json FROM happy_agent_values WHERE owner_id='' AND key=?1",
            [format!("{PREFIX}{key}")],
            |row| row.get(0),
        )
        .optional()?;
    encoded
        .map(|encoded| {
            ensure!(
                encoded.len() <= 4 * 1024 * 1024,
                "Stored service state exceeds its bound."
            );
            let value: Value = serde_json::from_str(&encoded)?;
            ensure!(
                schemas.valid(schema, &value)?,
                "Stored service state is invalid."
            );
            Ok(value)
        })
        .transpose()
}
fn write(ctx: &Context<'_>, key: &str, value: &Value) -> Result<()> {
    ctx.database().execute(
        "INSERT INTO happy_agent_values(owner_id,key,value_json) VALUES('',?1,?2) ON CONFLICT(owner_id,key) DO UPDATE SET value_json=excluded.value_json",
        params![format!("{PREFIX}{key}"), value.to_string()],
    )?;
    Ok(())
}
fn identity(schemas: &Schemas, id: &str) -> Result<()> {
    ensure!(
        schemas.valid("cuid2", &json!(id))?,
        "The service or workspace identity is invalid."
    );
    Ok(())
}
fn header(ctx: &Context<'_>, schemas: &Schemas, workspace: &str) -> Result<Value> {
    identity(schemas, workspace)?;
    Ok(read(
        ctx,
        schemas,
        &format!("workspace.{workspace}.header!"),
        "serviceHeader",
    )?
    .unwrap_or_else(|| json!({"nextSequence":0,"lastCreatedAt":0,"activeIds":[],"closed":false})))
}
pub fn query(
    ctx: &Context<'_>,
    schemas: &Schemas,
    workspace: &str,
    id: &str,
) -> Result<Option<Value>> {
    identity(schemas, workspace)?;
    identity(schemas, id)?;
    let record = read(
        ctx,
        schemas,
        &format!("record.{id}!"),
        "serviceStoredRecord",
    )?;
    Ok(record.filter(|record| record["service"]["workspaceId"] == workspace))
}
pub fn owner_workspace(
    ctx: &Context<'_>,
    schemas: &Schemas,
    agent: &str,
) -> Result<Option<String>> {
    identity(schemas, agent)?;
    Ok(read(ctx, schemas, &format!("owner.{agent}!"), "cuid2")?
        .and_then(|value| value.as_str().map(str::to_owned)))
}
pub fn required(ctx: &Context<'_>, schemas: &Schemas, workspace: &str, id: &str) -> Result<Value> {
    query(ctx, schemas, workspace, id)?.context("The service record was not found.")
}
pub fn create(ctx: &Context<'_>, schemas: &Schemas, mut record: Value) -> Result<Value> {
    let workspace = record["service"]["workspaceId"]
        .as_str()
        .context("The service workspace is missing.")?
        .to_owned();
    let id = record["service"]["id"]
        .as_str()
        .context("The service identity is missing.")?
        .to_owned();
    let agent = record["service"]["agentId"]
        .as_str()
        .context("The service owner is missing.")?
        .to_owned();
    let mut state = header(ctx, schemas, &workspace)?;
    ensure!(
        state["closed"] != true,
        "This workspace is closed to new services."
    );
    let active = state["activeIds"]
        .as_array()
        .context("The service active index is invalid.")?;
    ensure!(
        active.len() < 32,
        "This workspace already has 32 active services."
    );
    ensure!(
        query(ctx, schemas, &workspace, &id)?.is_none(),
        "The service identity is already in use."
    );
    // A record belonging to another workspace still reserves its global identity.
    ensure!(
        read(
            ctx,
            schemas,
            &format!("record.{id}!"),
            "serviceStoredRecord"
        )?
        .is_none(),
        "The service identity is already in use."
    );
    if let Some(owner) = owner_workspace(ctx, schemas, &agent)? {
        ensure!(
            owner == workspace,
            "A service owner cannot be moved to another workspace."
        );
    }
    let sequence = state["nextSequence"]
        .as_u64()
        .context("The service sequence is invalid.")?;
    ensure!(sequence < MAX_SEQUENCE, "The service catalog is full.");
    let created = record["service"]["createdAt"]
        .as_u64()
        .context("The service creation time is invalid.")?
        .max(
            state["lastCreatedAt"]
                .as_u64()
                .context("The service clock is invalid.")?
                + 1,
        );
    record["sequence"] = json!(sequence);
    record["service"]["createdAt"] = json!(created);
    record["service"]["updatedAt"] = json!(created);
    ensure!(
        schemas.valid("serviceStoredRecord", &record)? && record["service"]["status"] == "starting",
        "The initial service record is invalid."
    );
    let page_key = format!("workspace.{workspace}.page.{:016}!", sequence / 256);
    let mut page = read(ctx, schemas, &page_key, "serviceIndexPage")?.unwrap_or_else(|| json!([]));
    let page_ids = page
        .as_array_mut()
        .context("The service history page is invalid.")?;
    ensure!(
        page_ids.len() == (sequence % 256) as usize,
        "The service history index is inconsistent."
    );
    page_ids.push(json!(id));
    state["activeIds"]
        .as_array_mut()
        .expect("validated header")
        .push(json!(id));
    state["nextSequence"] = json!(sequence + 1);
    state["lastCreatedAt"] = json!(created);
    write(ctx, &format!("record.{id}!"), &record)?;
    write(ctx, &format!("owner.{agent}!"), &json!(workspace))?;
    write(ctx, &page_key, &page)?;
    write(ctx, &format!("workspace.{workspace}.header!"), &state)?;
    Ok(record)
}
pub fn page(
    ctx: &Context<'_>,
    schemas: &Schemas,
    workspace: &str,
    include_stopped: bool,
    limit: usize,
    before: Option<u64>,
) -> Result<(Vec<Value>, Option<u64>)> {
    ensure!(
        (1..=288).contains(&limit),
        "The service page query is invalid."
    );
    let state = header(ctx, schemas, workspace)?;
    let mut before = before
        .unwrap_or_else(|| state["nextSequence"].as_u64().expect("validated header"))
        .min(state["nextSequence"].as_u64().expect("validated header"));
    if !include_stopped {
        let mut records = Vec::new();
        for id in state["activeIds"].as_array().expect("validated header") {
            let record = required(
                ctx,
                schemas,
                workspace,
                id.as_str().expect("validated identity"),
            )?;
            ensure!(
                !terminal(&record["service"]),
                "The active service index contains a finished execution."
            );
            if record["sequence"].as_u64().expect("validated record") < before {
                records.push(record);
            }
        }
        records.sort_by_key(|record| {
            std::cmp::Reverse(record["sequence"].as_u64().expect("validated record"))
        });
        let more = records.len() > limit;
        records.truncate(limit);
        let next = more.then(|| {
            records.last().expect("nonempty page")["sequence"]
                .as_u64()
                .expect("validated record")
        });
        return Ok((records, next));
    }
    let mut records = Vec::new();
    while before > 0 && records.len() < limit {
        let number = (before - 1) / 256;
        let index = read(
            ctx,
            schemas,
            &format!("workspace.{workspace}.page.{number:016}!"),
            "serviceIndexPage",
        )?
        .context("The service history page is missing.")?;
        while before > number * 256 && records.len() < limit {
            before -= 1;
            let id = index
                .get((before % 256) as usize)
                .and_then(Value::as_str)
                .context("The service history entry is missing.")?;
            let record = required(ctx, schemas, workspace, id)?;
            ensure!(
                record["sequence"] == before,
                "The service history order is inconsistent."
            );
            records.push(record);
        }
    }
    Ok((records, (before > 0).then_some(before)))
}
pub fn replace(
    ctx: &Context<'_>,
    schemas: &Schemas,
    service: &Value,
    previous: &str,
    confirmed_teardown: bool,
) -> Result<()> {
    let workspace = service["workspaceId"]
        .as_str()
        .context("The service workspace is missing.")?;
    let id = service["id"]
        .as_str()
        .context("The service identity is missing.")?;
    let mut record = required(ctx, schemas, workspace, id)?;
    let mut candidate = record.clone();
    candidate["service"] = service.clone();
    ensure!(
        schemas.valid("serviceStoredRecord", &candidate)?,
        "The service update is invalid."
    );
    let before = &record["service"];
    ensure!(
        before["version"] == previous,
        "The service version changed."
    );
    ensure!(
        !terminal(before),
        "A finished service cannot be changed or restarted."
    );
    for key in [
        "agentId",
        "command",
        "cwd",
        "name",
        "port",
        "tty",
        "protocol",
        "access",
        "sandbox",
        "createdAt",
    ] {
        ensure!(
            before[key] == service[key],
            "A service execution's identity and sandbox cannot change."
        );
    }
    for key in ["processId", "startedAt"] {
        ensure!(
            before[key].is_null() || before[key] == service[key],
            "A service cannot be rebound to another process or startup."
        );
    }
    ensure!(
        service["version"] != before["version"]
            && service["updatedAt"].as_u64() >= before["updatedAt"].as_u64(),
        "The service update must advance its version and timestamp."
    );
    ensure!(
        before["status"] != "stopping" || terminal(service) || service["status"] == "stopping",
        "A service cannot return to an earlier lifecycle state."
    );
    ensure!(
        before["status"] != "running" || service["status"] != "starting",
        "A service cannot return to an earlier lifecycle state."
    );
    if terminal(service) {
        ensure!(
            confirmed_teardown
                && !service["endedAt"].is_null()
                && service["endpointStatus"] == "unavailable",
            "Service termination requires confirmed sandbox cleanup."
        );
        let mut state = header(ctx, schemas, workspace)?;
        state["activeIds"]
            .as_array_mut()
            .expect("validated header")
            .retain(|value| value != id);
        write(ctx, &format!("workspace.{workspace}.header!"), &state)?;
    }
    record["service"] = service.clone();
    write(ctx, &format!("record.{id}!"), &record)
}
pub fn close_admission(
    ctx: &Context<'_>,
    schemas: &Schemas,
    workspace: &str,
) -> Result<Vec<String>> {
    let mut state = header(ctx, schemas, workspace)?;
    state["closed"] = json!(true);
    write(ctx, &format!("workspace.{workspace}.header!"), &state)?;
    Ok(state["activeIds"]
        .as_array()
        .expect("validated header")
        .iter()
        .map(|value| value.as_str().expect("validated identity").to_owned())
        .collect())
}
pub fn reopen_admission(ctx: &Context<'_>, schemas: &Schemas, workspace: &str) -> Result<()> {
    let mut state = header(ctx, schemas, workspace)?;
    if state["closed"] == true {
        state["closed"] = json!(false);
        write(ctx, &format!("workspace.{workspace}.header!"), &state)?;
    }
    Ok(())
}
pub fn terminal(service: &Value) -> bool {
    matches!(
        service["status"].as_str(),
        Some("completed" | "killed" | "failed")
    )
}
