use anyhow::Result;
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope, AgentSystem, DatabaseLocation, SqliteDatabase, ToolAuthorization, ToolPermissionPolicy};
use happy_providers::{
    Compaction, Event, Outcome, RunRequest, Session, SessionContext, ToolDefinition, Usage,
};
use serde_json::json;
use std::{
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

struct MetadataOwner {
    shutdown: CancellationToken,
    system: Mutex<std::sync::Weak<AgentSystem>>,
    committed: Mutex<Vec<serde_json::Value>>,
    recursive_refused: AtomicBool,
}
#[async_trait]
impl AgentModule for MetadataOwner {
    fn name(&self) -> &'static str { "metadata-owner-fixture" }
    fn shutdown(&self) -> Option<CancellationToken> { Some(self.shutdown.clone()) }
    fn metadata_changed(&self, ctx: &happy_agent_base::DatabaseContext<'_>, scope: &AgentScope<'_>, change: &serde_json::Value) -> Result<()> {
        assert_eq!(scope.configuration["metadata"], change["metadata"]);
        ctx.put_value(scope.id, "fixture.metadata-owner", change)?;
        let system = self.system.lock().unwrap().upgrade().unwrap();
        self.recursive_refused.store(system.update_metadata(ctx, scope.id, &json!({"recursive":true})).is_err(), Ordering::Release);
        anyhow::ensure!(change["update"]["reject"] != true, "The owning hook rejected this metadata update.");
        Ok(())
    }
    fn metadata_committed(&self, _id: &str, _configuration: &serde_json::Value, change: &serde_json::Value) { self.committed.lock().unwrap().push(change.clone()); }
}

#[tokio::test]
async fn metadata_merges_the_transaction_snapshot_and_publishes_only_after_commit() {
    let directory = tempfile::tempdir().unwrap();
    let database = Arc::new(SqliteDatabase::new());
    database.load(DatabaseLocation { directory: directory.path().into(), database: directory.path().join("agent.sqlite"), ownership: directory.path().join("agent.sqlite.lock"), store_lock: directory.path().join("agent.lock") }).await.unwrap();
    let owner = Arc::new(MetadataOwner { shutdown: CancellationToken::new(), system: Mutex::new(std::sync::Weak::new()), committed: Mutex::new(Vec::new()), recursive_refused: AtomicBool::new(false) });
    let system = Arc::new(AgentSystem::new(database.clone(), vec![owner.clone()]).unwrap());
    *owner.system.lock().unwrap() = Arc::downgrade(&system);
    let target = system.clone();
    database.transact(move |ctx| target.create(ctx, "metadatafixture", &json!({"metadata":{"title":"Original","retained":true}}))).await.unwrap();
    let target = system.clone(); let observer = owner.clone();
    database.transact(move |ctx| {
        target.update_metadata(ctx, "metadatafixture", &json!({"title":"First"}))?;
        target.update_metadata(ctx, "metadatafixture", &json!({"color":"blue"}))?;
        assert!(observer.committed.lock().unwrap().is_empty());
        assert_eq!(target.configuration(ctx, "metadatafixture")?.unwrap()["metadata"], json!({"title":"First","retained":true,"color":"blue"}));
        Ok(())
    }).await.unwrap();
    assert!(owner.recursive_refused.load(Ordering::Acquire));
    assert_eq!(owner.committed.lock().unwrap().len(), 2);
    assert_eq!(owner.committed.lock().unwrap()[1]["previousMetadata"], json!({"title":"First","retained":true}));
    let target = system.clone();
    assert!(database.transact(move |ctx| target.update_metadata(ctx, "metadatafixture", &json!({"title":"Rejected","reject":true}))).await.is_err());
    assert_eq!(owner.committed.lock().unwrap().len(), 2);
    let target = system.clone();
    database.transact(move |ctx| {
        assert_eq!(target.configuration(ctx, "metadatafixture")?.unwrap()["metadata"], json!({"title":"First","retained":true,"color":"blue"}));
        assert_eq!(ctx.value("metadatafixture", "fixture.metadata-owner")?.unwrap()["update"], json!({"color":"blue"}));
        assert!(target.update_metadata(ctx, "metadatafixture", &json!({"title":123})).is_err());
        Ok(())
    }).await.unwrap();
    system.close().await; database.close().await.unwrap();
}

struct AuthorizedRuntime {
    shutdown: CancellationToken,
    executed: Mutex<Vec<(String, String)>>,
    refusals: AtomicUsize,
}
#[async_trait]
impl AgentModule for AuthorizedRuntime {
    fn name(&self) -> &'static str { "private-permission-fixture" }
    fn shutdown(&self) -> Option<CancellationToken> { Some(self.shutdown.clone()) }
    fn permission_policy(&self, _scope: &AgentScope<'_>, _call: &serde_json::Value) -> Option<Result<ToolPermissionPolicy>> {
        Some(Ok(ToolPermissionPolicy { should_review_in_auto_mode: true, should_run_in_full_access_in_auto_mode: false, requires_auto_or_full_access: false, action: "the fixture action".into(), instructions: None }))
    }
    async fn authorize_tool(&self, scope: &AgentScope<'_>, call: &serde_json::Value, _policy: &ToolPermissionPolicy, _cancel: CancellationToken) -> Option<ToolAuthorization> {
        let arguments: serde_json::Value = serde_json::from_str(call["call"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(scope.settings["permissionMode"], "auto", "The next action sees the persisted mode");
        Some(if arguments["step"] == "full" {
            let mut settings = scope.settings.clone(); settings["permissionMode"] = json!("full_access");
            ToolAuthorization::Continue { settings: Some(settings) }
        } else if arguments["step"] == "deny" {
            let count = self.refusals.fetch_add(1, Ordering::SeqCst) + 1;
            ToolAuthorization::Denied { message: happy_providers::Message::Tool { call_id: call["id"].as_str().unwrap().into(), content: vec![happy_providers::Block::text(&format!("Review refusal {count}"))], is_error: true, vendor: None }, stop_turn: count == 3 }
        } else { ToolAuthorization::Continue { settings: None } })
    }
    async fn execute_tool(&self, scope: &AgentScope<'_>, call: &serde_json::Value, _cancel: CancellationToken) -> Option<happy_providers::Message> {
        let arguments: serde_json::Value = serde_json::from_str(call["call"]["arguments"].as_str().unwrap()).unwrap();
        self.executed.lock().unwrap().push((arguments["step"].as_str().unwrap().into(), scope.settings["permissionMode"].as_str().unwrap().into()));
        Some(happy_providers::Message::Tool { call_id: call["id"].as_str().unwrap().into(), content: vec![happy_providers::Block::text("Ran once")], is_error: false, vendor: None })
    }
    async fn session(&self, _scope: &AgentScope<'_>, _tools: Vec<ToolDefinition>) -> Option<Result<Box<dyn Session>>> { Some(Ok(Box::new(AuthorizedSession))) }
}
struct AuthorizedSession;
#[async_trait]
impl Session for AuthorizedSession {
    async fn run(&mut self, _request: RunRequest, _cancel: CancellationToken, events: mpsc::Sender<Event>) {
        events.send(Event::BlockStart).await.unwrap();
        for (index, step) in ["full", "sandbox", "deny", "deny", "deny", "after"].into_iter().enumerate() {
            let call_id = format!("provider{index}");
            events.send(Event::ToolCallStart { call_id: call_id.clone(), name: "fixture".into(), namespace: None, server: false, vendor: None }).await.unwrap();
            events.send(Event::ToolCallEnd { call_id, arguments: json!({"step":step}).to_string(), incomplete: false, vendor: None }).await.unwrap();
        }
        events.send(Event::BlockStop).await.unwrap();
        events.send(Event::Done { outcome: Outcome::ToolCall { usage: Usage::default() } }).await.unwrap();
    }
    async fn compact(&mut self, _context: SessionContext, _prompt: Option<String>, _cancel: CancellationToken) -> Compaction { panic!("This fixture does not compact.") }
    async fn destroy(&mut self) {}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn authorization_scopes_one_execution_and_commits_the_last_refusal_before_stopping_the_batch() {
    let directory = tempfile::tempdir().unwrap();
    let database = Arc::new(SqliteDatabase::new());
    database.load(DatabaseLocation { directory: directory.path().into(), database: directory.path().join("auto-agent.sqlite"), ownership: directory.path().join("auto-agent.sqlite.lock"), store_lock: directory.path().join("auto-agent.lock") }).await.unwrap();
    let runtime = Arc::new(AuthorizedRuntime { shutdown: CancellationToken::new(), executed: Mutex::new(Vec::new()), refusals: AtomicUsize::new(0) });
    let system = Arc::new(AgentSystem::new(database.clone(), vec![runtime.clone()]).unwrap());
    let owner = system.clone();
    database.transact(move |ctx| {
        owner.create(ctx, "permissionreviewer", &json!({"provenance":{"createdAt":1700000000000u64},"environment":{"osVersion":"fixture","platform":"linux","workingDirectory":"/","shell":"/bin/bash"},"modules":{},"metadata":{}}))?;
        owner.enqueue(ctx, "permissionreviewer", &json!({"id":"permissioninput","message":{"role":"user","content":[{"type":"text","text":"Inspect this workspace"}]},"metadata":{"messageOrigin":"user"},"options":{"provider":"fixture","model":"fixture","effort":"low","permissionMode":"auto"}}), false)
    }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), system.wait_for_idle("permissionreviewer", &CancellationToken::new())).await.unwrap().unwrap();
    assert_eq!(*runtime.executed.lock().unwrap(), vec![("full".into(), "full_access".into()), ("sandbox".into(), "auto".into())]);
    database.transact(|ctx| {
        let stored: String = ctx.database().query_row("SELECT value_json FROM happy_agent_values WHERE owner_id='permissionreviewer' AND key='settings'", [], |row| row.get(0))?;
        assert_eq!(serde_json::from_str::<serde_json::Value>(&stored)?["permissionMode"], "auto");
        let mut statement = ctx.database().prepare("SELECT record_json FROM happy_agent_records WHERE owner_id='permissionreviewer' ORDER BY position")?;
        let records = statement.query_map([], |row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?.join("\n");
        assert!(records.contains("Review refusal 3"), "The stopping refusal remains a durable tool result");
        assert!(records.contains("The tool call was aborted."), "Later actions in the same batch never run");
        Ok(())
    }).await.unwrap();
    runtime.shutdown.cancel(); system.close().await; database.close().await.unwrap();
}

struct ManagedRuntime {
    shutdown: CancellationToken,
    requests: mpsc::Sender<(usize, usize, RunRequest)>,
    created: AtomicUsize,
    destroyed: Arc<AtomicUsize>,
    settled: Arc<Notify>,
}
#[async_trait]
impl AgentModule for ManagedRuntime {
    fn name(&self) -> &'static str {
        "managed-private-runtime"
    }
    fn shutdown(&self) -> Option<CancellationToken> {
        Some(self.shutdown.clone())
    }
    fn compatible(
        &self,
        _previous: &serde_json::Value,
        _next: &serde_json::Value,
    ) -> Option<Result<bool>> {
        Some(Ok(true))
    }
    fn session_key(
        &self,
        scope: &AgentScope<'_>,
        _tools: &[ToolDefinition],
    ) -> Result<Option<String>> {
        Ok(Some(
            scope.settings["provider"].as_str().unwrap().to_owned(),
        ))
    }
    async fn session(
        &self,
        _scope: &AgentScope<'_>,
        _tools: Vec<ToolDefinition>,
    ) -> Option<Result<Box<dyn Session>>> {
        Some(Ok(Box::new(ManagedSession {
            serial: self.created.fetch_add(1, Ordering::SeqCst),
            turns: 0,
            requests: self.requests.clone(),
            destroyed: self.destroyed.clone(),
        })))
    }
    fn settled(
        &self,
        ctx: &happy_agent_base::DatabaseContext<'_>,
        _scope: &AgentScope<'_>,
        _status: &str,
        _reason: &str,
    ) -> Result<()> {
        let settled = self.settled.clone();
        ctx.after_commit(move || settled.notify_one())
    }
}
struct ManagedSession {
    serial: usize,
    turns: usize,
    requests: mpsc::Sender<(usize, usize, RunRequest)>,
    destroyed: Arc<AtomicUsize>,
}
#[async_trait]
impl Session for ManagedSession {
    async fn run(
        &mut self,
        request: RunRequest,
        _cancel: CancellationToken,
        events: mpsc::Sender<Event>,
    ) {
        self.turns += 1;
        self.requests
            .send((self.serial, self.turns, request))
            .await
            .unwrap();
        for event in [
            Event::BlockStart,
            Event::TextStart,
            Event::TextDelta {
                delta: "Managed response".into(),
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
        panic!("This fixture does not compact.")
    }
    async fn destroy(&mut self) {
        self.destroyed.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn managed_private_session_survives_turns_and_compatible_model_changes_until_route_or_shutdown()
 {
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
    let destroyed = Arc::new(AtomicUsize::new(0));
    let runtime = Arc::new(ManagedRuntime {
        shutdown: CancellationToken::new(),
        requests,
        created: AtomicUsize::new(0),
        destroyed: destroyed.clone(),
        settled: Arc::new(Notify::new()),
    });
    let system = Arc::new(AgentSystem::new(database.clone(), vec![runtime.clone()]).unwrap());
    let owner = system.clone();
    database.transact(move |ctx| owner.create(ctx,"managedreviewer",&json!({"provenance":{"createdAt":1700000000000u64},"environment":{"osVersion":"fixture","platform":"linux","workingDirectory":"/","shell":"/bin/bash"},"modules":{},"metadata":{}}))).await.unwrap();
    for (id, provider, model, effort) in [
        ("firstmanaged", "fixture", "first-model", "low"),
        ("secondmanaged", "fixture", "compatible-model", "high"),
        ("thirdmanaged", "other", "compatible-model", "high"),
    ] {
        let owner = system.clone();
        database.transact(move |ctx| owner.enqueue(ctx,"managedreviewer",&json!({"id":id,"message":{"role":"user","content":[{"type":"text","text":id}]},"metadata":{"messageOrigin":"agent"},"options":{"provider":provider,"model":model,"effort":effort,"permissionMode":"read_only"}}),false)).await.unwrap();
        let (serial, turn, request) = tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), runtime.settled.notified())
            .await
            .unwrap();
        assert_eq!(request.model.as_deref(), Some(model));
        if id == "secondmanaged" {
            assert_eq!(
                (serial, turn),
                (0, 2),
                "A compatible next turn must use the same stateful session"
            );
            assert_eq!(runtime.created.load(Ordering::SeqCst), 1);
            assert_eq!(
                destroyed.load(Ordering::SeqCst),
                0,
                "Turn completion does not own the provider lifetime"
            );
        } else if id == "thirdmanaged" {
            assert_eq!((serial, turn), (1, 1));
            assert_eq!(runtime.created.load(Ordering::SeqCst), 2);
            assert_eq!(
                destroyed.load(Ordering::SeqCst),
                1,
                "Changing the construction route retires its old session"
            );
        }
    }
    runtime.shutdown.cancel();
    system.close().await;
    assert_eq!(
        destroyed.load(Ordering::SeqCst),
        2,
        "The system closes every retained provider session"
    );
    database.close().await.unwrap();
}

struct PrivateRuntime {
    shutdown: CancellationToken,
    requests: mpsc::Sender<RunRequest>,
    wait_once: AtomicBool,
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
        scope: &AgentScope<'_>,
        tools: Vec<ToolDefinition>,
    ) -> Option<Result<Box<dyn Session>>> {
        assert!(tools.is_empty());
        Some(Ok(Box::new(PrivateSession {
            requests: self.requests.clone(),
            wait_for_cancel: scope.id == "reviewerstopped"
                && self.wait_once.swap(false, Ordering::SeqCst),
        })))
    }
}
struct PrivateSession {
    requests: mpsc::Sender<RunRequest>,
    wait_for_cancel: bool,
}
#[async_trait]
impl Session for PrivateSession {
    async fn run(
        &mut self,
        request: RunRequest,
        cancel: CancellationToken,
        events: mpsc::Sender<Event>,
    ) {
        self.requests.send(request).await.unwrap();
        if self.wait_for_cancel {
            cancel.cancelled().await;
            events
                .send(Event::Done {
                    outcome: Outcome::Cancelled,
                })
                .await
                .unwrap();
            return;
        }
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
        wait_once: AtomicBool::new(false),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn aborting_a_private_review_preserves_queued_input_and_keeps_the_root_and_other_agents_alive()
 {
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
    let (requests, mut received) = mpsc::channel(8);
    let runtime = Arc::new(PrivateRuntime {
        shutdown: CancellationToken::new(),
        requests,
        wait_once: AtomicBool::new(true),
        gate_next_exit: AtomicBool::new(false),
        exited: Notify::new(),
        gate: (Mutex::new(false), Condvar::new()),
    });
    let _release = ReleaseOnDrop(runtime.clone());
    let system = Arc::new(AgentSystem::new(database.clone(), vec![runtime.clone()]).unwrap());
    let owner = system.clone();
    database.transact(move |ctx| {
        owner.create(ctx, "reviewerstopped", &json!({"provenance":{"createdAt":1700000000000u64},"environment":{"osVersion":"fixture","platform":"linux","workingDirectory":"/","shell":"/bin/bash"},"modules":{},"metadata":{}}))?;
        owner.enqueue(ctx, "reviewerstopped", &json!({"id":"firstreview","message":{"role":"user","content":[{"type":"text","text":"A review that waits"}]},"options":{"provider":"fixture","model":"review-model","effort":"low","permissionMode":"read_only"}}), false)
    }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), received.recv())
        .await
        .unwrap()
        .unwrap();
    let owner = system.clone();
    database.transact(move |ctx| owner.enqueue(ctx, "reviewerstopped", &json!({"id":"queuedreview","message":{"role":"user","content":[{"type":"text","text":"Keep this queued"}]}}), false)).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), system.abort("reviewerstopped"))
        .await
        .unwrap()
        .unwrap();
    assert!(!runtime.shutdown.is_cancelled());
    assert!(received.try_recv().is_err());
    let owner = system.clone();
    database.transact(move |ctx| {
        assert!(owner.owed(ctx, "reviewerstopped")?.is_none());
        let queued: i64 = ctx.database().query_row("SELECT count(*) FROM happy_agent_values WHERE owner_id='reviewerstopped' AND key GLOB 'send.*'", [], |row| row.get(0))?;
        assert_eq!(queued, 1);
        owner.create(ctx, "reviewerhealthy", &json!({"provenance":{"createdAt":1700000000000u64},"environment":{"osVersion":"fixture","platform":"linux","workingDirectory":"/","shell":"/bin/bash"},"modules":{},"metadata":{}}))?;
        owner.enqueue(ctx, "reviewerhealthy", &json!({"id":"healthyreview","message":{"role":"user","content":[{"type":"text","text":"The other reviewer still runs"}]},"options":{"provider":"fixture","model":"review-model","permissionMode":"read_only"}}), false)
    }).await.unwrap();
    let healthy = tokio::time::timeout(Duration::from_secs(5), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(&healthy.context.messages[0].content()[0], happy_providers::Block::Text { text } if text == "The other reviewer still runs")
    );
    let owner = system.clone();
    database.transact(move |ctx| owner.enqueue(ctx, "reviewerstopped", &json!({"id":"newreview","message":{"role":"user","content":[{"type":"text","text":"Start another review"}]}}), false)).await.unwrap();
    let resumed = tokio::time::timeout(Duration::from_secs(5), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resumed.context.messages.len(), 3);
    assert!(
        matches!(&resumed.context.messages[1].content()[0], happy_providers::Block::Text { text } if text == "Keep this queued")
    );
    runtime.shutdown.cancel();
    system.close().await;
    database.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_new_turn_accepted_after_abort_settlement_restarts_with_a_fresh_worker_lifetime() {
    let directory = tempfile::tempdir().unwrap();
    let database = Arc::new(SqliteDatabase::new());
    database.load(DatabaseLocation { directory: directory.path().into(), database: directory.path().join("auto-agent.sqlite"), ownership: directory.path().join("auto-agent.sqlite.lock"), store_lock: directory.path().join("auto-agent.lock") }).await.unwrap();
    let (requests, mut received) = mpsc::channel(4);
    let runtime = Arc::new(PrivateRuntime { shutdown: CancellationToken::new(), requests, wait_once: AtomicBool::new(true), gate_next_exit: AtomicBool::new(true), exited: Notify::new(), gate: (Mutex::new(false), Condvar::new()) });
    let _release = ReleaseOnDrop(runtime.clone());
    let system = Arc::new(AgentSystem::new(database.clone(), vec![runtime.clone()]).unwrap());
    let owner = system.clone();
    database.transact(move |ctx| {
        owner.create(ctx, "reviewerstopped", &json!({"provenance":{"createdAt":1700000000000u64},"environment":{"osVersion":"fixture","platform":"linux","workingDirectory":"/","shell":"/bin/bash"},"modules":{},"metadata":{}}))?;
        owner.enqueue(ctx, "reviewerstopped", &json!({"id":"firstabortedreview","message":{"role":"user","content":[{"type":"text","text":"Wait for abort"}]},"options":{"provider":"fixture","model":"review-model","permissionMode":"read_only"}}), false)
    }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), received.recv()).await.unwrap().unwrap();
    let owner = system.clone();
    database.transact(move |ctx| owner.request_abort(ctx, "reviewerstopped")).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), runtime.exited.notified()).await.unwrap();
    let owner = system.clone();
    database.transact(move |ctx| {
        assert!(owner.owed(ctx, "reviewerstopped")?.is_none(), "The aborted turn settled before the new input arrived");
        owner.enqueue(ctx, "reviewerstopped", &json!({"id":"freshreviewafterabort","message":{"role":"user","content":[{"type":"text","text":"Start a genuinely new turn"}]}}), false)
    }).await.unwrap();
    runtime.release();
    let restarted = tokio::time::timeout(Duration::from_secs(5), received.recv()).await;
    runtime.shutdown.cancel(); system.close().await; database.close().await.unwrap();
    let restarted = restarted.expect("A fresh turn accepted while the cancelled worker retires must start without another delivery").unwrap();
    assert!(matches!(&restarted.context.messages.last().unwrap().content()[0], happy_providers::Block::Text { text } if text == "Start a genuinely new turn"));
}
