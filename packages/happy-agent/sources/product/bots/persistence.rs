//! The six immutable bot migrations and their original relational catalogs.
use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::Result;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-bots-catalog",
        "CREATE TABLE happy_agent_module_bots(id TEXT PRIMARY KEY,name TEXT NOT NULL,username TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL UNIQUE,workspace_version INTEGER NOT NULL,workspace_updated_at BIGINT NOT NULL,agent_id TEXT NOT NULL UNIQUE,path TEXT NOT NULL UNIQUE,status TEXT NOT NULL,avatar_source TEXT,avatar_thumbhash TEXT,order_key TEXT NOT NULL,version INTEGER NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,archived_at BIGINT);CREATE INDEX happy_agent_module_bots_order ON happy_agent_module_bots(order_key,id);CREATE TABLE happy_agent_module_bot_avatars(bot_id TEXT PRIMARY KEY,image_bytes BLOB NOT NULL,content_type TEXT NOT NULL,content_hash TEXT NOT NULL,thumbhash TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL);",
    ),
    (
        "002-bot-avatars-are-webp",
        "DROP TABLE happy_agent_module_bot_avatars;CREATE TABLE happy_agent_module_bot_avatars(bot_id TEXT PRIMARY KEY,image_bytes BLOB NOT NULL,content_hash TEXT NOT NULL,thumbhash TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL);UPDATE happy_agent_module_bots SET avatar_source=NULL,avatar_thumbhash=NULL;",
    ),
    (
        "003-bot-admin",
        "ALTER TABLE happy_agent_module_bots ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;",
    ),
    (
        "004-system-bots",
        "ALTER TABLE happy_agent_module_bots ADD COLUMN system_key TEXT;CREATE UNIQUE INDEX happy_agent_module_bots_system_key ON happy_agent_module_bots(system_key) WHERE system_key IS NOT NULL;CREATE TABLE happy_agent_module_bot_system_seeds(system_key TEXT PRIMARY KEY,bot_id TEXT NOT NULL UNIQUE);",
    ),
    (
        "005-bot-name-configuration",
        "ALTER TABLE happy_agent_module_bots ADD COLUMN name_configured INTEGER NOT NULL DEFAULT 1;",
    ),
    (
        "006-bot-runner",
        "ALTER TABLE happy_agent_module_bots ADD COLUMN runner_id TEXT;",
    ),
];
const COLUMNS: &str = "id,is_admin,system_key,name,name_configured,username,workspace_id,workspace_version,workspace_updated_at,agent_id,path,runner_id,status,avatar_source,avatar_thumbhash,order_key,version,created_at,updated_at,archived_at";

