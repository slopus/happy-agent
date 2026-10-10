use super::{
    agents::{AgentRequestError, AgentSystemModule},
    config::{ConfigModule, Document},
    cloud::{CloudModule, CloudOperationError},
    connections::{ConnectionsModule, RemoteConnectionError},
    events::{Entry, EventsModule},
    identity::now,
    lifecycle::LifecycleModule,
    live::{LiveModule, LiveSubscription},
    schemas::Schemas,
    runtime::RuntimeModule,
    secrets::SecretsModule,
    projects::ProjectsModule,
    workspaces::WorkspacesModule,
    bots::BotsModule,
    tools::ToolsModule,
    user_input::{UserInputModule,UserInputSubscription},
    auto::AutoModule,
    provider_scan::ProviderScanModule,
    owners::{NodeModule,RunnersModule},
    profile::{ProfileModule,ProfileSubscription},
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
    sync::{Arc, OnceLock},
    time::Duration,
};
use subtle::ConstantTimeEq;

type Body = UnsyncBoxBody<Bytes, anyhow::Error>;
mod secrets;
mod live;
mod metadata;
mod processes;
mod questions;
mod mutation;
mod configuration;
mod profile;
mod runners;
mod onboarding;

pub struct ApiModule {
    config: Arc<ConfigModule>,
    pub lifecycle: Arc<LifecycleModule>,
    token: OnceLock<String>,
    schemas: Schemas,
    events: Arc<EventsModule>,
    agents: Arc<AgentSystemModule>,
    runtime: Arc<RuntimeModule>,
    cloud: Arc<CloudModule>,
    connections: Arc<ConnectionsModule>,
    secrets: Arc<SecretsModule>,
    projects: Arc<ProjectsModule>,
    workspaces: Arc<WorkspacesModule>,
    bots: Arc<BotsModule>,
    live: Arc<LiveModule>,
    _live_events: LiveSubscription,
    tools: Arc<ToolsModule>,
    process_events: OnceLock<processes::ProcessEvents>,
    user_input:Arc<UserInputModule>,
    auto:Arc<AutoModule>,
    question_events:OnceLock<UserInputSubscription>,
    provider_scan:Arc<ProviderScanModule>,
    node:Arc<NodeModule>,
    profile:Arc<ProfileModule>,
    _profile_events:ProfileSubscription,
    runners:Arc<RunnersModule>,
    _runner_events:super::owners::RunnerSnapshotSubscription,
    runner_connections:std::sync::Mutex<tokio::task::JoinSet<()>>,
    runner_connection_slots:Arc<tokio::sync::Semaphore>,
}

