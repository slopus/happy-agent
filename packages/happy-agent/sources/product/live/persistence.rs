//! Owner-filtered voice sessions and the original selective retention query.
use crate::product::{runtime::Context, schemas::Schemas};
use anyhow::Result;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

pub const MIGRATIONS: &[(&str, &str)] = &[(
    "001-live-sessions",
    "CREATE TABLE happy_live_sessions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,window_id TEXT NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL,session_json TEXT NOT NULL);CREATE INDEX happy_live_owner ON happy_live_sessions(owner_id,updated_at);CREATE UNIQUE INDEX happy_live_window ON happy_live_sessions(owner_id,window_id) WHERE status IN ('starting','active','closing');",
)];
fn decode(schemas: &Schemas, owner: &str, text: &str) -> Result<Value> {
    let session: Value = serde_json::from_str(text)?;
    let stored = json!({"ownerId":owner,"session":session});
    anyhow::ensure!(
        schemas.valid("ownerLiveStored", &stored)?,
        "The stored voice session is invalid."
    );
    Ok(stored)
}
pub fn read(ctx: &Context<'_>, schemas: &Schemas, owner: &str, id: &str) -> Result<Option<Value>> {
    let text: Option<String> = ctx
        .database()
        .query_row(
            "SELECT session_json FROM happy_live_sessions WHERE id=?1 AND owner_id=?2",
            params![id, owner],
            |row| row.get(0),
        )
        .optional()?;
    text.map(|text| decode(schemas, owner, &text).map(|stored| stored["session"].clone()))
        .transpose()
}
pub fn exists(ctx: &Context<'_>, id: &str) -> Result<bool> {
    Ok(ctx.database().query_row(
        "SELECT EXISTS(SELECT 1 FROM happy_live_sessions WHERE id=?1)",
        [id],
        |row| row.get(0),
    )?)
}
pub fn active(ctx: &Context<'_>, schemas: &Schemas, owner: Option<&str>) -> Result<Vec<Value>> {
    let mut query=ctx.database().prepare("SELECT owner_id,session_json FROM happy_live_sessions WHERE status IN ('starting','active','closing') AND (?1 IS NULL OR owner_id=?1) ORDER BY updated_at,id LIMIT 10001")?;
    let rows = query
        .query_map([owner], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        rows.len() <= 10000,
        "The voice session restoration bound was exceeded."
    );
    rows.into_iter()
        .map(|(owner, text)| decode(schemas, &owner, &text))
        .collect()
}
pub fn save(ctx: &Context<'_>, schemas: &Schemas, owner: &str, session: &Value) -> Result<()> {
    anyhow::ensure!(
        schemas.valid("ownerLiveSession", session)?,
        "The voice session is invalid."
    );
    ctx.database().execute("INSERT INTO happy_live_sessions(id,owner_id,window_id,status,updated_at,session_json) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,session_json=excluded.session_json",params![session["id"].as_str(),owner,session["windowId"].as_str(),session["status"].as_str(),session["updatedAt"].as_u64(),session.to_string()])?;
    Ok(())
}
pub fn prune(ctx: &Context<'_>, owner: &str, timestamp: u64) -> Result<()> {
    ctx.database().execute("DELETE FROM happy_live_sessions WHERE owner_id=?1 AND status IN ('closed','failed') AND (updated_at<?2 OR id IN (SELECT id FROM happy_live_sessions WHERE owner_id=?1 AND status IN ('closed','failed') ORDER BY updated_at DESC,id DESC LIMIT -1 OFFSET 1000))",params![owner,i64::try_from(timestamp)?.saturating_sub(7*86400_000)])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_terminal_retention_never_touches_another_owner_or_nonterminal_call() {
        let database = rusqlite::Connection::open_in_memory().unwrap();
        database.execute_batch(MIGRATIONS[0].1).unwrap();
        database.execute("INSERT INTO happy_live_sessions VALUES('old-other','other','one','closed',1,'intentionally unrelated invalid historical payload')",[]).unwrap();
        database.execute("INSERT INTO happy_live_sessions VALUES('old-active','owner','two','active',1,'active payload not decoded by retention')",[]).unwrap();
        database.execute("INSERT INTO happy_live_sessions VALUES('old-terminal','owner','three','failed',1,'old historical payload')",[]).unwrap();
        for index in 0..1002 {
            database.execute("INSERT INTO happy_live_sessions VALUES(?1,'owner',?1,'closed',?2,'historical payload')",params![format!("recent-{index:04}"),1_000_000_000+index]).unwrap();
        }
        database.execute("DELETE FROM happy_live_sessions WHERE owner_id=?1 AND status IN ('closed','failed') AND (updated_at<?2 OR id IN (SELECT id FROM happy_live_sessions WHERE owner_id=?1 AND status IN ('closed','failed') ORDER BY updated_at DESC,id DESC LIMIT -1 OFFSET 1000))",params!["owner",1_000_000_000i64-7*86400_000]).unwrap();
        assert_eq!(database.query_row("SELECT count(*) FROM happy_live_sessions WHERE owner_id='owner' AND status='closed'",[],|row|row.get::<_,u64>(0)).unwrap(),1000);
        assert_eq!(database.query_row("SELECT count(*) FROM happy_live_sessions WHERE id IN ('old-other','old-active')",[],|row|row.get::<_,u64>(0)).unwrap(),2);
        assert_eq!(
            database
                .query_row(
                    "SELECT count(*) FROM happy_live_sessions WHERE id='old-terminal'",
                    [],
                    |row| row.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        assert!(database.execute("INSERT INTO happy_live_sessions VALUES('duplicate','owner','two','starting',2,'')",[]).is_err());
    }
}
