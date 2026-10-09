use async_trait::async_trait;
use happy_agent_base::persistence::{StorageError, Store};
use happy_agent_base::*;
use happy_providers::*;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

struct Script {
    events: Vec<Event>,
    gate: Option<Arc<Notify>>,
}
struct Factory {
    scripts: Arc<Mutex<std::collections::VecDeque<Script>>>,
    requests: mpsc::Sender<RunRequest>,
}
struct ScriptSession {
    scripts: Arc<Mutex<std::collections::VecDeque<Script>>>,
    requests: mpsc::Sender<RunRequest>,
}
#[async_trait]
impl SessionFactory for Factory {
    async fn create(
        &self,
        _: &AgentConfig,
        _: Vec<ToolDefinition>,
    ) -> anyhow::Result<Box<dyn Session>> {
        Ok(Box::new(ScriptSession {
            scripts: self.scripts.clone(),
            requests: self.requests.clone(),
        }))
    }
}
#[async_trait]
impl Session for ScriptSession {
    async fn run(
        &mut self,
        request: RunRequest,
        cancel: CancellationToken,
        events: mpsc::Sender<Event>,
    ) {
        self.requests.send(request).await.unwrap();
        let script = self
            .scripts
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected inference");
        if let Some(gate) = script.gate {
            tokio::select! { _=gate.notified()=>{},_=cancel.cancelled()=>{ events.send(Event::Done { outcome:Outcome::Cancelled }).await.ok(); return; } }
        }
        for event in script.events {
            events.send(event).await.unwrap();
        }
    }
    async fn compact(
        &mut self,
        context: SessionContext,
        _: Option<String>,
        _: CancellationToken,
    ) -> Compaction {
        Compaction::Completed {
            context: SessionContext {
                instructions: context.instructions,
                messages: vec![Message::Compaction {
                    content: Some("summary".into()),
                    encrypted_content: None,
                    vendor: None,
                }],
            },
            usage: Usage {
                input: 100,
                output: 10,
                ..Default::default()
            },
        }
    }
}
fn config(id: &str) -> AgentConfig {
    serde_json::from_value(json!({"id":id,"instructions":"root","provider":{"kind":"responses","credential":{"type":"environment","variable":"TEST_PROVIDER_TOKEN"},"model":"model","endpoint":"http://127.0.0.1:1"}})).unwrap()
}
fn normal(text: &str) -> Script {
    Script {
        events: vec![
            Event::BlockStart,
            Event::TextStart,
            Event::TextDelta { delta: text.into() },
            Event::TextEnd,
            Event::BlockStop,
            Event::Done {
                outcome: Outcome::Normal {
                    usage: Usage::default(),
                },
            },
        ],
        gate: None,
    }
}
fn tools() -> Script {
    Script {
        events: vec![
            Event::BlockStart,
            Event::ToolCallStart {
                call_id: "native-call".into(),
                name: "counter".into(),
                namespace: None,
                server: false,
                vendor: None,
            },
            Event::ToolCallEnd {
                call_id: "native-call".into(),
                arguments: "{}".into(),
                incomplete: false,
                vendor: None,
            },
            Event::BlockStop,
            Event::Done {
                outcome: Outcome::ToolCall {
                    usage: Usage::default(),
                },
            },
        ],
        gate: None,
    }
}
fn factory(scripts: Vec<Script>) -> (Arc<dyn SessionFactory>, mpsc::Receiver<RunRequest>) {
    let (tx, rx) = mpsc::channel(32);
    (
        Arc::new(Factory {
            scripts: Arc::new(Mutex::new(scripts.into())),
            requests: tx,
        }),
        rx,
    )
}
async fn settled(events: &mut mpsc::Receiver<AgentEvent>) -> AgentEvent {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if matches!(event, AgentEvent::Settled { .. }) {
                return event;
            }
        }
    })
    .await
    .expect("agent never settled")
}

struct Counter {
    count: Arc<AtomicUsize>,
    durable: bool,
    early_commit: bool,
}
#[async_trait]
impl Tool for Counter {
    fn definition(&self) -> ToolDefinition {
        serde_json::from_value(
            json!({"name":"counter","parameters":{"type":"object","additionalProperties":false}}),
        )
        .unwrap()
    }
    fn durable(&self) -> bool {
        self.durable
    }
    fn should_review_in_auto_mode(&self, _: &Value) -> bool {
        false
    }
    async fn execute(&self, context: ToolContext, _: Value) -> anyhow::Result<ToolResult> {
        self.count.fetch_add(1, Ordering::SeqCst);
        if self.early_commit {
            context.commit(ToolResult::text("early result")).await?;
            anyhow::bail!("ignore this later failure");
        }
        Ok(ToolResult::text("executed"))
    }
}

