use anyhow::Result;
use async_trait::async_trait;
use happy_agent_base::{
    AgentModule, AgentScope, AgentSystem, DatabaseContext, DatabaseLocation, SqliteDatabase,
};
use happy_providers::{
    Compaction, Event, Outcome, RunRequest, Session, SessionContext, ToolDefinition, Usage,
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
struct Owner {
    shutdown: CancellationToken,
    system: Mutex<Weak<AgentSystem>>,
    database: Arc<SqliteDatabase>,
}
impl Owner {
    fn append(ctx: &DatabaseContext<'_>, scope: &AgentScope<'_>, value: Value) -> Result<()> {
        let mut sequence = ctx
            .value(scope.id, "fixture.sequence")?
            .unwrap_or(json!([]));
        sequence.as_array_mut().unwrap().push(value);
        ctx.put_value(scope.id, "fixture.sequence", &sequence)
    }
}
#[async_trait]
impl AgentModule for Owner {
    fn name(&self) -> &'static str {
        "original-loop-boundaries"
    }
    fn shutdown(&self) -> Option<CancellationToken> {
        Some(self.shutdown.clone())
    }
    fn before_loop_transactional(
        &self,
        ctx: &DatabaseContext<'_>,
        scope: &AgentScope<'_>,
        loop_id: &str,
    ) -> Result<()> {
        Self::append(ctx, scope, json!({"hook":"open","loopId":loop_id}))
    }
    async fn before_loop(&self, scope: &AgentScope<'_>, _: CancellationToken) -> Result<()> {
        let database = self.database.clone();
        let id = scope.id.to_owned();
        database
            .transact(move |ctx| {
                assert_eq!(
                    ctx.value(&id, "fixture.sequence")?
                        .unwrap()
                        .as_array()
                        .unwrap()
                        .last()
                        .unwrap()["hook"],
                    "open"
                );
                Ok(())
            })
            .await
    }
    fn after_turn_transactional(
        &self,
        ctx: &DatabaseContext<'_>,
        scope: &AgentScope<'_>,
        loop_id: &str,
        turn_id: Option<&str>,
        aborted: bool,
    ) -> Result<()> {
        assert!(!aborted);
        assert!(turn_id.is_some());
        Self::append(
            ctx,
            scope,
            json!({"hook":"turn","loopId":loop_id,"turnId":turn_id}),
        )
    }
    fn after_loop_transactional(
        &self,
        ctx: &DatabaseContext<'_>,
        scope: &AgentScope<'_>,
        loop_id: &str,
    ) -> Result<()> {
        Self::append(ctx, scope, json!({"hook":"close","loopId":loop_id}))?;
        let sequence = ctx.value(scope.id, "fixture.sequence")?.unwrap();
        if sequence
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["hook"] == "close")
            .count()
            == 1
        {
            self.system.lock().unwrap().upgrade().unwrap().enqueue(ctx,scope.id,&json!({"id":"continuation","message":{"role":"user","content":[{"type":"text","text":"Continue"}]},"options":{},"metadata":{"origin":"agent","senderAgentId":scope.id}}),false)?;
        }
        Ok(())
    }
    fn settled(
        &self,
        ctx: &DatabaseContext<'_>,
        scope: &AgentScope<'_>,
        _: &str,
        _: &str,
    ) -> Result<()> {
        Self::append(ctx, scope, json!({"hook":"settled"}))
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
    async fn run(&mut self, _: RunRequest, _: CancellationToken, events: mpsc::Sender<Event>) {
        events.send(Event::BlockStart).await.unwrap();
        events.send(Event::TextStart).await.unwrap();
        events
            .send(Event::TextDelta {
                delta: "One complete turn".into(),
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
    }
    async fn compact(
        &mut self,
        _: SessionContext,
        _: Option<String>,
        _: CancellationToken,
    ) -> Compaction {
        panic!("The boundary fixture does not compact.")
    }
    async fn destroy(&mut self) {}
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transactional_loop_hooks_wrap_each_continuation_and_only_the_final_loop_settles()
-> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = Arc::new(SqliteDatabase::new());
    database
        .load(DatabaseLocation {
            directory: directory.path().into(),
            database: directory.path().join("agent.sqlite"),
            ownership: directory.path().join("agent.sqlite.lock"),
            store_lock: directory.path().join("agent.lock"),
        })
        .await?;
    let owner = Arc::new(Owner {
        shutdown: CancellationToken::new(),
        system: Mutex::new(Weak::new()),
        database: database.clone(),
    });
    let system = Arc::new(AgentSystem::new(database.clone(), vec![owner.clone()])?);
    *owner.system.lock().unwrap() = Arc::downgrade(&system);
    database.transact({let system=system.clone();move|ctx|{system.create(ctx,"boundaryfixture",&json!({"metadata":{}}))?;system.enqueue(ctx,"boundaryfixture",&json!({"id":"opening","message":{"role":"user","content":[{"type":"text","text":"Begin"}]},"options":{"provider":"fixture","model":"fixture","effort":"low","permissionMode":"auto"}}),false)}}).await?;
    tokio::time::timeout(
        Duration::from_secs(5),
        system.wait_for_idle("boundaryfixture", &CancellationToken::new()),
    )
    .await??;
    database
        .transact(|ctx| {
            let sequence = ctx.value("boundaryfixture", "fixture.sequence")?.unwrap();
            let sequence = sequence.as_array().unwrap();
            assert_eq!(
                sequence
                    .iter()
                    .map(|entry| entry["hook"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["open", "turn", "close", "open", "turn", "close", "settled"]
            );
            assert_eq!(sequence[0]["loopId"], sequence[1]["loopId"]);
            assert_eq!(sequence[0]["loopId"], sequence[2]["loopId"]);
            assert_eq!(sequence[3]["loopId"], sequence[4]["loopId"]);
            assert_eq!(sequence[3]["loopId"], sequence[5]["loopId"]);
            assert_ne!(sequence[0]["loopId"], sequence[3]["loopId"]);
            assert_ne!(sequence[1]["turnId"], sequence[4]["turnId"]);
            assert!(ctx.value("boundaryfixture", "owed")?.is_none());
            Ok(())
        })
        .await?;
    owner.shutdown.cancel();
    system.close().await;
    database.close().await?;
    Ok(())
}
