//! Real HTTP acceptance of the native public Secrets boundary.
use super::*;
use crate::product::{
    agent_runtime::AgentRuntimeModule,
    auto::AutoModule,
    bots::BotsModule,
    cloud::CloudModule,
    connections::ConnectionsModule,
    history::HistoryModule,
    live::LiveModule,
    owners::{AbortModule, Fixture, GitModule, RunnersModule},
    permissions::PermissionsModule,
    secrets::SecretsModule,
    services::ServicesModule,
    tailcat::TailcatModule,
    titles::TitlesModule,
    tools::ToolsModule,
    usage::UsageModule,
};
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::{
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;

struct Graph {
    fixture: Fixture,
    api: Arc<ApiModule>,
    agents: Arc<AgentRuntimeModule>,
    runners: Arc<RunnersModule>,
    git: Arc<GitModule>,
    services: Arc<ServicesModule>,
    cloud: Arc<CloudModule>,
    connections: Arc<ConnectionsModule>,
    tailcat: Arc<TailcatModule>,
    url: String,
    token: String,
    client: reqwest::Client,
    cancel: CancellationToken,
    server: Option<JoinHandle<()>>,
}
impl Graph {
    async fn new() -> Self {
        Self::install(Fixture::new().await).await
    }
    async fn install(fixture: Fixture) -> Self {
        let usage = Arc::new(
            UsageModule::new(
                fixture.runtime.clone(),
                fixture.events.clone(),
                fixture.config.clone(),
            )
            .unwrap(),
        );
        usage.load().await.unwrap();
        let history = Arc::new(
            HistoryModule::new(
                fixture.config.clone(),
                fixture.runtime.clone(),
                fixture.events.clone(),
                usage.clone(),
            )
            .unwrap(),
        );
        history.load().await.unwrap();
        let secrets = SecretsModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            fixture.events.clone(),
        )
        .unwrap();
        secrets.load().await.unwrap();
        let services = ServicesModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            fixture.lifecycle.clone(),
            fixture.events.clone(),
        )
        .unwrap();
        services.load().await.unwrap();
        let runners=RunnersModule::new(fixture.config.clone(),fixture.runtime.clone(),fixture.lifecycle.clone()).unwrap();runners.load().await.unwrap();
        let tools = Arc::new(
            ToolsModule::new(
                fixture.config.clone(),
                history.clone(),
                fixture.lifecycle.clone(),
                fixture.runtime.clone(),
                secrets.clone(),
                services.clone(),
                fixture.events.clone(),
                runners.clone(),
            )
            .unwrap(),
        );
        let auto = AutoModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            tools.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        auto.load().await.unwrap();
        let permissions = Arc::new(
            PermissionsModule::new(auto.clone(), fixture.runtime.clone(), history.clone()).unwrap(),
        );
        let agents = Arc::new(AgentRuntimeModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            history.clone(),
            tools.clone(),
            usage.clone(),
            fixture.lifecycle.clone(),
            auto.clone(),
            permissions,
            fixture.events.clone(),
        ));
        agents.install(secrets.clone()).unwrap();
        let git = GitModule::new(fixture.config.clone(), runners.clone()).unwrap();
        let abort = AbortModule::new(
            fixture.runtime.clone(),
            agents.clone(),
            tools.clone(),
            services.clone(),
        );
        let projects = ProjectsModule::install(
            fixture.config.clone(),
            fixture.runtime.clone(),
            git.clone(),
            abort.clone(),
            fixture.durable.clone(),
            runners.clone(),
            services.clone(),
            fixture.events.clone(),
        )
        .unwrap();
        projects.load().await.unwrap();
        let workspaces = WorkspacesModule::install(
            fixture.config.clone(),
            fixture.runtime.clone(),
            projects.clone(),
            git.clone(),
            abort.clone(),
            fixture.durable.clone(),
            runners.clone(),
            services.clone(),
            fixture.events.clone(),
        )
        .unwrap();
        workspaces.load().await.unwrap();
        let titles = TitlesModule::new(
            fixture.config.clone(),
            fixture.durable.clone(),
            fixture.lifecycle.clone(),
            fixture.runtime.clone(),
            agents.clone(),
            history.clone(),
            workspaces.clone(),
        )
        .unwrap();
        let bots = BotsModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            agents.clone(),
            abort,
            titles,
            projects.clone(),
            workspaces.clone(),
            runners.clone(),
            fixture.durable.clone(),
            fixture.events.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        bots.load().await.unwrap();
        let cloud = CloudModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            fixture.lifecycle.clone(),
            fixture.events.clone(),
        )
        .unwrap();
        cloud.load().await.unwrap();
        let tailcat = TailcatModule::new(
            fixture.config.clone(),
            bots.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            agents.clone(),
        )
        .unwrap();
        let connections = ConnectionsModule::new(
            fixture.config.clone(),
            bots.clone(),
            cloud.clone(),
            tailcat.clone(),
            fixture.durable.clone(),
            fixture.runtime.clone(),
            fixture.events.clone(),
            agents.clone(),
        )
        .unwrap();
        connections.load().await.unwrap();
        let live = LiveModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            agents.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        live.load().await.unwrap();
        let presence=crate::product::presence::PresenceModule::new(fixture.config.clone(),fixture.runtime.clone(),fixture.durable.clone(),fixture.lifecycle.clone(),agents.clone()).unwrap();presence.load().await.unwrap();
        let user_input=crate::product::user_input::UserInputModule::new(presence,fixture.runtime.clone(),fixture.durable.clone(),agents.clone(),fixture.lifecycle.clone()).unwrap();user_input.load().await.unwrap();
        let public_agents = Arc::new(
            AgentSystemModule::new(
                fixture.config.clone(),
                fixture.runtime.clone(),
                fixture.events.clone(),
                history,
                usage,
                projects.clone(),
                workspaces.clone(),
                agents.clone(),
                tools.clone(),
                user_input.clone(),
            )
            .unwrap(),
        );
        let api = ApiModule::new(
            fixture.config.clone(),
            fixture.lifecycle.clone(),
            fixture.events.clone(),
            public_agents,
            fixture.runtime.clone(),
            cloud.clone(),
            connections.clone(),
            secrets,
            projects,
            workspaces,
            bots,
            live,
            tools,
            user_input,
            auto,
            crate::product::provider_scan::ProviderScanModule::new(fixture.config.clone(),fixture.durable.clone(),fixture.lifecycle.clone()).unwrap(),
            fixture.node.clone(),
        )
        .unwrap();
        agents.prepare().unwrap();
        agents.load().await.unwrap();
        api.prepare_token().unwrap();
        let token = fixture.config.prepare_token().unwrap();
        fixture.lifecycle.ready().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind native API fixture");
        let url = format!("http://{}", listener.local_addr().unwrap());
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let owner = api.clone();
        let server = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {_=stop.cancelled()=>break,result=listener.accept()=>{let Ok((socket,_))=result else{break;};if connections.len()>=128{continue;}let owner=owner.clone();connections.spawn(async move{let service=service_fn(move|request|owner.clone().handle(request));let _=hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(socket),service).await;});},_=connections.join_next(),if !connections.is_empty()=>{}}
            }
            connections.abort_all();
            while connections.join_next().await.is_some() {}
        });
        Self {
            fixture,
            api,
            agents,
            runners,
            git,
            services,
            cloud,
            connections,
            tailcat,
            url,
            token,
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
            cancel,
            server: Some(server),
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        version: Option<&str>,
    ) -> (u16, Value) {
        let mut request = self
            .client
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
                format!("{}{path}", self.url),
            )
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(version) = version {
            request = request.header("If-Match", version);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let body = response.json().await.unwrap();
        (status, body)
    }
    async fn create(&self, id: &str) -> Value {
        let(status,body)=self.request("POST","/v0/secrets",Some(json!({"id":id,"description":" fixture ","environment":{"Token":"http-private-value"},"mutationId":"create-echo"})),None).await;
        assert_eq!(status, 201, "{body}");
        body["secret"].clone()
    }
    async fn events(&self) -> Vec<Value> {
        let (status, body) = self
            .request("GET", "/v0/events?limit=10000", None, None)
            .await;
        assert_eq!(status, 200);
        body["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["type"].as_str().unwrap().starts_with("secret."))
            .cloned()
            .collect()
    }
    async fn project(&self) -> String {
        let id = cuid2::create_id();
        let project = json!({"id":id,"repositoryRef":self.fixture.directory.path(),"kind":"home","storageKey":"http-project","name":"HTTP fixture","nameSource":"folder","status":"active","presence":"present","initializationStatus":"ready","initializationAttempt":0,"worktreeSupport":"unknown","gitAhead":0,"gitBehind":0,"gitDetached":false,"orderKey":"500","version":1,"createdAt":100,"updatedAt":100});
        let owner = self.api.projects.clone();
        self.fixture
            .runtime
            .transact(move |ctx| owner.register(ctx, &project))
            .await
            .unwrap();
        id
    }
    async fn agent(&self, project: &str) -> String {
        let (status, body) = self
            .request(
                "POST",
                "/v0/agents",
                Some(json!({"workspaceId":project,"title":"HTTP fixture agent"})),
                None,
            )
            .await;
        assert_eq!(status, 201, "{body}");
        body["agent"]["id"].as_str().unwrap().to_owned()
    }
    async fn close(&mut self) {
        self.cancel.cancel();
        if let Some(server) = self.server.take() {
            tokio::time::timeout(Duration::from_secs(2), server)
                .await
                .unwrap()
                .unwrap();
        }
        self.fixture.lifecycle.begin_shutdown();
        self.fixture.durable.stop().await;
        self.agents.close().await;
        self.connections.close().await.unwrap();
        self.tailcat.close().await.unwrap();
        self.cloud.close().await.unwrap();
        self.services.close().await.unwrap();
        self.runners.close().await;
        self.git.close().await;
        self.fixture.close().await;
    }
    async fn restart(mut self) -> Self {
        self.close().await;
        let mut fixture = self.fixture;
        fixture.restart().await;
        Self::install(fixture).await
    }
}

