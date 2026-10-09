use super::{
    config::{ConfigModule, Document},
    identity::now,
    journal::{Entry, Journal},
    lifecycle::LifecycleModule,
    runtime::RuntimeModule,
    schemas::Schemas,
};
use bytes::Bytes;
use futures_util::stream;
use http_body_util::{BodyExt, Full, Limited, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Request, Response, StatusCode,
    body::{Frame, Incoming},
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    convert::Infallible,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use subtle::ConstantTimeEq;

type Body = UnsyncBoxBody<Bytes, Infallible>;

pub struct ApiModule {
    config: Arc<ConfigModule>,
    pub lifecycle: Arc<LifecycleModule>,
    token: OnceLock<String>,
    runtime: OnceLock<Arc<Mutex<RuntimeModule>>>,
    schemas: Schemas,
    journal: Mutex<Journal>,
}

impl ApiModule {
    pub fn new(config: Arc<ConfigModule>, lifecycle: Arc<LifecycleModule>) -> anyhow::Result<Self> {
        Ok(Self {
            config,
            lifecycle,
            token: OnceLock::new(),
            runtime: OnceLock::new(),
            schemas: Schemas::new()?,
            journal: Mutex::new(Journal::new()),
        })
    }
    pub fn prepare_token(&self) -> anyhow::Result<()> {
        let token = self.config.prepare_token()?;
        self.token
            .set(token)
            .map_err(|_| anyhow::anyhow!("The API credential has already been prepared."))
    }
    pub fn start(&self, runtime: Arc<Mutex<RuntimeModule>>) {
        let _ = self.runtime.set(runtime);
    }
    pub async fn close_runtime(&self) -> anyhow::Result<()> {
        if let Some(runtime) = self.runtime.get() {
            let runtime = runtime.clone();
            tokio::task::spawn_blocking(move || {
                runtime
                    .lock()
                    .map_err(|_| anyhow::anyhow!("The runtime database lock is unavailable."))?
                    .close()
            })
            .await??;
        }
        Ok(())
    }
    pub fn begin_drain(&self) -> anyhow::Result<()> {
        // Capture the sticky transition and its journal position together with
        // stream subscriptions, so a hello cannot miss both forms of the event.
        let mut journal = self
            .journal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let was_draining = self.lifecycle.is_draining();
        let result = self.lifecycle.begin_drain();
        if !was_draining {
            journal.append("daemon.draining", json!({"draining":true}), None);
        }
        result.map(|_| ())
    }
    fn authorized(&self, request: &Request<Incoming>) -> bool {
        let mut headers = request
            .headers()
            .get_all(hyper::header::AUTHORIZATION)
            .iter();
        let Some(header) = headers.next() else {
            return false;
        };
        if headers.next().is_some() {
            return false;
        }
        let Some(supplied) = header
            .to_str()
            .ok()
            .and_then(|header| header.strip_prefix("Bearer "))
        else {
            return false;
        };
        let Some(token) = self.token.get() else {
            return false;
        };
        supplied.len() == token.len() && bool::from(supplied.as_bytes().ct_eq(token.as_bytes()))
    }
    pub async fn handle(
        self: Arc<Self>,
        request: Request<Incoming>,
    ) -> Result<Response<Body>, Infallible> {
        let method = request.method().as_str().to_owned();
        let path = request.uri().path().to_owned();
        let authorized = self.authorized(&request);
        if method == "GET" && path == "/v0/authentication" {
            return Ok(response(
                200,
                json!({"authenticated":authorized,"userId":null,"methods":[]}),
            ));
        }
        if !authorized {
            return Ok(error(401, "unauthorized", "Unauthorized"));
        }
        if method == "GET" && path == "/v0/health" {
            return Ok(response(200, self.lifecycle.health()));
        }
        if !self.lifecycle.is_ready() {
            return Ok(error(
                503,
                "not_initialized",
                "Happy Agent is still starting.",
            ));
        }
        let mutating = !(["GET", "HEAD", "OPTIONS"].contains(&method.as_str())
            || method == "POST" && ["/v0/drain", "/v0/shutdown"].contains(&path.as_str()));
        // Admission precedes reading the body. Accepted requests remain owned
        // by drain until their mutation and event publication have completed.
        let _mutation = if mutating {
            let Some(mutation) = self.lifecycle.admit_mutation() else {
                return Ok(error(
                    503,
                    "draining",
                    "Happy Agent is draining and no longer accepts mutations.",
                ));
            };
            Some(mutation)
        } else {
            None
        };
        let result = match (method.as_str(), path.as_str()) {
            ("GET", "/") => response(200, json!({"text":"Welcome to Happy Agent!"})),
            ("POST", "/v0/drain") => match self.begin_drain() {
                Ok(()) => response(202, json!({"draining":true,"pid":std::process::id()})),
                Err(failure) => internal(failure),
            },
            ("POST", "/v0/shutdown") => {
                self.lifecycle.begin_shutdown();
                response(202, json!({"shuttingDown":true,"pid":std::process::id()}))
            }
            ("POST" | "DELETE", "/v0/debug/inspector") => {
                error(409, "conflict", "This daemon cannot start a debugger.")
            }
            ("GET" | "PUT", "/v0/config/instructions") => {
                self.document(request, Document::Instructions).await
            }
            ("GET" | "PUT", "/v0/config/security") => {
                self.document(request, Document::Security).await
            }
            ("GET", "/v0/events") => self.events(&request),
            ("GET", "/v0/events/stream") => self.event_stream(&request),
            _ => error(404, "not_found", "Not found."),
        };
        Ok(result)
    }
    async fn document(&self, request: Request<Incoming>, document: Document) -> Response<Body> {
        if request.method() == "GET" {
            return match self.config.read_document(document).await {
                Ok(text) => response(200, json!({document.field():text})),
                Err(failure) => internal(failure),
            };
        }
        let value = match read_json(request).await {
            Ok(value) => value,
            Err(result) => return result,
        };
        match self.schemas.valid(document.schema(), &value) {
            Ok(true) => {}
            Ok(false) => return error(400, "invalid_request", "The document request is invalid."),
            Err(failure) => return internal(failure),
        }
        let text = value[document.field()].as_str().unwrap_or("");
        if text.len() > document.limit() {
            return error(
                400,
                "invalid_request",
                "The document exceeds its allowed byte size.",
            );
        }
        match self.config.write_document(document, text.to_owned()).await {
            Ok(text) => {
                let payload = if let Some(id) = value.get("mutationId") {
                    json!({"mutationId":id})
                } else {
                    json!({})
                };
                self.journal
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .append("config.updated", payload, None);
                response(200, json!({document.field():text}))
            }
            Err(failure) => internal(failure),
        }
    }
    fn events(&self, request: &Request<Incoming>) -> Response<Body> {
        let query = Query::new(request);
        let after = query.get("after");
        let until = query.get("until");
        if !self.valid_cursor(after) || !self.valid_cursor(until) {
            return error(400, "invalid_request", "The event cursor is invalid.");
        }
        let limit = match query.get("limit") {
            None => 100,
            Some(value)
                if self
                    .schemas
                    .valid("eventLimitText", &json!(value))
                    .unwrap_or(false) =>
            {
                match value.parse::<usize>() {
                    Ok(limit)
                        if self
                            .schemas
                            .valid("eventLimit", &json!(limit))
                            .unwrap_or(false) =>
                    {
                        limit
                    }
                    _ => {
                        return error(
                            400,
                            "invalid_request",
                            "The event limit must be between 1 and 10000.",
                        );
                    }
                }
            }
            Some(_) => {
                return error(
                    400,
                    "invalid_request",
                    "The event limit must be between 1 and 10000.",
                );
            }
        };
        let journal = self
            .journal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match journal.replay(after, until, limit, None) {
            Some(page) => response(200, page),
            None => response(
                409,
                json!({"error":"Event cursor is unavailable.","code":"cursor_unavailable","cursor":journal.cursor()}),
            ),
        }
    }
    fn valid_cursor(&self, cursor: Option<&str>) -> bool {
        cursor.is_none_or(|cursor| {
            self.schemas
                .valid("cursor", &json!(cursor))
                .unwrap_or(false)
        })
    }
    fn event_stream(&self, request: &Request<Incoming>) -> Response<Body> {
        let query = Query::new(request);
        let after = query.get("after").or_else(|| {
            request
                .headers()
                .get("Last-Event-ID")
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty())
        });
        if !self.valid_cursor(after) {
            return error(400, "invalid_request", "The event cursor is invalid.");
        }
        let (hello, replay, receiver) = {
            let journal = self
                .journal
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let (cursor, gap, replay, receiver) = journal.subscribe(after);
            let hello = json!({"cursor":cursor,"gap":gap,"resumed":after.is_some()&&!gap,"connectedAt":now(),
                "daemonId":self.lifecycle.daemon_id(),"daemonStartedAt":self.lifecycle.started_at(),"draining":self.lifecycle.is_draining()});
            (
                Bytes::from(format!("event: hello\ndata: {hello}\n\n")),
                replay,
                receiver,
            )
        };
        let state = StreamState {
            hello: Some(hello),
            replay,
            receiver,
            heartbeat: tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(15),
                Duration::from_secs(15),
            ),
            shutdown: self.lifecycle.shutdown.clone(),
        };
        let frames = stream::unfold(state, |mut state| async move {
            if let Some(hello) = state.hello.take() {
                return Some((Ok::<_, Infallible>(Frame::data(hello)), state));
            }
            loop {
                if state.shutdown.is_cancelled() {
                    return None;
                }
                if let Some(entry) = state.replay.pop_front() {
                    if entry.visible_to(None) {
                        return Some((Ok(Frame::data(event_frame(&entry))), state));
                    }
                    continue;
                }
                tokio::select! {
                    biased;
                    _=state.shutdown.cancelled()=>return None,
                    entry=state.receiver.recv()=>match entry {
                        Ok(entry) if entry.visible_to(None)=>return Some((Ok(Frame::data(event_frame(&entry))),state)),
                        Ok(_)=>continue,
                        // A slow reader must reconnect from its last delivered
                        // cursor; silently skipping a lagged window loses events.
                        Err(_)=>return None,
                    },
                    _=state.heartbeat.tick()=>return Some((Ok(Frame::data(Bytes::from_static(b": heartbeat\n\n"))),state)),
                }
            }
        });
        let mut response = Response::new(StreamBody::new(frames).boxed_unsync());
        response.headers_mut().insert(
            hyper::header::CONTENT_TYPE,
            hyper::header::HeaderValue::from_static("text/event-stream; charset=utf-8"),
        );
        response.headers_mut().insert(
            hyper::header::CACHE_CONTROL,
            hyper::header::HeaderValue::from_static("no-store"),
        );
        response
    }
}

