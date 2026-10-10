use anyhow::Result;
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope, AgentSystem, DatabaseContext, DatabaseLocation, SqliteDatabase};
use happy_providers::{Block, Compaction, Event, Message, Outcome, RunRequest, Session, SessionContext, ToolDefinition, Usage};
use serde_json::{Value, json};
use std::{sync::{Arc, atomic::{AtomicUsize, Ordering}}, time::Duration};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Owner { shutdown: CancellationToken, stop_after_claim: bool, executions: AtomicUsize }
#[async_trait]
impl AgentModule for Owner {
    fn name(&self) -> &'static str { "transactional-attachment-fixture" }
    fn shutdown(&self) -> Option<CancellationToken> { Some(self.shutdown.clone()) }
    fn execute_transactional_tool(&self, ctx: &DatabaseContext<'_>, scope: &AgentScope<'_>, call: &Value) -> Option<Result<Message>> {
        if call["call"]["name"] != "fixture_attachment" { return None; }
        Some((|| {
            self.executions.fetch_add(1, Ordering::SeqCst);
            let count = ctx.value(scope.id, "fixture.attachment-count")?.and_then(|value| value.as_u64()).unwrap_or(0);
            ctx.put_value(scope.id, "fixture.attachment-count", &json!(count + 1))?;
            if self.stop_after_claim { let shutdown = self.shutdown.clone(); ctx.after_commit(move || shutdown.cancel())?; }
            Ok(Message::Tool { call_id: call["id"].as_str().unwrap().into(), content: vec![Block::text("The attachment committed once.")], is_error: false, vendor: None })
        })())
    }
    async fn session(&self, _scope: &AgentScope<'_>, _tools: Vec<ToolDefinition>) -> Option<Result<Box<dyn Session>>> { Some(Ok(Box::new(Provider))) }
}
struct Provider;
#[async_trait]
impl Session for Provider {
    async fn run(&mut self, request: RunRequest, _cancel: CancellationToken, events: mpsc::Sender<Event>) {
        events.send(Event::BlockStart).await.unwrap();
        if request.context.messages.iter().any(|message| matches!(message, Message::Tool { .. })) {
            assert!(request.context.messages.iter().any(|message| matches!(message, Message::Tool { content, .. } if content.iter().any(|block| matches!(block, Block::Text { text, .. } if text == "The attachment committed once.")))));
            events.send(Event::TextStart).await.unwrap(); events.send(Event::TextDelta { delta: "Restored without repeating the attachment.".into() }).await.unwrap(); events.send(Event::TextEnd).await.unwrap();
            events.send(Event::BlockStop).await.unwrap(); events.send(Event::Done { outcome: Outcome::Normal { usage: Usage::default() } }).await.unwrap();
        } else {
            events.send(Event::ToolCallStart { call_id: "original-attachment-call".into(), name: "fixture_attachment".into(), namespace: None, server: false, vendor: None }).await.unwrap();
            events.send(Event::ToolCallEnd { call_id: "original-attachment-call".into(), arguments: "{}".into(), incomplete: false, vendor: None }).await.unwrap();
            events.send(Event::BlockStop).await.unwrap(); events.send(Event::Done { outcome: Outcome::ToolCall { usage: Usage::default() } }).await.unwrap();
        }
    }
    async fn compact(&mut self, _context: SessionContext, _prompt: Option<String>, _cancel: CancellationToken) -> Compaction { panic!("The attachment fixture never compacts.") }
    async fn destroy(&mut self) {}
}
fn location(path: &std::path::Path) -> DatabaseLocation { DatabaseLocation { directory: path.into(), database: path.join("agent.sqlite"), ownership: path.join("agent.sqlite.lock"), store_lock: path.join("agent.lock") } }

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachment_and_acknowledgement_survive_a_stop_before_public_settlement_without_reexecution() {
    let directory = tempfile::tempdir().unwrap(); let database = Arc::new(SqliteDatabase::new()); database.load(location(directory.path())).await.unwrap();
    let owner = Arc::new(Owner { shutdown: CancellationToken::new(), stop_after_claim: true, executions: AtomicUsize::new(0) });
    let system = Arc::new(AgentSystem::new(database.clone(), vec![owner.clone()]).unwrap()); let target = system.clone();
    database.transact(move |ctx| { target.create(ctx, "attachmentfixture", &json!({"metadata":{}}))?; target.enqueue(ctx, "attachmentfixture", &json!({"id":"attachmentinput","message":{"role":"user","content":[{"type":"text","text":"Attach the secret reference."}]},"options":{"provider":"fixture","model":"fixture","effort":"low","permissionMode":"auto"}}), false) }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), owner.shutdown.cancelled()).await.unwrap(); system.close().await;
    database.transact(|ctx| {
        assert_eq!(ctx.value("attachmentfixture", "fixture.attachment-count")?, Some(json!(1)));
        assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_values WHERE owner_id='attachmentfixture' AND key GLOB 'tool.*' AND json_extract(value_json,'$.committed.role')='tool'", [], |row| row.get(0))?, 1);
        assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_values WHERE owner_id='attachmentfixture' AND key GLOB 'toolResult.*'", [], |row| row.get(0))?, 1);
        Ok(())
    }).await.unwrap(); assert_eq!(owner.executions.load(Ordering::SeqCst), 1); database.close().await.unwrap();
    let database = Arc::new(SqliteDatabase::new()); database.load(location(directory.path())).await.unwrap();
    let restored_owner = Arc::new(Owner { shutdown: CancellationToken::new(), stop_after_claim: false, executions: AtomicUsize::new(0) });
    let restored = Arc::new(AgentSystem::new(database.clone(), vec![restored_owner.clone()]).unwrap()); restored.load().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), restored.wait_for_idle("attachmentfixture", &CancellationToken::new())).await.unwrap().unwrap();
    assert_eq!(restored_owner.executions.load(Ordering::SeqCst), 0);
    database.transact(|ctx| { assert_eq!(ctx.value("attachmentfixture", "fixture.attachment-count")?, Some(json!(1))); assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_values WHERE owner_id='attachmentfixture' AND (key GLOB 'tool.*' OR key GLOB 'toolResult.*')", [], |row| row.get(0))?, 0); Ok(()) }).await.unwrap();
    restored.close().await; database.close().await.unwrap();
}