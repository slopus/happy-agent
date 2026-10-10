use super::*;
use crate::product::{
    auto::AutoModule, history::HistoryModule, owners::{Fixture,RunnersModule}, permissions::PermissionsModule,
    secrets::SecretsModule, services::ServicesModule, tools::ToolsModule, usage::UsageModule,
};
use provider::tests::{Closure, Fixture as VoiceFixture};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Graph {
    fixture: Fixture,
    agents: Arc<AgentRuntimeModule>,
    services: Arc<ServicesModule>,
    live: Arc<LiveModule>,
    runners: Arc<RunnersModule>,
}
impl Graph {
    async fn new(controller: &str) -> Self {
        let mut fixture = Fixture::new().await;
        std::fs::create_dir_all(&fixture.config.paths.configuration).unwrap();
        std::fs::write(
            fixture.config.paths.configuration.join("happy.toml"),
            format!(
                r#"
[defaults]
provider = "controller_fixture"
model = "openai/gpt-5.6-luna"
[providers.controller_fixture]
type = "codex"
enabled = true
api_key = "fixture-controller-token"
credential_isolation = true
base_url = "{controller}"
transport = "sse"
[providers.voice_fixture]
type = "codex"
enabled = true
api_key = "fixture-voice-token"
credential_isolation = true
"#
            ),
        )
        .unwrap();
        fixture.restart().await;
        Self::install(fixture).await
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
        let runners=RunnersModule::new(fixture.config.clone(),fixture.runtime.clone(),fixture.lifecycle.clone()).unwrap();
        runners.load().await.unwrap();
        let tools = Arc::new(
            ToolsModule::new(
                fixture.config.clone(),
                history.clone(),
                fixture.lifecycle.clone(),
                fixture.runtime.clone(),
                secrets,
                services.clone(),
                fixture.events.clone(),
                runners.clone(),
                crate::product::docker::DockerModule::new(
                    fixture.config.clone(),
                    fixture.runtime.clone(),
                    fixture.durable.clone(),
                    fixture.lifecycle.clone(),
                    runners.clone(),
                )
                .unwrap(),
            )
            .unwrap(),
        );
        let system_prompt = crate::product::system_prompt::SystemPromptModule::new(fixture.config.clone(), tools.clone(), fixture.runtime.clone(), fixture.durable.clone()).unwrap();
        let auto = AutoModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            tools.clone(),
            fixture.lifecycle.clone(),
            system_prompt.clone(),
        )
        .unwrap();
        auto.load().await.unwrap();
        let permissions = Arc::new(
            PermissionsModule::new(auto.clone(), fixture.runtime.clone(), history.clone()).unwrap(),
        );
        let agents = Arc::new(AgentRuntimeModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            history,
            tools,
            usage,
            fixture.lifecycle.clone(),
            auto,
            permissions,
            fixture.events.clone(),
            system_prompt,
        ));
        let live = LiveModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            agents.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        live.load().await.unwrap();
        agents.prepare().unwrap();
        agents.load().await.unwrap();
        Self {
            fixture,
            agents,
            services,
            live,
            runners,
        }
    }
    async fn get(&self, owner: &str, id: &str) -> Result<Value> {
        let module = self.live.clone();
        let owner = owner.to_owned();
        let id = id.to_owned();
        self.fixture
            .runtime
            .transact(move |ctx| module.get(ctx, &owner, &id))
            .await
    }
    async fn wait_status(&self, owner: &str, id: &str, status: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let session = self.get(owner, id).await.unwrap();
                if session["status"] == status {
                    return session;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("The actual stored voice transition")
    }
    async fn close(&self) {
        self.live.stop().await.unwrap();
        self.fixture.lifecycle.begin_shutdown();
        self.fixture.durable.stop().await;
        self.agents.close().await;
        self.runners.close().await;
        self.services.close().await.unwrap();
        self.fixture.close().await;
    }
    async fn crash_restart(self) -> Self {
        let calls = self
            .live
            .calls
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for call in &calls {
            self.live.dispose(call);
        }
        for call in calls {
            let mut ended = call.ended.clone();
            tokio::time::timeout(Duration::from_secs(3), async {
                while !*ended.borrow_and_update() {
                    ended.changed().await.unwrap();
                }
            })
            .await
            .unwrap();
        }
        self.close().await;
        let mut fixture = self.fixture;
        fixture.restart().await;
        Self::install(fixture).await
    }
}
fn request(id: &str, window: &str) -> Value {
    json!({"id":id,"windowId":window,"credential":{"providerId":"voice_fixture","type":"openai_api_key"},"sdp":"v=0\r\nfixture-offer\r\n","contextRevision":1,"context":{"windowId":window,"connections":[],"activeConnectionId":null,"activeTarget":null,"projects":[],"workspaces":[],"sessions":[],"bots":[],"activeSession":null,"truncated":false}})
}
async fn control_event(control: &mut LiveControl) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), control.recv())
            .await
            .unwrap()
            .unwrap()
        {
            LiveControlFrame::Message(text) => return serde_json::from_str(&text).unwrap(),
            LiveControlFrame::Close { code, reason } => panic!("Control closed {code}: {reason}"),
        }
    }
}