#[tokio::test]
async fn tool_results_preserve_the_calls_opaque_provider_metadata() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("agent.sqlite")).await.unwrap();
    let mut call = tools();
    let metadata = json!({"provider":"responses","type":"custom_tool_call","opaque":"unchanged"});
    if let Event::ToolCallEnd { vendor, .. } = &mut call.events[2] {
        *vendor = Some(metadata.clone());
    }
    let (factory, mut requests) = factory(vec![call, normal("answer")]);
    let (tx, mut events) = mpsc::channel(128);
    let agent = Agent::open(
        store.clone(),
        config("agent"),
        vec![Arc::new(Counter {
            count: Arc::new(AtomicUsize::new(0)),
            durable: false,
            early_commit: false,
        })],
        factory,
        tx,
    )
    .await
    .unwrap();
    agent
        .send(Message::user("run"), Default::default())
        .await
        .unwrap();
    requests.recv().await.unwrap();
    let next = requests.recv().await.unwrap();
    assert!(
        matches!(&next.context.messages[2], Message::Tool { vendor:Some(vendor), .. } if vendor==&metadata)
    );
    settled(&mut events).await;
    agent.close().await.unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn hosted_call_with_a_matching_local_name_never_executes_locally() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("agent.sqlite")).await.unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let mut hosted = tools();
    if let Event::ToolCallStart { server, vendor, .. } = &mut hosted.events[1] {
        *server = true;
        *vendor = Some(json!({"opaque":"retained"}));
    }
    hosted.events[2] = Event::ToolCallEnd {
        call_id: "native-call".into(),
        arguments: "{}".into(),
        incomplete: false,
        vendor: Some(json!({"opaque":"retained"})),
    };
    *hosted.events.last_mut().unwrap() = Event::Done {
        outcome: Outcome::Normal {
            usage: Usage::default(),
        },
    };
    let (factory, mut requests) = factory(vec![hosted, normal("follow-up")]);
    let (tx, mut events) = mpsc::channel(128);
    let agent = Agent::open(
        store.clone(),
        config("agent"),
        vec![Arc::new(Counter {
            count: count.clone(),
            durable: false,
            early_commit: false,
        })],
        factory,
        tx,
    )
    .await
    .unwrap();
    agent
        .send(Message::user("search"), Default::default())
        .await
        .unwrap();
    requests.recv().await.unwrap();
    settled(&mut events).await;
    assert_eq!(count.load(Ordering::SeqCst), 0);
    agent
        .send(Message::user("continue"), Default::default())
        .await
        .unwrap();
    let next = requests.recv().await.unwrap();
    assert!(
        matches!(&next.context.messages[1], Message::Assistant { content } if matches!(content.as_slice(), [Block::ToolCall { server:true, vendor:Some(vendor), .. }] if vendor["opaque"]=="retained"))
    );
    settled(&mut events).await;
    agent.close().await.unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn queue_followups_stay_separate_and_finished_agent_accepts_more() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("agent.sqlite")).await.unwrap();
    let gate = Arc::new(Notify::new());
    let mut first = normal("first answer");
    first.gate = Some(gate.clone());
    let (factory, mut requests) =
        factory(vec![first, normal("second answer"), normal("third answer")]);
    let (tx, mut events) = mpsc::channel(128);
    let agent = Agent::open(store.clone(), config("agent"), vec![], factory, tx)
        .await
        .unwrap();
    let options = DeliveryOptions {
        id: Some("message-1".into()),
        ..Default::default()
    };
    assert!(
        agent
            .send(Message::user("first"), options.clone())
            .await
            .unwrap()
            .created
    );
    assert!(
        !agent
            .send(Message::user("duplicate"), options)
            .await
            .unwrap()
            .created
    );
    requests.recv().await.unwrap();
    agent
        .send(Message::user("second"), Default::default())
        .await
        .unwrap();
    gate.notify_one();
    settled(&mut events).await;
    let second = requests.recv().await.unwrap();
    assert_eq!(
        second.context.messages,
        vec![
            Message::user("first"),
            Message::Assistant {
                content: vec![Block::text("first answer")]
            },
            Message::user("second")
        ]
    );
    settled(&mut events).await;
    agent
        .send(Message::user("third"), Default::default())
        .await
        .unwrap();
    let third = requests.recv().await.unwrap();
    assert_eq!(third.context.messages.last(), Some(&Message::user("third")));
    settled(&mut events).await;
    agent.close().await.unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn tool_result_is_committed_before_next_inference_and_first_commit_wins() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("agent.sqlite")).await.unwrap();
    let (factory, mut requests) = factory(vec![tools(), normal("finished")]);
    let (tx, mut events) = mpsc::channel(128);
    let count = Arc::new(AtomicUsize::new(0));
    let agent = Agent::open(
        store.clone(),
        config("agent"),
        vec![Arc::new(Counter {
            count: count.clone(),
            durable: true,
            early_commit: true,
        })],
        factory,
        tx,
    )
    .await
    .unwrap();
    agent
        .send(Message::user("use a tool"), Default::default())
        .await
        .unwrap();
    requests.recv().await.unwrap();
    let next = requests.recv().await.unwrap();
    assert!(
        matches!(next.context.messages.last(),Some(Message::Tool { call_id,content,is_error:false,.. }) if call_id=="native-call" && content==&vec![Block::text("early result")])
    );
    settled(&mut events).await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    agent.close().await.unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn cancellation_keeps_queued_input_idle_until_a_new_delivery() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("agent.sqlite")).await.unwrap();
    let mut first = normal("never commit");
    first.gate = Some(Arc::new(Notify::new()));
    let (factory, mut requests) =
        factory(vec![first, normal("queued answer"), normal("wake answer")]);
    let (tx, mut events) = mpsc::channel(128);
    let agent = Agent::open(store.clone(), config("agent"), vec![], factory, tx)
        .await
        .unwrap();
    agent
        .send(Message::user("first"), Default::default())
        .await
        .unwrap();
    requests.recv().await.unwrap();
    agent
        .send(Message::user("queued"), Default::default())
        .await
        .unwrap();
    agent.abort();
    assert!(matches!(
        settled(&mut events).await,
        AgentEvent::Settled { aborted: true, .. }
    ));
    assert!(!agent.is_active().await.unwrap());
    assert!(requests.try_recv().is_err());
    agent
        .send(Message::user("wake"), Default::default())
        .await
        .unwrap();
    let queued = requests.recv().await.unwrap();
    assert_eq!(
        queued.context.messages.last(),
        Some(&Message::user("queued"))
    );
    settled(&mut events).await;
    requests.recv().await.unwrap();
    settled(&mut events).await;
    agent.close().await.unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn transactional_delivery_and_notifications_roll_back_together() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("agent.sqlite")).await.unwrap();
    store
        .transact(|ctx| ctx.create_agent(&config("agent")))
        .await
        .unwrap();
    let result = store
        .transact(|ctx| {
            ctx.set_kv("agent", "agent", "value", &json!(1))?;
            ctx.deliver(
                "agent",
                Message::user("rollback"),
                Default::default(),
                false,
            )?;
            ctx.emit(AgentEvent::Settled {
                agent_id: "agent".into(),
                settlement_id: "rollback".into(),
                aborted: false,
                error: None,
            });
            Err::<(), _>(StorageError("rollback".into()))
        })
        .await;
    assert!(result.is_err());
    let (value, events) = store
        .transact(|ctx| {
            Ok((
                ctx.query_kv("agent", "agent", "value")?,
                ctx.query_queued("agent")?,
                ctx.query_stage("agent")?,
            ))
        })
        .await
        .unwrap();
    assert!(value.0.is_none());
    assert!(value.1.is_none());
    assert_eq!(value.2, Stage::Idle);
    assert!(events.is_empty());
    store.close().await.unwrap();
}

