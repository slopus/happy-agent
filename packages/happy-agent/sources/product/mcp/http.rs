//! A remote MCP server reached over Streamable HTTP, as the original's SDK transport spoke it.
//!
//! Every message is a POST; a request's answer comes back as JSON or as a server-sent event
//! stream that may also carry the server's own requests. After initialization a GET stream is
//! opened for messages the server sends unprompted, and reopened when it ends. The session ID
//! and the negotiated protocol version travel on every message once known, and configured
//! headers win over both.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::lock;
use super::protocol::{McpError, Transport, TransportEvent};

const MAX_RECONNECTION_ATTEMPTS: u32 = 2;

pub(super) struct HttpTransport {
    this: std::sync::Weak<HttpTransport>,
    client: reqwest::Client,
    url: reqwest::Url,
    headers: Vec<(String, String)>,
    session_id: Mutex<Option<String>>,
    protocol_version: Mutex<Option<String>>,
    retry_ms: Mutex<Option<u64>>,
    events: mpsc::UnboundedSender<TransportEvent>,
    abort: CancellationToken,
}

struct StreamOutcome {
    last_event_id: Option<String>,
    primed: bool,
    received_response: bool,
}

impl HttpTransport {
    /// Prepare the transport; no request is made until the first message.
    pub fn new(config: &Value) -> Result<(Arc<HttpTransport>, mpsc::UnboundedReceiver<TransportEvent>), String> {
        let url = reqwest::Url::parse(config["url"].as_str().unwrap_or_default()).map_err(|_| "Invalid URL".to_string())?;
        let mut headers: Vec<(String, String)> = config
            .get("headers")
            .and_then(Value::as_object)
            .map(|headers| headers.iter().filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_string()))).collect())
            .unwrap_or_default();
        if let Some(variable) = config.get("bearerTokenEnvVar").and_then(Value::as_str) {
            let token = std::env::var(variable).ok().map(|token| super::super::text::js_trim(&token).to_string()).unwrap_or_default();
            if token.is_empty() {
                return Err(format!("MCP bearer token environment variable {variable} is missing."));
            }
            headers.retain(|(name, _)| !name.eq_ignore_ascii_case("authorization"));
            headers.push(("Authorization".into(), format!("Bearer {token}")));
        }
        let client = reqwest::Client::builder().no_proxy().build().map_err(|error| error.to_string())?;
        let (events, receiver) = mpsc::unbounded_channel();
        Ok((
            Arc::new_cyclic(|this| HttpTransport {
                this: this.clone(),
                client,
                url,
                headers,
                session_id: Mutex::new(None),
                protocol_version: Mutex::new(None),
                retry_ms: Mutex::new(None),
                events,
                abort: CancellationToken::new(),
            }),
            receiver,
        ))
    }

    fn common_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        let mut set = |name: &str, value: &str| {
            if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(value)) {
                headers.insert(name, value);
            }
        };
        if let Some(session) = lock(&self.session_id).clone() {
            set("mcp-session-id", &session);
        }
        if let Some(version) = lock(&self.protocol_version).clone() {
            set("mcp-protocol-version", &version);
        }
        for (name, value) in &self.headers {
            set(name, value);
        }
        headers
    }

    async fn fetch(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response, McpError> {
        tokio::select! {
            _ = self.abort.cancelled() => Err(McpError::plain("This operation was aborted")),
            response = request.send() => response.map_err(|_| McpError::plain("fetch failed")),
        }
    }

    /// Open the GET stream for messages the server sends on its own, resuming after
    /// `last_event_id` when one is given.
    fn open_stream(self: &Arc<Self>, last_event_id: Option<String>, attempt: u32) {
        let transport = self.clone();
        tokio::spawn(async move {
            match transport.get_stream(last_event_id.clone()).await {
                Ok(Some(response)) => {
                    let outcome = transport.read_stream(response).await;
                    transport.after_stream(outcome, true);
                }
                Ok(None) => {}
                Err(_) if attempt > 0 => transport.schedule_reconnection(last_event_id, attempt),
                Err(_) => {}
            }
        });
    }

    async fn get_stream(&self, last_event_id: Option<String>) -> Result<Option<reqwest::Response>, McpError> {
        let mut headers = self.common_headers();
        headers.insert(reqwest::header::ACCEPT, HeaderValue::from_static("text/event-stream"));
        if let Some(id) = last_event_id.and_then(|id| HeaderValue::from_str(&id).ok()) {
            headers.insert(HeaderName::from_static("last-event-id"), id);
        }
        let response = self.fetch(self.client.get(self.url.clone()).headers(headers)).await?;
        if response.status().is_success() {
            return Ok(Some(response));
        }
        if response.status().as_u16() == 405 {
            return Ok(None);
        }
        Err(McpError::plain(format!(
            "Streamable HTTP error: Failed to open SSE stream: {}",
            response.status().canonical_reason().unwrap_or_default()
        )))
    }

    /// Reopen an ended stream that never carried its answer, with a growing delay.
    fn schedule_reconnection(self: &Arc<Self>, last_event_id: Option<String>, attempt: u32) {
        if attempt >= MAX_RECONNECTION_ATTEMPTS || self.abort.is_cancelled() {
            return;
        }
        let delay = lock(&self.retry_ms).unwrap_or_else(|| (1_000.0 * 1.5f64.powi(attempt as i32)).min(30_000.0) as u64);
        let transport = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = transport.abort.cancelled() => {}
                _ = tokio::time::sleep(Duration::from_millis(delay)) => {
                    match transport.get_stream(last_event_id.clone()).await {
                        Ok(Some(response)) => {
                            let outcome = transport.read_stream(response).await;
                            transport.after_stream(outcome, true);
                        }
                        Ok(None) => {}
                        Err(_) => transport.schedule_reconnection(last_event_id, attempt + 1),
                    }
                }
            }
        });
    }

    fn after_stream(self: &Arc<Self>, outcome: StreamOutcome, reconnectable: bool) {
        if (reconnectable || outcome.primed) && !outcome.received_response && !self.abort.is_cancelled() {
            self.schedule_reconnection(outcome.last_event_id, 0);
        }
    }

    /// Deliver every message event of one server-sent event stream.
    async fn read_stream(&self, response: reqwest::Response) -> StreamOutcome {
        let mut outcome = StreamOutcome { last_event_id: None, primed: false, received_response: false };
        let mut body = response.bytes_stream();
        let mut buffer = String::new();
        let mut pending = Vec::<u8>::new();
        let (mut data, mut event, mut id): (Vec<String>, Option<String>, Option<String>) = (Vec::new(), None, None);
        loop {
            let chunk = tokio::select! {
                _ = self.abort.cancelled() => return outcome,
                chunk = body.next() => chunk,
            };
            let Some(Ok(chunk)) = chunk else { return outcome };
            pending.extend_from_slice(&chunk);
            let valid = match std::str::from_utf8(&pending) {
                Ok(text) => text.len(),
                Err(error) => error.valid_up_to(),
            };
            buffer.push_str(&String::from_utf8_lossy(&pending[..valid]));
            pending.drain(..valid);
            while let Some(end) = buffer.find('\n') {
                let line = buffer[..end].trim_end_matches('\r').to_string();
                buffer.drain(..=end);
                if line.is_empty() {
                    if let Some(identity) = id.take() {
                        outcome.last_event_id = Some(identity);
                        outcome.primed = true;
                    }
                    let kind = event.take();
                    let payload = std::mem::take(&mut data).join("\n");
                    if !payload.is_empty() {
                        if kind.as_deref().is_none_or(|kind| kind == "message") {
                            if let Ok(message) = serde_json::from_str::<Value>(&payload) {
                                if message.get("result").is_some() && message.get("id").is_some() {
                                    outcome.received_response = true;
                                }
                                let _ = self.events.send(TransportEvent::Message(message));
                            }
                        }
                    }
                    continue;
                }
                if line.starts_with(':') {
                    continue;
                }
                let (field, value) = match line.split_once(':') {
                    Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
                    None => (line.as_str(), ""),
                };
                match field {
                    "data" => data.push(value.to_string()),
                    "event" => event = Some(value.to_string()),
                    "id" if !value.contains('\u{0}') => id = Some(value.to_string()),
                    "retry" => {
                        if let Ok(milliseconds) = value.parse::<u64>() {
                            *lock(&self.retry_ms) = Some(milliseconds);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn send(&self, message: Value) -> Result<(), McpError> {
        let mut headers = self.common_headers();
        headers.insert(reqwest::header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(reqwest::header::ACCEPT, HeaderValue::from_static("application/json, text/event-stream"));
        let body = super::super::text::js_json_stringify(&message);
        let response = self.fetch(self.client.post(self.url.clone()).headers(headers).body(body)).await?;
        if let Some(session) = response.headers().get("mcp-session-id").and_then(|value| value.to_str().ok()) {
            if !session.is_empty() {
                *lock(&self.session_id) = Some(session.to_string());
            }
        }
        if !response.status().is_success() {
            let text = response.text().await.unwrap_or_else(|_| "null".into());
            return Err(McpError::plain(format!("Streamable HTTP error: Error POSTing to endpoint: {text}")));
        }
        if response.status().as_u16() == 202 {
            if message.get("method").and_then(Value::as_str) == Some("notifications/initialized") && message.get("id").is_none() {
                if let Some(transport) = self.self_handle() {
                    transport.open_stream(None, 0);
                }
            }
            return Ok(());
        }
        let is_request = message.get("method").is_some() && message.get("id").is_some_and(|id| !id.is_null());
        if !is_request {
            return Ok(());
        }
        let content_type = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).map(str::to_string);
        match content_type.as_deref() {
            Some(kind) if kind.contains("text/event-stream") => {
                if let Some(transport) = self.self_handle() {
                    tokio::spawn(async move {
                        let outcome = transport.read_stream(response).await;
                        transport.after_stream(outcome, false);
                    });
                }
                Ok(())
            }
            Some(kind) if kind.contains("application/json") => {
                let data: Value = response.json().await.map_err(|error| McpError::plain(error.to_string()))?;
                let messages = match data {
                    Value::Array(items) => items,
                    single => vec![single],
                };
                for message in messages {
                    let _ = self.events.send(TransportEvent::Message(message));
                }
                Ok(())
            }
            other => Err(McpError::plain(format!("Streamable HTTP error: Unexpected content type: {}", other.unwrap_or("null")))),
        }
    }

    async fn close(&self) {
        self.abort.cancel();
        let _ = self.events.send(TransportEvent::Closed);
    }

    fn set_protocol_version(&self, version: &str) {
        *lock(&self.protocol_version) = Some(version.to_string());
    }
}

impl HttpTransport {
    fn self_handle(&self) -> Option<Arc<HttpTransport>> {
        self.this.upgrade()
    }
}
