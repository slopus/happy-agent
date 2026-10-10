//! Window-scoped voice owns its catalog, provider transport and isolated desktop inference.
use super::{
    agent_runtime::AgentRuntimeModule,
    config::{ConfigModule, LiveControllerRoute, LiveCredential, LiveCredentialKind},
    durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration},
    lifecycle::LifecycleModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use futures_util::future::BoxFuture;
use happy_agent_base::AgentModule;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;
mod controller;
mod persistence;
mod protocol;
mod provider;
#[cfg(test)]
mod tests;
mod version;

#[derive(Clone, Debug)]
pub struct LiveError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub session: Option<Value>,
}
impl LiveError {
    fn new(
        status: u16,
        code: &'static str,
        message: impl Into<String>,
        session: Option<Value>,
    ) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            session,
        }
    }
}
impl std::fmt::Display for LiveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}
impl std::error::Error for LiveError {}
pub struct PreparedLiveReservation {
    owner: String,
    request: Value,
    route: LiveControllerRoute,
    credential: LiveCredential,
}
pub struct LiveReservation {
    pub session: Value,
    allocation: watch::Receiver<Option<std::result::Result<String, LiveError>>>,
}
impl LiveReservation {
    pub async fn allocated(mut self) -> Result<String> {
        loop {
            if let Some(result) = self.allocation.borrow_and_update().clone() {
                return result.map_err(Into::into);
            }
            self.allocation.changed().await.map_err(|_| {
                LiveError::new(
                    503,
                    "live_unavailable",
                    "Voice ended before startup completed.",
                    Some(self.session.clone()),
                )
            })?;
        }
    }
}
pub type LiveEventListener = Arc<dyn Fn(Value) + Send + Sync>;
pub struct LiveSubscription {
    owner: Weak<LiveModule>,
    id: u64,
}
impl Drop for LiveSubscription {
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
pub struct LiveModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    lifetime: CancellationToken,
    owner: Weak<Self>,
    schemas: Schemas,
    calls: Mutex<BTreeMap<String, Arc<Call>>>,
    listeners: Mutex<BTreeMap<u64, LiveEventListener>>,
    next_listener: AtomicU64,
    stopped: AtomicBool,
    #[cfg(test)]
    transport_endpoints: Mutex<Option<provider::Endpoints>>,
}
struct Call {
    id: String,
    owner: String,
    route: LiveControllerRoute,
    credential_kind: LiveCredentialKind,
    credential: Mutex<Option<LiveCredential>>,
    sdp: Mutex<Option<String>>,
    state: Mutex<CallState>,
    transport: Mutex<Option<Arc<provider::ProviderTransport>>>,
    abort: CancellationToken,
    disposed: CancellationToken,
    controller_abort: CancellationToken,
    attached: CancellationToken,
    queue: mpsc::Sender<QueuedCommand>,
    slots: Arc<Semaphore>,
    queued_bytes: Arc<AtomicUsize>,
    allocation: watch::Sender<Option<std::result::Result<String, LiveError>>>,
    ended: watch::Receiver<bool>,
}
struct CallState {
    lifetime: CallLifetime,
    failure: FailureState,
    session: Value,
    context: Value,
    control: ControlState,
    controller: ControllerState,
    controller_lost: bool,
    fragments: VecDeque<Value>,
    actions: BTreeMap<String, ActionState>,
    watched: BTreeSet<String>,
    updates: BTreeMap<String, Value>,
    delegations: BTreeSet<String>,
}
enum CallLifetime {
    Owned,
    Disposed,
}
enum FailureState {
    Available,
    Scheduled,
    Recorded,
}
enum ControlState {
    Unclaimed,
    Claimed,
    Attached {
        sender: mpsc::Sender<QueuedFrame>,
        bytes: Arc<AtomicUsize>,
    },
    Closed,
}
enum ControllerState {
    Idle,
    Running,
}
struct ActionState {
    action: Value,
    result: Option<Value>,
    expired: bool,
    reply: Option<oneshot::Sender<Result<Value>>>,
}
struct QueueBudget {
    bytes: Arc<AtomicUsize>,
    size: usize,
    _permit: OwnedSemaphorePermit,
}
impl Drop for QueueBudget {
    fn drop(&mut self) {
        self.bytes.fetch_sub(self.size, Ordering::AcqRel);
    }
}
struct QueuedCommand {
    command: Command,
    _budget: QueueBudget,
}
enum Command {
    Provider(Value),
    Desktop(String),
    ControllerComplete {
        delegation: String,
        outcome: std::result::Result<String, controller::Failure>,
    },
    CloseRequested,
    ConnectionLost,
    AttachExpired,
}
struct Procedure {
    owner: Weak<LiveModule>,
}
impl LiveModule {
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        agents: Arc<AgentRuntimeModule>,
        lifecycle: Arc<LifecycleModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in [
            "ownerLiveSession",
            "ownerLiveStored",
            "ownerLiveClientMessage",
            "ownerLiveServerMessage",
            "ownerLiveDesktopAction",
            "ownerLiveDesktopActionResult",
            "ownerLiveCreateRequest",
            "ownerLiveCredential",
            "ownerLiveStartArgs",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        let module = Arc::new_cyclic(|owner| Self {
            config,
            runtime,
            durable: durable.clone(),
            lifetime: lifecycle.shutdown.child_token(),
            owner: owner.clone(),
            schemas,
            calls: Mutex::new(BTreeMap::new()),
            listeners: Mutex::new(BTreeMap::new()),
            next_listener: AtomicU64::new(1),
            stopped: AtomicBool::new(false),
            #[cfg(test)]
            transport_endpoints: Mutex::new(None),
        });
        durable.register(Registration {
            name: "live-start-once".to_owned(),
            arguments_schema: "ownerLiveStartArgs",
            result_schema: "ownerNull",
            function: Arc::new(Procedure {
                owner: Arc::downgrade(&module),
            }),
        })?;
        agents.install(module.clone())?;
        Ok(module)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime
            .migrate("live", persistence::MIGRATIONS)
            .await?;
        let owner = self.clone();
        self.runtime.transact(move|ctx|{for stored in persistence::active(ctx,&owner.schemas,None)? {let session=&stored["session"];owner.update(ctx,stored["ownerId"].as_str().unwrap(),session,json!({"status":"failed","error":"Voice ended because the daemon restarted. Start a new call explicitly.","endedAt":super::identity::now(),"usage":{"seconds":session["usage"]["seconds"],"final":false}}),None)?;}Ok(())}).await
    }
    pub fn on_event(self: &Arc<Self>, listener: LiveEventListener) -> Result<LiveSubscription> {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The voice event subscriber bound was reached."
        );
        let id = self.next_listener.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(LiveSubscription {
            owner: Arc::downgrade(self),
            id,
        })
    }
    fn publish(&self, ctx: &Context<'_>, event: Value) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid("ownerLiveEvent", &event)?,
            "The voice event is invalid."
        );
        let listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        ctx.after_commit(move || {
            for listener in listeners {
                let event = event.clone();
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(event)));
            }
        })?;
        Ok(())
    }
    pub async fn prepare_reservation(
        &self,
        owner: &str,
        request: &Value,
    ) -> Result<PreparedLiveReservation> {
        anyhow::ensure!(self.schemas.valid("ownerLiveCreateRequest",request)?&&request["windowId"]==request["context"]["windowId"]&&serde_json::to_vec(&json!({"type":"desktopContext","revision":request["contextRevision"],"context":request["context"]}))?.len()<=256*1024,LiveError::new(400,"invalid_request","The voice request or desktop context is invalid or too large.",None));
        anyhow::ensure!(
            !self.stopped.load(Ordering::Acquire),
            LiveError::new(503, "live_unavailable", "Voice is shutting down.", None)
        );
        let route=self.config.live_controller_route().await.map_err(|_|LiveError::new(503,"live_unavailable","Voice cannot use the default controller model. Check the enabled default model and its accounts.",None))?;
        let credential=self.config.live_credential(&request["credential"]).await.map_err(|_|LiveError::new(503,"live_unavailable","Voice cannot use the selected OpenAI credential. Check that the selected account is enabled, signed in, and holds the selected credential type.",None))?;
        Ok(PreparedLiveReservation {
            owner: owner.to_owned(),
            request: request.clone(),
            route,
            credential,
        })
    }
    pub fn reserve(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        prepared: PreparedLiveReservation,
    ) -> Result<LiveReservation> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            !self.stopped.load(Ordering::Acquire),
            LiveError::new(503, "live_unavailable", "Voice is shutting down.", None)
        );
        let PreparedLiveReservation {
            owner,
            request,
            route,
            credential,
        } = prepared;
        let id = request["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(cuid2::create_id);
        if let Some(session) = persistence::read(ctx, &self.schemas, &owner, &id)? {
            return Err(LiveError::new(
                409,
                "conflict",
                "This voice session ID has already been used.",
                Some(session),
            )
            .into());
        }
        anyhow::ensure!(
            !persistence::exists(ctx, &id)?,
            LiveError::new(404, "not_found", "The voice session was not found.", None)
        );
        persistence::prune(ctx, &owner, super::identity::now())?;
        let active = persistence::active(ctx, &self.schemas, Some(&owner))?;
        anyhow::ensure!(
            active.len() < 4
                && !active
                    .iter()
                    .any(|stored| stored["session"]["windowId"] == request["windowId"]),
            LiveError::new(
                409,
                "conflict",
                "This window already has voice, or the account has four active voice sessions.",
                None
            )
        );
        let timestamp = super::identity::now();
        let session = json!({"id":id,"windowId":request["windowId"],"credential":request["credential"],"contextRevision":request["contextRevision"],"status":"starting","usage":{"seconds":null,"final":false},"error":null,"createdAt":timestamp,"updatedAt":timestamp,"endedAt":null,"version":version::next(None)?});
        persistence::save(ctx, &self.schemas, &owner, &session)?;
        let (sender, receiver) = mpsc::channel(64);
        let (allocation, allocation_receiver) = watch::channel(None);
        let (end, ended) = watch::channel(false);
        let call = Arc::new(Call {
            id: id.clone(),
            owner: owner.clone(),
            route,
            credential_kind: credential.kind,
            credential: Mutex::new(Some(credential)),
            sdp: Mutex::new(Some(request["sdp"].as_str().unwrap().to_owned())),
            state: Mutex::new(CallState {
                lifetime: CallLifetime::Owned,
                failure: FailureState::Available,
                session: session.clone(),
                context: request["context"].clone(),
                control: ControlState::Unclaimed,
                controller: ControllerState::Idle,
                controller_lost: false,
                fragments: VecDeque::new(),
                actions: BTreeMap::new(),
                watched: BTreeSet::new(),
                updates: BTreeMap::new(),
                delegations: BTreeSet::new(),
            }),
            transport: Mutex::new(None),
            abort: self.lifetime.child_token(),
            disposed: CancellationToken::new(),
            controller_abort: self.lifetime.child_token(),
            attached: CancellationToken::new(),
            queue: sender,
            slots: Arc::new(Semaphore::new(64)),
            queued_bytes: Arc::new(AtomicUsize::new(0)),
            allocation,
            ended,
        });
        let module = self.clone();
        let registered = call.clone();
        let call_id = id.clone();
        ctx.after_commit(move || {
            module
                .calls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(call_id, registered.clone());
            tokio::spawn(async move {
                module.run(registered, receiver, end).await;
            });
        })?;
        let mut payload = json!({"session":session});
        if let Some(mutation) = request.get("mutationId") {
            payload["mutationId"] = mutation.clone();
        }
        self.publish(
            ctx,
            json!({"ownerId":owner,"type":"live.session.created","payload":payload}),
        )?;
        self.durable.invoke(ctx,&json!({"function":"live-start-once","arguments":{"id":id},"operationId":format!("live:{id}")}))?;
        Ok(LiveReservation {
            session,
            allocation: allocation_receiver,
        })
    }
    pub async fn reserve_direct(
        self: &Arc<Self>,
        owner: &str,
        request: &Value,
    ) -> Result<LiveReservation> {
        let prepared = self.prepare_reservation(owner, request).await?;
        let module = self.clone();
        self.runtime
            .transact(move |ctx| module.reserve(ctx, prepared))
            .await
    }
    pub fn get(&self, ctx: &Context<'_>, owner: &str, id: &str) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        persistence::prune(ctx, owner, super::identity::now())?;
        persistence::read(ctx, &self.schemas, owner, id)?.ok_or_else(|| {
            LiveError::new(404, "not_found", "The voice session was not found.", None).into()
        })
    }
    pub fn close(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        owner: &str,
        id: &str,
        mutation: Option<&str>,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let session = self.get(ctx, owner, id)?;
        if terminal(&session) || session["status"] == "closing" {
            return Ok(session);
        }
        let next = self.update(
            ctx,
            owner,
            &session,
            json!({"status":"closing","error":null}),
            mutation,
        )?;
        let module = self.clone();
        let id = id.to_owned();
        ctx.after_commit(move || {
            if let Some(call) = module.call(&id) {
                module.enqueue(&call, Command::CloseRequested, 0);
            }
        })?;
        Ok(next)
    }
    fn call(&self, id: &str) -> Option<Arc<Call>> {
        self.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .cloned()
    }
    fn update(
        &self,
        ctx: &Context<'_>,
        owner: &str,
        current: &Value,
        mut changes: Value,
        mutation: Option<&str>,
    ) -> Result<Value> {
        changes["updatedAt"] = json!(super::identity::now());
        let mut session = current.clone();
        for (key, value) in changes.as_object().unwrap() {
            session[key] = value.clone();
        }
        session["version"] = json!(version::next(current["version"].as_str())?);
        persistence::save(ctx, &self.schemas, owner, &session)?;
        let module = self
            .owner
            .upgrade()
            .context("The voice module was closed.")?;
        let committed = session.clone();
        ctx.after_commit(move||{if let Some(call)=module.call(committed["id"].as_str().unwrap()){call.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).session=committed.clone();if let Err(error)=module.send(&call,json!({"type":"status","status":committed["status"],"error":committed["error"]})){module.fail_async(call,error.to_string());}}})?;
        let mut payload = json!({"sessionId":session["id"],"previousVersion":current["version"],"version":session["version"],"changes":changes});
        if let Some(mutation) = mutation {
            payload["mutationId"] = json!(mutation);
        }
        self.publish(
            ctx,
            json!({"ownerId":owner,"type":"live.session.updated","payload":payload}),
        )?;
        Ok(session)
    }
    async fn change(self: &Arc<Self>, call: &Arc<Call>, changes: Value) -> Result<()> {
        let module = self.clone();
        let call = call.clone();
        self.runtime
            .transact(move |ctx| {
                let Some(current) = persistence::read(ctx, &module.schemas, &call.owner, &call.id)?
                else {
                    return Ok(());
                };
                if !terminal(&current) {
                    module.update(ctx, &call.owner, &current, changes, None)?;
                }
                Ok(())
            })
            .await
    }
    fn enqueue(self: &Arc<Self>, call: &Arc<Call>, command: Command, size: usize) {
        if terminal(&call.session()) {
            return;
        }
        let permit = call.slots.clone().try_acquire_owned();
        let accepted =
            call.queued_bytes
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |bytes| {
                    bytes
                        .checked_add(size)
                        .filter(|bytes| *bytes <= 1024 * 1024)
                });
        match (permit, accepted) {
            (Ok(permit), Ok(_)) => {
                let budget = QueueBudget {
                    bytes: call.queued_bytes.clone(),
                    size,
                    _permit: permit,
                };
                if call
                    .queue
                    .try_send(QueuedCommand {
                        command,
                        _budget: budget,
                    })
                    .is_err()
                {
                    self.fail_async(
                        call.clone(),
                        "Voice exceeded its control queue limit.".to_owned(),
                    );
                }
            }
            (permit, accepted) => {
                drop(permit);
                if accepted.is_ok() {
                    call.queued_bytes.fetch_sub(size, Ordering::AcqRel);
                }
                self.fail_async(
                    call.clone(),
                    "Voice exceeded its control queue limit.".to_owned(),
                );
            }
        }
    }
    fn fail_async(self: &Arc<Self>, call: Arc<Call>, message: String) {
        {
            let mut state = call
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !matches!(state.failure, FailureState::Available) {
                return;
            }
            state.failure = FailureState::Scheduled;
        }
        let module = self.clone();
        tokio::spawn(async move {
            if let Err(error) = module.fail(&call, &message, None).await {
                tracing::warn!(%error,"The voice failure could not be recorded.");
                module.dispose(&call);
            }
            call.state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .failure = FailureState::Recorded;
        });
    }
    async fn fail(
        self: &Arc<Self>,
        call: &Arc<Call>,
        message: &str,
        provider: Option<provider::ProviderFailure>,
    ) -> Result<()> {
        if !terminal(&call.session()) {
            self.change(
                call,
                json!({"status":"failed","error":message,"endedAt":super::identity::now()}),
            )
            .await?;
        }
        call.allocation.send_if_modified(|result| {
            if result.is_none() {
                *result = Some(Err(LiveError::new(
                    provider.map_or(503, |error| error.status()),
                    provider.map_or("live_unavailable", |error| error.code()),
                    message,
                    Some(call.session()),
                )));
                true
            } else {
                false
            }
        });
        self.dispose(call);
        Ok(())
    }
    fn dispose(&self, call: &Arc<Call>) {
        {
            let mut state = call
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if matches!(state.lifetime, CallLifetime::Disposed) {
                return;
            }
            state.lifetime = CallLifetime::Disposed;
        }
        call.attached.cancel();
        call.controller_abort.cancel();
        call.abort.cancel();
        if let Some(transport) = call.transport() {
            transport.dispose();
        }
        self.cancel_actions(call);
        let mut state = call
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let ControlState::Attached { sender, bytes } = &state.control {
            let _ = sender.try_send(QueuedFrame {
                frame: LiveControlFrame::Close {
                    code: 1000,
                    reason: "Voice has ended.".to_owned(),
                },
                budget: FrameBudget {
                    bytes: bytes.clone(),
                    size: 0,
                },
            });
        }
        state.control = ControlState::Closed;
        drop(state);
        call.disposed.cancel();
        self.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&call.id);
    }
    async fn start(self: &Arc<Self>, call: Arc<Call>) -> Result<()> {
        let credential = call
            .credential
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            .context("The voice allocation was already attempted.")?;
        let sdp = call
            .sdp
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            .context("The voice offer was already consumed.")?;
        let (events, mut receiver) = mpsc::channel(64);
        let module = self.clone();
        let receiving = call.clone();
        tokio::spawn(async move {
            while let Some(event) = receiver.recv().await {
                let bytes = serde_json::to_vec(&event).map_or(1024 * 1024 + 1, |value| value.len());
                module.enqueue(&receiving, Command::Provider(event), bytes);
            }
        });
        #[cfg(test)]
        let endpoints = self
            .transport_endpoints
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        #[cfg(not(test))]
        let endpoints: Option<provider::Endpoints> = None;
        let opening = if let Some(endpoints) = endpoints {
            provider::ProviderTransport::open_at(
                credential,
                sdp,
                include_str!("live/voice-instructions.txt").trim(),
                call.abort.clone(),
                events,
                endpoints,
            )
            .await
        } else {
            provider::ProviderTransport::open(
                credential,
                sdp,
                include_str!("live/voice-instructions.txt").trim(),
                call.abort.clone(),
                events,
            )
            .await
        };
        match opening {
            Ok(transport) => {
                let answer = transport.sdp.clone();
                let transport = Arc::new(transport);
                *call
                    .transport
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(transport.clone());
                if terminal(&call.session()) || call.session()["status"] == "closing" {
                    transport.dispose();
                    self.fail(&call, "Voice stopped during startup.", None)
                        .await?;
                    return Ok(());
                }
                let attached = {
                    let state = call
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    matches!(state.control, ControlState::Attached { .. })
                };
                if !attached {
                    let module = self.clone();
                    let waiting = call.clone();
                    tokio::spawn(async move {
                        tokio::select! {_=waiting.attached.cancelled()=>{},_=waiting.abort.cancelled()=>{},_=tokio::time::sleep(Duration::from_secs(15))=>module.enqueue(&waiting,Command::AttachExpired,0)}
                    });
                }
                call.allocation.send_if_modified(|allocation| {
                    if allocation.is_none() {
                        *allocation = Some(Ok(answer.clone()));
                        true
                    } else {
                        false
                    }
                });
            }
            Err(error) => {
                let failure = error.downcast_ref::<provider::ProviderFailure>().copied();
                self.fail(&call,failure.map_or("Voice could not start on the selected account. Check GPT-Live access and connectivity; no fallback or retry was attempted.",|error|error.message()),failure).await?;
            }
        }
        Ok(())
    }
    async fn run(
        self: Arc<Self>,
        call: Arc<Call>,
        mut receiver: mpsc::Receiver<QueuedCommand>,
        end: watch::Sender<bool>,
    ) {
        loop {
            let command = tokio::select! {_=call.disposed.cancelled()=>break,command=receiver.recv()=>match command{Some(command)=>command,None=>break}};
            let outcome = match command.command {
                Command::Provider(event) => self.provider_event(&call, event).await,
                Command::Desktop(text) => self.desktop_message(&call, &text).await,
                Command::ControllerComplete {
                    delegation,
                    outcome,
                } => self.controller_complete(&call, &delegation, outcome).await,
                Command::CloseRequested => self.close_transport(&call).await,
                Command::ConnectionLost => {
                    call.state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .controller_lost = true;
                    let module = self.clone();
                    let owner = call.owner.clone();
                    let id = call.id.clone();
                    self.runtime
                        .transact(move |ctx| module.close(ctx, &owner, &id, None))
                        .await
                        .map(|_| ())
                }
                Command::AttachExpired => {
                    self.fail(
                        &call,
                        "The desktop did not attach to voice within 15 seconds.",
                        None,
                    )
                    .await
                }
            };
            if outcome.is_err() {
                let _ = self
                    .fail(
                        &call,
                        "Voice received invalid or conflicting control data and ended safely.",
                        None,
                    )
                    .await;
            }
            drop(command._budget);
            if terminal(&call.session()) {
                break;
            }
        }
        end.send_replace(true);
    }
    async fn close_transport(self: &Arc<Self>, call: &Arc<Call>) -> Result<()> {
        call.controller_abort.cancel();
        self.cancel_actions(call);
        if let Some(transport) = call.transport() {
            let module = self.clone();
            let closing = call.clone();
            tokio::spawn(async move {
                if transport.close().await.is_err() {
                    // The transport publishes its sanitized ended event before releasing this
                    // barrier. Let the actor preserve that actual reason in the catalog.
                    let mut ended = closing.ended.clone();
                    let observed = tokio::time::timeout(Duration::from_secs(25), async {
                        loop {
                            if *ended.borrow_and_update() {
                                return Ok::<_, anyhow::Error>(());
                            }
                            ended.changed().await?;
                        }
                    })
                    .await;
                    if !matches!(observed, Ok(Ok(()))) && !terminal(&closing.session()) {
                        let _ = module
                            .fail(
                                &closing,
                                "The voice connection could not close cleanly.",
                                None,
                            )
                            .await;
                    }
                }
            });
        } else {
            self.fail(call, "Voice was stopped before startup completed.", None)
                .await?;
        }
        Ok(())
    }
    pub async fn stop(self: &Arc<Self>) -> Result<()> {
        self.stopped.store(true, Ordering::Release);
        let calls = self
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let results = futures_util::future::join_all(calls.into_iter().map(|call| {
            let module = self.clone();
            async move {
                let owner = call.owner.clone();
                let id = call.id.clone();
                let closing = module.clone();
                module
                    .runtime
                    .transact(move |ctx| closing.close(ctx, &owner, &id, None))
                    .await?;
                if let Some(transport) = call.transport() {
                    transport.close().await?;
                }
                let mut ended = call.ended.clone();
                tokio::time::timeout(Duration::from_secs(25), async {
                    loop {
                        if *ended.borrow_and_update() {
                            break;
                        }
                        ended.changed().await?;
                    }
                    Ok::<_, anyhow::Error>(())
                })
                .await
                .context("Voice could not finish its teardown before the shutdown deadline.")??;
                Ok::<_, anyhow::Error>(())
            }
        }))
        .await;
        for result in results {
            result?;
        }
        Ok(())
    }
}
impl Call {
    fn session(&self) -> Value {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .session
            .clone()
    }
    fn transport(&self) -> Option<Arc<provider::ProviderTransport>> {
        self.transport
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}
fn terminal(session: &Value) -> bool {
    session["status"] == "closed" || session["status"] == "failed"
}
impl DurableFunction for Procedure {
    fn execute(
        self: Arc<Self>,
        call: Value,
        kv: CallKv,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            let module = self
                .owner
                .upgrade()
                .context("The voice module was closed.")?;
            let Some(live) = module.call(call["arguments"]["id"].as_str().unwrap()) else {
                return Ok(Value::Null);
            };
            let attempted = module
                .runtime
                .transact(move |ctx| {
                    if kv.read(ctx, "attempted")?.is_some() {
                        return Ok(true);
                    }
                    kv.write(ctx, "attempted", &json!(true))?;
                    Ok(false)
                })
                .await?;
            if attempted {
                module
                    .fail(
                        &live,
                        "Voice startup was interrupted and was not retried.",
                        None,
                    )
                    .await?;
            } else {
                anyhow::ensure!(!cancel.is_cancelled(), "Voice startup was cancelled.");
                module.start(live).await?;
            }
            Ok(Value::Null)
        })
    }
}
#[async_trait]
impl AgentModule for LiveModule {
    fn name(&self) -> &'static str {
        "live"
    }
    async fn close(&self) {
        if let Some(module) = self.owner.upgrade()
            && let Err(error) = module.stop().await
        {
            tracing::warn!(%error,"Voice could not finish cleanly during shutdown.");
        }
    }
}

pub enum LiveControlFrame {
    Message(String),
    Close { code: u16, reason: String },
}
struct FrameBudget {
    bytes: Arc<AtomicUsize>,
    size: usize,
}
impl Drop for FrameBudget {
    fn drop(&mut self) {
        self.bytes.fetch_sub(self.size, Ordering::AcqRel);
    }
}
struct QueuedFrame {
    frame: LiveControlFrame,
    budget: FrameBudget,
}
pub struct PreparedControl {
    owner: Weak<LiveModule>,
    call: Arc<Call>,
    window: String,
    consumed: bool,
}
pub struct LiveControl {
    owner: Weak<LiveModule>,
    call: Arc<Call>,
    receiver: mpsc::Receiver<QueuedFrame>,
    closed: bool,
}
