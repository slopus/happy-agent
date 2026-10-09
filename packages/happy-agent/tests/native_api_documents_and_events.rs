#![cfg(unix)]

use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

struct Installation {
    _directory: tempfile::TempDir,
    home: PathBuf,
    client: reqwest::Client,
    token: String,
}
impl Installation {
    fn start() -> Self {
        let scratch = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.context")
            .canonicalize()
            .expect("scratch");
        let directory = tempfile::Builder::new()
            .prefix("")
            .rand_bytes(2)
            .tempdir_in(scratch)
            .expect("isolated installation");
        let home = directory.path().join(".happy");
        let output = Command::new(env!("CARGO_BIN_EXE_happy-agent"))
            .arg("start")
            .env("HAPPY_HOME_DIR", &home)
            .output()
            .expect("native start");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let token = std::fs::read_to_string(home.join("agent/token"))
            .expect("token")
            .trim()
            .to_owned();
        let client = reqwest::Client::builder()
            .unix_socket(home.join("agent/server.sock"))
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("socket client");
        Self {
            _directory: directory,
            home,
            client,
            token,
        }
    }
    async fn get(&self, path: &str) -> (u16, Value) {
        let response = self
            .client
            .get(format!("http://happy{path}"))
            .bearer_auth(&self.token)
            .send()
            .await
            .expect("GET");
        (
            response.status().as_u16(),
            response.json().await.expect("JSON"),
        )
    }
    async fn put(&self, path: &str, body: Value) -> (u16, Value) {
        let response = self
            .client
            .put(format!("http://happy{path}"))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .expect("PUT");
        (
            response.status().as_u16(),
            response.json().await.expect("JSON"),
        )
    }
    async fn post(&self, path: &str) -> (u16, Value) {
        let response = self
            .client
            .post(format!("http://happy{path}"))
            .bearer_auth(&self.token)
            .send()
            .await
            .expect("POST");
        (
            response.status().as_u16(),
            response.json().await.expect("JSON"),
        )
    }
    async fn stream(&self, path: &str, last_event: Option<&str>) -> reqwest::Response {
        let mut request = self
            .client
            .get(format!("http://happy{path}"))
            .bearer_auth(&self.token);
        if let Some(cursor) = last_event {
            request = request.header("Last-Event-ID", cursor);
        }
        let response = request.send().await.expect("SSE connection");
        assert_eq!(response.status(), 200);
        assert!(
            response.headers()["content-type"]
                .to_str()
                .expect("content type")
                .starts_with("text/event-stream")
        );
        response
    }
}

async fn frame(response: &mut reqwest::Response, pending: &mut Vec<u8>) -> String {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if let Some(end) = pending.windows(2).position(|bytes| bytes == b"\n\n") {
                return String::from_utf8(pending.drain(..end + 2).collect())
                    .expect("UTF-8 SSE frame");
            }
            pending.extend_from_slice(
                &response
                    .chunk()
                    .await
                    .expect("SSE bytes")
                    .expect("open stream"),
            );
        }
    })
    .await
    .expect("observable SSE frame")
}
fn data(frame: &str) -> Value {
    serde_json::from_str(
        frame
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .expect("SSE data"),
    )
    .expect("JSON SSE data")
}