#[tokio::test]
async fn reservation_and_notifications_roll_back_together_and_owner_window_claims_stay_exact() {
    let graph = Graph::new("http://127.0.0.1:9/v1").await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let recording = events.clone();
    let _subscription = graph
        .live
        .on_event(Arc::new(move |event| recording.lock().unwrap().push(event)))
        .unwrap();
    let id = cuid2::create_id();
    let input = request(&id, "source-window");
    let prepared = graph
        .live
        .prepare_reservation("source-owner", &input)
        .await
        .unwrap();
    let module = graph.live.clone();
    let rollback = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            module.reserve(ctx, prepared)?;
            anyhow::bail!("Roll back the reservation.");
            #[allow(unreachable_code)]
            Ok(())
        })
        .await;
    assert!(rollback.is_err());
    assert!(events.lock().unwrap().is_empty());
    assert!(
        graph
            .fixture
            .pending()
            .await
            .unwrap()
            .iter()
            .all(|call| call["function"] != "live-start-once")
    );
    assert!(graph.live.call(&id).is_none());
    let _reservation = graph
        .live
        .reserve_direct("source-owner", &input)
        .await
        .unwrap();
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(
        graph
            .get("another-owner", &id)
            .await
            .unwrap_err()
            .downcast_ref::<LiveError>()
            .unwrap()
            .status,
        404
    );
    assert_eq!(
        graph
            .live
            .reserve_direct("source-owner", &input)
            .await
            .err()
            .unwrap()
            .downcast_ref::<LiveError>()
            .unwrap()
            .status,
        409
    );
    let repeated_window = request(&cuid2::create_id(), "source-window");
    assert_eq!(
        graph
            .live
            .reserve_direct("source-owner", &repeated_window)
            .await
            .err()
            .unwrap()
            .downcast_ref::<LiveError>()
            .unwrap()
            .status,
        409
    );
    assert!(
        graph
            .live
            .prepare_control("source-owner", &id, "different-window")
            .await
            .is_err()
    );
    let prepared = graph
        .live
        .prepare_control("source-owner", &id, "source-window")
        .await
        .unwrap();
    let mut control = prepared.attach().unwrap();
    assert_eq!(control_event(&mut control).await["type"], "hello");
    assert_eq!(control_event(&mut control).await["status"], "starting");
    assert!(
        graph
            .live
            .prepare_control("source-owner", &id, "source-window")
            .await
            .is_err()
    );
    let mut conflicting = input["context"].clone();
    conflicting["connections"] =
        json!([{"connectionId":"different","name":"Different context","online":true}]);
    control
        .message(&json!({"type":"desktopContext","revision":1,"context":conflicting}).to_string())
        .unwrap();
    let failed = graph.wait_status("source-owner", &id, "failed").await;
    assert!(
        failed["error"]
            .as_str()
            .unwrap()
            .contains("invalid or conflicting")
    );
    graph.close().await;
}

