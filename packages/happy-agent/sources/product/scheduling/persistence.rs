use super::*;
use rusqlite::{OptionalExtension, params};
pub const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-scheduling",
        "CREATE TABLE IF NOT EXISTS happy_scheduling_waits(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,record_json TEXT NOT NULL);CREATE INDEX IF NOT EXISTS happy_scheduling_waits_agent ON happy_scheduling_waits(agent_id,id);CREATE TABLE IF NOT EXISTS happy_scheduling_schedules(id TEXT PRIMARY KEY,sender_agent_id TEXT NOT NULL,target_agent_id TEXT NOT NULL,due_at BIGINT NOT NULL,status TEXT NOT NULL,schedule_json TEXT NOT NULL);CREATE INDEX IF NOT EXISTS happy_scheduling_schedules_sender ON happy_scheduling_schedules(sender_agent_id,due_at,id);CREATE INDEX IF NOT EXISTS happy_scheduling_schedules_target ON happy_scheduling_schedules(target_agent_id,due_at,id);CREATE TABLE IF NOT EXISTS happy_scheduling_receipts(acting_agent_id TEXT NOT NULL,kind TEXT NOT NULL,operation_id TEXT NOT NULL,receipt_json TEXT NOT NULL,PRIMARY KEY(acting_agent_id,kind,operation_id));CREATE TABLE IF NOT EXISTS happy_scheduling_proofs(acting_agent_id TEXT NOT NULL,kind TEXT NOT NULL,operation_id TEXT NOT NULL,proof_json TEXT NOT NULL,PRIMARY KEY(acting_agent_id,kind,operation_id));",
    ),
    (
        "002-remove-scheduling-idempotency",
        "DROP TABLE IF EXISTS happy_scheduling_receipts;DROP TABLE IF EXISTS happy_scheduling_proofs;",
    ),
    (
        "003-remove-scheduling-operation-state",
        "DROP TABLE IF EXISTS happy_scheduling_receipts;DROP TABLE IF EXISTS happy_scheduling_proofs;",
    ),
    (
        "004-scheduling-due-index",
        "CREATE INDEX IF NOT EXISTS happy_scheduling_schedules_due ON happy_scheduling_schedules(status,due_at,id);",
    ),
];
fn decode(schemas: &Schemas, encoded: String, wait: bool) -> Result<Value> {
    anyhow::ensure!(
        encoded.len() <= 1024 * 1024,
        "The scheduling record exceeds its storage bound."
    );
    let value = serde_json::from_str(&encoded)?;
    if wait {
        validate_wait(schemas, &value)?;
    } else {
        validate_schedule(schemas, &value)?;
    }
    Ok(value)
}
pub fn read_wait(
    ctx: &Context<'_>,
    schemas: &Schemas,
    agent: &str,
    id: &str,
) -> Result<Option<Value>> {
    ctx.database()
        .query_row(
            "SELECT record_json FROM happy_scheduling_waits WHERE id=?1 AND agent_id=?2 LIMIT 1",
            params![id, agent],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|encoded| decode(schemas, encoded, true))
        .transpose()
}
pub fn write_wait(ctx: &Context<'_>, schemas: &Schemas, wait: &Value) -> Result<()> {
    validate_wait(schemas, wait)?;
    ctx.database().execute("INSERT INTO happy_scheduling_waits(id,agent_id,record_json) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id,record_json=excluded.record_json",params![wait["id"].as_str().unwrap(),wait["agentId"].as_str().unwrap(),wait.to_string()])?;
    Ok(())
}
pub fn read_schedule(ctx: &Context<'_>, schemas: &Schemas, id: &str) -> Result<Option<Value>> {
    ctx.database()
        .query_row(
            "SELECT schedule_json FROM happy_scheduling_schedules WHERE id=?1 LIMIT 1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|encoded| decode(schemas, encoded, false))
        .transpose()
}
pub fn write_schedule(ctx: &Context<'_>, schemas: &Schemas, schedule: &Value) -> Result<()> {
    validate_schedule(schemas, schedule)?;
    ctx.database().execute("INSERT INTO happy_scheduling_schedules(id,sender_agent_id,target_agent_id,due_at,status,schedule_json) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET sender_agent_id=excluded.sender_agent_id,target_agent_id=excluded.target_agent_id,due_at=excluded.due_at,status=excluded.status,schedule_json=excluded.schedule_json",params![schedule["id"].as_str().unwrap(),schedule["senderAgentId"].as_str().unwrap(),schedule["targetAgentId"].as_str().unwrap(),schedule["dueAt"].as_u64().unwrap(),schedule["status"].as_str().unwrap(),schedule.to_string()])?;
    Ok(())
}
pub fn page(ctx: &Context<'_>, schemas: &Schemas, agent: &str, query: &Value) -> Result<Value> {
    let offset = cursor(query["cursor"].as_str().unwrap_or("0"))?;
    let limit = query["limit"].as_u64().unwrap_or(50).min(50);
    let mut statement=ctx.database().prepare("SELECT schedule_json FROM happy_scheduling_schedules WHERE sender_agent_id=?1 AND (?2='' OR status=?2) AND (?3='' OR target_agent_id=?3) ORDER BY due_at,id LIMIT ?4 OFFSET ?5")?;
    let rows = statement
        .query_map(
            params![
                agent,
                query["status"].as_str().unwrap_or(""),
                query["targetAgentId"].as_str().unwrap_or(""),
                limit + 1,
                offset
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next = rows.len() > limit as usize;
    let schedules = rows
        .into_iter()
        .take(limit as usize)
        .map(|encoded| decode(schemas, encoded, false))
        .collect::<Result<Vec<_>>>()?;
    let mut page = json!({"schedules":schedules,"limit":limit});
    if offset > 0 {
        page["previousCursor"] = json!(offset.saturating_sub(limit).to_string());
    }
    if next {
        page["nextCursor"] =
            json!((offset + page["schedules"].as_array().unwrap().len() as u64).to_string());
    }
    Ok(page)
}
pub fn pending(ctx: &Context<'_>, schemas: &Schemas, after: Option<u64>) -> Result<Vec<Value>> {
    let mut statement=ctx.database().prepare("SELECT schedule_json FROM happy_scheduling_schedules WHERE status='pending' AND (?1 IS NULL OR due_at>?1) ORDER BY due_at,id LIMIT 1000")?;
    let rows = statement
        .query_map([after], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|encoded| decode(schemas, encoded, false))
        .collect()
}
pub fn cursor(text: &str) -> Result<u64> {
    anyhow::ensure!(
        !text.is_empty()
            && (text == "0"
                || (!text.starts_with('0') && text.bytes().all(|byte| byte.is_ascii_digit()))),
        "Scheduling cursor is invalid."
    );
    let value = text
        .parse::<u64>()
        .context("Scheduling cursor is too large.")?;
    anyhow::ensure!(
        value <= 9_007_199_254_740_991,
        "Scheduling cursor is too large."
    );
    Ok(value)
}
pub fn validate_wait(schemas: &Schemas, wait: &Value) -> Result<()> {
    valid(
        schemas,
        "ownerSchedulingWaitRecord",
        wait,
        "Scheduling durable wait",
    )?;
    let created = wait["createdAt"].as_u64().unwrap();
    let started = wait["startedAt"].as_u64().unwrap();
    let due = wait["dueAt"].as_u64().unwrap();
    anyhow::ensure!(
        created <= wait["updatedAt"].as_u64().unwrap() && started >= created && started <= due,
        "Scheduling durable wait has invalid timestamp ordering."
    );
    if wait["status"] != "waiting" {
        let finished = wait["finishedAt"].as_u64().unwrap();
        anyhow::ensure!(
            finished >= started
                && wait["elapsedMs"].as_u64().unwrap() == finished - started
                && (wait["status"] != "elapsed" || finished >= due),
            "Scheduling durable wait has an untruthful elapsed duration."
        );
    }
    Ok(())
}
pub fn validate_schedule(schemas: &Schemas, schedule: &Value) -> Result<()> {
    valid(
        schemas,
        "ownerSchedulingSchedule",
        schedule,
        "scheduled message",
    )?;
    let created = schedule["createdAt"].as_u64().unwrap();
    let updated = schedule["updatedAt"].as_u64().unwrap();
    let due = schedule["dueAt"].as_u64().unwrap();
    anyhow::ensure!(
        created <= updated && due >= created,
        "Scheduled message has invalid timestamp ordering."
    );
    if schedule["status"] == "delivered" {
        let delivered = schedule["deliveredAt"]
            .as_u64()
            .context("Delivered message has inconsistent delivery fields.")?;
        anyhow::ensure!(
            schedule.get("failure").is_none()
                && delivered >= created
                && delivered >= due
                && delivered <= updated,
            "Delivered message has an invalid delivery timestamp."
        );
    } else {
        anyhow::ensure!(
            schedule.get("deliveredAt").is_none(),
            "Non-delivered message has deliveredAt."
        );
    }
    if schedule["status"] == "undelivered" {
        anyhow::ensure!(
            schedule.get("failure").is_some() && updated >= due,
            "Undelivered message has invalid failure detail."
        );
    } else {
        anyhow::ensure!(
            schedule.get("failure").is_none(),
            "Only undelivered messages may include failure detail."
        );
    }
    Ok(())
}