impl ApiModule {
    pub fn new(
        config: Arc<ConfigModule>,
        lifecycle: Arc<LifecycleModule>,
        events: Arc<EventsModule>,
        agents: Arc<AgentSystemModule>,
        runtime: Arc<RuntimeModule>,
        cloud: Arc<CloudModule>,
        connections: Arc<ConnectionsModule>,
        secrets: Arc<SecretsModule>,
        projects: Arc<ProjectsModule>,
        workspaces: Arc<WorkspacesModule>,
        bots: Arc<BotsModule>,
        live: Arc<LiveModule>,
        tools: Arc<ToolsModule>,
        user_input:Arc<UserInputModule>,
        auto:Arc<AutoModule>,
        provider_scan:Arc<ProviderScanModule>,
        node:Arc<NodeModule>,
        profile:Arc<ProfileModule>,
        runners:Arc<RunnersModule>,
    ) -> anyhow::Result<Arc<Self>> {
        let journal = events.clone();
        let live_events = live.on_event(Arc::new(move |event| {
            // Local installations have one authenticated owner. Team transports
            // supply the owner audience at their public event boundary.
            if let Some(kind) = event["type"].as_str() { journal.with_journal(|journal| journal.append(kind, event["payload"].clone(), None)); }
        }))?;
        let journal=events.clone();let projector=Arc::downgrade(&profile);
        let profile_events=profile.on_event_transactional(Arc::new(move|ctx,event,snapshot|{let Some(profile)=projector.upgrade()else{return Ok(());};let mut payload=json!({"previousVersion":event["data"]["previousVersion"],"version":event["data"]["version"],"profile":profile.resource(snapshot)});mutation::apply(&mut payload);journal.publish(ctx,"profile.updated",payload,event["createdAt"].as_u64().unwrap())}))?;
        let journal=events.clone();
        let runner_events=runners.on_snapshot_transactional(Arc::new(move|ctx,snapshot|journal.publish(ctx,"runners.updated",snapshot.clone(),super::identity::now())))?;
        let module=Arc::new(Self {
            runners,
            _runner_events:runner_events,
            runner_connections:std::sync::Mutex::new(tokio::task::JoinSet::new()),
            runner_connection_slots:Arc::new(tokio::sync::Semaphore::new(256)),
            config,
            lifecycle,
            token: OnceLock::new(),
            schemas: Schemas::new()?,
            events,
            agents,
            runtime,
            cloud,
            connections,
            secrets,
            projects,
            workspaces,
            bots,
            live,
            _live_events: live_events,
            tools,
            process_events:OnceLock::new(),
            user_input,
            auto,
            question_events:OnceLock::new(),
            provider_scan,
            node,
            profile,
            _profile_events:profile_events,
        });
        module.agents.install(module.clone())?;
        module.start_process_events()?;
        module.start_question_events()?;
        Ok(module)
    }
    pub fn prepare_token(&self) -> anyhow::Result<()> {
        let token = self.config.prepare_token()?;
        self.token
            .set(token)
            .map_err(|_| anyhow::anyhow!("The API credential has already been prepared."))
    }
    pub fn begin_drain(&self) -> anyhow::Result<()> {
        // Capture the sticky transition and its journal position together with
        // stream subscriptions, so a hello cannot miss both forms of the event.
        self.events.with_journal(|journal| {
            let was_draining = self.lifecycle.is_draining();
            let result = self.lifecycle.begin_drain();
            if !was_draining {
                journal.append("daemon.draining", json!({"draining":true}), None);
            }
            result.map(|_| ())
        })
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
        if method=="GET"&&path=="/v0/runners/connect" {return Ok(self.runner_connect(request).await);}
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
            ("GET", "/v0/onboarding") => match self.onboarding_state().await {Ok(state)=>response(200,state),Err(failure)=>internal(failure)},
            ("POST", "/v0/onboarding/complete") => match self.complete_onboarding().await {Ok(state)=>response(200,state),Err(failure)=>internal(failure)},
            ("GET", "/v0/runners") => match self.runners.snapshot().await {Ok(snapshot)=>response(200,snapshot),Err(failure)=>internal(failure)},
            _ if path=="/v0/profile"||path=="/v0/profile/photo"=>self.profile_route(request).await,
            _ if path=="/v0/config"||path=="/v0/providers/scan"||path.starts_with("/v0/providers/")=>self.configuration_route(request).await,
            ("GET", "/v0/connections") => {
                let connections = self.connections.clone();
                match self.runtime.transact(move |ctx| connections.snapshot(ctx)).await { Ok(value) => response(200,value), Err(failure) => internal(failure) }
            }
            _ if path.starts_with("/v0/connections/") => self.connection(request).await,
            _ if path == "/v0/cloud" || path.starts_with("/v0/cloud/") => self.cloud(request).await,
            _ if path == "/v0/secrets" || path.starts_with("/v0/secrets/") => self.secret_route(request).await,
            _ if path == "/v0/live/sessions" || path.starts_with("/v0/live/sessions/") => self.live_route(request).await,
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
            ("POST", "/v0/agents") => match read_json(request).await {
                Ok(body) => match self.agents.create(body).await {
                    Ok(value) => response(201, value),
                    Err(failure) => internal(failure),
                },
                Err(response) => response,
            },
            _ if path.starts_with("/v0/agents/")&&(method=="GET"&&path.ends_with("/activity")||method=="DELETE"&&path.contains("/processes/"))=>self.process_route(request).await,
            _ if path.starts_with("/v0/agents/")&&(method=="GET"&&path.ends_with("/question")||method=="POST"&&path.contains("/question/"))=>self.question_route(request).await,
            _ if ["GET", "POST"].contains(&method.as_str()) && path.starts_with("/v0/agents/") => {
                self.agent(request).await
            }
            _ => error(404, "not_found", "Not found."),
        };
        Ok(result)
    }
    async fn connection(&self, request: Request<Incoming>) -> Response<Body> {
        let path = request.uri().path().to_owned();
        let Some((id, operation)) = path.strip_prefix("/v0/connections/").and_then(|path| path.split_once('/')) else { return error(404,"not_found","Not found."); };
        if !self.schemas.valid("ownerConnectionId", &json!(id)).unwrap_or(false) { return error(404,"not_found","The remote connection was not found."); }
        if operation.starts_with("api/") {
            let mut remote_path = format!("/{}", &operation[4..]);
            if let Some(query) = request.uri().query() { remote_path.push('?'); remote_path.push_str(query); }
            let id = id.to_owned();
            return match self.connections.forward(request.map(|body| body.map_err(anyhow::Error::from).boxed_unsync()), &id, &remote_path, self.lifecycle.shutdown.child_token()).await { Ok(response) => response, Err(failure) => internal(failure) };
        }
        if request.method() == hyper::Method::POST && operation == "reorder" {
            let mut values = request.headers().get_all(hyper::header::IF_MATCH).iter();
            let expected = values.next().and_then(|value| value.to_str().ok()).map(str::to_owned);
            if values.next().is_some() || !expected.as_ref().is_some_and(|value| self.schemas.valid("ownerResourceVersion", &json!(value)).unwrap_or(false)) { return error(400,"invalid_request","A valid If-Match resource version is required."); }
            let expected = expected.expect("the validated resource version");
            let id = id.to_owned();
            let body = match read_json_limited(request, 2 * 1024, false).await { Ok(body) => body, Err(response) => return response };
            let module = self.connections.clone();
            return match self.runtime.transact(move |ctx| module.reorder(ctx, &id, &body, &expected)).await { Ok(value) => response(200,value),Err(failure) => internal(failure) };
        }
        error(404,"not_found","Not found.")
    }
    async fn cloud(&self, request: Request<Incoming>) -> Response<Body> {
        let method = request.method().clone(); let path = request.uri().path().to_owned();
        if method == hyper::Method::GET && path == "/v0/cloud" { return response(200,json!({"cloud":self.cloud.status()})); }
        if self.config.team_enabled() && (path == "/v0/cloud/auth/start" || path == "/v0/cloud/auth/complete" || path == "/v0/cloud/organizations" || path.starts_with("/v0/cloud/organizations/")) { return error(501,"unsupported","Connecting or managing a Cloud account is unavailable in team mode."); }
        if method == hyper::Method::GET && path == "/v0/cloud/organizations" { return match self.cloud.list_organizations().await { Ok(organizations) => response(200,organizations), Err(failure) => internal(failure) }; }
        let (schema, optional, limit) = match (method.as_str(), path.as_str()) {
            ("POST", "/v0/cloud/auth/start") => ("cloudStartRequest",false,8 * 1024),
            ("POST", "/v0/cloud/auth/complete") => ("cloudCompleteRequest",false,8 * 1024),
            ("DELETE", "/v0/cloud/auth") | ("POST", "/v0/cloud/access-token") => ("cloudMutationRequest",true,2 * 1024),
            ("POST", "/v0/cloud/organizations") => ("cloudCreateOrganizationRequest",false,2 * 1024),
            ("DELETE", _) if path.starts_with("/v0/cloud/organizations/") => ("cloudMutationRequest",true,2 * 1024),
            _ => return error(404,"not_found","Not found."),
        };
        let body = match read_json_limited(request,limit,optional).await { Ok(body) => body, Err(response) => return response };
        if !self.schemas.valid(schema,&body).unwrap_or(false) { return error(400,"invalid_request","The Cloud request is invalid."); }
        let mutation = body.get("mutationId").cloned();
        let result = match (method.as_str(),path.as_str()) {
            ("POST","/v0/cloud/auth/start") => self.cloud.start(&body).await.map(|cloud| (200,json!({"cloud":cloud}))),
            ("POST","/v0/cloud/auth/complete") => self.cloud.complete(&body).await.map(|cloud| (200,json!({"cloud":cloud}))),
            ("DELETE","/v0/cloud/auth") => { let cloud = self.cloud.clone(); self.runtime.transact(move |ctx| cloud.disconnect(ctx, mutation.as_ref())).await.map(|cloud| (200,json!({"cloud":cloud}))) },
            ("POST","/v0/cloud/access-token") => self.cloud.mint_with_mutation(mutation).await.map(|value| (200,value)),
            ("POST","/v0/cloud/organizations") => self.cloud.create_organization_with_mutation(body["name"].as_str().expect("the validated organization name"),mutation).await.map(|organization| (201,json!({"organization":organization}))),
            ("DELETE",_) => {
                let id = path.strip_prefix("/v0/cloud/organizations/").expect("the matched organization route");
                if id.contains('/') || !self.schemas.valid("cloudOrganizationId",&json!(id)).unwrap_or(false) { return error(400,"invalid_request","The Cloud organization ID is invalid."); }
                self.cloud.delete_organization_with_mutation(id,mutation).await.map(|()| (200,json!({"deleted":true})))
            }
            _ => unreachable!("the matched Cloud operation"),
        };
        match result { Ok((status,value)) => response(status,value), Err(failure) => internal(failure) }
    }
    async fn agent(&self, request: Request<Incoming>) -> Response<Body> {
        let path = request.uri().path().to_owned();
        let parts = path
            .trim_start_matches("/v0/agents/")
            .split('/')
            .collect::<Vec<_>>();
        let id = parts[0];
        if !self.schemas.valid("cuid2", &json!(id)).unwrap_or(false) {
            return error(400, "invalid_request", "The agent identifier is invalid.");
        }
        if request.method() == "POST" {
            if !matches!(parts.as_slice(), [_, "send"]) {
                return error(404, "not_found", "Not found.");
            }
            if let Err(failure) = self.agents.assert_sendable(id.to_owned()).await {
                return internal(failure);
            }
            let body = match read_json(request).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            return match self.agents.send(id.to_owned(), body).await {
                Ok(value) => response(202, value),
                Err(failure) => internal(failure),
            };
        }
        let result = match parts.as_slice() {
            [_] => self.agents.focused(id.to_owned()).await,
            [_, "mode"] => self.agents.mode(id.to_owned()).await,
            [_, "usage"] => self.agents.usage(id.to_owned()).await,
            [_, "messages"] => {
                let query = Query::new(&request);
                let value: Value = query
                    .0
                    .iter()
                    .map(|(key, value)| (key.clone(), json!(value)))
                    .collect();
                if !self.schemas.valid("historyQuery", &value).unwrap_or(false) {
                    return error(400, "invalid_request", "The history query is invalid.");
                }
                if query.get("before").is_some() && query.get("after").is_some() {
                    return error(
                        400,
                        "invalid_request",
                        "Choose either a before or an after history cursor.",
                    );
                }
                let limit = match query.get("limit") {
                    None => 50,
                    Some(value) => match value.parse::<usize>() {
                        Ok(value)
                            if self
                                .schemas
                                .valid("historyLimit", &json!(value))
                                .unwrap_or(false) =>
                        {
                            value
                        }
                        _ => {
                            return error(
                                400,
                                "invalid_request",
                                "The history limit must be between 1 and 500.",
                            );
                        }
                    },
                };
                let omit = match query.get("omitToolData") {
                    None | Some("false") => false,
                    Some("true") => true,
                    _ => {
                        return error(
                            400,
                            "invalid_request",
                            "The tool data option must be true or false.",
                        );
                    }
                };
                self.agents
                    .messages(
                        id.to_owned(),
                        query.get("before").map(str::to_owned),
                        query.get("after").map(str::to_owned),
                        limit,
                        omit,
                    )
                    .await
            }
            _ => return error(404, "not_found", "Not found."),
        };
        match result {
            Ok(Some(value)) => response(200, value),
            Ok(None) => error(404, "not_found", "The agent was not found."),
            Err(failure) => internal(failure),
        }
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
                self.events.with_journal(|journal| {
                    journal.append("config.updated", payload, None);
                });
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
        self.events.with_journal(|journal|match journal.replay(after, until, limit, None) {
            Some(page) => response(200, page),
            None => response(
                409,
                json!({"error":"Event cursor is unavailable.","code":"cursor_unavailable","cursor":journal.cursor()}),
            ),
        })
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
        let (hello, replay, receiver) = self.events.with_journal(|journal|{
            let (cursor, gap, replay, receiver) = journal.subscribe(after);
            let hello = json!({"cursor":cursor,"gap":gap,"resumed":after.is_some()&&!gap,"connectedAt":now(),
                "daemonId":self.lifecycle.daemon_id(),"daemonStartedAt":self.lifecycle.started_at(),"draining":self.lifecycle.is_draining()});
            (
                Bytes::from(format!("event: hello\ndata: {hello}\n\n")),
                replay,
                receiver,
            )
        });
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
                return Some((Ok::<_, anyhow::Error>(Frame::data(hello)), state));
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
    read_json_limited(request,48 * 1024 * 1024,false).await
}
async fn read_json_limited(request: Request<Incoming>, limit: usize, optional: bool) -> Result<Value, Response<Body>> {
    let body = tokio::time::timeout(
        Duration::from_secs(30),
        Limited::new(request.into_body(), limit).collect(),
    )
    .await;
    match body {
        Ok(Ok(body)) => { let body = body.to_bytes(); if optional && body.is_empty() { return Ok(json!({})); } serde_json::from_slice(&body).map_err(|_| {
            error(
                400,
                "invalid_request",
                "The request body must contain valid JSON.",
            )
        }) },
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
    let mut response = Response::new(Full::new(Bytes::from(value.to_string())).map_err(|never| match never {}).boxed_unsync());
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
    if let Some(failure) = failure.downcast_ref::<super::live::LiveError>() {
        let mut value = json!({"error":failure.message,"code":failure.code});
        if let Some(session) = &failure.session { value["session"] = session.clone(); }
        return response(failure.status,value);
    }
    if let Some(failure) = failure.downcast_ref::<CloudOperationError>() {
        return response(failure.status,json!({"error":failure.message,"code":failure.code,"cloud":failure.cloud}));
    }
    if let Some(failure) = failure.downcast_ref::<RemoteConnectionError>() {
        let mut value = json!({"error":failure.message,"code":failure.code});
        if let Some(current) = &failure.current { value["currentVersion"] = current["version"].clone(); value["connections"] = current["connections"].clone(); }
        return response(failure.status,value);
    }
    if let Some(failure) = failure.downcast_ref::<AgentRequestError>() {
        return error(failure.status, failure.code, failure.message);
    }
    eprintln!("API request failed: {failure:#}");
    error(500, "internal", "An internal error occurred.")
}
