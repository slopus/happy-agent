//! Machine operations and runner connections, owned by the runners feature.
use crate::product::{
    config::ConfigModule, identity::now, lifecycle::LifecycleModule, runtime::RuntimeModule,
    schemas::Schemas,
};
use anyhow::{Context as _, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{Notify, mpsc, oneshot, watch},
};
use tokio_util::sync::CancellationToken;

#[path = "runners_compute.rs"]
mod compute;
#[path = "runners_persistence.rs"]
mod persistence;
#[path = "runners_tunnel.rs"]
mod tunnel;
pub use compute::{RunnerCompute, RunnerProcess};

#[cfg(test)]
#[path = "runners_compute_tests.rs"]
mod compute_tests;

const FRAME_LIMIT: usize = 64 * 1024 * 1024;
type Frame = (Value, Vec<u8>);
type RpcAnswer = oneshot::Sender<Result<Frame>>;
type StreamSender = mpsc::Sender<Frame>;
type StreamReceiver = mpsc::Receiver<Frame>;
const METHODS: &[(&str, &str, &str)] = &[
    (
        "compute.create",
        "ownerRunnerParams_compute_create",
        "ownerRunnerResult_compute_create",
    ),
    (
        "compute.dispose",
        "ownerRunnerParams_compute_dispose",
        "ownerRunnerResult_compute_dispose",
    ),
    (
        "fs.exists",
        "ownerRunnerParams_fs_exists",
        "ownerRunnerResult_fs_exists",
    ),
    (
        "fs.lstat",
        "ownerRunnerParams_fs_lstat",
        "ownerRunnerResult_fs_lstat",
    ),
    (
        "fs.mkdir",
        "ownerRunnerParams_fs_mkdir",
        "ownerRunnerResult_fs_mkdir",
    ),
    (
        "fs.move",
        "ownerRunnerParams_fs_move",
        "ownerRunnerResult_fs_move",
    ),
    (
        "fs.realpath",
        "ownerRunnerParams_fs_realpath",
        "ownerRunnerResult_fs_realpath",
    ),
    (
        "fs.readFileBuffer",
        "ownerRunnerParams_fs_readFileBuffer",
        "ownerRunnerResult_fs_readFileBuffer",
    ),
    (
        "fs.readdir",
        "ownerRunnerParams_fs_readdir",
        "ownerRunnerResult_fs_readdir",
    ),
    (
        "fs.rm",
        "ownerRunnerParams_fs_rm",
        "ownerRunnerResult_fs_rm",
    ),
    (
        "process.start",
        "ownerRunnerParams_process_start",
        "ownerRunnerResult_process_start",
    ),
    (
        "process.signal",
        "ownerRunnerParams_process_signal",
        "ownerRunnerResult_process_signal",
    ),
    (
        "shell.run",
        "ownerRunnerParams_shell_run",
        "ownerRunnerResult_shell_run",
    ),
    (
        "net.listen",
        "ownerRunnerParams_net_listen",
        "ownerRunnerResult_net_listen",
    ),
    (
        "net.accept",
        "ownerRunnerParams_net_accept",
        "ownerRunnerResult_net_accept",
    ),
    (
        "fs.chmod",
        "ownerRunnerParams_fs_chmod",
        "ownerRunnerResult_fs_chmod",
    ),
    (
        "fs.lstatMany",
        "ownerRunnerParams_fs_lstatMany",
        "ownerRunnerResult_fs_lstatMany",
    ),
    (
        "fs.readFile",
        "ownerRunnerParams_fs_readFile",
        "ownerRunnerResult_fs_readFile",
    ),
    (
        "fs.readdirPage",
        "ownerRunnerParams_fs_readdirPage",
        "ownerRunnerResult_fs_readdirPage",
    ),
    (
        "fs.setModificationTime",
        "ownerRunnerParams_fs_setModificationTime",
        "ownerRunnerResult_fs_setModificationTime",
    ),
    (
        "fs.stat",
        "ownerRunnerParams_fs_stat",
        "ownerRunnerResult_fs_stat",
    ),
    (
        "fs.writeFile",
        "ownerRunnerParams_fs_writeFile",
        "ownerRunnerResult_fs_writeFile",
    ),
    (
        "shell.startSession",
        "ownerRunnerParams_shell_startSession",
        "ownerRunnerResult_shell_startSession",
    ),
    (
        "shell.readSession",
        "ownerRunnerParams_shell_readSession",
        "ownerRunnerResult_shell_readSession",
    ),
    (
        "shell.killSession",
        "ownerRunnerParams_shell_killSession",
        "ownerRunnerResult_shell_killSession",
    ),
    (
        "shell.writeSession",
        "ownerRunnerParams_shell_writeSession",
        "ownerRunnerResult_shell_writeSession",
    ),
    (
        "shell.interruptSession",
        "ownerRunnerParams_shell_interruptSession",
        "ownerRunnerResult_shell_interruptSession",
    ),
    (
        "shell.killAllSessions",
        "ownerRunnerParams_shell_killAllSessions",
        "ownerRunnerResult_shell_killAllSessions",
    ),
    (
        "shell.detachSession",
        "ownerRunnerParams_shell_detachSession",
        "ownerRunnerResult_shell_detachSession",
    ),
    (
        "process.resize",
        "ownerRunnerParams_process_resize",
        "ownerRunnerResult_process_resize",
    ),
    (
        "watch.start",
        "ownerRunnerParams_watch_start",
        "ownerRunnerResult_watch_start",
    ),
    (
        "net.connect",
        "ownerRunnerParams_net_connect",
        "ownerRunnerResult_net_connect",
    ),
];

pub struct RunnersModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    lifecycle: Arc<LifecycleModule>,
    schemas: Schemas,
    instance: String,
    links: Mutex<BTreeMap<String, Arc<Link>>>,
    closed: AtomicBool,
    updates: watch::Sender<Value>,
    computes: Mutex<BTreeMap<(String, String), Arc<RunnerCompute>>>,
    snapshot_listeners: Mutex<BTreeMap<u64, SnapshotListener>>,
    next_listener: AtomicU64,
}
type SnapshotListener =
    Arc<dyn for<'a> Fn(&crate::product::runtime::Context<'a>, &Value) -> Result<()> + Send + Sync>;
