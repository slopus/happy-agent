use super::config::ConfigModule;
use anyhow::{Context as _, Result, bail};
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
    pub fn agent_config(&self, ctx: &Context<'_>, id: &str) -> Result<Option<serde_json::Value>> {
        self.assert_context(ctx)?;
        happy_agent_base::AgentSystem::stored_configuration(ctx, id)
    }
    pub fn parent_of(&self, ctx: &Context<'_>, id: &str) -> Result<Option<String>> {
        self.assert_context(ctx)?;
        happy_agent_base::AgentSystem::stored_parent(ctx, id)
    }
    pub fn children_of(&self, ctx: &Context<'_>, id: &str) -> Result<Vec<String>> {
        self.assert_context(ctx)?;
        happy_agent_base::AgentSystem::stored_children(ctx, id)
    }
    pub fn agents_with_running_process_metadata(&self,ctx:&Context<'_>)->Result<Vec<String>> {
        self.assert_context(ctx)?;
        let mut statement=ctx.database().prepare("SELECT substr(root.key,20) FROM happy_agent_values root LEFT JOIN happy_agent_values current ON current.owner_id=substr(root.key,20) AND current.key='agentConfig' WHERE root.owner_id='' AND substr(root.key,1,19)='agentSystem.config.' AND json_extract(coalesce(current.value_json,root.value_json),'$.metadata.processes.running')>0 ORDER BY root.key LIMIT 10001")?;
        let ids=statement.query_map([],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        anyhow::ensure!(ids.len()<=10_000,"The process metadata reconciliation exceeds the agent catalog bound.");Ok(ids)
    }
    pub fn installation_epoch(&self, ctx: &Context<'_>) -> Result<String> {
        self.assert_context(ctx)?;
        ctx.database().query_row("SELECT value FROM happy_agent_loader_state WHERE key='installation_epoch'", [], |row| row.get::<_, String>(0)).optional()?.context("The installation epoch has not been initialized.")
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
    pub async fn migrate_native(self: &Arc<Self>, module: &'static str, migrations: &'static [happy_agent_base::NativeMigration]) -> Result<()> { self.database.migrate_native(module, migrations).await }
    pub async fn close(self: &Arc<Self>) -> Result<()> {
        self.database.close().await
    }
}
