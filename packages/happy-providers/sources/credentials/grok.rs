//! Grok CLI's OAuth session: OIDC refresh of the token it keeps in its shared auth store.
//!
//! The store belongs to the Grok CLI, so every refresh happens under a cross-process lock beside
//! the store, re-reads the file first, and adopts a token another process already rotated instead
//! of spending the refresh token twice. A sign-out or a login replaced during the exchange is
//! authoritative: the store is never recreated or overwritten from memory.
use super::{bounded_body, discovery};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(super) const OAUTH_SCOPE: &str = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
/// Refresh this far ahead of expiry so a request cannot race the cutoff.
pub(super) const EARLY_REFRESH_MS: i128 = 5 * 60 * 1_000;
const FALLBACK_TTL_MS: i128 = 30 * 24 * 60 * 60 * 1_000;
/// Discovery, token exchange, and body consumption share one deadline.
const REFRESH_TIMEOUT: Duration = Duration::from_secs(30);
const LOCK_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_LIMIT: usize = 256 * 1024;

pub(super) fn now_ms() -> i128 {
    time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000
}

fn parse_time(value: Option<&Value>) -> Option<i128> {
    let parsed = time::OffsetDateTime::parse(
        value?.as_str()?,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()?;
    Some(parsed.unix_timestamp_nanos() / 1_000_000)
}

/// The stored expiry, else thirty days after creation; a record with neither is expired.
pub(super) fn expired(record: &Value, early_ms: i128, now: i128) -> bool {
    if let Some(expires_at) = parse_time(record.get("expires_at")) {
        return now >= expires_at - early_ms;
    }
    match parse_time(record.get("create_time")) {
        Some(created_at) => now >= created_at + FALLBACK_TTL_MS - early_ms,
        None => true,
    }
}

/// `Date.prototype.toISOString`.
fn iso(ms: i128) -> Option<String> {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(ms * 1_000_000).ok()?;
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        at.month() as u8,
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    ))
}

/// `application/x-www-form-urlencoded`, as `URLSearchParams` serializes it.
fn form(pairs: &[(&str, &str)]) -> String {
    let encode = |value: &str| {
        value
            .bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                    (byte as char).to_string()
                }
                b' ' => "+".to_owned(),
                _ => format!("%{byte:02X}"),
            })
            .collect::<String>()
    };
    pairs
        .iter()
        .map(|(name, value)| format!("{}={}", encode(name), encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn text<'a>(record: &'a Value, name: &str) -> Option<&'a str> {
    record.get(name)?.as_str().filter(|value| !value.is_empty())
}

/// Rotates the session whose current token is `token`. Returns the token to use and the store it
/// came from, or `None` when no usable token could be obtained. Never fails loudly: an unreachable
/// identity provider, a rejected refresh token, or an unwritable store all read as `None`.
pub(super) async fn refresh(file: &Path, token: &str) -> Option<(String, Value)> {
    // Aliases share one lock and one write target.
    let path = tokio::fs::canonicalize(file).await.ok()?;
    let _lock = FileLock::acquire(&path).await.ok()?;
    // A sign-out is authoritative; never recreate a deleted login from an in-memory token.
    let disk = read_store(&path).await?;
    let record = disk.get(OAUTH_SCOPE).filter(|record| record.is_object())?;
    if let Some(key) = text(record, "key")
        && key != token
        && !expired(record, 0, now_ms())
    {
        return Some((key.to_owned(), disk));
    }
    let (Some(refresh_token), Some(issuer), Some(client_id)) = (
        text(record, "refresh_token"),
        text(record, "oidc_issuer"),
        text(record, "oidc_client_id"),
    ) else {
        return None;
    };
    let tokens = tokio::time::timeout(
        REFRESH_TIMEOUT,
        request_tokens(issuer, client_id, refresh_token),
    )
    .await
    .ok()??;
    // Do not overwrite a login replaced while the network was busy.
    let current = read_store(&path).await?;
    let unchanged = current.get(OAUTH_SCOPE).is_some_and(|now| {
        now.get("key") == record.get("key")
            && now.get("refresh_token") == record.get("refresh_token")
    });
    if !unchanged {
        return None;
    }
    let mut next = current;
    let scope = next.get_mut(OAUTH_SCOPE)?.as_object_mut()?;
    scope.insert("key".into(), Value::String(tokens.access_token.clone()));
    if let Some(refresh_token) = tokens.refresh_token {
        scope.insert("refresh_token".into(), Value::String(refresh_token));
    }
    if let Some(expires_at) = tokens.expires_at {
        scope.insert("expires_at".into(), Value::String(expires_at));
    }
    write_store(&path, &next).await.ok()?;
    Some((tokens.access_token, next))
}

