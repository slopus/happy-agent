//! Grok CLI OAuth sessions stay usable: OIDC refresh before expiry, adoption of a token another
//! process rotated under the store lock, quiet failure, one refresh and replay after the proxy
//! rejects a session, and maintenance without inference.
use happy_providers::{
    Credential, CredentialSource, ErrorKind, Event, HttpSession, Outcome, RunRequest, Session,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

const SCOPE: &str = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

#[derive(Clone, Debug)]
struct Request {
    method: String,
    path: String,
    authorization: Option<String>,
    body: String,
}

/// A loopback identity provider: OIDC discovery plus a scripted token endpoint.
struct Issuer {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl Issuer {
    async fn start(token: impl Fn(usize) -> (u16, Value, u64) + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests: Arc<Mutex<Vec<Request>>> = Arc::default();
        let (recorded, base, token) = (requests.clone(), url.clone(), Arc::new(token));
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let (recorded, base, token) = (recorded.clone(), base.clone(), token.clone());
                tokio::spawn(async move {
                    let Some(request) = read_request(&mut socket).await else {
                        return;
                    };
                    let (status, body, delay) =
                        if request.path == "/.well-known/openid-configuration" {
                            (
                                200,
                                json!({ "token_endpoint": format!("{base}/oauth/token") }),
                                0,
                            )
                        } else {
                            let index = {
                                let all = recorded.lock().unwrap();
                                all.iter()
                                    .filter(|request| request.path == "/oauth/token")
                                    .count()
                            };
                            token(index)
                        };
                    recorded.lock().unwrap().push(request);
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    let body = body.to_string();
                    let head = format!(
                        "HTTP/1.1 {status} X\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(body.as_bytes()).await;
                });
            }
        });
        Self { url, requests }
    }

    fn token_requests(&self) -> Vec<Request> {
        let all = self.requests.lock().unwrap();
        all.iter()
            .filter(|request| request.path == "/oauth/token")
            .cloned()
            .collect()
    }
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
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length: ")?
                    .parse::<usize>()
                    .ok()
            })
            .unwrap_or(0);
        if bytes.len() < end + 4 + length {
            continue;
        }
        let authorization = head.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("authorization")
                .then(|| value.trim().to_owned())
        });
        let mut parts = head.split_whitespace();
        return Some(Request {
            method: parts.next()?.to_owned(),
            path: parts.next()?.to_owned(),
            authorization,
            body: String::from_utf8_lossy(&bytes[end + 4..end + 4 + length]).to_string(),
        });
    }
}

fn fresh_tokens() -> (u16, Value, u64) {
    (
        200,
        json!({ "access_token": "fresh-access", "refresh_token": "fresh-refresh", "expires_in": 3600 }),
        0,
    )
}

fn iso_from_now(seconds: i64) -> String {
    let at = time::OffsetDateTime::now_utc() + time::Duration::seconds(seconds);
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}

/// A Grok CLI store holding an OAuth session that expires `expires_in` seconds from now.
fn write_store(directory: &Path, issuer: &str, expires_in: i64) -> PathBuf {
    let file = directory.join("auth.json");
    let store = json!({
        "unrelated::scope": { "key": "unrelated-key" },
        SCOPE: {
            "auth_mode": "oidc",
            "key": "stale-access",
            "refresh_token": "stale-refresh",
            "oidc_issuer": issuer,
            "oidc_client_id": "grok-cli-client",
            "expires_at": iso_from_now(expires_in),
            "user_id": "user-1",
        },
    });
    std::fs::write(&file, serde_json::to_string_pretty(&store).unwrap()).unwrap();
    file
}

async fn load(file: &Path) -> Credential {
    let source: CredentialSource =
        serde_json::from_value(json!({ "type": "grok", "auth_file": file, "ambient": false }))
            .unwrap();
    Credential::load(source, "us-east-1").await.unwrap()
}

async fn bearer(credential: &Credential) -> String {
    let headers = credential
        .headers(
            "POST",
            "https://cli-chat-proxy.grok.com/v1/responses",
            b"",
            "us-east-1",
            "",
        )
        .await
        .unwrap();
    headers["authorization"].to_str().unwrap().to_owned()
}

fn stored(file: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap()
}