#[tokio::test]
async fn sse_replays_then_delivers_live_events_and_reports_cursor_gaps() {
    let installation = Installation::start();
    let (_, origin) = installation.get("/v0/events").await;
    let origin = origin["cursor"].as_str().expect("origin");
    installation
        .put("/v0/config/security", json!({"policy":"first"}))
        .await;
    let mut resumed = installation.stream("/v0/events/stream", Some(origin)).await;
    let mut pending = Vec::new();
    let hello = frame(&mut resumed, &mut pending).await;
    assert!(hello.starts_with("event: hello\n"));
    assert!(!hello.contains("id: "));
    let hello = data(&hello);
    assert_eq!(hello["resumed"], true);
    assert_eq!(hello["gap"], false);
    assert_eq!(hello["draining"], false);
    assert!(hello["daemonId"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(hello["daemonStartedAt"].as_u64().is_some());
    let replay = frame(&mut resumed, &mut pending).await;
    assert!(replay.contains("event: config.updated\n"));
    let replay = data(&replay);
    installation
        .put(
            "/v0/config/security",
            json!({"policy":"live","mutationId":"live-change"}),
        )
        .await;
    let live = frame(&mut resumed, &mut pending).await;
    let live = data(&live);
    assert!(
        live["cursor"].as_str().expect("live cursor")
            > replay["cursor"].as_str().expect("replay cursor")
    );
    assert_eq!(live["payload"], json!({"mutationId":"live-change"}));
    let mut gap = installation
        .stream(
            "/v0/events/stream?after=00000000-0000-7000-8000-000000000000",
            Some(origin),
        )
        .await;
    let gap_hello = data(&frame(&mut gap, &mut Vec::new()).await);
    assert_eq!(gap_hello["gap"], true);
    assert_eq!(gap_hello["resumed"], false);
    assert_eq!(gap_hello["daemonId"], hello["daemonId"]);
    assert_eq!(installation.post("/v0/drain").await.0, 202);
    assert_eq!(installation.post("/v0/drain").await.0, 202);
    let draining = data(&frame(&mut resumed, &mut pending).await);
    assert_eq!(draining["type"], "daemon.draining");
    assert_eq!(draining["payload"], json!({"draining":true}));
    let (_, events) = installation.get("/v0/events").await;
    assert_eq!(
        events["events"]
            .as_array()
            .expect("events")
            .iter()
            .filter(|event| event["type"] == "daemon.draining")
            .count(),
        1
    );
    let mut drained = installation.stream("/v0/events/stream", None).await;
    assert_eq!(
        data(&frame(&mut drained, &mut Vec::new()).await)["draining"],
        true
    );
}

#[tokio::test]
async fn drain_waits_for_an_admitted_http_body_and_rejects_later_mutations() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let installation = Installation::start();
    let mut stream = tokio::net::UnixStream::connect(installation.home.join("agent/server.sock"))
        .await
        .expect("raw API connection");
    let body = json!({"instructions":"accepted before drain","mutationId":"accepted"}).to_string();
    stream.write_all(format!("PUT /v0/config/instructions HTTP/1.1\r\nHost: happy\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n",installation.token,body.len()).as_bytes()).await.expect("headers");
    let mut interim = Vec::new();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !interim.ends_with(b"\r\n\r\n") {
            interim.push(stream.read_u8().await.expect("interim response"));
        }
    })
    .await
    .expect("body admission");
    assert!(
        String::from_utf8(interim)
            .expect("HTTP response")
            .starts_with("HTTP/1.1 100 Continue")
    );
    assert_eq!(installation.post("/v0/drain").await.0, 202);
    assert_eq!(
        installation.get("/v0/health").await.1["drainWaitingFor"],
        json!([{"name":"api-mutations","count":1}])
    );
    assert_eq!(
        installation
            .put("/v0/config/security", json!({"policy":"too late"}))
            .await
            .0,
        503
    );
    stream
        .write_all(body.as_bytes())
        .await
        .expect("complete accepted body");
    let mut result = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        stream.read_to_end(&mut result),
    )
    .await
    .expect("accepted mutation completes")
    .expect("HTTP body");
    assert!(
        String::from_utf8(result)
            .expect("HTTP result")
            .starts_with("HTTP/1.1 200 OK")
    );
    assert_eq!(
        installation.get("/v0/config/instructions").await.1,
        json!({"instructions":"accepted before drain"})
    );
    assert_eq!(
        installation.get("/v0/health").await.1["drainWaitingFor"],
        json!([])
    );
}
impl Drop for Installation {
    fn drop(&mut self) {
        let _ = Command::new(env!("CARGO_BIN_EXE_happy-agent"))
            .arg("kill")
            .env("HAPPY_HOME_DIR", &self.home)
            .output();
    }
}

