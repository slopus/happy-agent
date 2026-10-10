use anyhow::Result;
use async_trait::async_trait;
use happy_agent_base::{AcceptedInput, AgentModule, AgentScope, AgentSystem, DatabaseContext, DatabaseLocation, SqliteDatabase};
use happy_providers::{Compaction, Event, Outcome, RunRequest, Session, SessionContext, ToolDefinition, Usage};
use serde_json::{Value, json};
use std::{sync::{Arc, atomic::{AtomicUsize, Ordering}}, time::Duration};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

struct Owner {
    shutdown: CancellationToken, entered: Notify, ready: Notify,
    fail_start: bool, reject_settlement: bool,
    starts: AtomicUsize, accepted: AtomicUsize,
    reports: mpsc::Sender<(String, Option<String>)>,
}
#[async_trait]
impl AgentModule for Owner {
    fn name(&self) -> &'static str { "owned-loop-fixture" }
    fn shutdown(&self) -> Option<CancellationToken> { Some(self.shutdown.clone()) }
    async fn before_loop(&self, _scope: &AgentScope<'_>, _cancel: CancellationToken) -> Result<()> {
        self.starts.fetch_add(1,Ordering::SeqCst); self.entered.notify_one();
        self.ready.notified().await;
        anyhow::ensure!(!self.fail_start, "Workspace preparation failed before accepting the opening input.");
        Ok(())
    }
    fn accepted(&self, _ctx: &DatabaseContext<'_>, _scope: &AgentScope<'_>, inputs: &[AcceptedInput], _steering: bool) -> Result<()> { self.accepted.fetch_add(inputs.len(),Ordering::SeqCst); Ok(()) }
    fn settled_detail(&self, ctx: &DatabaseContext<'_>, scope: &AgentScope<'_>, _status: &str, _reason: &str, error: Option<&str>) -> Result<()> {
        let owed = ctx.value(scope.id,"owed")?.unwrap();
        let identity = owed["settlementId"].as_str().unwrap().to_owned();
        self.reports.try_send((identity.clone(),error.map(str::to_owned)))?;
        ctx.put_value(scope.id,"fixture.report",&json!({"id":identity,"error":error}))?;
        anyhow::ensure!(!self.reject_settlement, "The report hook rejected settlement."); Ok(())
    }
    async fn session(&self,_scope:&AgentScope<'_>,_tools:Vec<ToolDefinition>)->Option<Result<Box<dyn Session>>> { Some(Ok(Box::new(Provider))) }
}
struct Provider;
#[async_trait]
impl Session for Provider {
    async fn run(&mut self,_request:RunRequest,_cancel:CancellationToken,events:mpsc::Sender<Event>) {
        events.send(Event::BlockStart).await.unwrap(); events.send(Event::TextStart).await.unwrap(); events.send(Event::TextDelta{delta:"Prepared once before accepting.".into()}).await.unwrap(); events.send(Event::TextEnd).await.unwrap(); events.send(Event::BlockStop).await.unwrap(); events.send(Event::Done{outcome:Outcome::Normal{usage:Usage::default()}}).await.unwrap();
    }
    async fn compact(&mut self,_context:SessionContext,_prompt:Option<String>,_cancel:CancellationToken)->Compaction { panic!("The loop fixture does not compact.") }
    async fn destroy(&mut self) {}
}
fn location(path:&std::path::Path)->DatabaseLocation { DatabaseLocation { directory:path.into(),database:path.join("agent.sqlite"),ownership:path.join("agent.sqlite.lock"),store_lock:path.join("agent.lock") } }
fn input()->Value { json!({"id":"openinginput","message":{"role":"user","content":[{"type":"text","text":"Start only after workspace preparation."}]},"options":{"provider":"fixture","model":"fixture","effort":"low","permissionMode":"auto"}}) }
fn owner(fail_start:bool,reject_settlement:bool)->(Arc<Owner>,mpsc::Receiver<(String,Option<String>)>) {
    let(reports,receiver)=mpsc::channel(4); (Arc::new(Owner {shutdown:CancellationToken::new(),entered:Notify::new(),ready:Notify::new(),fail_start,reject_settlement,starts:AtomicUsize::new(0),accepted:AtomicUsize::new(0),reports}),receiver)
}
async fn seed(database:&Arc<SqliteDatabase>,system:&Arc<AgentSystem>)->Result<()> {let system=system.clone();database.transact(move|ctx|{system.create(ctx,"loophookfixture",&json!({"metadata":{}}))?;system.enqueue(ctx,"loophookfixture",&input(),false)}).await}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
async fn opening_hook_holds_acceptance_and_inference_and_cancellation_keeps_input_idle() -> Result<()> {
    let directory=tempfile::tempdir()?;let database=Arc::new(SqliteDatabase::new());database.load(location(directory.path())).await?;
    let(owner,mut reports)=owner(false,false);let system=Arc::new(AgentSystem::new(database.clone(),vec![owner.clone()])?);seed(&database,&system).await?;
    tokio::time::timeout(Duration::from_secs(5),owner.entered.notified()).await?;
    assert_eq!(owner.accepted.load(Ordering::SeqCst),0);
    database.transact(|ctx|{assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_records WHERE owner_id='loophookfixture'",[],|row|row.get(0))?,0);Ok(())}).await?;
    system.abort("loophookfixture").await?;
    assert!(tokio::time::timeout(Duration::from_secs(5),reports.recv()).await?.is_some());assert_eq!(owner.accepted.load(Ordering::SeqCst),0);assert_eq!(owner.starts.load(Ordering::SeqCst),1);
    database.transact(|ctx|{assert!(ctx.value("loophookfixture","owed")?.is_none());assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_values WHERE owner_id='loophookfixture' AND key GLOB 'send.*'",[],|row|row.get(0))?,1);Ok(())}).await?;
    owner.shutdown.cancel();system.close().await;database.close().await?;Ok(())
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
async fn early_failure_keeps_its_settlement_identity_and_error_across_a_report_rollback_and_reopen() -> Result<()> {
    let directory=tempfile::tempdir()?;let database=Arc::new(SqliteDatabase::new());database.load(location(directory.path())).await?;
    let(first,mut reports)=owner(true,true);let system=Arc::new(AgentSystem::new(database.clone(),vec![first.clone()])?);seed(&database,&system).await?;
    tokio::time::timeout(Duration::from_secs(5),first.entered.notified()).await?;first.ready.notify_one();
    let(identity,error)=tokio::time::timeout(Duration::from_secs(5),reports.recv()).await?.unwrap();assert_eq!(error.as_deref(),Some("Workspace preparation failed before accepting the opening input."));
    first.shutdown.cancel();system.close().await;
    database.transact({let identity=identity.clone();move|ctx|{assert_eq!(ctx.value("loophookfixture","owed")?.unwrap()["settlementId"],identity);assert!(ctx.value("loophookfixture","fixture.report")?.is_none());Ok(())}}).await?;database.close().await?;
    let database=Arc::new(SqliteDatabase::new());database.load(location(directory.path())).await?;let(second,mut reports)=owner(false,false);let system=Arc::new(AgentSystem::new(database.clone(),vec![second.clone()])?);system.load().await?;
    let(restored_identity,restored_error)=tokio::time::timeout(Duration::from_secs(5),reports.recv()).await?.unwrap();assert_eq!(restored_identity,identity);assert_eq!(restored_error,error);assert_eq!(second.starts.load(Ordering::SeqCst),0);assert_eq!(second.accepted.load(Ordering::SeqCst),0);
    tokio::time::timeout(Duration::from_secs(5),system.wait_for_idle("loophookfixture",&CancellationToken::new())).await??;
    second.shutdown.cancel();system.close().await;database.close().await?;Ok(())
}