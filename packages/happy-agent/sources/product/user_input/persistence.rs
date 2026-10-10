use super::*;
use rusqlite::{OptionalExtension, params};

pub const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-user-input",
        "CREATE TABLE IF NOT EXISTS happy_user_input_requests(id TEXT PRIMARY KEY,asking_agent_id TEXT NOT NULL,status TEXT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,request_json TEXT NOT NULL);CREATE INDEX IF NOT EXISTS happy_user_input_requests_agent ON happy_user_input_requests(asking_agent_id,created_at,id);CREATE INDEX IF NOT EXISTS happy_user_input_requests_status ON happy_user_input_requests(status,updated_at,id);CREATE TABLE IF NOT EXISTS happy_user_input_receipts(acting_agent_id TEXT NOT NULL,operation_id TEXT NOT NULL,receipt_json TEXT NOT NULL,PRIMARY KEY(acting_agent_id,operation_id));CREATE TABLE IF NOT EXISTS happy_user_input_proofs(acting_agent_id TEXT NOT NULL,operation_id TEXT NOT NULL,proof_json TEXT NOT NULL,PRIMARY KEY(acting_agent_id,operation_id));",
    ),
    (
        "002-drop-user-input-idempotency",
        "DROP TABLE IF EXISTS happy_user_input_receipts;DROP TABLE IF EXISTS happy_user_input_proofs;",
    ),
];
fn decode(schemas: &Schemas, encoded: String) -> Result<Value> {
    anyhow::ensure!(
        encoded.len() <= 2 * 1024 * 1024,
        "The user input request exceeds its storage bound."
    );
    let request = serde_json::from_str(&encoded)?;
    validation::request(schemas, &request)?;
    Ok(request)
}
pub fn read(ctx: &Context<'_>, schemas: &Schemas, id: &str) -> Result<Option<Value>> {
    let encoded = ctx
        .database()
        .query_row(
            "SELECT request_json FROM happy_user_input_requests WHERE id=?1 LIMIT 1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let request = encoded
        .map(|encoded| decode(schemas, encoded))
        .transpose()?;
    if let Some(request) = &request {
        anyhow::ensure!(
            request["id"] == id,
            "User input store returned a request with a different identity."
        );
    }
    Ok(request)
}
pub fn write(ctx: &Context<'_>, schemas: &Schemas, request: &Value) -> Result<()> {
    validation::request(schemas, request)?;
    ctx.database().execute("INSERT INTO happy_user_input_requests(id,asking_agent_id,status,created_at,updated_at,request_json) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET asking_agent_id=excluded.asking_agent_id,status=excluded.status,created_at=excluded.created_at,updated_at=excluded.updated_at,request_json=excluded.request_json",params![request["id"].as_str().unwrap(),request["askingAgentId"].as_str().unwrap(),request["status"].as_str().unwrap(),request["createdAt"].as_u64().unwrap(),request["updatedAt"].as_u64().unwrap(),request.to_string()])?;
    Ok(())
}
pub fn page(ctx: &Context<'_>, schemas: &Schemas, agent: &str, query: &Value) -> Result<Value> {
    let limit = query["limit"].as_u64().unwrap_or(50);
    let offset = validation::cursor(query["cursor"].as_str().unwrap_or("0"), "requests")?;
    let status = query["status"].as_str().unwrap_or("");
    let mut statement=ctx.database().prepare("SELECT request_json FROM happy_user_input_requests WHERE asking_agent_id=?1 AND (?2='' OR (?2='pending' AND status='pending') OR (?2='terminal' AND status<>'pending')) ORDER BY created_at,id LIMIT ?3 OFFSET ?4")?;
    let encoded = statement
        .query_map(params![agent, status, limit + 1, offset], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_next = encoded.len() > limit as usize;
    let requests = encoded
        .into_iter()
        .take(limit as usize)
        .map(|encoded| decode(schemas, encoded))
        .collect::<Result<Vec<_>>>()?;
    let mut page = json!({"requests":requests,"cursor":offset.to_string(),"limit":limit});
    if offset > 0 {
        page["previousCursor"] = json!(offset.saturating_sub(limit).to_string());
    }
    if has_next {
        page["nextCursor"] =
            json!((offset + page["requests"].as_array().unwrap().len() as u64).to_string());
    }
    Ok(page)
}
pub fn latest(ctx: &Context<'_>, schemas: &Schemas, agent: &str) -> Result<Option<u64>> {
    ctx.database().query_row("SELECT request_json FROM happy_user_input_requests WHERE asking_agent_id=?1 ORDER BY created_at DESC,id DESC LIMIT 1",[agent],|row|row.get::<_,String>(0)).optional()?.map(|encoded|decode(schemas,encoded).map(|request|request["createdAt"].as_u64().unwrap())).transpose()
}
