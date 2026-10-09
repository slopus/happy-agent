use crate::{
    AgentConfig, AgentEvent, Delivery, DeliveryOptions, PendingCall, PermissionDecision,
    PermissionMode, Snapshot, Stage, Tool, ToolContext, ToolResult, identity,
    persistence::{RuntimeLease, StorageError, Store},
};
use async_trait::async_trait;
use happy_providers::{
    Accumulator, Block, Compaction, Event, HttpSession, Message, Outcome, RunRequest, Session,
    SessionContext, ToolDefinition,
};
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    sync::{Notify, mpsc},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

#[async_trait]
pub trait SessionFactory: Send + Sync {
    async fn create(
        &self,
        config: &AgentConfig,
        tools: Vec<ToolDefinition>,
    ) -> anyhow::Result<Box<dyn Session>>;
}
pub struct NativeSessionFactory;
#[async_trait]
impl SessionFactory for NativeSessionFactory {
    async fn create(
        &self,
        config: &AgentConfig,
        tools: Vec<ToolDefinition>,
    ) -> anyhow::Result<Box<dyn Session>> {
        Ok(Box::new(
            HttpSession::new(config.id.clone(), config.provider.clone(), tools).await?,
        ))
    }
}

struct Inner {
    id: String,
    store: Store,
    factory: Arc<dyn SessionFactory>,
    tools: Vec<Arc<dyn Tool>>,
    events: mpsc::Sender<AgentEvent>,
    notify: Notify,
    cancel: Mutex<CancellationToken>,
    aborted: AtomicBool,
    draining: AtomicBool,
    closing: AtomicBool,
    _lease: RuntimeLease,
    stopped: Notify,
    failure: Mutex<Option<String>>,
}
pub struct Agent {
    inner: Arc<Inner>,
    worker: Option<JoinHandle<Result<(), StorageError>>>,
}

