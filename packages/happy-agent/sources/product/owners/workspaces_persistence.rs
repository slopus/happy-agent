//! Workspace rows, ancestry and attachments belong to this catalog alone.
use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::Result;
use rusqlite::{OptionalExtension, Row, params};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;

pub const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-workspaces-catalog",
        "CREATE TABLE IF NOT EXISTS happy_agent_module_workspaces(id TEXT PRIMARY KEY,owner_agent_id TEXT NOT NULL,project_ref TEXT NOT NULL,base_ref TEXT,name TEXT NOT NULL,status TEXT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,archived_at BIGINT);CREATE INDEX IF NOT EXISTS happy_agent_module_workspaces_project_id ON happy_agent_module_workspaces(project_ref,id);CREATE TABLE IF NOT EXISTS happy_agent_module_workspace_operation_receipts(agent_id TEXT NOT NULL,operation_id TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(agent_id,operation_id));CREATE TABLE IF NOT EXISTS happy_agent_module_workspace_mutation_proofs(agent_id TEXT NOT NULL,operation_id TEXT NOT NULL,proof_json TEXT NOT NULL,PRIMARY KEY(agent_id,operation_id));",
    ),
    (
        "002-drop-workspace-replay-state",
        "DROP TABLE IF EXISTS happy_agent_module_workspace_operation_receipts;DROP TABLE IF EXISTS happy_agent_module_workspace_mutation_proofs;",
    ),
    (
        "003-workspace-path",
        "ALTER TABLE happy_agent_module_workspaces ADD COLUMN path TEXT;",
    ),
    (
        "004-workspace-git-record",
        "DROP TABLE IF EXISTS happy_agent_module_workspaces;CREATE TABLE happy_agent_module_workspaces(id TEXT PRIMARY KEY,owner_agent_id TEXT NOT NULL,project_ref TEXT NOT NULL,name TEXT NOT NULL,name_key TEXT NOT NULL,name_configured INTEGER NOT NULL,branch TEXT NOT NULL,storage_key TEXT NOT NULL,kind TEXT NOT NULL,path TEXT NOT NULL,base_ref TEXT,base_commit TEXT,git_common_dir TEXT,presence TEXT NOT NULL,status TEXT NOT NULL,order_key TEXT NOT NULL,version INTEGER NOT NULL,creator_session_id TEXT,git_ahead INTEGER NOT NULL,git_behind INTEGER NOT NULL,git_detached INTEGER NOT NULL,git_head TEXT,git_upstream TEXT,initialization_attempt INTEGER NOT NULL,initialization_error TEXT,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,archived_at BIGINT);CREATE INDEX IF NOT EXISTS happy_agent_module_workspaces_order ON happy_agent_module_workspaces(project_ref,order_key,id);CREATE UNIQUE INDEX IF NOT EXISTS happy_agent_module_workspaces_path ON happy_agent_module_workspaces(path);CREATE UNIQUE INDEX IF NOT EXISTS happy_agent_module_workspaces_branch ON happy_agent_module_workspaces(project_ref,branch);CREATE UNIQUE INDEX IF NOT EXISTS happy_agent_module_workspaces_storage_key ON happy_agent_module_workspaces(project_ref,storage_key);CREATE UNIQUE INDEX IF NOT EXISTS happy_agent_module_workspaces_name_key ON happy_agent_module_workspaces(project_ref,name_key);",
    ),
    (
        "005-workspace-without-owner",
        "DROP TABLE IF EXISTS happy_agent_module_workspaces;CREATE TABLE happy_agent_module_workspaces(id TEXT PRIMARY KEY,project_ref TEXT NOT NULL,name TEXT NOT NULL,name_key TEXT NOT NULL,name_configured INTEGER NOT NULL,branch TEXT NOT NULL,storage_key TEXT NOT NULL,kind TEXT NOT NULL,path TEXT NOT NULL,base_ref TEXT,base_commit TEXT,git_common_dir TEXT,presence TEXT NOT NULL,status TEXT NOT NULL,order_key TEXT NOT NULL,version INTEGER NOT NULL,creator_session_id TEXT,git_ahead INTEGER NOT NULL,git_behind INTEGER NOT NULL,git_detached INTEGER NOT NULL,git_head TEXT,git_upstream TEXT,initialization_attempt INTEGER NOT NULL,initialization_error TEXT,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,archived_at BIGINT);CREATE INDEX IF NOT EXISTS happy_agent_module_workspaces_order ON happy_agent_module_workspaces(project_ref,order_key,id);CREATE UNIQUE INDEX IF NOT EXISTS happy_agent_module_workspaces_path ON happy_agent_module_workspaces(path);CREATE UNIQUE INDEX IF NOT EXISTS happy_agent_module_workspaces_branch ON happy_agent_module_workspaces(project_ref,branch);CREATE UNIQUE INDEX IF NOT EXISTS happy_agent_module_workspaces_storage_key ON happy_agent_module_workspaces(project_ref,storage_key);CREATE UNIQUE INDEX IF NOT EXISTS happy_agent_module_workspaces_name_key ON happy_agent_module_workspaces(project_ref,name_key);",
    ),
    (
        "006-workspace-agent-associations",
        "CREATE TABLE happy_agent_module_workspace_agents(workspace_id TEXT NOT NULL,agent_id TEXT PRIMARY KEY,order_key TEXT NOT NULL);CREATE INDEX happy_agent_module_workspace_agents_workspace_order ON happy_agent_module_workspace_agents(workspace_id,order_key,agent_id);",
    ),
    (
        "007-workspace-hierarchy",
        "ALTER TABLE happy_agent_module_workspaces ADD COLUMN parent_id TEXT NOT NULL DEFAULT '';UPDATE happy_agent_module_workspaces SET parent_id=project_ref WHERE parent_id='';CREATE INDEX happy_agent_module_workspaces_project_parent_order ON happy_agent_module_workspaces(project_ref,parent_id,order_key,id);",
    ),
    (
        "008-workspace-service-cleanup",
        "ALTER TABLE happy_agent_module_workspaces ADD COLUMN service_cleanup TEXT;",
    ),
    (
        "009-workspace-subtask",
        "ALTER TABLE happy_agent_module_workspaces ADD COLUMN subtask_agent_id TEXT;",
    ),
    (
        "010-workspace-runner-and-image",
        "ALTER TABLE happy_agent_module_workspaces ADD COLUMN runner_id TEXT;ALTER TABLE happy_agent_module_workspaces ADD COLUMN docker_image TEXT;",
    ),
];

