use super::filesystem::{atomic_private, private_directory, private_file, remove_missing_ok};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct Paths {
    pub home: PathBuf,
    pub directory: PathBuf,
    pub public: PathBuf,
    pub configuration: PathBuf,
    pub socket: PathBuf,
    pub token: PathBuf,
    pub pid: PathBuf,
    pub log: PathBuf,
    pub observation: PathBuf,
    pub drain: PathBuf,
    pub database: PathBuf,
    pub instructions: PathBuf,
    pub security: PathBuf,
}

pub struct ConfigModule {
    pub paths: Paths,
    pub values: toml::Value,
    catalogs: serde_json::Value,
    compatibility: serde_json::Value,
}

pub struct ExecutionEnvironment {
    pub root: PathBuf,
    pub cwd: PathBuf,
    pub shell: String,
}

#[derive(Clone, Copy)]
pub enum Document {
    Instructions,
    Security,
}
impl Document {
    pub fn limit(self) -> usize {
        match self {
            Self::Instructions => 256 * 1024,
            Self::Security => 32 * 1024,
        }
    }
    pub fn field(self) -> &'static str {
        match self {
            Self::Instructions => "instructions",
            Self::Security => "policy",
        }
    }
    pub fn schema(self) -> &'static str {
        match self {
            Self::Instructions => "instructions",
            Self::Security => "security",
        }
    }
}