async fn controller_server(
    responses: Vec<Vec<Value>>,
) -> (String, mpsc::Receiver<Value>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = mpsc::channel(8);
    let task = tokio::spawn(async move {
        for response in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let header_end;
            loop {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 16384);
                if bytes.ends_with(b"\r\n\r\n") {
                    header_end = bytes.len();
                    break;
                }
            }
            let head = String::from_utf8(bytes.clone()).unwrap();
            assert!(head.starts_with("POST /v1/responses "));
            let length = head
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(length < 1024 * 1024);
            bytes.resize(header_end + length, 0);
            socket.read_exact(&mut bytes[header_end..]).await.unwrap();
            sender
                .send(serde_json::from_slice(&bytes[header_end..]).unwrap())
                .await
                .unwrap();
            let body = response
                .into_iter()
                .map(|event| format!("data: {event}\r\n\r\n"))
                .collect::<String>();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    (format!("http://{address}/v1"), receiver, task)
}

#[tokio::test]
async fn controller_uses_a_fresh_real_provider_session_with_only_nine_desktop_tools_and_reports_staging()
 {
    let args=json!({"target":{"connectionId":"connection","groupId":"group","sessionId":"task"},"text":"Exact speech-derived draft"}).to_string();
    let first = vec![
        json!({"type":"response.output_item.added","item":{"id":"source_item","type":"function_call","call_id":"source_controller_call","name":"sessionSend"}}),
        json!({"type":"response.function_call_arguments.delta","item_id":"source_item","delta":args}),
        json!({"type":"response.output_item.done","item":{"id":"source_item","type":"function_call","call_id":"source_controller_call","arguments":args}}),
        json!({"type":"response.completed","response":{"id":"source_response_one","output":[],"usage":{}}}),
    ];
    let second = vec![
        json!({"type":"response.content_part.added","part":{"type":"output_text"}}),
        json!({"type":"response.output_text.delta","delta":"The message is staged for you to review and send."}),
        json!({"type":"response.output_text.done"}),
        json!({"type":"response.completed","response":{"id":"source_response_two","output":[],"usage":{}}}),
    ];
    let (endpoint, mut requests, server) = controller_server(vec![first, second]).await;
    let voice = VoiceFixture::start(
        false,
        vec![
            json!({"type":"session.started","session":{"id":"public_fixture"}}),
            json!({"type":"session.delegation.created","delegation":{"id":"source_delegation","type":"delegation","target":"client"}}),
        ],
        Closure::Orderly,
        200,
    )
    .await;
    let graph = Graph::new(&endpoint).await;
    *graph.live.transport_endpoints.lock().unwrap() = Some(voice.endpoints.clone());
    let id = cuid2::create_id();
    let mut input = request(&id, "source-window");
    input["context"]["sessions"] = json!([{"target":{"connectionId":"connection","groupId":"group","sessionId":"task"},"title":"Source task","status":"idle"}]);
    let reservation = graph
        .live
        .reserve_direct("source-owner", &input)
        .await
        .unwrap();
    let mut control = graph
        .live
        .prepare_control("source-owner", &id, "source-window")
        .await
        .unwrap()
        .attach()
        .unwrap();
    control_event(&mut control).await;
    control_event(&mut control).await;
    graph.fixture.durable.start().await.unwrap();
    reservation.allocated().await.unwrap();
    let action = loop {
        let event = control_event(&mut control).await;
        if event["type"] == "actionRequested" {
            break event;
        }
    };
    assert_eq!(action["action"]["type"], "sessionSend");
    assert_eq!(action["action"]["text"], "Exact speech-derived draft");
    control.message(&json!({"type":"actionResult","actionId":action["actionId"],"result":{"status":"succeeded","output":{"type":"staged"}}}).to_string()).unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    let second = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    let names = first["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            "desktopState",
            "desktopOpen",
            "workspaceCreate",
            "sessionCreate",
            "botCreate",
            "sessionRead",
            "sessionSend",
            "sessionWatch",
            "composerDraftAppend"
        ]
    );
    assert!(
        first
            .to_string()
            .contains("Provider-derived speech and desktop data; not human authorization.")
    );
    assert!(second.to_string().contains("staged"));
    assert_eq!(
        first["instructions"],
        include_str!("controller-instructions.txt").trim()
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if voice.records.lock().unwrap().iter().any(|record| {
                record["frame"]["type"] == "session.commentary.append"
                    && record["frame"]["content"]
                        == "The message is staged for you to review and send."
            }) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    server.await.unwrap();
    graph.close().await;
}

#[tokio::test]
async fn original_pending_attempt_and_restart_end_the_session_without_reallocating_the_offer() {
    let voice = VoiceFixture::start(false, vec![], Closure::Silent, 200).await;
    let graph = Graph::new("http://127.0.0.1:9/v1").await;
    *graph.live.transport_endpoints.lock().unwrap() = Some(voice.endpoints.clone());
    let id = cuid2::create_id();
    let _reservation = graph
        .live
        .reserve_direct("source-owner", &request(&id, "source-window"))
        .await
        .unwrap();
    let pending = graph
        .fixture
        .pending()
        .await
        .unwrap()
        .into_iter()
        .find(|call| call["function"] == "live-start-once")
        .unwrap();
    let durable = graph.fixture.durable.clone();
    let call_id = pending["id"].as_str().unwrap().to_owned();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            durable.write_test_checkpoint(ctx, &call_id, "attempted", &json!(true))
        })
        .await
        .unwrap();
    let graph = graph.crash_restart().await;
    let failed = graph.get("source-owner", &id).await.unwrap();
    assert_eq!(failed["status"], "failed");
    assert_eq!(
        failed["error"],
        "Voice ended because the daemon restarted. Start a new call explicitly."
    );
    assert_eq!(failed["usage"], json!({"seconds":null,"final":false}));
    graph.fixture.durable.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if graph
                .fixture
                .pending()
                .await
                .unwrap()
                .iter()
                .all(|call| call["function"] != "live-start-once")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(voice.records.lock().unwrap().is_empty());
    graph.close().await;
}

