#![cfg(unix)]

#[path = "compute/pty_and_processes.rs"]
mod compute_acceptance;
#[path = "compute/detached_reload.rs"]
mod detached_reload_acceptance;
#[path = "api/questions.rs"]
mod question_acceptance;
#[path = "compute/vendor_file_tools.rs"]
mod vendor_file_tools;
#[path = "api/profile.rs"]
mod profile_acceptance;
#[path = "api/provider_maintenance.rs"]
mod provider_maintenance_acceptance;
#[path = "api/onboarding.rs"]
mod onboarding_acceptance;
#[path = "api/mcp.rs"]
mod mcp_acceptance;
#[path = "api/catalog.rs"]
mod catalog_acceptance;

use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};

const AGENT: &str = "agenttoolrecovery";
const RUN: &str = "messagerecoveredrun";
const INFERENCE: &str = "inferencerecoveredtool";
const CALL: &str = "callrecoveredtool";
const WORKSPACE: &str = "workspacerecovered";

struct Installation {
    _directory: tempfile::TempDir,
    home: PathBuf,
}
impl Installation {
    fn new() -> Self {
        let scratch = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.g");
        std::fs::create_dir_all(&scratch).expect("short socket fixture directory");
        let scratch = scratch
            .canonicalize()
            .expect("scratch");
        let directory = tempfile::Builder::new()
            .prefix("")
            .rand_bytes(2)
            .tempdir_in(scratch)
            .expect("installation");
        let home = directory.path().join(".happy");
        std::fs::create_dir_all(home.join("agent")).expect("private directory");
        Self {
            _directory: directory,
            home,
        }
    }
    fn command(&self, command: &str) {
        let output = Command::new(env!("CARGO_BIN_EXE_happy-agent"))
            .arg(command)
            .env("HAPPY_HOME_DIR", &self.home)
            .output()
            .expect("original command");
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stderr),
            std::fs::read_to_string(self.home.join("agent/daemon.log")).unwrap_or_default()
        );
    }
    fn client(&self) -> (reqwest::Client, String) {
        (
            reqwest::Client::builder()
                .unix_socket(self.home.join("agent/server.sock"))
                .timeout(Duration::from_secs(5))
                .build()
                .expect("client"),
            std::fs::read_to_string(self.home.join("agent/token"))
                .expect("token")
                .trim()
                .to_owned(),
        )
    }
    fn seed(&self, endpoint: &str) {
        let folder = self._directory.path().join("workspace");
        std::fs::create_dir(&folder).expect("workspace");
        std::fs::write(folder.join("fixture.txt"), "one recovered execution\n")
            .expect("tool input");
        let public = self._directory.path().join(if cfg!(target_os = "macos") {
            "Happy/Config"
        } else {
            "happy/config"
        });
        std::fs::create_dir_all(&public).expect("configuration");
        std::fs::write(public.join("happy.toml"),format!("[providers]\ndefault_enable = false\n[providers.fixture]\ntype = 'codex'\napi_key = 'fixture-placeholder'\ncredential_isolation = true\nenabled = true\nbase_url = '{endpoint}'\ntransport = 'sse'\ninclude_models = ['openai/gpt-5.6-sol']\n")).expect("original isolated provider configuration");
        let database =
            Connection::open(self.home.join("agent/agent.sqlite")).expect("original database");
        database
            .execute_batch(include_str!("original_agent_restart.sql"))
            .expect("original schema");
        for (module, keys) in [
            ("@happy-agent-base", vec!["001-core-storage"]),
            (
                "happy-agent-installation",
                vec!["001-root-agent", "002-drop-root-agent"],
            ),
            (
                "history",
                vec![
                    "001-history-records",
                    "002-history-runs-and-pending",
                    "003-history-tool-call-index",
                ],
            ),
            (
                "events",
                vec![
                    "001-durable-events",
                    "002-latest-agent-events",
                    "003-event-payload-bytes",
                ],
            ),
            (
                "projects",
                vec![
                    "001-projects-catalog",
                    "002-drop-project-idempotency-tables",
                    "003-project-order-version-avatar",
                    "004-project-folder-record",
                    "005-project-without-owner",
                    "006-project-root-agents",
                    "007-project-root-agent-order-keys",
                    "008-project-avatar-assets",
                    "009-project-workspace-setup-commands",
                    "010-project-runner",
                ],
            ),
            (
                "workspaces",
                vec!["001-workspaces-catalog", "002-drop-workspace-replay-state", "003-workspace-path", "004-workspace-git-record", "005-workspace-without-owner", "006-workspace-agent-associations", "007-workspace-hierarchy", "008-workspace-service-cleanup", "009-workspace-subtask", "010-workspace-runner-and-image"],
            ),
        ] {
            for (position, key) in keys.into_iter().enumerate() {
                database
                    .execute(
                        "INSERT INTO happy_agent_migrations VALUES(?1,?2,?3)",
                        params![module, key, position as i64],
                    )
                    .expect("immutable module migration prefix");
            }
        }
        let mode = json!({"providerId":"fixture","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"full_access"});
        let configuration = json!({"provenance":{"createdAt":1700000000000u64},"environment":{"osVersion":"fixture","platform":"linux","workingDirectory":folder,"shell":"/bin/bash"},"modules":{"compute":{"cwd":folder}},"metadata":{"title":"Recover original run","lastMode":mode,"version":1,"updatedAt":1700000000000u64,"opaqueFixture":{"kept":true}}});
        let input = json!({"role":"user","content":[{"type":"text","text":"Finish the original tool and continue."}]});
        let arguments=json!({"cmd":"cat fixture.txt | tee -a recovery-count","workdir":folder,"yield_time_ms":1000,"max_output_tokens":1000}).to_string();
        for (owner, key, value) in [
            (
                "",
                format!("agentSystem.config.{AGENT}"),
                configuration.clone(),
            ),
            (AGENT, "agentConfig".into(), configuration),
            (
                AGENT,
                "owed".into(),
                json!({"stage":"inference","loopId":"looprecoveredtool","turnId":"turnrecoveredtool","inferenceId":INFERENCE}),
            ),
            (
                AGENT,
                "settings".into(),
                json!({"provider":"fixture","model":"openai/gpt-5.6-sol","effort":"medium","profile":null,"permissionMode":"full_access"}),
            ),
            (AGENT, format!("message.{RUN}"), json!(true)),
            (
                AGENT,
                format!("kv.{AGENT}.run.module.history.pending_inference_id"),
                json!(INFERENCE),
            ),
            (
                AGENT,
                format!("kv.{AGENT}.run.module.history.pending_blocks"),
                json!([{"type":"tool_call","callId":CALL,"name":"exec_command","arguments":serde_json::from_str::<Value>(&arguments).expect("arguments")}]),
            ),
        ] {
            database
                .execute(
                    "INSERT INTO happy_agent_values VALUES(?1,?2,?3)",
                    params![owner, key, value.to_string()],
                )
                .expect("original private value");
        }
        let records = [
            json!({"type":"user","id":RUN,"message":input,"metadata":{"messageOrigin":"user","mode":mode}}),
            json!({"type":"block","id":CALL,"block":{"type":"tool_call","callId":"provider-recovered-tool","name":"exec_command","arguments":arguments}}),
        ];
        for (position, record) in records.iter().enumerate() {
            database
                .execute(
                    "INSERT INTO happy_agent_records VALUES(?1,?2,?3)",
                    params![AGENT, position as i64, record.to_string()],
                )
                .expect("original private record");
        }
        let message = json!({"role":"user","blocks":[{"type":"text","text":"Finish the original tool and continue."}],"recordId":RUN,"runId":RUN,"delivery":"queue","mode":mode,"profile":null,"at":1700000000000u64});
        database.execute("INSERT INTO happy_agent_module_history VALUES(?1,0,?2,'user',?3,'finish the original tool and continue.',0,1,38,0,0,0,?2)",params![AGENT,RUN,message.to_string()]).expect("accepted public user message");
        database.execute("INSERT INTO happy_agent_module_history_runs VALUES(?1,0,?2,'running',NULL,1700000000000,NULL)",params![AGENT,RUN]).expect("original public run");
        let parsed_arguments =
            serde_json::from_str::<Value>(&arguments).expect("original arguments");
        let active = json!({"acceptedMessageIds":[RUN],"activeIndex":null,"activeKind":null,"argumentBuffers":{CALL:arguments},"blocks":[{"type":"toolCall","id":CALL,"name":"exec_command","arguments":parsed_arguments}],"callIndexes":{CALL:0},"hasProviderEvent":true,"runId":RUN,"stopReason":"stop","text":"","inferenceId":INFERENCE});
        database
            .execute(
                "INSERT INTO happy_agent_active_runs VALUES(?1,?2)",
                params![AGENT, active.to_string()],
            )
            .expect("original active run identity");
        database
            .execute(
                "INSERT INTO happy_agent_module_project_root_agents(project_id,agent_id,order_key) VALUES(?1,?2,'5')",
                params![WORKSPACE, AGENT],
            )
            .expect("original agent placement");
        database.execute("INSERT INTO happy_agent_module_projects(id,repository_ref,kind,storage_key,name,name_source,status,presence,initialization_status,order_key,created_at,updated_at) VALUES(?1,?2,'regular','restore-fixture','Restoration fixture','user','active','present','ready','5',1700000000000,1700000000000)",params![WORKSPACE,folder.to_string_lossy()]).expect("original root project ownership");
    }
}
impl Drop for Installation {
    fn drop(&mut self) {
        let _ = Command::new(env!("CARGO_BIN_EXE_happy-agent"))
            .arg("kill")
            .env("HAPPY_HOME_DIR", &self.home)
            .output();
    }
}

async fn provider() -> (String, mpsc::Receiver<Value>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("inference fixture");
    let endpoint = format!(
        "http://{}/v1",
        listener.local_addr().expect("fixture address")
    );
    let (sender, receiver) = mpsc::channel(2);
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("restored inference request");
        let mut bytes = Vec::new();
        let body = loop {
            let mut buffer = [0u8; 8192];
            let count = socket.read(&mut buffer).await.expect("inference bytes");
            assert!(count > 0, "complete inference request");
            bytes.extend_from_slice(&buffer[..count]);
            assert!(bytes.len() < 4 * 1024 * 1024, "bounded request fixture");
            if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|length| length.trim().parse::<usize>().expect("content length"))
                    })
                    .expect("length");
                if bytes.len() >= end + 4 + length {
                    break serde_json::from_slice::<Value>(&bytes[end + 4..end + 4 + length])
                        .expect("inference JSON");
                }
            }
        };
        sender.send(body).await.expect("observed inference");
        let events = [
            json!({"type":"response.content_part.added","part":{"type":"output_text"}}),
            json!({"type":"response.output_text.delta","delta":"Recovered existing run."}),
            json!({"type":"response.output_text.done"}),
            json!({"type":"response.completed","response":{"id":"recovered-response","output":[],"usage":{"input_tokens":17,"output_tokens":3}}}),
        ];
        let body = events
            .iter()
            .map(|event| format!("data: {event}\r\n\r\n"))
            .collect::<String>();
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.expect("inference response");
    });
    (endpoint, receiver, task)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_undispatched_tool_resumes_once_and_keeps_public_run_and_message_identity() {
    let (endpoint, mut requests, provider) = provider().await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let (client, token) = installation.client();
    let response = client
        .get(format!("http://happy/v0/agents/{AGENT}"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("original focused agent route");
    assert_eq!(response.status(), 200);
    let inference = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .expect("restored inference")
        .expect("observed inference");
    let request = inference.to_string();
    assert!(
        request.contains("provider-recovered-tool"),
        "provider-native correlation identity is preserved: {request}"
    );
    assert!(
        request.contains("one recovered execution"),
        "recovered real tool output reaches inference: {request}"
    );
    let page = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let response = client
                .get(format!("http://happy/v0/agents/{AGENT}/messages"))
                .bearer_auth(&token)
                .send()
                .await
                .expect("history");
            assert_eq!(response.status(), 200);
            let page: Value = response.json().await.expect("history JSON");
            if page["runs"][0]["status"] == "completed" {
                break page;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("durable public run completion");
    assert_eq!(page["runs"].as_array().expect("run array").len(), 1);
    assert_eq!(page["runs"][0]["id"], RUN);
    let messages = page["runs"][0]["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0]["id"], RUN);
    assert_eq!(messages[1]["id"], INFERENCE);
    assert_eq!(messages[1]["content"][0]["id"], CALL);
    assert_eq!(messages[1]["content"][0]["status"], "completed");
    assert_ne!(messages[2]["id"], INFERENCE);
    assert_eq!(
        messages[2]["content"],
        json!([{"type":"text","text":"Recovered existing run."}])
    );
    assert_eq!(
        std::fs::read_to_string(
            installation
                ._directory
                .path()
                .join("workspace/recovery-count")
        )
        .expect("real tool side effect"),
        "one recovered execution\n"
    );
    installation.command("stop");
    let database =
        Connection::open(installation.home.join("agent/agent.sqlite")).expect("settled store");
    assert_eq!(database.query_row("SELECT count(*) FROM happy_agent_values WHERE owner_id=?1 AND (key='owed' OR key LIKE 'tool.%')",[AGENT],|row|row.get::<_,i64>(0)).expect("settled keys"),0);
    let config: String = database
        .query_row(
            "SELECT value_json FROM happy_agent_values WHERE owner_id=?1 AND key='agentConfig'",
            [AGENT],
            |row| row.get(0),
        )
        .expect("retained configuration");
    assert_eq!(
        serde_json::from_str::<Value>(&config).expect("configuration")["metadata"]["opaqueFixture"],
        json!({"kept":true})
    );
    drop(database);
    installation.command("start");
    let (_, token) = installation.client();
    let second: Value = client
        .get(format!("http://happy/v0/agents/{AGENT}/messages"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("second restart history")
        .json()
        .await
        .expect("same history");
    assert_eq!(second["runs"], page["runs"]);
    assert_eq!(
        std::fs::read_to_string(
            installation
                ._directory
                .path()
                .join("workspace/recovery-count")
        )
        .expect("retained tool side effect"),
        "one recovered execution\n"
    );
    provider.await.expect("provider fixture completed");
}

async fn completed(installation: &Installation) -> Value {
    let (client, token) = installation.client();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let page: Value = client
                .get(format!("http://happy/v0/agents/{AGENT}/messages"))
                .bearer_auth(&token)
                .send()
                .await
                .expect("history")
                .json()
                .await
                .expect("history JSON");
            if page["runs"][0]["status"] == "completed" {
                return page;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("run settlement")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn published_client_reads_recovered_identity_presentation_and_measured_usage() {
    let (endpoint, mut requests, provider) = provider().await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .expect("real inference")
        .expect("observed request");
    completed(&installation).await;
    let output = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/client_agent_recovery.mjs"))
        .arg(&installation.home)
        .output()
        .expect("published JavaScript client");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("Published client recovered agent"));
    provider.await.expect("inference fixture completed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatched_nonreloadable_tool_is_interrupted_without_repeating_its_side_effect() {
    let (endpoint, mut requests, provider) = provider().await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).expect("store");
    let call: String = database
        .query_row(
            "SELECT record_json FROM happy_agent_records WHERE owner_id=?1 AND position=1",
            [AGENT],
            |row| row.get(0),
        )
        .expect("original call");
    let mut call: Value = serde_json::from_str(&call).expect("call");
    call["block"]
        .as_object_mut()
        .expect("block")
        .remove("callId");
    let pending = json!({"id":CALL,"call":call["block"]});
    database
        .execute(
            "INSERT INTO happy_agent_values VALUES(?1,?2,?3)",
            params![AGENT, format!("tool.000000.{CALL}"), pending.to_string()],
        )
        .expect("already dispatched batch");
    drop(database);
    installation.command("start");
    let inference = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .expect("continuation")
        .expect("request");
    assert!(
        inference
            .to_string()
            .contains("The tool call was interrupted by a restart and was not retried.")
    );
    assert!(
        !installation
            ._directory
            .path()
            .join("workspace/recovery-count")
            .exists()
    );
    let page = completed(&installation).await;
    assert_eq!(
        page["runs"][0]["messages"][1]["content"][0]["status"],
        "failed"
    );
    provider.await.expect("provider completion");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restored_settlement_finishes_without_a_new_inference() {
    let installation = Installation::new();
    installation.seed("http://127.0.0.1:1/v1");
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).expect("store");
    database
        .execute(
            "DELETE FROM happy_agent_records WHERE owner_id=?1 AND position>0",
            [AGENT],
        )
        .expect("no unanswered calls");
    database
        .execute(
            "DELETE FROM happy_agent_values WHERE owner_id=?1 AND key GLOB 'kv.*'",
            [AGENT],
        )
        .expect("no pending blocks");
    database.execute("UPDATE happy_agent_values SET value_json=?2 WHERE owner_id=?1 AND key='owed'",params![AGENT,json!({"stage":"settlement","loopId":"looprecoveredtool","settlementId":"settlementrecovered"}).to_string()]).expect("owed settlement");
    drop(database);
    installation.command("start");
    let page = completed(&installation).await;
    assert_eq!(
        page["runs"][0]["messages"]
            .as_array()
            .expect("messages")
            .len(),
        1
    );
    assert_eq!(page["runs"][0]["usage"], json!({}));
    assert!(
        !installation
            ._directory
            .path()
            .join("workspace/recovery-count")
            .exists()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_restoration_keeps_queued_input_idle_without_owed_work() {
    let installation = Installation::new();
    installation.seed("http://127.0.0.1:1/v1");
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).expect("store");
    database
        .execute(
            "DELETE FROM happy_agent_values WHERE owner_id=?1 AND (key='owed' OR key GLOB 'kv.*')",
            [AGENT],
        )
        .expect("idle persisted state");
    database
        .execute(
            "DELETE FROM happy_agent_active_runs WHERE agent_id=?1",
            [AGENT],
        )
        .expect("idle public state");
    database.execute("INSERT INTO happy_agent_values VALUES(?1,'send.17000000000000.000000',?2)",params![AGENT,json!({"id":"messagequeuedidle","message":{"role":"user","content":[{"type":"text","text":"Remain queued until new authorization wakes the agent."}]},"options":{"profile":null}}).to_string()]).expect("durable queued input");
    drop(database);
    installation.command("start");
    let (client, token) = installation.client();
    let focused: Value = client
        .get(format!("http://happy/v0/agents/{AGENT}"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("agent")
        .json()
        .await
        .expect("focused");
    assert_eq!(focused["agent"]["status"], "idle");
    installation.command("stop");
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).expect("store");
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM happy_agent_values WHERE owner_id=?1 AND key GLOB 'send.*'",
                [AGENT],
                |row| row.get::<_, i64>(0)
            )
            .expect("queue preserved"),
        1
    );
    assert!(
        !installation
            ._directory
            .path()
            .join("workspace/recovery-count")
            .exists()
    );
}

struct Exchange {
    request: Value,
    respond: tokio::sync::oneshot::Sender<Vec<Value>>,
}
async fn scripted_provider(
    count: usize,
) -> (
    String,
    mpsc::Receiver<Exchange>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("scripted inference");
    let endpoint = format!(
        "http://{}/v1",
        listener.local_addr().expect("fixture address")
    );
    let (sender, receiver) = mpsc::channel(count);
    let task = tokio::spawn(async move {
        let mut observed = 0;
        let mut naming_requests = 0;
        while observed < count {
            let (mut socket, _) = listener.accept().await.expect("inference");
            let mut bytes = Vec::new();
            let request: Value = loop {
                let mut buffer = [0; 8192];
                let n = socket.read(&mut buffer).await.expect("request bytes");
                assert!(n > 0, "complete request");
                bytes.extend_from_slice(&buffer[..n]);
                assert!(bytes.len() < 4 * 1024 * 1024, "bounded request");
                if let Some(end) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().expect("length"))
                        })
                        .expect("body length");
                    if bytes.len() >= end + 4 + length {
                        break serde_json::from_slice(&bytes[end + 4..end + 4 + length])
                            .expect("inference JSON");
                    }
                }
            };
            let response = if request["client_metadata"]["session_id"].as_str().is_some_and(|id| id.starts_with("naming:")) {
                naming_requests += 1;
                assert!(naming_requests <= 128, "bounded independent naming requests");
                assert_eq!(request["tools"], json!([]), "Source naming inference has no ordinary tool loop");
                text_response("<title>Native fixture work</title>")
            } else {
                observed += 1;
                let (respond, response) = tokio::sync::oneshot::channel();
                sender
                    .send(Exchange { request, respond })
                    .await
                    .expect("observed request");
                tokio::time::timeout(Duration::from_secs(5), response)
                    .await
                    .expect("bounded scripted response")
                    .expect("scripted response")
            };
            let body = response
                .iter()
                .map(|event| format!("data: {event}\r\n\r\n"))
                .collect::<String>();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.expect("response");
        }
    });
    (endpoint, receiver, task)
}
fn text_response(text: &str) -> Vec<Value> {
    vec![
        json!({"type":"response.content_part.added","part":{"type":"output_text"}}),
        json!({"type":"response.output_text.delta","delta":text}),
        json!({"type":"response.output_text.done"}),
        json!({"type":"response.completed","response":{"id":format!("response-{text}"),"output":[],"usage":{"input_tokens":10,"output_tokens":2}}}),
    ]
}
async fn exchange(requests: &mut mpsc::Receiver<Exchange>) -> Exchange {
    tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .expect("next genuine inference")
        .expect("observed inference")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn new_agent_send_tool_steering_and_all_mode_queue_keep_original_api_identities() {
    let (endpoint, mut requests, provider) = scripted_provider(3).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    let database =
        Connection::open(installation.home.join("agent/agent.sqlite")).expect("original catalog");
    database
        .execute(
            "DELETE FROM happy_agent_values WHERE owner_id=?1 OR (owner_id='' AND key=?2)",
            params![AGENT, format!("agentSystem.config.{AGENT}")],
        )
        .expect("remove fixture agent");
    database
        .execute(
            "DELETE FROM happy_agent_module_project_root_agents WHERE agent_id=?1",
            [AGENT],
        )
        .expect("empty root-agent series");
    drop(database);
    installation.command("start");
    let (client, token) = installation.client();
    let id = "agentnewnativeflow";
    let response = client
        .post("http://happy/v0/agents")
        .bearer_auth(&token)
        .json(&json!({"workspaceId":WORKSPACE,"id":id,"title":"New native conversation"}))
        .send()
        .await
        .expect("create original agent");
    assert_eq!(response.status(), 201);
    let focused: Value = response.json().await.expect("new focused agent");
    assert_eq!(focused["agent"]["status"], "idle");
    assert_eq!(focused["agent"]["workspaceId"], WORKSPACE);
    let repeat:Value=client.post("http://happy/v0/agents").bearer_auth(&token).json(&json!({"workspaceId":"workspacenolongerexists","id":id,"title":"Ignored duplicate title"})).send().await.expect("safe creation retry").json().await.expect("same agent");
    assert_eq!(repeat["agent"], focused["agent"]);
    let invalid = client
        .post("http://happy/v0/agents")
        .bearer_auth(&token)
        .json(&json!({"workspaceId":WORKSPACE,"id":id,"parentAgentId":"agentinvalidparent"}))
        .send()
        .await
        .expect("strict duplicate validation");
    assert_eq!(invalid.status(), 400);
    let mode = json!({"providerId":"fixture","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"full_access"});
    let send = |message: &str, text: &str, delivery: &str| json!({"id":message,"text":text,"delivery":delivery,"profile":"removed-profile","clientMetadata":{"opaque":{"kept":true}},"mode":mode});
    let first = client
        .post(format!("http://happy/v0/agents/{id}/send"))
        .bearer_auth(&token)
        .json(&send(
            "messagenewnativeflow",
            "Produce the requested real tool call.",
            "queue",
        ))
        .send()
        .await
        .expect("original send");
    assert_eq!(first.status(), 202);
    let first: Value = first.json().await.expect("sent message");
    assert_eq!(first["message"]["id"], "messagenewnativeflow");
    assert_eq!(first["message"]["profile"], Value::Null);
    let initial = exchange(&mut requests).await;
    assert!(
        initial
            .request
            .to_string()
            .contains("Produce the requested real tool call.")
    );
    for (message, text, delivery) in [
        ("messagequeuednativeone", "First queued message.", "queue"),
        ("messagequeuednativetwo", "Second queued message.", "queue"),
        (
            "messagesteerednative",
            "Steer after the full tool batch.",
            "steer",
        ),
    ] {
        let response = client
            .post(format!("http://happy/v0/agents/{id}/send"))
            .bearer_auth(&token)
            .json(&send(message, text, delivery))
            .send()
            .await
            .expect("queued send");
        assert_eq!(response.status(), 202);
        let pending: Value = response.json().await.expect("pending message");
        assert_eq!(pending["message"]["status"], "pending");
        assert_eq!(pending["message"]["runId"], Value::Null);
    }
    let arguments=json!({"cmd":"printf 'one new execution\\n' | tee -a new-flow-count","yield_time_ms":1000,"max_output_tokens":1000}).to_string();
    initial.respond.send(vec![json!({"type":"response.output_item.added","item":{"type":"function_call","id":"native-item","call_id":"native-new-flow-call","name":"exec_command"}}),json!({"type":"response.output_item.done","item":{"type":"function_call","id":"native-item","call_id":"native-new-flow-call","name":"exec_command","arguments":arguments}}),json!({"type":"response.completed","response":{"id":"native-tool-response","output":[],"usage":{"input_tokens":10,"output_tokens":2}}})]).expect("tool-producing response");
    let steered = exchange(&mut requests).await;
    let context = steered.request.to_string();
    assert!(context.contains("native-new-flow-call"));
    assert!(context.contains("one new execution"));
    assert!(context.contains("Steer after the full tool batch."));
    assert!(!context.contains("First queued message."));
    steered
        .respond
        .send(text_response("Steering completed."))
        .expect("steering response");
    let queued = exchange(&mut requests).await;
    let context = queued.request.to_string();
    assert!(context.contains("First queued message."));
    assert!(context.contains("Second queued message."));
    queued
        .respond
        .send(text_response("Both queued messages completed."))
        .expect("queued response");
    let page = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let page: Value = client
                .get(format!("http://happy/v0/agents/{id}/messages"))
                .bearer_auth(&token)
                .send()
                .await
                .expect("public history")
                .json()
                .await
                .expect("page");
            if page["runs"].as_array().is_some_and(|runs| {
                runs.len() == 3 && runs.iter().all(|run| run["status"] != "running")
            }) {
                break page;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("three settled public runs");
    assert_eq!(page["runs"][0]["id"], "messagenewnativeflow");
    assert_eq!(page["runs"][0]["status"], "aborted");
    assert_eq!(page["runs"][0]["reason"], "steering");
    assert_eq!(page["runs"][1]["id"], "messagesteerednative");
    assert_eq!(page["runs"][1]["status"], "completed");
    assert_eq!(page["runs"][2]["id"], "messagequeuednativeone");
    assert_eq!(
        page["runs"][2]["messages"][1]["id"],
        "messagequeuednativetwo"
    );
    let mut duplicate = send("messagenewnativeflow", "Ignored duplicate body.", "queue");
    duplicate["mode"]["providerId"] = json!("removed-provider");
    let response = client
        .post(format!("http://happy/v0/agents/{id}/send"))
        .bearer_auth(&token)
        .json(&duplicate)
        .send()
        .await
        .expect("idempotent send after route removal");
    assert_eq!(response.status(), 202);
    let message: Value = response.json().await.expect("accepted duplicate");
    assert_eq!(message["message"]["status"], "accepted");
    assert_eq!(message["message"]["mode"], mode);
    assert_eq!(
        message["message"]["clientMetadata"],
        json!({"opaque":{"kept":true}})
    );
    assert_eq!(
        std::fs::read_to_string(
            installation
                ._directory
                .path()
                .join("workspace/new-flow-count")
        )
        .expect("real generated tool"),
        "one new execution\n"
    );
    let events: Value = client
        .get("http://happy/v0/events?limit=1000")
        .bearer_auth(&token)
        .send()
        .await
        .expect("run transitions")
        .json()
        .await
        .expect("events");
    let transitions = events["events"]
        .as_array()
        .expect("event array")
        .iter()
        .filter(|event| event["type"] == "run.boundary")
        .collect::<Vec<_>>();
    assert_eq!(transitions.len(), 1);
    assert_eq!(
        transitions[0]["payload"]["finishedRun"]["id"],
        "messagenewnativeflow"
    );
    assert_eq!(
        transitions[0]["payload"]["startedRun"]["id"],
        "messagesteerednative"
    );
    provider
        .await
        .expect("all three genuine inferences completed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_tool_request_keeps_three_messages_and_concurrent_retries_do_not_repeat_work() {
    let (endpoint, mut requests, provider) = scripted_provider(1).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    let database =
        Connection::open(installation.home.join("agent/agent.sqlite")).expect("original catalog");
    database
        .execute(
            "DELETE FROM happy_agent_values WHERE owner_id=?1 OR (owner_id='' AND key=?2)",
            params![AGENT, format!("agentSystem.config.{AGENT}")],
        )
        .expect("remove fixture agent");
    database
        .execute(
            "DELETE FROM happy_agent_module_project_root_agents WHERE agent_id=?1",
            [AGENT],
        )
        .expect("empty roots");
    drop(database);
    installation.command("start");
    let (client, token) = installation.client();
    let agent = "agentexplicitnative";
    let message = "messageexplicitnative";
    let created = client
        .post("http://happy/v0/agents")
        .bearer_auth(&token)
        .json(&json!({"workspaceId":WORKSPACE,"id":agent}))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    let mode = json!({"providerId":"fixture","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"full_access"});
    let body = json!({"id":message,"text":"Run the requested tool before answering.","profile":"old-profile","mode":mode,"clientMetadata":{"userId":"client-owned-untrusted","value":"opaque-client-metadata"},"content":[{"type":"tool_call_request","name":"exec_command","arguments":{"cmd":"printf 'one explicit execution\\n' | tee -a explicit-count","yield_time_ms":1000,"max_output_tokens":1000}}]});
    let sent = client
        .post(format!("http://happy/v0/agents/{agent}/send"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .expect("explicit request");
    assert_eq!(sent.status(), 202);
    let inference = exchange(&mut requests).await;
    let context = inference.request.to_string();
    assert!(!context.contains("tool_call_request"));
    assert!(!context.contains("opaque-client-metadata"));
    assert!(context.contains("one explicit execution"));
    let page: Value = client
        .get(format!("http://happy/v0/agents/{agent}/messages"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("history before inference completes")
        .json()
        .await
        .expect("page");
    let messages = page["runs"][0]["messages"]
        .as_array()
        .expect("two messages");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["id"], message);
    assert_eq!(messages[0]["metadata"], json!({}));
    assert_eq!(messages[0]["clientMetadata"], body["clientMetadata"]);
    assert_eq!(messages[0]["content"][1], body["content"][0]);
    let call = messages[1]["content"][0]["id"]
        .as_str()
        .expect("stable requested call")
        .to_owned();
    assert_eq!(messages[1]["id"], call);
    assert_eq!(messages[1]["content"][0]["status"], "completed");
    assert!(context.contains(&call));
    let mut replay = body.clone();
    replay["text"] = json!("Changed duplicate text.");
    replay["mode"]["providerId"] = json!("unavailable-provider");
    replay["mode"]["modelId"] = json!("unavailable-model");
    let path = format!("http://happy/v0/agents/{agent}/send");
    let (first, second) = tokio::join!(
        client.post(&path).bearer_auth(&token).json(&replay).send(),
        client.post(&path).bearer_auth(&token).json(&replay).send()
    );
    for response in [first, second] {
        let response = response.expect("concurrent retry");
        assert_eq!(response.status(), 202);
        let replay: Value = response.json().await.expect("original resource");
        assert_eq!(replay["message"], messages[0]);
    }
    let mut invalid = replay;
    invalid["mutationId"] = json!("not-accepted-by-send");
    let response = client
        .post(&path)
        .bearer_auth(&token)
        .json(&invalid)
        .send()
        .await
        .expect("strict duplicate validation");
    assert_eq!(response.status(), 400);
    inference
        .respond
        .send(text_response("Explicit tool completed."))
        .expect("one provider reply");
    let page = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let page: Value = client
                .get(format!("http://happy/v0/agents/{agent}/messages"))
                .bearer_auth(&token)
                .send()
                .await
                .expect("final history")
                .json()
                .await
                .expect("page");
            if page["runs"][0]["status"] == "completed" {
                break page;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("completed run");
    let messages = page["runs"][0]["messages"]
        .as_array()
        .expect("three messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1]["id"], call);
    assert_ne!(messages[2]["id"], call);
    assert_eq!(
        std::fs::read_to_string(
            installation
                ._directory
                .path()
                .join("workspace/explicit-count")
        )
        .expect("single real tool effect"),
        "one explicit execution\n"
    );
    installation.command("stop");
    installation.command("start");
    let (_, token) = installation.client();
    let restored: Value = client
        .get(format!("http://happy/v0/agents/{agent}/messages"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("restored history")
        .json()
        .await
        .expect("page");
    assert_eq!(restored["runs"], page["runs"]);
    assert_eq!(
        std::fs::read_to_string(
            installation
                ._directory
                .path()
                .join("workspace/explicit-count")
        )
        .expect("no restart replay"),
        "one explicit execution\n"
    );
    provider.await.expect("one provider request only");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_failure_finishes_the_original_run_as_failed_and_survives_restart() {
    let (endpoint, mut requests, provider) = scripted_provider(1).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let inference = exchange(&mut requests).await;
    inference.respond.send(vec![json!({"type":"response.failed","response":{"error":{"code":"invalid_request","message":"Deterministic provider failure."}}})]).expect("failed inference response");
    let (client, token) = installation.client();
    let page = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let page: Value = client
                .get(format!("http://happy/v0/agents/{AGENT}/messages"))
                .bearer_auth(&token)
                .send()
                .await
                .expect("history")
                .json()
                .await
                .expect("page");
            if page["runs"][0]["status"] != "running" {
                break page;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("failed run settlement");
    assert_eq!(page["runs"][0]["status"], "failed");
    assert_eq!(page["runs"][0]["reason"], "error");
    let messages = page["runs"][0]["messages"].as_array().expect("messages");
    assert_eq!(messages.last().expect("durable error")["role"], "service");
    assert!(
        messages.last().expect("durable error")["content"]
            .to_string()
            .contains("The provider rejected the inference request.")
    );
    installation.command("stop");
    installation.command("start");
    let (_, token) = installation.client();
    let restored: Value = client
        .get(format!("http://happy/v0/agents/{AGENT}/messages"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("restored failure")
        .json()
        .await
        .expect("page");
    assert_eq!(restored["runs"], page["runs"]);
    provider.await.expect("one failed inference");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_complex_arguments_are_accepted_retained_and_fail_the_tool_before_execution() {
    let (endpoint, mut requests, provider) = scripted_provider(1).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    let database =
        Connection::open(installation.home.join("agent/agent.sqlite")).expect("original catalog");
    database
        .execute(
            "DELETE FROM happy_agent_values WHERE owner_id=?1 OR (owner_id='' AND key=?2)",
            params![AGENT, format!("agentSystem.config.{AGENT}")],
        )
        .expect("empty original catalog");
    database
        .execute(
            "DELETE FROM happy_agent_module_project_root_agents WHERE agent_id=?1",
            [AGENT],
        )
        .expect("empty project roots");
    drop(database);
    installation.command("start");
    let (client, token) = installation.client();
    let agent = "agentcomplexrequest";
    let created = client
        .post("http://happy/v0/agents")
        .bearer_auth(&token)
        .json(&json!({"workspaceId":WORKSPACE,"id":agent}))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    let mut nested = json!(true);
    for _ in 0..9 {
        nested = json!({"child":nested});
    }
    let control = json!({"type":"tool_call_request","name":"exec_command","arguments":{"cmd":"printf unexpected > complex-side-effect","complex":nested}});
    let body = json!({"id":"messagecomplexrequest","text":"Handle this requested tool.","profile":null,"mode":{"providerId":"fixture","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"full_access"},"content":[control]});
    let response = client
        .post(format!("http://happy/v0/agents/{agent}/send"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .expect("accept explicit input");
    assert_eq!(response.status(), 202);
    let inference = exchange(&mut requests).await;
    assert!(
        inference
            .request
            .to_string()
            .contains("Tool arguments exceed the supported size or complexity limits."),
        "ordinary failed result reaches inference: {}",
        inference.request
    );
    let page: Value = client
        .get(format!("http://happy/v0/agents/{agent}/messages"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("history")
        .json()
        .await
        .expect("page");
    let messages = page["runs"][0]["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["content"][1], control);
    assert_eq!(messages[1]["content"][0]["arguments"], control["arguments"]);
    assert_eq!(messages[1]["content"][0]["status"], "failed");
    assert!(
        !installation
            ._directory
            .path()
            .join("workspace/complex-side-effect")
            .exists()
    );
    inference
        .respond
        .send(text_response("The requested arguments were too complex."))
        .expect("normal continuation");
    provider.await.expect("one continuation inference");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_arguments_larger_than_private_event_limit_still_enter_canonical_history() {
    let installation = Installation::new();
    installation.seed("http://127.0.0.1:1/v1");
    let database =
        Connection::open(installation.home.join("agent/agent.sqlite")).expect("original catalog");
    database
        .execute(
            "DELETE FROM happy_agent_values WHERE owner_id=?1 OR (owner_id='' AND key=?2)",
            params![AGENT, format!("agentSystem.config.{AGENT}")],
        )
        .expect("empty original catalog");
    database
        .execute(
            "DELETE FROM happy_agent_module_project_root_agents WHERE agent_id=?1",
            [AGENT],
        )
        .expect("empty project roots");
    drop(database);
    installation.command("start");
    let (client, token) = installation.client();
    let agent = "agentlargerequest";
    let created = client
        .post("http://happy/v0/agents")
        .bearer_auth(&token)
        .json(&json!({"workspaceId":WORKSPACE,"id":agent}))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    let control = json!({"type":"tool_call_request","name":"exec_command","arguments":{"cmd":"printf unexpected > large-side-effect","value":"x".repeat(6 * 1024 * 1024)}});
    let body = json!({"id":"messagelargerequest","text":"Handle this requested tool.","profile":null,"mode":{"providerId":"fixture","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"full_access"},"content":[control]});
    let response = client
        .post(format!("http://happy/v0/agents/{agent}/send"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .expect("accept large explicit input");
    let status = response.status();
    let accepted: Value = response.json().await.expect("accepted resource");
    assert_eq!(status, 202, "{accepted}");
    assert_eq!(accepted["message"]["content"][1], control);
    let page = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let page: Value = client
                .get(format!("http://happy/v0/agents/{agent}/messages"))
                .bearer_auth(&token)
                .send()
                .await
                .expect("history")
                .json()
                .await
                .expect("page");
            if page["runs"][0]["messages"]
                .as_array()
                .is_some_and(|messages| {
                    messages.len() >= 2 && messages[1]["content"][0]["status"] == "failed"
                })
            {
                break page;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("failed tool preserves accepted input");
    assert_eq!(page["runs"][0]["messages"][0]["content"][1], control);
    assert_eq!(
        page["runs"][0]["messages"][1]["content"][0]["arguments"],
        control["arguments"]
    );
    assert!(
        page["runs"][0]["messages"][1]["content"][0]["result"]["output"]
            .as_str()
            .expect("failed result")
            .contains("Tool arguments exceed the supported size or complexity limits.")
    );
    assert!(
        !installation
            ._directory
            .path()
            .join("workspace/large-side-effect")
            .exists()
    );
    let events: Value = client
        .get("http://happy/v0/events?limit=1000")
        .bearer_auth(&token)
        .send()
        .await
        .expect("public journal")
        .json()
        .await
        .expect("events");
    let pending = events["events"]
        .as_array()
        .expect("events")
        .iter()
        .find(|event| {
            event["type"] == "message.created"
                && event["payload"]["message"]["id"] == "messagelargerequest"
        })
        .expect("exact public pending event");
    assert_eq!(pending["payload"]["message"]["content"][1], control);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn common_history_tool_reads_an_original_archive_and_an_uncreated_agent_in_read_only() {
    let (endpoint, mut requests, provider) = scripted_provider(2).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    let database =
        Connection::open(installation.home.join("agent/agent.sqlite")).expect("original catalog");
    database
        .execute(
            "DELETE FROM happy_agent_values WHERE owner_id=?1 OR (owner_id='' AND key=?2)",
            params![AGENT, format!("agentSystem.config.{AGENT}")],
        )
        .expect("keep archive without active fixture agent");
    database
        .execute(
            "DELETE FROM happy_agent_module_project_root_agents WHERE agent_id=?1",
            [AGENT],
        )
        .expect("empty project roots");
    drop(database);
    installation.command("start");
    let (client, token) = installation.client();
    let agent = "agenthistoryreader";
    let response = client
        .post("http://happy/v0/agents")
        .bearer_auth(&token)
        .json(&json!({"workspaceId":WORKSPACE,"id":agent}))
        .send()
        .await
        .expect("create reader");
    assert_eq!(response.status(), 201);
    let body = json!({"id":"messagehistoryreader","text":"Read the original archive, then the empty agent.","profile":null,"mode":{"providerId":"fixture","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"read_only"},"content":[{"type":"tool_call_request","name":"read_agent_history","arguments":{"target":AGENT,"from":"begin","limit":1,"query":"finish","roles":["user"],"include_tools":false}}]});
    let response = client
        .post(format!("http://happy/v0/agents/{agent}/send"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .expect("read-only common tool");
    assert_eq!(response.status(), 202);
    let first = exchange(&mut requests).await;
    let output = first.request["input"]
        .as_array()
        .expect("input")
        .iter()
        .find(|item| item["type"] == "function_call_output")
        .expect("history tool result")["output"]
        .as_str()
        .expect("JSON tool output");
    let result: Value = serde_json::from_str(output).expect("common history result");
    assert_eq!(result["target"], AGENT);
    assert_eq!(result["cursor"], 0);
    assert_eq!(result["total_messages"], 1);
    assert_eq!(result["matched_messages"], 1);
    assert_eq!(result["returned_messages"], 1);
    assert!(
        result["history"]
            .as_str()
            .expect("readable archive")
            .contains("1. USER\nText: Finish the original tool and continue.")
    );
    assert!(result.get("previous_cursor").is_none());
    assert_eq!(result["stats"]["returned"]["user_messages"], 1);
    assert_eq!(result["agents"].as_array().expect("roster").len(), 2);
    assert!(
        first.request["tools"]
            .as_array()
            .expect("fixed common array")
            .iter()
            .any(|tool| tool["name"] == "read_agent_history")
    );
    first.respond.send(vec![json!({"type":"response.output_item.added","item":{"type":"function_call","call_id":"native-empty-history","name":"read_agent_history"}}), json!({"type":"response.function_call_arguments.delta","delta":json!({"target":"agentnevercreated","from":"last","include_tools":false}).to_string()}), json!({"type":"response.function_call_arguments.done"}), json!({"type":"response.completed","response":{"id":"history-call-response","output":[],"usage":{"input_tokens":10,"output_tokens":2}}})]).expect("generated common history call");
    let second = exchange(&mut requests).await;
    let output = second.request["input"]
        .as_array()
        .expect("input")
        .iter()
        .find(|item| {
            item["type"] == "function_call_output" && item["call_id"] == "native-empty-history"
        })
        .expect("native call identity")["output"]
        .as_str()
        .expect("JSON output");
    let empty: Value = serde_json::from_str(output).expect("empty history result");
    assert_eq!(empty["target"], "agentnevercreated");
    assert_eq!(empty["total_messages"], 0);
    assert_eq!(empty["returned_messages"], 0);
    assert_eq!(empty["history"], "");
    assert_eq!(empty["agents"][1]["status"], "unknown");
    second
        .respond
        .send(text_response("Both archives inspected."))
        .expect("normal continuation");
    provider.await.expect("two native inferences");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_complex_provider_arguments_keep_raw_history_and_use_the_tool_schema() {
    let (endpoint, mut requests, provider) = scripted_provider(2).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let first = exchange(&mut requests).await;
    let mut nested = json!(true);
    for _ in 0..9 {
        nested = json!({"child":nested});
    }
    let arguments =
        json!({"cmd":"printf unexpected > ordinary-side-effect","complex":nested}).to_string();
    first.respond.send(vec![json!({"type":"response.output_item.added","item":{"type":"function_call","call_id":"native-complex-ordinary","name":"exec_command"}}),json!({"type":"response.function_call_arguments.delta","delta":arguments}),json!({"type":"response.function_call_arguments.done"}),json!({"type":"response.completed","response":{"id":"complex-response","output":[],"usage":{"input_tokens":10,"output_tokens":2}}})]).expect("ordinary provider call");
    let second = exchange(&mut requests).await;
    let output = second.request["input"]
        .as_array()
        .expect("input")
        .iter()
        .find(|item| {
            item["type"] == "function_call_output" && item["call_id"] == "native-complex-ordinary"
        })
        .expect("ordinary result")["output"]
        .as_str()
        .expect("output");
    assert_eq!(output, "The command arguments are invalid.");
    let (client, token) = installation.client();
    let page: Value = client
        .get(format!("http://happy/v0/agents/{AGENT}/messages"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("history")
        .json()
        .await
        .expect("page");
    let call = &page["runs"][0]["messages"][2]["content"][0];
    assert_eq!(call["arguments"], arguments);
    assert_eq!(call["status"], "failed");
    assert!(
        !installation
            ._directory
            .path()
            .join("workspace/ordinary-side-effect")
            .exists()
    );
    second
        .respond
        .send(text_response("Invalid ordinary arguments handled."))
        .expect("continuation");
    provider.await.expect("two native inferences");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_tool_matches_original_source_goldens_for_search_paging_statistics_and_budget() {
    let goldens: Value = serde_json::from_str(include_str!("history_tool_goldens.json"))
        .expect("original source goldens");
    let cases = goldens["cases"].as_array().expect("cases");
    let (endpoint, mut requests, provider) = scripted_provider(cases.len()).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    let database =
        Connection::open(installation.home.join("agent/agent.sqlite")).expect("original catalog");
    database
        .execute(
            "DELETE FROM happy_agent_values WHERE owner_id=?1 OR (owner_id='' AND key=?2)",
            params![AGENT, format!("agentSystem.config.{AGENT}")],
        )
        .expect("empty catalog");
    database
        .execute(
            "DELETE FROM happy_agent_module_project_root_agents WHERE agent_id=?1",
            [AGENT],
        )
        .expect("empty project roots");
    for row in goldens["rows"].as_array().expect("original archive rows") {
        let message = &row["message"];
        let counters = &row["stats"];
        database.execute("INSERT INTO happy_agent_module_history(agent_id,position,record_id,role,message_json,search_text,assistant_messages,user_messages,text_characters,thinking_blocks,tool_calls,tool_results) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",params![row["agentId"].as_str(),row["position"].as_i64(),message["recordId"].as_str(),message["role"].as_str(),message.to_string(),row["searchText"].as_str(),counters["assistantMessages"].as_i64(),counters["userMessages"].as_i64(),counters["textCharacters"].as_i64(),counters["thinkingBlocks"].as_i64(),counters["toolCalls"].as_i64(),counters["toolResults"].as_i64()]).expect("original source archive fixture");
    }
    drop(database);
    installation.command("start");
    let (client, token) = installation.client();
    let agent = "agentgoldenreader";
    let created = client
        .post("http://happy/v0/agents")
        .bearer_auth(&token)
        .json(&json!({"workspaceId":WORKSPACE,"id":agent}))
        .send()
        .await
        .expect("create reader");
    assert_eq!(created.status(), 201);
    for (index, case) in cases.iter().enumerate() {
        let body = json!({"id":format!("messagehistorygolden{index:02}"),"text":"Read the selected durable archive.","profile":null,"mode":{"providerId":"fixture","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"read_only"},"content":[{"type":"tool_call_request","name":"read_agent_history","arguments":case["arguments"]}]});
        let sent = client
            .post(format!("http://happy/v0/agents/{agent}/send"))
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .expect("request golden read");
        assert_eq!(sent.status(), 202, "case {index}");
        let inference = exchange(&mut requests).await;
        let output = inference.request["input"]
            .as_array()
            .expect("input")
            .iter()
            .rev()
            .find(|item| item["type"] == "function_call_output")
            .expect("latest read result")["output"]
            .as_str()
            .expect("JSON result");
        let mut result: Value = serde_json::from_str(output).expect("history result");
        let roster = result
            .as_object_mut()
            .expect("result")
            .remove("agents")
            .expect("roster");
        let caller = roster
            .as_array()
            .expect("agents")
            .iter()
            .find(|entry| entry["agent_id"] == agent)
            .expect("calling agent");
        assert_eq!(caller["message_count"], 2 + 3 * index);
        assert_eq!(
            result, case["expected"],
            "original source golden case {index}"
        );
        inference
            .respond
            .send(text_response("Archive read completed."))
            .expect("normal continuation");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let focused: Value = client
                    .get(format!("http://happy/v0/agents/{agent}"))
                    .bearer_auth(&token)
                    .send()
                    .await
                    .expect("focused agent")
                    .json()
                    .await
                    .expect("resource");
                if focused["agent"]["status"] == "idle" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("settled golden turn");
    }
    installation.command("stop");
    installation.command("start");
    let (_, token) = installation.client();
    let page: Value = client
        .get(format!("http://happy/v0/agents/{agent}/messages"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("restored history")
        .json()
        .await
        .expect("page");
    assert_eq!(page["runs"].as_array().expect("runs").len(), cases.len());
    assert!(page["runs"].as_array().expect("runs").iter().all(|run| {
        run["status"] == "completed"
            && run["messages"]
                .as_array()
                .is_some_and(|messages| messages.len() == 3)
    }));
    provider.await.expect("all golden native turns");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_retry_discards_completed_tool_items_before_any_tool_effect() {
    let (endpoint, mut requests, provider) = scripted_provider(2).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let first = exchange(&mut requests).await;
    let input = first.request["input"].clone();
    first.respond.send(vec![json!({"type":"response.output_item.added","item":{"type":"function_call","call_id":"native-abandoned-retry-tool","name":"exec_command"}}),json!({"type":"response.function_call_arguments.delta","delta":json!({"cmd":"printf stale > stale-provider-effect"}).to_string()}),json!({"type":"response.function_call_arguments.done"}),json!({"type":"response.failed","response":{"status":503,"error":{"code":"server_error","message":"Retry this incomplete provider attempt."}}})]).expect("abandoned retryable attempt");
    let retry = exchange(&mut requests).await;
    assert_eq!(
        retry.request["input"], input,
        "provider owns replay of the original immutable request"
    );
    retry
        .respond
        .send(text_response("Successful retry response."))
        .expect("successful provider retry");
    let page = completed(&installation).await;
    let messages = page["runs"][0]["messages"]
        .as_array()
        .expect("settled messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(
        messages[2]["content"],
        json!([{"type":"text","text":"Successful retry response."}])
    );
    assert!(!page.to_string().contains("native-abandoned-retry-tool"));
    assert!(
        !installation
            ._directory
            .path()
            .join("workspace/stale-provider-effect")
            .exists()
    );
    installation.command("stop");
    installation.command("start");
    let (client, token) = installation.client();
    let restored: Value = client
        .get(format!("http://happy/v0/agents/{AGENT}/messages"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("restored retry result")
        .json()
        .await
        .expect("page");
    assert_eq!(restored["runs"], page["runs"]);
    assert!(
        !installation
            ._directory
            .path()
            .join("workspace/stale-provider-effect")
            .exists()
    );
    provider.await.expect("exactly two provider attempts");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compatible_model_switch_retains_context_and_incompatible_switch_hands_off_public_history()
{
    let (endpoint, mut requests, provider) = scripted_provider(3).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    let public = installation
        ._directory
        .path()
        .join(if cfg!(target_os = "macos") {
            "Happy/Config/happy.toml"
        } else {
            "happy/config/happy.toml"
        });
    let configuration = std::fs::read_to_string(&public)
        .expect("fixture configuration")
        .replace(
            "include_models = ['openai/gpt-5.6-sol']",
            "include_models = ['openai/gpt-5.6-sol', 'openai/gpt-5.6-luna']",
        );
    std::fs::write(&public,format!("{configuration}\n[providers.switch-fixture]\ntype = 'grok'\napi_key = 'fixture-placeholder'\ncredential_isolation = true\nenabled = true\nbase_url = '{endpoint}'\ntransport = 'sse'\ninclude_models = ['xai/grok-4.6']\n")).expect("two curated fixture routes");
    let database =
        Connection::open(installation.home.join("agent/agent.sqlite")).expect("original catalog");
    database
        .execute(
            "DELETE FROM happy_agent_values WHERE owner_id=?1 OR (owner_id='' AND key=?2)",
            params![AGENT, format!("agentSystem.config.{AGENT}")],
        )
        .expect("empty catalog");
    database
        .execute(
            "DELETE FROM happy_agent_module_project_root_agents WHERE agent_id=?1",
            [AGENT],
        )
        .expect("empty project roots");
    drop(database);
    installation.command("start");
    let (client, token) = installation.client();
    let agent = "agentmodelhandoff";
    let created = client
        .post("http://happy/v0/agents")
        .bearer_auth(&token)
        .json(&json!({"workspaceId":WORKSPACE,"id":agent}))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    for (index, (provider_id, model, effort, text)) in [
        (
            "fixture",
            "openai/gpt-5.6-sol",
            "medium",
            "Remember the original request.",
        ),
        (
            "fixture",
            "openai/gpt-5.6-luna",
            "medium",
            "Continue with the compatible model.",
        ),
        (
            "switch-fixture",
            "xai/grok-4.6",
            "high",
            "Continue with the incompatible model.",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let body = json!({"id":format!("messagemodelhandoff{index}"),"text":text,"profile":null,"mode":{"providerId":provider_id,"modelId":model,"effort":effort,"serviceTier":null,"permissionMode":"full_access"}});
        let sent = client
            .post(format!("http://happy/v0/agents/{agent}/send"))
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .expect("send selected model");
        assert_eq!(sent.status(), 202);
        let inference = exchange(&mut requests).await;
        let input = inference.request["input"]
            .as_array()
            .expect("provider input");
        if index == 1 {
            assert!(input.iter().any(|item| item["role"] == "user"
                && item["content"] == "Remember the original request."));
            assert!(input.iter().any(|item| item["role"] == "assistant"
                && item["content"][0]["text"] == "A prior assistant answer."));
            assert!(
                !inference
                    .request
                    .to_string()
                    .contains("model-switch-history-context")
            );
        }
        if index == 2 {
            assert_eq!(input.len(), 2, "fresh private context: {input:?}");
            assert_eq!(input[0]["role"], "developer");
            let notice = input[0]["content"][0]["text"]
                .as_str()
                .expect("handoff notice");
            assert!(notice.contains("<model-switch-history-context>"));
            assert!(notice.contains("Beginning history excerpt:"));
            assert!(notice.contains("Remember the original request."));
            assert!(notice.contains("read_agent_history"));
            let golden: Value = serde_json::from_str(include_str!("model_switch_goldens.json"))
                .expect("original handoff golden");
            assert_eq!(notice, golden["notice"].as_str().expect("source notice"));
            assert_eq!(input[1]["role"], "user");
            assert_eq!(input[1]["content"], text);
        }
        inference
            .respond
            .send(text_response(if index == 0 {
                "A prior assistant answer."
            } else {
                "Selected model completed."
            }))
            .expect("provider response");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let focused: Value = client
                    .get(format!("http://happy/v0/agents/{agent}"))
                    .bearer_auth(&token)
                    .send()
                    .await
                    .expect("focused agent")
                    .json()
                    .await
                    .expect("resource");
                if focused["agent"]["status"] == "idle" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("settled turn");
    }
    let page: Value = client
        .get(format!("http://happy/v0/agents/{agent}/messages"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("public archive")
        .json()
        .await
        .expect("page");
    assert_eq!(page["runs"].as_array().expect("runs").len(), 3);
    assert!(page["runs"].as_array().expect("runs").iter().all(|run| {
        run["status"] == "completed"
            && run["messages"]
                .as_array()
                .is_some_and(|messages| messages.len() == 2)
    }));
    installation.command("stop");
    installation.command("start");
    let (_, token) = installation.client();
    let restored: Value = client
        .get(format!("http://happy/v0/agents/{agent}/messages"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("model-switch archive after restart")
        .json()
        .await
        .expect("page");
    assert_eq!(restored["runs"], page["runs"]);
    provider.await.expect("three real selected model turns");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn regular_tier_clears_priority_while_effort_and_permission_changes_preserve_context() {
    let (endpoint, mut requests, provider) = scripted_provider(2).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    let database =
        Connection::open(installation.home.join("agent/agent.sqlite")).expect("original catalog");
    database
        .execute(
            "DELETE FROM happy_agent_values WHERE owner_id=?1 OR (owner_id='' AND key=?2)",
            params![AGENT, format!("agentSystem.config.{AGENT}")],
        )
        .expect("empty catalog");
    database
        .execute(
            "DELETE FROM happy_agent_module_project_root_agents WHERE agent_id=?1",
            [AGENT],
        )
        .expect("empty project roots");
    drop(database);
    installation.command("start");
    let (client, token) = installation.client();
    let agent = "agenttiercontext";
    assert_eq!(
        client
            .post("http://happy/v0/agents")
            .bearer_auth(&token)
            .json(&json!({"workspaceId":WORKSPACE,"id":agent}))
            .send()
            .await
            .expect("create")
            .status(),
        201
    );
    for (index, (tier, effort, permission)) in [
        (json!("priority"), "medium", "full_access"),
        (Value::Null, "high", "read_only"),
    ]
    .into_iter()
    .enumerate()
    {
        let mode = json!({"providerId":"fixture","modelId":"openai/gpt-5.6-sol","effort":effort,"serviceTier":tier,"permissionMode":permission});
        assert_eq!(client.post(format!("http://happy/v0/agents/{agent}/send")).bearer_auth(&token).json(&json!({"id":format!("messagetiercontext{index}"),"text":format!("Tier context turn {index}."),"profile":null,"mode":mode})).send().await.expect("send tier selection").status(),202);
        let inference = exchange(&mut requests).await;
        assert_eq!(inference.request["reasoning"]["effort"], effort);
        if index == 0 {
            assert_eq!(inference.request["service_tier"], "priority");
        } else {
            assert!(
                inference.request.get("service_tier").is_none(),
                "regular tier omits the provider option"
            );
            assert!(
                inference.request["input"]
                    .as_array()
                    .expect("input")
                    .iter()
                    .any(|item| item["role"] == "assistant"
                        && item["content"][0]["text"] == "Prior tier context answer.")
            );
            assert!(
                !inference
                    .request
                    .to_string()
                    .contains("model-switch-history-context")
            );
        }
        inference
            .respond
            .send(text_response(if index == 0 {
                "Prior tier context answer."
            } else {
                "Regular tier completed."
            }))
            .expect("provider response");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let focused: Value = client
                    .get(format!("http://happy/v0/agents/{agent}"))
                    .bearer_auth(&token)
                    .send()
                    .await
                    .expect("focused agent")
                    .json()
                    .await
                    .expect("resource");
                if focused["agent"]["status"] == "idle" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("settled turn");
    }
    let mode: Value = client
        .get(format!("http://happy/v0/agents/{agent}/mode"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("last selected mode")
        .json()
        .await
        .expect("mode");
    assert!(mode["mode"]["serviceTier"].is_null());
    assert_eq!(mode["mode"]["effort"], "high");
    assert_eq!(mode["mode"]["permissionMode"], "read_only");
    installation.command("stop");
    let database = Connection::open(installation.home.join("agent/agent.sqlite"))
        .expect("persisted selection");
    let settings: String = database
        .query_row(
            "SELECT value_json FROM happy_agent_values WHERE owner_id=?1 AND key='settings'",
            [agent],
            |row| row.get(0),
        )
        .expect("settings");
    let settings: Value = serde_json::from_str(&settings).expect("selected settings");
    assert!(settings.get("serviceTier").is_none());
    provider.await.expect("two provider turns");
}

fn command_response(id: &str, name: &str, arguments: Value) -> Vec<Value> {
    vec![
        json!({"type":"response.output_item.added","item":{"type":"function_call","id":format!("item-{id}"),"call_id":id,"name":name}}),
        json!({"type":"response.function_call_arguments.delta","item_id":format!("item-{id}"),"delta":arguments.to_string()}),
        json!({"type":"response.function_call_arguments.done","arguments":arguments.to_string()}),
        json!({"type":"response.output_item.done","item":{"type":"function_call","id":format!("item-{id}"),"call_id":id,"name":name,"arguments":arguments.to_string()}}),
        json!({"type":"response.completed","response":{"id":format!("response-{id}"),"output":[],"usage":{"input_tokens":10,"output_tokens":2}}}),
    ]
}

fn command_output(request: &Value, id: &str) -> String {
    request["input"]
        .as_array()
        .expect("provider context")
        .iter()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == id)
        .expect("native call result")["output"]
        .as_str()
        .expect("command output")
        .to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn yielded_command_accepts_input_reads_only_new_output_and_stops_the_process_group() {
    let (endpoint, mut requests, provider) = scripted_provider(5).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let first = exchange(&mut requests).await;
    let command = "printf 'session-ready\\n'; mkfifo descendant-input; (exec 3<> descendant-input; printf 'descendant-ready\\n'; IFS= read -r released <&3; printf 'escaped' > descendant-effect) & IFS= read -r first || exec sleep 20; printf 'accepted:%s\\n' \"$first\"; IFS= read -r second; printf 'unexpected-%s\\n' completion";
    first
        .respond
        .send(command_response(
            "native-session-start",
            "exec_command",
            json!({"cmd":command,"yield_time_ms":250}),
        ))
        .expect("start interactive command");
    let after_start = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap_or_else(|error| {
            panic!(
                "The yielded command did not continue: {error}; daemon log: {}",
                std::fs::read_to_string(installation.home.join("agent/daemon.log"))
                    .unwrap_or_default()
            )
        })
        .expect("command continuation");
    let output = command_output(&after_start.request, "native-session-start");
    assert!(output.contains("session-ready"), "{output}");
    assert!(
        output.contains("descendant-ready"),
        "the descendant opened its real input pipe"
    );
    let session: u64 = output
        .lines()
        .find_map(|line| line.strip_prefix("Process running with session ID "))
        .expect("yielded session identity")
        .parse()
        .expect("positive integer session");
    assert!(session > 0);
    after_start
        .respond
        .send(command_response(
            "native-session-input",
            "write_stdin",
            json!({"session_id":session,"chars":"hello-session\n","yield_time_ms":250}),
        ))
        .expect("type into yielded command");
    let after_input = exchange(&mut requests).await;
    let output = command_output(&after_input.request, "native-session-input");
    assert!(output.contains("accepted:hello-session"), "{output}");
    assert!(
        !output.contains("session-ready"),
        "initial output must not repeat: {output}"
    );
    assert!(
        output.contains(&format!("Process running with session ID {session}")),
        "{output}"
    );
    after_input
        .respond
        .send(command_response(
            "native-session-poll",
            "write_stdin",
            json!({"session_id":session,"yield_time_ms":0}),
        ))
        .expect("poll yielded command");
    let after_poll = exchange(&mut requests).await;
    let output = command_output(&after_poll.request, "native-session-poll");
    assert!(output.contains("(no new output)"), "{output}");
    assert!(!output.contains("accepted:hello-session"));
    after_poll
        .respond
        .send(command_response(
            "native-session-stop",
            "kill_session",
            json!({"session_id":session}),
        ))
        .expect("stop yielded command");
    let after_stop = exchange(&mut requests).await;
    let output = command_output(&after_stop.request, "native-session-stop");
    assert!(
        output.starts_with("The shell session was stopped."),
        "{output}"
    );
    assert!(!output.contains("unexpected-completion"));
    use std::os::unix::fs::OpenOptionsExt;
    let pipe = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(
            installation
                ._directory
                .path()
                .join("workspace/descendant-input"),
        );
    assert_eq!(
        pipe.expect_err("the descendant no longer holds a reader")
            .raw_os_error(),
        Some(libc::ENXIO)
    );
    assert!(
        !installation
            ._directory
            .path()
            .join("workspace/descendant-effect")
            .exists()
    );
    after_stop
        .respond
        .send(text_response("The interactive command was stopped."))
        .expect("finish turn");
    let page = completed(&installation).await;
    let messages = page["runs"][0]["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 7);
    let call_ids: Vec<_> = messages
        .iter()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .filter(|block| block["type"] == "tool_call")
        .map(|block| block["id"].as_str().expect("Base call identity"))
        .collect();
    assert_eq!(call_ids.len(), 5);
    installation.command("stop");
    provider.await.expect("five actual inference exchanges");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn yielded_command_survives_turn_completion_and_permission_reduction_stops_it_before_restart()
{
    let (endpoint, mut requests, provider) = scripted_provider(4).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let first = exchange(&mut requests).await;
    first.respond.send(command_response("native-detached-start","exec_command",json!({"cmd":"mkfifo background-input; exec 3<> background-input; printf 'background-ready\\n'; IFS= read -r released <&3; printf '%s' \"$released\" > background-effect","yield_time_ms":250}))).expect("start background command");
    let after_start = exchange(&mut requests).await;
    let output = command_output(&after_start.request, "native-detached-start");
    let session: u64 = output
        .lines()
        .find_map(|line| line.strip_prefix("Process running with session ID "))
        .expect("yielded handle")
        .parse()
        .expect("session");
    assert!(output.contains("background-ready"));
    after_start
        .respond
        .send(text_response("The command keeps running after this turn."))
        .expect("finish owning turn");
    let first_page = completed(&installation).await;
    use std::os::unix::fs::OpenOptionsExt;
    let input = installation
        ._directory
        .path()
        .join("workspace/background-input");
    drop(
        std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&input)
            .expect("the completed turn retains its yielded command"),
    );
    let (client, token) = installation.client();
    let mode = json!({"providerId":"fixture","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"read_only"});
    assert_eq!(client.post(format!("http://happy/v0/agents/{AGENT}/send")).bearer_auth(&token).json(&json!({"id":"messagepermissionreduction","text":"Continue in Read only.","profile":null,"mode":mode})).send().await.expect("reduce permissions").status(),202);
    let restricted = exchange(&mut requests).await;
    let pipe = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&input);
    assert_eq!(
        pipe.expect_err("permission reduction stops existing commands before inference")
            .raw_os_error(),
        Some(libc::ENXIO)
    );
    restricted
        .respond
        .send(text_response("Read only continuation completed."))
        .expect("finish restricted turn");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let focused: Value = client
                .get(format!("http://happy/v0/agents/{AGENT}"))
                .bearer_auth(&token)
                .send()
                .await
                .expect("agent")
                .json()
                .await
                .expect("resource");
            if focused["agent"]["status"] == "idle" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("settled restricted turn");
    installation.command("stop");
    installation.command("start");
    let (_, token) = installation.client();
    assert_eq!(client.post(format!("http://happy/v0/agents/{AGENT}/send")).bearer_auth(&token).json(&json!({"id":"messagerestartedsession","text":"Report the old command handle.","content":[{"type":"tool_call_request","name":"write_stdin","arguments":{"session_id":session,"yield_time_ms":0}}],"profile":null,"mode":mode})).send().await.expect("old session after restart").status(),202);
    let restarted = exchange(&mut requests).await;
    assert!(
        restarted
            .request
            .to_string()
            .contains(&format!("There is no command {session} on this machine."))
    );
    restarted
        .respond
        .send(text_response("The prior daemon's session is gone."))
        .expect("finish restart report");
    let page = completed(&installation).await;
    assert_eq!(page["runs"].as_array().expect("runs").len(), 3);
    assert_eq!(page["runs"][0], first_page["runs"][0]);
    assert!(
        !installation
            ._directory
            .path()
            .join("workspace/background-effect")
            .exists()
    );
    installation.command("stop");
    provider.await.expect("four actual inference exchanges");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_history_counts_utf16_characters_and_discloses_omitted_output() {
    let (endpoint, mut requests, provider) = scripted_provider(2).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let first = exchange(&mut requests).await;
    first
        .respond
        .send(command_response(
            "native-unicode-history",
            "exec_command",
            json!({"cmd":"printf '界%.0s' {1..20000}","max_output_tokens":10000}),
        ))
        .expect("unicode output");
    let after_command = exchange(&mut requests).await;
    let full = command_output(&after_command.request, "native-unicode-history");
    assert_eq!(full.matches('界').count(), 20000);
    after_command
        .respond
        .send(text_response("The Unicode output is retained and bounded."))
        .expect("finish");
    let page = completed(&installation).await;
    let call = page["runs"][0]["messages"][2]["content"][0].clone();
    let retained = full.chars().take(16000).collect::<String>();
    let expected = format!(
        "{retained}\n...[truncated {} chars]",
        full.encode_utf16().count() - 16000
    );
    assert_eq!(call["result"]["output"], expected);
    installation.command("stop");
    let database =
        Connection::open(installation.home.join("agent/agent.sqlite")).expect("canonical history");
    let stored:String=database.query_row("SELECT history.message_json FROM happy_agent_module_history history JOIN happy_agent_module_history_tool_calls calls ON history.agent_id=calls.agent_id AND history.record_id=calls.record_id WHERE calls.agent_id=?1 AND calls.call_id=?2",params![AGENT,call["id"].as_str().expect("call identity")],|row|row.get(0)).expect("indexed owning history");
    let stored: Value = serde_json::from_str(&stored).expect("stored history");
    let result = stored["blocks"]
        .as_array()
        .expect("blocks")
        .iter()
        .find(|block| block["type"] == "tool_result")
        .expect("result");
    assert_eq!(
        result["display"],
        format!(
            "Tool exec_command returned {} characters.",
            expected.encode_utf16().count()
        )
    );
    provider.await.expect("two provider exchanges");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_shutdown_closes_a_yielded_command_after_its_turn_and_restart_preserves_history() {
    let (endpoint, mut requests, provider) = scripted_provider(2).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let first = exchange(&mut requests).await;
    first.respond.send(command_response("native-shutdown-session","exec_command",json!({"cmd":"mkfifo shutdown-input; exec 3<> shutdown-input; printf 'shutdown-session-ready\\n'; IFS= read -r released <&3; printf '%s' \"$released\" > shutdown-effect","yield_time_ms":250}))).expect("yielded shutdown session");
    let after_start = exchange(&mut requests).await;
    let output = command_output(&after_start.request, "native-shutdown-session");
    assert!(output.contains("Process running with session ID "));
    assert!(output.contains("shutdown-session-ready"));
    after_start
        .respond
        .send(text_response("The command remains owned by this daemon."))
        .expect("finish turn");
    let page = completed(&installation).await;
    use std::os::unix::fs::OpenOptionsExt;
    let input = installation
        ._directory
        .path()
        .join("workspace/shutdown-input");
    drop(
        std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&input)
            .expect("yielded process survives turn completion"),
    );
    installation.command("stop");
    assert_eq!(
        std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&input)
            .expect_err("shutdown closes the whole owned execution")
            .raw_os_error(),
        Some(libc::ENXIO)
    );
    assert!(
        !installation
            ._directory
            .path()
            .join("workspace/shutdown-effect")
            .exists()
    );
    installation.command("start");
    let restored = completed(&installation).await;
    assert_eq!(restored["runs"], page["runs"]);
    installation.command("stop");
    provider.await.expect("no process replay inference");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_during_initial_command_wait_preserves_the_claim_and_never_repeats_the_effect() {
    let (endpoint, mut requests, provider) = scripted_provider(2).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let first = exchange(&mut requests).await;
    first.respond.send(command_response("native-initial-wait","exec_command",json!({"cmd":"printf 'one initial execution\\n' >> initial-wait-effect; IFS= read -r input; printf 'initial-wait-finished\\n'","yield_time_ms":30000}))).expect("foreground command");
    let effect = installation
        ._directory
        .path()
        .join("workspace/initial-wait-effect");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if std::fs::read_to_string(&effect).is_ok_and(|text| text == "one initial execution\n")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the real command started before cancellation");
    let (client, token) = installation.client();
    assert_eq!(
        client
            .post("http://happy/v0/shutdown")
            .bearer_auth(&token)
            .send()
            .await
            .expect("shutdown cancels the initial wait")
            .status(),
        202
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !installation.home.join("agent/daemon.pid").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("shutdown released database ownership and its process identity");
    let database = Connection::open(installation.home.join("agent/agent.sqlite"))
        .expect("durable command claim");
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM happy_agent_values WHERE owner_id=?1 AND key GLOB 'tool.*'",
                [AGENT],
                |row| row.get::<_, i64>(0)
            )
            .expect("dispatched nonreloadable claim"),
        1
    );
    drop(database);
    installation.command("start");
    let restarted = exchange(&mut requests).await;
    let output = command_output(&restarted.request, "native-initial-wait");
    assert_eq!(
        output,
        "The tool call was interrupted by a restart and was not retried."
    );
    restarted
        .respond
        .send(text_response("The interrupted command was not repeated."))
        .expect("finish original run");
    let page = completed(&installation).await;
    assert_eq!(page["runs"].as_array().expect("runs").len(), 1);
    assert_eq!(
        std::fs::read_to_string(&effect).expect("effect"),
        "one initial execution\n"
    );
    installation.command("stop");
    provider.await.expect("two provider exchanges");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_auto_review_uses_private_inference_and_elevates_only_the_reviewed_command() {
    use sha2::{Digest, Sha256};
    let (endpoint, mut requests, provider) = scripted_provider(4).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    database.execute("DELETE FROM happy_agent_values WHERE owner_id=?1 OR (owner_id='' AND key=?2)", params![AGENT, format!("agentSystem.config.{AGENT}")]).unwrap();
    database.execute("DELETE FROM happy_agent_module_project_root_agents WHERE agent_id=?1", [AGENT]).unwrap();
    drop(database);
    installation.command("start");
    let (client, token) = installation.client();
    let agent = "agentfreshreviewfixture";
    let created = client.post("http://happy/v0/agents").bearer_auth(&token).json(&json!({"workspaceId":WORKSPACE,"id":agent})).send().await.unwrap();
    assert_eq!(created.status(), 201);
    let outside = installation._directory.path().join("reviewed-external-effect");
    let denied = installation._directory.path().join("unreviewed-external-effect");
    let authorization = format!("Write the exact file {} containing approved once. Then report the result.", outside.display());
    let mode = json!({"providerId":"fixture","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"auto"});
    assert_eq!(client.post(format!("http://happy/v0/agents/{agent}/send")).bearer_auth(&token).json(&json!({"id":"messagefreshreviewfixture","text":authorization,"profile":null,"mode":mode})).send().await.unwrap().status(), 202);
    let main = exchange(&mut requests).await;
    main.respond.send(command_response("native-reviewed-escalation", "exec_command", json!({"cmd":format!("printf 'approved once' > '{}'", outside.display()),"sandbox_permissions":"require_escalated","justification":"Write the exact file authorized in the user message.","yield_time_ms":1000}))).unwrap();
    let review = tokio::time::timeout(Duration::from_secs(5), requests.recv()).await.unwrap_or_else(|error| panic!("No private review: {error}; daemon log: {}", std::fs::read_to_string(installation.home.join("agent/daemon.log")).unwrap_or_default())).expect("private reviewer inference");
    let review_text = review.request.to_string();
    assert!(review_text.contains(&authorization), "The full real user authorization reaches the private reviewer: {review_text}");
    assert!(review_text.contains("proposed_action"), "The source permission wrapper reaches the reviewer.");
    assert_ne!(review.request["model"], main.request["model"], "The original same-account hidden review route is selected.");
    review.respond.send(text_response("<review><outcome>allow</outcome><risk_level>medium</risk_level><user_authorization>high</user_authorization><rationale>The person authorized this exact file write.</rationale></review>")).unwrap();
    let next = exchange(&mut requests).await;
    let result = command_output(&next.request, "native-reviewed-escalation");
    assert!(result.contains("Process exited with code 0"), "The reviewed command executes: {result}");
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "approved once");
    next.respond.send(command_response("native-after-review-sandbox", "exec_command", json!({"cmd":format!("printf unexpected > '{}'", denied.display()),"workdir":installation._directory.path(),"yield_time_ms":1000}))).unwrap();
    let final_turn = exchange(&mut requests).await;
    let result = command_output(&final_turn.request, "native-after-review-sandbox");
    assert!(result.contains("working directory is outside its workspace"), "The next command uses the restored Auto sandbox: {result}");
    assert!(!denied.exists());
    final_turn.respond.send(text_response("The authorized write completed and the later command remained sandboxed.")).unwrap();
    let page = tokio::time::timeout(Duration::from_secs(5), async { loop {
        let page: Value = client.get(format!("http://happy/v0/agents/{agent}/messages")).bearer_auth(&token).send().await.unwrap().json().await.unwrap();
        if page["runs"][0]["status"] == "completed" { break page; }
        tokio::task::yield_now().await;
    }}).await.unwrap();
    let reviewed = page["runs"][0]["messages"].as_array().unwrap().iter().flat_map(|message| message["content"].as_array().into_iter().flatten()).find(|block| block["type"] == "tool_call" && block["name"] == "exec_command" && block["arguments"]["sandbox_permissions"] == "require_escalated").unwrap();
    assert_eq!(reviewed["review"]["outcome"], "allowed");
    assert_eq!(reviewed["elevated"], true);
    assert!(!page.to_string().contains("The person authorized this exact file write.</rationale>"), "The private reviewer transcript is absent from public history.");
    installation.command("stop");
    let private = Connection::open(installation.home.join("agent/auto-agent.sqlite")).unwrap();
    let reviewer = format!("r{}", &format!("{:x}", Sha256::digest(agent.as_bytes()))[..31]);
    let cursor: String = private.query_row("SELECT value_json FROM happy_agent_values WHERE owner_id='' AND key=?1", [format!("agentSystem.autoCursor.{reviewer}")], |row| row.get(0)).expect("the original private cursor key");
    let cursor: Value = serde_json::from_str(&cursor).unwrap();
    assert_eq!(cursor.as_object().unwrap().len(), 4);
    assert_eq!(cursor["lastReviewNormal"], true);
    let leaked: i64 = private.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND (name LIKE '%history%' OR name LIKE '%usage%' OR name LIKE '%events%')", [], |row| row.get(0)).unwrap();
    assert_eq!(leaked, 0, "The private reviewer has no public feature stores.");
    let main = Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    let settings: String = main.query_row("SELECT value_json FROM happy_agent_values WHERE owner_id=?1 AND key='settings'", [agent], |row| row.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&settings).unwrap()["permissionMode"], "auto");
    let leaked: i64 = main.query_row("SELECT count(*) FROM happy_agent_values WHERE owner_id='' AND key=?1", [format!("agentSystem.config.{reviewer}")], |row| row.get(0)).unwrap();
    assert_eq!(leaked, 0, "The private reviewer is absent from the public agent catalog.");
    provider.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restored_uncertified_auto_evidence_preserves_original_rows_and_returns_unproven_without_inference() {
    let (endpoint, mut requests, provider) = scripted_provider(1).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    database.execute_batch("CREATE TABLE happy_agent_auto_evidence(agent_id TEXT NOT NULL,generation INTEGER NOT NULL,position INTEGER NOT NULL,category TEXT NOT NULL,entry_json TEXT NOT NULL,trusted_user_evidence INTEGER NOT NULL,trusted_user_evidence_truncated INTEGER NOT NULL,PRIMARY KEY(agent_id,generation,position));CREATE TABLE happy_agent_auto_state(agent_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,next_position INTEGER NOT NULL,archive_healthy INTEGER NOT NULL);CREATE TABLE happy_agent_auto_user_evidence(agent_id TEXT NOT NULL,call_id TEXT NOT NULL,content_json TEXT NOT NULL,PRIMARY KEY(agent_id,call_id));").unwrap();
    database.execute("INSERT INTO happy_agent_migrations VALUES('auto','001-auto-evidence',0)", []).unwrap();
    let archived = json!({"role":"user","blocks":[{"type":"text","text":"Retained historical authorization with no complete-archive proof."}]}).to_string();
    database.execute("INSERT INTO happy_agent_auto_evidence VALUES(?1,0,0,'message',?2,1,0)", params![AGENT,&archived]).unwrap();
    database.execute("INSERT INTO happy_agent_auto_state VALUES(?1,0,1,1)", [AGENT]).unwrap();
    let mut record: Value = serde_json::from_str(&database.query_row::<String,_,_>("SELECT record_json FROM happy_agent_records WHERE owner_id=?1 AND position=1", [AGENT], |row| row.get(0)).unwrap()).unwrap();
    let mut arguments: Value = serde_json::from_str(record["block"]["arguments"].as_str().unwrap()).unwrap();
    arguments["sandbox_permissions"] = json!("require_escalated");
    arguments["justification"] = json!("The restored agent requested this exact external action.");
    record["block"]["arguments"] = json!(arguments.to_string());
    database.execute("UPDATE happy_agent_records SET record_json=?2 WHERE owner_id=?1 AND position=1", params![AGENT,record.to_string()]).unwrap();
    let settings = json!({"provider":"fixture","model":"openai/gpt-5.6-sol","effort":"medium","permissionMode":"auto"});
    database.execute("UPDATE happy_agent_values SET value_json=?2 WHERE owner_id=?1 AND key='settings'", params![AGENT,settings.to_string()]).unwrap();
    drop(database);
    installation.command("start");
    let continuation = exchange(&mut requests).await;
    let text = continuation.request.to_string();
    assert!(!text.contains("<proposed_action>"), "An uncertified original archive must not start reviewer inference.");
    assert!(text.contains("The automatic permission review could not run"), "The original unproven refusal reaches main inference: {text}");
    assert!(text.contains("No judgement was made about the action itself."));
    assert!(!installation._directory.path().join("workspace/recovery-count").exists());
    continuation.respond.send(text_response("The restored action remains unproven because its archive cannot prove completeness.")).unwrap();
    let page = completed(&installation).await;
    let reviewed = page["runs"][0]["messages"].as_array().unwrap().iter().flat_map(|message| message["content"].as_array().into_iter().flatten()).find(|block| block["type"] == "tool_call" && block["id"] == CALL).unwrap();
    assert_eq!(reviewed["review"]["outcome"], "unproven");
    assert_eq!(reviewed["review"]["kind"], "unavailable");
    assert!(reviewed["review"].get("risk").is_none());
    assert!(reviewed["review"].get("userAuthorization").is_none());
    assert_eq!(reviewed["elevated"], false);
    installation.command("stop");
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    let retained: (String, String, i64, i64) = database.query_row("SELECT category,entry_json,trusted_user_evidence,trusted_user_evidence_truncated FROM happy_agent_auto_evidence WHERE agent_id=?1 AND generation=0 AND position=0", [AGENT], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
    assert_eq!(retained, ("message".into(), archived, 1, 0));
    assert_eq!(database.query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_auto_native_generations WHERE agent_id=?1", [AGENT], |row| row.get(0)).unwrap(), 0);
    drop(database);
    installation.command("start");
    assert_eq!(completed(&installation).await["runs"], page["runs"]);
    installation.command("stop");
    provider.await.unwrap();
}