async fn read_store(path: &Path) -> Option<Value> {
    let bytes = discovery::read(path).await.ok()??;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Some(Value::Object(Map::new()));
    }
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
}

/// Stages the store beside the original and renames it, so a reader never sees a partial login.
async fn write_store(path: &Path, store: &Value) -> std::io::Result<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    let staged = directory.join(format!(".{}.auth.json", uuid::Uuid::new_v4()));
    let mut bytes = serde_json::to_vec_pretty(store)?;
    bytes.push(b'\n');
    let result = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut output = options.open(&staged).await?;
        use tokio::io::AsyncWriteExt;
        output.write_all(&bytes).await?;
        output.sync_all().await?;
        tokio::fs::rename(&staged, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&staged).await;
    }
    result
}

struct Tokens {
    access_token: String,
    expires_at: Option<String>,
    refresh_token: Option<String>,
}

/// OIDC discovery, then a `refresh_token` grant at the issuer's token endpoint.
async fn request_tokens(issuer: &str, client_id: &str, refresh_token: &str) -> Option<Tokens> {
    let client = reqwest::Client::builder()
        .connect_timeout(REFRESH_TIMEOUT)
        .build()
        .ok()?;
    let discovery = client
        .get(format!(
            "{}/.well-known/openid-configuration",
            issuer.strip_suffix('/').unwrap_or(issuer)
        ))
        .send()
        .await
        .ok()?;
    if !discovery.status().is_success() {
        return None;
    }
    let metadata: Value =
        serde_json::from_slice(&bounded_body(discovery, RESPONSE_LIMIT).await.ok()?).ok()?;
    let endpoint = text(&metadata, "token_endpoint")?;
    let response = client
        .post(endpoint)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ]))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let tokens: Value =
        serde_json::from_slice(&bounded_body(response, RESPONSE_LIMIT).await.ok()?).ok()?;
    let access_token = text(&tokens, "access_token")?.to_owned();
    let expires_in = match tokens.get("expires_in") {
        None => None,
        Some(value) => Some(value.as_f64().filter(|seconds| *seconds >= 0.0)?),
    };
    let refresh_token = match tokens.get("refresh_token") {
        None => None,
        Some(_) => Some(text(&tokens, "refresh_token")?.to_owned()),
    };
    let expires_at = match expires_in {
        Some(seconds) => Some(iso(now_ms() + (seconds * 1_000.0) as i128)?),
        None => None,
    };
    Some(Tokens {
        access_token,
        expires_at,
        refresh_token,
    })
}

/// An exclusive advisory lock on `<store>.lock`, shared with every process refreshing the store.
/// Closing the file releases it.
struct FileLock {
    #[cfg(unix)]
    _file: std::fs::File,
}

impl FileLock {
    async fn acquire(store: &Path) -> std::io::Result<Self> {
        let mut name = store.file_name().unwrap_or_default().to_owned();
        name.push(".lock");
        let path: PathBuf = store.with_file_name(name);
        tokio::task::spawn_blocking(move || Self::acquire_blocking(&path))
            .await
            .map_err(std::io::Error::other)?
    }

    #[cfg(unix)]
    fn acquire_blocking(path: &Path) -> std::io::Result<Self> {
        use std::os::unix::{fs::OpenOptionsExt, io::AsRawFd};
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(path)?;
        let deadline = std::time::Instant::now() + LOCK_TIMEOUT;
        loop {
            // SAFETY: the descriptor stays open for the lifetime of `file`.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Ok(Self { _file: file });
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::WouldBlock
                || std::time::Instant::now() >= deadline
            {
                return Err(error);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(not(unix))]
    fn acquire_blocking(_path: &Path) -> std::io::Result<Self> {
        Ok(Self {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decides_expiry_from_the_stored_times() {
        let at = |value: &str| parse_time(Some(&json!(value))).unwrap();
        let record = json!({ "expires_at": "2026-07-24T06:00:00.000Z" });
        assert!(!expired(&record, 0, at("2026-07-24T05:59:00.000Z")));
        assert!(expired(
            &record,
            EARLY_REFRESH_MS,
            at("2026-07-24T05:59:00.000Z")
        ));
        assert!(expired(&json!({}), 0, 0));
        let created = json!({ "create_time": "2026-07-01T00:00:00Z" });
        assert!(!expired(&created, 0, at("2026-07-20T00:00:00Z")));
        assert!(expired(&created, 0, at("2026-08-01T00:00:00Z")));
        assert_eq!(
            iso(at("2026-07-24T06:00:00.5Z")).unwrap(),
            "2026-07-24T06:00:00.500Z"
        );
    }
}