impl Agent {
    pub async fn open(
        store: Store,
        config: AgentConfig,
        tools: Vec<Arc<dyn Tool>>,
        factory: Arc<dyn SessionFactory>,
        events: mpsc::Sender<AgentEvent>,
    ) -> Result<Self, StorageError> {
        // Configuration is persistent; restoring never replaces it with caller defaults.
        let id = config.id.clone();
        let lease = store.claim_runtime(&id)?;
        store.transact(move |ctx| ctx.create_agent(&config)).await?;
        let inner = Arc::new(Inner {
            id,
            store,
            factory,
            tools,
            events,
            notify: Notify::new(),
            cancel: Mutex::new(CancellationToken::new()),
            aborted: AtomicBool::new(false),
            draining: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            _lease: lease,
            stopped: Notify::new(),
            failure: Mutex::new(None),
        });
        let owned = inner.clone();
        let recover = inner.store.query_active(inner.id.clone()).await?;
        let worker = tokio::spawn(async move {
            let result = worker(owned.clone(), recover).await;
            if let Err(error) = &result
                && let Ok(mut failure) = owned.failure.lock()
            {
                *failure = Some(error.to_string());
            }
            owned.stopped.notify_waiters();
            result
        });
        Ok(Self {
            inner,
            worker: Some(worker),
        })
    }
    pub async fn native(
        store: Store,
        config: AgentConfig,
        tools: Vec<Arc<dyn Tool>>,
        events: mpsc::Sender<AgentEvent>,
    ) -> Result<Self, StorageError> {
        Self::open(store, config, tools, Arc::new(NativeSessionFactory), events).await
    }
    pub async fn is_active(&self) -> Result<bool, StorageError> {
        self.inner.store.query_active(self.inner.id.clone()).await
    }
    pub async fn wait_failure(&self) -> StorageError {
        loop {
            let stopped = self.inner.stopped.notified();
            if let Ok(failure) = self.inner.failure.lock()
                && let Some(failure) = &*failure
            {
                return StorageError(failure.clone());
            }
            stopped.await;
        }
    }
    pub async fn send(
        &self,
        message: Message,
        options: DeliveryOptions,
    ) -> Result<Delivery, StorageError> {
        self.deliver(message, options, false).await
    }
    pub async fn steer(
        &self,
        message: Message,
        options: DeliveryOptions,
    ) -> Result<Delivery, StorageError> {
        self.deliver(message, options, true).await
    }
    async fn deliver(
        &self,
        message: Message,
        options: DeliveryOptions,
        steering: bool,
    ) -> Result<Delivery, StorageError> {
        if self.inner.draining.load(Ordering::Acquire) || self.inner.closing.load(Ordering::Acquire)
        {
            return Err(StorageError(
                "This agent is shutting down and cannot accept new work.".to_owned(),
            ));
        }
        validate_message(&message)?;
        let id = self.inner.id.clone();
        let (delivery, _) = self
            .inner
            .store
            .transact(move |ctx| ctx.deliver(&id, message, options, steering))
            .await?;
        if delivery.created {
            self.inner.notify.notify_one();
        }
        Ok(delivery)
    }
    /// Cancellation never waits behind the persistence or worker locks.
    pub fn abort(&self) {
        self.inner.aborted.store(true, Ordering::Release);
        if let Ok(token) = self.inner.cancel.lock() {
            token.cancel();
        }
        self.inner.notify.notify_one();
    }
    pub async fn compact(&self, instructions: Option<String>) -> Result<(), StorageError> {
        let id = self.inner.id.clone();
        self.inner
            .store
            .transact(move |ctx| {
                if matches!(ctx.query_stage(&id)?, Stage::Idle) {
                    ctx.set_stage(&id, &Stage::Compaction { instructions })
                } else {
                    ctx.set_kv(
                        &id,
                        "agent",
                        "compaction-request",
                        &serde_json::json!({"instructions":instructions}),
                    )
                }
            })
            .await?;
        self.inner.notify.notify_one();
        Ok(())
    }
    /// Drain finishes the current operation and leaves the next durable stage for restart.
    pub async fn drain(mut self) -> Result<(), StorageError> {
        self.inner.draining.store(true, Ordering::Release);
        self.inner.notify.notify_one();
        self.join().await
    }
    pub async fn close(mut self) -> Result<(), StorageError> {
        self.inner.closing.store(true, Ordering::Release);
        self.abort();
        self.join().await
    }
    async fn join(&mut self) -> Result<(), StorageError> {
        if let Some(worker) = self.worker.take() {
            worker
                .await
                .map_err(|e| StorageError(format!("Agent worker failed: {e}")))??;
        }
        Ok(())
    }
}
impl Drop for Agent {
    fn drop(&mut self) {
        self.inner.closing.store(true, Ordering::Release);
        if let Ok(token) = self.inner.cancel.lock() {
            token.cancel();
        }
        self.inner.notify.notify_one();
    }
}

