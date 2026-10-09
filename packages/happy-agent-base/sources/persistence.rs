use crate::{
    AgentConfig, AgentEvent, Delivery, DeliveryOptions, PendingCall, QueuedMessage, Snapshot,
    Stage, identity,
};
use happy_providers::{Block, Message, SessionContext};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;

#[derive(Debug, thiserror::Error)]
#[error("Agent database operation failed: {0}")]
pub struct StorageError(pub String);
type Result<T> = std::result::Result<T, StorageError>;
fn failure(error: impl std::fmt::Display) -> StorageError {
    StorageError(error.to_string())
}

struct Database {
    connection: Connection,
    _owner: Connection,
}
/// All SQL, including reads, runs on Tokio's blocking pool under one owned lock.
#[derive(Clone)]
pub struct Store {
    inner: Arc<Mutex<Option<Database>>>,
    runtimes: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}
pub(crate) struct RuntimeLease {
    id: String,
    runtimes: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}
impl Drop for RuntimeLease {
    fn drop(&mut self) {
        if let Ok(mut runtimes) = self.runtimes.lock() {
            runtimes.remove(&self.id);
        }
    }
}
pub struct Tx<'a> {
    database: &'a Connection,
    events: std::cell::RefCell<Vec<AgentEvent>>,
}

impl Store {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_owned();
        let database = tokio::task::spawn_blocking(move || open_database(path))
            .await
            .map_err(failure)??;
        Ok(Self {
            inner: Arc::new(Mutex::new(Some(database))),
            runtimes: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
        })
    }
    pub(crate) fn claim_runtime(&self, id: &str) -> Result<RuntimeLease> {
        let mut runtimes = self
            .runtimes
            .lock()
            .map_err(|_| failure("The live agent registry is unavailable."))?;
        if !runtimes.insert(id.to_owned()) {
            return Err(failure(
                "This agent already has a live runtime in this store.",
            ));
        }
        Ok(RuntimeLease {
            id: id.to_owned(),
            runtimes: self.runtimes.clone(),
        })
    }
    /// The closure may compose any number of operations on the same immutable Tx.
    /// Notifications are returned only after the outer commit has succeeded.
    pub async fn transact<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Tx<'_>) -> Result<T> + Send + 'static,
    ) -> Result<(T, Vec<AgentEvent>)> {
        let mut guard = self.inner.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || {
            let database = guard
                .as_mut()
                .ok_or_else(|| failure("The agent database is closed."))?;
            let transaction = database
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(failure)?;
            let ctx = Tx {
                database: &transaction,
                events: std::cell::RefCell::new(Vec::new()),
            };
            let value = work(&ctx)?;
            let events = ctx.events.into_inner();
            transaction.commit().map_err(failure)?;
            Ok((value, events))
        })
        .await
        .map_err(failure)?
    }
    pub async fn query_snapshot(&self, id: String) -> Result<Snapshot> {
        self.transact(move |ctx| ctx.query_snapshot(&id))
            .await
            .map(|(snapshot, _)| snapshot)
    }
    pub async fn query_active(&self, id: String) -> Result<bool> {
        self.transact(move |ctx| ctx.query_stage(&id).map(|s| s.active()))
            .await
            .map(|(active, _)| active)
    }
    pub async fn close(&self) -> Result<()> {
        let mut guard = self.inner.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || {
            if let Some(database) = guard.take() {
                database._owner.execute_batch("ROLLBACK").map_err(failure)?;
                database
                    .connection
                    .close()
                    .map_err(|(_, error)| failure(error))?;
            }
            Ok(())
        })
        .await
        .map_err(failure)?
    }
}

