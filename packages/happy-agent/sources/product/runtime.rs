use super::{config::ConfigModule, filesystem::private_file};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::{path::Path, sync::Arc};

// This module owns the database and both original ownership seams. Historical module
// tables and unknown KV payloads are retained without eager decoding at startup.
pub struct RuntimeModule {
    _config: Arc<ConfigModule>,
    database: Option<Connection>,
    owner: Option<Connection>,
    storage_token: String,
}

impl RuntimeModule {
    pub async fn open(config: Arc<ConfigModule>) -> Result<Arc<std::sync::Mutex<Self>>> {
        tokio::task::spawn_blocking(move || Self::open_blocking(config))
            .await?
            .map(|runtime| Arc::new(std::sync::Mutex::new(runtime)))
    }

    fn open_blocking(config: Arc<ConfigModule>) -> Result<Self> {
        config.prepare()?;
        let canonical_directory = std::fs::canonicalize(&config.paths.directory)?;
        let database_path = canonical_directory.join(
            config
                .paths
                .database
                .file_name()
                .context("The database file name is unavailable.")?,
        );
        let lock_path = canonical_directory.join("agent.sqlite.lock");
        let owner = Connection::open(&lock_path)?;
        private_file(&lock_path)?;
        owner.busy_timeout(std::time::Duration::ZERO)?;
        owner
            .execute_batch("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE")
            .context("The Happy agent SQLite database is already open in another process.")?;
        let storage_token = storage_lock(&canonical_directory.join("agent.lock"))?;
        let result = (|| {
            let mut database = Connection::open(&database_path)?;
            private_file(&database_path)?;
            database.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")?;
            database.execute_batch("CREATE TABLE IF NOT EXISTS happy_agent_migrations(module_key TEXT NOT NULL,migration_key TEXT NOT NULL,position BIGINT NOT NULL,PRIMARY KEY(module_key,migration_key),UNIQUE(module_key,position));")?;
            migrate(
                &mut database,
                "@happy-agent-base",
                &[(
                    "001-core-storage",
                    "CREATE TABLE happy_agent_records(owner_id TEXT NOT NULL,position BIGINT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(owner_id,position)); CREATE TABLE happy_agent_values(owner_id TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(owner_id,key));",
                )],
            )?;
            migrate(
                &mut database,
                "happy-agent-installation",
                &[
                    (
                        "001-root-agent",
                        "CREATE TABLE IF NOT EXISTS happy_agent_loader_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
                    ),
                    (
                        "002-drop-root-agent",
                        "DELETE FROM happy_agent_loader_state WHERE key='root_agent_id';",
                    ),
                ],
            )?;
            let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let version: Option<String> = transaction
                .query_row(
                    "SELECT value FROM happy_agent_loader_state WHERE key='schema_version'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(version) = version
                && !version.parse::<u64>().is_ok_and(|version| version > 0)
            {
                bail!("The stored Happy agent schema version is invalid.");
            }
            transaction.execute("INSERT INTO happy_agent_loader_state(key,value) VALUES('installation_epoch',?1) ON CONFLICT DO NOTHING",[uuid::Uuid::new_v4().to_string()])?;
            transaction.execute("INSERT INTO happy_agent_loader_state(key,value) VALUES('schema_version','1') ON CONFLICT DO NOTHING",[])?;
            transaction.commit()?;
            Ok(database)
        })();
        match result {
            Ok(database) => Ok(Self {
                _config: config,
                database: Some(database),
                owner: Some(owner),
                storage_token,
            }),
            Err(error) => {
                release_storage_lock(&config.paths.directory.join("agent.lock"), &storage_token);
                Err(error)
            }
        }
    }

    pub fn close(&mut self) -> Result<()> {
        if let Some(database) = self.database.take()
            && let Err((database, error)) = database.close()
        {
            self.database = Some(database);
            return Err(error.into());
        }
        if let Some(owner) = self.owner.take() {
            owner.execute_batch("ROLLBACK")?;
        }
        release_storage_lock(
            &self._config.paths.directory.join("agent.lock"),
            &self.storage_token,
        );
        Ok(())
    }
}

impl Drop for RuntimeModule {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn migrate(database: &mut Connection, module: &str, migrations: &[(&str, &str)]) -> Result<()> {
    let applied = {
        let mut statement = database.prepare("SELECT migration_key,position FROM happy_agent_migrations WHERE module_key=?1 ORDER BY position")?;
        statement
            .query_map([module], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (index, (key, position)) in applied.iter().enumerate() {
        if migrations.get(index).map(|migration| migration.0) != Some(key.as_str())
            || *position != index as i64
        {
            bail!(
                "The applied migrations for module \"{module}\" are not a prefix of its current migrations."
            );
        }
    }
    for (index, (key, sql)) in migrations.iter().enumerate().skip(applied.len()) {
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(sql)?;
        transaction.execute("INSERT INTO happy_agent_migrations(module_key,migration_key,position) VALUES(?1,?2,?3)",params![module,key,index as i64])?;
        transaction.commit()?;
    }
    Ok(())
}

fn storage_lock(path: &Path) -> Result<String> {
    use std::io::Write;
    let token = uuid::Uuid::new_v4().to_string();
    for _ in 0..2 {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(path) {
            Ok(mut file) => {
                let bytes = serde_json::to_vec(
                    &serde_json::json!({"pid":std::process::id(),"token":token}),
                )?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                return Ok(token);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let owner = std::fs::read(path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
                if let Some(pid) = owner.and_then(|value| value.get("pid").and_then(|v| v.as_u64()))
                    && u32::try_from(pid).is_ok_and(super::process::process_running)
                {
                    bail!("The Happy agent store is already owned by process {pid}.");
                }
                super::filesystem::remove_missing_ok(path)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    bail!("The Happy agent store lock could not be acquired.")
}

fn release_storage_lock(path: &Path, token: &str) {
    if let Ok(bytes) = std::fs::read(path)
        && let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes)
        && value.get("token").and_then(|value| value.as_str()) == Some(token)
    {
        let _ = std::fs::remove_file(path);
    }
}