async fn worker(inner: Arc<Inner>, mut recover: bool) -> Result<(), StorageError> {
    let mut session: Option<Box<dyn Session>> = None;
    let mut session_profile: Option<Option<String>> = None;
    loop {
        let notified = inner.notify.notified();
        if inner.draining.load(Ordering::Acquire) {
            break;
        }
        let snapshot = inner.store.query_snapshot(inner.id.clone()).await?;
        if !snapshot.stage.active() {
            if inner.closing.load(Ordering::Acquire) {
                break;
            }
            // An idle abort cannot cancel the next accepted turn.
            inner.aborted.store(false, Ordering::Release);
            if let Ok(mut token) = inner.cancel.lock() {
                *token = CancellationToken::new();
            }
            notified.await;
            continue;
        }
        if recover {
            recover = false;
            if let Stage::Inference {
                inference_id,
                completed_blocks,
                accept_send,
                prepared,
            } = &snapshot.stage
            {
                publish(
                    &inner,
                    AgentEvent::Provider {
                        agent_id: inner.id.clone(),
                        inference_id: inference_id.clone(),
                        event: Event::BlockReset,
                    },
                )
                .await;
                let calls = calls_from_blocks(completed_blocks);
                let stage = if calls.is_empty() {
                    Stage::Inference {
                        inference_id: identity(),
                        completed_blocks: Vec::new(),
                        accept_send: *accept_send,
                        prepared: *prepared,
                    }
                } else {
                    Stage::Tools { calls }
                };
                let id = inner.id.clone();
                inner
                    .store
                    .transact(move |ctx| ctx.set_stage(&id, &stage))
                    .await?;
                continue;
            }
        }
        let cancel = inner
            .cancel
            .lock()
            .map_err(|_| StorageError("Agent cancellation state is unavailable.".to_owned()))?
            .clone();
        if cancel.is_cancelled() || inner.aborted.load(Ordering::Acquire) {
            if let Stage::Tools { calls } = snapshot.stage {
                execute_batch(&inner, &snapshot.config, calls, cancel.clone(), true).await?;
            }
            settle(&inner, true, None).await?;
            inner.aborted.store(false, Ordering::Release);
            if let Ok(mut token) = inner.cancel.lock() {
                *token = CancellationToken::new();
            }
            if inner.closing.load(Ordering::Acquire) {
                break;
            }
            continue;
        }
        match snapshot.stage.clone() {
            Stage::Inference { inference_id, .. } => {
                // Tool-result stages are already committed, so queued steering cannot reorder them.
                let id = inner.id.clone();
                let (accepted, events) = inner
                    .store
                    .transact(move |ctx| ctx.accept_next(&id))
                    .await?;
                for event in events {
                    publish(&inner, event).await;
                }
                if accepted.is_some() {
                    continue;
                }
                let id = inner.id.clone();
                let (compaction, _) = inner
                    .store
                    .transact(move |ctx| {
                        let compact = ctx.query_kv(&id, "agent", "compaction-request")?;
                        if let Some(value) = compact.as_ref().filter(|v| !v.is_null()) {
                            ctx.set_stage(
                                &id,
                                &Stage::Compaction {
                                    instructions: value["instructions"].as_str().map(str::to_owned),
                                },
                            )?;
                            ctx.set_kv(&id, "agent", "compaction-request", &Value::Null)?;
                        }
                        Ok(compact.is_some_and(|v| !v.is_null()))
                    })
                    .await?;
                if compaction {
                    continue;
                }
                let snapshot = inner.store.query_snapshot(inner.id.clone()).await?;
                if session_profile.as_ref() != Some(&snapshot.profile) {
                    if let Some(session) = &mut session {
                        session.destroy().await;
                    }
                    session = None;
                    session_profile = Some(snapshot.profile.clone());
                }
                if session.is_none() {
                    match inner
                        .factory
                        .create(
                            &snapshot.config,
                            inner.tools.iter().map(|tool| tool.definition()).collect(),
                        )
                        .await
                    {
                        Ok(created) => session = Some(created),
                        Err(error) => {
                            settle(&inner, false, Some(error.to_string())).await?;
                            continue;
                        }
                    }
                }
                let context = context(&snapshot);
                let request = RunRequest {
                    context,
                    ..Default::default()
                };
                let Some(session) = &mut session else {
                    continue;
                };
                let (events, mut receiver) = mpsc::channel(128);
                let run = session.run(request, cancel.clone(), events);
                tokio::pin!(run);
                let mut ended = false;
                let mut terminal = None;
                let mut accumulator = Accumulator::default();
                let mut committed_count = 0;
                loop {
                    tokio::select! {
                        _=&mut run,if !ended=>{ ended=true; },
                        event=receiver.recv()=>{ let Some(event)=event else { break; };
                            accumulator.add(&event);
                            if matches!(event,Event::BlockStop) {
                                let blocks=accumulator.committed[committed_count..].to_vec(); committed_count=accumulator.committed.len();
                                let id=inner.id.clone(); inner.store.transact(move|ctx|ctx.commit_block(&id,&blocks)).await?;
                            }
                            if let Event::Done { outcome }=&event { terminal=Some(outcome.clone()); }
                            publish(&inner,AgentEvent::Provider { agent_id:inner.id.clone(),inference_id:inference_id.clone(),event }).await;
                        },
                    }
                }
                let calls = calls_from_blocks(&accumulator.committed);
                let stage = if calls.is_empty() {
                    Stage::Settlement {
                        settlement_id: identity(),
                    }
                } else {
                    Stage::Tools { calls }
                };
                let id = inner.id.clone();
                inner
                    .store
                    .transact(move |ctx| ctx.set_stage(&id, &stage))
                    .await?;
                match terminal {
                    Some(Outcome::Error { error }) => {
                        settle(&inner, false, Some(error.message)).await?;
                    }
                    Some(Outcome::Cancelled) => { /* The loop closes every pending call before settlement. */
                    }
                    None => {
                        publish(
                            &inner,
                            AgentEvent::Provider {
                                agent_id: inner.id.clone(),
                                inference_id,
                                event: Event::BlockReset,
                            },
                        )
                        .await;
                        settle(
                            &inner,
                            false,
                            Some(
                                "The provider stream ended without a completion event.".to_owned(),
                            ),
                        )
                        .await?;
                    }
                    _ => {}
                }
            }
            Stage::Tools { calls } => {
                execute_batch(&inner, &snapshot.config, calls, cancel, false).await?
            }
            Stage::Compaction { instructions } => {
                if session.is_none() {
                    match inner
                        .factory
                        .create(
                            &snapshot.config,
                            inner.tools.iter().map(|tool| tool.definition()).collect(),
                        )
                        .await
                    {
                        Ok(created) => session = Some(created),
                        Err(error) => {
                            settle(&inner, false, Some(error.to_string())).await?;
                            continue;
                        }
                    }
                }
                let Some(session) = &mut session else {
                    continue;
                };
                match session
                    .compact(context(&snapshot), instructions, cancel)
                    .await
                {
                    Compaction::Completed { context, usage } => {
                        let id = inner.id.clone();
                        let (_, events) = inner
                            .store
                            .transact(move |ctx| ctx.replace_context(&id, &context, usage))
                            .await?;
                        for event in events {
                            publish(&inner, event).await;
                        }
                    }
                    Compaction::Cancelled { .. } => {
                        settle(&inner, true, None).await?;
                    }
                    Compaction::Failed { error } => {
                        settle(&inner, false, Some(error.message)).await?;
                    }
                }
            }
            Stage::Settlement { .. } => {
                settle(&inner, false, None).await?;
            }
            Stage::Idle => {}
        }
    }
    if let Some(session) = &mut session {
        session.destroy().await;
    }
    Ok(())
}

