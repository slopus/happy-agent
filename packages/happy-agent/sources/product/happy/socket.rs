use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use happy_agent_base::RuntimeSchemas;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{broadcast, mpsc, oneshot},
    task::JoinHandle,
    time::Instant,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
type Wire =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
use tokio_util::sync::CancellationToken;

const MAX_FRAME: usize = 5 * 1024 * 1024;
const MAX_PENDING: usize = 512;
const MAX_QUEUED_BYTES: usize = 16 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug)]
pub(super) enum Event {
    Received {
        name: String,
        value: Value,
        answer: Option<u64>,
    },
    Disconnected,
}
enum Command {
    Emit {
        name: String,
        value: Value,
        answer: Option<oneshot::Sender<Result<Value>>>,
    },
    Answer {
        id: u64,
        value: Value,
    },
}
struct Queued {
    command: Command,
    _budget: Budget,
}
struct Budget {
    bytes: Arc<AtomicUsize>,
    size: usize,
}
impl Drop for Budget {
    fn drop(&mut self) {
        self.bytes.fetch_sub(self.size, Ordering::AcqRel);
    }
}
struct Pending {
    deadline: Instant,
    sender: oneshot::Sender<Result<Value>>,
}

/// One Engine.IO v4 / Socket.IO default-namespace WebSocket. The owned task
/// settles every outstanding answer when its carrier ends; no caller is held
/// until an unrelated timeout. Connection retry belongs to the Happy owner.
pub(super) struct Socket {
    commands: mpsc::Sender<Queued>,
    events: broadcast::Sender<Event>,
    first_events: Mutex<Option<broadcast::Receiver<Event>>>,
    bytes: Arc<AtomicUsize>,
    cancel: CancellationToken,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}
