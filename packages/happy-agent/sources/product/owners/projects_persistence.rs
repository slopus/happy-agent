//! The project catalog's original SQLite representation and guarded writes.
use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::{Result, bail};
use rusqlite::{OptionalExtension, Row, params};
use serde_json::{Value, json};

#[path = "projects_persistence/catalog.rs"]
mod catalog;
#[path = "projects_persistence/edits.rs"]
mod edits;
pub(super) use catalog::{
    query_agent_orders, query_by_path, query_catalog_page, query_home_id, query_last_order,
    query_storage_key_exists,
};
pub(super) use edits::{delete_avatar, query_avatar, save_settings};

pub(super) const PROJECT_COLUMNS: &str = "id,repository_ref,runner_id,kind,storage_key,name,name_source,status,presence,initialization_status,initialization_attempt,initialization_error,default_branch,worktree_support,worktree_unsupported_reason,remote_source_json,required_secret_kind,git_ahead,git_behind,git_detached,git_branch,git_head,git_upstream,workspace_setup_commands_json,order_key,version,avatar_json,description,created_at,updated_at,archived_at";

// Versions and their effects are the shipped module migrations. In particular,
// 004 and 005 intentionally reset their old generations; 010 preserves rows.
pub const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-projects-catalog",
        "CREATE TABLE IF NOT EXISTS happy_agent_module_projects(id TEXT PRIMARY KEY,owner_agent_id TEXT NOT NULL,repository_ref TEXT NOT NULL UNIQUE,name TEXT NOT NULL,status TEXT NOT NULL,description TEXT,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,archived_at BIGINT);CREATE INDEX IF NOT EXISTS happy_agent_module_projects_status_id ON happy_agent_module_projects(status,id);CREATE TABLE IF NOT EXISTS happy_agent_module_project_settings(project_id TEXT PRIMARY KEY,settings_json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS happy_agent_module_project_operation_receipts(agent_id TEXT NOT NULL,operation_id TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(agent_id,operation_id));CREATE TABLE IF NOT EXISTS happy_agent_module_project_mutation_proofs(agent_id TEXT NOT NULL,operation_id TEXT NOT NULL,proof_json TEXT NOT NULL,PRIMARY KEY(agent_id,operation_id));",
    ),
    (
        "002-drop-project-idempotency-tables",
        "DROP TABLE IF EXISTS happy_agent_module_project_operation_receipts;DROP TABLE IF EXISTS happy_agent_module_project_mutation_proofs;",
    ),
    (
        "003-project-order-version-avatar",
        "ALTER TABLE happy_agent_module_projects ADD COLUMN order_key TEXT NOT NULL DEFAULT '';ALTER TABLE happy_agent_module_projects ADD COLUMN version BIGINT NOT NULL DEFAULT 1;ALTER TABLE happy_agent_module_projects ADD COLUMN avatar_json TEXT;UPDATE happy_agent_module_projects SET order_key=printf('%020d',rowid) WHERE order_key='';CREATE INDEX IF NOT EXISTS happy_agent_module_projects_order_id ON happy_agent_module_projects(order_key,id);",
    ),
    (
        "004-project-folder-record",
        "DROP TABLE IF EXISTS happy_agent_module_projects;DROP TABLE IF EXISTS happy_agent_module_project_settings;CREATE TABLE happy_agent_module_projects(id TEXT PRIMARY KEY,owner_agent_id TEXT NOT NULL,repository_ref TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,storage_key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,name_source TEXT NOT NULL,status TEXT NOT NULL,presence TEXT NOT NULL,initialization_status TEXT NOT NULL,initialization_attempt BIGINT NOT NULL DEFAULT 0,initialization_error TEXT,default_branch TEXT,worktree_support TEXT NOT NULL DEFAULT 'unknown',worktree_unsupported_reason TEXT,remote_source_json TEXT,required_secret_kind TEXT,git_ahead BIGINT NOT NULL DEFAULT 0,git_behind BIGINT NOT NULL DEFAULT 0,git_detached INTEGER NOT NULL DEFAULT 0,git_branch TEXT,git_head TEXT,git_upstream TEXT,order_key TEXT NOT NULL,version BIGINT NOT NULL DEFAULT 1,avatar_json TEXT,description TEXT,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,archived_at BIGINT);CREATE INDEX IF NOT EXISTS happy_agent_module_projects_status_id ON happy_agent_module_projects(status,id);CREATE INDEX IF NOT EXISTS happy_agent_module_projects_order_id ON happy_agent_module_projects(order_key,id);CREATE TABLE happy_agent_module_project_settings(project_id TEXT PRIMARY KEY,settings_json TEXT NOT NULL);",
    ),
    (
        "005-project-without-owner",
        "DROP TABLE IF EXISTS happy_agent_module_projects;DROP TABLE IF EXISTS happy_agent_module_project_settings;CREATE TABLE happy_agent_module_projects(id TEXT PRIMARY KEY,repository_ref TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,storage_key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,name_source TEXT NOT NULL,status TEXT NOT NULL,presence TEXT NOT NULL,initialization_status TEXT NOT NULL,initialization_attempt BIGINT NOT NULL DEFAULT 0,initialization_error TEXT,default_branch TEXT,worktree_support TEXT NOT NULL DEFAULT 'unknown',worktree_unsupported_reason TEXT,remote_source_json TEXT,required_secret_kind TEXT,git_ahead BIGINT NOT NULL DEFAULT 0,git_behind BIGINT NOT NULL DEFAULT 0,git_detached INTEGER NOT NULL DEFAULT 0,git_branch TEXT,git_head TEXT,git_upstream TEXT,order_key TEXT NOT NULL,version BIGINT NOT NULL DEFAULT 1,avatar_json TEXT,description TEXT,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,archived_at BIGINT);CREATE INDEX IF NOT EXISTS happy_agent_module_projects_status_id ON happy_agent_module_projects(status,id);CREATE INDEX IF NOT EXISTS happy_agent_module_projects_order_id ON happy_agent_module_projects(order_key,id);CREATE TABLE happy_agent_module_project_settings(project_id TEXT PRIMARY KEY,settings_json TEXT NOT NULL);",
    ),
    (
        "006-project-root-agents",
        "CREATE TABLE happy_agent_module_project_root_agents(position INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,agent_id TEXT NOT NULL UNIQUE);CREATE INDEX happy_agent_module_project_root_agents_project_position ON happy_agent_module_project_root_agents(project_id,position);",
    ),
    (
        "007-project-root-agent-order-keys",
        "ALTER TABLE happy_agent_module_project_root_agents ADD COLUMN order_key TEXT NOT NULL DEFAULT '';UPDATE happy_agent_module_project_root_agents SET order_key=printf('%020d',position) WHERE order_key='';CREATE INDEX happy_agent_module_project_root_agents_project_order ON happy_agent_module_project_root_agents(project_id,order_key,agent_id);",
    ),
    (
        "008-project-avatar-assets",
        "UPDATE happy_agent_module_projects SET avatar_json=NULL;CREATE TABLE happy_agent_module_project_avatars(project_id TEXT PRIMARY KEY,image_bytes BLOB NOT NULL,content_type TEXT NOT NULL,content_hash TEXT NOT NULL,thumbhash TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL);",
    ),
    (
        "009-project-workspace-setup-commands",
        "ALTER TABLE happy_agent_module_projects ADD COLUMN workspace_setup_commands_json TEXT;",
    ),
    (
        "010-project-runner",
        "CREATE TABLE happy_agent_module_projects_runner_rebuild(id TEXT PRIMARY KEY,repository_ref TEXT NOT NULL,runner_id TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL,storage_key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,name_source TEXT NOT NULL,status TEXT NOT NULL,presence TEXT NOT NULL,initialization_status TEXT NOT NULL,initialization_attempt BIGINT NOT NULL DEFAULT 0,initialization_error TEXT,default_branch TEXT,worktree_support TEXT NOT NULL DEFAULT 'unknown',worktree_unsupported_reason TEXT,remote_source_json TEXT,required_secret_kind TEXT,git_ahead BIGINT NOT NULL DEFAULT 0,git_behind BIGINT NOT NULL DEFAULT 0,git_detached INTEGER NOT NULL DEFAULT 0,git_branch TEXT,git_head TEXT,git_upstream TEXT,order_key TEXT NOT NULL,version BIGINT NOT NULL DEFAULT 1,avatar_json TEXT,description TEXT,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,archived_at BIGINT,workspace_setup_commands_json TEXT,UNIQUE(runner_id,repository_ref));INSERT INTO happy_agent_module_projects_runner_rebuild(id,repository_ref,kind,storage_key,name,name_source,status,presence,initialization_status,initialization_attempt,initialization_error,default_branch,worktree_support,worktree_unsupported_reason,remote_source_json,required_secret_kind,git_ahead,git_behind,git_detached,git_branch,git_head,git_upstream,order_key,version,avatar_json,description,created_at,updated_at,archived_at,workspace_setup_commands_json) SELECT id,repository_ref,kind,storage_key,name,name_source,status,presence,initialization_status,initialization_attempt,initialization_error,default_branch,worktree_support,worktree_unsupported_reason,remote_source_json,required_secret_kind,git_ahead,git_behind,git_detached,git_branch,git_head,git_upstream,order_key,version,avatar_json,description,created_at,updated_at,archived_at,workspace_setup_commands_json FROM happy_agent_module_projects;DROP TABLE happy_agent_module_projects;ALTER TABLE happy_agent_module_projects_runner_rebuild RENAME TO happy_agent_module_projects;CREATE INDEX happy_agent_module_projects_status_id ON happy_agent_module_projects(status,id);CREATE INDEX happy_agent_module_projects_order_id ON happy_agent_module_projects(order_key,id);",
    ),
];