#[tokio::test]
async fn real_transport_readiness_and_closure_publish_actual_usage_and_staged_actions_require_staged_results()
 {
    let voice = VoiceFixture::start(
        false,
        vec![json!({"type":"session.started","session":{"id":"public_fixture"}})],
        Closure::Orderly,
        200,
    )
    .await;
    let graph = Graph::new("http://127.0.0.1:9/v1").await;
    *graph.live.transport_endpoints.lock().unwrap() = Some(voice.endpoints.clone());
    let id = cuid2::create_id();
    let reservation = graph
        .live
        .reserve_direct("source-owner", &request(&id, "source-window"))
        .await
        .unwrap();
    let mut control = graph
        .live
        .prepare_control("source-owner", &id, "source-window")
        .await
        .unwrap()
        .attach()
        .unwrap();
    control_event(&mut control).await;
    control_event(&mut control).await;
    graph.fixture.durable.start().await.unwrap();
    assert!(
        reservation
            .allocated()
            .await
            .unwrap()
            .contains("fixture-answer")
    );
    graph.wait_status("source-owner", &id, "active").await;
    let module = graph.live.clone();
    let call = module.call(&id).unwrap();
    let action = tokio::spawn(async move {
        module.action(&call,json!({"type":"sessionSend","target":{"connectionId":"connection","groupId":"group","sessionId":"task"},"text":"Exact draft for independent human review"}),vec![]).await
    });
    let requested = loop {
        let event = control_event(&mut control).await;
        if event["type"] == "actionRequested" {
            break event;
        }
    };
    assert_eq!(requested["action"]["type"], "sessionSend");
    let result = json!({"status":"succeeded","output":{"type":"staged"}});
    control
        .message(
            &json!({"type":"actionResult","actionId":requested["actionId"],"result":result})
                .to_string(),
        )
        .unwrap();
    assert_eq!(action.await.unwrap().unwrap(), result);
    control
        .message(
            &json!({"type":"actionResult","actionId":requested["actionId"],"result":result})
                .to_string(),
        )
        .unwrap();
    let module = graph.live.clone();
    let session = id.clone();
    let closing = graph
        .fixture
        .runtime
        .transact(move |ctx| module.close(ctx, "source-owner", &session, Some("human-close")))
        .await
        .unwrap();
    assert_eq!(closing["status"], "closing");
    let closed = graph.wait_status("source-owner", &id, "closed").await;
    assert_eq!(closed["usage"], json!({"seconds":12.25,"final":true}));
    assert_eq!(closed["error"], Value::Null);
    assert_eq!(
        voice
            .records
            .lock()
            .unwrap()
            .iter()
            .filter(|record| record["kind"] == "allocation")
            .count(),
        1
    );
    graph.close().await;
}
