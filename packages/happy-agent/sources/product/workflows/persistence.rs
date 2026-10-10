use super::*;
pub const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-workflows-runs",
        "CREATE TABLE IF NOT EXISTS happy_agent_module_workflow_runs(agent_id TEXT NOT NULL,id TEXT NOT NULL,workflow TEXT NOT NULL,status TEXT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,run_json TEXT NOT NULL,PRIMARY KEY(agent_id,id)); CREATE INDEX IF NOT EXISTS happy_agent_module_workflow_runs_agent_status_id ON happy_agent_module_workflow_runs(agent_id,status,id); CREATE TABLE IF NOT EXISTS happy_agent_module_workflow_logs(agent_id TEXT NOT NULL,run_id TEXT NOT NULL,position BIGINT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(agent_id,run_id,position)); CREATE TABLE IF NOT EXISTS happy_agent_module_workflow_receipts(agent_id TEXT NOT NULL,operation_id TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(agent_id,operation_id)); CREATE TABLE IF NOT EXISTS happy_agent_module_workflow_proofs(agent_id TEXT NOT NULL,operation_id TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(agent_id,operation_id));",
    ),
    (
        "002-workflows-drop-replay-evidence",
        "DROP TABLE IF EXISTS happy_agent_module_workflow_receipts; DROP TABLE IF EXISTS happy_agent_module_workflow_proofs;",
    ),
    (
        "003-workflows-execution",
        "CREATE TABLE IF NOT EXISTS happy_agent_module_workflow_checkpoints(agent_id TEXT NOT NULL,run_id TEXT NOT NULL,snapshot BLOB NOT NULL,next_call_index BIGINT NOT NULL,phase TEXT NOT NULL,PRIMARY KEY(agent_id,run_id)); CREATE TABLE IF NOT EXISTS happy_agent_module_workflow_agent_calls(agent_id TEXT NOT NULL,run_id TEXT NOT NULL,call_index BIGINT NOT NULL,collaborator_id TEXT NOT NULL,signature TEXT NOT NULL,output_json TEXT,error TEXT,PRIMARY KEY(agent_id,run_id,call_index)); CREATE UNIQUE INDEX IF NOT EXISTS happy_agent_module_workflow_agent_calls_collaborator ON happy_agent_module_workflow_agent_calls(collaborator_id); CREATE TABLE IF NOT EXISTS happy_agent_module_workflow_launches(agent_id TEXT NOT NULL,run_id TEXT NOT NULL,launch_json TEXT NOT NULL,PRIMARY KEY(agent_id,run_id));",
    ),
];
pub fn decode(schemas: &Schemas, encoded: &str, schema: &str, maximum: usize) -> Result<Value> {
    anyhow::ensure!(
        encoded.len() <= maximum,
        "Stored workflow data exceeds its byte bound."
    );
    let value: Value =
        serde_json::from_str(encoded).context("Stored workflow data is not valid JSON.")?;
    anyhow::ensure!(
        schemas.valid(schema, &value)?,
        "Stored workflow data has an invalid shape."
    );
    Ok(value)
}
pub fn validate_run(schemas: &Schemas, run: &Value) -> Result<()> {
    anyhow::ensure!(
        schemas.valid("ownerWorkflowRun", run)?,
        "A stored workflow run is not a valid run."
    );
    let created = run["createdAt"].as_u64().unwrap();
    let updated = run["updatedAt"].as_u64().unwrap();
    let started = run["startedAt"].as_u64().unwrap();
    anyhow::ensure!(
        updated >= created,
        "A stored workflow run was updated before it was created."
    );
    anyhow::ensure!(
        (created..=updated).contains(&started),
        "A stored workflow run started outside its own lifetime."
    );
    if run["status"] == "paused" {
        anyhow::ensure!(
            run["pausedAt"] == run["updatedAt"],
            "A stored paused workflow run did not pause when it was last updated."
        );
    }
    if format::terminal(run) {
        anyhow::ensure!(
            run["finishedAt"] == run["updatedAt"],
            "A stored finished workflow run did not finish when it was last updated."
        );
    }
    Ok(())
}
pub fn read_run(
    ctx: &Context<'_>,
    schemas: &Schemas,
    agent: &str,
    id: &str,
) -> Result<Option<Value>> {
    let encoded=ctx.database().query_row("SELECT run_json FROM happy_agent_module_workflow_runs WHERE agent_id=?1 AND id=?2 LIMIT 1",rusqlite::params![agent,id],|row|row.get::<_,String>(0)).optional()?;
    encoded
        .map(|encoded| {
            let value = decode(schemas, &encoded, "ownerWorkflowRun", 16 * 1024 * 1024)?;
            validate_run(schemas, &value)?;
            Ok(value)
        })
        .transpose()
}
pub fn write_run(ctx: &Context<'_>, schemas: &Schemas, run: &Value) -> Result<()> {
    validate_run(schemas, run)?;
    ctx.database().execute("INSERT INTO happy_agent_module_workflow_runs(agent_id,id,workflow,status,created_at,updated_at,run_json) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(agent_id,id) DO UPDATE SET workflow=excluded.workflow,status=excluded.status,created_at=excluded.created_at,updated_at=excluded.updated_at,run_json=excluded.run_json",rusqlite::params![run["agentId"].as_str().unwrap(),run["id"].as_str().unwrap(),run["workflow"].as_str().unwrap(),run["status"].as_str().unwrap(),run["createdAt"].as_u64().unwrap(),run["updatedAt"].as_u64().unwrap(),run.to_string()])?;
    Ok(())
}
pub fn read_request(
    ctx: &Context<'_>,
    schemas: &Schemas,
    agent: &str,
    id: &str,
) -> Result<Option<Value>> {
    let encoded=ctx.database().query_row("SELECT launch_json FROM happy_agent_module_workflow_launches WHERE agent_id=?1 AND run_id=?2 LIMIT 1",rusqlite::params![agent,id],|row|row.get::<_,String>(0)).optional()?;
    encoded
        .map(|encoded| decode(schemas, &encoded, "ownerWorkflowRequest", 4 * 1024 * 1024))
        .transpose()
}
pub fn write_request(
    ctx: &Context<'_>,
    schemas: &Schemas,
    agent: &str,
    request: &Value,
) -> Result<()> {
    anyhow::ensure!(
        schemas.valid("ownerWorkflowRequest", request)?,
        "The workflow launch request is invalid."
    );
    ctx.database().execute("INSERT INTO happy_agent_module_workflow_launches(agent_id,run_id,launch_json) VALUES(?1,?2,?3) ON CONFLICT(agent_id,run_id) DO UPDATE SET launch_json=excluded.launch_json",rusqlite::params![agent,request["id"].as_str().unwrap(),request.to_string()])?;
    Ok(())
}
pub struct Checkpoint {
    pub snapshot: Vec<u8>,
    pub next_call_index: u64,
    pub phase: String,
}
pub fn read_checkpoint(
    ctx: &Context<'_>,
    schemas: &Schemas,
    agent: &str,
    id: &str,
) -> Result<Option<Checkpoint>> {
    let row=ctx.database().query_row("SELECT length(snapshot),snapshot,next_call_index,phase FROM happy_agent_module_workflow_checkpoints WHERE agent_id=?1 AND run_id=?2 LIMIT 1",rusqlite::params![agent,id],|row|{let length=row.get::<_,u64>(0)?;if length>256*1024*1024{return Err(rusqlite::Error::InvalidQuery);}Ok(Checkpoint{snapshot:row.get(1)?,next_call_index:row.get(2)?,phase:row.get(3)?})}).optional()?;
    if let Some(checkpoint) = &row {
        anyhow::ensure!(
            schemas.valid(
                "ownerWorkflowCheckpoint",
                &json!({"nextAgentCallIndex":checkpoint.next_call_index,"phase":checkpoint.phase})
            )?,
            "The stored workflow checkpoint metadata is invalid."
        );
        anyhow::ensure!(
            checkpoint.phase.len() <= 32 * 1024 * 1024,
            "The workflow checkpoint phase exceeds its interpreter memory budget."
        );
    }
    Ok(row)
}
pub fn write_checkpoint(
    ctx: &Context<'_>,
    schemas: &Schemas,
    agent: &str,
    id: &str,
    checkpoint: &Checkpoint,
) -> Result<()> {
    anyhow::ensure!(
        checkpoint.snapshot.len() <= 256 * 1024 * 1024
            && checkpoint.phase.len() <= 32 * 1024 * 1024
            && schemas.valid(
                "ownerWorkflowCheckpoint",
                &json!({"nextAgentCallIndex":checkpoint.next_call_index,"phase":checkpoint.phase})
            )?,
        "The workflow checkpoint exceeds its bounds."
    );
    ctx.database().execute("INSERT INTO happy_agent_module_workflow_checkpoints(agent_id,run_id,snapshot,next_call_index,phase) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(agent_id,run_id) DO UPDATE SET snapshot=excluded.snapshot,next_call_index=excluded.next_call_index,phase=excluded.phase",rusqlite::params![agent,id,checkpoint.snapshot,checkpoint.next_call_index,checkpoint.phase])?;
    Ok(())
}
pub fn read_call(
    ctx: &Context<'_>,
    schemas: &Schemas,
    agent: &str,
    id: &str,
    index: u64,
) -> Result<Option<Value>> {
    let row=ctx.database().query_row("SELECT collaborator_id,signature,output_json,error FROM happy_agent_module_workflow_agent_calls WHERE agent_id=?1 AND run_id=?2 AND call_index=?3 LIMIT 1",rusqlite::params![agent,id,index],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?))).optional()?;
    let Some((collaborator, signature, output, error)) = row else {
        return Ok(None);
    };
    anyhow::ensure!(
        signature.len() <= 128 * 1024 * 1024,
        "The stored workflow call exceeds its signature bound."
    );
    let mut call =
        json!({"runId":id,"callIndex":index,"collaboratorId":collaborator,"signature":signature});
    if let Some(output) = output {
        anyhow::ensure!(
            output.len() <= 128 * 1024 * 1024,
            "The stored workflow answer exceeds its byte bound."
        );
        call["output"] = serde_json::from_str(&output)
            .context("A stored workflow agent result is not valid JSON.")?;
    }
    if let Some(error) = error {
        call["error"] = json!(error);
    }
    anyhow::ensure!(
        schemas.valid("ownerWorkflowAgentCall", &call)?,
        "The stored workflow call is invalid."
    );
    Ok(Some(call))
}
pub fn read_calls(
    ctx: &Context<'_>,
    schemas: &Schemas,
    agent: &str,
    id: &str,
) -> Result<BTreeMap<u64, Value>> {
    let mut statement=ctx.database().prepare("SELECT call_index FROM happy_agent_module_workflow_agent_calls WHERE agent_id=?1 AND run_id=?2 AND output_json IS NOT NULL ORDER BY call_index LIMIT 1001")?;
    let indices = statement
        .query_map(rusqlite::params![agent, id], |row| row.get::<_, u64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        indices.len() <= 1000,
        "The workflow call list exceeds its bounds."
    );
    let mut calls = BTreeMap::new();
    for index in indices {
        if let Ok(Some(call)) = read_call(ctx, schemas, agent, id, index) {
            calls.insert(index, call);
        }
    }
    Ok(calls)
}
pub fn write_call(
    ctx: &Context<'_>,
    agent: &str,
    id: &str,
    index: u64,
    collaborator: &str,
    signature: &str,
) -> Result<()> {
    ctx.database().execute("INSERT INTO happy_agent_module_workflow_agent_calls(agent_id,run_id,call_index,collaborator_id,signature,output_json,error) VALUES(?1,?2,?3,?4,?5,NULL,NULL) ON CONFLICT(agent_id,run_id,call_index) DO UPDATE SET collaborator_id=excluded.collaborator_id,signature=excluded.signature,output_json=NULL,error=NULL",rusqlite::params![agent,id,index,collaborator,signature])?;
    Ok(())
}
pub fn remember_call(
    ctx: &Context<'_>,
    agent: &str,
    id: &str,
    index: u64,
    signature: &str,
    output: &Value,
) -> Result<()> {
    ctx.database().execute("INSERT INTO happy_agent_module_workflow_agent_calls(agent_id,run_id,call_index,collaborator_id,signature,output_json,error) VALUES(?1,?2,?3,?4,?5,?6,NULL) ON CONFLICT(agent_id,run_id,call_index) DO UPDATE SET signature=excluded.signature,output_json=excluded.output_json,error=NULL",rusqlite::params![agent,id,index,format!("{id}:{index}"),signature,output.to_string()])?;
    Ok(())
}
pub fn unanswered(ctx: &Context<'_>, agent: &str, id: &str) -> Result<Vec<String>> {
    let mut statement=ctx.database().prepare("SELECT collaborator_id FROM happy_agent_module_workflow_agent_calls WHERE agent_id=?1 AND run_id=?2 AND output_json IS NULL AND error IS NULL ORDER BY call_index LIMIT 1001")?;
    let ids = statement
        .query_map(rusqlite::params![agent, id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        ids.len() <= 1000,
        "The workflow collaborator list exceeds its bounds."
    );
    Ok(ids)
}
fn cursor(query: &Value, total: u64, limit: u64) -> u64 {
    if query["from"] == "end" {
        total.saturating_sub(limit)
    } else {
        query["cursor"].as_u64().unwrap_or(0).min(total)
    }
}
pub fn page(ctx: &Context<'_>, schemas: &Schemas, agent: &str, query: &Value) -> Result<Value> {
    let limit = query["limit"].as_u64().unwrap_or(50).min(50);
    let terminal = query["includeTerminal"] != false;
    let total=ctx.database().query_row("SELECT count(*) FROM happy_agent_module_workflow_runs WHERE agent_id=?1 AND (?2 OR status NOT IN ('completed','failed','cancelled'))",rusqlite::params![agent,terminal],|row|row.get::<_,u64>(0))?;
    let cursor = cursor(query, total, limit);
    let mut statement=ctx.database().prepare("SELECT run_json FROM happy_agent_module_workflow_runs WHERE agent_id=?1 AND (?2 OR status NOT IN ('completed','failed','cancelled')) ORDER BY id LIMIT ?3 OFFSET ?4")?;
    let mut runs = Vec::new();
    for row in statement.query_map(rusqlite::params![agent, terminal, limit, cursor], |row| {
        row.get::<_, String>(0)
    })? {
        let run = decode(schemas, &row?, "ownerWorkflowRun", 16 * 1024 * 1024)?;
        validate_run(schemas, &run)?;
        runs.push(run);
    }
    let mut page = json!({"agentId":agent,"cursor":cursor,"runs":runs,"totalRuns":total});
    if cursor > 0 {
        page["previousCursor"] = json!(cursor.saturating_sub(limit));
    }
    let next = cursor + runs.len() as u64;
    if next < total {
        page["nextCursor"] = json!(next);
    }
    anyhow::ensure!(
        schemas.valid("ownerWorkflowPage", &page)?,
        "A workflow page was assembled in an invalid shape."
    );
    Ok(page)
}
pub fn append_log(ctx: &Context<'_>, agent: &str, id: &str, line: &str) -> Result<()> {
    let position = ctx.database().query_row(
        "SELECT count(*) FROM happy_agent_module_workflow_logs WHERE agent_id=?1 AND run_id=?2",
        rusqlite::params![agent, id],
        |row| row.get::<_, u64>(0),
    )?;
    ctx.database().execute("INSERT INTO happy_agent_module_workflow_logs(agent_id,run_id,position,text) VALUES(?1,?2,?3,?4)",rusqlite::params![agent,id,position,line])?;
    Ok(())
}
pub fn logs(
    ctx: &Context<'_>,
    schemas: &Schemas,
    agent: &str,
    id: &str,
    query: &Value,
) -> Result<Value> {
    let limit = query["limit"].as_u64().unwrap_or(200).min(200);
    let total = ctx.database().query_row(
        "SELECT count(*) FROM happy_agent_module_workflow_logs WHERE agent_id=?1 AND run_id=?2",
        rusqlite::params![agent, id],
        |row| row.get::<_, u64>(0),
    )?;
    let cursor = cursor(query, total, limit);
    let mut statement=ctx.database().prepare("SELECT position,text FROM happy_agent_module_workflow_logs WHERE agent_id=?1 AND run_id=?2 ORDER BY position LIMIT ?3 OFFSET ?4")?;
    let lines = statement
        .query_map(rusqlite::params![agent, id, limit, cursor], |row| {
            Ok(json!({"position":row.get::<_,u64>(0)?,"text":row.get::<_,String>(1)?}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next = cursor + lines.len() as u64;
    let mut page =
        json!({"agentId":agent,"id":id,"cursor":cursor,"lines":lines,"totalLines":total});
    if cursor > 0 {
        page["previousCursor"] = json!(cursor.saturating_sub(limit));
    }
    if next < total {
        page["nextCursor"] = json!(next);
    }
    anyhow::ensure!(
        schemas.valid("ownerWorkflowLogPage", &page)?,
        "A workflow log page was assembled in an invalid shape."
    );
    Ok(page)
}