#[test]
fn published_client_reads_native_documents_and_event_stream() {
    let installation = Installation::start();
    let output = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/client_documents_and_events.mjs"))
        .arg(&installation.home)
        .output()
        .expect("published client validation");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("Published client document and event contracts verified.")
    );
}

#[tokio::test]
async fn documents_persist_and_mutation_events_replay_in_cursor_order() {
    use std::os::unix::fs::PermissionsExt;
    let installation = Installation::start();
    assert_eq!(
        installation.get("/v0/config/instructions").await,
        (200, json!({"instructions":""}))
    );
    let (status, origin) = installation.get("/v0/events").await;
    assert_eq!(status, 200);
    assert_eq!(origin["events"], json!([]));
    let text = "Keep the original commands. 中文 😀\nSecond line.";
    assert_eq!(
        installation
            .put(
                "/v0/config/instructions",
                json!({"instructions":text,"mutationId":"same-mutation"})
            )
            .await,
        (200, json!({"instructions":text}))
    );
    assert_eq!(
        installation.get("/v0/config/instructions").await.1,
        json!({"instructions":text})
    );
    assert_eq!(
        installation
            .put(
                "/v0/config/security",
                json!({"policy":"Review each action.","mutationId":"same-mutation"})
            )
            .await
            .0,
        200
    );
    assert_eq!(
        installation
            .put(
                "/v0/config/security",
                json!({"policy":"Review each action.","mutationId":"same-mutation"})
            )
            .await
            .0,
        200
    );
    assert_eq!(
        installation
            .put(
                "/v0/config/security",
                json!({"policy":"invalid", "unexpected":true})
            )
            .await
            .0,
        400
    );
    assert_eq!(
        installation
            .put("/v0/config/security", json!({"policy":"x".repeat(32769)}))
            .await
            .0,
        400
    );
    let (status, page) = installation
        .get(&format!(
            "/v0/events?after={}",
            origin["cursor"].as_str().expect("origin cursor")
        ))
        .await;
    assert_eq!(status, 200);
    let events = page["events"].as_array().expect("events");
    assert_eq!(events.len(), 3); // mutationId echoes and never deduplicates a mutation.
    let mut previous = origin["cursor"].as_str().expect("origin").to_owned();
    for event in events {
        assert_eq!(event["type"], "config.updated");
        assert_eq!(event["payload"], json!({"mutationId":"same-mutation"}));
        let cursor = event["cursor"].as_str().expect("cursor");
        assert!(cursor > previous.as_str());
        assert_eq!(
            uuid::Uuid::parse_str(cursor)
                .expect("UUID")
                .get_version_num(),
            7
        );
        previous = cursor.to_owned();
    }
    assert_eq!(page["cursor"], previous);
    assert_eq!(
        installation
            .get(&format!("/v0/events?after={previous}"))
            .await
            .1["events"],
        json!([])
    );
    let (_, bounded) = installation
        .get(&format!(
            "/v0/events?after={}&until={}&limit=1",
            origin["cursor"].as_str().expect("origin"),
            events[1]["cursor"].as_str().expect("until")
        ))
        .await;
    assert_eq!(bounded["events"].as_array().expect("bounded page").len(), 1);
    assert_eq!(installation.get("/v0/events?after=invalid").await.0, 400);
    assert_eq!(installation.get("/v0/events?limit=01").await.0, 400);
    assert_eq!(installation.get("/v0/events?limit=10001").await.0, 400);
    let (status, gap) = installation
        .get("/v0/events?after=00000000-0000-7000-8000-000000000000")
        .await;
    assert_eq!(status, 409);
    assert_eq!(gap["code"], "cursor_unavailable");
    let public =
        installation
            .home
            .parent()
            .expect("public parent")
            .join(if cfg!(target_os = "macos") {
                "Happy/Config"
            } else {
                "happy/config"
            });
    for name in ["AGENTS.md", "SECURITY.md"] {
        assert_eq!(
            std::fs::metadata(public.join(name))
                .expect("document")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