#[tokio::test]
async fn refreshes_an_expiring_session_through_oidc_before_it_is_sent() {
    let issuer = Issuer::start(|_| fresh_tokens()).await;
    let directory = tempfile::tempdir().unwrap();
    // Inside the five-minute safety buffer, though not yet past the stored expiry.
    let file = write_store(directory.path(), &issuer.url, 60);
    let credential = load(&file).await;
    assert_eq!(bearer(&credential).await, "Bearer fresh-access");
    let requests = issuer.token_requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(
        requests[0].body,
        "grant_type=refresh_token&refresh_token=stale-refresh&client_id=grok-cli-client"
    );
    let store = stored(&file);
    assert_eq!(store[SCOPE]["key"], "fresh-access");
    assert_eq!(store[SCOPE]["refresh_token"], "fresh-refresh");
    assert_eq!(store[SCOPE]["user_id"], "user-1");
    assert_eq!(store["unrelated::scope"]["key"], "unrelated-key");
    let expires_at = time::OffsetDateTime::parse(
        store[SCOPE]["expires_at"].as_str().unwrap(),
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    assert!(expires_at > time::OffsetDateTime::now_utc() + time::Duration::minutes(55));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    // The renewed token is valid for an hour, so later requests spend nothing.
    assert_eq!(bearer(&credential).await, "Bearer fresh-access");
    assert_eq!(issuer.token_requests().len(), 1);

    let valid = tempfile::tempdir().unwrap();
    let file = write_store(valid.path(), &issuer.url, 3600);
    assert_eq!(bearer(&load(&file).await).await, "Bearer stale-access");
    assert_eq!(
        issuer.token_requests().len(),
        1,
        "a valid token is never refreshed"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn adopts_a_token_another_process_already_refreshed_under_the_store_lock() {
    use std::os::unix::io::AsRawFd;
    let issuer = Issuer::start(|_| fresh_tokens()).await;
    let directory = tempfile::tempdir().unwrap();
    let file = write_store(directory.path(), &issuer.url, -60);
    let credential = load(&file).await;

    // Another process holds the store lock while it rotates the login.
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(directory.path().join("auth.json.lock"))
        .unwrap();
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    let refreshing = {
        let credential = credential.clone();
        tokio::spawn(async move { bearer(&credential).await })
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        !refreshing.is_finished(),
        "the refresh waits for the other process"
    );
    let mut store = stored(&file);
    store[SCOPE]["key"] = json!("rotated-elsewhere");
    store[SCOPE]["refresh_token"] = json!("rotated-refresh");
    store[SCOPE]["expires_at"] = json!(iso_from_now(3600));
    std::fs::write(&file, store.to_string()).unwrap();
    drop(lock);

    assert_eq!(refreshing.await.unwrap(), "Bearer rotated-elsewhere");
    assert!(
        issuer.token_requests().is_empty(),
        "the rotated refresh token is never spent twice"
    );

    // Two holders of the same store refreshing at once spend the refresh token once.
    let shared = tempfile::tempdir().unwrap();
    let file = write_store(shared.path(), &issuer.url, -60);
    let (first, second) = (load(&file).await, load(&file).await);
    let (one, two) = tokio::join!(bearer(&first), bearer(&second));
    assert_eq!(
        (one.as_str(), two.as_str()),
        ("Bearer fresh-access", "Bearer fresh-access")
    );
    assert_eq!(issuer.token_requests().len(), 1);
}

#[tokio::test]
async fn reports_refresh_failures_instead_of_throwing() {
    // An unreachable identity provider: the request proceeds with the current token.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let unreachable = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let directory = tempfile::tempdir().unwrap();
    let file = write_store(directory.path(), &unreachable, -60);
    let credential = load(&file).await;
    let before = std::fs::read(&file).unwrap();
    assert_eq!(bearer(&credential).await, "Bearer stale-access");
    assert!(
        !credential
            .refresh_for_maintenance(&CancellationToken::new())
            .await
            .unwrap()
    );
    assert_eq!(std::fs::read(&file).unwrap(), before);

    // A rejected refresh token leaves the login untouched and never echoes it.
    let issuer = Issuer::start(|_| {
        (
            400,
            json!({ "error": "invalid_grant", "error_description": "stale-refresh revoked" }),
            0,
        )
    })
    .await;
    let rejected = tempfile::tempdir().unwrap();
    let file = write_store(rejected.path(), &issuer.url, -60);
    let credential = load(&file).await;
    let before = std::fs::read(&file).unwrap();
    assert_eq!(bearer(&credential).await, "Bearer stale-access");
    assert!(
        !credential
            .refresh_for_maintenance(&CancellationToken::new())
            .await
            .unwrap()
    );
    assert_eq!(std::fs::read(&file).unwrap(), before);
    assert_eq!(issuer.token_requests().len(), 2);
    assert!(!format!("{credential:?}").contains("stale-"));

    // A sign-out is authoritative: the deleted store is never recreated from memory.
    std::fs::remove_file(&file).unwrap();
    assert!(
        !credential
            .refresh_for_maintenance(&CancellationToken::new())
            .await
            .unwrap()
    );
    assert!(!file.exists());
    assert_eq!(issuer.token_requests().len(), 2);
}

/// A loopback inference proxy answering each request with the next scripted status.
async fn proxy(statuses: Vec<u16>) -> (String, Arc<Mutex<Vec<Request>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests: Arc<Mutex<Vec<Request>>> = Arc::default();
    let recorded = requests.clone();
    tokio::spawn(async move {
        for status in statuses {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let Some(request) = read_request(&mut socket).await else {
                return;
            };
            recorded.lock().unwrap().push(request);
            let (content_type, body) = if status == 200 {
                let events = [
                    json!({"type":"response.content_part.added","part":{"type":"output_text"}}),
                    json!({"type":"response.output_text.delta","delta":"hello"}),
                    json!({"type":"response.output_text.done"}),
                    json!({"type":"response.completed","response":{"id":"response-1","output":[],"usage":{"input_tokens":5,"output_tokens":1}}}),
                ];
                let body = events.iter().map(|event| format!("data: {event}\r\n\r\n"));
                ("text/event-stream", body.collect::<String>())
            } else {
                let error = json!({ "error": { "message": "The session token is not valid." } });
                ("application/json", error.to_string())
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

/// Runs one inference with no retry budget, so only the refresh replay can send a second request.
async fn infer(file: &Path, endpoint: String) -> Vec<Event> {
    let config = serde_json::from_value(json!({
        "kind": "grok",
        "credential": { "type": "grok", "auth_file": file, "ambient": false },
        "model": "grok-4.5",
        "endpoint": endpoint,
        "transport": "sse",
        "inferenceMaxRetries": 0,
        "streamIdleTimeoutMs": 2000,
    }))
    .unwrap();
    let mut session = HttpSession::new("unauthorized".into(), config, vec![])
        .await
        .unwrap();
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
async fn refreshes_once_and_replays_a_request_the_proxy_rejected() {
    let issuer = Issuer::start(|_| fresh_tokens()).await;
    let directory = tempfile::tempdir().unwrap();
    // Valid by its stored expiry, yet revoked server-side.
    let file = write_store(directory.path(), &issuer.url, 3600);
    let (endpoint, requests) = proxy(vec![401, 200]).await;
    let events = infer(&file, endpoint).await;
    assert!(
        matches!(
            events.last(),
            Some(Event::Done {
                outcome: Outcome::Normal { .. }
            })
        ),
        "the replay completes the turn: {events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Event::Retrying { .. }))
    );
    let sent: Vec<_> = requests
        .lock()
        .unwrap()
        .iter()
        .map(|request| request.authorization.clone())
        .collect();
    assert_eq!(
        sent,
        [
            Some("Bearer stale-access".to_owned()),
            Some("Bearer fresh-access".to_owned())
        ]
    );
    assert_eq!(issuer.token_requests().len(), 1);
    assert_eq!(stored(&file)[SCOPE]["key"], "fresh-access");

    // A replay that is rejected again surfaces the error instead of refreshing a second time.
    let directory = tempfile::tempdir().unwrap();
    let file = write_store(directory.path(), &issuer.url, 3600);
    let (endpoint, requests) = proxy(vec![401, 401, 200]).await;
    let events = infer(&file, endpoint).await;
    let Some(Event::Done {
        outcome: Outcome::Error { error },
    }) = events.last()
    else {
        panic!("a repeated rejection must fail the turn: {events:?}");
    };
    assert_eq!(error.kind, ErrorKind::Authentication);
    assert!(!format!("{error:?}").contains("-access"));
    assert_eq!(requests.lock().unwrap().len(), 2);
    assert_eq!(issuer.token_requests().len(), 2);
}

#[tokio::test]
async fn maintenance_rotates_an_idle_login_and_keeps_a_rotation_its_caller_stopped_waiting_for() {
    assert_eq!(
        happy_providers::CREDENTIAL_MAINTENANCE_INTERVAL,
        Duration::from_secs(3 * 60 * 60)
    );
    let issuer = Issuer::start(|index| {
        let (status, body, _) = fresh_tokens();
        (status, body, if index == 0 { 300 } else { 0 })
    })
    .await;
    let directory = tempfile::tempdir().unwrap();
    // A valid login: maintenance rotates it anyway, without any inference.
    let file = write_store(directory.path(), &issuer.url, 3600);
    let credential = load(&file).await;

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        credential
            .refresh_for_maintenance(&cancelled)
            .await
            .is_err()
    );
    assert!(
        issuer.token_requests().is_empty(),
        "an already-cancelled refresh never starts"
    );

    let cancel = CancellationToken::new();
    let waiting = {
        let (credential, cancel) = (credential.clone(), cancel.clone());
        tokio::spawn(async move { credential.refresh_for_maintenance(&cancel).await })
    };
    while issuer.token_requests().is_empty() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    cancel.cancel();
    assert!(waiting.await.unwrap().is_err());
    // The exchange that was already in flight still lands in the store and in this credential.
    for _ in 0..100 {
        if stored(&file)[SCOPE]["key"] == "fresh-access" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(stored(&file)[SCOPE]["refresh_token"], "fresh-refresh");
    assert_eq!(bearer(&credential).await, "Bearer fresh-access");
    assert_eq!(issuer.token_requests().len(), 1);

    // Static keys have nothing to maintain.
    let source: CredentialSource =
        serde_json::from_value(json!({ "type": "bearer", "token": "static" })).unwrap();
    let key = Credential::load(source, "us-east-1").await.unwrap();
    assert!(
        !key.refresh_for_maintenance(&CancellationToken::new())
            .await
            .unwrap()
    );
}
