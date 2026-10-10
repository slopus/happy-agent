use super::*;
pub(in crate::product::secrets) fn attached(ctx: &Context<'_>, id: &str) -> Result<bool> {
    ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM happy_agent_secret_attachments WHERE owner_agent_id=?1 AND secret_id=?2 UNION ALL SELECT 1 FROM happy_agent_secret_api_attachments WHERE owner_agent_id=?1 AND secret_id=?2)",rusqlite::params![GLOBAL,id],|row|row.get(0)).map_err(|_|storage_error())
}
fn attachment(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":row.get::<_,String>(0)?,"secretId":row.get::<_,String>(1)?,"target":{"type":row.get::<_,String>(2)?,"id":row.get::<_,String>(3)?},"createdAt":row.get::<_,u64>(4)?}),
    )
}
fn grant(ctx: &Context<'_>, id: &str, target: &Value, schemas: &Schemas) -> Result<Option<Value>> {
    let result=ctx.database().query_row("SELECT id,secret_id,target_type,target_id,created_at FROM happy_agent_secret_api_attachments WHERE owner_agent_id=?1 AND secret_id=?2 AND target_type=?3 AND target_id=?4",rusqlite::params![GLOBAL,id,target["type"].as_str().expect("target type"),target["id"].as_str().expect("target id")],attachment).optional().map_err(|_|storage_error())?;
    if let Some(result) = &result {
        ensure!(
            schemas.valid("secretAttachment", result)?,
            "The stored secret attachment is invalid."
        );
    }
    Ok(result)
}
pub(in crate::product::secrets) fn attach(
    ctx: &Context<'_>,
    id: &str,
    target: &Value,
    schemas: &Schemas,
) -> Result<(Value, bool)> {
    let secret = get(ctx, id, schemas)?.context("The secret reference does not exist.")?;
    if secret["availableToAgents"] != true {
        return Err(SecretConflictError {
            message: "This secret is not available to agents.".into(),
            current: Some(secret),
        }
        .into());
    }
    if let Some(existing) = grant(ctx, id, target, schemas)? {
        return Ok((existing, false));
    }
    let candidate =
        json!({"id":cuid2::create_id(),"secretId":id,"target":target,"createdAt":now()});
    ensure!(
        schemas.valid("secretAttachment", &candidate)?,
        "The new secret attachment is invalid."
    );
    ctx.database().execute("INSERT INTO happy_agent_secret_api_attachments(id,owner_agent_id,secret_id,target_type,target_id,created_at) VALUES(?1,?2,?3,?4,?5,?6)",rusqlite::params![candidate["id"].as_str().expect("id"),GLOBAL,id,target["type"].as_str().expect("type"),target["id"].as_str().expect("target"),candidate["createdAt"].as_u64().expect("timestamp")]).map_err(|_|storage_error())?;
    Ok((candidate, true))
}
pub(in crate::product::secrets) fn detach(
    ctx: &Context<'_>,
    id: &str,
    target: &Value,
    schemas: &Schemas,
) -> Result<Option<Value>> {
    let previous = grant(ctx, id, target, schemas)?;
    if previous.is_some() {
        ctx.database().execute("DELETE FROM happy_agent_secret_api_attachments WHERE owner_agent_id=?1 AND secret_id=?2 AND target_type=?3 AND target_id=?4",rusqlite::params![GLOBAL,id,target["type"].as_str().expect("type"),target["id"].as_str().expect("target")]).map_err(|_|storage_error())?;
    }
    Ok(previous)
}
pub(in crate::product::secrets) fn attachment_page(
    ctx: &Context<'_>,
    id: &str,
    query: &Value,
    schemas: &Schemas,
) -> Result<Value> {
    let limit = query["limit"].as_u64().expect("limit");
    if let Some(cursor) = query.get("cursor").and_then(Value::as_str) {
        let known:bool=ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM happy_agent_secret_api_attachments WHERE owner_agent_id=?1 AND secret_id=?2 AND id=?3)",rusqlite::params![GLOBAL,id,cursor],|row|row.get(0)).map_err(|_|storage_error())?;
        if !known {
            return Err(SecretInputError("The secret attachment cursor is unknown.".into()).into());
        }
    }
    let mut statement=ctx.database().prepare("SELECT id,secret_id,target_type,target_id,created_at FROM happy_agent_secret_api_attachments WHERE owner_agent_id=?1 AND secret_id=?2 AND(?3 IS NULL OR(created_at,id)>(SELECT created_at,id FROM happy_agent_secret_api_attachments WHERE owner_agent_id=?1 AND secret_id=?2 AND id=?3)) ORDER BY created_at,id LIMIT ?4").map_err(|_|storage_error())?;
    let mut attachments = statement
        .query_map(
            rusqlite::params![
                GLOBAL,
                id,
                query.get("cursor").and_then(Value::as_str),
                limit + 1
            ],
            attachment,
        )
        .map_err(|_| storage_error())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| storage_error())?;
    for attachment in &attachments {
        ensure!(
            schemas.valid("secretAttachment", attachment)?,
            "The stored secret attachment is invalid."
        );
    }
    let cursor = if attachments.len() > limit as usize {
        attachments.pop();
        attachments
            .last()
            .map(|v| v["id"].clone())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    Ok(json!({"attachments":attachments,"nextCursor":cursor}))
}
