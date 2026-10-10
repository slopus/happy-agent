use anyhow::{Context as _, Result, bail};
use rusqlite::{Connection, TransactionBehavior, params};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

// This module owns the database and both original ownership seams. Historical module
// tables and unknown KV payloads are retained without eager decoding at startup.
pub struct SqliteDatabase {
    state: Mutex<Option<Database>>,
}

/// Resolved by the feature module that owns application paths.
pub struct DatabaseLocation {
    pub directory: PathBuf,
    pub database: PathBuf,
    pub ownership: PathBuf,
    pub store_lock: PathBuf,
}

/// A feature owns the exact body of its shipped procedural migration. The
/// database owns prefix validation, transaction boundaries and its ledger.
#[derive(Clone, Copy)]
pub struct NativeMigration {
    pub key: &'static str,
    pub apply: fn(&DatabaseContext<'_>) -> Result<()>,
}

struct Database {
    database: Connection,
    owner: Connection,
    store_lock: PathBuf,
    storage_token: String,
}

/// An immutable transaction scope. Module operations use this exact connection
/// and return their notifications to the owner for publication after commit.
pub struct DatabaseContext<'a> {
    database: &'a Connection,
    owner: usize,
    after_commit: std::cell::RefCell<Vec<Box<dyn FnOnce() + Send>>>,
    claims: std::cell::RefCell<std::collections::BTreeSet<(String, String)>>,
    operations: std::cell::RefCell<std::collections::BTreeSet<(String, String)>>,
}
impl DatabaseContext<'_> {
    pub fn database(&self) -> &Connection {
        self.database
    }
    pub fn after_commit(&self, work: impl FnOnce() + Send + 'static) -> Result<()> {
        let mut observers = self.after_commit.borrow_mut();
        anyhow::ensure!(
            observers.len() < 10000,
            "The transaction has too many notifications."
        );
        observers.push(Box::new(work));
        Ok(())
    }
    /// Transaction-owned deduplication, discarded on both commit and rollback.
    /// This never changes the context's database identity or execution state.
    pub fn claim_once(&self, namespace: &str, key: &str) -> Result<bool> {
        let mut claims = self.claims.borrow_mut();
        let claim = (namespace.to_owned(), key.to_owned());
        if claims.contains(&claim) { return Ok(false); }
        anyhow::ensure!(claims.len() < 10_000 && claims.iter().map(|(namespace,key)| namespace.len()+key.len()).sum::<usize>() + namespace.len()+key.len() <= 4 * 1024 * 1024, "Transaction claims exceed their memory budget.");
        Ok(claims.insert(claim))
    }
    /// Reentrant hooks use this transaction's current values but cannot recurse
    /// into the operation currently publishing their change.
    pub fn with_operation<T>(&self, namespace: &str, key: &str, work: impl FnOnce() -> Result<T>) -> Result<T> {
        let operation = (namespace.to_owned(), key.to_owned());
        {
            let mut active = self.operations.borrow_mut();
            anyhow::ensure!(active.len() < 10_000 && !active.contains(&operation), "The operation cannot reenter its own transactional hook.");
            active.insert(operation.clone());
        }
        let result = work();
        self.operations.borrow_mut().remove(&operation);
        result
    }
}

impl Default for SqliteDatabase {
    fn default() -> Self {
        Self::new()
    }
}
impl SqliteDatabase {
    pub fn assert_context(&self, ctx: &DatabaseContext<'_>) -> Result<()> {
        anyhow::ensure!(
            ctx.owner == self as *const Self as usize,
            "The transaction belongs to a different runtime database."
        );
        Ok(())
    }
    pub fn new() -> Self {
        Self {
            state: Mutex::new(None),
        }
    }