pub(super) const COLUMNS: &str = "id,project_ref,parent_id,name,name_configured,branch,storage_key,kind,path,runner_id,docker_image,base_ref,base_commit,git_common_dir,presence,status,order_key,version,creator_session_id,subtask_agent_id,git_ahead,git_behind,git_detached,git_head,git_upstream,initialization_attempt,initialization_error,created_at,updated_at,archived_at,service_cleanup";
const FIELDS: &[&str] = &[
    "id",
    "projectRef",
    "parentId",
    "name",
    "nameConfigured",
    "branch",
    "storageKey",
    "kind",
    "path",
    "runnerId",
    "dockerImage",
    "baseRef",
    "baseCommit",
    "gitCommonDir",
    "presence",
    "status",
    "orderKey",
    "version",
    "creatorSessionId",
    "subtaskAgentId",
    "gitAhead",
    "gitBehind",
    "gitDetached",
    "gitHead",
    "gitUpstream",
    "initializationAttempt",
    "initializationError",
    "createdAt",
    "updatedAt",
    "archivedAt",
    "serviceCleanup",
];

pub(super) fn from_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    let mut value = json!({});
    for (index, field) in FIELDS.iter().enumerate() {
        if [4, 22].contains(&index) {
            let number = row.get::<_, i64>(index)?;
            if number != 0 && number != 1 {
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    index,
                    rusqlite::types::Type::Integer,
                    Box::new(std::io::Error::other("Invalid stored workspace boolean.")),
                ));
            }
            value[*field] = json!(number == 1);
        } else if [17, 20, 21, 25, 27, 28, 29].contains(&index) {
            if let Some(number) = row.get::<_, Option<i64>>(index)? {
                value[*field] = json!(number);
            }
        } else if index == 30 {
            if let Some(text) = row.get::<_, Option<String>>(index)? {
                value[*field] = serde_json::from_str(&text).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        index,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            }
        } else if let Some(text) = row.get::<_, Option<String>>(index)? {
            value[*field] = json!(text);
        }
    }
    Ok(value)
}