impl Socket {
    pub async fn connect(
        server: &str,
        auth: Value,
        cancel: CancellationToken,
    ) -> Result<Arc<Self>> {
        let mut url = reqwest::Url::parse(server)?;
        let scheme = match url.scheme() {
            "https" => "wss",
            "http" => "ws",
            _ => bail!("The Happy server must use HTTP or HTTPS."),
        };
        url.set_scheme(scheme)
            .map_err(|_| anyhow::anyhow!("The Happy server address is invalid."))?;
        url.set_path("/v1/updates/");
        url.set_query(Some("EIO=4&transport=websocket"));
        url.set_fragment(None);
        anyhow::ensure!(
            url.username().is_empty() && url.password().is_none(),
            "The Happy server address must not contain credentials."
        );
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME))
            .max_frame_size(Some(MAX_FRAME));
        let operation = async {
            let (mut wire, _) =
                connect_async_with_config(url.as_str(), Some(config), false).await?;
            let schemas = RuntimeSchemas::compile(include_str!("socket_schemas.json"))?;
            let first = wire
                .next()
                .await
                .context("Happy closed its connection before opening it.")??;
            let first = first.to_text()?;
            let open: Value = serde_json::from_str(
                first
                    .strip_prefix('0')
                    .context("Happy did not open an Engine.IO connection.")?,
            )?;
            anyhow::ensure!(
                schemas.valid("open", &open)?,
                "Happy returned an invalid Engine.IO connection."
            );
            let interval = open["pingInterval"]
                .as_u64()
                .context("The Happy heartbeat interval is invalid.")?;
            let timeout = open["pingTimeout"]
                .as_u64()
                .context("The Happy heartbeat timeout is invalid.")?;
            let heartbeat = Duration::from_millis(interval.saturating_add(timeout).min(120_000));
            wire.send(Message::Text(format!("40{auth}").into())).await?;
            loop {
                let frame = wire
                    .next()
                    .await
                    .context("Happy closed its connection during authentication.")??;
                if frame.is_ping() {
                    wire.send(Message::Pong(frame.into_data())).await?;
                    continue;
                }
                let text = frame.to_text()?;
                if text == "2" {
                    wire.send(Message::Text("3".into())).await?;
                    continue;
                }
                if text.starts_with("44") {
                    bail!(
                        "Happy refused the mobile connection. Authenticated HTTP registration must revalidate its credentials."
                    );
                }
                let body = text
                    .strip_prefix("40")
                    .context("Happy did not accept its Socket.IO connection.")?;
                let connected: Value = serde_json::from_str(body)?;
                anyhow::ensure!(
                    schemas.valid("connected", &connected)?,
                    "Happy returned an invalid Socket.IO connection."
                );
                break;
            }
            let (commands, receiver) = mpsc::channel(MAX_PENDING);
            let (events, first_events) = broadcast::channel(MAX_PENDING);
            let socket = Arc::new(Self {
                commands,
                events: events.clone(),
                first_events: Mutex::new(Some(first_events)),
                bytes: Arc::new(AtomicUsize::new(0)),
                cancel: cancel.child_token(),
                task: tokio::sync::Mutex::new(None),
            });
            let stop = socket.cancel.clone();
            let task = tokio::spawn(async move {
                let mut pending = BTreeMap::<u64, Pending>::new();
                let mut next = 0u64;
                let mut receiver = receiver;
                let mut check = tokio::time::interval(Duration::from_millis(100));
                let mut alive = Instant::now() + heartbeat;
                let result: Result<()> = async {
                    loop {
                        tokio::select! {
                            biased;
                            _ = stop.cancelled() => break,
                            command = receiver.recv() => {
                                let Some(command) = command else { break; };
                                match command.command {
                                    Command::Emit { name, value, answer } => {
                                        let id = if let Some(answer) = answer {
                                            if pending.len() >= MAX_PENDING { let _ = answer.send(Err(anyhow::anyhow!("Happy has too many unanswered requests."))); continue; }
                                            next = next.checked_add(1).context("The Happy answer identity limit was reached.")?;
                                            pending.insert(next, Pending { deadline: Instant::now() + TIMEOUT, sender: answer });
                                            next.to_string()
                                        } else { String::new() };
                                        send(&mut wire,Message::Text(format!("42{id}{}", json!([name,value])).into()),&stop).await?;
                                    }
                                    Command::Answer { id, value } => send(&mut wire,Message::Text(format!("43{id}{}", json!([value])).into()),&stop).await?,
                                }
                            }
                            frame = wire.next() => {
                                let Some(frame) = frame else { break; };
                                let frame = frame?;
                                if frame.is_close() { break; }
                                if frame.is_ping() { send(&mut wire,Message::Pong(frame.into_data()),&stop).await?; continue; }
                                if frame.is_pong() { continue; }
                                let text = frame.to_text()?;
                                if text == "2" { alive = Instant::now() + heartbeat; send(&mut wire,Message::Text("3".into()),&stop).await?; continue; }
                                if text == "1" || text == "41" { break; }
                                if let Some(body) = text.strip_prefix("43") {
                                    let (id, values) = parse_packet(body)?;
                                    let id = id.context("Happy answered without a request identity.")?;
                                    if let Some(request) = pending.remove(&id) { let _ = request.sender.send(Ok(values.first().cloned().unwrap_or(Value::Null))); }
                                } else if let Some(body) = text.strip_prefix("42") {
                                    let (answer, values) = parse_packet(body)?;
                                    let name = values.first().and_then(Value::as_str).context("Happy sent an event without a name.")?;
                                    let _ = events.send(Event::Received { name: name.into(), value: values.get(1).cloned().unwrap_or(Value::Null), answer });
                                } else { bail!("Happy sent an unsupported Socket.IO packet."); }
                            }
                            _ = check.tick() => {
                                if Instant::now() >= alive { bail!("Happy's connection stopped answering heartbeats."); }
                                let expired = pending.iter().filter(|(_,request)| request.sender.is_closed() || Instant::now() >= request.deadline).map(|(id,_)| *id).collect::<Vec<_>>();
                                for id in expired { if let Some(request) = pending.remove(&id) { let _ = request.sender.send(Err(anyhow::anyhow!("Happy did not answer in time."))); } }
                            }
                        }
                    }
                    Ok(())
                }.await;
                if let Err(error) = result {
                    tracing::debug!(error=%error,"Happy's carrier stopped.");
                }
                stop.cancel();
                for (_, request) in pending {
                    let _ = request
                        .sender
                        .send(Err(anyhow::anyhow!("Happy disconnected before answering.")));
                }
                let _ = events.send(Event::Disconnected);
                let _ = tokio::time::timeout(Duration::from_secs(1), async {
                    let _ = wire.close(None).await;
                    while let Some(Ok(frame)) = wire.next().await {
                        if frame.is_close() {
                            break;
                        }
                    }
                })
                .await;
            });
            *socket.task.lock().await = Some(task);
            Ok(socket)
        };
        tokio::select! { result = tokio::time::timeout(TIMEOUT, operation) => result.context("Happy did not establish its connection in time.")?, _ = cancel.cancelled() => bail!("Happy connection stopped.") }
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.first_events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            .unwrap_or_else(|| self.events.subscribe())
    }
    pub fn stopped(&self) -> bool {
        self.cancel.is_cancelled()
    }
    pub async fn emit(&self, name: &str, value: Value) -> Result<()> {
        self.send(Command::Emit {
            name: name.into(),
            value,
            answer: None,
        })
        .await
    }
    pub async fn request(&self, name: &str, value: Value) -> Result<Value> {
        let (answer, receive) = oneshot::channel();
        self.send(Command::Emit {
            name: name.into(),
            value,
            answer: Some(answer),
        })
        .await?;
        tokio::select! { result = receive => result.context("Happy disconnected before answering.")?, _ = self.cancel.cancelled() => bail!("Happy disconnected before answering.") }
    }
    pub async fn answer(&self, id: u64, value: Value) -> Result<()> {
        self.send(Command::Answer { id, value }).await
    }
    async fn send(&self, command: Command) -> Result<()> {
        let size = match &command {
            Command::Emit { name, value, .. } => name.len() + value.to_string().len(),
            Command::Answer { value, .. } => value.to_string().len(),
        };
        anyhow::ensure!(
            size < MAX_FRAME - 64,
            "The Happy socket request is too large."
        );
        anyhow::ensure!(!self.stopped(), "Happy is not connected.");
        self.bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |bytes| {
                bytes
                    .checked_add(size)
                    .filter(|bytes| *bytes <= MAX_QUEUED_BYTES)
            })
            .map_err(|_| anyhow::anyhow!("Happy's outgoing connection could not keep up."))?;
        let command = Queued {
            command,
            _budget: Budget {
                bytes: self.bytes.clone(),
                size,
            },
        };
        tokio::select! { result = self.commands.send(command) => result.context("Happy is not connected."), _ = self.cancel.cancelled() => bail!("Happy is not connected.") }
    }
    pub async fn close(&self) {
        self.cancel.cancel();
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}
impl Drop for Socket {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

fn parse_packet(body: &str) -> Result<(Option<u64>, Vec<Value>)> {
    let start = body
        .find('[')
        .context("The Happy packet has no arguments.")?;
    let id = if start == 0 {
        None
    } else {
        Some(
            body[..start]
                .parse::<u64>()
                .context("The Happy packet identity is invalid.")?,
        )
    };
    let values =
        serde_json::from_str(&body[start..]).context("The Happy packet arguments are invalid.")?;
    Ok((id, values))
}
async fn send(wire: &mut Wire, frame: Message, cancel: &CancellationToken) -> Result<()> {
    tokio::select! {
        _=cancel.cancelled()=>bail!("Happy disconnected before sending."),
        result=tokio::time::timeout(TIMEOUT,wire.send(frame))=>{result.context("Happy's connection did not accept its write in time.")??;Ok(())}
    }
}