pub struct RunnerSnapshotSubscription {
    owner: std::sync::Weak<RunnersModule>,
    id: u64,
}
impl Drop for RunnerSnapshotSubscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            owner
                .snapshot_listeners
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&self.id);
        }
    }
}
struct Link {
    session: Mutex<Option<Arc<Session>>>,
    changed: Notify,
    since: AtomicU64,
    reason: Mutex<Option<String>>,
    reports: Mutex<Reports>,
    lease: Mutex<Option<CancellationToken>>,
}
struct Reports {
    epoch: Option<String>,
    sequence: u64,
}
struct Session {
    sender: mpsc::Sender<Vec<u8>>,
    cancel: CancellationToken,
    requests: Mutex<HashMap<u64, RpcAnswer>>,
    streams: Mutex<HashMap<u64, StreamSender>>,
    next: AtomicU64,
    next_stream: AtomicU64,
    identity: Value,
    product: tokio::sync::Mutex<bool>,
    tunnel: tokio::sync::Mutex<Option<tunnel::Tunnel>>,
}
struct ConnectionGuard {
    owner: Arc<RunnersModule>,
    runner: String,
    link: Arc<Link>,
    session: Arc<Session>,
}
impl ConnectionGuard {
    fn disconnect(&self, reason: Option<String>) -> bool {
        self.session.cancel.cancel();
        self.session
            .requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.session
            .streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        let removed = {
            let mut current = self
                .link
                .session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if current
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &self.session))
            {
                current.take();
                true
            } else {
                false
            }
        };
        if removed {
            self.link.since.store(now(), Ordering::Release);
            *self
                .link
                .reason
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = reason;
            self.link.changed.notify_waiters();
            self.owner
                .start_lease(self.runner.clone(), self.link.clone());
        }
        removed
    }
}
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        if self.disconnect(Some("The runner connection ended.".into())) {
            let owner = self.owner.clone();
            // The connection owns cleanup even when its caller stops waiting.
            // This projection belongs to the application's independent lifetime.
            tokio::spawn(async move {
                let result = tokio::time::timeout(Duration::from_secs(10), owner.snapshot()).await;
                if !matches!(result, Ok(Ok(_))) {
                    eprintln!("The disconnected runner status could not be saved.");
                }
            });
        }
    }
}
/// A transport authenticated at the HTTP boundary. The feature owns its framing,
/// handshake, request routing, liveness and lifetime after acceptance.
pub struct RunnerTransport {
    pub incoming: mpsc::Receiver<Vec<u8>>,
    pub outgoing: mpsc::Sender<Vec<u8>>,
}
pub struct RunOptions {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub environment: BTreeMap<String, Option<String>>,
    pub maximum_bytes: usize,
    pub timeout: Duration,
}
pub struct RunResult {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub truncated: bool,
    pub timed_out: bool,
}

