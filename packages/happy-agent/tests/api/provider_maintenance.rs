//! Idle sign-ins are renewed through the built daemon without running the idle model.
use super::*;
const SCOPE: &str = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

struct Stop<'a>(&'a Installation);
impl Drop for Stop<'_> {
    fn drop(&mut self) {
        let _ = Command::new(env!("CARGO_BIN_EXE_happy-agent"))
            .arg("stop")
            .env("HAPPY_HOME_DIR", &self.0.home)
            .output();
    }
}

async fn issuer() -> (String, mpsc::Receiver<String>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (sender, receiver) = mpsc::channel(16);
    let root = base.clone();
    let task = tokio::spawn(async move {
        let mut refreshes = 0;
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let (head, body) = loop {
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                if count == 0 {
                    break (String::new(), String::new());
                }
                bytes.extend_from_slice(&buffer[..count]);
                assert!(bytes.len() <= 65_536);
                let Some(end) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
                    continue;
                };
                let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
                let length = head
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break (
                        head,
                        String::from_utf8(bytes[end + 4..end + 4 + length].to_vec()).unwrap(),
                    );
                }
            };
            if head.is_empty() {
                continue;
            }
            let response = if head.starts_with("GET /.well-known/openid-configuration ") {
                json!({"token_endpoint":format!("{root}/oauth/token")})
            } else {
                assert!(head.starts_with("POST /oauth/token "), "Maintenance must not invoke a model.");
                refreshes += 1;
                sender.send(body).await.unwrap();
                json!({"access_token":format!("renewed-access-{refreshes}"),"refresh_token":format!("renewed-refresh-{refreshes}"),"expires_in":86_400})
            }.to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
        }
    });
    (base, receiver, task)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_renews_an_enabled_hidden_idle_login_and_restarts_without_inference() {
    let (endpoint, mut inference, provider) = scripted_provider(1).await;
    let (issuer, mut refreshes, server) = issuer().await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    let file = installation._directory.path().join("grok-auth.json");
    std::fs::write(&file, json!({SCOPE:{"auth_mode":"oidc","key":"idle-access","refresh_token":"idle-refresh","oidc_issuer":issuer,"oidc_client_id":"idle-client","expires_at":"2099-01-01T00:00:00Z"},"unrelated::scope":{"key":"preserved"}}).to_string()).unwrap();
    let public = installation
        ._directory
        .path()
        .join(if cfg!(target_os = "macos") {
            "Happy/Config"
        } else {
            "happy/config"
        });
    use std::io::Write;
    let mut configured = std::fs::OpenOptions::new()
        .append(true)
        .open(public.join("happy.toml"))
        .unwrap();
    writeln!(configured, "\n[providers.idle]\ntype='grok'\nauth_file='{}'\ncredential_isolation=true\nenabled=true\nhidden=true\n[providers.disabled]\ntype='grok'\nauth_file='{}'\ncredential_isolation=true\nenabled=false\n[providers.static]\ntype='grok'\napi_key='static-fixture'\ncredential_isolation=true\nenabled=true\n[providers.pool]\ntype='smart'\nproviders=['idle']\nenabled=true", file.display(), file.display()).unwrap();
    installation.command("start");
    let _stop = Stop(&installation);
    exchange(&mut inference)
        .await
        .respond
        .send(text_response("maintenance-ready"))
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(8), refreshes.recv()).await;
    assert!(
        first.is_ok(),
        "The existing startup maintenance contract must renew an enabled hidden idle login without inference."
    );
    assert_eq!(
        first.unwrap().unwrap(),
        "grant_type=refresh_token&refresh_token=idle-refresh&client_id=idle-client"
    );
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let store: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
            if store[SCOPE]["key"] == "renewed-access-1" {
                assert_eq!(store["unrelated::scope"]["key"], "preserved");
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("The accepted rotation must finish its bounded store write.");
    assert!(
        refreshes.try_recv().is_err(),
        "Disabled, static and smart accounts must not add a refresh."
    );
    installation.command("stop");
    installation.command("start");
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(8), refreshes.recv())
            .await
            .unwrap()
            .unwrap(),
        "grant_type=refresh_token&refresh_token=renewed-refresh-1&client_id=idle-client"
    );
    assert!(refreshes.try_recv().is_err());
    assert!(inference.try_recv().is_err());
    installation.command("stop");
    provider.await.unwrap();
    server.abort();
    let _ = server.await;
}