struct Query(Vec<(String, String)>);
impl Query {
    fn new(request: &Request<Incoming>) -> Self {
        Self(
            form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
                .into_owned()
                .collect(),
        )
    }
    fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }
}
struct StreamState {
    hello: Option<Bytes>,
    replay: VecDeque<Arc<Entry>>,
    receiver: tokio::sync::broadcast::Receiver<Arc<Entry>>,
    heartbeat: tokio::time::Interval,
    shutdown: tokio_util::sync::CancellationToken,
}
fn event_frame(entry: &Entry) -> Bytes {
    Bytes::from(format!(
        "id: {}\nevent: {}\ndata: {}\n\n",
        entry.cursor(),
        entry.envelope["type"].as_str().unwrap_or(""),
        entry.envelope
    ))
}
async fn read_json(request: Request<Incoming>) -> Result<Value, Response<Body>> {
    let body = tokio::time::timeout(
        Duration::from_secs(30),
        Limited::new(request.into_body(), 48 * 1024 * 1024).collect(),
    )
    .await;
    match body {
        Ok(Ok(body)) => serde_json::from_slice(&body.to_bytes()).map_err(|_| {
            error(
                400,
                "invalid_request",
                "The request body must contain valid JSON.",
            )
        }),
        Ok(Err(_)) => Err(error(
            400,
            "invalid_request",
            "The request body is too large or incomplete.",
        )),
        Err(_) => Err(error(
            400,
            "invalid_request",
            "The request body did not finish in time.",
        )),
    }
}
fn response(status: u16, value: Value) -> Response<Body> {
    let mut response = Response::new(Full::new(Bytes::from(value.to_string())).boxed_unsync());
    *response.status_mut() =
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response.headers_mut().insert(
        hyper::header::CACHE_CONTROL,
        hyper::header::HeaderValue::from_static("no-store"),
    );
    response
}
fn error(status: u16, code: &str, message: &str) -> Response<Body> {
    response(status, json!({"error":message,"code":code}))
}
fn internal(failure: anyhow::Error) -> Response<Body> {
    eprintln!("API request failed: {failure:#}");
    error(500, "internal", "An internal error occurred.")
}
