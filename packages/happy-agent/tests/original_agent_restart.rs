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
