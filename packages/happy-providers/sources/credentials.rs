use crate::{ErrorKind, ProviderError};
use aws_credential_types::provider::ProvideCredentials;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum CredentialSource {
    Bearer {
        token: String,
    },
    Environment {
        variable: String,
    },
    Codex {
        #[serde(default)]
        auth_file: Option<PathBuf>,
    },
    Grok {
        #[serde(default)]
        auth_file: Option<PathBuf>,
    },
    Aws {
        #[serde(default)]
        profile: Option<String>,
    },
}
impl std::fmt::Debug for CredentialSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bearer { .. } => f.write_str("Bearer([redacted])"),
            Self::Environment { variable } => f
                .debug_struct("Environment")
                .field("variable", variable)
                .finish(),
            Self::Codex { auth_file } => f
                .debug_struct("Codex")
                .field("auth_file", auth_file)
                .finish(),
            Self::Grok { auth_file } => f
                .debug_struct("Grok")
                .field("auth_file", auth_file)
                .finish(),
            Self::Aws { profile } => f.debug_struct("Aws").field("profile", profile).finish(),
        }
    }
}

#[derive(Clone)]
pub struct Credential {
    source: CredentialSource,
    state: Arc<Mutex<Auth>>,
    aws: Option<aws_credential_types::provider::SharedCredentialsProvider>,
}
impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}
#[derive(Default)]
struct Auth {
    token: String,
    account: Option<String>,
    file: Option<PathBuf>,
    original: Option<Value>,
    codex_session: bool,
}

#[derive(Deserialize)]
struct CodexAuth {
    #[serde(default)]
    auth_mode: Option<String>,
    #[serde(default, rename = "OPENAI_API_KEY")]
    api_key: Option<String>,
    #[serde(default)]
    tokens: Option<CodexTokens>,
}
#[derive(Deserialize)]
struct CodexTokens {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
}
#[derive(Deserialize)]
struct GrokRecord {
    #[serde(default)]
    key: Option<String>,
}

