//! Codex CLI's ChatGPT login: OAuth refresh of the tokens it keeps in `auth.json`.
//!
//! The file belongs to the Codex CLI, so every refresh happens under a cross-process lock beside
//! the file's resolved path, re-reads it first, and adopts a token another session or the CLI
//! already rotated instead of spending the refresh token twice. The lock is per open file, so it
//! also joins refreshes within this process, through any alias. A sign-out, another account's
//! login, or a login replaced during the exchange is authoritative: the file is never recreated or
//! overwritten from memory.
use super::{discovery, grok, local_file};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const DEFAULT_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// The token exchange and its response body share one deadline.
const REFRESH_TIMEOUT: Duration = Duration::from_secs(30);
const LOCK_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_LIMIT: usize = 256 * 1024;
const STORE_LIMIT: u64 = 1024 * 1024;

/// The login a Codex auth file holds, and the whole file it came from.
pub(super) struct Login {
    pub token: String,
    pub account: Option<String>,
    pub store: Value,
}

/// Re-reads the login after the provider rejected it. `None` when the file no longer holds a
/// ChatGPT login for `account`; the token found is returned even when it has not changed.
pub(super) async fn reload(file: &Path, account: Option<&str>) -> Result<Option<Login>, String> {
    let Some(path) = canonical(file).await else {
        return Ok(None);
    };
    let Some((_, store)) = read_store(&path).await? else {
        return Ok(None);
    };
    Ok(login(store).filter(|current| matches_account(account, current.account.as_deref())))
}

/// Rotates the login whose current token is `token`. `None` when the file no longer holds a
/// ChatGPT login for `account`; an error, worded as the original worded it, when a refresh was
/// owed and could not complete.
pub(super) async fn refresh(
    client: &reqwest::Client,
    file: &Path,
    token: &str,
    account: Option<&str>,
) -> Result<Option<Login>, String> {
    // Aliases share one lock and one write target.
    let Some(path) = canonical(file).await else {
        return Ok(None);
    };
    let _lock = lock(&path)
        .await
        .map_err(|_| "Codex authentication is being refreshed elsewhere; try again.".to_owned())?;
    let Some((contents, store)) = read_store(&path).await? else {
        return Ok(None);
    };
    let Some(current) = login(store.clone()) else {
        return Ok(None);
    };
    if !matches_account(account, current.account.as_deref()) {
        return Ok(None);
    }
    // Another session or the native CLI may already have rotated this credential.
    if current.token != token {
        return Ok(Some(current));
    }
    if !valid("codexRefreshable", &store) {
        return Err("Codex authentication is missing a refresh token.".into());
    }
    let refresh_token = store["tokens"]["refresh_token"].as_str().unwrap_or_default();
    let body = tokio::time::timeout(REFRESH_TIMEOUT, exchange(client, refresh_token))
        .await
        .map_err(|_| "Credential refresh timed out.".to_owned())??;
    // Do not resurrect a sign-out or overwrite credentials changed while the network was busy.
    if read_bytes(&path).await.ok().flatten().as_deref() != Some(contents.as_slice()) {
        return Err("Codex authentication changed during token refresh.".into());
    }
    let mut next = store;
    let tokens = next["tokens"]
        .as_object_mut()
        .ok_or_else(|| "Codex authentication is missing a refresh token.".to_owned())?;
    tokens.insert("access_token".into(), body["access_token"].clone());
    if let Some(id_token) = body["id_token"].as_str() {
        tokens.insert("id_token".into(), Value::String(id_token.to_owned()));
    }
    if let Some(refresh_token) = body["refresh_token"].as_str() {
        tokens.insert("refresh_token".into(), Value::String(refresh_token.to_owned()));
    }
    next["last_refresh"] = grok::iso(grok::now_ms()).map_or(Value::Null, Value::String);
    write_store(&path, &next)
        .await
        .map_err(|_| "The refreshed Codex login could not be saved.".to_owned())?;
    login(next)
        .map(Some)
        .ok_or_else(|| "Codex authentication was invalid after token refresh.".to_owned())
}