#[tokio::test]
async fn native_http_secret_create_read_list_rotation_events_and_restart() {
    let mut graph = Graph::new().await;
    let original = graph.create("http-token").await;
    assert_eq!(original["description"], "fixture");
    assert!(!original.to_string().contains("http-private-value"));
    assert_eq!(
        graph
            .request("GET", "/v0/secrets/http-token", None, None)
            .await,
        (200, json!({"secret":original}))
    );
    let (status, list) = graph
        .request("GET", "/v0/secrets?limit=1", None, None)
        .await;
    assert_eq!(status, 200);
    assert_eq!(list, json!({"secrets":[original],"nextCursor":null}));
    let (status, rotated) = graph
        .request(
            "PATCH",
            "/v0/secrets/http-token",
            Some(
                json!({"environment":{"TOKEN":"http-rotated-value"},"mutationId":"rotation-echo"}),
            ),
            original["version"].as_str(),
        )
        .await;
    assert_eq!(status, 200);
    let rotated = rotated["secret"].clone();
    assert!(rotated["version"].as_str() > original["version"].as_str());
    assert_eq!(rotated["environmentVariables"], json!(["Token"]));
    let events = graph.events().await;
    assert_eq!(
        events
            .iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["secret.created", "secret.updated"]
    );
    assert_eq!(
        events[0]["payload"],
        json!({"secret":original,"mutationId":"create-echo"})
    );
    assert_eq!(
        events[1]["payload"],
        json!({"secretId":"http-token","previousVersion":original["version"],"version":rotated["version"],"changes":{"updatedAt":rotated["updatedAt"]},"mutationId":"rotation-echo"})
    );
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("http-private-value")
    );
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("http-rotated-value")
    );
    graph = graph.restart().await;
    assert_eq!(
        graph
            .request("GET", "/v0/secrets/http-token", None, None)
            .await,
        (200, json!({"secret":rotated}))
    );
    graph.close().await;
}
#[tokio::test]
async fn native_http_secret_version_conflicts_and_noops_emit_only_committed_changes() {
    let mut graph = Graph::new().await;
    let original = graph.create("http-token").await;
    let before = graph.events().await;
    let (status, missing) = graph
        .request(
            "PATCH",
            "/v0/secrets/http-token",
            Some(json!({"description":"change"})),
            None,
        )
        .await;
    assert_eq!(status, 400);
    assert_eq!(missing["code"], "invalid_request");
    let (status, same) = graph
        .request(
            "PATCH",
            "/v0/secrets/http-token",
            Some(json!({"description":"fixture","environment":{"TOKEN":"http-private-value"}})),
            original["version"].as_str(),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(same["secret"], original);
    assert_eq!(graph.events().await, before);
    let (status, current) = graph
        .request(
            "PATCH",
            "/v0/secrets/http-token",
            Some(json!({"description":"updated"})),
            original["version"].as_str(),
        )
        .await;
    assert_eq!(status, 200);
    let current = current["secret"].clone();
    let (status, stale) = graph
        .request(
            "PATCH",
            "/v0/secrets/http-token",
            Some(json!({"environment":{"Token":"rejected-private-value"}})),
            original["version"].as_str(),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(stale["code"], "conflict");
    assert_eq!(stale["currentVersion"], current["version"]);
    assert_eq!(stale["secret"], current);
    let(status,collision)=graph.request("POST","/v0/secrets",Some(json!({"id":"http-token","description":"collision","environment":{"TOKEN":"rejected-private-value"}})),None).await;
    assert_eq!(status, 409);
    assert_eq!(collision["secret"], current);
    assert!(!collision.to_string().contains("rejected-private-value"));
    assert_eq!(graph.events().await.len(), 2);
    assert_eq!(
        graph
            .request("GET", "/v0/secrets/http-token", None, None)
            .await
            .1["secret"],
        current
    );
    graph.close().await;
}
#[tokio::test]
async fn native_http_secret_grants_keep_typed_identity_idempotence_and_mutation_echo() {
    let mut graph = Graph::new().await;
    let secret = graph.create("http-token").await;
    let project = graph.project().await;
    let agent = graph.agent(&project).await;
    let mut grants = Vec::new();
    for (kind, id) in [
        ("project", project.as_str()),
        ("workspace", project.as_str()),
        ("agent", agent.as_str()),
    ] {
        let path = format!("/v0/secrets/http-token/attachments/{kind}/{id}");
        let (status, created) = graph
            .request("PUT", &path, Some(json!({"mutationId":"grant-echo"})), None)
            .await;
        assert_eq!(status, 201, "{created}");
        assert_eq!(created["created"], true);
        grants.push(created["attachment"].clone());
        let count = graph.events().await.len();
        let (status, same) = graph.request("PUT", &path, None, None).await;
        assert_eq!(status, 200);
        assert_eq!(
            same,
            json!({"attachment":created["attachment"],"created":false})
        );
        assert_eq!(graph.events().await.len(), count);
        let (status, filtered) = graph
            .request(
                "GET",
                &format!("/v0/secrets?targetType={kind}&targetId={id}"),
                None,
                None,
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(filtered["secrets"].as_array().unwrap().len(), 1);
    }
    assert_ne!(grants[0]["id"], grants[1]["id"]);
    let count = graph.events().await.len();
    let (status, disabled) = graph
        .request(
            "PATCH",
            "/v0/secrets/http-token",
            Some(json!({"availableToAgents":false})),
            secret["version"].as_str(),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(disabled["secret"], secret);
    assert_eq!(graph.events().await.len(), count);
    let (status, page) = graph
        .request(
            "GET",
            "/v0/secrets/http-token/attachments?limit=1",
            None,
            None,
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(page["attachments"], json!([grants[0]]));
    assert_eq!(page["nextCursor"], grants[0]["id"]);
    let path = format!("/v0/secrets/http-token/attachments/agent/{agent}");
    let (status, detached) = graph
        .request(
            "DELETE",
            &path,
            Some(json!({"mutationId":"detach-echo"})),
            None,
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(detached, json!({"detached":true,"attachment":grants[2]}));
    let count = graph.events().await.len();
    assert_eq!(
        graph.request("DELETE", &path, None, None).await,
        (200, json!({"detached":false,"attachment":null}))
    );
    assert_eq!(graph.events().await.len(), count);
    let events = graph.events().await;
    assert_eq!(
        events.last().unwrap()["payload"],
        json!({"attachment":grants[2],"mutationId":"detach-echo"})
    );
    graph.close().await;
}
#[tokio::test]
async fn native_http_secret_archive_guards_reject_new_grants_but_allow_detachment() {
    let mut graph = Graph::new().await;
    graph.create("http-token").await;
    let project = graph.project().await;
    let agent = graph.agent(&project).await;
    let path = format!("/v0/secrets/http-token/attachments/agent/{agent}");
    assert_eq!(graph.request("PUT", &path, None, None).await.0, 201);
    let owner = graph.agents.clone();
    let id = agent.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| owner.update_metadata(ctx, &id, &json!({"archivedAt":123})))
        .await
        .unwrap();
    let count = graph.events().await.len();
    let (status, rejected) = graph.request("PUT", &path, None, None).await;
    assert_eq!(status, 409);
    assert_eq!(rejected["code"], "conflict");
    assert_eq!(graph.events().await.len(), count);
    assert_eq!(graph.request("DELETE", &path, None, None).await.0, 200);
    let unknown = cuid2::create_id();
    assert_eq!(
        graph
            .request(
                "PUT",
                &format!("/v0/secrets/http-token/attachments/project/{unknown}"),
                None,
                None
            )
            .await
            .0,
        404
    );
    let root = graph.api.projects.clone();
    let archived = project.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| root.archive(ctx, &project))
        .await
        .unwrap();
    let count = graph.events().await.len();
    for kind in ["project", "workspace"] {
        let path = format!("/v0/secrets/http-token/attachments/{kind}/{archived}");
        assert_eq!(graph.request("PUT", &path, None, None).await.0, 409);
        assert_eq!(
            graph.request("DELETE", &path, None, None).await,
            (200, json!({"detached":false,"attachment":null}))
        );
    }
    assert_eq!(graph.events().await.len(), count);
    let project_id = graph
        .request("GET", "/v0/secrets/http-token", None, None)
        .await
        .1;
    assert_eq!(project_id["secret"]["id"], "http-token");
    graph.close().await;
}
#[tokio::test]
async fn native_http_secret_invalid_queries_inputs_and_attachment_bodies_have_no_effect() {
    let mut graph = Graph::new().await;
    let record = graph.create("http-token").await;
    let count = graph.events().await.len();
    for path in [
        "/v0/secrets?limit=0",
        "/v0/secrets?limit=101",
        "/v0/secrets?limit=01",
        "/v0/secrets?limit=1.0",
        "/v0/secrets?targetType=project",
        "/v0/secrets?cursor=unknown",
        "/v0/secrets?unexpected=yes",
        "/v0/secrets/%ZZ",
        "/v0/secrets/http-token/attachments?cursor=unknown",
    ] {
        let (status, body) = graph.request("GET", path, None, None).await;
        assert_eq!(status, 400, "{path}: {body}");
        assert_eq!(body["code"], "invalid_request");
    }
    for (input, expected) in [
        (json!({"environment":{"TOKEN":"one","token":"two"}}), 400),
        (json!({"environment":{"Token":null}}), 409),
        (json!({"environment":{"TOKEN":"a".repeat(65537)}}), 400),
        (json!({"description":"   "}), 400),
        (json!({"mutationId":"only-echo"}), 400),
    ] {
        let (status, body) = graph
            .request(
                "PATCH",
                "/v0/secrets/http-token",
                Some(input),
                record["version"].as_str(),
            )
            .await;
        assert_eq!(status, expected, "{body}");
    }
    let project = graph.project().await;
    let target = format!("/v0/secrets/http-token/attachments/project/{project}");
    let response = graph
        .client
        .put(format!("{}{target}", graph.url))
        .bearer_auth(&graph.token)
        .body(" ".repeat(2049))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 400);
    assert_eq!(graph.events().await.len(), count);
    assert_eq!(
        graph
            .request("GET", "/v0/secrets/http-token", None, None)
            .await
            .1["secret"],
        record
    );
    graph.close().await;
}

#[tokio::test]
async fn native_http_secret_two_client_races_and_reused_mutation_ids_preserve_single_effects() {
    let mut graph = Graph::new().await;
    let original = graph.create("http-token").await;
    let (left, right) = tokio::join!(
        graph.request(
            "PATCH",
            "/v0/secrets/http-token",
            Some(json!({"description":"left","mutationId":"reused-echo"})),
            original["version"].as_str()
        ),
        graph.request(
            "PATCH",
            "/v0/secrets/http-token",
            Some(json!({"description":"right","mutationId":"reused-echo"})),
            original["version"].as_str()
        )
    );
    let (winner, loser) = if left.0 == 200 {
        (left, right)
    } else {
        (right, left)
    };
    assert_eq!(winner.0, 200);
    assert_eq!(loser.0, 409);
    assert_eq!(loser.1["secret"], winner.1["secret"]);
    assert_eq!(loser.1["currentVersion"], winner.1["secret"]["version"]);
    assert_eq!(graph.events().await.len(), 2);
    let (status, current) = graph
        .request(
            "PATCH",
            "/v0/secrets/http-token",
            Some(json!({"description":"another change","mutationId":"reused-echo"})),
            winner.1["secret"]["version"].as_str(),
        )
        .await;
    assert_eq!(status, 200);
    assert_ne!(current["secret"]["version"], winner.1["secret"]["version"]);
    let events = graph.events().await;
    assert_eq!(events.len(), 3);
    assert_eq!(events[1]["payload"]["mutationId"], "reused-echo");
    assert_eq!(events[2]["payload"]["mutationId"], "reused-echo");
    let project = graph.project().await;
    let path = format!("/v0/secrets/http-token/attachments/project/{project}");
    let (left, right) = tokio::join!(
        graph.request(
            "PUT",
            &path,
            Some(json!({"mutationId":"reused-echo"})),
            None
        ),
        graph.request(
            "PUT",
            &path,
            Some(json!({"mutationId":"reused-echo"})),
            None
        )
    );
    let statuses = [left.0, right.0];
    assert!(statuses == [201, 200] || statuses == [200, 201]);
    assert_eq!(left.1["attachment"], right.1["attachment"]);
    assert_ne!(left.1["created"], right.1["created"]);
    assert_eq!(graph.events().await.len(), 4);
    graph.close().await;
}
