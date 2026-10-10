//! Codex CLI ChatGPT logins stay usable: an unauthorized request re-reads the login once and then
//! refreshes it once, both outside the retry budget; refreshes share the lock beside the file's
//! resolved path, adopt a rotation already on disk, and never overwrite a login that changed.
use happy_providers::{
    Credential, CredentialSource, Event, HttpSession, Outcome, RunRequest, Session,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Notify, mpsc},
};
use tokio_util::sync::CancellationToken;

/// The token endpoint is chosen through environment variables, which every test here shares.
static ENVIRONMENT: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

#[derive(Clone, Debug)]
struct Request {
    path: String,
    authorization: Option<String>,
    body: String,
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<Request> {
    let mut bytes = Vec::new();
    loop {
        let mut buffer = [0; 4096];
        let count = socket.read(&mut buffer).await.ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&buffer[..count]);
        let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&bytes[..end]).to_string();
        let length = head
            .lines()
            .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length: ")?.parse::<usize>().ok())
            .unwrap_or(0);
        if bytes.len() < end + 4 + length {
            continue;
        }
        let authorization = head.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("authorization").then(|| value.trim().to_owned())
        });
        let mut parts = head.split_whitespace();
        parts.next()?;
        return Some(Request {
            path: parts.next()?.to_owned(),
            authorization,
            body: String::from_utf8_lossy(&bytes[end + 4..end + 4 + length]).to_string(),
        });
    }
}

/// A loopback token endpoint that answers each refresh once `release` is notified, or at once.
struct TokenEndpoint {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
    requested: Arc<Notify>,
    release: Arc<Notify>,
}

impl TokenEndpoint {
    async fn start(status: u16, body: String, held: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/oauth/token", listener.local_addr().unwrap());
        let requests: Arc<Mutex<Vec<Request>>> = Arc::default();
        let (requested, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
        let (recorded, notify, gate) = (requests.clone(), requested.clone(), release.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let (recorded, notify, gate, body) = (recorded.clone(), notify.clone(), gate.clone(), body.clone());
                tokio::spawn(async move {
                    let Some(request) = read_request(&mut socket).await else { return };
                    recorded.lock().unwrap().push(request);
                    notify.notify_one();
                    if held {
                        gate.notified().await;
                    }
                    let head = format!(
                        "HTTP/1.1 {status} X\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(body.as_bytes()).await;
                });
            }
        });
        Self { url, requests, requested, release }
    }

    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

fn fresh() -> String {
    json!({ "access_token": "fresh-access", "refresh_token": "fresh-refresh" }).to_string()
}

/// Points the token exchange at `url` for as long as the returned guard lives.
async fn environment(url: &str) -> tokio::sync::MutexGuard<'static, ()> {
    let guard = ENVIRONMENT.lock().await;
    // SAFETY: every test that reads these variables holds the same lock.
    unsafe {
        std::env::set_var("CODEX_REFRESH_TOKEN_URL_OVERRIDE", url);
        std::env::set_var("CODEX_APP_SERVER_LOGIN_CLIENT_ID", "test-client");
    }
    guard
}

fn write_login(directory: &Path) -> PathBuf {
    let file = directory.join("auth.json");
    let login = json!({
        "unrelated": "preserve-me",
        "tokens": { "access_token": "stale-access", "refresh_token": "stale-refresh", "account_id": "account-1" },
    });
    std::fs::write(&file, login.to_string()).unwrap();
    file
}

async fn load(file: &Path) -> Credential {
    let source: CredentialSource = serde_json::from_value(json!({ "type": "codex", "auth_file": file, "ambient": false })).unwrap();
    Credential::load(source, "us-east-1").await.unwrap()
}

async fn bearer(credential: &Credential) -> String {
    let headers = credential.headers("POST", "https://chatgpt.com/backend-api/codex/responses", b"", "us-east-1", "").await.unwrap();
    headers["authorization"].to_str().unwrap().to_owned()
}

fn stored(file: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap()
}

