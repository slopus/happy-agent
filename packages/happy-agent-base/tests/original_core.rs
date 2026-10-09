use anyhow::Result;
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope, AgentSystem, DatabaseLocation, SqliteDatabase};
use happy_providers::{
    Compaction, Event, Outcome, RunRequest, Session, SessionContext, ToolDefinition, Usage,
};
use serde_json::json;
use std::{
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

struct PrivateRuntime {
    shutdown: CancellationToken,
    requests: mpsc::Sender<RunRequest>,
    gate_next_exit: AtomicBool,
    exited: Notify,
    gate: (Mutex<bool>, Condvar),
}
impl PrivateRuntime {
    fn release(&self) {
        *self.gate.0.lock().unwrap() = false;
        self.gate.1.notify_all();
    }
}
struct ReleaseOnDrop(Arc<PrivateRuntime>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release();
        self.0.shutdown.cancel();
    }
}
#[async_trait]
impl AgentModule for PrivateRuntime {
    fn name(&self) -> &'static str {
        "private-runtime"
    }
    fn shutdown(&self) -> Option<CancellationToken> {
        Some(self.shutdown.clone())
    }
    fn stage(&self, _id: &str, stage: Option<&str>) {
        if stage.is_none() && self.gate_next_exit.swap(false, Ordering::SeqCst) {
            let mut blocked = self.gate.0.lock().unwrap();
            *blocked = true;
            self.exited.notify_one();
            while *blocked {
                blocked = self.gate.1.wait(blocked).unwrap();
            }
        }
    }
    async fn instructions(&self, _scope: &AgentScope<'_>) -> Result<String> {
        Ok("Private reviewer instructions".into())
    }
    async fn session(
        &self,
        _scope: &AgentScope<'_>,
        tools: Vec<ToolDefinition>,
    ) -> Option<Result<Box<dyn Session>>> {
        assert!(tools.is_empty());
        Some(Ok(Box::new(PrivateSession(self.requests.clone()))))
    }
}
struct PrivateSession(mpsc::Sender<RunRequest>);
#[async_trait]
impl Session for PrivateSession {
    async fn run(
        &mut self,
        request: RunRequest,
        _cancel: CancellationToken,
        events: mpsc::Sender<Event>,
    ) {
        self.0.send(request).await.unwrap();
        for event in [
            Event::BlockStart,
            Event::TextStart,
            Event::TextDelta {
                delta: "<review><outcome>allow</outcome></review>".into(),
            },
            Event::TextEnd,
            Event::BlockStop,
            Event::Done {
                outcome: Outcome::Normal {
                    usage: Usage::default(),
                },
            },
        ] {
            events.send(event).await.unwrap();
        }
    }
    async fn compact(
        &mut self,
        _context: SessionContext,
        _prompt: Option<String>,
        _cancel: CancellationToken,
    ) -> Compaction {
        panic!("This private-core fixture does not request compaction.")
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn private_core_without_public_features_runs_input_accepted_during_worker_exit() {
    let directory = tempfile::tempdir().unwrap();
    let database = Arc::new(SqliteDatabase::new());
    database
        .load(DatabaseLocation {
            directory: directory.path().into(),
            database: directory.path().join("auto-agent.sqlite"),
            ownership: directory.path().join("auto-agent.sqlite.lock"),
            store_lock: directory.path().join("auto-agent.lock"),
        })
        .await
        .unwrap();
    let (requests, mut received) = mpsc::channel(4);
    let runtime = Arc::new(PrivateRuntime {
        shutdown: CancellationToken::new(),
        requests,
        gate_next_exit: AtomicBool::new(true),
        exited: Notify::new(),
        gate: (Mutex::new(false), Condvar::new()),
    });
    let _release = ReleaseOnDrop(runtime.clone());
    let system = Arc::new(AgentSystem::new(database.clone(), vec![runtime.clone()]).unwrap());
    let owner = system.clone();
    database.transact(move |ctx| {
        owner.create(ctx, "reviewerfixture", &json!({"provenance":{"createdAt":1700000000000u64},"environment":{"osVersion":"fixture","platform":"linux","workingDirectory":"/","shell":"/bin/bash"},"modules":{},"metadata":{}}))?;
        owner.enqueue(ctx, "reviewerfixture", &json!({"id":"firstreview","message":{"role":"user","content":[{"type":"text","text":"Review the first action"}]},"metadata":{"messageOrigin":"agent"},"options":{"provider":"fixture","model":"review-model","effort":"low","permissionMode":"read_only"}}), false)
    }).await.unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.context.instructions, "Private reviewer instructions");
    tokio::time::timeout(Duration::from_secs(5), runtime.exited.notified())
        .await
        .unwrap();
    let owner = system.clone();
    database.transact(move |ctx| owner.enqueue(ctx, "reviewerfixture", &json!({"id":"secondreview","message":{"role":"user","content":[{"type":"text","text":"Review the next action"}]},"metadata":{"messageOrigin":"agent"}}), false)).await.unwrap();
    runtime.release();
    let second = tokio::time::timeout(Duration::from_secs(5), received.recv()).await;
    runtime.shutdown.cancel();
    system.close().await;
    let public_tables = database.transact(|ctx| {
        Ok(ctx.database().query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND (name LIKE 'happy_agent_module_history%' OR name LIKE 'happy_agent_usage%' OR name LIKE 'happy_agent_events%')", [], |row| row.get::<_, i64>(0))?)
    }).await.unwrap();
    database.close().await.unwrap();
    assert_eq!(
        public_tables, 0,
        "The private core must not require public feature tables."
    );
    let second = second
        .expect("Input accepted while the previous worker exits must start without another message")
        .unwrap();
    assert_eq!(second.context.messages.len(), 3);
    assert!(
        matches!(&second.context.messages[2].content()[0], happy_providers::Block::Text { text } if text == "Review the next action")
    );
}
