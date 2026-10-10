//! Source's bounded, daemon-lifetime projection of detached shell sessions.
use super::CommandSession;
use crate::product::{
    identity::{Versions, now},
    schemas::Schemas,
};
use anyhow::Result;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
};

const EXITED_PER_AGENT: usize = 256;
const EXITED_TOTAL: usize = 4096;

pub(super) struct Processes {
    schemas: Schemas,
    state: Mutex<State>,
    transitions: tokio::sync::Mutex<()>,
    listeners: Mutex<BTreeMap<u64, ProcessEventListener>>,
    next_listener: AtomicU64,
}
pub type ProcessEventListener = Arc<dyn Fn(Value) + Send + Sync>;
pub struct ProcessSubscription {
    owner: Weak<Processes>,
    id: u64,
}
impl Drop for ProcessSubscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            owner
                .listeners
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&self.id);
        }
    }
}
struct State {
    records: BTreeMap<u64, Value>,
    exited: VecDeque<u64>,
    versions: Versions,
}
impl Processes {
    pub(super) fn new() -> Result<Self> {
        let schemas = Schemas::new()?;
        for name in [
            "computeProcess",
            "computeProcessChanges",
            "computeProcessEvent",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        Ok(Self {
            schemas,
            state: Mutex::new(State {
                records: BTreeMap::new(),
                exited: VecDeque::new(),
                versions: Versions::new(),
            }),
            transitions: tokio::sync::Mutex::new(()),
            listeners: Mutex::new(BTreeMap::new()),
            next_listener: AtomicU64::new(1),
        })
    }
    pub(super) fn on_event(
        self: &Arc<Self>,
        listener: ProcessEventListener,
    ) -> Result<ProcessSubscription> {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The native process observer limit has been reached."
        );
        let id = self.next_listener.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(ProcessSubscription {
            owner: Arc::downgrade(self),
            id,
        })
    }
    pub(super) fn list(&self, agent: &str) -> Vec<Value> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .records
            .values()
            .rev()
            .filter(|record| record["agentId"] == agent)
            .cloned()
            .collect()
    }
    pub(super) fn running(&self, agent: &str) -> usize {
        self.list(agent)
            .iter()
            .filter(|record| record["status"] == "running")
            .count()
    }
    pub(super) fn agents(&self) -> Vec<String> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .records
            .values()
            .filter_map(|record| record["agentId"].as_str().map(str::to_owned))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    pub(super) fn find(&self, agent: &str, id: &str) -> Option<(u64, Value)> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .records
            .iter()
            .find(|(_, record)| record["agentId"] == agent && record["id"] == id)
            .map(|(session, record)| (*session, record.clone()))
    }
    pub(super) async fn detach(&self, session: &Arc<CommandSession>) -> Result<()> {
        let _transition = self.transitions.lock().await;
        let started = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.records.contains_key(&session.id) {
                return Ok(());
            }
            let record = json!({"id":cuid2::create_id(),"agentId":session.owner,"command":session.command,"startedAt":session.started_at,"endedAt":null,"exitCode":null,"status":"running","version":state.versions.next()});
            anyhow::ensure!(
                self.schemas.valid("computeProcess", &record)?,
                "The native background process is invalid."
            );
            state.records.insert(session.id, record.clone());
            json!({"type":"process_started","agentId":session.owner,"process":record,"runningProcesses":running(&state, &session.owner)})
        };
        self.emit(started)?;
        // An exit between the initial read and detachment must finalize this
        // same identity. The supervision continuation serializes here too.
        let finished = {
            let state = session
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.finished.then_some(state.exit)
        };
        if let Some(exit) = finished {
            self.exit_locked(session.id, exit).await?;
        }
        Ok(())
    }
    pub(super) async fn exit(&self, session: u64, code: Option<i32>) -> Result<()> {
        let _transition = self.transitions.lock().await;
        self.exit_locked(session, code).await
    }
    pub(super) async fn detach_remote(
        &self,
        session: u64,
        owner: &str,
        command: &str,
        started: u64,
        finished: Option<Option<i32>>,
    ) -> Result<()> {
        let _transition = self.transitions.lock().await;
        let event = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.records.contains_key(&session) {
                return Ok(());
            }
            let record = json!({"id":cuid2::create_id(),"agentId":owner,"command":command,"startedAt":started,"endedAt":null,"exitCode":null,"status":"running","version":state.versions.next()});
            anyhow::ensure!(
                self.schemas.valid("computeProcess", &record)?,
                "The runner background process is invalid."
            );
            state.records.insert(session, record.clone());
            json!({"type":"process_started","agentId":owner,"process":record,"runningProcesses":running(&state,owner)})
        };
        self.emit(event)?;
        if let Some(exit) = finished {
            self.exit_locked(session, exit).await?;
        }
        Ok(())
    }
    pub(super) async fn exit_all(&self, agent: &str) -> Result<()> {
        let _transition = self.transitions.lock().await;
        let sessions = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .records
            .iter()
            .filter(|(_, record)| record["agentId"] == agent && record["status"] == "running")
            .map(|(id, _)| *id)
            .collect::<Vec<_>>();
        for session in sessions {
            self.exit_locked(session, None).await?;
        }
        Ok(())
    }
    async fn exit_locked(&self, session: u64, code: Option<i32>) -> Result<()> {
        let event = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some(before) = state
                .records
                .get(&session)
                .filter(|record| record["status"] == "running")
                .cloned()
            else {
                return Ok(());
            };
            let agent = before["agentId"].as_str().unwrap().to_owned();
            let version = state.versions.next();
            let changes = json!({"endedAt":now(),"exitCode":code,"status":"exited"});
            anyhow::ensure!(
                self.schemas.valid("computeProcessChanges", &changes)?,
                "The native process completion is invalid."
            );
            let mut after = before.clone();
            for (key, value) in changes.as_object().unwrap() {
                after[key] = value.clone();
            }
            after["version"] = json!(version);
            anyhow::ensure!(
                self.schemas.valid("computeProcess", &after)?,
                "The completed native process is invalid."
            );
            state.records.insert(session, after);
            state.exited.push_back(session);
            let event = json!({"type":"process_exited","agentId":agent,"processId":before["id"],"previousVersion":before["version"],"version":version,"changes":changes,"runningProcesses":running(&state, &agent)});
            trim(&mut state, &agent);
            event
        };
        self.emit(event)
    }
    fn emit(&self, event: Value) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid("computeProcessEvent", &event)?,
            "The native process event is invalid."
        );
        let listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        // Source's synchronous observers see the visible transition before an
        // abort sends its signal. Observation never undoes process lifecycle.
        // API observers append to a bounded journal and enqueue bounded metadata
        // work here; they must not start asynchronous work for every callback.
        for listener in listeners {
            let _ =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(event.clone())));
        }
        Ok(())
    }
}
fn running(state: &State, agent: &str) -> usize {
    state
        .records
        .values()
        .filter(|record| record["agentId"] == agent && record["status"] == "running")
        .count()
}
fn trim(state: &mut State, agent: &str) {
    let exited = state
        .exited
        .iter()
        .filter(|id| {
            state
                .records
                .get(id)
                .is_some_and(|record| record["agentId"] == agent)
        })
        .copied()
        .collect::<Vec<_>>();
    for id in exited
        .iter()
        .take(exited.len().saturating_sub(EXITED_PER_AGENT))
    {
        state.records.remove(id);
    }
    state.exited.retain(|id| state.records.contains_key(id));
    while state.exited.len() > EXITED_TOTAL {
        if let Some(id) = state.exited.pop_front() {
            state.records.remove(&id);
        }
    }
}