pub fn validate(schemas: &Schemas, workspace: &Value) -> Result<()> {
    anyhow::ensure!(
        schemas.valid("ownerWorkspace", workspace)?,
        "The stored workspace is invalid."
    );
    anyhow::ensure!(
        workspace["updatedAt"].as_u64() >= workspace["createdAt"].as_u64(),
        "Workspace timestamps are not ordered."
    );
    if workspace["version"] == 1 {
        anyhow::ensure!(
            workspace["status"] == "initializing" && workspace["presence"] == "missing",
            "The workspace's first version must describe its reservation."
        );
    }
    if let Some(archived) = workspace.get("archivedAt") {
        anyhow::ensure!(
            workspace["status"] == "archived" || workspace["status"] == "archiving",
            "A non-archived workspace has an archive timestamp."
        );
        anyhow::ensure!(
            archived.as_u64() >= workspace["createdAt"].as_u64()
                && archived.as_u64() <= workspace["updatedAt"].as_u64(),
            "The workspace's archive timestamp is inconsistent."
        );
    } else {
        anyhow::ensure!(
            workspace["status"] != "archived",
            "The archived workspace has no archive timestamp."
        );
    }
    Ok(())
}

pub fn read(ctx: &Context<'_>, schemas: &Schemas, id: &str) -> Result<Option<Value>> {
    let value = ctx
        .database()
        .query_row(
            &format!("SELECT {COLUMNS} FROM happy_agent_module_workspaces WHERE id=?1"),
            [id],
            from_row,
        )
        .optional()?;
    if let Some(value) = &value {
        validate(schemas, value)?;
    }
    Ok(value)
}

pub fn available(ctx: &Context<'_>) -> Result<bool> {
    Ok(ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='happy_agent_module_workspaces')",[],|row|row.get(0))?)
}
pub fn has_identity(ctx: &Context<'_>, id: &str) -> Result<bool> {
    Ok(ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM happy_agent_module_workspaces WHERE id=?1 OR subtask_agent_id=?1 UNION ALL SELECT 1 FROM happy_agent_module_workspace_agents WHERE agent_id=?1)", [id], |row|row.get(0))?)
}

pub fn agent_association(ctx: &Context<'_>, agent: &str) -> Result<Option<(String, String)>> {
    Ok(ctx.database().query_row("SELECT workspace_id,order_key FROM happy_agent_module_workspace_agents WHERE agent_id=?1",[agent],|row|Ok((row.get(0)?,row.get(1)?))).optional()?)
}