/// The ChatGPT login in a Codex auth file, read the way discovery reads it.
fn login(store: Value) -> Option<Login> {
    if !valid("codexAuth", &store) {
        return None;
    }
    let (token, account) = discovery::codex_session(&store)?;
    Some(Login {
        token,
        account,
        store,
    })
}

/// A credential that named no account accepts any; one that did accepts only that account.
fn matches_account(expected: Option<&str>, found: Option<&str>) -> bool {
    expected.is_none() || expected == found
}

fn valid(name: &str, value: &Value) -> bool {
    discovery::valid(name, value).unwrap_or(false)
}

fn setting(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_owned())
}

/// A `refresh_token` grant at Codex's token endpoint, which either environment variable the
/// original honored may redirect.
async fn exchange(client: &reqwest::Client, refresh_token: &str) -> Result<Value, String> {
    let url = setting("CODEX_REFRESH_TOKEN_URL_OVERRIDE", DEFAULT_TOKEN_URL);
    let client_id = setting("CODEX_APP_SERVER_LOGIN_CLIENT_ID", DEFAULT_CLIENT_ID);
    let body = json!({
        "client_id": client_id,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    });
    let mut response = client
        .post(url)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| "Codex access token could not be refreshed.".to_owned())?;
    if !response.status().is_success() {
        return Err(format!(
            "Codex access token could not be refreshed (HTTP {}).",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Codex access token could not be refreshed.".to_owned())?
    {
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err("Credential refresh returned an oversized response.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(|body| valid("codexRefreshResponse", body))
        .ok_or_else(|| "Codex token refresh did not return an access token.".to_owned())
}

async fn canonical(file: &Path) -> Option<PathBuf> {
    tokio::fs::canonicalize(file).await.ok()
}

/// The file's bytes through a bounded, non-following open, or `None` when it is gone; a path
/// that is not a regular file is refused rather than waited on.
async fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let path = path.to_owned();
    let read = tokio::task::spawn_blocking(move || {
        let file = match local_file::open_regular(&path, false, false) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(STORE_LIMIT + 1).read_to_end(&mut bytes)?;
        Ok(Some(bytes))
    })
    .await
    .map_err(|_| "Codex authentication could not be read.".to_owned())?;
    match read {
        Ok(Some(bytes)) if bytes.len() as u64 > STORE_LIMIT => {
            Err("Codex authentication could not be read.".into())
        }
        Ok(bytes) => Ok(bytes),
        Err(_) => Err("Codex authentication could not be read.".into()),
    }
}

async fn read_store(path: &Path) -> Result<Option<(Vec<u8>, Value)>, String> {
    let Some(bytes) = read_bytes(path).await? else {
        return Ok(None);
    };
    let store = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| "Codex authentication could not be read.".to_owned())?;
    Ok(Some((bytes, store)))
}

/// Stages the login beside the file as the original did, then renames it into place, so a reader
/// never sees a partial login; the staged file is removed whatever happens.
async fn write_store(path: &Path, store: &Value) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(store)?;
    bytes.push(b'\n');
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut name = path.file_name().unwrap_or_default().to_owned();
        name.push(format!(".{}.{}.tmp", std::process::id(), uuid::Uuid::new_v4()));
        let staged = path.with_file_name(name);
        let written = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut output = options.open(&staged)?;
            output.write_all(&bytes)?;
            output.sync_all()?;
            drop(output);
            std::fs::rename(&staged, &path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            }
            Ok(())
        })();
        match std::fs::remove_file(&staged) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound && written.is_ok() => {
                Err(error)
            }
            _ => written,
        }
    })
    .await
    .map_err(std::io::Error::other)?
}

/// Takes the exclusive lock on `<file>.lock` that every refresh of the file shares.
async fn lock(file: &Path) -> std::io::Result<local_file::FileLock> {
    let mut name = file.file_name().unwrap_or_default().to_owned();
    name.push(".lock");
    let path = file.with_file_name(name);
    tokio::task::spawn_blocking(move || local_file::FileLock::acquire_blocking(&path, LOCK_TIMEOUT))
        .await
        .map_err(std::io::Error::other)?
}
