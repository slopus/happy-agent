//! Daemon-owned GitHub authentication with revocable command capabilities.
use crate::product::{config::ConfigModule, schemas::Schemas};
use anyhow::{Context as _, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Request, Response,
    body::{Frame, Incoming},
    service::service_fn,
};
use rand::RngCore;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Mutex as AsyncMutex, Semaphore},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;

type Body = UnsyncBoxBody<Bytes, anyhow::Error>;
pub struct GitAuthentication {
    pub environment: BTreeMap<String, Option<String>>,
    pub loopback_port: u16,
}
pub struct GitCommandAuthenticationLease {
    pub environment: BTreeMap<String, Option<String>>,
    pub loopback_port: u16,
    capability: String,
    owner: std::sync::Weak<GitCredentialBroker>,
}
impl Drop for GitCommandAuthenticationLease {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            owner
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .leases
                .remove(&self.capability);
        }
    }
}
struct Credential {
    project: String,
    repository: String,
    token: String,
    capability: String,
}
pub struct PreparedGitCredential {
    reservation: String,
    owner: std::sync::Weak<GitCredentialBroker>,
}
impl PreparedGitCredential {
    pub fn activate(&self) {
        if let Some(owner) = self.owner.upgrade() {
            let mut state = owner
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some((key, credential)) = state.prepared.remove(&self.reservation) {
                if !state.closed {
                    state.records.insert(key, credential);
                    state.bytes = state
                        .records
                        .values()
                        .map(|record| {
                            record.token.len() + record.repository.len() + record.project.len()
                        })
                        .sum();
                }
            }
        }
    }
}
impl Drop for PreparedGitCredential {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            owner
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .prepared
                .remove(&self.reservation);
        }
    }
}
#[derive(Default)]
struct State {
    records: BTreeMap<String, Credential>,
    prepared: BTreeMap<String, (String, Credential)>,
    leases: BTreeMap<String, String>,
    bytes: usize,
    port: Option<u16>,
    closed: bool,
}
pub struct GitCredentialBroker {
    _config: Arc<ConfigModule>,
    schemas: Schemas,
    state: Mutex<State>,
    starting: AsyncMutex<()>,
    server: Mutex<Option<JoinHandle<()>>>,
    cancel: CancellationToken,
    requests: Arc<Semaphore>,
    client: reqwest::Client,
}
impl GitCredentialBroker {
    pub fn new(config: Arc<ConfigModule>) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in [
            "ownerGitCreator",
            "ownerGitCredentialRepository",
            "ownerGitCredentialToken",
            "ownerGitCredentialCapability",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        Ok(Arc::new(Self {
            _config: config,
            schemas,
            state: Mutex::new(State::default()),
            starting: AsyncMutex::new(()),
            server: Mutex::new(None),
            cancel: CancellationToken::new(),
            requests: Arc::new(Semaphore::new(32)),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(30))
                .timeout(Duration::from_secs(1800))
                .build()?,
        }))
    }
    pub async fn register(
        self: &Arc<Self>,
        project: &str,
        creator: &Value,
        repository: &str,
        token: &str,
    ) -> Result<GitAuthentication> {
        let prepared = self.prepare(project, creator, repository, token).await?;
        prepared.activate();
        self.daemon_authentication(project, creator)?
            .context("The Git credential broker is closed.")
    }
    pub async fn prepare(
        self: &Arc<Self>,
        project: &str,
        creator: &Value,
        repository: &str,
        token: &str,
    ) -> Result<Arc<PreparedGitCredential>> {
        anyhow::ensure!(
            self.schemas.valid("cuid2", &json!(project))?
                && self.schemas.valid("ownerGitCreator", creator)?,
            "The Git authentication owner is invalid."
        );
        anyhow::ensure!(
            self.schemas
                .valid("ownerGitCredentialRepository", &json!(repository))?,
            "The GitHub repository must use the form owner/repository."
        );
        anyhow::ensure!(
            self.schemas
                .valid("ownerGitCredentialToken", &json!(token))?,
            "The GitHub token is invalid."
        );
        self.start().await?;
        let key = record_key(project, creator);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(!state.closed, "The Git credential broker is closed.");
        let existing = state.records.get(&key);
        if let Some(existing) = existing {
            anyhow::ensure!(
                existing.repository.eq_ignore_ascii_case(repository),
                "That project credential names a different Git repository."
            );
        }
        anyhow::ensure!(
            state.records.len() + state.prepared.len() < 10_000,
            "The Git credential catalog exceeds its bound."
        );
        let bytes = state.bytes
            + state
                .prepared
                .values()
                .map(|(_, record)| {
                    record.token.len() + record.repository.len() + record.project.len()
                })
                .sum::<usize>()
            + token.len()
            + repository.len()
            + project.len();
        anyhow::ensure!(
            bytes <= 64 * 1024 * 1024,
            "The Git credential catalog exceeds its memory bound."
        );
        let credential_capability =
            existing.map_or_else(capability, |record| record.capability.clone());
        let reservation = capability();
        state.prepared.insert(
            reservation.clone(),
            (
                key,
                Credential {
                    project: project.into(),
                    repository: repository.into(),
                    token: token.into(),
                    capability: credential_capability,
                },
            ),
        );
        Ok(Arc::new(PreparedGitCredential {
            reservation,
            owner: Arc::downgrade(self),
        }))
    }
    pub fn authentication(
        self: &Arc<Self>,
        project: &str,
        creator: &Value,
    ) -> Result<Option<GitCommandAuthenticationLease>> {
        anyhow::ensure!(
            self.schemas.valid("ownerGitCreator", creator)?,
            "The Git authentication creator is invalid."
        );
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed {
            return Ok(None);
        }
        let Some(port) = state.port else {
            return Ok(None);
        };
        let key = record_key(project, creator);
        let Some(record) = state.records.get(&key) else {
            return Ok(None);
        };
        anyhow::ensure!(
            state.leases.len() < 10_000,
            "The Git command authentication catalog exceeds its bound."
        );
        let capability = capability();
        let auth = authentication(port, &record.repository, &capability);
        state.leases.insert(capability.clone(), key);
        Ok(Some(GitCommandAuthenticationLease {
            environment: auth.environment,
            loopback_port: port,
            capability,
            owner: Arc::downgrade(self),
        }))
    }
    pub fn daemon_authentication(
        &self,
        project: &str,
        creator: &Value,
    ) -> Result<Option<GitAuthentication>> {
        anyhow::ensure!(
            self.schemas.valid("ownerGitCreator", creator)?,
            "The Git authentication creator is invalid."
        );
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(if state.closed {
            None
        } else {
            state.port.and_then(|port| {
                state
                    .records
                    .get(&record_key(project, creator))
                    .map(|record| authentication(port, &record.repository, &record.capability))
            })
        })
    }
    pub fn revoke_project(&self, project: &str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.records.retain(|_, record| record.project != project);
        state
            .prepared
            .retain(|_, (_, record)| record.project != project);
        state.bytes = state
            .records
            .values()
            .map(|record| record.token.len() + record.repository.len() + record.project.len())
            .sum();
        let records = &state
            .records
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        state.leases.retain(|_, key| records.contains(key));
    }
    pub async fn close(&self) {
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.closed = true;
            state.records.clear();
            state.prepared.clear();
            state.leases.clear();
            state.bytes = 0;
            state.port = None;
        }
        self.cancel.cancel();
        let task = self
            .server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }
    async fn start(self: &Arc<Self>) -> Result<u16> {
        let _start = self.starting.lock().await;
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            anyhow::ensure!(!state.closed, "The Git credential broker is closed.");
            if let Some(port) = state.port {
                return Ok(port);
            }
        }
        let listener = loop {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
            if ![1080, 3128].contains(&listener.local_addr()?.port()) {
                break listener;
            }
        };
        let port = listener.local_addr()?.port();
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            anyhow::ensure!(!state.closed, "The Git credential broker is closed.");
            state.port = Some(port);
        }
        let owner = Arc::downgrade(self);
        let cancel = self.cancel.clone();
        let task = tokio::spawn(async move {
            let capacity = Arc::new(Semaphore::new(64));
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    _ = connections.join_next(), if !connections.is_empty() => {},
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break; };
                        let Ok(lease) = capacity.clone().try_acquire_owned() else { drop(stream); continue; };
                        let owner = owner.clone(); let connection_cancel = cancel.clone();
                        connections.spawn(async move {
                            let _lease = lease;
                            let service = service_fn(move |request| { let owner = owner.clone(); async move { Ok::<_, Infallible>(match owner.upgrade() { Some(owner) => owner.handle(request).await, None => error(503, "Git authentication is unavailable.") }) } });
                            let io = hyper_util::rt::TokioIo::new(stream);
                            let connection = hyper::server::conn::http1::Builder::new().max_buf_size(64 * 1024).serve_connection(io, service);
                            tokio::select! { _ = connection_cancel.cancelled() => {}, _ = tokio::time::timeout(Duration::from_secs(1800), connection) => {} }
                        });
                    }
                }
            }
            connections.abort_all();
            while connections.join_next().await.is_some() {}
        });
        *self
            .server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(task);
        Ok(port)
    }
    fn authorize(&self, method: &hyper::Method, uri: &hyper::Uri) -> Option<(String, String)> {
        if method != hyper::Method::GET && method != hyper::Method::POST {
            return None;
        }
        let parts = uri
            .path()
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        if ![5, 6].contains(&parts.len())
            || parts[1] != "github.com"
            || !parts[3].ends_with(".git")
            || !self
                .schemas
                .valid("ownerGitCredentialCapability", &json!(parts[0]))
                .ok()?
        {
            return None;
        }
        let repository = format!("{}/{}", parts[2], parts[3].strip_suffix(".git")?);
        let service = if method == hyper::Method::GET {
            if parts.len() != 6 || parts[4] != "info" || parts[5] != "refs" {
                return None;
            }
            let query = uri.query()?;
            let requested = form_urlencoded::parse(query.as_bytes())
                .find(|(key, _)| key == "service")?
                .1;
            if requested != "git-upload-pack" && requested != "git-receive-pack" {
                return None;
            }
            "info/refs"
        } else {
            if parts.len() != 5
                || !["git-upload-pack", "git-receive-pack"].contains(&parts[4])
                || uri.query().is_some()
            {
                return None;
            }
            parts[4]
        };
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed {
            return None;
        }
        let leased_key = state.leases.get(parts[0]);
        let record = state
            .records
            .iter()
            .find(|(key, record)| {
                (record.capability == parts[0] || leased_key == Some(*key))
                    && record.repository.eq_ignore_ascii_case(&repository)
            })?
            .1;
        let path = format!(
            "/{}.git/{service}{}",
            record.repository,
            uri.query()
                .map_or_else(String::new, |query| format!("?{query}"))
        );
        Some((path, record.token.clone()))
    }
    async fn handle(self: Arc<Self>, request: Request<Incoming>) -> Response<Body> {
        if self.cancel.is_cancelled() {
            return error(503, "Git authentication is unavailable.");
        }
        let Ok(lease) = self.requests.clone().try_acquire_owned() else {
            return error(429, "Too many Git requests are active.");
        };
        let Some((path, token)) = self.authorize(request.method(), request.uri()) else {
            return error(404, "Git repository not found.");
        };
        match self.forward(request, &path, &token, lease).await {
            Ok(response) => response,
            Err(_) => error(502, "The Git host could not be reached."),
        }
    }
    async fn forward(
        &self,
        request: Request<Incoming>,
        path: &str,
        token: &str,
        lease: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<Response<Body>> {
        let (parts, incoming) = request.into_parts();
        let mut headers = reqwest::header::HeaderMap::new();
        for name in [
            "accept",
            "accept-encoding",
            "content-encoding",
            "content-length",
            "content-type",
            "git-protocol",
            "user-agent",
        ] {
            if let Some(value) = parts.headers.get(name) {
                headers.insert(
                    reqwest::header::HeaderName::from_static(name),
                    value.clone(),
                );
            }
        }
        if !headers.contains_key("accept") {
            headers.insert("accept", "*/*".parse()?);
        }
        if !headers.contains_key("user-agent") {
            headers.insert("user-agent", "Happy Agent Git broker".parse()?);
        }
        headers.insert(
            "authorization",
            format!(
                "Basic {}",
                STANDARD.encode(format!("x-access-token:{token}"))
            )
            .parse()?,
        );
        let upstream = self
            .client
            .request(parts.method, format!("https://github.com{path}"))
            .headers(headers)
            .body(reqwest::Body::wrap_stream(incoming.into_data_stream()))
            .send()
            .await?;
        let mut response = Response::builder().status(upstream.status());
        for name in [
            "cache-control",
            "content-length",
            "content-encoding",
            "content-type",
            "location",
            "www-authenticate",
        ] {
            if let Some(value) = upstream.headers().get(name) {
                response = response.header(name, value);
            }
        }
        response = response.header("x-content-type-options", "nosniff");
        let stream = futures_util::stream::unfold(
            (upstream.bytes_stream(), lease),
            |(mut stream, lease)| async move {
                stream.next().await.map(|bytes| {
                    (
                        bytes.map(Frame::data).map_err(anyhow::Error::from),
                        (stream, lease),
                    )
                })
            },
        );
        response
            .body(StreamBody::new(stream).boxed_unsync())
            .context("The Git host returned invalid response headers.")
    }
}
impl Drop for GitCredentialBroker {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
fn capability() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn record_key(project: &str, creator: &Value) -> String {
    format!(
        "{project}\0{}\0{}",
        creator["instanceId"].as_str().unwrap_or(""),
        creator["profileId"].as_str().unwrap_or("")
    )
}
fn authentication(port: u16, repository: &str, capability: &str) -> GitAuthentication {
    GitAuthentication {
        loopback_port: port,
        environment: [
            ("GCM_INTERACTIVE", "never".to_owned()),
            ("GIT_CONFIG_COUNT", "2".to_owned()),
            ("GIT_CONFIG_KEY_0", "credential.helper".to_owned()),
            (
                "GIT_CONFIG_KEY_1",
                format!(
                    "url.http://127.0.0.1:{port}/{capability}/github.com/{repository}.git.insteadOf"
                ),
            ),
            ("GIT_CONFIG_VALUE_0", String::new()),
            (
                "GIT_CONFIG_VALUE_1",
                format!("https://github.com/{repository}.git"),
            ),
            ("GIT_TERMINAL_PROMPT", "0".to_owned()),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), Some(value)))
        .collect(),
    }
}
pub fn redact(text: &str, environment: &BTreeMap<String, Option<String>>) -> String {
    let mut text = text.to_owned();
    for (name, value) in environment {
        if !name.starts_with("GIT_CONFIG_KEY_") {
            continue;
        }
        let Some(value) = value
            .as_deref()
            .and_then(|value| value.strip_prefix("url.http://127.0.0.1:"))
            .filter(|value| value.ends_with(".insteadOf"))
        else {
            continue;
        };
        let Some((port, tail)) = value.split_once('/') else {
            continue;
        };
        let Some((capability, _)) = tail.split_once('/') else {
            continue;
        };
        if port.parse::<u16>().is_err()
            || capability.len() != 64
            || !capability
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            continue;
        }
        let prefix = format!("http://127.0.0.1:{port}/{capability}/");
        text = text
            .replace(
                &prefix,
                "http://127.0.0.1/[Happy Agent Git authentication]/",
            )
            .replace(capability, "[Happy Agent Git authentication]");
    }
    text
}
fn error(status: u16, text: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("x-content-type-options", "nosniff")
        .body(
            Full::new(Bytes::from_static(text.as_bytes()))
                .map_err(|never| match never {})
                .boxed_unsync(),
        )
        .expect("The fixed Git error response is valid.")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn leases_revoke_without_disclosing_the_repository_token() {
        let directory = tempfile::tempdir().unwrap();
        let config = Arc::new(ConfigModule::isolated(&directory.path().join(".happy")).unwrap());
        let broker = GitCredentialBroker::new(config).unwrap();
        let creator = json!({"instanceId":"local-fixture","profileId":"local"});
        let auth = broker
            .register(
                "gitcredentialfixture",
                &creator,
                "owner/repository",
                "private-token-never-in-git-environment",
            )
            .await
            .unwrap();
        assert!(!format!("{:?}", auth.environment).contains("private-token"));
        let lease = broker
            .authentication("gitcredentialfixture", &creator)
            .unwrap()
            .unwrap();
        let path = format!(
            "/{}/github.com/owner/repository.git/info/refs?service=git-upload-pack",
            lease.capability
        );
        assert!(
            broker
                .authorize(&hyper::Method::GET, &path.parse().unwrap())
                .is_some()
        );
        assert!(
            broker
                .authorize(
                    &hyper::Method::GET,
                    &path
                        .replace("owner/repository", "other/repository")
                        .parse()
                        .unwrap()
                )
                .is_none()
        );
        let sanitized = redact(
            &format!(
                "Git failed for http://127.0.0.1:{}/{}/github.com/owner/repository.git",
                lease.loopback_port, lease.capability
            ),
            &lease.environment,
        );
        assert!(!sanitized.contains(&lease.capability));
        drop(lease);
        assert!(
            broker
                .authorize(&hyper::Method::GET, &path.parse().unwrap())
                .is_none()
        );
        let lease = broker
            .authentication("gitcredentialfixture", &creator)
            .unwrap()
            .unwrap();
        let path = format!(
            "/{}/github.com/owner/repository.git/git-receive-pack",
            lease.capability
        );
        assert!(
            broker
                .authorize(&hyper::Method::POST, &path.parse().unwrap())
                .is_some()
        );
        broker.revoke_project("gitcredentialfixture");
        assert!(
            broker
                .authorize(&hyper::Method::POST, &path.parse().unwrap())
                .is_none()
        );
        let response = reqwest::get(format!("http://127.0.0.1:{}{}", auth.loopback_port, path))
            .await
            .unwrap();
        assert_eq!(response.status(), 404);
        broker.close().await;
    }
}