impl Credential {
    pub async fn load(source: CredentialSource, region: &str) -> anyhow::Result<Self> {
        let mut state = Auth::default();
        let mut aws = None;
        match &source {
            CredentialSource::Bearer { token } => state.token = token.clone(),
            CredentialSource::Environment { variable } => {
                state.token = std::env::var(variable)
                    .map_err(|_| anyhow::anyhow!("Set {variable} before using this provider."))?;
            }
            CredentialSource::Codex { auth_file } => {
                let file = auth_file
                    .clone()
                    .unwrap_or(native_auth_path("CODEX_HOME", ".codex")?);
                let contents = tokio::fs::read(&file).await?;
                let auth: CodexAuth = serde_json::from_slice(&contents)?;
                if auth.auth_mode.as_deref() == Some("apikey") {
                    state.token = auth.api_key.unwrap_or_default();
                } else {
                    let tokens = auth.tokens.ok_or_else(|| {
                        anyhow::anyhow!("Sign in through Codex before using this provider.")
                    })?;
                    state.token = tokens.access_token.unwrap_or_default();
                    state.account = tokens.account_id;
                    state.codex_session = true;
                }
                state.original = Some(serde_json::from_slice(&contents)?);
                state.file = Some(file);
            }
            CredentialSource::Grok { auth_file } => {
                let file = auth_file
                    .clone()
                    .unwrap_or(native_auth_path("GROK_HOME", ".grok")?);
                let records: BTreeMap<String, GrokRecord> =
                    serde_json::from_slice(&tokio::fs::read(file).await?)?;
                // The caller selected this source; do not silently select another account.
                let record = records
                    .get("https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828")
                    .or_else(|| records.get("xai::api_key"))
                    .ok_or_else(|| {
                        anyhow::anyhow!("Sign in through Grok before using this provider.")
                    })?;
                state.token = record.key.clone().unwrap_or_default();
            }
            CredentialSource::Aws { profile } => {
                let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest())
                    .region(aws_config::Region::new(region.to_owned()));
                if let Some(profile) = profile {
                    loader = loader.profile_name(profile);
                }
                let config = tokio::time::timeout(Duration::from_secs(30), loader.load()).await?;
                aws = config.credentials_provider();
                anyhow::ensure!(
                    aws.is_some(),
                    "AWS credentials are unavailable for this profile."
                );
            }
        }
        anyhow::ensure!(
            aws.is_some() || !state.token.trim().is_empty(),
            "The selected provider credential is empty."
        );
        Ok(Self {
            source,
            state: Arc::new(Mutex::new(state)),
            aws,
        })
    }
    pub async fn is_codex_session(&self) -> bool {
        self.state.lock().await.codex_session
    }
    pub async fn headers(
        &self,
        method: &str,
        url: &str,
        body: &[u8],
        region: &str,
        service: &str,
    ) -> Result<reqwest::header::HeaderMap, ProviderError> {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(provider) = &self.aws {
            let credential =
                tokio::time::timeout(Duration::from_secs(30), provider.provide_credentials())
                    .await
                    .map_err(|_| {
                        ProviderError::new(
                            ErrorKind::Authentication,
                            "AWS credential resolution timed out.",
                        )
                    })?
                    .map_err(|_| {
                        ProviderError::new(
                            ErrorKind::Authentication,
                            "AWS credentials could not be resolved. Check the selected profile.",
                        )
                    })?;
            sign_aws(
                &mut headers,
                method,
                url,
                body,
                region,
                service,
                &credential,
            )?;
        } else {
            let auth = self.state.lock().await;
            headers.insert(
                "authorization",
                format!("Bearer {}", auth.token).parse().map_err(|_| {
                    ProviderError::new(
                        ErrorKind::Authentication,
                        "The provider credential contains invalid header characters.",
                    )
                })?,
            );
            if let Some(account) = &auth.account {
                headers.insert(
                    "chatgpt-account-id",
                    account.parse().map_err(|_| {
                        ProviderError::new(
                            ErrorKind::Authentication,
                            "The stored Codex account identifier is invalid.",
                        )
                    })?,
                );
            }
        }
        Ok(headers)
    }
    pub async fn anthropic_api_key(&self) -> String {
        self.state.lock().await.token.clone()
    }
    /// Refresh is provider-owned; outer code never replays inference on its own.
    pub async fn refresh_codex(&self, client: &reqwest::Client) -> Result<bool, ProviderError> {
        let mut auth = self.state.lock().await;
        if !auth.codex_session {
            return Ok(false);
        }
        let Some(original) = &auth.original else {
            return Ok(false);
        };
        let Some(refresh) = original
            .pointer("/tokens/refresh_token")
            .and_then(Value::as_str)
        else {
            return Ok(false);
        };
        let response = client.post("https://auth.openai.com/oauth/token").timeout(Duration::from_secs(30)).json(&serde_json::json!({"grant_type":"refresh_token","refresh_token":refresh,"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"})).send().await.map_err(|_| ProviderError::new(ErrorKind::Authentication, "Codex login could not be refreshed. Sign in again through Codex."))?;
        if !response.status().is_success() {
            return Ok(false);
        }
        let bytes = bounded_body(response, 256 * 1024).await?;
        #[derive(Deserialize)]
        struct Exchange {
            access_token: String,
            #[serde(default)]
            refresh_token: Option<String>,
            #[serde(default)]
            id_token: Option<String>,
        }
        let exchange: Exchange = serde_json::from_slice(&bytes).map_err(|_| {
            ProviderError::new(
                ErrorKind::Authentication,
                "The Codex refresh response was invalid.",
            )
        })?;
        let Some(file) = &auth.file else {
            return Ok(false);
        };
        let current = tokio::fs::read(file)
            .await
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        if current.as_ref() != auth.original.as_ref() {
            return Ok(false);
        }
        let mut changed = original.clone();
        changed["tokens"]["access_token"] = Value::String(exchange.access_token.clone());
        if let Some(token) = exchange.refresh_token {
            changed["tokens"]["refresh_token"] = Value::String(token);
        }
        if let Some(token) = exchange.id_token {
            changed["tokens"]["id_token"] = Value::String(token);
        }
        let temporary = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut output = options.open(&temporary).await.map_err(|_| {
            ProviderError::new(
                ErrorKind::Authentication,
                "The refreshed Codex login could not be saved.",
            )
        })?;
        use tokio::io::AsyncWriteExt;
        let bytes = serde_json::to_vec_pretty(&changed).map_err(|_| {
            ProviderError::new(
                ErrorKind::Authentication,
                "The refreshed Codex login could not be encoded.",
            )
        })?;
        output.write_all(&bytes).await.map_err(|_| {
            ProviderError::new(
                ErrorKind::Authentication,
                "The refreshed Codex login could not be saved.",
            )
        })?;
        output.sync_all().await.map_err(|_| {
            ProviderError::new(
                ErrorKind::Authentication,
                "The refreshed Codex login could not be saved.",
            )
        })?;
        // Check once more after the network/write boundary; never recreate a removed login.
        let current = tokio::fs::read(file)
            .await
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        if current.as_ref() != auth.original.as_ref() {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Ok(false);
        }
        tokio::fs::rename(&temporary, file).await.map_err(|_| {
            ProviderError::new(
                ErrorKind::Authentication,
                "The refreshed Codex login could not be saved.",
            )
        })?;
        auth.token = exchange.access_token;
        auth.original = Some(changed);
        Ok(true)
    }
}

