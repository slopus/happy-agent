use super::socket::{Event as WireEvent, Socket};
use anyhow::{Context, Result, bail};
use futures_util::{StreamExt, future::BoxFuture, stream::FuturesUnordered};
use happy_agent_base::RuntimeSchemas;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{broadcast, mpsc, oneshot, watch},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

const MAX_DEDICATED: usize = 64;
const MAX_SUBSCRIBE: usize = 500;
const MAX_LINKS: usize = 10_000;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Transport {
    Multiplexed,
    Dedicated,
}
#[derive(Clone, Debug)]
pub(super) struct Descriptor {
    pub remote: String,
    pub agent: String,
    pub bot: bool,
    /// Durable agent update time; reconnect order never becomes recency.
    pub updated: u64,
}
#[derive(Clone, Debug)]
pub(super) enum Event {
    Connected,
    Disconnected,
    Update(Value),
    Rpc { request: Value, answer: Option<u64> },
    Unsubscribed,
}
#[derive(Clone)]
struct Carrier {
    socket: Arc<Socket>,
    cancel: CancellationToken,
}
struct Link {
    descriptor: Descriptor,
    identity: u64,
    carrier: watch::Sender<Option<Carrier>>,
    events: mpsc::Sender<Event>,
    methods: Arc<Mutex<BTreeSet<String>>>,
    dedicated: Option<Arc<Socket>>,
    connecting: bool,
}
impl Link {
    fn disconnect(&mut self) {
        if let Some(carrier) = self.carrier.borrow().as_ref() {
            carrier.cancel.cancel();
        }
        if self.carrier.send_replace(None).is_some() {
            let _ = self.events.try_send(Event::Disconnected);
        }
        self.methods
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
    fn connect(&mut self, socket: Arc<Socket>) {
        if self.carrier.borrow().is_some() {
            return;
        }
        self.carrier.send_replace(Some(Carrier {
            socket,
            cancel: CancellationToken::new(),
        }));
        if self.events.try_send(Event::Connected).is_err() {
            self.disconnect();
        }
    }
}
pub(super) struct SessionLink {
    remote: String,
    identity: u64,
    commands: mpsc::Sender<Command>,
    carrier: watch::Receiver<Option<Carrier>>,
    methods: Arc<Mutex<BTreeSet<String>>>,
}
impl SessionLink {
    pub fn connected(&self) -> bool {
        self.carrier
            .borrow()
            .as_ref()
            .is_some_and(|carrier| !carrier.cancel.is_cancelled() && !carrier.socket.stopped())
    }
    pub async fn request(&self, event: &str, value: Value) -> Result<Value> {
        let carrier = self
            .carrier
            .borrow()
            .clone()
            .context("Happy is not connected.")?;
        tokio::select! { biased; _ = carrier.cancel.cancelled() => bail!("Happy disconnected before answering."), result = carrier.socket.request(event, value) => result }
    }
    pub async fn emit(&self, event: &str, value: Value) -> Result<()> {
        let carrier = self
            .carrier
            .borrow()
            .clone()
            .context("Happy is not connected.")?;
        let method = if event == "rpc-register" {
            value["method"].as_str().map(str::to_owned)
        } else {
            None
        };
        tokio::select! { biased; _ = carrier.cancel.cancelled() => bail!("Happy disconnected before sending."), result = carrier.socket.emit(event, value) => result? }
        if let Some(method) = method {
            self.methods
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(method);
        }
        Ok(())
    }
    pub async fn answer(&self, id: u64, value: Value) -> Result<()> {
        let carrier = self
            .carrier
            .borrow()
            .clone()
            .context("Happy is not connected.")?;
        tokio::select! { biased; _ = carrier.cancel.cancelled() => bail!("Happy disconnected before answering."), result = carrier.socket.answer(id, value) => result }
    }
    pub async fn unsubscribe(&self) {
        let (done, receive) = oneshot::channel();
        if self
            .commands
            .send(Command::Release {
                remote: self.remote.clone(),
                identity: self.identity,
                done,
            })
            .await
            .is_ok()
        {
            let _ = receive.await;
        }
    }
}
enum Command {
    Open {
        descriptor: Descriptor,
        replace: bool,
        answer: oneshot::Sender<Result<Option<(SessionLink, mpsc::Receiver<Event>)>>>,
    },
    Release {
        remote: String,
        identity: u64,
        done: oneshot::Sender<()>,
    },
    Machine(Arc<Socket>),
}
enum Outcome {
    Subscription {
        epoch: u64,
        probe: bool,
        asked: Vec<(String, u64)>,
        answer: Result<Value>,
    },
    Retry {
        epoch: u64,
        asked: Vec<(String, u64)>,
    },
    Dedicated {
        epoch: u64,
        remote: String,
        identity: u64,
        socket: Result<Arc<Socket>>,
    },
    DedicatedRetry {
        epoch: u64,
        remote: String,
        identity: u64,
    },
    DedicatedEvent {
        remote: String,
        identity: u64,
        socket: Arc<Socket>,
        event: Result<WireEvent, broadcast::error::RecvError>,
        receiver: broadcast::Receiver<WireEvent>,
    },
    Closed,
}

/// Routing and transport negotiation belong to one connection owner. The
/// descriptor is supplied by its catalog projection; this adapter never reads
/// a second catalog or infers ownership from an address.
pub(super) struct SessionSockets {
    commands: mpsc::Sender<Command>,
    transport: watch::Receiver<Option<Transport>>,
    first: watch::Receiver<Option<Transport>>,
    cancel: CancellationToken,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}
impl SessionSockets {
    pub fn new(
        server: String,
        token: String,
        version: String,
        cancel: CancellationToken,
    ) -> Result<Self> {
        let schemas = RuntimeSchemas::compile(include_str!("socket_schemas.json"))?;
        let (commands, receiver) = mpsc::channel(512);
        let (transport, receive_transport) = watch::channel(None);
        let (first, receive_first) = watch::channel(None);
        let cancel = cancel.child_token();
        let actor = Actor {
            server,
            token,
            version,
            schemas,
            links: BTreeMap::new(),
            machine: None,
            machine_events: None,
            epoch: 0,
            next: 0,
            current: None,
            decided: None,
            commands: commands.clone(),
            transport,
            first,
            pending: FuturesUnordered::new(),
            subscriptions: 0,
            waiting_rooms: BTreeSet::new(),
            epoch_cancel: CancellationToken::new(),
            cancel: cancel.clone(),
        };
        let task = tokio::spawn(actor.run(receiver));
        Ok(Self {
            commands,
            transport: receive_transport,
            first: receive_first,
            cancel,
            task: tokio::sync::Mutex::new(Some(task)),
        })
    }
    pub async fn machine_connected(&self, socket: Arc<Socket>) -> Result<()> {
        self.commands
            .send(Command::Machine(socket))
            .await
            .context("Happy session routing has stopped.")
    }
    pub async fn first_transport(&self) -> Option<Transport> {
        let mut transport = self.first.clone();
        loop {
            if let Some(value) = *transport.borrow() {
                return Some(value);
            }
            tokio::select! { _ = self.cancel.cancelled() => return None, changed = transport.changed() => { if changed.is_err() { return None; } } }
        }
    }
    pub fn latest_transport(&self) -> Option<Transport> {
        *self.transport.borrow()
    }
    pub async fn open(
        &self,
        descriptor: Descriptor,
        replace: bool,
    ) -> Result<Option<(SessionLink, mpsc::Receiver<Event>)>> {
        let (answer, receive) = oneshot::channel();
        self.commands
            .send(Command::Open {
                descriptor,
                replace,
                answer,
            })
            .await
            .context("Happy session routing has stopped.")?;
        receive
            .await
            .context("Happy session routing has stopped.")?
    }
    pub async fn close(&self) {
        self.cancel.cancel();
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}
impl Drop for SessionSockets {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

struct Actor {
    server: String,
    token: String,
    version: String,
    schemas: RuntimeSchemas,
    links: BTreeMap<String, Link>,
    machine: Option<Arc<Socket>>,
    machine_events: Option<broadcast::Receiver<WireEvent>>,
    epoch: u64,
    next: u64,
    current: Option<Transport>,
    decided: Option<Transport>,
    commands: mpsc::Sender<Command>,
    transport: watch::Sender<Option<Transport>>,
    first: watch::Sender<Option<Transport>>,
    pending: FuturesUnordered<BoxFuture<'static, Outcome>>,
    subscriptions: usize,
    waiting_rooms: BTreeSet<(String, u64)>,
    epoch_cancel: CancellationToken,
    cancel: CancellationToken,
}
impl Actor {
    async fn run(mut self, mut commands: mpsc::Receiver<Command>) {
        loop {
            tokio::select! {
                _ = self.cancel.cancelled() => break,
                command = commands.recv() => {
                    let Some(command) = command else { break; };
                    match command {
                        Command::Open { descriptor,replace,answer } => {
                            let result = self.open(descriptor,replace).await;
                            if let Err(returned) = answer.send(result) { if let Ok(Some((link,_))) = returned { self.release(&link.remote,link.identity).await; } }
                        }
                        Command::Release { remote,identity,done } => { self.release(&remote,identity).await; let _ = done.send(()); }
                        Command::Machine(socket) => {
                            self.disconnect_machine();
                            self.machine_events = Some(socket.subscribe());
                            self.machine = Some(socket);
                            let asked = self.links.values().take(MAX_SUBSCRIBE).map(|link| (link.descriptor.remote.clone(),link.identity)).collect();
                            self.subscribe(asked,true);
                        }
                    }
                }
                event = async { self.machine_events.as_mut().expect("guarded machine receiver").recv().await }, if self.machine_events.is_some() => {
                    match event { Ok(WireEvent::Received { name,value,answer }) => self.route(&name,value,answer), _ => self.disconnect_machine() }
                }
                outcome = self.pending.next(), if !self.pending.is_empty() => {
                    if let Some(outcome) = outcome { self.outcome(outcome).await; }
                }
            }
        }
        for link in self.links.values_mut() {
            link.disconnect();
        }
        // Cancel before awaiting, then drain all pending connection/answer work.
        self.cancel.cancel();
        self.epoch_cancel.cancel();
        let mut closing = Vec::new();
        while let Some(outcome) = self.pending.next().await {
            if let Outcome::Dedicated {
                socket: Ok(socket), ..
            } = outcome
            {
                closing.push(socket);
            }
        }
        for link in self.links.values_mut() {
            if let Some(socket) = link.dedicated.take() {
                closing.push(socket);
            }
        }
        close_sockets(closing).await;
    }
    fn disconnect_machine(&mut self) {
        self.epoch += 1;
        self.epoch_cancel.cancel();
        self.epoch_cancel = CancellationToken::new();
        self.machine = None;
        self.machine_events = None;
        self.current = None;
        self.subscriptions = 0;
        self.waiting_rooms.clear();
        for link in self.links.values_mut() {
            link.connecting = false;
            if link.dedicated.is_none() {
                link.disconnect();
            }
        }
    }
    async fn open(
        &mut self,
        descriptor: Descriptor,
        replace: bool,
    ) -> Result<Option<(SessionLink, mpsc::Receiver<Event>)>> {
        anyhow::ensure!(
            !descriptor.remote.is_empty()
                && descriptor.remote.len() <= 1024
                && !descriptor.agent.is_empty()
                && descriptor.agent.len() <= 128,
            "The Happy session identity is invalid."
        );
        anyhow::ensure!(
            !self.links.contains_key(&descriptor.remote),
            "The Happy session already has a transport link."
        );
        anyhow::ensure!(
            self.links.len() < MAX_LINKS,
            "The Happy session catalog exceeds its bound."
        );
        if self.decided != Some(Transport::Multiplexed) && self.links.len() >= MAX_DEDICATED {
            if !replace {
                return Ok(None);
            }
            let oldest = self
                .links
                .values()
                .filter(|link| !link.descriptor.bot || descriptor.bot)
                .min_by_key(|link| {
                    (
                        link.descriptor.bot,
                        link.descriptor.updated,
                        link.descriptor.agent.clone(),
                    )
                })
                .map(|link| (link.descriptor.remote.clone(), link.identity));
            let Some((remote, identity)) = oldest else {
                return Ok(None);
            };
            self.release(&remote, identity).await;
        }
        self.next = self
            .next
            .checked_add(1)
            .context("The Happy session identity limit was reached.")?;
        let identity = self.next;
        let remote = descriptor.remote.clone();
        let (carrier, receive_carrier) = watch::channel(None);
        let (events, receive_events) = mpsc::channel(128);
        let methods = Arc::new(Mutex::new(BTreeSet::new()));
        let link = SessionLink {
            remote: remote.clone(),
            identity,
            carrier: receive_carrier,
            commands: self.commands.clone(),
            methods: methods.clone(),
        };
        self.links.insert(
            remote.clone(),
            Link {
                descriptor,
                identity,
                carrier,
                events,
                methods,
                dedicated: None,
                connecting: false,
            },
        );
        match self.current {
            Some(Transport::Multiplexed) => self.subscribe(vec![(remote, identity)], false),
            Some(Transport::Dedicated) => self.dedicated(&remote),
            None => (),
        }
        Ok(Some((link, receive_events)))
    }
    async fn release(&mut self, remote: &str, identity: u64) {
        if !self
            .links
            .get(remote)
            .is_some_and(|link| link.identity == identity)
        {
            return;
        }
        let mut link = self.links.remove(remote).expect("checked session link");
        self.waiting_rooms.remove(&(remote.to_owned(), identity));
        let methods = link
            .methods
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        link.disconnect();
        if let Some(socket) = link.dedicated.take() {
            socket.close().await;
        } else if self.current != Some(Transport::Dedicated) {
            if let Some(socket) = &self.machine {
                let _ = socket
                    .emit("session-unsubscribe", json!({"sids":[remote]}))
                    .await;
                for method in methods {
                    let _ = socket
                        .emit("rpc-unregister", json!({"method":method}))
                        .await;
                }
            }
        }
        let _ = link.events.try_send(Event::Unsubscribed);
    }
    fn subscribe(&mut self, asked: Vec<(String, u64)>, probe: bool) {
        let Some(socket) = &self.machine else {
            return;
        };
        // Even the first empty subscription probes for an older server's handler.
        let batches = if asked.is_empty() {
            vec![Vec::new()]
        } else {
            asked.chunks(MAX_SUBSCRIBE).map(<[_]>::to_vec).collect()
        };
        for asked in batches {
            if !probe && self.subscriptions >= 16 {
                self.waiting_rooms.extend(asked);
                continue;
            }
            self.subscriptions += 1;
            let socket = socket.clone();
            let epoch = self.epoch;
            let cancel = self.cancel.clone();
            let epoch_cancel = self.epoch_cancel.clone();
            self.pending.push(Box::pin(async move {
                let request = socket.request("session-subscribe",json!({"sids":asked.iter().map(|(remote,_)|remote).collect::<Vec<_>>()}));
                let answer = tokio::select! { _ = cancel.cancelled() => return Outcome::Closed, _=epoch_cancel.cancelled()=>return Outcome::Closed,result = tokio::time::timeout(if probe { PROBE_TIMEOUT } else { Duration::from_secs(15) },request) => result.map_err(|_|anyhow::anyhow!("Happy did not answer its subscription probe.")).and_then(|result|result) };
                Outcome::Subscription { epoch,probe,asked,answer }
            }));
        }
    }
    async fn outcome(&mut self, outcome: Outcome) {
        match outcome {
            Outcome::Subscription {
                epoch,
                probe,
                asked,
                answer,
            } if epoch == self.epoch => {
                self.subscriptions = self.subscriptions.saturating_sub(1);
                let answer = answer
                    .ok()
                    .filter(|value| self.schemas.valid("subscription", value).unwrap_or(false));
                if probe {
                    let supported = answer
                        .as_ref()
                        .is_some_and(|answer| answer["reason"] != "unsupported-client");
                    self.decide(
                        if supported {
                            Transport::Multiplexed
                        } else {
                            Transport::Dedicated
                        },
                        &asked,
                    )
                    .await;
                }
                if self.current != Some(Transport::Multiplexed) {
                    return;
                }
                if let Some(answer) = answer {
                    if answer["result"] == "success" {
                        let joined = answer["subscribed"]
                            .as_array()
                            .expect("validated subscription");
                        for (remote, identity) in &asked {
                            if !joined.iter().any(|value| value.as_str() == Some(remote)) {
                                continue;
                            }
                            if let Some(link) = self.links.get_mut(remote).filter(|link| {
                                link.identity == *identity && link.dedicated.is_none()
                            }) {
                                if let Some(socket) = &self.machine {
                                    link.connect(socket.clone());
                                }
                            }
                        }
                    } else if answer["reason"] == "internal" {
                        let cancel = self.cancel.clone();
                        self.pending.push(Box::pin(async move { tokio::select! { _ = cancel.cancelled() => Outcome::Closed, _ = tokio::time::sleep(Duration::from_secs(2)) => Outcome::Retry {epoch,asked} } }));
                    }
                }
                self.flush_waiting_rooms();
            }
            Outcome::Retry { epoch, asked }
                if epoch == self.epoch && self.current == Some(Transport::Multiplexed) =>
            {
                let asked = asked
                    .into_iter()
                    .filter(|(remote, identity)| {
                        self.links
                            .get(remote)
                            .is_some_and(|link| link.identity == *identity)
                    })
                    .collect();
                self.subscribe(asked, false);
            }
            Outcome::Dedicated {
                epoch,
                remote,
                identity,
                socket,
            } => {
                let current = epoch == self.epoch
                    && self.current == Some(Transport::Dedicated)
                    && self
                        .links
                        .get(&remote)
                        .is_some_and(|link| link.identity == identity);
                if !current {
                    if let Ok(socket) = socket {
                        socket.close().await;
                    }
                    return;
                }
                let link = self.links.get_mut(&remote).expect("checked dedicated link");
                link.connecting = false;
                if let Ok(socket) = socket {
                    let receiver = socket.subscribe();
                    link.dedicated = Some(socket.clone());
                    link.connect(socket.clone());
                    self.listen_dedicated(remote, identity, socket, receiver);
                } else {
                    self.retry_dedicated(remote, identity);
                }
            }
            Outcome::DedicatedRetry {
                epoch,
                remote,
                identity,
            } if epoch == self.epoch
                && self.current == Some(Transport::Dedicated)
                && self
                    .links
                    .get(&remote)
                    .is_some_and(|link| link.identity == identity) =>
            {
                self.dedicated(&remote)
            }
            Outcome::DedicatedEvent {
                remote,
                identity,
                socket,
                event,
                receiver,
            } => {
                let Some(link) = self.links.get_mut(&remote).filter(|link| {
                    link.identity == identity
                        && link
                            .dedicated
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(current, &socket))
                }) else {
                    return;
                };
                match event {
                    Ok(WireEvent::Received {
                        name,
                        value,
                        answer,
                    }) => {
                        Self::deliver(link, &name, value, answer);
                        self.listen_dedicated(remote, identity, socket, receiver);
                    }
                    _ => {
                        link.disconnect();
                        if let Some(socket) = link.dedicated.take() {
                            socket.close().await;
                        }
                        if self.current == Some(Transport::Dedicated) {
                            self.retry_dedicated(remote, identity);
                        }
                    }
                }
            }
            _ => (),
        }
    }
    fn flush_waiting_rooms(&mut self) {
        while self.subscriptions < 16 && !self.waiting_rooms.is_empty() {
            let batch = self
                .waiting_rooms
                .iter()
                .take(MAX_SUBSCRIBE)
                .cloned()
                .collect::<Vec<_>>();
            for identity in &batch {
                self.waiting_rooms.remove(identity);
            }
            let batch = batch
                .into_iter()
                .filter(|(remote, identity)| {
                    self.links
                        .get(remote)
                        .is_some_and(|link| link.identity == *identity)
                })
                .collect::<Vec<_>>();
            if !batch.is_empty() {
                self.subscribe(batch, false);
            }
        }
    }
    async fn decide(&mut self, transport: Transport, asked: &[(String, u64)]) {
        self.current = Some(transport);
        self.decided = Some(transport);
        self.transport.send_replace(Some(transport));
        if self.first.borrow().is_none() {
            self.first.send_replace(Some(transport));
        }
        if transport == Transport::Multiplexed {
            let mut closing = Vec::new();
            for link in self.links.values_mut() {
                if let Some(socket) = link.dedicated.take() {
                    link.disconnect();
                    closing.push(socket);
                }
            }
            close_sockets(closing).await;
            let remaining = self
                .links
                .values()
                .filter(|link| {
                    !asked.iter().any(|(remote, identity)| {
                        remote == &link.descriptor.remote && *identity == link.identity
                    })
                })
                .map(|link| (link.descriptor.remote.clone(), link.identity))
                .collect::<Vec<_>>();
            if !remaining.is_empty() {
                self.subscribe(remaining, false);
            }
        } else {
            // Contract before opening any dedicated socket. Bots have priority;
            // projects cannot displace them, and ties use the durable agent ID.
            let mut retained = self
                .links
                .values()
                .map(|link| {
                    (
                        link.descriptor.remote.clone(),
                        link.descriptor.bot,
                        link.descriptor.updated,
                        link.descriptor.agent.clone(),
                    )
                })
                .collect::<Vec<_>>();
            retained.sort_by(|left, right| {
                right
                    .1
                    .cmp(&left.1)
                    .then_with(|| right.2.cmp(&left.2))
                    .then_with(|| right.3.cmp(&left.3))
            });
            let retained = retained
                .into_iter()
                .take(MAX_DEDICATED)
                .map(|entry| entry.0)
                .collect::<BTreeSet<_>>();
            let mut closing = Vec::new();
            for (remote, link) in &mut self.links {
                if !retained.contains(remote) {
                    link.disconnect();
                    if let Some(socket) = link.dedicated.take() {
                        closing.push(socket);
                    }
                    let _ = link.events.try_send(Event::Unsubscribed);
                }
            }
            close_sockets(closing).await;
            for remote in retained {
                self.dedicated(&remote);
            }
        }
    }
    fn dedicated(&mut self, remote: &str) {
        let Some(link) = self.links.get_mut(remote) else {
            return;
        };
        if link.connecting || link.dedicated.is_some() {
            return;
        }
        link.disconnect();
        link.connecting = true;
        let server = self.server.clone();
        let auth = json!({"clientType":"session-scoped","happyClient":format!("rig/{}",self.version),"sessionId":remote,"token":self.token});
        let remote = remote.to_owned();
        let identity = link.identity;
        let epoch = self.epoch;
        let cancel = self.cancel.clone();
        let epoch_cancel = self.epoch_cancel.clone();
        self.pending.push(Box::pin(async move { let socket=tokio::select!{result=Socket::connect(&server,auth,cancel)=>result,_=epoch_cancel.cancelled()=>Err(anyhow::anyhow!("Happy changed its connection before the session connected."))};Outcome::Dedicated {epoch,remote,identity,socket} }));
    }
    fn retry_dedicated(&mut self, remote: String, identity: u64) {
        let epoch = self.epoch;
        let cancel = self.cancel.clone();
        let epoch_cancel = self.epoch_cancel.clone();
        self.pending.push(Box::pin(async move{tokio::select!{_=cancel.cancelled()=>Outcome::Closed,_=epoch_cancel.cancelled()=>Outcome::Closed,_=tokio::time::sleep(Duration::from_secs(2))=>Outcome::DedicatedRetry{epoch,remote,identity}}}));
    }
    fn listen_dedicated(
        &mut self,
        remote: String,
        identity: u64,
        socket: Arc<Socket>,
        mut receiver: broadcast::Receiver<WireEvent>,
    ) {
        let cancel = self.cancel.clone();
        self.pending.push(Box::pin(async move{tokio::select!{_=cancel.cancelled()=>Outcome::Closed,event=receiver.recv()=>Outcome::DedicatedEvent{remote,identity,socket,event,receiver}}}));
    }
    fn route(&mut self, name: &str, value: Value, answer: Option<u64>) {
        let remote = if name == "update" && self.schemas.valid("update", &value).unwrap_or(false) {
            match value["body"]["t"].as_str() {
                Some("update-session") => value["body"]["id"].as_str(),
                Some("new-message") => value["body"]["sid"].as_str(),
                _ => None,
            }
        } else if name == "rpc-request" && self.schemas.valid("rpc", &value).unwrap_or(false) {
            value["method"]
                .as_str()
                .and_then(|method| method.split_once(':').map(|(remote, _)| remote))
        } else {
            None
        };
        if let Some(link) = remote
            .and_then(|remote| self.links.get_mut(remote))
            .filter(|link| link.dedicated.is_none() && link.carrier.borrow().is_some())
        {
            Self::deliver(link, name, value, answer);
        }
    }
    fn deliver(link: &mut Link, name: &str, value: Value, answer: Option<u64>) {
        let event = match name {
            "update" => Some(Event::Update(value)),
            "rpc-request" => Some(Event::Rpc {
                request: value,
                answer,
            }),
            _ => None,
        };
        if let Some(event) = event {
            if link.events.try_send(event).is_err() {
                link.disconnect();
            }
        }
    }
}
async fn close_sockets(sockets: Vec<Arc<Socket>>) {
    futures_util::future::join_all(sockets.iter().map(|socket| socket.close())).await;
}