impl RunnersModule {
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        lifecycle: Arc<LifecycleModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in [
            "ownerRunnerSnapshot",
            "ownerRunnerFrame",
            "ownerRunnersConfiguration",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        for (_, params, result) in METHODS {
            let _ = schemas.valid(params, &Value::Null)?;
            let _ = schemas.valid(result, &Value::Null)?;
        }
        let configuration = config.runners_configuration();
        anyhow::ensure!(
            schemas.valid("ownerRunnersConfiguration", &configuration)?,
            "The runner configuration is invalid."
        );
        Ok(Arc::new(Self {
            config,
            runtime,
            lifecycle,
            schemas,
            instance: uuid::Uuid::new_v4().to_string(),
            links: Mutex::new(BTreeMap::new()),
            closed: AtomicBool::new(false),
            updates: watch::channel(Value::Null).0,
            computes: Mutex::new(BTreeMap::new()),
            snapshot_listeners: Mutex::new(BTreeMap::new()),
            next_listener: AtomicU64::new(1),
        }))
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime
            .migrate("runners", persistence::MIGRATIONS)
            .await?;
        self.snapshot().await.map(|_| ())
    }
    pub fn enabled(&self) -> bool {
        self.config.runners_configuration()["entries"]
            .as_object()
            .is_some_and(|entries| !entries.is_empty())
    }
    pub fn place(&self, runner: Option<&str>) -> Result<Option<String>> {
        let configuration = self.config.runners_configuration();
        if let Some(runner) = runner {
            anyhow::ensure!(
                configuration["entries"].get(runner).is_some(),
                "No runner called {runner} is configured."
            );
            return Ok(Some(runner.to_owned()));
        }
        Ok(configuration["defaultId"].as_str().map(str::to_owned))
    }
    pub fn authenticate(&self, authorization: &str) -> Option<String> {
        let token = authorization.strip_prefix("Bearer ")?;
        let configuration = self.config.runners_configuration();
        let mut found = None;
        for (id, entry) in configuration["entries"].as_object()? {
            let expected = entry["token"].as_str()?;
            if expected.len() == token.len()
                && bool::from(expected.as_bytes().ct_eq(token.as_bytes()))
            {
                found = Some(id.clone());
            }
        }
        found
    }
    /// Observe committed runner snapshots, retaining only the most recent one.
    pub fn on_updated(&self) -> watch::Receiver<Value> {
        self.updates.subscribe()
    }
    pub fn on_snapshot_transactional(
        self: &Arc<Self>,
        listener: SnapshotListener,
    ) -> Result<RunnerSnapshotSubscription> {
        let mut listeners = self
            .snapshot_listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The runner status listener limit was reached."
        );
        let id = self.next_listener.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(RunnerSnapshotSubscription {
            owner: Arc::downgrade(self),
            id,
        })
    }
    pub fn is_connected(&self, id: &str) -> bool {
        self.links
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .is_some_and(|link| {
                link.session
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .as_ref()
                    .is_some_and(|session| !session.cancel.is_cancelled())
            })
    }
    pub fn known_machine(
        &self,
        ctx: &crate::product::runtime::Context<'_>,
        id: &str,
    ) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        Ok(persistence::read(ctx, &self.schemas)?.and_then(|snapshot| {
            snapshot["runners"]
                .as_array()
                .and_then(|runners| runners.iter().find(|runner| runner["id"] == id))
                .and_then(|runner| {
                    (!runner["machine"].is_null()).then(|| runner["machine"].clone())
                })
        }))
    }
    /// Establish the product machine before entering a caller's transaction.
    pub async fn prepare_machine(
        &self,
        runner: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if !self.local(runner)? {
            self.machine(runner.unwrap(), cancel).await?;
        }
        Ok(())
    }
    fn local(&self, runner: Option<&str>) -> Result<bool> {
        anyhow::ensure!(
            !self.closed.load(Ordering::Acquire),
            "The runners module is closed."
        );
        if let Some(id) = runner {
            anyhow::ensure!(
                self.config.runners_configuration()["entries"]
                    .get(id)
                    .is_some(),
                "The runner {id} is not configured."
            );
            Ok(false)
        } else {
            anyhow::ensure!(
                !self.enabled(),
                "Local execution is disabled while runners are configured."
            );
            Ok(true)
        }
    }
    fn link(&self, id: &str) -> Result<Arc<Link>> {
        self.local(Some(id))?;
        Ok(self
            .links
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(id.to_owned())
            .or_insert_with(|| {
                Arc::new(Link {
                    session: Mutex::new(None),
                    changed: Notify::new(),
                    since: AtomicU64::new(now()),
                    reason: Mutex::new(None),
                    reports: Mutex::new(Reports {
                        epoch: None,
                        sequence: 0,
                    }),
                    lease: Mutex::new(None),
                })
            })
            .clone())
    }
    async fn session(&self, id: &str, cancel: &CancellationToken) -> Result<Arc<Session>> {
        let link = self.link(id)?;
        loop {
            let changed = link.changed.notified();
            if let Some(session) = link
                .session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
            {
                return Ok(session);
            }
            let elapsed = now().saturating_sub(link.since.load(Ordering::Acquire));
            anyhow::ensure!(elapsed < 10000, "The runner {id} is unavailable.");
            tokio::select! { _=cancel.cancelled()=>bail!("Runner work was cancelled."), _=tokio::time::sleep(Duration::from_millis(10000-elapsed))=>bail!("The runner {id} is unavailable."),_=changed=>{} }
        }
    }
    pub async fn accept(
        self: &Arc<Self>,
        id: String,
        mut transport: RunnerTransport,
    ) -> Result<()> {
        let link = self.link(&id)?;
        let lifetime = self.lifecycle.shutdown.child_token();
        let (hello, _) = tokio::time::timeout(
            Duration::from_secs(10),
            async {tokio::select!{result=self.receive(&mut transport.incoming)=>result,_=lifetime.cancelled()=>bail!("The daemon is shutting down.")}},
        )
        .await??;
        anyhow::ensure!(
            hello["type"] == "hello"
                && hello["protocol"]["min"]
                    .as_u64()
                    .is_some_and(|min| min <= 1)
                && hello["protocol"]["max"]
                    .as_u64()
                    .is_some_and(|max| max >= 1),
            "The runner does not support runner protocol version 1."
        );
        self.send(
            &transport.outgoing,
            json!({"type":"welcome","protocol":1,"instanceId":self.instance,"leaseGraceMs":60000}),
            &[],
        )
        .await?;
        let (ready, _) = tokio::time::timeout(
            Duration::from_secs(10),
            async {tokio::select!{result=self.receive(&mut transport.incoming)=>result,_=lifetime.cancelled()=>bail!("The daemon is shutting down.")}},
        )
        .await??;
        anyhow::ensure!(
            ready["type"] == "ready",
            "The runner did not complete its handshake."
        );
        let session = Arc::new(Session {
            sender: transport.outgoing,
            cancel: lifetime.clone(),
            requests: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            next_stream: AtomicU64::new(1),
            identity: hello["runner"].clone(),
            product: tokio::sync::Mutex::new(false),
            tunnel: tokio::sync::Mutex::new(None),
        });
        if let Some(old) = link
            .session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .replace(session.clone())
        {
            old.cancel.cancel();
        }
        let connection = ConnectionGuard {
            owner: self.clone(),
            runner: id.clone(),
            link: link.clone(),
            session: session.clone(),
        };
        if let Some(lease) = link
            .lease
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            lease.cancel();
        }
        {
            let mut reports = link
                .reports
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let epoch = ready["epoch"].as_str().unwrap();
            if reports.epoch.as_deref() != Some(epoch) {
                reports.epoch = Some(epoch.into());
                reports.sequence = 0;
            }
        }
        for stream in ready["streams"].as_array().unwrap() {
            // A product stream whose previous caller failed cannot be replayed.
            // The peer still owns it until these explicit release frames arrive.
            self.send(
                &session.sender,
                json!({"type":"close","stream":stream}),
                &[],
            )
            .await?;
            self.send(
                &session.sender,
                json!({"type":"release","stream":stream}),
                &[],
            )
            .await?;
        }
        link.since.store(now(), Ordering::Release);
        *link
            .reason
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        link.changed.notify_waiters();
        for ((runner, _), compute) in self
            .computes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
        {
            if runner == &id {
                compute.attached(
                    session.clone(),
                    ready["computes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|known| known == compute.id()),
                );
            }
        }
        if let Err(error) = self.snapshot().await {
            return Err(error);
        }
        let mut liveness = tokio::time::interval(Duration::from_secs(15));
        let mut last = tokio::time::Instant::now();
        let outcome:Result<()>=async {
            loop {
                tokio::select! {
                    biased;
                    _=lifetime.cancelled()=>{if self.closed.load(Ordering::Acquire) || self.lifecycle.shutdown.is_cancelled() {self.send(&session.sender,json!({"type":"goodbye","reason":"The daemon is shutting down."}),&[]).await?;}break;},
                    _=liveness.tick()=>{anyhow::ensure!(last.elapsed()<Duration::from_secs(45),"The runner stopped responding.");self.send(&session.sender,json!({"type":"ping","nonce":session.next.fetch_add(1,Ordering::Relaxed)}),&[]).await?;},
                    frame=self.receive(&mut transport.incoming)=>{
                        let(header,body)=frame?;last=tokio::time::Instant::now();
                        match header["type"].as_str().unwrap_or_default() {
                            "ping"=>self.send(&session.sender,json!({"type":"pong","nonce":header["nonce"]}),&[]).await?,
                            "pong"=>{},
                            "response"=>{let pending=session.requests.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&header["id"].as_u64().unwrap_or_default());if let Some(pending)=pending {let response=if let Some(error)=header.get("error") {Err(compute::remote_error(error))} else {Ok((header["result"].clone(),body))};let _=pending.send(response);}},
                            "event"=>{let event=header["event"].as_str().unwrap();anyhow::ensure!(self.schemas.valid(&format!("ownerRunnerEvent_{}",event.replace('.',"_")),&header["params"])? ,"The runner sent an invalid event.");if let Some(seq)=header["seq"].as_u64() {let apply={let mut reports=link.reports.lock().unwrap_or_else(std::sync::PoisonError::into_inner);if seq>reports.sequence {reports.sequence=seq;true}else{false}};if apply {self.compute_event(&id,event,&header["params"]);}self.send(&session.sender,json!({"type":"ack","seq":seq}),&[]).await?;}else{self.compute_event(&id,event,&header["params"]);}},
                            "data"|"eof"|"exit"|"flow"=>{anyhow::ensure!(body.len()<=65536,"A runner stream chunk exceeds its bound.");let stream=header["stream"].as_u64().unwrap_or_default();let sender=session.streams.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&stream).cloned();if let Some(sender)=sender {sender.try_send((header,body)).map_err(|_|anyhow::anyhow!("The runner stream exceeded its bounded receive window."))?;} else if header["type"]!="flow" {self.send(&session.sender,json!({"type":"release","stream":stream}),&[]).await?;}},
                            "goodbye"=>bail!("{}",header["reason"].as_str().unwrap_or("The runner disconnected.")),
                            _=>bail!("The runner sent an unexpected frame."),
                        }
                    }
                }
            }
            Ok(())
        }.await;
        let reason = outcome
            .as_ref()
            .err()
            .map(|error| error.to_string().chars().take(4096).collect());
        if connection.disconnect(reason) {
            self.snapshot().await?;
        }
        outcome
    }
    fn start_lease(self: &Arc<Self>, runner: String, link: Arc<Link>) {
        let cancel = self.lifecycle.shutdown.child_token();
        if let Some(previous) = link
            .lease
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .replace(cancel.clone())
        {
            previous.cancel();
        }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(61000);
        let owner = self.clone();
        tokio::spawn(async move {
            tokio::select! { biased;_=cancel.cancelled()=>return,_=tokio::time::sleep_until(deadline)=>{} }
            let connected = link
                .session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if connected.is_none() && !cancel.is_cancelled() {
                for ((id, _), compute) in owner
                    .computes
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .iter()
                {
                    if *id == runner {
                        compute.lost();
                    }
                }
            }
        });
    }
    async fn receive(&self, receiver: &mut mpsc::Receiver<Vec<u8>>) -> Result<(Value, Vec<u8>)> {
        let frame = receiver
            .recv()
            .await
            .context("The runner connection ended.")?;
        anyhow::ensure!(
            frame.len() >= 4 && frame.len() <= FRAME_LIMIT,
            "The runner frame exceeds its framing boundary."
        );
        let length = u32::from_be_bytes(frame[..4].try_into()?) as usize;
        anyhow::ensure!(
            length <= frame.len() - 4,
            "The runner frame header was cut short."
        );
        let header = serde_json::from_slice(&frame[4..4 + length])?;
        anyhow::ensure!(
            self.schemas.valid("ownerRunnerFrame", &header)?,
            "The runner sent a frame the protocol does not define."
        );
        Ok((header, frame[4 + length..].to_vec()))
    }
    async fn send(&self, sender: &mpsc::Sender<Vec<u8>>, header: Value, body: &[u8]) -> Result<()> {
        let frame = self.frame(header, body)?;
        tokio::time::timeout(Duration::from_secs(10), sender.send(frame))
            .await?
            .map_err(|_| anyhow::anyhow!("The runner connection ended."))
    }
    fn frame(&self, header: Value, body: &[u8]) -> Result<Vec<u8>> {
        anyhow::ensure!(
            self.schemas.valid("ownerRunnerFrame", &header)?,
            "The outgoing runner frame is invalid."
        );
        let header = serde_json::to_vec(&header)?;
        anyhow::ensure!(
            header.len() + body.len() + 4 <= FRAME_LIMIT,
            "The runner frame is too large."
        );
        let mut frame = Vec::with_capacity(header.len() + body.len() + 4);
        frame.extend_from_slice(&u32::try_from(header.len())?.to_be_bytes());
        frame.extend_from_slice(&header);
        frame.extend_from_slice(body);
        Ok(frame)
    }
    async fn request(
        &self,
        session: &Arc<Session>,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
    ) -> Result<(Value, Vec<u8>)> {
        self.request_body(session, method, params, &[], cancel)
            .await
    }
    async fn request_body(
        &self,
        session: &Arc<Session>,
        method: &str,
        params: Value,
        body: &[u8],
        cancel: &CancellationToken,
    ) -> Result<(Value, Vec<u8>)> {
        self.request_body_guarded(session, method, params, body, cancel, None)
            .await
    }
    async fn request_body_guarded(
        &self,
        session: &Arc<Session>,
        method: &str,
        params: Value,
        body: &[u8],
        cancel: &CancellationToken,
        generation: Option<(&RunnerCompute, u64)>,
    ) -> Result<Frame> {
        anyhow::ensure!(
            !cancel.is_cancelled() && !session.cancel.is_cancelled(),
            "The runner request was cancelled before it was sent."
        );
        let (_, args, result) = METHODS
            .iter()
            .find(|(name, _, _)| *name == method)
            .context("The runner method is not installed.")?;
        anyhow::ensure!(
            self.schemas.valid(args, &params)?,
            "The runner method arguments are invalid."
        );
        let id = session.next.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = session
                .requests
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            anyhow::ensure!(
                pending.len() < 128,
                "Too many runner requests are in flight."
            );
            pending.insert(id, sender);
        }
        let _pending = tunnel::PendingRequest {
            session: session.clone(),
            id,
        };
        let answer=async {
            let frame=self.frame(json!({"type":"request","id":id,"method":method,"params":params}),body)?;
            let permit=tokio::select!{biased;_=cancel.cancelled()=>bail!("The runner request was cancelled before it was sent."),_=session.cancel.cancelled()=>bail!("The runner disconnected before the request was sent."),result=tokio::time::timeout(Duration::from_secs(10),session.sender.reserve())=>result??};
            if let Some((compute,generation))=generation {compute.send_session_frame(generation,permit,frame)?;}else{permit.send(frame);}
            let deadline=match method{"shell.run"=>params["options"]["timeoutMs"].as_u64().unwrap_or(30000).min(1800000)+10000,"shell.readSession"=>params["waitMs"].as_u64().unwrap_or(0).min(86400000)+10000,_=>60000};
            tokio::select! {_=cancel.cancelled()=>bail!("The runner request was cancelled; its outcome may be unknown."),_=session.cancel.cancelled()=>bail!("The runner disconnected; the request outcome is unknown."),answer=receiver=>answer.context("The runner request outcome is unknown.")?,_=tokio::time::sleep(Duration::from_millis(deadline))=>bail!("The runner request did not finish in time; its outcome may be unknown.")}
        }.await;
        session
            .requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id);
        if answer.is_err() && !session.cancel.is_cancelled() {
            let _ = self
                .send(&session.sender, json!({"type":"cancel","id":id}), &[])
                .await;
        }
        let (value, body) = answer?;
        anyhow::ensure!(
            self.schemas.valid(result, &value)?,
            "The runner returned an invalid method result."
        );
        Ok((value, body))
    }
    fn compute_event(&self, runner: &str, event: &str, params: &Value) {
        let id = params["computeId"].as_str().unwrap();
        if let Some(compute) = self
            .computes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&(runner.into(), id.into()))
            .cloned()
        {
            compute.event(event, params);
        }
    }
    async fn machine(&self, id: &str, cancel: &CancellationToken) -> Result<Arc<Session>> {
        let session = self.session(id, cancel).await?;
        let mut created = session.product.lock().await;
        if !*created {
            self.request(
                &session,
                "compute.create",
                json!({"computeId":"happy-product","cwd":session.identity["home"]}),
                cancel,
            )
            .await?;
            *created = true;
        }
        drop(created);
        Ok(session)
    }
    async fn rpc_path(
        &self,
        id: &str,
        method: &str,
        path: &Path,
        extra: Value,
        cancel: &CancellationToken,
    ) -> Result<(Value, Vec<u8>)> {
        let session = self.machine(id, cancel).await?;
        let mut params = json!({"computeId":"happy-product","permissions":{"mode":"full_access","network":{"egress":true,"localBinding":true}},"path":path});
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().cloned().unwrap_or_default());
        self.request(&session, method, params, cancel).await
    }
    pub async fn exists(
        &self,
        runner: Option<&str>,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<bool> {
        if self.local(runner)? {
            match tokio::fs::symlink_metadata(path).await {
                Ok(_) => Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(error.into()),
            }
        } else {
            Ok(self
                .rpc_path(runner.unwrap(), "fs.exists", path, json!({}), cancel)
                .await?
                .0["exists"]
                .as_bool()
                .unwrap_or(false))
        }
    }
    pub async fn inspect(
        &self,
        runner: Option<&str>,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        if self.local(runner)? {
            let metadata = tokio::fs::symlink_metadata(path).await?;
            let modified = metadata
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)
                .map_or_else(
                    |error| -(error.duration().as_secs_f64() * 1000.0),
                    |duration| duration.as_secs_f64() * 1000.0,
                );
            let result = json!({"stat":{"isFile":metadata.is_file(),"isDirectory":metadata.is_dir(),"isSymbolicLink":metadata.is_symlink(),"size":metadata.len(),"mtimeMs":modified}});
            anyhow::ensure!(
                self.schemas.valid("ownerRunnerResult_fs_lstat", &result)?,
                "The file metadata is invalid."
            );
            Ok(result["stat"].clone())
        } else {
            Ok(self
                .rpc_path(runner.unwrap(), "fs.lstat", path, json!({}), cancel)
                .await?
                .0["stat"]
                .clone())
        }
    }
    pub async fn canonical_path(
        &self,
        runner: Option<&str>,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        if self.local(runner)? {
            Ok(tokio::fs::canonicalize(path).await?)
        } else {
            Ok(PathBuf::from(
                self.rpc_path(runner.unwrap(), "fs.realpath", path, json!({}), cancel)
                    .await?
                    .0["path"]
                    .as_str()
                    .context("The runner path is missing.")?,
            ))
        }
    }
    pub async fn future_path(
        &self,
        runner: Option<&str>,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        anyhow::ensure!(
            path.is_absolute(),
            "The future machine path must be absolute."
        );
        let mut existing = path.to_path_buf();
        let mut missing = Vec::new();
        while !self.exists(runner, &existing, cancel).await? {
            missing.push(
                existing
                    .file_name()
                    .context("The future path has no existing ancestor.")?
                    .to_owned(),
            );
            existing = existing
                .parent()
                .context("The future path has no parent.")?
                .to_path_buf();
        }
        let mut canonical = self.canonical_path(runner, &existing, cancel).await?;
        for component in missing.into_iter().rev() {
            canonical.push(component);
        }
        Ok(canonical)
    }
    pub async fn mkdir(
        &self,
        runner: Option<&str>,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if self.local(runner)? {
            tokio::fs::create_dir_all(path).await?;
        } else {
            self.rpc_path(
                runner.unwrap(),
                "fs.mkdir",
                path,
                json!({"recursive":true}),
                cancel,
            )
            .await?;
        }
        Ok(())
    }
    pub async fn remove(
        &self,
        runner: Option<&str>,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if self.local(runner)? {
            match tokio::fs::symlink_metadata(path).await {
                Ok(metadata) if metadata.is_dir() => tokio::fs::remove_dir_all(path).await?,
                Ok(_) => tokio::fs::remove_file(path).await?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        } else {
            self.rpc_path(
                runner.unwrap(),
                "fs.rm",
                path,
                json!({"recursive":true,"force":true}),
                cancel,
            )
            .await?;
        }
        Ok(())
    }
    pub async fn move_path(
        &self,
        runner: Option<&str>,
        source: &Path,
        destination: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if self.local(runner)? {
            tokio::fs::rename(source, destination).await?;
        } else {
            let session = self.machine(runner.unwrap(), cancel).await?;
            self.request(&session,"fs.move",json!({"computeId":"happy-product","permissions":{"mode":"full_access","network":{"egress":true,"localBinding":true}},"source":source,"destination":destination}),cancel).await?;
        }
        Ok(())
    }
    pub async fn read(
        &self,
        runner: Option<&str>,
        path: &Path,
        maximum: usize,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        if self.local(runner)? {
            let file = tokio::fs::File::open(path).await?;
            let mut bytes = Vec::new();
            file.take(u64::try_from(maximum)? + 1)
                .read_to_end(&mut bytes)
                .await?;
            anyhow::ensure!(
                bytes.len() <= maximum,
                "The machine file exceeds its read bound."
            );
            Ok(bytes)
        } else {
            let bytes = self
                .rpc_path(
                    runner.unwrap(),
                    "fs.readFileBuffer",
                    path,
                    json!({"maxBytes":maximum}),
                    cancel,
                )
                .await?
                .1;
            anyhow::ensure!(
                bytes.len() <= maximum,
                "The runner file exceeds its read bound."
            );
            Ok(bytes)
        }
    }
    pub async fn read_no_follow(
        &self,
        runner: Option<&str>,
        path: &Path,
        maximum: usize,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        if self.local(runner)? {
            let path = path.to_owned();
            let work = tokio::task::spawn_blocking(move || {
                use std::io::Read;
                let mut options = std::fs::OpenOptions::new();
                options.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::OpenOptionsExt;
                    options.custom_flags(0x00200000);
                }
                let file = options.open(path)?;
                let metadata = file.metadata()?;
                anyhow::ensure!(
                    metadata.is_file() && metadata.len() <= maximum as u64,
                    "The machine file is not a bounded regular file."
                );
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    anyhow::ensure!(
                        metadata.file_attributes() & 0x400 == 0,
                        "The machine file is a symbolic link."
                    );
                }
                let mut bytes = Vec::new();
                file.take(maximum as u64 + 1).read_to_end(&mut bytes)?;
                anyhow::ensure!(
                    bytes.len() <= maximum,
                    "The machine file exceeds its read bound."
                );
                Ok(bytes)
            });
            tokio::select! {_=cancel.cancelled()=>bail!("The machine file read was cancelled."),answer=work=>answer?}
        } else {
            let bytes = self
                .rpc_path(
                    runner.unwrap(),
                    "fs.readFileBuffer",
                    path,
                    json!({"maxBytes":maximum,"noFollow":true}),
                    cancel,
                )
                .await?
                .1;
            anyhow::ensure!(
                bytes.len() <= maximum,
                "The runner file exceeds its read bound."
            );
            Ok(bytes)
        }
    }
    pub async fn projects_home(
        &self,
        runner: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        if self.local(runner)? {
            Ok(self.config.projects_home())
        } else {
            let session = self.machine(runner.unwrap(), cancel).await?;
            let home = session.identity["home"]
                .as_str()
                .context("The runner home folder is missing.")?;
            Ok(self.config.projects_home_on(Path::new(home)))
        }
    }
    pub async fn workspaces_home(
        &self,
        runner: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        if self.local(runner)? {
            Ok(self.config.workspaces_home())
        } else {
            let session = self.machine(runner.unwrap(), cancel).await?;
            let home = session.identity["home"]
                .as_str()
                .context("The runner home folder is missing.")?;
            let platform = session.identity["platform"]
                .as_str()
                .context("The runner platform is missing.")?;
            Ok(self.config.workspaces_home_on(Path::new(home), platform))
        }
    }
    pub async fn platform(
        &self,
        runner: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<String> {
        if self.local(runner)? {
            Ok(if cfg!(windows) {
                "win32"
            } else if cfg!(target_os = "macos") {
                "darwin"
            } else {
                "linux"
            }
            .to_owned())
        } else {
            let session = self.machine(runner.unwrap(), cancel).await?;
            Ok(session.identity["platform"]
                .as_str()
                .context("The runner platform is missing.")?
                .to_owned())
        }
    }
    pub async fn entries(
        &self,
        runner: Option<&str>,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>> {
        if self.local(runner)? {
            let mut entries = tokio::fs::read_dir(path).await?;
            let mut names = Vec::new();
            while let Some(entry) = entries.next_entry().await? {
                anyhow::ensure!(
                    names.len() < 100000,
                    "The directory exceeds its entry bound."
                );
                names.push(entry.file_name().into_string().map_err(|_| {
                    anyhow::anyhow!("The directory contains an invalid UTF-8 name.")
                })?);
            }
            names.sort();
            Ok(names)
        } else {
            let result = self
                .rpc_path(runner.unwrap(), "fs.readdir", path, json!({}), cancel)
                .await?
                .0;
            let entries = result["entries"]
                .as_array()
                .context("The runner directory entries are missing.")?;
            anyhow::ensure!(
                entries.len() <= 100000,
                "The runner directory exceeds its entry bound."
            );
            Ok(entries
                .iter()
                .map(|entry| entry.as_str().unwrap_or_default().to_owned())
                .collect())
        }
    }
    pub async fn run(
        &self,
        runner: Option<&str>,
        options: RunOptions,
        cancel: &CancellationToken,
    ) -> Result<RunResult> {
        anyhow::ensure!(
            options.maximum_bytes <= FRAME_LIMIT && options.maximum_bytes > 0,
            "The program output bound is invalid."
        );
        if self.local(runner)? {
            self.run_local(options, cancel).await
        } else {
            self.run_remote(runner.unwrap(), options, cancel).await
        }
    }
    pub async fn run_shell(
        &self,
        runner: Option<&str>,
        command: &str,
        cwd: &Path,
        cancel: &CancellationToken,
    ) -> Result<RunResult> {
        if self.local(runner)? {
            let shell = self.config.product_shell();
            let args = if cfg!(windows) {
                vec![
                    "/d".to_owned(),
                    "/s".to_owned(),
                    "/c".to_owned(),
                    command.to_owned(),
                ]
            } else {
                vec!["-lc".to_owned(), command.to_owned()]
            };
            self.run_local(
                RunOptions {
                    command: shell,
                    args,
                    cwd: Some(cwd.to_path_buf()),
                    environment: BTreeMap::new(),
                    maximum_bytes: 512 * 1024,
                    timeout: Duration::from_secs(1800),
                },
                cancel,
            )
            .await
        } else {
            let session = self.machine(runner.unwrap(), cancel).await?;
            let response=self.request(&session,"shell.run",json!({"computeId":"happy-product","options":{"command":command,"cwd":cwd,"permissions":{"mode":"full_access","network":{"egress":true,"localBinding":true}},"maxOutputBytes":512*1024,"timeoutMs":1800000}}),cancel).await?.0;
            let result = &response["result"];
            let stdout = result["stdout"]
                .as_str()
                .unwrap_or_default()
                .as_bytes()
                .to_vec();
            let stderr = result["stderr"].as_str().unwrap_or_default().to_owned();
            anyhow::ensure!(
                stdout.len() <= 512 * 1024 && stderr.len() <= 512 * 1024,
                "The runner shell output exceeds its bound."
            );
            Ok(RunResult {
                code: result["exitCode"]
                    .as_i64()
                    .and_then(|code| i32::try_from(code).ok())
                    .unwrap_or(1),
                stdout,
                stderr,
                truncated: result["stdoutOmittedBytes"].as_u64().unwrap_or(0) > 0,
                timed_out: result["timedOut"].as_bool().unwrap_or(false),
            })
        }
    }
    async fn run_local(
        &self,
        options: RunOptions,
        cancel: &CancellationToken,
    ) -> Result<RunResult> {
        anyhow::ensure!(!cancel.is_cancelled(), "The machine program was cancelled.");
        let mut command = Command::new(&options.command);
        command
            .args(&options.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = &options.cwd {
            command.current_dir(cwd);
        }
        for (key, value) in &options.environment {
            if let Some(value) = value {
                command.env(key, value);
            } else {
                command.env_remove(key);
            }
        }
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn()?;
        let pid = child.id();
        let _lifetime = ProcessGroupGuard(pid);
        let mut out = child
            .stdout
            .take()
            .context("The process stdout is unavailable.")?;
        let mut err = child
            .stderr
            .take()
            .context("The process stderr is unavailable.")?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut out_open = true;
        let mut err_open = true;
        let mut truncated = false;
        let mut timed_out = false;
        let mut stopped = false;
        let deadline = tokio::time::sleep(options.timeout);
        tokio::pin!(deadline);
        let mut out_bytes = [0u8; 8192];
        let mut err_bytes = [0u8; 8192];
        let status = loop {
            tokio::select! {
                result=child.wait()=>break result?,
                result=out.read(&mut out_bytes),if out_open=>{let count=result?;if count==0 {out_open=false;}else {let room=options.maximum_bytes.saturating_sub(stdout.len());stdout.extend_from_slice(&out_bytes[..count.min(room)]);if count>room {truncated=true;stopped=true;kill_group(pid);let _=child.start_kill();}}},
                result=err.read(&mut err_bytes),if err_open=>{let count=result?;if count==0 {err_open=false;}else {let room=options.maximum_bytes.saturating_sub(stderr.len());stderr.extend_from_slice(&err_bytes[..count.min(room)]);}},
                _=&mut deadline,if !stopped=>{timed_out=true;stopped=true;kill_group(pid);let _=child.start_kill();},
                _=cancel.cancelled(),if !stopped=>{stopped=true;kill_group(pid);let _=child.start_kill();},
                _=self.lifecycle.shutdown.cancelled(),if !stopped=>{stopped=true;kill_group(pid);let _=child.start_kill();},
            }
        };
        // The parent exit does not close pipes held by a descendant. Reap its
        // process group before a bounded final drain instead of retaining it.
        kill_group(pid);
        let drain = async {
            let mut tail = Vec::new();
            out.take(options.maximum_bytes.saturating_sub(stdout.len()) as u64 + 1)
                .read_to_end(&mut tail)
                .await?;
            truncated |= stdout.len() + tail.len() > options.maximum_bytes;
            stdout.extend(
                tail.into_iter()
                    .take(options.maximum_bytes.saturating_sub(stdout.len())),
            );
            let mut tail = Vec::new();
            err.take(options.maximum_bytes.saturating_sub(stderr.len()) as u64)
                .read_to_end(&mut tail)
                .await?;
            stderr.extend(tail);
            Ok::<_, std::io::Error>(())
        };
        tokio::time::timeout(Duration::from_secs(5), drain).await??;
        anyhow::ensure!(
            !cancel.is_cancelled() && !self.lifecycle.shutdown.is_cancelled(),
            "The machine program was cancelled."
        );
        Ok(RunResult {
            code: status.code().unwrap_or(1),
            stdout,
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            truncated,
            timed_out,
        })
    }
    async fn run_remote(
        &self,
        id: &str,
        options: RunOptions,
        cancel: &CancellationToken,
    ) -> Result<RunResult> {
        let session = self.machine(id, cancel).await?;
        let (_route, mut receiver) = tunnel::route(&session)?;
        let stream = _route.id;
        let operation=async {
            let mut params=json!({"computeId":"happy-product","stream":stream,"command":options.command,"args":options.args,"environment":options.environment});if let Some(cwd)=&options.cwd {params["cwd"]=json!(cwd);}
            self.request(&session,"process.start",params,cancel).await?;
            self.send(&session.sender,json!({"type":"eof","stream":stream,"channel":"in","offset":0}),&[]).await?;
            let mut stdout=Vec::new();let mut stderr=Vec::new();let mut offsets=[0u64;2];let mut eof=[false;2];let mut stopped=false;let mut truncated=false;let mut timed_out=false;
            let deadline=tokio::time::sleep(options.timeout);tokio::pin!(deadline);
            let teardown=tokio::time::sleep(Duration::from_secs(365*24*60*60));tokio::pin!(teardown);
            loop {
                tokio::select! {
                    _=session.cancel.cancelled()=>bail!("The runner disconnected; the command outcome is unknown."),
                    _=&mut teardown,if stopped=>bail!("The runner did not confirm command teardown."),
                    _=&mut deadline,if !stopped=>{timed_out=true;stopped=true;teardown.as_mut().reset(tokio::time::Instant::now()+Duration::from_secs(5));self.send(&session.sender,json!({"type":"close","stream":stream}),&[]).await?;},
                    _=cancel.cancelled(),if !stopped=>{stopped=true;teardown.as_mut().reset(tokio::time::Instant::now()+Duration::from_secs(5));self.send(&session.sender,json!({"type":"close","stream":stream}),&[]).await?;},
                    frame=receiver.recv()=>{
                        let(header,body)=frame.context("The runner stream ended without teardown proof.")?;
                        match header["type"].as_str().unwrap_or_default() {
                            "data"=>{let channel=if header["channel"]=="out" {0}else if header["channel"]=="err" {1}else {bail!("The runner sent data on an invalid output channel.");};let offset=header["offset"].as_u64().unwrap_or_default();anyhow::ensure!(offset<=offsets[channel] && !eof[channel],"The runner stream data is reordered or follows EOF.");let duplicate=usize::try_from(offsets[channel]-offset)?.min(body.len());let bytes=&body[duplicate..];offsets[channel]+=bytes.len() as u64;let destination=if channel==0 {&mut stdout}else{&mut stderr};let room=options.maximum_bytes.saturating_sub(destination.len());destination.extend_from_slice(&bytes[..bytes.len().min(room)]);if channel==0 && bytes.len()>room && !stopped {truncated=true;stopped=true;teardown.as_mut().reset(tokio::time::Instant::now()+Duration::from_secs(5));self.send(&session.sender,json!({"type":"close","stream":stream}),&[]).await?;}self.send(&session.sender,json!({"type":"flow","stream":stream,"channel":header["channel"],"consumed":offsets[channel]}),&[]).await?;},
                            "eof"=>{let channel=if header["channel"]=="out"{0}else{1};anyhow::ensure!(header["offset"].as_u64()==Some(offsets[channel]),"The runner output ended at an invalid offset.");eof[channel]=true;},
                            "exit"=>{anyhow::ensure!(eof==[true,true],"The runner command exit preceded output completion.");anyhow::ensure!(!cancel.is_cancelled(),"The runner command was cancelled.");return Ok(RunResult{code:header["exitCode"].as_i64().and_then(|code|i32::try_from(code).ok()).unwrap_or(1),stdout,stderr:String::from_utf8_lossy(&stderr).into_owned(),truncated,timed_out});},
                            "flow"=>{anyhow::ensure!(header["channel"]=="in" && header["consumed"]==0,"The runner command acknowledged unexpected input.");},
                            _=>bail!("The runner stream sent an invalid frame."),
                        }
                    }
                }
            }
        }.await;
        session
            .streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&stream);
        let _ = self
            .send(
                &session.sender,
                json!({"type":"release","stream":stream}),
                &[],
            )
            .await;
        operation
    }
    pub async fn snapshot(self: &Arc<Self>) -> Result<Value> {
        let configuration = self.config.runners_configuration();
        let links = self
            .links
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let module = self.clone();
        self.runtime.transact(move|ctx|{
            let previous=persistence::read(ctx,&module.schemas)?;let mut runners=Vec::new();
            for(id,entry)in configuration["entries"].as_object().context("The runner entries are missing.")? {
                let known=previous.as_ref().and_then(|snapshot|snapshot["runners"].as_array()).and_then(|runners|runners.iter().find(|runner|runner["id"]==*id));
                let session=links.get(id).and_then(|link|link.session.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone());let connected=session.is_some();
                let reason=if connected{Value::Null}else{links.get(id).and_then(|link|link.reason.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()).map(Value::String).or_else(||known.map(|known|known["reason"].clone())).unwrap_or(Value::Null)};
                runners.push(json!({"id":id,"name":entry["name"],"default":configuration["defaultId"]==*id,"status":if connected{"connected"}else{"disconnected"},"machine":session.as_ref().map(|session|session.identity.clone()).or_else(||known.map(|known|known["machine"].clone())).unwrap_or(Value::Null),"protocol":if connected{json!(1)}else{Value::Null},"since":links.get(id).map(|link|link.since.load(Ordering::Acquire)).or_else(||known.and_then(|known|known["since"].as_u64())).unwrap_or_else(now),"reason":reason}));
            }
            if previous.as_ref().is_some_and(|previous|previous["runners"]==json!(runners)) {return Ok(previous.unwrap());}
            let value=json!({"runners":runners,"version":next_snapshot_version(previous.as_ref().and_then(|snapshot|snapshot["version"].as_str()))?});persistence::save(ctx,&module.schemas,&value)?;
            let listeners=module.snapshot_listeners.lock().unwrap_or_else(std::sync::PoisonError::into_inner).values().cloned().collect::<Vec<_>>();
            for listener in listeners {listener(ctx,&value)?;}
            let published=value.clone();let owner=module.clone();ctx.after_commit(move||{owner.updates.send_replace(published);})?;Ok(value)
        }).await
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let links = self
            .links
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        for link in links.values() {
            let session = link
                .session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            if let Some(session) = session {
                session.cancel.cancel();
            }
        }
    }
}

struct ProcessGroupGuard(Option<u32>);
impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        kill_group(self.0);
    }
}
fn kill_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid.and_then(|pid| i32::try_from(pid).ok()) {
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
}

