//! JSON-RPC over one MCP transport, as the original's SDK client spoke it.
//!
//! Request IDs count from zero. A request ends with the server's answer, with the connection
//! closing, with its timeout, or with its caller's lifetime; the last two tell the server with
//! `notifications/cancelled`. The server's own requests are answered here: `ping` always, and
//! `elicitation/create` through whatever handler the current tool call installed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::lock;
use super::sdk::{self, Incoming, Shape};

/// What a failed request reports, worded as the SDK worded it.
#[derive(Debug, Clone)]
pub(super) struct McpError {
    pub code: Option<i64>,
    pub message: String,
}

impl McpError {
    pub fn plain(message: impl Into<String>) -> Self {
        Self { code: None, message: message.into() }
    }

    pub fn coded(code: i64, message: impl Into<String>) -> Self {
        Self { code: Some(code), message: message.into() }
    }
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.code {
            Some(code) => write!(f, "MCP error {code}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for McpError {}

pub(super) const CONNECTION_CLOSED: i64 = -32000;
pub(super) const REQUEST_TIMEOUT: i64 = -32001;
pub(super) const INVALID_REQUEST: i64 = -32600;
pub(super) const METHOD_NOT_FOUND: i64 = -32601;
pub(super) const INVALID_PARAMS: i64 = -32602;

/// What a transport hands the protocol.
pub(super) enum TransportEvent {
    Message(Value),
    Closed,
}

/// Runner input applies backpressure; closing takes priority over queued messages.
pub(super) enum TransportEvents {
    Unbounded(mpsc::UnboundedReceiver<TransportEvent>),
    Bounded {
        messages: mpsc::Receiver<TransportEvent>,
        closed: CancellationToken,
    },
}
impl From<mpsc::UnboundedReceiver<TransportEvent>> for TransportEvents {
    fn from(events: mpsc::UnboundedReceiver<TransportEvent>) -> Self {
        Self::Unbounded(events)
    }
}
impl TransportEvents {
    async fn recv(&mut self) -> Option<TransportEvent> {
        match self {
            Self::Unbounded(events) => events.recv().await,
            Self::Bounded { messages, closed } => tokio::select! {
                biased;
                _ = closed.cancelled() => Some(TransportEvent::Closed),
                message = messages.recv() => message,
            },
        }
    }
}

/// One way to reach a server. Incoming messages arrive on the channel the transport was
/// created with; `Closed` arrives once, when the server or the transport ends.
#[async_trait]
pub(super) trait Transport: Send + Sync {
    async fn send(&self, message: Value) -> Result<(), McpError>;
    async fn close(&self);
    /// The negotiated protocol version, for transports that carry it on every message.
    fn set_protocol_version(&self, _version: &str) {}
}

/// Answers a server's `elicitation/create` with the parsed request.
pub(super) type ElicitationHandler = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Value, McpError>> + Send + Sync>;

struct State {
    next_id: i64,
    pending: HashMap<i64, oneshot::Sender<Result<Value, McpError>>>,
    handling: HashMap<String, CancellationToken>,
    closed: bool,
    on_close: Vec<Box<dyn FnOnce() + Send>>,
}

pub(super) struct Protocol {
    transport: Arc<dyn Transport>,
    state: Mutex<State>,
    elicitation: Mutex<Option<ElicitationHandler>>,
}

impl Protocol {
    /// Start reading the transport's events.
    pub fn start(
        transport: Arc<dyn Transport>,
        events: impl Into<TransportEvents>,
    ) -> Arc<Protocol> {
        let mut events = events.into();
        let protocol = Arc::new(Protocol {
            transport,
            state: Mutex::new(State { next_id: 0, pending: HashMap::new(), handling: HashMap::new(), closed: false, on_close: Vec::new() }),
            elicitation: Mutex::new(None),
        });
        let weak = Arc::downgrade(&protocol);
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                let Some(protocol) = weak.upgrade() else {
                    return;
                };
                match event {
                    TransportEvent::Message(message) => protocol.receive(message),
                    TransportEvent::Closed => {
                        protocol.closed();
                        return;
                    }
                }
            }
            if let Some(protocol) = weak.upgrade() {
                protocol.closed();
            }
        });
        protocol
    }

