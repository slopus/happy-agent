use anyhow::Result;
use async_trait::async_trait;
use happy_agent_base::{
    AcceptedInput, AgentModule, AgentScope, AgentSystem, DatabaseContext, DatabaseLocation,
    SqliteDatabase,
};
use happy_providers::{
    Compaction, Event, Outcome, RunRequest, Session, SessionContext, ToolDefinition, Usage,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Owner {
    snapshots: mpsc::Sender<Vec<String>>,
    shutdown: CancellationToken,
}
#[async_trait]
impl AgentModule for Owner {
    fn name(&self) -> &'static str {
        "acceptance-order-fixture"
    }
    fn shutdown(&self) -> Option<CancellationToken> {
        Some(self.shutdown.clone())
    }
    fn record(
        &self,
        ctx: &DatabaseContext<'_>,
        scope: &AgentScope<'_>,
        record: &Value,
    ) -> Result<()> {
        if record["type"] == "user" {
            let mut texts: Vec<String> = serde_json::from_value(
                ctx.value(scope.id, "fixture.transcript")?
                    .unwrap_or(json!([])),
            )?;
            texts.push(
                record["message"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
            ctx.put_value(scope.id, "fixture.transcript", &json!(texts))?;
        }
        Ok(())
    }
    fn accepted(
        &self,
        ctx: &DatabaseContext<'_>,
        scope: &AgentScope<'_>,
        inputs: &[AcceptedInput],
        _: bool,
    ) -> Result<()> {
        for _ in inputs {
            let count = ctx
                .value(scope.id, "fixture.count")?
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                + 1;
            ctx.put_value(scope.id, "fixture.count", &json!(count))?;
            if count == 2 {
                self.snapshots.try_send(serde_json::from_value(
                    ctx.value(scope.id, "fixture.transcript")?.unwrap(),
                )?)?;
            }
        }
        Ok(())
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
        let _ = events
            .send(Event::Done {
                outcome: Outcome::Normal {
                    usage: Usage::default(),
                },
            })
            .await;
    }
    async fn compact(
        &mut self,
        _: SessionContext,
        _: Option<String>,
        _: CancellationToken,
    ) -> Compaction {
        panic!("This fixture does not compact.")
    }
    async fn destroy(&mut self) {}
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn second_accepted_message_snapshot_excludes_a_later_prequeued_message() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let path = directory.path();
    let database = Arc::new(SqliteDatabase::new());
    database
        .load(DatabaseLocation {
            directory: path.into(),
            database: path.join("agent.sqlite"),
            ownership: path.join("agent.sqlite.lock"),
            store_lock: path.join("agent.lock"),
        })
        .await?;
    let (sender, mut receiver) = mpsc::channel(1);
    let system = Arc::new(AgentSystem::new(
        database.clone(),
        vec![Arc::new(Owner {
            snapshots: sender,
            shutdown: CancellationToken::new(),
        })],
    )?);
    let owner = system.clone();
    database.transact(move|ctx|{
        owner.create(ctx,"messageordering",&json!({"metadata":{}}))?;
        for (id,text) in [("firstinput","First request"),("secondinput","Second request"),("thirdinput","Later request")] {
            owner.enqueue(ctx,"messageordering",&json!({"id":id,"message":{"role":"user","content":[{"type":"text","text":text}]},"options":{"provider":"fixture","model":"fixture","effort":"low","permissionMode":"auto"}}),false)?;
        }
        Ok(())
    }).await?;
    let snapshot = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await?
        .unwrap();
    system.close().await;
    database.close().await?;
    assert_eq!(snapshot, vec!["First request", "Second request"]);
    Ok(())
}