pub fn agent_ids(ctx: &Context<'_>, workspace: &str) -> Result<Vec<String>> {
    let ids=ctx.database().prepare("SELECT agent_id FROM happy_agent_module_workspace_agents WHERE workspace_id=?1 ORDER BY order_key,agent_id LIMIT 10001")?.query_map([workspace],|row|row.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    anyhow::ensure!(
        ids.len() <= 10000,
        "The workspace agent series exceeds its snapshot bound."
    );
    Ok(ids)
}

pub fn attach(ctx: &Context<'_>, workspace: &str, agent: &str, key: &str) -> Result<()> {
    ctx.database().execute("INSERT INTO happy_agent_module_workspace_agents(workspace_id,agent_id,order_key) VALUES(?1,?2,?3)", params![workspace,agent,key])?;
    Ok(())
}
pub fn last_agent_order(ctx: &Context<'_>, workspace: &str) -> Result<Option<String>> {
    Ok(ctx.database().query_row("SELECT order_key FROM happy_agent_module_workspace_agents WHERE workspace_id=?1 ORDER BY order_key DESC,agent_id DESC LIMIT 1", [workspace], |row| row.get(0)).optional()?)
}
pub fn project_workspaces(
    ctx: &Context<'_>,
    schemas: &Schemas,
    project: &str,
) -> Result<Vec<Value>> {
    let rows = ctx.database().prepare(&format!("SELECT {COLUMNS} FROM happy_agent_module_workspaces WHERE project_ref=?1 ORDER BY order_key,id LIMIT 10001"))?.query_map([project],from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        rows.len() <= 10000,
        "The project's workspace catalog exceeds its snapshot bound."
    );
    for row in &rows {
        validate(schemas, row)?;
    }
    Ok(rows)
}

pub fn ancestor_ids(
    ctx: &Context<'_>,
    schemas: &Schemas,
    workspace: &Value,
) -> Result<Vec<String>> {
    let mut current = workspace.clone();
    let mut seen = BTreeSet::new();
    let mut ancestors = Vec::new();
    loop {
        let id = current["id"].as_str().unwrap_or_default().to_owned();
        anyhow::ensure!(
            seen.len() < 10000 && seen.insert(id.clone()),
            "The workspace parent chain is cyclic or exceeds its snapshot bound."
        );
        ancestors.push(id);
        if current["parentId"] == current["projectRef"] {
            return Ok(ancestors);
        }
        current = read(
            ctx,
            schemas,
            current["parentId"].as_str().unwrap_or_default(),
        )?
        .ok_or_else(|| anyhow::anyhow!("The workspace's parent does not exist."))?;
        anyhow::ensure!(
            current["projectRef"] == workspace["projectRef"],
            "The workspace's parent belongs to another project."
        );
    }
}

fn parameters(workspace: &Value) -> Result<Vec<rusqlite::types::Value>> {
    FIELDS
        .iter()
        .map(|field| {
            Ok(match &workspace[*field] {
                Value::Null => rusqlite::types::Value::Null,
                Value::String(text) => rusqlite::types::Value::Text(text.clone()),
                Value::Bool(flag) => rusqlite::types::Value::Integer(i64::from(*flag)),
                Value::Number(number) => rusqlite::types::Value::Integer(
                    number
                        .as_i64()
                        .ok_or_else(|| anyhow::anyhow!("The workspace number cannot be stored."))?,
                ),
                value if *field == "serviceCleanup" => {
                    rusqlite::types::Value::Text(value.to_string())
                }
                _ => anyhow::bail!("The workspace field cannot be stored."),
            })
        })
        .collect()
}

pub fn write(ctx: &Context<'_>, schemas: &Schemas, before: &Value, after: &Value) -> Result<Value> {
    validate(schemas, after)?;
    anyhow::ensure!(
        before["id"] == after["id"]
            && after["version"].as_u64() == before["version"].as_u64().map(|v| v + 1),
        "A workspace mutation must advance its version exactly once."
    );
    let mut values = parameters(after)?;
    values.push(rusqlite::types::Value::Text(
        after["name"]
            .as_str()
            .unwrap_or_default()
            .nfkc()
            .collect::<String>()
            .to_lowercase(),
    ));
    values.push(rusqlite::types::Value::Integer(
        before["version"].as_i64().unwrap_or_default(),
    ));
    let assignments = COLUMNS
        .split(',')
        .enumerate()
        .skip(1)
        .map(|(index, column)| format!("{column}=?{}", index + 1))
        .collect::<Vec<_>>()
        .join(",");
    let affected=ctx.database().execute(&format!("UPDATE happy_agent_module_workspaces SET {assignments},name_key=?32 WHERE id=?1 AND version=?33"),rusqlite::params_from_iter(values))?;
    anyhow::ensure!(
        affected == 1,
        "The workspace changed before its state could be recorded."
    );
    let stored = read(ctx, schemas, after["id"].as_str().unwrap_or_default())?
        .ok_or_else(|| anyhow::anyhow!("The written workspace is missing."))?;
    anyhow::ensure!(
        stored == *after,
        "The workspace did not store the intended state."
    );
    Ok(stored)
}

pub fn insert(ctx: &Context<'_>, schemas: &Schemas, workspace: &Value) -> Result<()> {
    validate(schemas, workspace)?;
    let mut values = parameters(workspace)?;
    values.push(rusqlite::types::Value::Text(
        workspace["name"]
            .as_str()
            .unwrap_or_default()
            .nfkc()
            .collect::<String>()
            .to_lowercase(),
    ));
    let placeholders = (1..=values.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    ctx.database().execute(
        &format!(
            "INSERT INTO happy_agent_module_workspaces({COLUMNS},name_key) VALUES({placeholders})"
        ),
        rusqlite::params_from_iter(values),
    )?;
    Ok(())
}

pub fn has_unarchived(ctx: &Context<'_>, project: &str) -> Result<bool> {
    Ok(ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM happy_agent_module_workspaces WHERE project_ref=?1 AND status<>'archived')",[project],|row|row.get(0))?)
}

pub fn project_ids(ctx: &Context<'_>, project: &str) -> Result<Vec<String>> {
    let ids=ctx.database().prepare("SELECT id FROM happy_agent_module_workspaces WHERE project_ref=?1 AND status<>'archived' ORDER BY order_key,id LIMIT 10001")?.query_map([project],|row|row.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    anyhow::ensure!(
        ids.len() <= 10000,
        "The project's workspaces exceed their snapshot bound."
    );
    Ok(ids)
}

pub fn child_ids(ctx: &Context<'_>, project: &str, parent: &str) -> Result<Vec<String>> {
    let ids=ctx.database().prepare("SELECT id FROM happy_agent_module_workspaces WHERE project_ref=?1 AND parent_id=?2 AND status<>'archived' ORDER BY order_key,id LIMIT 10001")?.query_map(params![project,parent],|row|row.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    anyhow::ensure!(
        ids.len() <= 10000,
        "The workspace children exceed their snapshot bound."
    );
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn additive_migrations_preserve_hierarchy_service_intent_and_agent_order() {
        let database = Connection::open_in_memory().unwrap();
        for (_, sql) in &MIGRATIONS[..7] {
            database.execute_batch(sql).unwrap();
        }
        database.execute_batch("INSERT INTO happy_agent_module_workspaces(id,project_ref,parent_id,name,name_key,name_configured,branch,storage_key,kind,path,presence,status,order_key,version,git_ahead,git_behind,git_detached,initialization_attempt,created_at,updated_at,archived_at) VALUES('original-child','project','original-parent','Original child','original child',1,'child-branch','child-folder','directory','/original/project/child-folder','present','archiving','250',3,0,0,0,1,10,20,20);INSERT INTO happy_agent_module_workspace_agents VALUES('original-child','original-agent','125');").unwrap();
        database.execute_batch(MIGRATIONS[7].1).unwrap();
        database.execute("UPDATE happy_agent_module_workspaces SET service_cleanup=?1",[json!({"phase":"blocked","serviceIds":["original-service"],"error":{"code":"service_cleanup_unconfirmed","message":"Retain files."}}).to_string()]).unwrap();
        for (_, sql) in &MIGRATIONS[8..] {
            database.execute_batch(sql).unwrap();
        }
        let value = database
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM happy_agent_module_workspaces WHERE id='original-child'"
                ),
                [],
                from_row,
            )
            .unwrap();
        assert_eq!(value["parentId"], "original-parent");
        assert_eq!(
            value["serviceCleanup"]["serviceIds"],
            json!(["original-service"])
        );
        assert!(value.get("runnerId").is_none());
        assert!(value.get("subtaskAgentId").is_none());
        assert_eq!(value["archivedAt"], 20);
        assert_eq!(
            database
                .query_row(
                    "SELECT order_key FROM happy_agent_module_workspace_agents",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "125"
        );
    }

    #[test]
    fn workspace_record_keeps_explicit_null_cleanup_and_refuses_corrupt_flags() {
        let database = Connection::open_in_memory().unwrap();
        for (_, sql) in MIGRATIONS {
            database.execute_batch(sql).unwrap();
        }
        database.execute_batch("INSERT INTO happy_agent_module_workspaces(id,project_ref,parent_id,name,name_key,name_configured,branch,storage_key,kind,path,presence,status,order_key,version,git_ahead,git_behind,git_detached,initialization_attempt,created_at,updated_at,archived_at,service_cleanup) VALUES('child','project','project','Child','child',1,'child','child','directory','/project/child','present','archived','250',4,0,0,0,1,10,20,20,'null');").unwrap();
        let sql = format!("SELECT {COLUMNS} FROM happy_agent_module_workspaces WHERE id='child'");
        let value = database.query_row(&sql, [], from_row).unwrap();
        assert_eq!(value.get("serviceCleanup"), Some(&Value::Null));
        database
            .execute(
                "UPDATE happy_agent_module_workspaces SET name_configured=2",
                [],
            )
            .unwrap();
        assert!(
            database
                .query_row(&sql, [], from_row)
                .unwrap_err()
                .to_string()
                .contains("Invalid stored workspace boolean")
        );
    }
}