impl Tx<'_> {
    pub fn create_agent(&self, config: &AgentConfig) -> Result<()> {
        let config = encode(config)?;
        let agent: AgentConfig = serde_json::from_str(&config).map_err(failure)?;
        self.database.execute("INSERT INTO ha_agents(id,config,stage) VALUES(?1,?2,?3) ON CONFLICT(id) DO NOTHING",params![agent.id,config,encode(&Stage::Idle)?]).map_err(failure)?;
        Ok(())
    }
    pub fn query_stage(&self, id: &str) -> Result<Stage> {
        let value = self
            .database
            .query_row("SELECT stage FROM ha_agents WHERE id=?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(failure)?;
        serde_json::from_str(&value).map_err(failure)
    }
    pub fn set_stage(&self, id: &str, stage: &Stage) -> Result<()> {
        self.database
            .execute(
                "UPDATE ha_agents SET stage=?2 WHERE id=?1",
                params![id, encode(stage)?],
            )
            .map_err(failure)?;
        Ok(())
    }
    pub fn query_snapshot(&self, id: &str) -> Result<Snapshot> {
        let (config, stage, profile) = self
            .database
            .query_row(
                "SELECT config,stage,profile FROM ha_agents WHERE id=?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .map_err(failure)?;
        let mut query = self
            .database
            .prepare("SELECT id,message FROM ha_messages WHERE agent=?1 ORDER BY sequence")
            .map_err(failure)?;
        let rows = query
            .query_map([id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(failure)?;
        let mut history = Vec::new();
        for row in rows {
            let (id, message) = row.map_err(failure)?;
            history.push((id, serde_json::from_str(&message).map_err(failure)?));
        }
        Ok(Snapshot {
            config: serde_json::from_str(&config).map_err(failure)?,
            stage: serde_json::from_str(&stage).map_err(failure)?,
            profile,
            history,
        })
    }
    pub fn deliver(
        &self,
        id: &str,
        message: Message,
        options: DeliveryOptions,
        steering: bool,
    ) -> Result<Delivery> {
        let delivery_id = options.id.clone().unwrap_or_else(identity);
        let inserted = self
            .database
            .execute(
                "INSERT INTO ha_deliveries(agent,id) VALUES(?1,?2) ON CONFLICT DO NOTHING",
                params![id, delivery_id],
            )
            .map_err(failure)?;
        if inserted != 0 {
            let delivery = QueuedMessage {
                id: delivery_id.clone(),
                message,
                options,
                steering,
            };
            self.database
                .execute(
                    "INSERT INTO ha_queue(agent,id,steering,message) VALUES(?1,?2,?3,?4)",
                    params![id, delivery_id, steering, encode(&delivery)?],
                )
                .map_err(failure)?;
            if matches!(
                self.query_stage(id)?,
                Stage::Idle | Stage::Settlement { .. }
            ) {
                self.set_stage(
                    id,
                    &Stage::Inference {
                        inference_id: identity(),
                        completed_blocks: Vec::new(),
                        accept_send: true,
                        prepared: false,
                    },
                )?;
            }
        }
        Ok(Delivery {
            id: delivery_id,
            created: inserted != 0,
        })
    }
    pub fn query_queued(&self, id: &str) -> Result<Option<QueuedMessage>> {
        let row=self.database.query_row("SELECT message FROM ha_queue WHERE agent=?1 ORDER BY steering DESC,sequence LIMIT 1",[id],|r|r.get::<_,String>(0)).optional().map_err(failure)?;
        row.map(|value| serde_json::from_str(&value).map_err(failure))
            .transpose()
    }
    pub fn accept_next(&self, id: &str) -> Result<Option<QueuedMessage>> {
        let stage = self.query_stage(id)?;
        let Stage::Inference {
            accept_send,
            prepared,
            ..
        } = stage
        else {
            return Ok(None);
        };
        if prepared {
            return Ok(None);
        }
        let row=self.database.query_row("SELECT message FROM ha_queue WHERE agent=?1 AND (steering=1 OR ?2) ORDER BY steering DESC,sequence LIMIT 1",params![id,accept_send],|r|r.get::<_,String>(0)).optional().map_err(failure)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let delivery: QueuedMessage = serde_json::from_str(&row).map_err(failure)?;
        let mut snapshot = self.query_snapshot(id)?;
        if delivery.options.profile != snapshot.profile {
            self.database
                .execute("DELETE FROM ha_messages WHERE agent=?1", [id])
                .map_err(failure)?;
            self.database
                .execute("DELETE FROM ha_kv WHERE agent=?1 AND scope='history'", [id])
                .map_err(failure)?;
            self.database
                .execute(
                    "UPDATE ha_agents SET profile=?2 WHERE id=?1",
                    params![id, delivery.options.profile],
                )
                .map_err(failure)?;
        }
        if let Some(mode) = delivery.options.permission_mode {
            snapshot.config.permission_mode = mode;
            self.database
                .execute(
                    "UPDATE ha_agents SET config=?2 WHERE id=?1",
                    params![id, encode(&snapshot.config)?],
                )
                .map_err(failure)?;
        }
        let mut message = delivery.message.clone();
        let mut requested = None;
        if let Message::User { content } = &mut message {
            content.retain(|block| {
                if let Block::ToolCallRequest { name, arguments } = block {
                    requested = Some((name.clone(), Value::Object(arguments.clone()).to_string()));
                    false
                } else {
                    true
                }
            });
        }
        if !message.content().is_empty() {
            self.append_message(id, &delivery.id, &message)?;
        }
        if let Some((name, arguments)) = requested {
            let call = PendingCall {
                id: identity(),
                provider_call_id: identity(),
                name,
                namespace: None,
                arguments,
                incomplete: false,
                dispatched: false,
                vendor: None,
            };
            self.append_message(
                id,
                &identity(),
                &Message::Assistant {
                    content: vec![Block::ToolCall {
                        call_id: call.provider_call_id.clone(),
                        name: call.name.clone(),
                        namespace: None,
                        arguments: call.arguments.clone(),
                        incomplete: false,
                        vendor: None,
                        server: false,
                    }],
                },
            )?;
            self.set_stage(id, &Stage::Tools { calls: vec![call] })?;
        }
        if let Stage::Inference {
            inference_id,
            completed_blocks,
            ..
        } = self.query_stage(id)?
        {
            self.set_stage(
                id,
                &Stage::Inference {
                    inference_id,
                    completed_blocks,
                    accept_send: false,
                    prepared: true,
                },
            )?;
        }
        self.database
            .execute(
                "DELETE FROM ha_queue WHERE agent=?1 AND id=?2",
                params![id, delivery.id],
            )
            .map_err(failure)?;
        self.emit(AgentEvent::MessageAccepted {
            agent_id: id.to_owned(),
            delivery: delivery.clone(),
        });
        Ok(Some(delivery))
    }
    pub fn append_message(&self, id: &str, message_id: &str, message: &Message) -> Result<()> {
        self.database
            .execute(
                "INSERT INTO ha_messages(agent,id,message) VALUES(?1,?2,?3)",
                params![id, message_id, encode(message)?],
            )
            .map_err(failure)?;
        Ok(())
    }
    pub fn commit_block(&self, id: &str, blocks: &[Block]) -> Result<()> {
        if blocks.is_empty() {
            return Ok(());
        }
        let Stage::Inference {
            inference_id,
            mut completed_blocks,
            accept_send,
            prepared,
        } = self.query_stage(id)?
        else {
            return Err(failure("An inference block has no active inference."));
        };
        self.append_message(
            id,
            &identity(),
            &Message::Assistant {
                content: blocks.to_vec(),
            },
        )?;
        completed_blocks.extend_from_slice(blocks);
        self.set_stage(
            id,
            &Stage::Inference {
                inference_id,
                completed_blocks,
                accept_send,
                prepared,
            },
        )
    }
    pub fn dispatch_call(&self, id: &str, call: &PendingCall) -> Result<()> {
        let Stage::Tools { mut calls } = self.query_stage(id)? else {
            return Err(failure("The tool batch is not active."));
        };
        if let Some(pending) = calls.iter_mut().find(|c| c.id == call.id) {
            pending.dispatched = true;
        }
        self.set_stage(id, &Stage::Tools { calls })?;
        self.emit(AgentEvent::ToolStarted {
            agent_id: id.to_owned(),
            call: call.clone(),
        });
        Ok(())
    }
    pub fn query_call_result(&self, id: &str, call: &str) -> Result<Option<Message>> {
        let value = self
            .database
            .query_row(
                "SELECT result FROM ha_calls WHERE agent=?1 AND id=?2",
                params![id, call],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(failure)?;
        value
            .map(|v| serde_json::from_str(&v).map_err(failure))
            .transpose()
    }
    /// First committed result wins, atomically with caller-owned KV mutations.
    pub fn commit_call(&self, id: &str, call: &PendingCall, result: &Message) -> Result<bool> {
        let Stage::Tools { calls } = self.query_stage(id)? else {
            return Err(failure("This tool invocation has already settled."));
        };
        if !calls.iter().any(|c| c.id == call.id) {
            return Err(failure("This tool invocation is no longer active."));
        }
        let inserted = self
            .database
            .execute(
                "INSERT INTO ha_calls(agent,id,result) VALUES(?1,?2,?3) ON CONFLICT DO NOTHING",
                params![id, call.id, encode(result)?],
            )
            .map_err(failure)?;
        if inserted != 0 {
            self.database
                .execute(
                    "DELETE FROM ha_kv WHERE agent=?1 AND scope=?2",
                    params![id, format!("call:{}", call.id)],
                )
                .map_err(failure)?;
        }
        Ok(inserted != 0)
    }
    pub fn complete_batch(&self, id: &str, calls: &[PendingCall]) -> Result<()> {
        for call in calls {
            let result = self
                .query_call_result(id, &call.id)?
                .ok_or_else(|| failure("A tool batch has an unfinished result."))?;
            self.append_message(id, &identity(), &result)?;
            self.emit(AgentEvent::ToolCompleted {
                agent_id: id.to_owned(),
                call_id: call.id.clone(),
                message: result,
            });
        }
        self.database
            .execute("DELETE FROM ha_calls WHERE agent=?1", [id])
            .map_err(failure)?;
        self.set_stage(
            id,
            &Stage::Inference {
                inference_id: identity(),
                completed_blocks: Vec::new(),
                accept_send: false,
                prepared: false,
            },
        )
    }
    pub fn settle(&self, id: &str, aborted: bool, error: Option<String>) -> Result<bool> {
        let settlement_id = match self.query_stage(id)? {
            Stage::Settlement { settlement_id } => settlement_id,
            _ => identity(),
        };
        // A concurrent delivery and settlement compose through this exact transaction.
        let restart = !aborted && error.is_none() && self.query_queued(id)?.is_some();
        self.set_stage(
            id,
            &if restart {
                Stage::Inference {
                    inference_id: identity(),
                    completed_blocks: Vec::new(),
                    accept_send: true,
                    prepared: false,
                }
            } else {
                Stage::Idle
            },
        )?;
        self.database
            .execute(
                "DELETE FROM ha_kv WHERE agent=?1 AND (scope LIKE 'call:%' OR scope='run')",
                [id],
            )
            .map_err(failure)?;
        self.emit(AgentEvent::Settled {
            agent_id: id.to_owned(),
            settlement_id,
            aborted,
            error,
        });
        Ok(restart)
    }
    pub fn replace_context(
        &self,
        id: &str,
        context: &SessionContext,
        usage: happy_providers::Usage,
    ) -> Result<()> {
        let replaced_ids = self
            .query_snapshot(id)?
            .history
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        self.database
            .execute("DELETE FROM ha_messages WHERE agent=?1", [id])
            .map_err(failure)?;
        self.database
            .execute("DELETE FROM ha_kv WHERE agent=?1 AND scope='history'", [id])
            .map_err(failure)?;
        self.database.execute("DELETE FROM ha_deliveries WHERE agent=?1 AND id NOT IN (SELECT id FROM ha_queue WHERE agent=?1)",[id]).map_err(failure)?;
        for message in &context.messages {
            self.append_message(id, &identity(), message)?;
        }
        self.set_stage(
            id,
            &Stage::Inference {
                inference_id: identity(),
                completed_blocks: Vec::new(),
                accept_send: false,
                prepared: false,
            },
        )?;
        self.emit(AgentEvent::Compacted {
            agent_id: id.to_owned(),
            replaced_ids,
            usage,
        });
        Ok(())
    }
    pub fn query_kv(&self, id: &str, scope: &str, key: &str) -> Result<Option<Value>> {
        let row = self
            .database
            .query_row(
                "SELECT value FROM ha_kv WHERE agent=?1 AND scope=?2 AND key=?3",
                params![id, scope, key],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(failure)?;
        row.map(|value| serde_json::from_str(&value).map_err(failure))
            .transpose()
    }
    pub fn set_kv(&self, id: &str, scope: &str, key: &str, value: &Value) -> Result<()> {
        if let Some(call_id) = scope.strip_prefix("call:") {
            let Stage::Tools { calls } = self.query_stage(id)? else {
                return Err(failure("The tool state lifetime has ended."));
            };
            if !calls.iter().any(|c| c.id == call_id)
                || self.query_call_result(id, call_id)?.is_some()
            {
                return Err(failure("The tool state lifetime has ended."));
            }
        }
        self.database.execute("INSERT INTO ha_kv(agent,scope,key,value) VALUES(?1,?2,?3,?4) ON CONFLICT(agent,scope,key) DO UPDATE SET value=excluded.value",params![id,scope,key,encode(value)?]).map_err(failure)?;
        Ok(())
    }
    pub fn emit(&self, event: AgentEvent) {
        self.events.borrow_mut().push(event);
    }
}

fn open_database(path: PathBuf) -> Result<Database> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(failure)?;
    }
    let path = if path.exists() {
        std::fs::canonicalize(&path).map_err(failure)?
    } else {
        std::fs::canonicalize(path.parent().unwrap_or_else(|| Path::new(".")))
            .map_err(failure)?
            .join(
                path.file_name()
                    .ok_or_else(|| failure("A database file name is required."))?,
            )
    };
    let mut owner_path = path.as_os_str().to_owned();
    owner_path.push(".owner.sqlite");
    let owner = Connection::open(PathBuf::from(owner_path)).map_err(failure)?;
    owner
        .busy_timeout(std::time::Duration::ZERO)
        .map_err(failure)?;
    owner
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|_| failure("Another Happy Agent process owns this store."))?;
    let connection = Connection::open(path).map_err(failure)?;
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")
        .map_err(failure)?;
    let generation = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
        .map_err(failure)?;
    if generation == 0 {
        let tables=connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",[],|row|row.get::<_,u32>(0)).map_err(failure)?;
        if tables != 0 {
            return Err(failure(
                "This database belongs to the previous runtime. Select a new Rust store; importing old databases is not implemented.",
            ));
        }
        connection.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE ha_agents(id TEXT PRIMARY KEY,config TEXT NOT NULL,stage TEXT NOT NULL,profile TEXT);
            CREATE TABLE ha_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,agent TEXT NOT NULL REFERENCES ha_agents(id),id TEXT NOT NULL,message TEXT NOT NULL,UNIQUE(agent,id));
            CREATE TABLE ha_queue(sequence INTEGER PRIMARY KEY AUTOINCREMENT,agent TEXT NOT NULL REFERENCES ha_agents(id),id TEXT NOT NULL,steering INTEGER NOT NULL,message TEXT NOT NULL,UNIQUE(agent,id));
            CREATE TABLE ha_deliveries(agent TEXT NOT NULL REFERENCES ha_agents(id),id TEXT NOT NULL,PRIMARY KEY(agent,id));
            CREATE TABLE ha_calls(agent TEXT NOT NULL REFERENCES ha_agents(id),id TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(agent,id));
            CREATE TABLE ha_kv(agent TEXT NOT NULL REFERENCES ha_agents(id),scope TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(agent,scope,key));
            CREATE INDEX ha_history ON ha_messages(agent,sequence);
            CREATE INDEX ha_queued ON ha_queue(agent,steering DESC,sequence);
            PRAGMA user_version=1001; COMMIT;").map_err(failure)?;
    } else if generation != 1001 {
        return Err(failure("This Rust database generation is unsupported."));
    }
    Ok(Database {
        connection,
        _owner: owner,
    })
}
fn encode(value: &impl serde::Serialize) -> Result<String> {
    serde_json::to_string(value).map_err(failure)
}