pub(super) fn from_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    let mut value = json!({});
    for (index, field) in [
        (0, "id"),
        (1, "repositoryRef"),
        (3, "kind"),
        (4, "storageKey"),
        (5, "name"),
        (6, "nameSource"),
        (7, "status"),
        (8, "presence"),
        (9, "initializationStatus"),
        (13, "worktreeSupport"),
        (24, "orderKey"),
    ] {
        value[field] = json!(row.get::<_, String>(index)?);
    }
    let runner: String = row.get(2)?;
    if !runner.is_empty() {
        value["runnerId"] = json!(runner);
    }
    for (index, field) in [
        (10, "initializationAttempt"),
        (17, "gitAhead"),
        (18, "gitBehind"),
        (25, "version"),
        (28, "createdAt"),
        (29, "updatedAt"),
    ] {
        value[field] = json!(row.get::<_, i64>(index)?);
    }
    value["gitDetached"] = stored_boolean(row, 19)?;
    for (index, field) in [
        (11, "initializationError"),
        (12, "defaultBranch"),
        (14, "worktreeUnsupportedReason"),
        (16, "requiredSecretKind"),
        (20, "gitBranch"),
        (21, "gitHead"),
        (22, "gitUpstream"),
        (27, "description"),
    ] {
        if let Some(text) = row.get::<_, Option<String>>(index)? {
            value[field] = json!(text);
        }
    }
    for (index, field) in [
        (15, "remoteSource"),
        (23, "workspaceSetupCommands"),
        (26, "avatar"),
    ] {
        if let Some(text) = row.get::<_, Option<String>>(index)? {
            value[field] = serde_json::from_str(&text).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    index,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
        }
    }
    if let Some(timestamp) = row.get::<_, Option<i64>>(30)? {
        value["archivedAt"] = json!(timestamp);
    }
    Ok(value)
}