async fn execute_batch(
    inner: &Arc<Inner>,
    config: &AgentConfig,
    calls: Vec<PendingCall>,
    cancel: CancellationToken,
    abort: bool,
) -> Result<(), StorageError> {
    let mut tasks = tokio::task::JoinSet::new();
    for call in &calls {
        let id = inner.id.clone();
        let call_id = call.id.clone();
        let (result, _) = inner
            .store
            .transact(move |ctx| ctx.query_call_result(&id, &call_id))
            .await?;
        if result.is_some() {
            continue;
        }
        let tool = inner
            .tools
            .iter()
            .find(|tool| {
                let definition = tool.definition();
                (definition.name == call.name && definition.namespace == call.namespace)
                    || (definition
                        .namespace
                        .as_ref()
                        .is_some_and(|n| format!("{n}__{}", definition.name) == call.name)
                        && call.namespace.is_none())
            })
            .cloned();
        let interrupted =
            call.dispatched && !tool.as_ref().is_some_and(|t| t.durable() || t.reloadable());
        let id = inner.id.clone();
        let dispatched = call.clone();
        let (_, events) = inner
            .store
            .transact(move |ctx| ctx.dispatch_call(&id, &dispatched))
            .await?;
        for event in events {
            publish(inner, event).await;
        }
        let context = ToolContext {
            agent_id: inner.id.clone(),
            call: call.clone(),
            permission_mode: config.permission_mode,
            cancel: cancel.child_token(),
            store: inner.store.clone(),
        };
        tasks.spawn(async move {
            let result = if abort || context.cancel.is_cancelled() {
                ToolResult::error("This tool call was cancelled before execution.")
            } else if interrupted {
                ToolResult::error(
                    "This tool call was interrupted by a restart and cannot be safely repeated.",
                )
            } else if context.call.incomplete {
                ToolResult::error("The provider did not finish this tool call.")
            } else if let Some(tool) = tool {
                execute_tool(tool, context.clone()).await
            } else {
                ToolResult::error(format!(
                    "The requested tool is unavailable: {}.",
                    context.call.name
                ))
            };
            context.commit(result).await
        });
    }
    while let Some(result) = tasks.join_next().await {
        result.map_err(|e| StorageError(format!("Tool execution task failed: {e}")))??;
    }
    let id = inner.id.clone();
    let (_, events) = inner
        .store
        .transact(move |ctx| ctx.complete_batch(&id, &calls))
        .await?;
    for event in events {
        publish(inner, event).await;
    }
    Ok(())
}
async fn execute_tool(tool: Arc<dyn Tool>, mut context: ToolContext) -> ToolResult {
    let arguments = match serde_json::from_str::<Value>(&context.call.arguments) {
        Ok(value) => value,
        Err(_) => return ToolResult::error("The tool arguments are not valid JSON."),
    };
    let definition = tool.definition();
    match jsonschema::validator_for(&definition.parameters) {
        Ok(schema) => {
            if let Err(error) = schema.validate(&arguments) {
                return ToolResult::error(format!(
                    "The tool arguments do not match its schema: {error}"
                ));
            }
        }
        Err(_) => return ToolResult::error("This tool has an invalid argument schema."),
    }
    if context.permission_mode == PermissionMode::Auto
        && tool.should_review_in_auto_mode(&arguments)
    {
        match tool.review(&context, &arguments).await {
            PermissionDecision::Answer(result) => return result,
            PermissionDecision::Run => {}
            PermissionDecision::RunIn(mode) => {
                if mode == PermissionMode::FullAccess
                    && !tool.should_run_in_full_access_in_auto_mode(&arguments)
                {
                    return ToolResult::error(
                        "This tool does not permit automatic elevation for this action.",
                    );
                }
                context.permission_mode = mode;
            }
        }
    }
    let cancel = context.cancel.clone();
    tokio::select! { biased;
        _=cancel.cancelled()=>ToolResult::error("This tool call was cancelled."),
        result=tool.execute(context,arguments)=>match result { Ok(result)=>result,Err(error)=>ToolResult::error(error.to_string()) },
    }
}
async fn settle(inner: &Inner, aborted: bool, error: Option<String>) -> Result<(), StorageError> {
    let id = inner.id.clone();
    let (_, events) = inner
        .store
        .transact(move |ctx| ctx.settle(&id, aborted, error))
        .await?;
    for event in events {
        publish(inner, event).await;
    }
    Ok(())
}
async fn publish(inner: &Inner, event: AgentEvent) {
    let _ = inner.events.send(event).await;
}
fn context(snapshot: &Snapshot) -> SessionContext {
    SessionContext {
        instructions: snapshot.config.instructions.clone(),
        messages: snapshot
            .history
            .iter()
            .map(|(_, message)| message.clone())
            .collect(),
    }
}
fn calls_from_blocks(blocks: &[Block]) -> Vec<PendingCall> {
    blocks
        .iter()
        .filter_map(|block| match block {
            Block::ToolCall {
                call_id,
                name,
                namespace,
                arguments,
                incomplete,
                server: false,
                vendor,
                ..
            } => Some(PendingCall {
                id: identity(),
                provider_call_id: call_id.clone(),
                name: name.clone(),
                namespace: namespace.clone(),
                arguments: arguments.clone(),
                incomplete: *incomplete,
                dispatched: false,
                vendor: vendor.clone(),
            }),
            _ => None,
        })
        .collect()
}
fn validate_message(message: &Message) -> Result<(), StorageError> {
    let requests = message
        .content()
        .iter()
        .filter(|b| matches!(b, Block::ToolCallRequest { .. }))
        .count();
    if requests > 1 || requests > 0 && !matches!(message, Message::User { .. }) {
        return Err(StorageError(
            "Only a user message may contain one tool request.".to_owned(),
        ));
    }
    Ok(())
}