#[tokio::test]
async fn ownership_is_exclusive_and_released_on_close() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("agent.sqlite");
    let first = Store::open(&path).await.unwrap();
    assert!(Store::open(&path).await.is_err());
    first.close().await.unwrap();
    Store::open(&path).await.unwrap().close().await.unwrap();
}

#[tokio::test]
async fn one_store_cannot_create_two_live_instances_of_one_agent() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("agent.sqlite")).await.unwrap();
    let (factory, _) = factory(vec![]);
    let (tx, _events) = mpsc::channel(128);
    let agent = Agent::open(
        store.clone(),
        config("agent"),
        vec![],
        factory.clone(),
        tx.clone(),
    )
    .await
    .unwrap();
    assert!(
        Agent::open(store.clone(), config("agent"), vec![], factory, tx)
            .await
            .is_err()
    );
    agent.close().await.unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn restart_closes_non_durable_dispatched_calls_without_repeating_effects() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("agent.sqlite");
    let store = Store::open(&path).await.unwrap();
    let call = PendingCall {
        id: "stable-call".into(),
        provider_call_id: "native-call".into(),
        name: "counter".into(),
        namespace: None,
        arguments: "{}".into(),
        incomplete: false,
        dispatched: true,
        vendor: None,
    };
    store
        .transact(move |ctx| {
            ctx.create_agent(&config("agent"))?;
            ctx.append_message(
                "agent",
                "assistant",
                &Message::Assistant {
                    content: vec![Block::ToolCall {
                        call_id: "native-call".into(),
                        name: "counter".into(),
                        namespace: None,
                        arguments: "{}".into(),
                        incomplete: false,
                        vendor: None,
                        server: false,
                    }],
                },
            )?;
            ctx.set_stage("agent", &Stage::Tools { calls: vec![call] })
        })
        .await
        .unwrap();
    store.close().await.unwrap();
    let store = Store::open(&path).await.unwrap();
    let (factory, mut requests) = factory(vec![normal("recovered")]);
    let (tx, mut events) = mpsc::channel(128);
    let count = Arc::new(AtomicUsize::new(0));
    let agent = Agent::open(
        store.clone(),
        config("agent"),
        vec![Arc::new(Counter {
            count: count.clone(),
            durable: false,
            early_commit: false,
        })],
        factory,
        tx,
    )
    .await
    .unwrap();
    let request = requests.recv().await.unwrap();
    assert!(matches!(
        request.context.messages.last(),
        Some(Message::Tool { is_error: true, .. })
    ));
    settled(&mut events).await;
    assert_eq!(count.load(Ordering::SeqCst), 0);
    agent.close().await.unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn committed_tool_result_survives_restart_without_executing_again() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("agent.sqlite");
    let store = Store::open(&path).await.unwrap();
    let call = PendingCall {
        id: "stable-call".into(),
        provider_call_id: "native-call".into(),
        name: "counter".into(),
        namespace: None,
        arguments: "{}".into(),
        incomplete: false,
        dispatched: true,
        vendor: None,
    };
    store
        .transact(move |ctx| {
            ctx.create_agent(&config("agent"))?;
            ctx.set_stage(
                "agent",
                &Stage::Tools {
                    calls: vec![call.clone()],
                },
            )?;
            ctx.commit_call(
                "agent",
                &call,
                &ToolResult::text("committed before crash").message(&call),
            )?;
            Ok(())
        })
        .await
        .unwrap();
    store.close().await.unwrap();
    let store = Store::open(&path).await.unwrap();
    let (factory, mut requests) = factory(vec![normal("recovered")]);
    let (tx, mut events) = mpsc::channel(128);
    let count = Arc::new(AtomicUsize::new(0));
    let agent = Agent::open(
        store.clone(),
        config("agent"),
        vec![Arc::new(Counter {
            count: count.clone(),
            durable: true,
            early_commit: false,
        })],
        factory,
        tx,
    )
    .await
    .unwrap();
    assert!(
        matches!(requests.recv().await.unwrap().context.messages.last(),Some(Message::Tool { content,.. }) if content==&vec![Block::text("committed before crash")])
    );
    settled(&mut events).await;
    assert_eq!(count.load(Ordering::SeqCst), 0);
    agent.close().await.unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn input_tool_request_is_consumed_before_the_first_provider_call() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("agent.sqlite")).await.unwrap();
    let (factory, mut requests) = factory(vec![normal("finished")]);
    let (tx, mut events) = mpsc::channel(128);
    let count = Arc::new(AtomicUsize::new(0));
    let agent = Agent::open(
        store.clone(),
        config("agent"),
        vec![Arc::new(Counter {
            count: count.clone(),
            durable: true,
            early_commit: false,
        })],
        factory,
        tx,
    )
    .await
    .unwrap();
    agent
        .send(
            Message::User {
                content: vec![
                    Block::text("run it"),
                    Block::ToolCallRequest {
                        name: "counter".into(),
                        arguments: Default::default(),
                    },
                ],
            },
            Default::default(),
        )
        .await
        .unwrap();
    let request = requests.recv().await.unwrap();
    assert!(!request.context.messages.iter().any(|m| {
        m.content()
            .iter()
            .any(|b| matches!(b, Block::ToolCallRequest { .. }))
    }));
    assert!(matches!(
        request.context.messages.last(),
        Some(Message::Tool {
            is_error: false,
            ..
        })
    ));
    settled(&mut events).await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    agent.close().await.unwrap();
    store.close().await.unwrap();
}