fn stored_boolean(row: &Row<'_>, index: usize) -> rusqlite::Result<Value> {
    match row.get::<_, i64>(index)? {
        0 => Ok(json!(false)),
        1 => Ok(json!(true)),
        value => Err(rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(std::io::Error::other(format!(
                "Invalid stored project boolean: {value}"
            ))),
        )),
    }
}

pub fn read(ctx: &Context<'_>, schemas: &Schemas, id: &str) -> Result<Option<Value>> {
    let sql = format!("SELECT {PROJECT_COLUMNS} FROM happy_agent_module_projects WHERE id=?1");
    let value = ctx.database().query_row(&sql, [id], from_row).optional()?;
    if let Some(value) = &value {
        validate(schemas, value)?;
    }
    Ok(value)
}

pub fn settings(ctx: &Context<'_>, schemas: &Schemas, id: &str) -> Result<Value> {
    let text: Option<String> = ctx
        .database()
        .query_row(
            "SELECT settings_json FROM happy_agent_module_project_settings WHERE project_id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let settings = text
        .map(|text| serde_json::from_str::<Value>(&text))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    anyhow::ensure!(
        schemas.valid("ownerProjectSettings", &settings)?,
        "The stored project settings are invalid."
    );
    Ok(settings)
}

pub fn available(ctx: &Context<'_>) -> Result<bool> {
    Ok(ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='happy_agent_module_projects')",[],|row|row.get(0))?)
}

pub fn has_active_project(ctx: &Context<'_>) -> Result<bool> {
    Ok(ctx.database().query_row(
        "SELECT EXISTS(SELECT 1 FROM happy_agent_module_projects WHERE status<>'archived')",
        [],
        |row| row.get(0),
    )?)
}

pub fn validate(schemas: &Schemas, value: &Value) -> Result<()> {
    anyhow::ensure!(
        schemas.valid("ownerProject", value)?,
        "The stored project is invalid."
    );
    anyhow::ensure!(
        value["updatedAt"].as_u64() >= value["createdAt"].as_u64(),
        "Project timestamps are not ordered."
    );
    if value["status"] == "archived" {
        let archived = value["archivedAt"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("Archived project is missing its archival time."))?;
        anyhow::ensure!(
            archived >= value["createdAt"].as_u64().unwrap()
                && archived <= value["updatedAt"].as_u64().unwrap(),
            "Project archival time is inconsistent with its timestamps."
        );
    } else {
        anyhow::ensure!(
            value.get("archivedAt").is_none(),
            "Active project has an archival time."
        );
    }
    anyhow::ensure!(
        value["kind"] != "home" || value["initializationStatus"] == "ready",
        "The home project is never initialized."
    );
    anyhow::ensure!(
        value.get("initializationError").is_none() || value["initializationStatus"] == "failed",
        "Only a failed project keeps an initialization error."
    );
    anyhow::ensure!(
        value.get("worktreeUnsupportedReason").is_none()
            || value["worktreeSupport"] == "unsupported",
        "Only a project without worktree support keeps a reason."
    );
    Ok(())
}

pub fn write(ctx: &Context<'_>, schemas: &Schemas, before: &Value, after: &Value) -> Result<Value> {
    validate(schemas, after)?;
    anyhow::ensure!(
        after["id"] == before["id"]
            && after["version"].as_u64() == before["version"].as_u64().map(|v| v + 1),
        "A project mutation must advance its version exactly once."
    );
    anyhow::ensure!(
        after["updatedAt"].as_u64() >= before["updatedAt"].as_u64(),
        "A changed project moved its update time backwards."
    );
    let json_field = |field: &str| after.get(field).map(Value::to_string);
    let affected=ctx.database().execute("UPDATE happy_agent_module_projects SET name=?2,name_source=?3,status=?4,presence=?5,initialization_status=?6,initialization_attempt=?7,initialization_error=?8,default_branch=?9,worktree_support=?10,worktree_unsupported_reason=?11,git_ahead=?12,git_behind=?13,git_detached=?14,git_branch=?15,git_head=?16,git_upstream=?17,workspace_setup_commands_json=?18,version=?19,avatar_json=?20,description=?21,updated_at=?22,archived_at=?23,order_key=?25 WHERE id=?1 AND version=?24",params![after["id"].as_str(),after["name"].as_str(),after["nameSource"].as_str(),after["status"].as_str(),after["presence"].as_str(),after["initializationStatus"].as_str(),after["initializationAttempt"].as_i64(),after["initializationError"].as_str(),after["defaultBranch"].as_str(),after["worktreeSupport"].as_str(),after["worktreeUnsupportedReason"].as_str(),after["gitAhead"].as_i64(),after["gitBehind"].as_i64(),i64::from(after["gitDetached"].as_bool().unwrap_or(false)),after["gitBranch"].as_str(),after["gitHead"].as_str(),after["gitUpstream"].as_str(),json_field("workspaceSetupCommands"),after["version"].as_i64(),json_field("avatar"),after["description"].as_str(),after["updatedAt"].as_i64(),after["archivedAt"].as_i64(),before["version"].as_i64(),after["orderKey"].as_str()])?;
    anyhow::ensure!(
        affected == 1,
        "The project changed before its state could be recorded."
    );
    let stored = read(ctx, schemas, after["id"].as_str().unwrap_or_default())?
        .ok_or_else(|| anyhow::anyhow!("The written project is missing."))?;
    anyhow::ensure!(
        stored == *after,
        "The project did not store the intended state."
    );
    Ok(stored)
}

pub fn agent_association(ctx: &Context<'_>, agent: &str) -> Result<Option<(String, String)>> {
    Ok(ctx.database().query_row("SELECT project_id,order_key FROM happy_agent_module_project_root_agents WHERE agent_id=?1",[agent],|row|Ok((row.get(0)?,row.get(1)?))).optional()?)
}

pub fn agent_ids(ctx: &Context<'_>, project: &str) -> Result<Vec<String>> {
    let ids=ctx.database().prepare("SELECT agent_id FROM happy_agent_module_project_root_agents WHERE project_id=?1 ORDER BY order_key,agent_id LIMIT 10001")?.query_map([project],|row|row.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    anyhow::ensure!(
        ids.len() <= 10000,
        "The project's root-agent series exceeds its snapshot bound."
    );
    Ok(ids)
}

pub fn attach(ctx: &Context<'_>, project: &str, agent: &str, key: &str) -> Result<()> {
    ctx.database().execute("INSERT INTO happy_agent_module_project_root_agents(project_id,agent_id,order_key) VALUES(?1,?2,?3)",params![project,agent,key])?;
    Ok(())
}

pub fn last_agent_order(ctx: &Context<'_>, project: &str) -> Result<Option<String>> {
    Ok(ctx.database().query_row(
        "SELECT max(order_key) FROM happy_agent_module_project_root_agents WHERE project_id=?1",
        [project],
        |row| row.get(0),
    )?)
}

pub fn save_avatar(ctx: &Context<'_>, id: &str, bytes: &[u8], metadata: &Value) -> Result<()> {
    ctx.database().execute("INSERT INTO happy_agent_module_project_avatars(project_id,image_bytes,content_type,content_hash,thumbhash,width,height) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(project_id) DO UPDATE SET image_bytes=excluded.image_bytes,content_type=excluded.content_type,content_hash=excluded.content_hash,thumbhash=excluded.thumbhash,width=excluded.width,height=excluded.height",params![id,bytes,metadata["contentType"].as_str(),metadata["contentHash"].as_str(),metadata["thumbhash"].as_str(),metadata["width"].as_i64(),metadata["height"].as_i64()])?;
    Ok(())
}

pub fn insert(ctx: &Context<'_>, schemas: &Schemas, project: &Value) -> Result<()> {
    validate(schemas, project)?;
    let fields = [
        "id",
        "repositoryRef",
        "runnerId",
        "kind",
        "storageKey",
        "name",
        "nameSource",
        "status",
        "presence",
        "initializationStatus",
        "initializationAttempt",
        "initializationError",
        "defaultBranch",
        "worktreeSupport",
        "worktreeUnsupportedReason",
        "remoteSource",
        "requiredSecretKind",
        "gitAhead",
        "gitBehind",
        "gitDetached",
        "gitBranch",
        "gitHead",
        "gitUpstream",
        "workspaceSetupCommands",
        "orderKey",
        "version",
        "avatar",
        "description",
        "createdAt",
        "updatedAt",
        "archivedAt",
    ];
    let mut values = Vec::with_capacity(fields.len());
    for field in fields {
        let value = if field == "runnerId" {
            rusqlite::types::Value::Text(project[field].as_str().unwrap_or("").to_owned())
        } else if ["remoteSource", "workspaceSetupCommands", "avatar"].contains(&field) {
            project
                .get(field)
                .map_or(rusqlite::types::Value::Null, |value| {
                    rusqlite::types::Value::Text(value.to_string())
                })
        } else {
            match &project[field] {
                Value::Null => rusqlite::types::Value::Null,
                Value::String(text) => rusqlite::types::Value::Text(text.clone()),
                Value::Bool(flag) => rusqlite::types::Value::Integer(i64::from(*flag)),
                Value::Number(number) => rusqlite::types::Value::Integer(
                    number
                        .as_i64()
                        .ok_or_else(|| anyhow::anyhow!("The project number cannot be stored."))?,
                ),
                _ => bail!("The project field cannot be stored."),
            }
        };
        values.push(value);
    }
    let placeholders = (1..=values.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    ctx.database().execute(
        &format!(
            "INSERT INTO happy_agent_module_projects({PROJECT_COLUMNS}) VALUES({placeholders})"
        ),
        rusqlite::params_from_iter(values),
    )?;
    ctx.database().execute(
        "INSERT INTO happy_agent_module_project_settings VALUES(?1,'{}')",
        [project["id"].as_str()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn runner_migration_preserves_original_project_and_adjacent_catalogs() {
        let database = Connection::open_in_memory().unwrap();
        for (_, sql) in &MIGRATIONS[..9] {
            database.execute_batch(sql).unwrap();
        }
        database.execute_batch("INSERT INTO happy_agent_module_projects(id,repository_ref,kind,storage_key,name,name_source,status,presence,initialization_status,order_key,created_at,updated_at,workspace_setup_commands_json) VALUES('source-project','/original/project','regular','source-project','Source project','user','active','present','initializing','100',10,20,'[\"pnpm install\"]');INSERT INTO happy_agent_module_project_settings VALUES('source-project','{\"workspaceInitialPrompt\":\"Inspect first\"}');INSERT INTO happy_agent_module_project_root_agents(project_id,agent_id,order_key) VALUES('source-project','original-root','500');INSERT INTO happy_agent_module_project_avatars VALUES('source-project',X'010203','image/webp','hash','thumb',2,3);").unwrap();
        database.execute_batch(MIGRATIONS[9].1).unwrap();
        let value=database.query_row(&format!("SELECT {PROJECT_COLUMNS} FROM happy_agent_module_projects WHERE id='source-project'"),[],from_row).unwrap();
        assert_eq!(value["id"], "source-project");
        assert!(value.get("runnerId").is_none());
        assert_eq!(value["version"], 1);
        assert_eq!(value["workspaceSetupCommands"], json!(["pnpm install"]));
        assert_eq!(
            database
                .query_row(
                    "SELECT settings_json FROM happy_agent_module_project_settings",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "{\"workspaceInitialPrompt\":\"Inspect first\"}"
        );
        assert_eq!(
            database
                .query_row(
                    "SELECT agent_id FROM happy_agent_module_project_root_agents",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "original-root"
        );
        assert_eq!(
            database
                .query_row(
                    "SELECT image_bytes FROM happy_agent_module_project_avatars",
                    [],
                    |row| row.get::<_, Vec<u8>>(0)
                )
                .unwrap(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn row_conversion_rejects_corrupt_flags_without_coercing_them() {
        let database = Connection::open_in_memory().unwrap();
        for (_, sql) in MIGRATIONS {
            database.execute_batch(sql).unwrap();
        }
        database.execute_batch("INSERT INTO happy_agent_module_projects(id,repository_ref,kind,storage_key,name,name_source,status,presence,initialization_status,order_key,created_at,updated_at,git_detached) VALUES('project','/original/project','regular','project','Project','user','active','present','ready','100',10,20,2)").unwrap();
        let error = database
            .query_row(
                &format!(
                    "SELECT {PROJECT_COLUMNS} FROM happy_agent_module_projects WHERE id='project'"
                ),
                [],
                from_row,
            )
            .unwrap_err();
        assert!(error.to_string().contains("Invalid stored project boolean"));
    }
}