    pub async fn load(self: &Arc<Self>, location: DatabaseLocation) -> Result<()> {
        let runtime = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut state = runtime
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("The runtime database lock is unavailable."))?;
            anyhow::ensure!(state.is_none(), "The runtime database is already loaded.");
            *state = Some(Self::open_blocking(location)?);
            Ok(())
        })
        .await?
    }

    fn open_blocking(location: DatabaseLocation) -> Result<Database> {
        let canonical_directory = std::fs::canonicalize(&location.directory)?;
        let database_path = canonical_directory.join(
            location
                .database
                .file_name()
                .context("The database file name is unavailable.")?,
        );
        let lock_path = canonical_directory.join(
            location
                .ownership
                .file_name()
                .context("The database lock file name is unavailable.")?,
        );
        let store_lock = canonical_directory.join(
            location
                .store_lock
                .file_name()
                .context("The store lock file name is unavailable.")?,
        );
        let owner = Connection::open(&lock_path)?;
        private_file(&lock_path)?;
        owner.busy_timeout(std::time::Duration::ZERO)?;
        owner
            .execute_batch("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE")
            .context("The Happy agent SQLite database is already open in another process.")?;
        let storage_token = storage_lock(&store_lock)?;
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
            Ok(database)
        })();
        match result {
            Ok(database) => Ok(Database {
                database,
                owner,
                store_lock,
                storage_token,
            }),
            Err(error) => {
                release_storage_lock(&store_lock, &storage_token);
                Err(error)
            }
        }
    }

    pub async fn transact<T: Send + 'static>(
        self: &Arc<Self>,
        work: impl for<'a> FnOnce(&DatabaseContext<'a>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let runtime = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut state = runtime
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("The runtime database lock is unavailable."))?;
            let state = state
                .as_mut()
                .context("The runtime database is not open.")?;
            let transaction = state
                .database
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let context = DatabaseContext {
                database: &transaction,
                owner: Arc::as_ptr(&runtime) as usize,
                after_commit: std::cell::RefCell::new(Vec::new()),
                claims: std::cell::RefCell::new(std::collections::BTreeSet::new()),
                operations: std::cell::RefCell::new(std::collections::BTreeSet::new()),
            };
            let value = work(&context)?;
            let observers = context.after_commit.into_inner();
            transaction.commit()?;
            for observer in observers {
                observer();
            }
            Ok(value)
        })
        .await?
    }

    pub async fn migrate(
        self: &Arc<Self>,
        module: &'static str,
        migrations: &'static [(&'static str, &'static str)],
    ) -> Result<()> {
        let runtime = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut state = runtime
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("The runtime database lock is unavailable."))?;
            migrate(
                &mut state
                    .as_mut()
                    .context("The runtime database is not open.")?
                    .database,
                module,
                migrations,
            )
        })
        .await?
    }

    pub async fn migrate_native(self: &Arc<Self>, module: &'static str, migrations: &'static [NativeMigration]) -> Result<()> {
        let keys = migrations.iter().map(|migration| migration.key).collect::<Vec<_>>();
        let applied = self.transact(move |ctx| applied_prefix(ctx.database(), module, &keys)).await?;
        for (index, migration) in migrations.iter().copied().enumerate().skip(applied) {
            self.transact(move |ctx| {
                let keys = migrations.iter().map(|migration| migration.key).collect::<Vec<_>>();
                let current = applied_prefix(ctx.database(), module, &keys)?;
                if current > index { return Ok(()); }
                anyhow::ensure!(current == index, "The native migration sequence changed during application.");
                (migration.apply)(ctx)?;
                ctx.database().execute("INSERT INTO happy_agent_migrations(module_key,migration_key,position) VALUES(?1,?2,?3)", params![module,migration.key,index as i64])?;
                Ok(())
            }).await?;
        }
        Ok(())
    }

    pub async fn close(self: &Arc<Self>) -> Result<()> {
        let runtime = self.clone();
        tokio::task::spawn_blocking(move || runtime.close_blocking()).await?
    }
    fn close_blocking(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("The runtime database lock is unavailable."))?;
        if let Some(database) = state.take() {
            let Database {
                database,
                owner,
                store_lock,
                storage_token,
            } = database;
            if let Err((database, error)) = database.close() {
                *state = Some(Database {
                    database,
                    owner,
                    store_lock,
                    storage_token,
                });
                return Err(error.into());
            }
            owner.execute_batch("ROLLBACK")?;
            release_storage_lock(&store_lock, &storage_token);
        }
        Ok(())
    }
}

impl Drop for SqliteDatabase {
    fn drop(&mut self) {
        let _ = self.close_blocking();
    }
}

fn migrate(database: &mut Connection, module: &str, migrations: &[(&str, &str)]) -> Result<()> {
    let keys = migrations.iter().map(|migration| migration.0).collect::<Vec<_>>();
    let applied = applied_prefix(database, module, &keys)?;
    for (index, (key, sql)) in migrations.iter().enumerate().skip(applied) {
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(sql)?;
        transaction.execute("INSERT INTO happy_agent_migrations(module_key,migration_key,position) VALUES(?1,?2,?3)",params![module,key,index as i64])?;
        transaction.commit()?;
    }
    Ok(())
}
fn applied_prefix(database: &Connection, module: &str, keys: &[&str]) -> Result<usize> {
    let applied = {
        let mut statement = database.prepare("SELECT migration_key,position FROM happy_agent_migrations WHERE module_key=?1 ORDER BY position LIMIT ?2")?;
        statement
            .query_map(params![module, i64::try_from(keys.len().saturating_add(1))?], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (index, (key, position)) in applied.iter().enumerate() {
        if keys.get(index).copied() != Some(key.as_str())
            || *position != index as i64
        {
            bail!(
                "The applied migrations for module \"{module}\" are not a prefix of its current migrations."
            );
        }
    }
    Ok(applied.len())
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
                    && u32::try_from(pid).is_ok_and(process_running)
                {
                    bail!("The Happy agent store is already owned by process {pid}.");
                }
                match std::fs::remove_file(path) {
                    Ok(()) => (),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                    Err(error) => return Err(error.into()),
                }
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

fn private_file(path: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    anyhow::ensure!(
        !metadata.file_type().is_symlink() && metadata.is_file(),
        "The private Happy path is not an ordinary file: {}",
        path.display()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
fn process_running(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, 0) };
        if result < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM) {
            return false;
        }
        #[cfg(target_os = "linux")]
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            && stat
                .rsplit_once(')')
                .is_some_and(|(_, tail)| tail.split_whitespace().next() == Some("Z"))
        {
            return std::fs::read_dir(format!("/proc/{pid}/task"))
                .is_ok_and(|tasks| tasks.filter_map(Result::ok).take(2).count() > 1);
        }
        true
    }
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .is_ok_and(|output| {
                String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
            })
    }
}
