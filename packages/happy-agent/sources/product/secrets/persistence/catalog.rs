use super::*;

pub(in crate::product::secrets) fn get(
    ctx: &Context<'_>,
    id: &str,
    schemas: &Schemas,
) -> Result<Option<Value>> {
    row(ctx, GLOBAL, id, schemas)?
        .map(|row| public(&row, schemas))
        .transpose()
        .map(Option::flatten)
}
pub(in crate::product::secrets) fn list(
    ctx: &Context<'_>,
    query: &Value,
    schemas: &Schemas,
) -> Result<Value> {
    let limit = query["limit"].as_u64().expect("validated limit");
    let target = query.get("target");
    let cursor = query.get("cursor").and_then(Value::as_str);
    if let Some(cursor) = cursor {
        let known:bool=ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM happy_agent_secrets WHERE owner_agent_id=?1 AND id=?2)",rusqlite::params![GLOBAL,cursor],|row|row.get(0)).map_err(|_|storage_error())?;
        if !known {
            return Err(SecretInputError("The secret page cursor is unknown.".into()).into());
        }
    }
    let mut statement=ctx.database().prepare("SELECT id FROM happy_agent_secrets AS s WHERE owner_agent_id=?1 AND public_version IS NOT NULL AND(?2 IS NULL OR EXISTS(SELECT 1 FROM happy_agent_secret_api_attachments a WHERE a.owner_agent_id=s.owner_agent_id AND a.secret_id=s.id AND a.target_type=?2 AND a.target_id=?3)) AND(?4 IS NULL OR(created_at,id)>(SELECT created_at,id FROM happy_agent_secrets AS c WHERE c.owner_agent_id=?1 AND c.id=?4)) ORDER BY created_at,id LIMIT ?5").map_err(|_|storage_error())?;
    let ids = statement
        .query_map(
            rusqlite::params![
                GLOBAL,
                target.and_then(|v| v["type"].as_str()),
                target.and_then(|v| v["id"].as_str()),
                cursor,
                limit + 1
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| storage_error())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| storage_error())?;
    drop(statement);
    let extra = ids.len() > limit as usize;
    let mut secrets = Vec::new();
    for id in ids.into_iter().take(limit as usize) {
        secrets.push(get(ctx, &id, schemas)?.context("The listed secret metadata is missing.")?);
    }
    let cursor = if extra {
        secrets
            .last()
            .map(|v| v["id"].clone())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    Ok(json!({"secrets":secrets,"nextCursor":cursor}))
}
pub(in crate::product::secrets) fn create(
    ctx: &Context<'_>,
    input: &Value,
    schemas: &Schemas,
) -> Result<Value> {
    let id = input["id"].as_str().expect("normalized id");
    if let Some(row) = row(ctx, GLOBAL, id, schemas)? {
        return Err(SecretConflictError {
            message: "That secret ID is already in use.".into(),
            current: public(&row, schemas)?,
        }
        .into());
    }
    let timestamp = now();
    let version = version(None)?;
    ctx.database().execute("INSERT INTO happy_agent_secrets(owner_agent_id,id,description,environment_json,revision,available_to_model,kind,public_version,created_at,updated_at) VALUES(?1,?2,?3,?4,'1',?5,NULL,?6,?7,?7)",rusqlite::params![GLOBAL,id,input["description"].as_str().expect("description"),serde_json::to_string(&input["environment"]).map_err(|_|storage_error())?,input["availableToAgents"].as_bool().expect("availability"),version,timestamp]).map_err(|_|storage_error())?;
    get(ctx, id, schemas)?.context("The new secret has no public catalog metadata.")
}
pub(in crate::product::secrets) fn update(
    ctx: &Context<'_>,
    id: &str,
    input: &Value,
    expected: &str,
    schemas: &Schemas,
) -> Result<Option<(Value, Value, bool)>> {
    let Some(row) = row(ctx, GLOBAL, id, schemas)? else {
        return Ok(None);
    };
    let Some(previous) = public(&row, schemas)? else {
        return Ok(None);
    };
    let conflict = |message: &str| SecretConflictError {
        message: message.into(),
        current: Some(previous.clone()),
    };
    if previous["version"] != expected {
        return Err(conflict("The secret has changed.").into());
    }
    if !row["kind"].is_null() {
        return Err(conflict("This secret is managed by another daemon feature.").into());
    }
    if input.get("availableToAgents") == Some(&Value::Bool(false)) && attached(ctx, id)? {
        return Err(
            conflict("Detach this secret everywhere before disabling agent access.").into(),
        );
    }
    let old_environment = environment(&row, schemas, true)?;
    let mut environment = old_environment.clone();
    if let Some(patch) = input.get("environment") {
        let map = environment.as_object_mut().expect("validated environment");
        for (name, value) in patch.as_object().expect("validated patch") {
            let old = map
                .keys()
                .find(|old| old.eq_ignore_ascii_case(name))
                .cloned();
            if value.is_null() {
                if let Some(old) = old {
                    map.remove(&old);
                }
            } else {
                map.insert(old.unwrap_or_else(|| name.clone()), value.clone());
            }
        }
    }
    if environment.as_object().expect("environment").is_empty() {
        return Err(conflict("A secret environment must contain at least one variable.").into());
    }
    validate_environment(schemas, &environment, true)?;
    let description = input.get("description").unwrap_or(&row["description"]);
    let available = input
        .get("availableToAgents")
        .unwrap_or(&previous["availableToAgents"]);
    if description == &row["description"]
        && available == &previous["availableToAgents"]
        && environment == old_environment
    {
        return Ok(Some((previous.clone(), previous, false)));
    }
    let updated = now().max(previous["updatedAt"].as_u64().expect("timestamp") + 1);
    ensure!(
        updated <= 9_007_199_254_740_991,
        "The secret update timestamp is invalid."
    );
    let next = version(Some(expected))?;
    let revision = if environment == old_environment {
        row["revision"].as_str().expect("revision").to_owned()
    } else {
        revision(&row)
    };
    ctx.database().execute("UPDATE happy_agent_secrets SET description=?1,environment_json=?2,revision=?3,available_to_model=?4,public_version=?5,updated_at=?6 WHERE owner_agent_id=?7 AND id=?8",rusqlite::params![description.as_str().expect("description"),serde_json::to_string(&environment).map_err(|_|storage_error())?,revision,available.as_bool().expect("availability"),next,updated,GLOBAL,id]).map_err(|_|storage_error())?;
    let current = get(ctx, id, schemas)?.context("The updated secret metadata is missing.")?;
    Ok(Some((previous, current, true)))
}
pub(in crate::product::secrets) fn retire(
    ctx: &Context<'_>,
    id: &str,
    kind: &str,
    schemas: &Schemas,
) -> Result<Option<Value>> {
    let Some(row) = row(ctx, GLOBAL, id, schemas)? else {
        return Ok(None);
    };
    let current = public(&row, schemas)?;
    if row["kind"] != kind {
        return Err(SecretConflictError {
            message: "This daemon feature does not own that managed secret.".into(),
            current,
        }
        .into());
    }
    let previous = current.context("The managed secret has no public catalog metadata.")?;
    for sql in [
        "DELETE FROM happy_agent_secret_attachments WHERE owner_agent_id=?1 AND secret_id=?2",
        "DELETE FROM happy_agent_secret_api_attachments WHERE owner_agent_id=?1 AND secret_id=?2",
        "DELETE FROM happy_agent_secrets WHERE owner_agent_id=?1 AND id=?2",
    ] {
        ctx.database()
            .execute(sql, rusqlite::params![GLOBAL, id])
            .map_err(|_| storage_error())?;
    }
    Ok(Some(previous))
}