fn leftovers(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names.retain(|name| name != "auth.json" && name != "auth.json.lock" && !name.starts_with("auth.json.alias"));
    names
}

async fn maintain(credential: &Credential) -> bool {
    credential.refresh_for_maintenance(&CancellationToken::new()).await.unwrap()
}

/// A loopback inference endpoint answering each request with the next scripted status.
async fn inference(statuses: Vec<u16>) -> (String, Arc<Mutex<Vec<Request>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests: Arc<Mutex<Vec<Request>>> = Arc::default();
    let recorded = requests.clone();
    tokio::spawn(async move {
        for status in statuses {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let Some(request) = read_request(&mut socket).await else { return };
            recorded.lock().unwrap().push(request);
            let (content_type, body) = if status == 200 {
                let events = [
                    json!({"type":"response.content_part.added","part":{"type":"output_text"}}),
                    json!({"type":"response.output_text.delta","delta":"hello"}),
                    json!({"type":"response.output_text.done"}),
                    json!({"type":"response.completed","response":{"id":"response-1","output":[],"usage":{"input_tokens":5,"output_tokens":1}}}),
                ];
                ("text/event-stream", events.iter().map(|event| format!("data: {event}\r\n\r\n")).collect::<String>())
            } else {
                ("application/json", json!({ "error": { "message": "expired" } }).to_string())
            };
            let head = format!(
                "HTTP/1.1 {status} X\r\nConnection: close\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(body.as_bytes()).await;
        }
    });
    (url, requests)
}

/// Runs one inference with no retry budget, so only unauthorized recovery can replay it.
async fn infer(file: &Path, endpoint: String) -> Vec<Event> {
    let config = serde_json::from_value(json!({
        "kind": "codex",
        "credential": { "type": "codex", "auth_file": file, "ambient": false },
        "model": "gpt-5.6-sol",
        "endpoint": endpoint,
        "transport": "sse",
        "inferenceMaxRetries": 0,
        "streamIdleTimeoutMs": 2000,
    }))
    .unwrap();
    let mut session = HttpSession::new("unauthorized".into(), config, vec![]).await.unwrap();
    let (tx, mut rx) = mpsc::channel(128);
    let run = session.run(RunRequest::default(), CancellationToken::new(), tx);
    let collecting = async {
        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        events
    };
    tokio::join!(run, collecting).1
}

#[tokio::test]
async fn reloads_once_refreshes_once_persists_tokens_and_replays_an_unauthorized_request() {
    let endpoint = TokenEndpoint::start(200, fresh(), false).await;
    let _environment = environment(&endpoint.url).await;
    let directory = tempfile::tempdir().unwrap();
    let file = write_login(directory.path());
    let (url, requests) = inference(vec![401, 401, 200]).await;
    let events = infer(&file, url).await;
    assert!(matches!(events.last(), Some(Event::Done { outcome: Outcome::Normal { .. } })), "{events:?}");
    assert!(!events.iter().any(|event| matches!(event, Event::Retrying { .. })), "recovery is outside the retry budget");
    let sent: Vec<_> = requests.lock().unwrap().iter().map(|request| request.authorization.clone().unwrap_or_default()).collect();
    assert_eq!(sent, ["Bearer stale-access", "Bearer stale-access", "Bearer fresh-access"]);
    let refreshes = endpoint.requests.lock().unwrap().clone();
    assert_eq!(refreshes.len(), 1);
    assert_eq!(refreshes[0].path, "/oauth/token");
    assert_eq!(
        serde_json::from_str::<Value>(&refreshes[0].body).unwrap(),
        json!({ "client_id": "test-client", "grant_type": "refresh_token", "refresh_token": "stale-refresh" })
    );
    let login = stored(&file);
    assert_eq!(login["tokens"], json!({ "access_token": "fresh-access", "refresh_token": "fresh-refresh", "account_id": "account-1" }));
    assert_eq!(login["unrelated"], "preserve-me");
    let refreshed = login["last_refresh"].as_str().unwrap();
    assert!(time::OffsetDateTime::parse(refreshed, &time::format_description::well_known::Rfc3339).is_ok(), "{refreshed}");
    assert!(std::fs::read_to_string(&file).unwrap().ends_with("}\n"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(leftovers(directory.path()).is_empty(), "{:?}", leftovers(directory.path()));

    // A login that is still rejected after both recoveries fails the turn without a third try.
    let directory = tempfile::tempdir().unwrap();
    let file = write_login(directory.path());
    let (url, requests) = inference(vec![401, 401, 401, 200]).await;
    let events = infer(&file, url).await;
    assert!(matches!(events.last(), Some(Event::Done { outcome: Outcome::Error { .. } })), "{events:?}");
    assert_eq!(requests.lock().unwrap().len(), 3);
    assert_eq!(endpoint.count(), 2);
}

#[tokio::test]
async fn shares_one_rotation_across_instances_and_aliases_under_the_file_lock() {
    let endpoint = TokenEndpoint::start(200, fresh(), true).await;
    let _environment = environment(&endpoint.url).await;
    let directory = tempfile::tempdir().unwrap();
    let file = write_login(directory.path());
    #[cfg(unix)]
    let alias = {
        let alias = directory.path().join("auth.json.alias");
        std::os::unix::fs::symlink(&file, &alias).unwrap();
        alias
    };
    #[cfg(not(unix))]
    let alias = file.clone();
    let (first, second) = (load(&file).await, load(&alias).await);
    let one = tokio::spawn({
        let first = first.clone();
        async move { maintain(&first).await }
    });
    endpoint.requested.notified().await;
    let two = tokio::spawn({
        let second = second.clone();
        async move { maintain(&second).await }
    });
    // The second refresh waits on the lock; let it get there before the first one answers.
    tokio::time::sleep(Duration::from_millis(100)).await;
    endpoint.release.notify_one();
    assert!(one.await.unwrap());
    assert!(two.await.unwrap());
    assert_eq!(endpoint.count(), 1, "the second refresh adopted the first one's rotation");
    assert_eq!(bearer(&first).await, "Bearer fresh-access");
    assert_eq!(bearer(&second).await, "Bearer fresh-access");
    assert_eq!(stored(&file)["tokens"]["refresh_token"], "fresh-refresh");
    assert!(leftovers(directory.path()).is_empty());

    // A rotation another process already wrote is adopted without spending the refresh token.
    let stale = tempfile::tempdir().unwrap();
    let file = write_login(stale.path());
    let credential = load(&file).await;
    let mut rotated = stored(&file);
    rotated["tokens"]["access_token"] = json!("rotated-elsewhere");
    std::fs::write(&file, rotated.to_string()).unwrap();
    assert!(maintain(&credential).await);
    assert_eq!(bearer(&credential).await, "Bearer rotated-elsewhere");
    assert_eq!(endpoint.count(), 1);
}

#[tokio::test]
async fn never_restores_overwrites_or_crosses_accounts() {
    let endpoint = TokenEndpoint::start(200, fresh(), true).await;
    let _environment = environment(&endpoint.url).await;

    // A sign-out is authoritative: the deleted login is never recreated from memory.
    let directory = tempfile::tempdir().unwrap();
    let file = write_login(directory.path());
    let credential = load(&file).await;
    std::fs::remove_file(&file).unwrap();
    assert!(!maintain(&credential).await);
    assert!(!file.exists());
    assert_eq!(endpoint.count(), 0);

    // Another account's login is never adopted or refreshed.
    let file = write_login(directory.path());
    let credential = load(&file).await;
    let mut other = stored(&file);
    other["tokens"]["account_id"] = json!("account-2");
    other["tokens"]["access_token"] = json!("other-access");
    std::fs::write(&file, other.to_string()).unwrap();
    assert!(!maintain(&credential).await);
    assert_eq!(bearer(&credential).await, "Bearer stale-access");
    assert_eq!(endpoint.count(), 0);

    // A login replaced during the exchange is kept exactly as it was written.
    let file = write_login(directory.path());
    let credential = load(&file).await;
    let refreshing = tokio::spawn({
        let credential = credential.clone();
        async move { maintain(&credential).await }
    });
    endpoint.requested.notified().await;
    let replacement = std::fs::read_to_string(&file).unwrap().replace("stale-", "another-");
    std::fs::write(&file, &replacement).unwrap();
    endpoint.release.notify_one();
    assert!(!refreshing.await.unwrap());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), replacement);
    assert_eq!(bearer(&credential).await, "Bearer stale-access");
    assert!(leftovers(directory.path()).is_empty());
}

#[tokio::test]
async fn rejected_oversized_and_invalid_answers_leave_the_login_untouched() {
    let missing_refresh = tempfile::tempdir().unwrap();
    for (status, body) in [
        (400, json!({ "error": "invalid_grant", "error_description": "stale-refresh revoked" }).to_string()),
        (200, json!({ "access_token": "x".repeat(300_000) }).to_string()),
        (200, json!({ "access_token": "" }).to_string()),
        (200, json!({ "access_token": "fresh-access", "refresh_token": "" }).to_string()),
    ] {
        let endpoint = TokenEndpoint::start(status, body, false).await;
        let _environment = environment(&endpoint.url).await;
        let directory = tempfile::tempdir().unwrap();
        let file = write_login(directory.path());
        let credential = load(&file).await;
        let before = std::fs::read(&file).unwrap();
        let error = credential.refresh_codex(&reqwest::Client::new()).await.unwrap_err();
        assert!(!format!("{error:?}").contains("stale-"), "{error:?}");
        if status == 400 {
            assert_eq!(error.message, "Codex access token could not be refreshed (HTTP 400).");
        }
        assert!(!maintain(&credential).await);
        assert_eq!(std::fs::read(&file).unwrap(), before);
        assert_eq!(bearer(&credential).await, "Bearer stale-access");
        assert_eq!(endpoint.count(), 2);
        assert!(leftovers(directory.path()).is_empty());
    }

    // A login without a refresh token has nothing to spend.
    let endpoint = TokenEndpoint::start(200, fresh(), false).await;
    let _environment = environment(&endpoint.url).await;
    let file = missing_refresh.path().join("auth.json");
    std::fs::write(&file, json!({ "tokens": { "access_token": "stale-access" } }).to_string()).unwrap();
    let credential = load(&file).await;
    let error = credential.refresh_codex(&reqwest::Client::new()).await.unwrap_err();
    assert_eq!(error.message, "Codex authentication is missing a refresh token.");
    assert_eq!(endpoint.count(), 0);
}

#[tokio::test]
async fn maintenance_keeps_a_rotation_its_caller_stopped_waiting_for() {
    let endpoint = TokenEndpoint::start(200, fresh(), true).await;
    let _environment = environment(&endpoint.url).await;
    let directory = tempfile::tempdir().unwrap();
    let file = write_login(directory.path());
    let credential = load(&file).await;
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(credential.refresh_for_maintenance(&cancelled).await.is_err());
    assert_eq!(endpoint.count(), 0, "an already-cancelled refresh never starts");

    let cancel = CancellationToken::new();
    let waiting = tokio::spawn({
        let (credential, cancel) = (credential.clone(), cancel.clone());
        async move { credential.refresh_for_maintenance(&cancel).await }
    });
    endpoint.requested.notified().await;
    cancel.cancel();
    assert!(waiting.await.unwrap().is_err());
    // A refresh asked for while that rotation is still running joins it instead of spending the
    // refresh token again.
    let joining = tokio::spawn({
        let credential = credential.clone();
        async move { maintain(&credential).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    endpoint.release.notify_one();
    assert!(joining.await.unwrap());
    assert_eq!(stored(&file)["tokens"]["refresh_token"], "fresh-refresh");
    assert_eq!(bearer(&credential).await, "Bearer fresh-access");
    assert_eq!(endpoint.count(), 1);
}