fn next_snapshot_version(previous: Option<&str>) -> Result<String> {
    let previous = previous
        .map(uuid::Uuid::parse_str)
        .transpose()?
        .map(|version| (version.as_u128() >> 80) as u64);
    let timestamp = now().max(previous.map_or(0, |time| time + 1));
    anyhow::ensure!(
        timestamp <= 0xffffffffffff,
        "The runner list version clock is exhausted."
    );
    let random = uuid::Uuid::new_v4().as_u128();
    Ok(uuid::Uuid::from_u128(
        (u128::from(timestamp) << 80) | (7u128 << 76) | (random & ((1u128 << 76) - 1)),
    )
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::owners::tests::Fixture;
    #[tokio::test]
    #[cfg(unix)]
    async fn no_follow_reads_refuse_symlinks_special_files_and_oversized_contents() {
        let fixture = Fixture::new().await;
        let runners = RunnersModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        let cancel = CancellationToken::new();
        let root = fixture.directory.path();
        tokio::fs::write(root.join("file"), "original")
            .await
            .unwrap();
        std::os::unix::fs::symlink(root.join("file"), root.join("alias")).unwrap();
        assert_eq!(
            runners
                .read_no_follow(None, &root.join("file"), 8, &cancel)
                .await
                .unwrap(),
            b"original"
        );
        assert!(
            runners
                .read_no_follow(None, &root.join("file"), 7, &cancel)
                .await
                .is_err()
        );
        assert!(
            runners
                .read_no_follow(None, &root.join("alias"), 8, &cancel)
                .await
                .is_err()
        );
        assert!(
            runners
                .read_no_follow(None, root, 8, &cancel)
                .await
                .is_err()
        );
        let fifo = std::ffi::CString::new(root.join("pipe").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(
            tokio::time::timeout(
                Duration::from_secs(1),
                runners.read_no_follow(None, &root.join("pipe"), 8, &cancel)
            )
            .await
            .unwrap()
            .is_err()
        );
        runners.close().await;
        fixture.close().await;
    }
    #[tokio::test]
    async fn dropping_a_runner_request_releases_its_slot_and_sends_cancellation() {
        let fixture = Fixture::new().await;
        let runners = RunnersModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        let (sender, mut receiver) = mpsc::channel(8);
        let session = Arc::new(Session {
            sender,
            cancel: CancellationToken::new(),
            requests: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            next_stream: AtomicU64::new(1),
            identity: json!({"version":"1","platform":"linux","arch":"x64","hostname":"test","home":"/test"}),
            product: tokio::sync::Mutex::new(true),
            tunnel: tokio::sync::Mutex::new(None),
        });
        let owner = runners.clone();
        let connection = session.clone();
        let task = tokio::spawn(async move {
            owner.request(&connection,"fs.exists",json!({"computeId":"happy-product","permissions":{"mode":"full_access","network":{"egress":true,"localBinding":true}},"path":"/test/file"}),&CancellationToken::new()).await
        });
        let frame = receiver.recv().await.unwrap();
        let length = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
        let request: Value = serde_json::from_slice(&frame[4..4 + length]).unwrap();
        assert_eq!(request["type"], "request");
        assert_eq!(session.requests.lock().unwrap().len(), 1);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(session.requests.lock().unwrap().is_empty());
        let frame = receiver.recv().await.unwrap();
        let length = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
        let cancelled: Value = serde_json::from_slice(&frame[4..4 + length]).unwrap();
        assert_eq!(cancelled, json!({"type":"cancel","id":request["id"]}));
        session.cancel.cancel();
        runners.close().await;
        fixture.close().await;
    }
    #[test]
    fn runner_versions_advance_past_an_original_snapshot_from_a_future_clock() {
        let future = now() + 100000;
        let original =
            uuid::Uuid::from_u128((u128::from(future) << 80) | (7u128 << 76) | (2u128 << 62))
                .to_string();
        let next = uuid::Uuid::parse_str(&next_snapshot_version(Some(&original)).unwrap()).unwrap();
        assert_eq!(next.get_version_num(), 7);
        assert_eq!((next.as_u128() >> 80) as u64, future + 1);
    }
}
