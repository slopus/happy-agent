use anyhow::Result;
use happy_agent_base::{DatabaseContext, DatabaseLocation, NativeMigration, SqliteDatabase};
use std::sync::Arc;

fn original_table(ctx: &DatabaseContext<'_>) -> Result<()> {
    ctx.database().execute_batch("CREATE TABLE fixture_original(id TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO fixture_original VALUES('retained','original');")?;
    Ok(())
}
fn backfill(ctx: &DatabaseContext<'_>) -> Result<()> {
    ctx.database().execute_batch("ALTER TABLE fixture_original ADD COLUMN version TEXT;UPDATE fixture_original SET version='validated-version';")?;
    let valid: bool = ctx.database().query_row("SELECT value='corrected' FROM fixture_original WHERE id='retained'", [], |row| row.get(0))?;
    if !valid { ctx.database().execute("UPDATE fixture_original SET value='would leak'", [])?; anyhow::bail!("The original backfill could not validate its row."); }
    Ok(())
}
const MIGRATIONS: &[NativeMigration] = &[
    NativeMigration { key: "001-original-table", apply: original_table },
    NativeMigration { key: "002-original-backfill", apply: backfill },
];

#[tokio::test]
async fn a_procedural_migration_commits_its_data_and_ledger_together_and_retains_previous_steps() {
    let directory = tempfile::tempdir().unwrap(); let database = Arc::new(SqliteDatabase::new());
    database.load(DatabaseLocation { directory: directory.path().into(), database: directory.path().join("agent.sqlite"), ownership: directory.path().join("agent.sqlite.lock"), store_lock: directory.path().join("agent.lock") }).await.unwrap();
    assert!(database.migrate_native("fixture-procedural", MIGRATIONS).await.is_err());
    database.transact(|ctx| {
        assert_eq!(ctx.database().query_row::<String,_,_>("SELECT value FROM fixture_original WHERE id='retained'", [], |row| row.get(0))?, "original");
        assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM pragma_table_info('fixture_original') WHERE name='version'", [], |row| row.get(0))?, 0);
        assert_eq!(ctx.database().query_row::<String,_,_>("SELECT migration_key FROM happy_agent_migrations WHERE module_key='fixture-procedural'", [], |row| row.get(0))?, "001-original-table");
        ctx.database().execute("UPDATE fixture_original SET value='corrected' WHERE id='retained'", [])?;
        Ok(())
    }).await.unwrap();
    database.migrate_native("fixture-procedural", MIGRATIONS).await.unwrap();
    database.migrate_native("fixture-procedural", MIGRATIONS).await.unwrap();
    database.transact(|ctx| {
        let (value, version): (String, String) = ctx.database().query_row("SELECT value,version FROM fixture_original WHERE id='retained'", [], |row| Ok((row.get(0)?,row.get(1)?)))?;
        assert_eq!((value, version), ("corrected".into(),"validated-version".into()));
        assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_migrations WHERE module_key='fixture-procedural'", [], |row| row.get(0))?, 2);
        Ok(())
    }).await.unwrap();
    database.close().await.unwrap();
}