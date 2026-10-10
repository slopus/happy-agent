//! The two original GPT-Live dialects, with one allocation and real closure proof.
use crate::product::{
    config::{LiveCredential, LiveCredentialKind},
    schemas::Schemas,
};
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
    },
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug)]
pub enum ProviderFailure {
    Unavailable,
    Forbidden,
    Unsupported,
    SignIn,
    ApiKey,
    SetupTimeout,
    ReadyTimeout,
    CloseTimeout,
}
impl ProviderFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Forbidden | Self::SignIn | Self::ApiKey => "forbidden",
            Self::Unsupported => "unsupported",
            _ => "live_unavailable",
        }
    }
    pub fn status(self) -> u16 {
        match self {
            Self::Forbidden | Self::SignIn | Self::ApiKey => 403,
            Self::Unsupported => 501,
            _ => 503,
        }
    }
    pub fn message(self) -> &'static str {
        match self {
            Self::SignIn => "The selected sign-in expired or was rejected. Sign in to Codex again.",
            Self::ApiKey => {
                "The selected OpenAI API key was rejected. Check the selected account's API key."
            }
            Self::ReadyTimeout => "GPT-Live did not become ready before the startup deadline.",
            Self::SetupTimeout => "GPT-Live connection setup exceeded its deadline.",
            Self::CloseTimeout => "GPT-Live did not confirm closure before the deadline.",
            Self::Forbidden => "The selected provider denied access to GPT-Live.",
            Self::Unsupported => "GPT-Live is not supported by the selected provider.",
            _ => "The GPT-Live connection is unavailable.",
        }
    }
}
impl std::fmt::Display for ProviderFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}
impl std::error::Error for ProviderFailure {}
struct Budget {
    bytes: Arc<AtomicUsize>,
    size: usize,
    _permit: OwnedSemaphorePermit,
}
impl Drop for Budget {
    fn drop(&mut self) {
        self.bytes.fetch_sub(self.size, Ordering::AcqRel);
    }
}
enum Command {
    Append {
        input: Value,
        reply: oneshot::Sender<Result<()>>,
        budget: Budget,
    },
}
pub struct ProviderTransport {
    pub sdp: String,
    sender: mpsc::Sender<Command>,
    ended: watch::Receiver<Option<bool>>,
    dispose: CancellationToken,
    requested_close: CancellationToken,
    slots: Arc<Semaphore>,
    bytes: Arc<AtomicUsize>,
}
#[derive(Clone)]
pub(super) struct Endpoints {
    allocation: String,
    attachment: String,
    setup_timeout: Duration,
    ready_timeout: Duration,
    close_timeout: Duration,
}
impl Endpoints {
    fn official(native: bool) -> Self {
        Self{allocation:if native{"https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"}else{"https://api.openai.com/v1/live/sessions"}.to_owned(),attachment:if native{"wss://api.openai.com/v1/live"}else{"wss://api.openai.com/v1/live/sessions"}.to_owned(),setup_timeout:Duration::from_secs(30),ready_timeout:Duration::from_secs(30),close_timeout:Duration::from_secs(15)}
    }
}
impl ProviderTransport {
    pub async fn open(
        credential: LiveCredential,
        sdp: String,
        instructions: &str,
        cancel: CancellationToken,
        events: mpsc::Sender<Value>,
    ) -> Result<Self> {
        let endpoints =
            Endpoints::official(credential.kind == LiveCredentialKind::CodexSubscription);
        Self::open_at(credential, sdp, instructions, cancel, events, endpoints).await
    }
    pub(super) async fn open_at(
        credential: LiveCredential,
        sdp: String,
        instructions: &str,
        cancel: CancellationToken,
        events: mpsc::Sender<Value>,
        endpoints: Endpoints,
    ) -> Result<Self> {
        let native = credential.kind == LiveCredentialKind::CodexSubscription;
        let mut selection = json!({"type":if native{"codex_subscription"}else{"openai_api_key"},"token":credential.token});
        if let Some(account) = credential.account_id {
            selection["accountId"] = json!(account);
        }
        let schemas = Schemas::new()?;
        anyhow::ensure!(
            schemas.valid(
                "ownerLiveProviderInput",
                &json!({"credential":selection,"sdp":sdp,"instructions":instructions})
            )?,
            "The selected voice transport input is invalid."
        );
        anyhow::ensure!(!cancel.is_cancelled(), "Voice was cancelled.");
        let expires = tokio::time::Instant::now() + endpoints.setup_timeout;
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", selection["token"].as_str().unwrap())
                .parse()
                .map_err(|_| ProviderFailure::Unavailable)?,
        );
        headers.insert(reqwest::header::USER_AGENT, "happy-agent-live/1".parse()?);
        if native {
            for (name, value) in [
                ("openai-alpha", "quicksilver=v2".to_owned()),
                ("x-session-id", uuid::Uuid::new_v4().to_string()),
                ("session-id", uuid::Uuid::new_v4().to_string()),
                ("thread-id", uuid::Uuid::new_v4().to_string()),
                ("originator", "happy_agent".to_owned()),
            ] {
                headers.insert(
                    reqwest::header::HeaderName::from_bytes(name.as_bytes())?,
                    value.parse().map_err(|_| ProviderFailure::Unavailable)?,
                );
            }
            if let Some(account) = selection["accountId"].as_str() {
                headers.insert(
                    "chatgpt-account-id",
                    account.parse().map_err(|_| ProviderFailure::Unavailable)?,
                );
            }
        }
        let session = json!({"model":if native{"gpt-live-1-codex"}else{"gpt-live-1"},"instructions":instructions,"audio":{"output":{"voice":"cove"}},"delegation":{"type":"client"}});
        let body = if native {
            json!({"sdp":sdp,"session":session})
        } else {
            json!({"session":session,"transport":{"type":"webrtc","sdp":sdp}})
        };
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| ProviderFailure::Unavailable)?;
        let allocation = async {
            let response = client
                .post(&endpoints.allocation)
                .headers(headers.clone())
                .json(&body)
                .send()
                .await
                .map_err(|_| ProviderFailure::Unavailable)?;
            if !response.status().is_success() {
                return Err(match response.status().as_u16() {
                    401 => {
                        if native {
                            ProviderFailure::SignIn
                        } else {
                            ProviderFailure::ApiKey
                        }
                    }
                    403 => ProviderFailure::Forbidden,
                    404 | 501 => ProviderFailure::Unsupported,
                    _ => ProviderFailure::Unavailable,
                }
                .into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| ProviderFailure::Unavailable)?;
                anyhow::ensure!(
                    bytes.len() + chunk.len() <= 131072,
                    ProviderFailure::Unavailable
                );
                bytes.extend_from_slice(&chunk);
            }
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if native {
                let location = location
                    .filter(|location| location.len() <= 2048)
                    .ok_or(ProviderFailure::Unavailable)?;
                anyhow::ensure!(
                    !text.trim().is_empty() && text.len() <= 65536,
                    ProviderFailure::Unavailable
                );
                let url = reqwest::Url::parse("https://chatgpt.com")
                    .unwrap()
                    .join(&location)
                    .map_err(|_| ProviderFailure::Unavailable)?;
                let expression=regex_lite::Regex::new("(?i)^(rtc_[a-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$").unwrap();
                let id = url
                    .path_segments()
                    .into_iter()
                    .flatten()
                    .find(|part| expression.is_match(part))
                    .ok_or(ProviderFailure::Unavailable)?
                    .to_owned();
                anyhow::ensure!(
                    schemas.valid("ownerLiveProviderId", &json!(id))?,
                    ProviderFailure::Unavailable
                );
                Ok::<_, anyhow::Error>((id, text))
            } else {
                let value: Value =
                    serde_json::from_str(&text).map_err(|_| ProviderFailure::Unavailable)?;
                anyhow::ensure!(
                    schemas.valid("ownerLiveProviderPublicAnswer", &value)?,
                    ProviderFailure::Unavailable
                );
                Ok((
                    value["session"]["id"].as_str().unwrap().to_owned(),
                    value["transport"]["sdp"].as_str().unwrap().to_owned(),
                ))
            }
        };
        let (session_id, answer) = tokio::select! {_=cancel.cancelled()=>return Err(ProviderFailure::Unavailable.into()),result=tokio::time::timeout_at(expires,allocation)=>result.map_err(|_|ProviderFailure::SetupTimeout)??};
        let mut request = (if native {
            format!("{}/{session_id}", endpoints.attachment)
        } else {
            format!("{}/{session_id}/attach", endpoints.attachment)
        })
        .into_client_request()
        .map_err(|_| ProviderFailure::Unavailable)?;
        for (name, value) in &headers {
            request.headers_mut().insert(name, value.clone());
        }
        let websocket = WebSocketConfig::default()
            .max_message_size(Some(1024 * 1024))
            .max_frame_size(Some(1024 * 1024))
            .max_write_buffer_size(262144);
        let (socket, _) = tokio::select! {_=cancel.cancelled()=>return Err(ProviderFailure::Unavailable.into()),result=tokio::time::timeout_at(expires,connect_async_with_config(request,Some(websocket),false))=>result.map_err(|_|ProviderFailure::SetupTimeout)?.map_err(|error|match error{tokio_tungstenite::tungstenite::Error::Http(response)if matches!(response.status().as_u16(),401|403)=>ProviderFailure::Forbidden,_=>ProviderFailure::Unavailable})?};
        let (sender, commands) = mpsc::channel(128);
        let (terminal, ended) = watch::channel(None);
        let dispose = CancellationToken::new();
        let requested_close = CancellationToken::new();
        let slots = Arc::new(Semaphore::new(128));
        let bytes = Arc::new(AtomicUsize::new(0));
        let transport = Self {
            sdp: answer,
            sender,
            ended,
            dispose: dispose.clone(),
            requested_close: requested_close.clone(),
            slots,
            bytes,
        };
        tokio::spawn(async move {
            run(
                socket,
                commands,
                terminal,
                events,
                schemas,
                native,
                session_id,
                cancel,
                dispose,
                requested_close,
                endpoints.ready_timeout,
                endpoints.close_timeout,
            )
            .await;
        });
        Ok(transport)
    }
    pub async fn append(&self, input: Value) -> Result<()> {
        let schemas = Schemas::new()?;
        anyhow::ensure!(
            schemas.valid("ownerLiveProviderAppend", &input)?,
            ProviderFailure::Unavailable
        );
        let size = input["text"].as_str().unwrap().len();
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| ProviderFailure::Unavailable)?;
        self.bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |bytes| {
                bytes.checked_add(size).filter(|bytes| *bytes <= 262144)
            })
            .map_err(|_| ProviderFailure::Unavailable)?;
        let budget = Budget {
            bytes: self.bytes.clone(),
            size,
            _permit: permit,
        };
        let (reply, answer) = oneshot::channel();
        self.sender
            .try_send(Command::Append {
                input,
                reply,
                budget,
            })
            .map_err(|_| ProviderFailure::Unavailable)?;
        answer.await.map_err(|_| ProviderFailure::Unavailable)?
    }
    pub async fn close(&self) -> Result<()> {
        self.requested_close.cancel();
        let mut ended = self.ended.clone();
        loop {
            if let Some(orderly) = *ended.borrow_and_update() {
                anyhow::ensure!(orderly, ProviderFailure::Unavailable);
                return Ok(());
            }
            ended
                .changed()
                .await
                .map_err(|_| ProviderFailure::Unavailable)?;
        }
    }
    pub fn dispose(&self) {
        self.dispose.cancel();
    }
}
impl Drop for ProviderTransport {
    fn drop(&mut self) {
        self.dispose.cancel();
    }
}
enum Phase {
    Starting,
    Active,
    Closing { was_ready: bool },
}
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
async fn send(socket: &mut Socket, value: Value) -> Result<()> {
    tokio::time::timeout(
        Duration::from_secs(5),
        socket.send(Message::Text(value.to_string().into())),
    )
    .await
    .map_err(|_| ProviderFailure::Unavailable)?
    .map_err(|_| ProviderFailure::Unavailable)?;
    Ok(())
}
async fn emit(events: &mpsc::Sender<Value>, schemas: &Schemas, event: Value) -> Result<()> {
    anyhow::ensure!(
        schemas.valid("ownerLiveProviderEvent", &event)?,
        ProviderFailure::Unavailable
    );
    tokio::time::timeout(Duration::from_secs(5), events.send(event))
        .await
        .map_err(|_| ProviderFailure::Unavailable)?
        .map_err(|_| ProviderFailure::Unavailable)?;
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn run(
    mut socket: Socket,
    mut commands: mpsc::Receiver<Command>,
    terminal: watch::Sender<Option<bool>>,
    events: mpsc::Sender<Value>,
    schemas: Schemas,
    native: bool,
    session_id: String,
    cancel: CancellationToken,
    dispose: CancellationToken,
    requested_close: CancellationToken,
    ready_timeout: Duration,
    close_timeout: Duration,
) {
    let mut phase = Phase::Starting;
    let mut transcript_items = VecDeque::new();
    let readiness = tokio::time::sleep(ready_timeout);
    tokio::pin!(readiness);
    let closure = tokio::time::sleep(Duration::from_secs(365 * 86400));
    tokio::pin!(closure);
    let outcome=async {loop{tokio::select!{
        _=dispose.cancelled()=>return Err(ProviderFailure::Unavailable.into()),
        _=&mut readiness,if matches!(phase,Phase::Starting)=>{let _=send(&mut socket,json!({"type":"session.close"})).await;return Err(ProviderFailure::ReadyTimeout.into());},
        _=&mut closure,if matches!(phase,Phase::Closing{..})=>return Err(ProviderFailure::CloseTimeout.into()),
        _=async{tokio::select!{_=cancel.cancelled()=>{},_=requested_close.cancelled()=>{}}},if !matches!(phase,Phase::Closing{..})=>{let was_ready=matches!(phase,Phase::Active);phase=Phase::Closing{was_ready};closure.as_mut().reset(tokio::time::Instant::now()+close_timeout);send(&mut socket,json!({"type":"session.close"})).await?;if native {tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Close(Some(CloseFrame{code:CloseCode::Normal,reason:"".into()})))).await.map_err(|_|ProviderFailure::Unavailable)?.map_err(|_|ProviderFailure::Unavailable)?;}},
        command=commands.recv()=>match command.ok_or(ProviderFailure::Unavailable)? {
            Command::Append{input,reply,budget}=>{if !matches!(phase,Phase::Active){let _=reply.send(Err(ProviderFailure::Unavailable.into()));drop(budget);continue;}let operation=async{for content in chunks(input["text"].as_str().unwrap()){anyhow::ensure!(!cancel.is_cancelled()&&!requested_close.is_cancelled(),ProviderFailure::Unavailable);let frame=if native{let mut frame=json!({"type":if input["delegationId"].is_null(){"session.context.append"}else{"delegation.context.append"},"channel":if input["speakable"]==true{"speakable"}else{"commentary"},"content":[{"type":"input_text","text":content}]});if !input["delegationId"].is_null(){frame["delegation_item_id"]=input["delegationId"].clone();}frame}else{json!({"type":if input["speakable"]==true{"session.commentary.append"}else{"session.thinking.append"},"event_id":uuid::Uuid::new_v4().to_string(),"delegation_id":input["delegationId"],"content":content})};send(&mut socket,frame).await?;}Ok::<_,anyhow::Error>(())}.await;let failed=operation.is_err();let _=reply.send(operation);drop(budget);if failed&&!cancel.is_cancelled()&&!requested_close.is_cancelled(){return Err(ProviderFailure::Unavailable.into());}},
        },
        message=socket.next()=>{
            let message=message.ok_or(ProviderFailure::Unavailable)?.map_err(|_|ProviderFailure::Unavailable)?;let text=match message {Message::Text(text)=>text,Message::Close(frame)=>return if native&&matches!(phase,Phase::Closing{was_ready:true})&&frame.is_some_and(|frame|frame.code==CloseCode::Normal){Ok(true)}else{Err(ProviderFailure::Unavailable.into())},Message::Ping(_)|Message::Pong(_)=>continue,_=>return Err(ProviderFailure::Unavailable.into())};let value:Value=serde_json::from_str(text.as_str()).map_err(|_|ProviderFailure::Unavailable)?;anyhow::ensure!(schemas.valid("ownerLiveProviderEnvelope",&value)?,ProviderFailure::Unavailable);let kind=value["type"].as_str().unwrap();
            if kind=="error"{let code=if schemas.valid("ownerLiveProviderError",&value)?{value["error"]["code"].as_str().or_else(||value["code"].as_str())}else{None};return Err(if code.is_some_and(|code|matches!(code,"forbidden"|"invalid_api_key"|"insufficient_scope")){ProviderFailure::Forbidden}else{ProviderFailure::Unavailable}.into());}
            if kind=="session.started"||(native&&kind=="session.updated"){anyhow::ensure!(schemas.valid("ownerLiveProviderReady",&value)?&&(native||value["session"]["id"]==session_id),ProviderFailure::Unavailable);if matches!(phase,Phase::Starting){phase=Phase::Active;emit(&events,&schemas,json!({"type":"ready"})).await?;}continue;}
            if !native&&kind=="session.closed"{anyhow::ensure!(schemas.valid("ownerLiveProviderClosed",&value)?&&value["session"]["id"]==session_id,ProviderFailure::Unavailable);emit(&events,&schemas,json!({"type":"usage","seconds":value["usage"]["seconds"],"final":true})).await?;return if matches!(phase,Phase::Closing{was_ready:true})&&value["reason"]=="close_requested"{Ok(true)}else{Err(ProviderFailure::Unavailable.into())};}
            if !native&&kind=="session.usage.updated"{anyhow::ensure!(schemas.valid("ownerLiveProviderUsage",&value)?,ProviderFailure::Unavailable);emit(&events,&schemas,json!({"type":"usage","seconds":value["usage"]["seconds"],"final":false})).await?;continue;}
            if matches!(phase,Phase::Closing{..}){continue;}
            if !native&&matches!(kind,"session.input_transcript.delta"|"session.output_transcript.delta"){anyhow::ensure!(matches!(phase,Phase::Active)&&schemas.valid("ownerLiveProviderPublicTranscript",&value)?,ProviderFailure::Unavailable);let start=value["start_ms"].as_f64().unwrap();let end=value["end_ms"].as_f64().unwrap();anyhow::ensure!(end>=start,ProviderFailure::Unavailable);let mut event=json!({"type":"transcript","role":if kind.contains("input_"){"user"}else{"assistant"},"text":value["delta"]});if start.fract()==0.0&&end.fract()==0.0{event["startMs"]=json!(start as u64);event["endMs"]=json!(end as u64);}emit(&events,&schemas,event).await?;continue;}
            if native&&matches!(kind,"input_transcript.added"|"output_transcript.added"){let role=if kind.starts_with("input_"){"input_transcript"}else{"output_transcript"};anyhow::ensure!(matches!(phase,Phase::Active)&&schemas.valid("ownerLiveProviderNativeTranscript",&value)?&&value["item"]["type"]==role,ProviderFailure::Unavailable);let key=format!("{role}:{}",value["item"]["id"].as_str().unwrap());if transcript_items.contains(&key){continue;}if transcript_items.len()>=512{transcript_items.pop_front();}transcript_items.push_back(key);emit(&events,&schemas,json!({"type":"transcript","role":if kind.starts_with("input_"){"user"}else{"assistant"},"text":value["item"]["text"]})).await?;continue;}
            if !native&&kind=="session.delegation.created"{anyhow::ensure!(matches!(phase,Phase::Active)&&schemas.valid("ownerLiveProviderPublicDelegation",&value)?,ProviderFailure::Unavailable);emit(&events,&schemas,json!({"type":"delegation","delegationId":value["delegation"]["id"]})).await?;continue;}
            if native&&kind=="delegation.created"{anyhow::ensure!(matches!(phase,Phase::Active)&&schemas.valid("ownerLiveProviderNativeDelegation",&value)?,ProviderFailure::Unavailable);let text=value["item"]["content"].as_array().unwrap().iter().map(|item|item["text"].as_str().unwrap()).collect::<String>();anyhow::ensure!(text.encode_utf16().count()<=65536,ProviderFailure::Unavailable);emit(&events,&schemas,json!({"type":"delegation","delegationId":value["item"]["id"],"text":text})).await?;}
        }
    }}}.await;
    let failure = outcome
        .as_ref()
        .err()
        .and_then(|error: &anyhow::Error| error.downcast_ref::<ProviderFailure>())
        .copied()
        .unwrap_or(ProviderFailure::Unavailable);
    let event = if matches!(outcome, Ok(true)) {
        json!({"type":"ended","orderly":true,"error":null})
    } else {
        json!({"type":"ended","orderly":false,"error":failure.message(),"code":failure.code()})
    };
    let _ = emit(&events, &schemas, event).await;
    terminal.send_replace(Some(matches!(outcome, Ok(true))));
    while let Ok(command) = commands.try_recv() {
        let Command::Append { reply, .. } = command;
        let _ = reply.send(Err(ProviderFailure::Unavailable.into()));
    }
}
pub fn chunks(text: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut part = String::new();
    for character in text.chars() {
        if part.len() + character.len_utf8() > 500 {
            result.push(std::mem::take(&mut part));
        }
        part.push(character);
    }
    if !part.is_empty() {
        result.push(part);
    }
    result
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    #[derive(Clone, Copy)]
    pub(in crate::product::live) enum Closure {
        Orderly,
        SocketOnly,
        Silent,
    }
    pub(in crate::product::live) struct Fixture {
        pub(in crate::product::live) endpoints: Endpoints,
        pub(in crate::product::live) records: Arc<Mutex<Vec<Value>>>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Fixture {
        pub(in crate::product::live) async fn start(
            native: bool,
            initial: Vec<Value>,
            closure: Closure,
            status: u16,
        ) -> Self {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let address = listener.local_addr().unwrap();
            let records = Arc::new(Mutex::new(Vec::new()));
            let observed = records.clone();
            let task = tokio::spawn(async move {
                let (mut http, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let header_end;
                loop {
                    let mut byte = [0];
                    http.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < 16384);
                    if request.ends_with(b"\r\n\r\n") {
                        header_end = request.len();
                        break;
                    }
                }
                let headers = String::from_utf8(request.clone()).unwrap();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                assert!(length <= 131072);
                request.resize(header_end + length, 0);
                http.read_exact(&mut request[header_end..]).await.unwrap();
                let input: Value = serde_json::from_slice(&request[header_end..]).unwrap();
                observed.lock().unwrap().push(json!({"kind":"allocation","path":headers.lines().next().unwrap().split_whitespace().nth(1).unwrap(),"headers":headers,"body":input}));
                let response = if status != 200 {
                    "Do not expose this fixture provider body or replay its offer.".to_owned()
                } else if native {
                    "v=0\r\nfixture-answer\r\n".to_owned()
                } else {
                    json!({"session":{"id":"public_fixture"},"transport":{"type":"webrtc","sdp":"v=0\r\nfixture-answer\r\n"}}).to_string()
                };
                let location = if native {
                    "Location: /backend-api/codex/realtime/calls/rtc_fixture-123\r\n"
                } else {
                    ""
                };
                let reply = format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nContent-Type: application/json\r\n{location}Connection: close\r\n\r\n{response}",
                    response.len()
                );
                http.write_all(reply.as_bytes()).await.unwrap();
                http.shutdown().await.unwrap();
                if status != 200 {
                    return;
                }
                let (tcp, _) = listener.accept().await.unwrap();
                let capture = observed.clone();
                let mut socket=tokio_tungstenite::accept_hdr_async(tcp,move|request:&tokio_tungstenite::tungstenite::handshake::server::Request,response:tokio_tungstenite::tungstenite::handshake::server::Response|{capture.lock().unwrap().push(json!({"kind":"attach","path":request.uri().path(),"authorization":request.headers().get("authorization").unwrap().to_str().unwrap(),"alpha":request.headers().get("openai-alpha").map(|value|value.to_str().unwrap())}));Ok(response)}).await.unwrap();
                for event in initial {
                    socket
                        .send(Message::Text(event.to_string().into()))
                        .await
                        .unwrap();
                }
                while let Some(frame) = socket.next().await {
                    match frame {
                        Ok(Message::Text(text)) => {
                            let value: Value = serde_json::from_str(text.as_str()).unwrap();
                            observed
                                .lock()
                                .unwrap()
                                .push(json!({"kind":"client","frame":value}));
                            if value["type"] == "session.close" && !native {
                                match closure {
                                    Closure::Orderly => {
                                        socket.send(Message::Text(json!({"type":"session.closed","session":{"id":"public_fixture"},"usage":{"seconds":12.25},"reason":"close_requested"}).to_string().into())).await.unwrap();
                                        return;
                                    }
                                    Closure::SocketOnly => {
                                        socket
                                            .close(Some(CloseFrame {
                                                code: CloseCode::Normal,
                                                reason: "".into(),
                                            }))
                                            .await
                                            .unwrap();
                                        return;
                                    }
                                    Closure::Silent => {}
                                }
                            }
                        }
                        Ok(Message::Close(_)) => {
                            if native && matches!(closure, Closure::Orderly) {
                                let _ = socket.flush().await;
                            }
                            return;
                        }
                        Ok(_) => {}
                        Err(_) => return,
                    }
                }
            });
            Self {
                endpoints: Endpoints {
                    allocation: format!(
                        "http://{address}/{}",
                        if native {
                            "native/calls"
                        } else {
                            "v1/live/sessions"
                        }
                    ),
                    attachment: format!(
                        "ws://{address}/{}",
                        if native {
                            "v1/live"
                        } else {
                            "v1/live/sessions"
                        }
                    ),
                    setup_timeout: Duration::from_secs(5),
                    ready_timeout: Duration::from_millis(100),
                    close_timeout: Duration::from_millis(100),
                },
                records,
                task,
            }
        }
        async fn open(
            &mut self,
            native: bool,
        ) -> (Result<ProviderTransport>, mpsc::Receiver<Value>) {
            let (events, receiver) = mpsc::channel(64);
            let endpoints = Endpoints {
                allocation: self.endpoints.allocation.clone(),
                attachment: self.endpoints.attachment.clone(),
                setup_timeout: self.endpoints.setup_timeout,
                ready_timeout: self.endpoints.ready_timeout,
                close_timeout: self.endpoints.close_timeout,
            };
            let transport = ProviderTransport::open_at(
                LiveCredential {
                    kind: if native {
                        LiveCredentialKind::CodexSubscription
                    } else {
                        LiveCredentialKind::OpenaiApiKey
                    },
                    token: "fixture-only-token".to_owned(),
                    account_id: native.then(|| "fixture-account".to_owned()),
                },
                "v=0\r\nfixture-offer\r\n".to_owned(),
                "Fixture voice instructions",
                CancellationToken::new(),
                events,
                endpoints,
            )
            .await;
            (transport, receiver)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn event(events: &mut mpsc::Receiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .expect("A real transport event")
    }
    #[test]
    fn append_chunks_preserve_utf8_without_replaying_or_rounding() {
        let text = "a😀é".repeat(2048);
        let chunks = chunks(&text);
        assert!(chunks.iter().all(|chunk| chunk.len() <= 500));
        assert_eq!(chunks.concat(), text);
        assert!(!chunks.is_empty());
    }
    #[tokio::test]
    async fn public_dialect_allocates_once_attaches_passively_and_requires_session_closed_usage() {
        let mut fixture=Fixture::start(false,vec![json!({"type":"session.started","session":{"id":"public_fixture"}}),json!({"type":"session.input_transcript.delta","delta":"Actual transcript","start_ms":0.1,"end_ms":1.2})],Closure::Orderly,200).await;
        let (transport, mut events) = fixture.open(false).await;
        let transport = transport.unwrap();
        assert_eq!(event(&mut events).await, json!({"type":"ready"}));
        assert_eq!(
            event(&mut events).await,
            json!({"type":"transcript","role":"user","text":"Actual transcript"})
        );
        transport
            .append(json!({"delegationId":null,"text":"Inspect the desktop.","speakable":false}))
            .await
            .unwrap();
        transport.close().await.unwrap();
        assert_eq!(
            event(&mut events).await,
            json!({"type":"usage","seconds":12.25,"final":true})
        );
        assert_eq!(
            event(&mut events).await,
            json!({"type":"ended","orderly":true,"error":null})
        );
        let records = fixture.records.lock().unwrap();
        assert_eq!(
            records
                .iter()
                .filter(|record| record["kind"] == "allocation")
                .count(),
            1
        );
        assert_eq!(records[0]["body"]["session"]["model"], "gpt-live-1");
        assert_eq!(
            records[0]["body"]["transport"]["sdp"],
            "v=0\r\nfixture-offer\r\n"
        );
        assert_eq!(
            records[1]["path"],
            "/v1/live/sessions/public_fixture/attach"
        );
        assert_eq!(records[2]["frame"]["type"], "session.thinking.append");
        assert_eq!(records[3]["frame"], json!({"type":"session.close"}));
    }
    #[tokio::test]
    async fn native_dialect_reuses_original_call_id_deduplicates_transcripts_and_never_invents_usage()
     {
        let transcript = json!({"type":"input_transcript.added","item":{"id":"utterance_1","type":"input_transcript","text":"Native speech"}});
        let mut fixture = Fixture::start(
            true,
            vec![
                json!({"type":"session.updated","session":{"id":"native_backend_id"}}),
                transcript.clone(),
                transcript,
            ],
            Closure::Orderly,
            200,
        )
        .await;
        let (transport, mut events) = fixture.open(true).await;
        let transport = transport.unwrap();
        assert_eq!(event(&mut events).await, json!({"type":"ready"}));
        assert_eq!(
            event(&mut events).await,
            json!({"type":"transcript","role":"user","text":"Native speech"})
        );
        transport.append(json!({"delegationId":"delegation_original","text":"Confirmed result","speakable":true})).await.unwrap();
        transport.close().await.unwrap();
        assert_eq!(
            event(&mut events).await,
            json!({"type":"ended","orderly":true,"error":null})
        );
        let records = fixture.records.lock().unwrap();
        assert_eq!(records[0]["body"]["session"]["model"], "gpt-live-1-codex");
        assert_eq!(records[1]["path"], "/v1/live/rtc_fixture-123");
        assert_eq!(records[1]["alpha"], "quicksilver=v2");
        assert_eq!(
            records[2]["frame"],
            json!({"type":"delegation.context.append","delegation_item_id":"delegation_original","channel":"speakable","content":[{"type":"input_text","text":"Confirmed result"}]})
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| record["kind"] == "allocation")
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn a_clean_websocket_close_is_not_public_provider_closure_proof() {
        let mut fixture = Fixture::start(
            false,
            vec![json!({"type":"session.started","session":{"id":"public_fixture"}})],
            Closure::SocketOnly,
            200,
        )
        .await;
        let (transport, mut events) = fixture.open(false).await;
        let transport = transport.unwrap();
        event(&mut events).await;
        assert!(transport.close().await.is_err());
        let ended = event(&mut events).await;
        assert_eq!(ended["type"], "ended");
        assert_eq!(ended["orderly"], false);
        assert_eq!(ended["code"], "live_unavailable");
    }
    #[tokio::test]
    async fn readiness_and_close_deadlines_fail_without_a_second_allocation() {
        for ready in [false, true] {
            let initial = if ready {
                vec![json!({"type":"session.started","session":{"id":"public_fixture"}})]
            } else {
                vec![]
            };
            let mut fixture = Fixture::start(false, initial, Closure::Silent, 200).await;
            let (transport, mut events) = fixture.open(false).await;
            let transport = transport.unwrap();
            if ready {
                event(&mut events).await;
                assert!(transport.close().await.is_err());
            }
            let ended = event(&mut events).await;
            assert_eq!(ended["orderly"], false);
            assert_eq!(
                ended["error"],
                if ready {
                    ProviderFailure::CloseTimeout.message()
                } else {
                    ProviderFailure::ReadyTimeout.message()
                }
            );
            assert_eq!(
                fixture
                    .records
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|record| record["kind"] == "allocation")
                    .count(),
                1
            );
        }
    }
    #[tokio::test]
    async fn wrong_ready_identity_and_rejected_credentials_stay_sanitized_and_do_not_replay() {
        let mut fixture = Fixture::start(
            false,
            vec![json!({"type":"session.started","session":{"id":"different_call"}})],
            Closure::Silent,
            200,
        )
        .await;
        let (transport, mut events) = fixture.open(false).await;
        let _transport = transport.unwrap();
        assert_eq!(event(&mut events).await["orderly"], false);
        for native in [false, true] {
            let mut fixture = Fixture::start(native, vec![], Closure::Silent, 401).await;
            let (transport, _) = fixture.open(native).await;
            let error = transport.err().unwrap();
            assert_eq!(
                error.to_string(),
                if native {
                    ProviderFailure::SignIn.message()
                } else {
                    ProviderFailure::ApiKey.message()
                }
            );
            assert!(!error.to_string().contains("fixture-only-token"));
            assert_eq!(fixture.records.lock().unwrap().len(), 1);
        }
    }
}