pub fn available(ctx: &Context<'_>) -> Result<bool> {
    Ok(ctx.database().query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='happy_agent_module_bots')", [], |row|row.get(0))?)
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let admin: i64 = row.get(1)?;
    let configured: i64 = row.get(4)?;
    if ![0, 1].contains(&admin) || ![0, 1].contains(&configured) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let mut record = json!({"id":row.get::<_,String>(0)?,"isAdmin":admin==1,"name":row.get::<_,String>(3)?,"nameConfigured":configured==1,"username":row.get::<_,String>(5)?,"workspaceId":row.get::<_,String>(6)?,"workspaceVersion":row.get::<_,i64>(7)?,"workspaceUpdatedAt":row.get::<_,i64>(8)?,"agentId":row.get::<_,String>(9)?,"path":row.get::<_,String>(10)?,"status":row.get::<_,String>(12)?,"orderKey":row.get::<_,String>(15)?,"version":row.get::<_,i64>(16)?,"createdAt":row.get::<_,i64>(17)?,"updatedAt":row.get::<_,i64>(18)?});
    for (column, field) in [(2, "systemKey"), (11, "runnerId")] {
        if let Some(value) = row.get::<_, Option<String>>(column)? {
            record[field] = json!(value);
        }
    }
    if let Some(at) = row.get::<_, Option<i64>>(19)? {
        record["archivedAt"] = json!(at);
    }
    if let (Some(source), Some(thumbhash)) = (
        row.get::<_, Option<String>>(13)?,
        row.get::<_, Option<String>>(14)?,
    ) {
        record["avatar"] = json!({"kind":"image","source":source,"thumbhash":thumbhash});
    }
    Ok(record)
}
fn validate(schemas: &Schemas, record: &Value) -> Result<()> {
    anyhow::ensure!(
        schemas.valid("ownerBotRecord", record)?,
        "Bot storage contains an invalid bot."
    );
    Ok(())
}
pub fn read(ctx: &Context<'_>, schemas: &Schemas, id: &str) -> Result<Option<Value>> {
    read_by(ctx, schemas, "id", id)
}
pub fn for_agent(ctx: &Context<'_>, schemas: &Schemas, id: &str) -> Result<Option<Value>> {
    read_by(ctx, schemas, "agent_id", id)
}
pub fn for_workspace(ctx: &Context<'_>, schemas: &Schemas, id: &str) -> Result<Option<Value>> {
    read_by(ctx, schemas, "workspace_id", id)
}
pub fn for_username(ctx: &Context<'_>, schemas: &Schemas, name: &str) -> Result<Option<Value>> {
    read_by(ctx, schemas, "username", name)
}
fn read_by(
    ctx: &Context<'_>,
    schemas: &Schemas,
    column: &str,
    value: &str,
) -> Result<Option<Value>> {
    let record = ctx
        .database()
        .query_row(
            &format!("SELECT {COLUMNS} FROM happy_agent_module_bots WHERE {column}=?1 LIMIT 1"),
            [value],
            from_row,
        )
        .optional()?;
    if let Some(record) = &record {
        validate(schemas, record)?;
    }
    Ok(record)
}
pub fn list(ctx: &Context<'_>, schemas: &Schemas) -> Result<Vec<Value>> {
    let records = ctx
        .database()
        .prepare(&format!(
            "SELECT {COLUMNS} FROM happy_agent_module_bots ORDER BY order_key,id LIMIT 10001"
        ))?
        .query_map([], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        records.len() <= 10000,
        "The bot roster exceeds its restoration bound."
    );
    for record in &records {
        validate(schemas, record)?;
    }
    Ok(records)
}
pub fn insert(ctx: &Context<'_>, schemas: &Schemas, record: &Value) -> Result<()> {
    validate(schemas, record)?;
    ctx.database().execute("INSERT INTO happy_agent_module_bots(id,is_admin,system_key,name,name_configured,username,workspace_id,workspace_version,workspace_updated_at,agent_id,path,runner_id,status,avatar_source,avatar_thumbhash,order_key,version,created_at,updated_at,archived_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",params![record["id"].as_str(),i64::from(record["isAdmin"].as_bool().unwrap()),record["systemKey"].as_str(),record["name"].as_str(),i64::from(record["nameConfigured"].as_bool().unwrap()),record["username"].as_str(),record["workspaceId"].as_str(),record["workspaceVersion"].as_i64(),record["workspaceUpdatedAt"].as_i64(),record["agentId"].as_str(),record["path"].as_str(),record["runnerId"].as_str(),record["status"].as_str(),record["avatar"]["source"].as_str(),record["avatar"]["thumbhash"].as_str(),record["orderKey"].as_str(),record["version"].as_i64(),record["createdAt"].as_i64(),record["updatedAt"].as_i64(),record["archivedAt"].as_i64()])?;
    Ok(())
}
pub fn update(
    ctx: &Context<'_>,
    schemas: &Schemas,
    before: &Value,
    record: &Value,
) -> Result<Value> {
    validate(schemas, record)?;
    anyhow::ensure!(
        record["id"] == before["id"]
            && record["version"].as_u64() == before["version"].as_u64().map(|version| version + 1),
        "A bot mutation must advance its version exactly once."
    );
    let changed=ctx.database().execute("UPDATE happy_agent_module_bots SET is_admin=?2,name=?3,name_configured=?4,status=?5,workspace_version=?6,workspace_updated_at=?7,avatar_source=?8,avatar_thumbhash=?9,order_key=?10,version=?11,updated_at=?12,archived_at=?13 WHERE id=?1 AND version=?14",params![record["id"].as_str(),i64::from(record["isAdmin"].as_bool().unwrap()),record["name"].as_str(),i64::from(record["nameConfigured"].as_bool().unwrap()),record["status"].as_str(),record["workspaceVersion"].as_i64(),record["workspaceUpdatedAt"].as_i64(),record["avatar"]["source"].as_str(),record["avatar"]["thumbhash"].as_str(),record["orderKey"].as_str(),record["version"].as_i64(),record["updatedAt"].as_i64(),record["archivedAt"].as_i64(),before["version"].as_i64()])?;
    anyhow::ensure!(changed == 1, "The bot changed before it could be stored.");
    let stored = read(ctx, schemas, record["id"].as_str().unwrap())?
        .ok_or_else(|| anyhow::anyhow!("The stored bot disappeared."))?;
    anyhow::ensure!(
        stored == *record,
        "The bot mutation did not store its intended state."
    );
    Ok(stored)
}
pub fn system_seed(ctx: &Context<'_>, schemas: &Schemas, key: &str) -> Result<Option<String>> {
    let id = ctx
        .database()
        .query_row(
            "SELECT bot_id FROM happy_agent_module_bot_system_seeds WHERE system_key=?1 LIMIT 1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(id) = &id {
        anyhow::ensure!(
            schemas.valid("cuid2", &json!(id))?,
            "System bot seed storage contains an invalid bot ID."
        );
    }
    Ok(id)
}
pub fn seed(ctx: &Context<'_>, key: &str, id: &str) -> Result<()> {
    ctx.database().execute(
        "INSERT INTO happy_agent_module_bot_system_seeds(system_key,bot_id) VALUES(?1,?2)",
        params![key, id],
    )?;
    Ok(())
}
pub fn save_avatar(
    ctx: &Context<'_>,
    schemas: &Schemas,
    id: &str,
    bytes: &[u8],
    metadata: &Value,
) -> Result<()> {
    anyhow::ensure!(
        !bytes.is_empty()
            && bytes.len() <= 8 * 1024 * 1024
            && schemas.valid("ownerBotAvatarMetadata", metadata)?,
        "The bot avatar is invalid."
    );
    ctx.database().execute("INSERT INTO happy_agent_module_bot_avatars(bot_id,image_bytes,content_hash,thumbhash,width,height) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(bot_id) DO UPDATE SET image_bytes=excluded.image_bytes,content_hash=excluded.content_hash,thumbhash=excluded.thumbhash,width=excluded.width,height=excluded.height",params![id,bytes,metadata["contentHash"].as_str(),metadata["thumbhash"].as_str(),metadata["width"].as_i64(),metadata["height"].as_i64()])?;
    Ok(())
}
pub fn avatar(ctx: &Context<'_>, schemas: &Schemas, id: &str) -> Result<Option<(Vec<u8>, Value)>> {
    let row=ctx.database().query_row("SELECT image_bytes,content_hash,thumbhash,width,height FROM happy_agent_module_bot_avatars WHERE bot_id=?1 LIMIT 1",[id],|row|Ok((row.get::<_,Vec<u8>>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?,row.get::<_,i64>(4)?))).optional()?;
    let Some((bytes, hash, thumbhash, width, height)) = row else {
        return Ok(None);
    };
    let metadata = json!({"contentHash":hash,"etag":format!("\"{hash}\""),"thumbhash":thumbhash,"width":width,"height":height});
    anyhow::ensure!(
        !bytes.is_empty()
            && bytes.len() <= 8 * 1024 * 1024
            && schemas.valid("ownerBotAvatarMetadata", &metadata)?,
        "Bot avatar storage contains an invalid image."
    );
    anyhow::ensure!(
        format!("{:x}", Sha256::digest(&bytes)) == hash,
        "The stored bot avatar does not match its content hash."
    );
    Ok(Some((bytes, metadata)))
}
pub fn clear_avatar(ctx: &Context<'_>, id: &str) -> Result<()> {
    ctx.database().execute(
        "DELETE FROM happy_agent_module_bot_avatars WHERE bot_id=?1",
        [id],
    )?;
    Ok(())
}
#[cfg(test)]
pub fn delete_test_bot(ctx: &Context<'_>, id: &str) -> Result<()> {
    clear_avatar(ctx, id)?;
    ctx.database()
        .execute("DELETE FROM happy_agent_module_bots WHERE id=?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_bots_keep_admin_identity_seed_ledger_and_avatar_through_runner_migration() {
        let database = rusqlite::Connection::open_in_memory().unwrap();
        for (_, sql) in &MIGRATIONS[..5] {
            database.execute_batch(sql).unwrap();
        }
        database.execute_batch("INSERT INTO happy_agent_module_bots(id,name,username,workspace_id,workspace_version,workspace_updated_at,agent_id,path,status,avatar_source,avatar_thumbhash,order_key,version,created_at,updated_at,archived_at,is_admin,system_key,name_configured) VALUES('original-chief','Chief of Staff','chief_of_staff','original-workspace',2,20,'original-agent','/original/chief','archived','generated','thumb','500',3,10,20,20,1,'chief_of_staff',1);INSERT INTO happy_agent_module_bot_system_seeds VALUES('chief_of_staff','original-chief');INSERT INTO happy_agent_module_bot_avatars VALUES('original-chief',X'010203','hash','thumb',2,3);").unwrap();
        database.execute_batch(MIGRATIONS[5].1).unwrap();
        let stored = database
            .query_row(
                &format!("SELECT {COLUMNS} FROM happy_agent_module_bots"),
                [],
                from_row,
            )
            .unwrap();
        assert_eq!(stored["isAdmin"], true);
        assert_eq!(stored["systemKey"], "chief_of_staff");
        assert_eq!(stored["status"], "archived");
        assert_eq!(stored["agentId"], "original-agent");
        assert!(stored.get("runnerId").is_none());
        assert_eq!(
            database
                .query_row(
                    "SELECT bot_id FROM happy_agent_module_bot_system_seeds",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "original-chief"
        );
        assert_eq!(
            database
                .query_row(
                    "SELECT image_bytes FROM happy_agent_module_bot_avatars",
                    [],
                    |row| row.get::<_, Vec<u8>>(0)
                )
                .unwrap(),
            [1, 2, 3]
        );
    }
}