impl ConfigModule {
    fn provider_type(&self, id: &str) -> Option<&str> {
        self.values
            .get("providers")?
            .get(id)?
            .get("type")
            .and_then(toml::Value::as_str)
    }
    pub fn models_compatible(
        &self,
        previous: &serde_json::Value,
        next: &serde_json::Value,
    ) -> Result<bool> {
        let Some(previous_model) = previous["model"].as_str() else {
            return Ok(false);
        };
        let Some(previous_provider) = previous["provider"].as_str() else {
            return Ok(false);
        };
        let next_model = next["model"]
            .as_str()
            .context("The selected model is missing.")?;
        let next_provider = next["provider"]
            .as_str()
            .context("The selected provider is missing.")?;
        let Some(previous_type) = self.provider_type(previous_provider) else {
            return Ok(false);
        };
        let next_type = self
            .provider_type(next_provider)
            .context("The selected provider is unavailable.")?;
        let Some(family) = self.compatibility["families"][previous_model].as_str() else {
            return Ok(false);
        };
        if self.compatibility["families"][next_model] != family {
            return Ok(false);
        }
        if !self.compatibility["matrix"][previous_type][next_type]
            .as_array()
            .is_some_and(|families| families.iter().any(|entry| entry == family))
        {
            return Ok(false);
        }
        if previous_type == "bedrock" && family == "codex" {
            return Ok(self.model_region(previous_provider, previous_model, true)
                == self.model_region(next_provider, next_model, true));
        }
        Ok(true)
    }
    fn model_region(&self, provider: &str, model: &str, ambient: bool) -> String {
        let entry = self
            .values
            .get("providers")
            .and_then(|providers| providers.get(provider));
        entry
            .and_then(|entry| entry.get("model_overrides"))
            .and_then(|overrides| overrides.get(model))
            .and_then(|model| model.get("region"))
            .or_else(|| entry.and_then(|entry| entry.get("region")))
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|region| !region.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                if !ambient {
                    return None;
                }
                ["AWS_REGION", "AWS_DEFAULT_REGION"]
                    .into_iter()
                    .find_map(|variable| {
                        std::env::var(variable)
                            .ok()
                            .map(|region| region.trim().to_owned())
                            .filter(|region| !region.is_empty())
                    })
            })
            .unwrap_or_else(|| "us-east-1".into())
    }
    pub fn model_label(&self, settings: &serde_json::Value) -> String {
        let model = settings["model"].as_str().unwrap_or("an unnamed model");
        settings["provider"]
            .as_str()
            .and_then(|provider| self.provider_type(provider))
            .and_then(|kind| self.catalogs[kind].as_array())
            .and_then(|models| models.iter().find(|entry| entry["id"] == model))
            .and_then(|model| model["name"].as_str())
            .unwrap_or(model)
            .to_owned()
    }
    pub fn context_window(&self, model: &str) -> Option<u64> {
        self.catalogs
            .as_object()?
            .values()
            .flat_map(|catalog| catalog.as_array().into_iter().flatten())
            .find(|entry| entry["id"] == model)
            .and_then(|entry| entry["contextWindow"].as_u64())
    }
    pub fn provider_enabled(&self, id: &str) -> bool {
        let providers = self.values.get("providers");
        let entry = providers.and_then(|providers| providers.get(id));
        entry
            .and_then(|entry| entry.get("enabled"))
            .and_then(toml::Value::as_bool)
            .or_else(|| {
                providers
                    .and_then(|providers| providers.get("default_enable"))
                    .and_then(toml::Value::as_bool)
            })
            .unwrap_or_else(|| {
                entry
                    .and_then(|entry| entry.get("auto_enable"))
                    .and_then(toml::Value::as_bool)
                    == Some(true)
            })
    }
    pub fn mode_available(&self, mode: &serde_json::Value) -> bool {
        let Some(provider) = mode["providerId"].as_str() else {
            return false;
        };
        if !self.provider_enabled(provider) {
            return false;
        }
        let entry = self
            .values
            .get("providers")
            .and_then(|providers| providers.get(provider));
        let field = |name: &str| entry.and_then(|entry| entry.get(name));
        let kind = field("type")
            .and_then(toml::Value::as_str)
            .unwrap_or(provider);
        let Some(model) = self
            .catalogs
            .get(kind)
            .and_then(serde_json::Value::as_array)
            .and_then(|catalog| catalog.iter().find(|entry| entry["id"] == mode["modelId"]))
        else {
            return false;
        };
        let model_id = model["id"].as_str().unwrap_or("");
        if field("include_models")
            .and_then(toml::Value::as_array)
            .is_some_and(|models| !models.iter().any(|id| id.as_str() == Some(model_id)))
            || field("exclude_models")
                .and_then(toml::Value::as_array)
                .is_some_and(|models| models.iter().any(|id| id.as_str() == Some(model_id)))
        {
            return false;
        }
        model["effortLevels"]
            .as_array()
            .is_some_and(|efforts| efforts.contains(&mode["effort"]))
            && (mode["serviceTier"].is_null()
                || model["serviceTiers"]
                    .as_array()
                    .is_some_and(|tiers| tiers.contains(&mode["serviceTier"])))
    }
    pub fn agent_configuration(
        &self,
        root: &str,
        project: &str,
        workspace: &str,
        title: Option<&str>,
    ) -> Result<serde_json::Value> {
        use serde_json::json;
        let root = PathBuf::from(root);
        let created = super::identity::now();
        let mut metadata = json!({"updatedAt":created,"version":1});
        if let Some(title) = title {
            metadata["title"] = json!(title);
        }
        let os_version = std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .unwrap_or_default()
            .trim()
            .to_owned();
        Ok(
            json!({"provenance":{"createdAt":created},"environment":{"osVersion":os_version,"platform":if cfg!(target_os="macos"){"darwin"}else if cfg!(windows){"win32"}else{"linux"},"workingDirectory":root,"shell":std::env::var("SHELL").unwrap_or_else(|_|"/bin/bash".into())},"metadata":metadata,"modules":{"compute":{"cwd":root,"secretScope":{"projectId":project,"workspaceId":workspace}}}}),
        )
    }
    pub fn execution_environment(
        &self,
        configuration: &serde_json::Value,
        arguments: &serde_json::Value,
    ) -> Result<ExecutionEnvironment> {
        let root = configuration["modules"]["compute"]["cwd"]
            .as_str()
            .or_else(|| configuration["environment"]["workingDirectory"].as_str())
            .context("The agent has no working directory.")?;
        let root = std::fs::canonicalize(root)?;
        let requested = arguments["workdir"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| root.clone());
        let cwd = std::fs::canonicalize(if requested.is_absolute() {
            requested
        } else {
            root.join(requested)
        })?;
        let shell = arguments["shell"]
            .as_str()
            .or_else(|| configuration["environment"]["shell"].as_str())
            .filter(|shell| !shell.is_empty())
            .unwrap_or("/bin/bash")
            .to_owned();
        Ok(ExecutionEnvironment { root, cwd, shell })
    }
    pub async fn session(
        &self,
        agent: &str,
        settings: &serde_json::Value,
        tools: Vec<happy_providers::ToolDefinition>,
    ) -> Result<happy_providers::HttpSession> {
        use happy_providers::{
            BedrockTransport, CredentialSource, ProviderConfig, ProviderKind, Transport,
        };
        let provider = settings["provider"]
            .as_str()
            .or_else(|| {
                self.values
                    .get("defaults")
                    .and_then(|defaults| defaults.get("provider"))
                    .and_then(toml::Value::as_str)
            })
            .context("No inference provider is selected.")?;
        let entry = self
            .values
            .get("providers")
            .and_then(|providers| providers.get(provider));
        let field = |name: &str| entry.and_then(|entry| entry.get(name));
        let configured_kind = field("type")
            .and_then(toml::Value::as_str)
            .unwrap_or(provider);
        anyhow::ensure!(
            self.provider_enabled(provider),
            "The selected inference provider is disabled."
        );
        let model = settings["model"]
            .as_str()
            .or_else(|| {
                self.values
                    .get("defaults")
                    .and_then(|defaults| defaults.get("model"))
                    .and_then(toml::Value::as_str)
            })
            .context("No inference model is selected.")?;
        let kind = match configured_kind {
            "codex" => ProviderKind::Codex,
            "grok" => ProviderKind::Grok,
            "claude" => ProviderKind::Claude,
            "bedrock" if model.starts_with("anthropic/") => ProviderKind::Claude,
            "bedrock" if model.starts_with("moonshotai/") => ProviderKind::Kimi,
            "bedrock" if model.starts_with("zai/") => ProviderKind::Glm,
            "bedrock" => ProviderKind::Codex,
            _ => bail!("The selected inference provider type is not supported."),
        };
        let credential = if let Some(token) = field("api_key").and_then(toml::Value::as_str) {
            CredentialSource::Bearer {
                token: token.to_owned(),
            }
        } else {
            anyhow::ensure!(
                field("credential_isolation").and_then(toml::Value::as_bool) != Some(true),
                "The selected isolated provider has no credential."
            );
            let auth_file = field("auth_file")
                .and_then(toml::Value::as_str)
                .map(PathBuf::from);
            match (configured_kind, kind) {
                ("bedrock", _) => CredentialSource::Aws {
                    profile: field("profile")
                        .and_then(toml::Value::as_str)
                        .map(str::to_owned),
                },
                (_, ProviderKind::Codex) => CredentialSource::Codex { auth_file },
                (_, ProviderKind::Grok) => CredentialSource::Grok { auth_file },
                (_, ProviderKind::Claude) => CredentialSource::Environment {
                    variable: "ANTHROPIC_API_KEY".into(),
                },
                (_, ProviderKind::Responses) => CredentialSource::Environment {
                    variable: "OPENAI_API_KEY".into(),
                },
                _ => bail!("The selected inference provider has no credential."),
            }
        };
        let transport = match field("transport")
            .and_then(toml::Value::as_str)
            .unwrap_or("auto")
        {
            "auto" => Transport::Auto,
            "sse" => Transport::Sse,
            "websocket" | "websocket-cached" => Transport::Websocket,
            _ => bail!("The selected provider transport is invalid."),
        };
        let config = ProviderConfig {
            kind,
            credential,
            model: model.into(),
            endpoint: field("base_url")
                .and_then(toml::Value::as_str)
                .map(str::to_owned),
            transport,
            bedrock: if configured_kind == "bedrock" {
                Some(if matches!(kind, ProviderKind::Claude) {
                    BedrockTransport::Runtime
                } else {
                    BedrockTransport::Mantle
                })
            } else {
                None
            },
            region: field("region")
                .and_then(toml::Value::as_str)
                .map(str::to_owned)
                .or_else(|| std::env::var("AWS_REGION").ok())
                .or_else(|| std::env::var("AWS_DEFAULT_REGION").ok())
                .unwrap_or_else(|| "us-east-1".into()),
            user_agent: None,
            headers: std::collections::BTreeMap::new(),
            inference_max_retries: self
                .values
                .get("settings")
                .and_then(|settings| settings.get("inference_max_retries"))
                .and_then(toml::Value::as_integer)
                .and_then(|count| u32::try_from(count).ok())
                .unwrap_or(10),
            stream_idle_timeout_ms: 300000,
            responses_features: true,
            parallel_tool_calls: true,
            native_compaction: true,
        };
        happy_providers::HttpSession::new(agent.into(), config, tools).await
    }

    pub fn load() -> Result<Self> {
        let os_home = home_directory()?;
        let configured = std::env::var("HAPPY_HOME_DIR").unwrap_or_default();
        let configured = configured.trim();
        let home = if configured.is_empty() {
            os_home.join(".happy")
        } else {
            let expanded = if let Some(relative) = configured.strip_prefix('~') {
                os_home.join(relative.trim_start_matches(['/', '\\']))
            } else {
                PathBuf::from(configured)
            };
            if expanded.is_absolute() {
                expanded
            } else {
                os_home.join(expanded)
            }
        };
        let home = normalize_path(&home);
        let directory = home.join("agent");
        let public = home
            .parent()
            .context("The Happy home must have a parent directory.")?
            .join(if cfg!(target_os = "macos") {
                "Happy"
            } else {
                "happy"
            });
        let configuration = public.join(if cfg!(target_os = "macos") {
            "Config"
        } else {
            "config"
        });
        #[cfg(unix)]
        let socket = directory.join("server.sock");
        #[cfg(windows)]
        let socket = {
            use sha2::{Digest, Sha256};
            let hash = Sha256::digest(directory.to_string_lossy().to_lowercase().as_bytes());
            PathBuf::from(format!(r"\\.\pipe\happy-agent-{hash:x}"))
        };
        let paths = Paths {
            instructions: configuration.join("AGENTS.md"),
            security: configuration.join("SECURITY.md"),
            home,
            public,
            configuration,
            socket,
            token: directory.join("token"),
            pid: directory.join("daemon.pid"),
            log: directory.join("daemon.log"),
            observation: directory.join("observation/agent.log"),
            drain: directory.join("drain.json"),
            database: directory.join("agent.sqlite"),
            directory,
        };
        let mut values: toml::Value = toml::from_str(include_str!("defaults.toml"))?;
        for path in [
            paths.configuration.join("happy.toml"),
            paths.directory.join("runtime.toml"),
        ] {
            match fs::read_to_string(&path) {
                Ok(text) => merge(
                    &mut values,
                    toml::from_str(&text).with_context(|| {
                        format!("Cannot read configuration at {}.", path.display())
                    })?,
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        if let Some(token) = values.get("api").and_then(|v| v.get("token"))
            && (!token.as_str().is_some_and(valid_token) || team_enabled(&values))
        {
            bail!("The configured Happy Agent API token is invalid for this deployment.");
        }
        let catalogs = serde_json::from_str(include_str!("model_catalogs.json"))?;
        let compatibility = serde_json::from_str(include_str!("model_compatibility.json"))?;
        anyhow::ensure!(
            super::schemas::Schemas::new()?.valid("nativeCatalog", &catalogs)?,
            "The curated native model catalog is invalid."
        );
        anyhow::ensure!(
            super::schemas::Schemas::new()?.valid("nativeModelCompatibility", &compatibility)?,
            "The curated model compatibility matrix is invalid."
        );
        Ok(Self {
            paths,
            values,
            catalogs,
            compatibility,
        })
    }

    pub fn team_enabled(&self) -> bool {
        team_enabled(&self.values)
    }

    fn document_path(&self, document: Document) -> PathBuf {
        match document {
            Document::Instructions => self.paths.instructions.clone(),
            Document::Security => self.paths.security.clone(),
        }
    }
    pub async fn read_document(&self, document: Document) -> Result<String> {
        use std::io::Read;
        let path = self.document_path(document);
        tokio::task::spawn_blocking(move || {
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NONBLOCK);
            }
            let file = match options.open(path) {
                Ok(file) => file,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) =>
                {
                    return Ok(String::new());
                }
                Err(error) => return Err(error.into()),
            };
            if !file.metadata()?.is_file() {
                return Ok(String::new());
            }
            let mut bytes = Vec::new();
            file.take(document.limit() as u64 + 4)
                .read_to_end(&mut bytes)?;
            let mut end = bytes.len().min(document.limit());
            if end < bytes.len() {
                while end > 0 && bytes.get(end).is_some_and(|byte| byte & 0xc0 == 0x80) {
                    end -= 1;
                }
            }
            let mut text = String::from_utf8_lossy(&bytes[..end]).into_owned();
            let mut end = text.len().min(document.limit());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            Ok(text)
        })
        .await?
    }
    pub async fn write_document(&self, document: Document, contents: String) -> Result<String> {
        anyhow::ensure!(
            contents.len() <= document.limit(),
            "The document exceeds its allowed byte size."
        );
        let path = self.document_path(document);
        tokio::task::spawn_blocking(move || {
            atomic_private(&path, contents.as_bytes())?;
            Ok(contents)
        })
        .await?
    }

    pub fn prepare(&self) -> Result<()> {
        private_directory(&self.paths.home)?;
        private_directory(&self.paths.directory)?;
        private_directory(&self.paths.directory.join("observation"))?;
        fs::create_dir_all(&self.paths.public)?;
        fs::create_dir_all(&self.paths.configuration)?;
        Ok(())
    }

    pub fn prepare_token(&self) -> Result<String> {
        self.prepare()?;
        if self.team_enabled() {
            remove_missing_ok(&self.paths.token)?;
            bail!(
                "Local daemon connections are disabled in team mode. Run 'happy-agent run' under the team deployment's process supervisor."
            );
        }
        let configured = self
            .values
            .get("api")
            .and_then(|v| v.get("token"))
            .and_then(|v| v.as_str());
        if configured.is_none() {
            match fs::read_to_string(&self.paths.token) {
                Ok(value) => {
                    let token = value.trim();
                    if !valid_token(token) {
                        bail!("The Happy Agent API token is invalid.");
                    }
                    private_file(&self.paths.token)?;
                    return Ok(token.to_owned());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let token = if let Some(token) = configured {
            token.to_owned()
        } else {
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            URL_SAFE_NO_PAD.encode(bytes)
        };
        atomic_private(&self.paths.token, format!("{token}\n").as_bytes())?;
        Ok(token)
    }
}

pub fn valid_token(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn team_enabled(values: &toml::Value) -> bool {
    values
        .get("feature")
        .and_then(|v| v.get("team"))
        .and_then(|v| v.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn home_directory() -> Result<PathBuf> {
    #[cfg(unix)]
    {
        // HOME is configuration supplied by the launcher, as in the original process runtime.
        if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
            return Ok(PathBuf::from(home));
        }
        bail!("The operating system home directory is unavailable.")
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .context("The operating system home directory is unavailable.")
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn merge(base: &mut toml::Value, next: toml::Value) {
    match (base, next) {
        (toml::Value::Table(base), toml::Value::Table(next)) => {
            for (key, value) in next {
                if let Some(base) = base.get_mut(&key) {
                    merge(base, value);
                } else {
                    base.insert(key, value);
                }
            }
        }
        (base, next) => *base = next,
    }
}
