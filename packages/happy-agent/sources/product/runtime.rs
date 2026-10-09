use super::config::ConfigModule;
use anyhow::{Result, bail};
use happy_agent_base::SqliteDatabase;
use rusqlite::OptionalExtension;
use std::sync::Arc;

pub use happy_agent_base::DatabaseContext as Context;

/// Product storage owns resolved paths and installation migrations. The shared
/// agent core owns the transaction scope and exclusive SQLite connection.
pub struct RuntimeModule {
    config: Arc<ConfigModule>,
    database: Arc<SqliteDatabase>,
}
impl RuntimeModule {
    pub fn new(config: Arc<ConfigModule>) -> Self {
        Self {
            config,
            database: Arc::new(SqliteDatabase::new()),
        }
    }
    pub fn database(&self) -> Arc<SqliteDatabase> {
        self.database.clone()
    }
    pub fn assert_context(&self, ctx: &Context<'_>) -> Result<()> {
        self.database.assert_context(ctx)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.config.prepare()?;
        self.database.load(self.config.database_location()).await?;
        self.migrate("happy-agent-installation", &[
            ("001-root-agent", "CREATE TABLE IF NOT EXISTS happy_agent_loader_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);"),
            ("002-drop-root-agent", "DELETE FROM happy_agent_loader_state WHERE key='root_agent_id';"),
        ]).await?;
        self.transact(|ctx| {
            let version: Option<String> = ctx.database().query_row("SELECT value FROM happy_agent_loader_state WHERE key='schema_version'", [], |row| row.get(0)).optional()?;
            if let Some(version) = version && !version.parse::<u64>().is_ok_and(|version| version > 0) {
                bail!("The stored Happy agent schema version is invalid.");
            }
            ctx.database().execute("INSERT INTO happy_agent_loader_state(key,value) VALUES('installation_epoch',?1) ON CONFLICT DO NOTHING", [uuid::Uuid::new_v4().to_string()])?;
            ctx.database().execute("INSERT INTO happy_agent_loader_state(key,value) VALUES('schema_version','1') ON CONFLICT DO NOTHING", [])?;
            Ok(())
        }).await
    }
    pub async fn transact<T: Send + 'static>(
        self: &Arc<Self>,
        work: impl for<'a> FnOnce(&Context<'a>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.database.transact(work).await
    }
    pub async fn migrate(
        self: &Arc<Self>,
        module: &'static str,
        migrations: &'static [(&'static str, &'static str)],
    ) -> Result<()> {
        self.database.migrate(module, migrations).await
    }
    pub async fn close(self: &Arc<Self>) -> Result<()> {
        self.database.close().await
    }
}