    pub fn transport(&self) -> &Arc<dyn Transport> {
        &self.transport
    }

    pub fn is_closed(&self) -> bool {
        lock(&self.state).closed
    }

    /// Run once when the connection ends, or now when it already has.
    pub fn on_close(&self, callback: impl FnOnce() + Send + 'static) {
        let mut state = lock(&self.state);
        if state.closed {
            drop(state);
            callback();
            return;
        }
        state.on_close.push(Box::new(callback));
    }

    pub fn set_elicitation(&self, handler: Option<ElicitationHandler>) {
        *lock(&self.elicitation) = handler;
    }

    fn closed(&self) {
        let (pending, callbacks, handling) = {
            let mut state = lock(&self.state);
            if state.closed {
                return;
            }
            state.closed = true;
            (std::mem::take(&mut state.pending), std::mem::take(&mut state.on_close), std::mem::take(&mut state.handling))
        };
        for token in handling.into_values() {
            token.cancel();
        }
        for callback in callbacks {
            callback();
        }
        for sender in pending.into_values() {
            let _ = sender.send(Err(McpError::coded(CONNECTION_CLOSED, "Connection closed")));
        }
    }

    fn receive(self: &Arc<Self>, message: Value) {
        let Some(incoming) = sdk::classify(&message) else {
            return;
        };
        match incoming {
            Incoming::Result { id, result } => self.respond(&id, Ok(result)),
            Incoming::Error { id: Some(id), code, message, .. } => self.respond(&id, Err(McpError::coded(code, message))),
            Incoming::Error { id: None, .. } => {}
            Incoming::Request { id, method, params } => self.handle_request(id, method, params),
            Incoming::Notification { method, params } => {
                if method == "notifications/cancelled" {
                    let Some(request) = params.as_ref().and_then(|params| params.get("requestId"))
                    else {
                        return;
                    };
                    if let Some(token) = lock(&self.state).handling.remove(&request.to_string()) {
                        token.cancel();
                    }
                }
            }
        }
    }

    fn respond(&self, id: &Value, outcome: Result<Value, McpError>) {
        let key = match id {
            Value::Number(number) => number.as_f64().map(|number| number as i64),
            Value::String(text) => text.trim().parse::<f64>().ok().filter(|number| number.fract() == 0.0).map(|number| number as i64),
            _ => None,
        };
        let Some(key) = key else { return };
        if let Some(sender) = lock(&self.state).pending.remove(&key) {
            let _ = sender.send(outcome);
        }
    }

    fn handle_request(self: &Arc<Self>, id: Value, method: String, params: Option<Value>) {
        let token = CancellationToken::new();
        lock(&self.state).handling.insert(id.to_string(), token.clone());
        let protocol = self.clone();
        tokio::spawn(async move {
            // A thrown handler error travels as its whole message, prefix included, while an
            // unknown method gets the bare JSON-RPC wording.
            let outcome = match method.as_str() {
                "ping" => Ok(json!({})),
                "elicitation/create" => protocol.elicit(params).await.map_err(|error| (error.code.unwrap_or(-32603), error.to_string())),
                _ => Err((METHOD_NOT_FOUND, "Method not found".to_string())),
            };
            lock(&protocol.state).handling.remove(&id.to_string());
            if token.is_cancelled() {
                return;
            }
            let response = match outcome {
                Ok(result) => json!({"result": result, "jsonrpc": "2.0", "id": id}),
                Err((code, message)) => {
                    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
                }
            };
            let _ = protocol.transport.send(response).await;
        });
    }