fn native_auth_path(variable: &str, directory: &str) -> anyhow::Result<PathBuf> {
    if let Ok(home) = std::env::var(variable)
        && !home.trim().is_empty()
    {
        return Ok(PathBuf::from(home).join("auth.json"));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "The home directory is unavailable; select an explicit authentication file."
            )
        })?;
    Ok(PathBuf::from(home).join(directory).join("auth.json"))
}

pub(crate) async fn bounded_body(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, ProviderError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ProviderError::transport("The provider response was interrupted."))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(ProviderError::new(
                ErrorKind::Unclassified,
                "The provider response exceeded its size limit.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn sign_aws(
    headers: &mut reqwest::header::HeaderMap,
    method: &str,
    url: &str,
    body: &[u8],
    region: &str,
    service: &str,
    credential: &aws_credential_types::Credentials,
) -> Result<(), ProviderError> {
    use hmac::{Hmac, Mac};
    use sha2::{Digest, Sha256};
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
    fn mac(key: &[u8], data: &str) -> Vec<u8> {
        let mut h = Hmac::<Sha256>::new_from_slice(key)
            .unwrap_or_else(|_| unreachable!("HMAC accepts every key length"));
        h.update(data.as_bytes());
        h.finalize().into_bytes().to_vec()
    }
    let url = reqwest::Url::parse(url).map_err(|_| {
        ProviderError::new(ErrorKind::Unclassified, "The provider endpoint is invalid.")
    })?;
    let host = url.host_str().ok_or_else(|| {
        ProviderError::new(
            ErrorKind::Unclassified,
            "The provider endpoint has no host.",
        )
    })?;
    let host = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    let now = time::OffsetDateTime::now_utc();
    let date = format!("{:04}{:02}{:02}", now.year(), now.month() as u8, now.day());
    let timestamp = format!(
        "{date}T{:02}{:02}{:02}Z",
        now.hour(),
        now.minute(),
        now.second()
    );
    let mut values = BTreeMap::from([("host", host), ("x-amz-date", timestamp.clone())]);
    if let Some(token) = credential.session_token() {
        values.insert("x-amz-security-token", token.to_owned());
    }
    let signed = values.keys().copied().collect::<Vec<_>>().join(";");
    let canonical_headers = values
        .iter()
        .map(|(key, value)| format!("{key}:{}\n", value.trim()))
        .collect::<String>();
    let mut query = url
        .query_pairs()
        .map(|(k, v)| (aws_encode(&k, false), aws_encode(&v, false)))
        .collect::<Vec<_>>();
    query.sort();
    let query = query
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let canonical = format!(
        "{method}\n{}\n{query}\n{canonical_headers}\n{signed}\n{}",
        aws_encode(url.path(), true),
        hex(&Sha256::digest(body))
    );
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let string = format!(
        "AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{}",
        hex(&Sha256::digest(canonical.as_bytes()))
    );
    let date_key = mac(
        format!("AWS4{}", credential.secret_access_key()).as_bytes(),
        &date,
    );
    let region_key = mac(&date_key, region);
    let service_key = mac(&region_key, service);
    let key = mac(&service_key, "aws4_request");
    for (name, value) in values {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
                ProviderError::new(
                    ErrorKind::Authentication,
                    "AWS authentication headers are invalid.",
                )
            })?,
            value.parse().map_err(|_| {
                ProviderError::new(
                    ErrorKind::Authentication,
                    "AWS authentication headers are invalid.",
                )
            })?,
        );
    }
    headers.insert(
        "authorization",
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={}",
            credential.access_key_id(),
            hex(&mac(&key, &string))
        )
        .parse()
        .map_err(|_| {
            ProviderError::new(
                ErrorKind::Authentication,
                "AWS authentication headers are invalid.",
            )
        })?,
    );
    Ok(())
}
fn aws_encode(value: &str, slash: bool) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) || (slash && b == b'/') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
