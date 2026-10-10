use anyhow::Result;
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope, AgentSystem, DatabaseLocation, SqliteDatabase};
use happy_providers::{
    Block, Compaction, Event, Message, Outcome, RunRequest, Session, SessionContext,
    ToolDefinition, Usage,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;
use rusqlite::OptionalExtension;

struct Owner {
    shutdown: CancellationToken,
    durable: bool,
    reloadable: bool,
    steerable: bool,
    stop_first: bool,
    entered: Notify,
    interrupted: Notify,
    executions: AtomicUsize,
    ids: Mutex<Vec<String>>,
}
#[async_trait]
impl AgentModule for Owner {
    fn name(&self) -> &'static str {
        "original-tool-lifetime-fixture"
    }
    fn shutdown(&self) -> Option<CancellationToken> {
        Some(self.shutdown.clone())
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        (call["call"]["name"] == "fixture_lifetime").then_some(self.durable)
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        (call["call"]["name"] == "fixture_lifetime").then_some(self.reloadable)
    }
    fn steerable(&self, call: &Value) -> Option<bool> {
        (call["call"]["name"] == "fixture_lifetime").then_some(self.steerable)
    }
    async fn execute_tool(
        &self,
        _: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        if call["call"]["name"] != "fixture_lifetime" {
            return None;
        }
        self.ids
            .lock()
            .unwrap()
            .push(call["id"].as_str().unwrap().to_owned());
        self.entered.notify_one();
        if self.stop_first {
            self.shutdown.cancel();
        } else {
            self.executions.fetch_add(1, Ordering::SeqCst);
            if self.steerable {
                cancel.cancelled().await;
                self.interrupted.notify_one();
            }
        }
        Some(Message::Tool {
            call_id: call["id"].as_str().unwrap().to_owned(),
            content: vec![Block::text("The original tool lifetime finished.")],
            is_error: false,
            vendor: None,
        })
    }
    async fn session(
        &self,
        _: &AgentScope<'_>,
        _: Vec<ToolDefinition>,
    ) -> Option<Result<Box<dyn Session>>> {
        Some(Ok(Box::new(Provider)))
    }
}
struct Provider;
#[async_trait]
impl Session for Provider {
    async fn run(
        &mut self,
        request: RunRequest,
        _: CancellationToken,
        events: mpsc::Sender<Event>,
    ) {
        events.send(Event::BlockStart).await.unwrap();
        if request
            .context
            .messages
            .iter()
            .any(|message| matches!(message, Message::Tool { .. }))
        {
            events.send(Event::TextStart).await.unwrap();
            events
                .send(Event::TextDelta {
                    delta: "The preserved result reached the provider.".to_owned(),
                })
                .await
                .unwrap();
            events.send(Event::TextEnd).await.unwrap();
            events.send(Event::BlockStop).await.unwrap();
            events
                .send(Event::Done {
                    outcome: Outcome::Normal {
                        usage: Usage::default(),
                    },
                })
                .await
                .unwrap();
        } else {
            events
                .send(Event::ToolCallStart {
                    call_id: "vendor-lifetime".to_owned(),
                    name: "fixture_lifetime".to_owned(),
                    namespace: None,
                    server: false,
                    vendor: None,
                })
                .await
                .unwrap();
            events
                .send(Event::ToolCallEnd {
                    call_id: "vendor-lifetime".to_owned(),
                    arguments: "{}".to_owned(),
                    incomplete: false,
                    vendor: None,
                })
                .await
                .unwrap();
            events.send(Event::BlockStop).await.unwrap();
            events
                .send(Event::Done {
                    outcome: Outcome::ToolCall {
                        usage: Usage::default(),
                    },
                })
                .await
                .unwrap();
        }
    }
    async fn compact(
        &mut self,
        _: SessionContext,
        _: Option<String>,
        _: CancellationToken,
    ) -> Compaction {
        panic!("The lifetime fixture does not compact.")
    }
    async fn destroy(&mut self) {}
}
fn owner(durable: bool, reloadable: bool, steerable: bool, stop_first: bool) -> Arc<Owner> {
    Arc::new(Owner {
        shutdown: CancellationToken::new(),
        durable,
        reloadable,
        steerable,
        stop_first,
        entered: Notify::new(),
        interrupted: Notify::new(),
        executions: AtomicUsize::new(0),
        ids: Mutex::new(Vec::new()),
    })
}
fn location(path: &std::path::Path) -> DatabaseLocation {
    DatabaseLocation {
        directory: path.into(),
        database: path.join("agent.sqlite"),
        ownership: path.join("agent.sqlite.lock"),
        store_lock: path.join("agent.lock"),
    }
}
fn input(id: &str) -> Value {
    json!({"id":id,"message":{"role":"user","content":[{"type":"text","text":"Exercise the original tool lifetime."}]},"options":{"provider":"fixture","model":"fixture","effort":"low","permissionMode":"auto"}})
}
async fn restore_case(durable: bool, reloadable: bool) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = Arc::new(SqliteDatabase::new());
    database.load(location(directory.path())).await?;
    let first = owner(durable, reloadable, false, true);
    let system = Arc::new(AgentSystem::new(database.clone(), vec![first.clone()])?);
    let creator = system.clone();
    database
        .transact(move |ctx| {
            creator.create(ctx, "lifetimefixture", &json!({"metadata":{}}))?;
            creator.enqueue(ctx, "lifetimefixture", &input("lifetimeinput"), false)
        })
        .await?;
    tokio::time::timeout(Duration::from_secs(5), first.shutdown.cancelled()).await?;
    system.close().await;
    let id = first.ids.lock().unwrap()[0].clone();
    database.transact(|ctx|{assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_values WHERE owner_id='lifetimefixture' AND key GLOB 'tool.*'",[],|row|row.get(0))?,1);Ok(())}).await?;
    database.close().await?;
    let database = Arc::new(SqliteDatabase::new());
    database.load(location(directory.path())).await?;
    let second = owner(durable, reloadable, false, false);
    let restored = Arc::new(AgentSystem::new(database.clone(), vec![second.clone()])?);
    restored.load().await?;
    tokio::time::timeout(
        Duration::from_secs(5),
        restored.wait_for_idle("lifetimefixture", &CancellationToken::new()),
    )
    .await??;
    let executions = second.executions.load(Ordering::SeqCst);
    let ids = second.ids.lock().unwrap().clone();
    second.shutdown.cancel();
    restored.close().await;
    database.close().await?;
    assert_eq!(executions, usize::from(durable || reloadable));
    if durable || reloadable {
        assert_eq!(ids, vec![id]);
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_durable_nonreloadable_call_reexecutes_after_restart_with_the_same_base_identity()
-> Result<()> {
    restore_case(true, false).await
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_reloadable_nondurable_call_can_also_reexecute_after_restart() -> Result<()> {
    restore_case(false, true).await
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_call_without_either_flag_never_reexecutes_after_restart() -> Result<()> {
    restore_case(false, false).await
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_steering_interrupts_only_the_current_steerable_execution_lifetime() -> Result<()>
{
    let directory = tempfile::tempdir()?;
    let database = Arc::new(SqliteDatabase::new());
    database.load(location(directory.path())).await?;
    let owner = owner(true, false, true, false);
    let system = Arc::new(AgentSystem::new(database.clone(), vec![owner.clone()])?);
    let creator = system.clone();
    database
        .transact(move |ctx| {
            creator.create(ctx, "steerfixture", &json!({"metadata":{}}))?;
            creator.enqueue(ctx, "steerfixture", &input("steerinput"), false)
        })
        .await?;
    tokio::time::timeout(Duration::from_secs(5), owner.entered.notified()).await?;
    let sender = system.clone();
    database
        .transact(move |ctx| sender.enqueue(ctx, "steerfixture", &input("nextsteering"), true))
        .await?;
    let interrupted =
        tokio::time::timeout(Duration::from_millis(500), owner.interrupted.notified()).await;
    owner.shutdown.cancel();
    system.close().await;
    database.close().await?;
    assert!(
        interrupted.is_ok(),
        "Committed steering must cancel the steerable tool's lifetime without aborting its turn."
    );
    Ok(())
}

struct DrainingOwner {shutdown:CancellationToken,drain:CancellationToken,reloadable:bool,steerable:bool,entered:Notify,release:Notify,interrupted:AtomicUsize}
#[async_trait]impl AgentModule for DrainingOwner{
    fn name(&self)->&'static str{"original-graceful-drain-fixture"}
    fn shutdown(&self)->Option<CancellationToken>{Some(self.shutdown.clone())}
    fn draining(&self)->bool{self.drain.is_cancelled()}
    fn drain_signal(&self)->Option<CancellationToken>{Some(self.drain.clone())}
    fn durable(&self,call:&Value)->Option<bool>{(call["call"]["name"]=="fixture_lifetime").then_some(true)}
    fn reloadable(&self,call:&Value)->Option<bool>{(call["call"]["name"]=="fixture_lifetime").then_some(self.reloadable)}
    fn steerable(&self,call:&Value)->Option<bool>{(call["call"]["name"]=="fixture_lifetime").then_some(self.steerable)}
    async fn execute_tool(&self,_:&AgentScope<'_>,call:&Value,cancel:CancellationToken)->Option<Message>{if call["call"]["name"]!="fixture_lifetime"{return None;}self.entered.notify_one();let interrupted=tokio::select!{biased;_=cancel.cancelled()=>true,_=self.release.notified()=>false};if interrupted{self.interrupted.fetch_add(1,Ordering::SeqCst);}Some(Message::Tool{call_id:call["id"].as_str().unwrap().to_owned(),content:vec![Block::text(if interrupted{"The fixture received cancellation."}else{"The ordinary tool finished."})],is_error:interrupted,vendor:None})}
    async fn session(&self,_:&AgentScope<'_>,_:Vec<ToolDefinition>)->Option<Result<Box<dyn Session>>>{Some(Ok(Box::new(Provider)))}
}
async fn drain_case(reloadable:bool,steerable:bool)->Result<()>{
    let directory=tempfile::tempdir()?;let database=Arc::new(SqliteDatabase::new());database.load(location(directory.path())).await?;let owner=Arc::new(DrainingOwner{shutdown:CancellationToken::new(),drain:CancellationToken::new(),reloadable,steerable,entered:Notify::new(),release:Notify::new(),interrupted:AtomicUsize::new(0)});let system=Arc::new(AgentSystem::new(database.clone(),vec![owner.clone()])?);let creator=system.clone();database.transact(move|ctx|{creator.create(ctx,"drainfixture",&json!({"metadata":{}}))?;creator.enqueue(ctx,"drainfixture",&input("draininput"),false)}).await?;tokio::time::timeout(Duration::from_secs(5),owner.entered.notified()).await?;owner.drain.cancel();if !reloadable&&!steerable{owner.release.notify_one();}let closing=system.clone();let mut stopped=tokio::spawn(async move{closing.close().await});let drained=tokio::time::timeout(Duration::from_millis(500),&mut stopped).await.is_ok();if !drained{owner.shutdown.cancel();tokio::time::timeout(Duration::from_secs(5),&mut stopped).await??;}
    let(pending,result)=database.transact(|ctx|{let pending=ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_values WHERE owner_id='drainfixture' AND key GLOB 'tool.*'",[],|row|row.get(0))?;let result=ctx.database().query_row("SELECT record_json FROM happy_agent_records WHERE owner_id='drainfixture' AND json_extract(record_json,'$.type')='tool' ORDER BY position DESC LIMIT 1",[],|row|row.get::<_,String>(0)).optional()?.map(|encoded|serde_json::from_str::<Value>(&encoded)).transpose()?;Ok((pending,result))}).await?;database.close().await?;assert!(drained,"Graceful drain must reach the boundary without waiting for a suspended tool.");if reloadable{assert_eq!(pending,1);assert!(result.is_none());}else{assert_eq!(pending,0);let result=result.unwrap();if steerable{assert!(result.to_string().contains("The tool call was interrupted while the agent was stopping."));}else{assert!(result.to_string().contains("The ordinary tool finished."));assert_eq!(owner.interrupted.load(Ordering::SeqCst),0);}}Ok(())
}
#[tokio::test(flavor="multi_thread",worker_threads=2)]async fn graceful_drain_parks_a_reloadable_call_without_a_permanent_result()->Result<()>{drain_case(true,false).await}
#[tokio::test(flavor="multi_thread",worker_threads=2)]async fn graceful_drain_settles_a_steerable_call_with_the_original_interruption_result()->Result<()>{drain_case(false,true).await}
#[tokio::test(flavor="multi_thread",worker_threads=2)]async fn graceful_drain_waits_for_an_ordinary_tool_to_finish_its_result_transaction()->Result<()>{drain_case(false,false).await}
