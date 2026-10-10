//! The three original migrations, including their procedural version backfills.
use crate::product::{
    identity::{Versions, now},
    runtime::Context,
    schemas::Schemas,
};
use anyhow::{Result, ensure};
use happy_agent_base::NativeMigration;
use serde_json::json;

pub(super) const MIGRATIONS: &[NativeMigration] = &[
    NativeMigration {
        key: "001-secrets",
        apply: initial,
    },
    NativeMigration {
        key: "002-secrets-api",
        apply: catalog,
    },
    NativeMigration {
        key: "003-secret-names",
        apply: names,
    },
];
fn initial(ctx: &Context<'_>) -> Result<()> {
    ctx.database().execute_batch("CREATE TABLE IF NOT EXISTS happy_agent_secrets(owner_agent_id TEXT NOT NULL,id TEXT NOT NULL,description TEXT NOT NULL,environment_json TEXT NOT NULL,revision TEXT NOT NULL,available_to_model INTEGER,kind TEXT,PRIMARY KEY(owner_agent_id,id));CREATE TABLE IF NOT EXISTS happy_agent_secret_attachments(owner_agent_id TEXT NOT NULL,scope_ref TEXT NOT NULL,secret_id TEXT NOT NULL,PRIMARY KEY(owner_agent_id,scope_ref,secret_id));CREATE INDEX IF NOT EXISTS happy_agent_secrets_owner ON happy_agent_secrets(owner_agent_id,id);CREATE INDEX IF NOT EXISTS happy_agent_secret_attachments_scope ON happy_agent_secret_attachments(owner_agent_id,scope_ref,secret_id);").map_err(|_|super::storage_error())?;
    Ok(())
}
fn catalog(ctx: &Context<'_>) -> Result<()> {
    ctx.database().execute_batch("ALTER TABLE happy_agent_secrets ADD COLUMN public_version TEXT;ALTER TABLE happy_agent_secrets ADD COLUMN created_at INTEGER;ALTER TABLE happy_agent_secrets ADD COLUMN updated_at INTEGER;CREATE TABLE happy_agent_secret_api_attachments(id TEXT NOT NULL PRIMARY KEY,owner_agent_id TEXT NOT NULL,secret_id TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(owner_agent_id,secret_id,target_type,target_id));CREATE INDEX happy_agent_secret_api_attachments_target ON happy_agent_secret_api_attachments(owner_agent_id,target_type,target_id,secret_id);CREATE INDEX happy_agent_secret_api_attachments_secret ON happy_agent_secret_api_attachments(owner_agent_id,secret_id,created_at,id);").map_err(|_|super::storage_error())?;
    backfill(ctx, false)
}
fn names(ctx: &Context<'_>) -> Result<()> {
    backfill(ctx, true)
}
fn backfill(ctx: &Context<'_>, named_only: bool) -> Result<()> {
    let schemas = Schemas::new()?;
    let mut previous = None;
    let mut after: Option<(String, String)> = None;
    loop {
        // Bound memory and read only identities. Value-bearing rows never enter
        // the migration adapter; updates retain their original owner and keys.
        let mut statement=ctx.database().prepare("SELECT owner_agent_id,id FROM happy_agent_secrets WHERE(public_version IS NULL OR created_at IS NULL OR updated_at IS NULL) AND(?1=0 OR(length(id) BETWEEN 2 AND 32 AND substr(id,1,1) GLOB '[a-z]' AND id NOT GLOB '*[^a-z0-9_-]*')) AND(?2 IS NULL OR owner_agent_id>?2 OR(owner_agent_id=?2 AND id>?3)) ORDER BY owner_agent_id,id LIMIT 256").map_err(|_|super::storage_error())?;
        let rows = statement
            .query_map(
                rusqlite::params![
                    named_only,
                    after.as_ref().map(|value| &value.0),
                    after.as_ref().map(|value| &value.1)
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|_| super::storage_error())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| super::storage_error())?;
        if rows.is_empty() {
            break;
        }
        after = rows.last().cloned();
        drop(statement);
        for (owner, id) in rows {
            ensure!(
                schemas.valid(
                    "secretMigrationRow",
                    &json!({"owner_agent_id":owner,"id":id})
                )?,
                "The secret migration identities are invalid."
            );
            if !schemas.valid("secretId", &json!(id))? {
                continue;
            }
            let timestamp = now();
            ensure!(
                timestamp <= 0xffffffffffff,
                "The system clock is outside the UUIDv7 timestamp range."
            );
            let mut versions = Versions::new();
            if let Some(previous) = previous {
                versions.observe(previous);
            }
            let version = versions.next();
            previous = Some(uuid::Uuid::parse_str(&version)?);
            ctx.database().execute("UPDATE happy_agent_secrets SET public_version=?1,created_at=?2,updated_at=?2 WHERE owner_agent_id=?3 AND id=?4 AND(public_version IS NULL OR created_at IS NULL OR updated_at IS NULL)",rusqlite::params![version,timestamp,owner,id]).map_err(|_|super::storage_error())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::{config::ConfigModule, runtime::RuntimeModule};
    use std::sync::Arc;
    const INITIAL: &[NativeMigration] = &[NativeMigration {
        key: "001-secrets",
        apply: initial,
    }];
    const BEFORE_NAMES: &[NativeMigration] = &[
        NativeMigration {
            key: "001-secrets",
            apply: initial,
        },
        NativeMigration {
            key: "002-secrets-api",
            apply: catalog,
        },
    ];
    #[tokio::test]
    async fn original_three_migrations_preserve_legacy_values_and_backfill_only_public_identities()
    {
        let directory = tempfile::tempdir().unwrap();
        let config = Arc::new(ConfigModule::isolated(&directory.path().join(".happy")).unwrap());
        let runtime = Arc::new(RuntimeModule::new(config.clone()));
        runtime.load().await.unwrap();
        runtime.migrate_native("secrets", INITIAL).await.unwrap();
        runtime.transact(|ctx|{
            for index in 0..600 {ctx.database().execute("INSERT INTO happy_agent_secrets VALUES(?1,?2,'fixture',?3,'old-revision',0,'github')",rusqlite::params![if index%2==0{"global"}else{"other-owner"},format!("secret-{index:04}"),if index==599{"invalid JSON values intentionally opaque to migration"}else{"{\"TOKEN\":\"original-value\"}"}])?;}
            ctx.database().execute("INSERT INTO happy_agent_secrets VALUES('global','UPPERCASE','legacy','invalid JSON also opaque','1',NULL,NULL)",[])?;
            ctx.database().execute("INSERT INTO happy_agent_secret_attachments VALUES('global','opaque-scope','secret-0000')",[])?;Ok(())
        }).await.unwrap();
        runtime
            .migrate_native("secrets", BEFORE_NAMES)
            .await
            .unwrap();
        runtime.transact(|ctx|{let count:u64=ctx.database().query_row("SELECT count(*) FROM happy_agent_secrets WHERE public_version IS NOT NULL",[],|row|row.get(0))?;assert_eq!(count,600);let legacy:Option<String>=ctx.database().query_row("SELECT public_version FROM happy_agent_secrets WHERE id='UPPERCASE'",[],|row|row.get(0))?;assert!(legacy.is_none());ctx.database().execute("INSERT INTO happy_agent_secrets(owner_agent_id,id,description,environment_json,revision) VALUES('global','later-name','fixture','still opaque','1')",[])?;Ok(())}).await.unwrap();
        runtime.migrate_native("secrets", MIGRATIONS).await.unwrap();
        runtime.close().await.unwrap();
        let runtime = Arc::new(RuntimeModule::new(config));
        runtime.load().await.unwrap();
        runtime.migrate_native("secrets", MIGRATIONS).await.unwrap();
        runtime.transact(|ctx|{
            let facts:(String,String,Option<String>)=ctx.database().query_row("SELECT environment_json,revision,kind FROM happy_agent_secrets WHERE owner_agent_id='global' AND id='secret-0000'",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;assert_eq!(facts,("{\"TOKEN\":\"original-value\"}".into(),"old-revision".into(),Some("github".into())));
            let mut statement=ctx.database().prepare("SELECT public_version FROM happy_agent_secrets WHERE id!='later-name' AND public_version IS NOT NULL ORDER BY owner_agent_id,id")?;let versions=statement.query_map([],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;assert!(versions.windows(2).all(|pair|pair[0]<pair[1]));
            let later:String=ctx.database().query_row("SELECT public_version FROM happy_agent_secrets WHERE id='later-name'",[],|row|row.get(0))?;assert_eq!(uuid::Uuid::parse_str(&later)?.get_version_num(),7);let count:u64=ctx.database().query_row("SELECT count(*) FROM happy_agent_secret_attachments",[],|row|row.get(0))?;assert_eq!(count,1);Ok(())
        }).await.unwrap();
        runtime.close().await.unwrap();
    }
}