    /// The SDK's client-side checks around the module's handler: the request must parse, form
    /// mode is the only mode offered, and the answer must be a valid elicitation result.
    async fn elicit(&self, params: Option<Value>) -> Result<Value, McpError> {
        let mut request = json!({"method": "elicitation/create"});
        if let Some(params) = params {
            request["params"] = params;
        }
        let parsed = sdk::parse(&sdk::ELICIT_REQUEST, &request).map_err(|error| {
            McpError::coded(
                INVALID_PARAMS,
                format!("Invalid elicitation request: {error}"),
            )
        })?;
        if parsed["params"]["mode"] == "url" {
            return Err(McpError::coded(INVALID_PARAMS, "Client does not support URL-mode elicitation requests"));
        }
        let handler = lock(&self.elicitation).clone();
        let result = match handler {
            Some(handler) => handler(parsed).await?,
            None => json!({"action": "decline"}),
        };
        let valid = match result["action"].as_str() {
            Some("accept" | "decline" | "cancel") => result.get("content").is_none_or(|content| {
                content.is_null()
                    || content.as_object().is_some_and(|content| {
                        content.values().all(|value| {
                            value.is_string()
                                || value.is_number()
                                || value.is_boolean()
                                || value.as_array().is_some_and(|items| items.iter().all(Value::is_string))
                        })
                    })
            }),
            _ => false,
        };
        if !valid {
            return Err(McpError::coded(INVALID_PARAMS, "Invalid elicitation result"));
        }
        Ok(result)
    }

    /// Send one request and wait for its result, parsed with the SDK's shape for it.
    pub async fn request(
        &self,
        method: &str,
        params: Option<Value>,
        shape: &Shape,
        timeout: Duration,
        lifetime: Option<&CancellationToken>,
    ) -> Result<Value, McpError> {
        if lifetime.is_some_and(CancellationToken::is_cancelled) {
            return Err(McpError::plain("This operation was aborted"));
        }
        let (id, receiver) = {
            let mut state = lock(&self.state);
            if state.closed {
                return Err(McpError::plain("Not connected"));
            }
            let id = state.next_id;
            state.next_id += 1;
            let (sender, receiver) = oneshot::channel();
            state.pending.insert(id, sender);
            (id, receiver)
        };
        let mut message = json!({"method": method});
        if let Some(params) = params {
            message["params"] = params;
        }
        message["jsonrpc"] = json!("2.0");
        message["id"] = json!(id);
        let never = CancellationToken::new();
        let lifetime = lifetime.unwrap_or(&never);
        let exchange = async {
            self.transport.send(message).await?;
            receiver.await.unwrap_or_else(|_| Err(McpError::coded(CONNECTION_CLOSED, "Connection closed")))
        };
        let outcome = tokio::select! {
            outcome = exchange => outcome,
            _ = tokio::time::sleep(timeout) => {
                self.cancel(id, "McpError: MCP error -32001: Request timed out").await;
                return Err(McpError::coded(REQUEST_TIMEOUT, "Request timed out"));
            }
            _ = lifetime.cancelled() => {
                self.cancel(id, "AbortError: This operation was aborted").await;
                return Err(McpError::coded(REQUEST_TIMEOUT, "AbortError: This operation was aborted"));
            }
        };
        lock(&self.state).pending.remove(&id);
        sdk::parse(shape, &outcome?).map_err(|error| {
            McpError::plain(format!(
                "The MCP server sent an invalid {method} result: {error}"
            ))
        })
    }

    async fn cancel(&self, id: i64, reason: &str) {
        lock(&self.state).pending.remove(&id);
        let _ = self
            .transport
            .send(json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": id, "reason": reason}}))
            .await;
    }

    pub async fn notify(&self, method: &str) -> Result<(), McpError> {
        if self.is_closed() {
            return Err(McpError::plain("Not connected"));
        }
        self.transport.send(json!({"method": method, "jsonrpc": "2.0"})).await
    }

    pub async fn close(&self) {
        self.transport.close().await;
        self.closed();
    }
}
