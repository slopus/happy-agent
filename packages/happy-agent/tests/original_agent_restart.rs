#![cfg(unix)]

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
            .join("../../.context")
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
            "{}",
            String::from_utf8_lossy(&output.stderr)
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
        for _ in 0..count {
            let (mut socket, _) = listener.accept().await.expect("inference");
            let mut bytes = Vec::new();
            let request = loop {
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
            let (respond, response) = tokio::sync::oneshot::channel();
            sender
                .send(Exchange { request, respond })
                .await
                .expect("observed request");
            let response = tokio::time::timeout(Duration::from_secs(5), response)
                .await
                .expect("bounded scripted response")
                .expect("scripted response");
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
