use super::filesystem::{atomic_private, private_directory, private_file, remove_missing_ok};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
mod environment;
mod routing;
mod presence;
mod provider_state;
mod provider_probe;
mod provider_usage;
mod public;
mod skill_directories;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
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
    global_values: toml::Value,
    catalogs: serde_json::Value,
    reviewer_catalogs: serde_json::Value,
    compatibility: serde_json::Value,
    runtime_values: Mutex<toml::Value>,
    runtime_writer: tokio::sync::Mutex<()>,
    skills_root: PathBuf,
    os_home: PathBuf,
    projects_root: PathBuf,
    workspaces_root: PathBuf,
    runners: serde_json::Value,
    provider_lifetime: tokio_util::sync::CancellationToken,
    default_provider: OnceLock<String>,
    provider_enablement: Arc<Mutex<BTreeMap<String, bool>>>,
    provider_signals: Arc<Mutex<BTreeMap<String, tokio_util::sync::CancellationToken>>>,
    route_states: Mutex<BTreeMap<(String, String, String), Arc<Mutex<routing::RouteState>>>>,
    #[cfg(test)]
    cloud_test_deployment: Mutex<Option<(String, String)>>,
    #[cfg(test)]
    tailcat_test_executable: Option<String>,
    #[cfg(test)]
    tailcat_test_port: Option<u16>,
    #[cfg(test)]
    workflow_test_executable: Option<PathBuf>,
}

#[async_trait::async_trait]
impl happy_agent_base::AgentModule for ConfigModule {
    fn name(&self) -> &'static str {
        "config"
    }
    fn compatible(
        &self,
        previous: &serde_json::Value,
        next: &serde_json::Value,
    ) -> Option<Result<bool>> {
        Some(self.models_compatible(previous, next))
    }
    async fn instructions(&self, _scope: &happy_agent_base::AgentScope<'_>) -> Result<String> {
        self.read_document(Document::Instructions).await
    }
    async fn session(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        tools: Vec<happy_providers::ToolDefinition>,
    ) -> Option<Result<Box<dyn happy_providers::Session>>> {
        Some(self.session(scope.id, scope.settings, tools).await)
    }
    fn session_key(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        tools: &[happy_providers::ToolDefinition],
    ) -> Result<Option<String>> {
        Ok(Some(self.session_key(scope.settings, tools)?))
    }
    async fn close(&self) {
        self.provider_lifetime.cancel();
        for signal in self.provider_signals.lock().unwrap_or_else(std::sync::PoisonError::into_inner).values() { signal.cancel(); }
    }
}

#[derive(Clone)]
pub struct LiveControllerRoute {
    pub provider_id: String,
    pub model_id: String,
    pub effort: happy_providers::Effort,
    pub signal: tokio_util::sync::CancellationToken,
    configuration: happy_providers::ProviderConfig,
    _lifetime: Arc<routing::FrozenLifetime>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LiveCredentialKind { OpenaiApiKey, CodexSubscription }
pub struct LiveCredential {
    pub kind: LiveCredentialKind,
    pub token: String,
    pub account_id: Option<String>,
}
pub struct CollaborationLimits {
    pub max_collaborators: usize,
    pub max_collaboration_depth: usize,
    pub cross_workspace: bool,
}

pub struct ExecutionEnvironment {
    pub root: PathBuf,
    pub cwd: PathBuf,
    pub shell: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolVendor { Codex, Claude, Grok, Kimi, Glm }
impl ToolVendor {
    pub fn as_str(self) -> &'static str { match self { Self::Codex=>"codex", Self::Claude=>"claude", Self::Grok=>"grok", Self::Kimi=>"kimi", Self::Glm=>"glm" } }
}
pub struct ComputeFileEnvironment {
    pub root: PathBuf,
    pub home: PathBuf,
    pub private_paths:Vec<PathBuf>,
    pub protected_paths:Vec<PathBuf>,
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
    pub fn compute_tool_vendor(&self, settings:&serde_json::Value)->Result<ToolVendor> {
        let model=settings["model"].as_str();
        let kind=settings["provider"].as_str().and_then(|provider|self.compatible_provider_type(provider));
        if let Some(model)=model {
            let mut selection=serde_json::json!({"model":model});
            if let Some(kind)=kind.as_deref().filter(|kind|matches!(*kind,"bedrock"|"claude"|"codex"|"grok"|"gym")) {selection["providerKind"]=serde_json::json!(kind);}
            anyhow::ensure!(super::schemas::Schemas::new()?.valid("computeToolSelection",&selection)?,"Compute tool model selection is invalid.");
            for (prefix,vendor) in [("anthropic/",ToolVendor::Claude),("openai/",ToolVendor::Codex),("xai/",ToolVendor::Grok),("moonshotai/",ToolVendor::Kimi),("zai/",ToolVendor::Glm)] {if model.starts_with(prefix){return Ok(vendor);}}
        }
        Ok(match kind.as_deref() {Some("claude")=>ToolVendor::Claude,Some("grok")=>ToolVendor::Grok,_=>ToolVendor::Codex})
    }
    pub fn workflows_enabled(&self)->bool {
        self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get("features").and_then(|features|features.get("workflows")).or_else(||self.values.get("features").and_then(|features|features.get("workflows"))).and_then(toml::Value::as_bool).unwrap_or(false)
    }
    pub fn workflow_worker_executable(&self)->Result<PathBuf> {
        #[cfg(test)]
        if let Some(executable)=&self.workflow_test_executable{return Ok(executable.clone());}
        Ok(std::env::current_exe()?)
    }
    #[cfg(test)]
    pub fn set_workflow_test_executable(&mut self,executable:PathBuf){self.workflow_test_executable=Some(executable);}
    pub fn compute_file_environment(&self, configuration:&serde_json::Value)->Result<ComputeFileEnvironment> {
        let root=if configuration["modules"]["compute"]["runnerId"].as_str().is_some(){PathBuf::from(configuration["modules"]["compute"]["cwd"].as_str().or_else(||configuration["environment"]["workingDirectory"].as_str()).context("The agent has no working directory.")?)}else{self.execution_environment(configuration,&serde_json::json!({}))?.root};
        let mut names=["AGENTS.md","AGENTS_SECURITY.md","happy.toml","mcp.toml"].into_iter().map(str::to_owned).collect::<std::collections::BTreeSet<_>>();
        #[cfg(windows)]
        names.extend([".agents",".codex",".gitconfig",".gitmodules"].into_iter().map(str::to_owned));
        for (section,field) in [("permissions","protected_paths"),("workspace","protected_sync")] {for value in self.values.get(section).and_then(|values|values.get(field)).and_then(toml::Value::as_array).into_iter().flatten(){let name=value.as_str().context("The protected project path must be a root file name.")?;let path=Path::new(name);anyhow::ensure!(!name.is_empty()&&!path.is_absolute()&&path.parent().is_some_and(|parent|parent.as_os_str().is_empty())&&name!="."&&name!="..","The protected project path must be a root file name.");names.insert(name.to_owned());}}
        let protected_paths=names.into_iter().map(|name|root.join(name)).collect();
        Ok(ComputeFileEnvironment{root,home:self.os_home.clone(),private_paths:vec![self.paths.directory.clone()],protected_paths})
    }
    pub fn presence_configuration(&self)->Result<serde_json::Value> {let mut values=self.values.clone();merge(&mut values,self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone());presence::normalize(values.get("presence"))}
    pub fn current_agent_environment(&self) -> Result<serde_json::Value> { environment::current() }
    pub fn collaboration_limits(&self) -> CollaborationLimits {
        let settings = self.values.get("settings");
        let limit = |key: &str, default| settings.and_then(|settings| settings.get(key)).and_then(toml::Value::as_integer).and_then(|value| usize::try_from(value).ok()).unwrap_or(default);
        CollaborationLimits { max_collaborators: limit("max_collaborators", 5), max_collaboration_depth: limit("max_collaboration_depth", 3), cross_workspace: self.values.get("features").and_then(|features| features.get("cross_workspace")).and_then(toml::Value::as_bool).unwrap_or(true) }
    }
    pub fn available_subagent_models(&self) -> Result<Vec<serde_json::Value>> {
        Ok(self.naming_models()?.into_iter().filter(|model| {
            let account = model["providerId"].as_str().unwrap_or_default();
            let entry = self.values.get("providers").and_then(|providers| providers.get(account));
            if entry.and_then(|entry| entry.get("hidden")).and_then(toml::Value::as_bool) == Some(true) { return false; }
            let includes = entry.and_then(|entry| entry.get("include_subagent_models")).and_then(toml::Value::as_array);
            let excludes = entry.and_then(|entry| entry.get("exclude_subagent_models")).and_then(toml::Value::as_array);
            let contains = |values: &Vec<toml::Value>| values.iter().any(|value| value.as_str() == model["id"].as_str());
            includes.is_none_or(contains) && !excludes.is_some_and(contains)
        }).collect())
    }
    pub async fn live_controller_route(&self) -> Result<LiveControllerRoute> {
        anyhow::ensure!(!self.provider_lifetime.is_cancelled(), "The default model account is unavailable for voice.");
        let model = self.naming_models()?.into_iter().next().context("Configure an enabled default model before starting voice.")?;
        let logical=model["providerId"].as_str().context("The default voice account is unavailable.")?.to_owned();
        let model_id=model["id"].as_str().context("The default voice model is unavailable.")?.to_owned();
        let provider_id = if self.provider_type(&logical) == Some("smart") {
            let route = self.smart_route(&logical)?.context("The default model's account pool has no enabled account for voice.")?;
            let candidates = route.models.iter().find(|entry| entry.model["id"] == model_id).context("The default model's account pool has no enabled account for voice.")?;
            let start = routing::random_index(candidates.accounts.len());
            (0..candidates.accounts.len()).map(|offset| &candidates.accounts[(start + offset) % candidates.accounts.len()]).find(|account| self.provider_enabled(account)).cloned().context("The default model's account pool has no enabled account for voice.")?
        } else { logical.clone() };
        let (_, mut configuration) = self.session_configuration(&serde_json::json!({"provider":provider_id,"model":model_id}))?;
        let effort = serde_json::from_value(model["defaultEffort"].clone()).context("The default voice model has no supported effort.")?;
        configuration.inference_max_retries = 0;
        let (signal, lifetime) = routing::FrozenLifetime::new(vec![self.provider_lifetime.clone(), self.provider_signal(&logical), self.provider_signal(&provider_id)]);
        anyhow::ensure!(!signal.is_cancelled() && self.provider_enabled(&provider_id), "The default model account was disabled before voice could start.");
        Ok(LiveControllerRoute { provider_id, model_id: configuration.model.clone(), effort, signal, configuration, _lifetime:lifetime })
    }
    pub async fn live_controller_session(&self, id: &str, route: &LiveControllerRoute, tools: Vec<happy_providers::ToolDefinition>) -> Result<happy_providers::HttpSession> {
        anyhow::ensure!(!route.signal.is_cancelled() && self.provider_enabled(&route.provider_id), "The default model account is unavailable for voice.");
        happy_providers::HttpSession::new(id.to_owned(), route.configuration.clone(), tools).await
    }
    pub async fn live_credential(&self, selector: &serde_json::Value) -> Result<LiveCredential> {
        anyhow::ensure!(super::schemas::Schemas::new()?.valid("ownerLiveCredential", selector)?, "The selected voice credential is invalid.");
        let provider = selector["providerId"].as_str().context("The selected voice account is missing.")?;
        let model = self.catalogs["codex"].as_array().and_then(|models| models.first()).and_then(|model| model["id"].as_str()).context("No OpenAI model is configured.")?;
        let (_, configuration) = self.session_configuration(&serde_json::json!({"provider":provider,"model":model}))?;
        anyhow::ensure!(configuration.kind == happy_providers::ProviderKind::Codex && configuration.bedrock.is_none(), "Select an enabled OpenAI account for voice.");
        let native = selector["type"] == "codex_subscription";
        let expected = if native { "https://chatgpt.com" } else { "https://api.openai.com" };
        let endpoint = reqwest::Url::parse(configuration.endpoint.as_deref().unwrap_or(expected))?;
        anyhow::ensure!(endpoint.origin().ascii_serialization() == expected && endpoint.username().is_empty() && endpoint.password().is_none(), "Voice requires an official OpenAI account endpoint; custom endpoints are not supported.");
        let credential = happy_providers::Credential::load(configuration.credential, &configuration.region).await?;
        anyhow::ensure!(credential.is_codex_session().await == native, "The selected account does not hold the requested voice credential type.");
        let headers = credential.headers("POST", expected, &[], &configuration.region, "").await?;
        let token = headers.get("authorization").and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer ")).context("The selected voice account is not signed in.")?.to_owned();
        anyhow::ensure!(!token.trim().is_empty(), "The selected voice account is not signed in.");
        let account_id = headers.get("chatgpt-account-id").map(|value| value.to_str().map(str::to_owned)).transpose()?;
        Ok(LiveCredential { kind: if native { LiveCredentialKind::CodexSubscription } else { LiveCredentialKind::OpenaiApiKey }, token, account_id })
    }
    pub fn set_provider_enabled(&self, provider: &str, enabled: bool) -> Result<()> {
        anyhow::ensure!(self.provider_type(provider).is_some(), "The provider account is not configured.");
        let previous=self.provider_enabled(provider);
        self.provider_enablement.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(provider.to_owned(), enabled);
        let mut signals = self.provider_signals.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if previous==enabled&&signals.get(provider).is_none_or(|signal|signal.is_cancelled()==!enabled){return Ok(());}
        if let Some(signal) = signals.remove(provider) { signal.cancel(); }
        if enabled { signals.insert(provider.to_owned(), self.provider_lifetime.child_token()); }
        Ok(())
    }
    pub fn remote_connections(&self) -> Result<BTreeMap<String, serde_json::Value>> {
        let mut values = self.values.clone();
        merge(&mut values, self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone());
        let connections = values.get("connections").map(serde_json::to_value).transpose()?.unwrap_or_else(|| serde_json::json!({}));
        anyhow::ensure!(super::schemas::Schemas::new()?.valid("ownerRemoteEntries", &connections)?, "The remote connection configuration is invalid.");
        Ok(serde_json::from_value(connections)?)
    }
    pub fn naming_models(&self) -> Result<Vec<serde_json::Value>> {
        let mut models=self.configured_models()?.into_iter().filter(|model| self.mode_available(&serde_json::json!({"providerId":model["providerId"],"modelId":model["id"],"effort":model["defaultEffort"],"serviceTier":null}))).map(|mut model|{if let Some(model)=model.as_object_mut(){model.remove("enabled");}model}).collect::<Vec<_>>();
        let hidden=|model:&serde_json::Value|self.values.get("providers").and_then(|providers|providers.get(model["providerId"].as_str().unwrap_or_default())).and_then(|provider|provider.get("hidden")).and_then(toml::Value::as_bool)==Some(true);
        models.sort_by_key(hidden);
        let defaults=self.values.get("defaults");let model=defaults.and_then(|defaults|defaults.get("model")).and_then(toml::Value::as_str);let provider=defaults.and_then(|defaults|defaults.get("provider")).and_then(toml::Value::as_str);
        if let Some(index)=models.iter().position(|entry|entry["id"].as_str()==model&&provider.map_or_else(||!hidden(entry),|provider|entry["providerId"]==provider)) {
            let mut selected=models.remove(index);
            if let Some(effort)=defaults.and_then(|defaults|defaults.get("effort")).and_then(toml::Value::as_str).filter(|effort|selected["effortLevels"].as_array().is_some_and(|efforts|efforts.contains(&serde_json::json!(effort)))){selected["defaultEffort"]=serde_json::json!(effort);}
            models.insert(0,selected);
        }
        Ok(models)
    }
    pub async fn naming_session(&self, id: &str, settings: &serde_json::Value) -> Result<Box<dyn happy_providers::Session>> {
        self.session_internal(id,settings,Vec::new(),Some(0),false).await
    }
    pub fn bots_home(&self) -> PathBuf { self.paths.public.join("Bots") }
    pub fn bots_home_on(&self, home: &Path, platform: &str) -> PathBuf { home.join(if platform == "darwin" { "Happy" } else { "happy" }).join("Bots") }
    pub fn bot_path(&self, username: &str) -> Result<PathBuf> {
        anyhow::ensure!(super::schemas::Schemas::new()?.valid("ownerBotUsername", &serde_json::json!(username))?, "The bot username cannot name a folder.");
        Ok(self.bots_home().join(username))
    }
    pub fn bot_path_on(&self, home: &Path, platform: &str, username: &str) -> Result<PathBuf> {
        anyhow::ensure!(super::schemas::Schemas::new()?.valid("ownerBotUsername", &serde_json::json!(username))?, "The bot username cannot name a folder.");
        Ok(self.bots_home_on(home, platform).join(username))
    }
    pub fn bot_configuration(&self, path: &str, workspace: &str, name: &str, runner: Option<&str>) -> Result<serde_json::Value> {
        let mut configuration = self.agent_configuration(path, "", workspace, Some(name))?;
        configuration["modules"]["compute"]["secretScope"] = serde_json::json!({"workspaceId":workspace});
        if let Some(runner) = runner { configuration["modules"]["compute"]["runnerId"] = serde_json::json!(runner); }
        anyhow::ensure!(super::schemas::Schemas::new()?.valid("agentConfig", &configuration)?, "The bot agent configuration is invalid.");
        Ok(configuration)
    }
    pub async fn write_runtime_connection(&self, id: &str, entry: &serde_json::Value) -> Result<()> {
        let schemas = super::schemas::Schemas::new()?;
        anyhow::ensure!(schemas.valid("ownerConnectionId", &serde_json::json!(id))? && schemas.valid("ownerRemoteEntry", entry)?, "The remote connection configuration is invalid.");
        let _write = self.runtime_writer.lock().await;
        let mut connections = self.remote_connections()?;
        connections.insert(id.to_owned(), entry.clone());
        anyhow::ensure!(schemas.valid("ownerRemoteEntries", &serde_json::to_value(&connections)?)?, "At most 100 remote connections may be configured.");
        let mut next = self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        next.as_table_mut().context("The generated runtime configuration is invalid.")?.entry("connections").or_insert_with(|| toml::Value::Table(toml::map::Map::new())).as_table_mut().context("The generated connection configuration is invalid.")?.insert(id.to_owned(), toml::Value::try_from(entry)?);
        self.persist_runtime(next).await
    }
    pub fn tailcat_enabled(&self) -> bool {
        self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get("feature").and_then(|value| value.get("tailcat")).and_then(|value| value.get("enabled")).and_then(toml::Value::as_bool).or_else(|| self.values.get("feature").and_then(|value| value.get("tailcat")).and_then(|value| value.get("enabled")).and_then(toml::Value::as_bool)).unwrap_or(false)
    }
    pub fn tailcat_port(&self) -> u16 {
        #[cfg(test)] if let Some(port) = self.tailcat_test_port { return port; }
        self.values.get("feature").and_then(|value| value.get("tailcat")).and_then(|value| value.get("port")).and_then(toml::Value::as_integer).and_then(|port| u16::try_from(port).ok()).unwrap_or(24779)
    }
    pub fn tailcat_home(&self) -> PathBuf { self.paths.directory.join("tailcat") }
    pub fn tailcat_executable(&self) -> String {
        #[cfg(test)] if let Some(executable) = &self.tailcat_test_executable { return executable.clone(); }
        std::env::var("HAPPY_AGENT_TAILCAT_PATH").ok().map(|path| path.trim().to_owned()).filter(|path| !path.is_empty()).unwrap_or_else(|| "tailcat".into())
    }
    #[cfg(test)] pub fn set_tailcat_test_executable(&mut self, executable: String) { self.tailcat_test_executable = Some(executable); }
    #[cfg(test)] pub fn set_tailcat_test_port(&mut self, port: u16) { self.tailcat_test_port = Some(port); }
    pub async fn write_runtime_tailcat_enabled(&self, enabled: bool) -> Result<()> {
        let _write = self.runtime_writer.lock().await;
        let mut next = self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let feature = next.as_table_mut().context("The generated runtime configuration is invalid.")?.entry("feature").or_insert_with(|| toml::Value::Table(toml::map::Map::new())).as_table_mut().context("The generated feature configuration is invalid.")?;
        feature.entry("tailcat").or_insert_with(|| toml::Value::Table(toml::map::Map::new())).as_table_mut().context("The generated Tailcat configuration is invalid.")?.insert("enabled".into(), toml::Value::Boolean(enabled));
        self.persist_runtime(next).await
    }
    async fn persist_runtime(&self, next: toml::Value) -> Result<()> {
        validate_configuration(&next)?;
        let path = self.paths.directory.join("runtime.toml");
        let text = toml::to_string(&next)?;
        tokio::task::spawn_blocking(move || atomic_private(&path, text.as_bytes())).await??;
        *self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = next;
        Ok(())
    }
    pub fn cloud_deployment(&self, environment: &str) -> Result<serde_json::Value> {
        let (cloud_url, client) = match environment {
            "production" => ("https://cloud.cluster-fluster.com", "client_01KZD3XE9YAFAMT0P8TD4HP73E"),
            "staging" => ("https://happy-cloud-staging.bulka-llc.workers.dev", "client_01KZD3XE4EW1AF1P6WTFHBPR4J"),
            _ => bail!("The Cloud deployment environment is invalid."),
        };
        let deployment = serde_json::json!({"cloudUrl":cloud_url,"workosClientId":client,"workosUrl":"https://api.workos.com"});
        #[cfg(test)]
        let deployment = {
            let mut deployment = deployment;
            if let Some((workos, cloud)) = self.cloud_test_deployment.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref() { deployment["workosUrl"] = serde_json::json!(workos); deployment["cloudUrl"] = serde_json::json!(cloud); }
            deployment
        };
        anyhow::ensure!(super::schemas::Schemas::new()?.valid("cloudDeployment", &deployment)?, "The Cloud deployment configuration is invalid.");
        Ok(deployment)
    }
    #[cfg(test)]
    pub fn set_cloud_test_deployment(&self, workos: &str, cloud: &str) -> Result<()> {
        let deployment = serde_json::json!({"cloudUrl":cloud,"workosClientId":"client_01KZD3XE4EW1AF1P6WTFHBPR4J","workosUrl":workos});
        anyhow::ensure!(super::schemas::Schemas::new()?.valid("cloudDeployment", &deployment)?, "The isolated Cloud test deployment is invalid.");
        for endpoint in [workos, cloud] {
            let parsed = reqwest::Url::parse(endpoint)?;
            anyhow::ensure!(parsed.scheme() == "http" && parsed.host_str().is_some_and(|host| host == "127.0.0.1" || host == "localhost" || host == "::1"), "The isolated Cloud test deployment must use a private loopback fixture.");
        }
        *self.cloud_test_deployment.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((workos.to_owned(), cloud.to_owned()));
        Ok(())
    }
    pub fn projects_home(&self) -> PathBuf { self.projects_root.clone() }
    pub fn workspaces_home(&self) -> PathBuf { self.workspaces_root.clone() }
    pub fn projects_home_on(&self, home: &Path) -> PathBuf { home.join("Happy/Projects") }
    pub fn workspaces_home_on(&self, home: &Path, platform: &str) -> PathBuf { home.join(if platform == "darwin" { "Happy/Workspaces" } else { "happy/workspaces" }) }
    pub fn runners_configuration(&self) -> serde_json::Value { self.runners.clone() }
    pub fn product_shell(&self) -> String {
        std::env::var(if cfg!(windows) { "COMSPEC" } else { "SHELL" }).ok().filter(|shell| !shell.is_empty()).unwrap_or_else(|| if cfg!(windows) { "cmd.exe".into() } else { "/bin/bash".into() })
    }
    pub fn git_ceiling_directories(&self) -> Option<String> {
        std::env::var("GIT_CEILING_DIRECTORIES").ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty() && value.encode_utf16().count() <= 16_384)
    }
    pub fn github_token(&self) -> Option<String> {
        for name in ["GITHUB_TOKEN", "GH_TOKEN"] {
            if let Ok(value) = std::env::var(name) {
                return super::schemas::Schemas::new().ok().and_then(|schemas| schemas.valid("ownerGithubToken", &serde_json::json!(&value)).ok().filter(|valid| *valid).map(|_| value));
            }
        }
        None
    }
    pub fn workspace_folder_defaults(&self) -> serde_json::Value {
        workspace_folder_settings(&self.values, &serde_json::json!({"keepCopiesOnArchive":true,"keepWorktreesOnArchive":false,"protectedSync":[],"setupCommands":[],"sync":[]}))
    }
    pub fn parse_workspace_folder_settings(&self, source: &str) -> Result<serde_json::Value> {
        anyhow::ensure!(source.len() <= 1_048_576, "The project configuration exceeds its size limit.");
        let values: toml::Value = toml::from_str(source)?;
        validate_configuration(&values)?;
        let schemas = super::schemas::Schemas::new()?;
        if let Some(workspace) = values.get("workspace") {
            anyhow::ensure!(schemas.valid("ownerWorkspaceConfigInput", &serde_json::to_value(workspace)?)?, "The workspace configuration is invalid.");
        }
        let result = workspace_folder_settings(&values, &self.workspace_folder_defaults());
        anyhow::ensure!(schemas.valid("ownerFolderSettings", &result)?, "The workspace settings are invalid.");
        Ok(result)
    }
    pub fn service_execution(&self, service: &str) -> Result<serde_json::Value> {
        anyhow::ensure!(cfg!(target_os = "linux"), "Sandboxed workspace services require Linux native namespaces and cgroups.");
        let schemas = super::schemas::Schemas::new()?;
        anyhow::ensure!(service.len() >= 16 && schemas.valid("cuid2", &serde_json::json!(service))?, "The service identity cannot name an execution folder.");
        let directory = self.paths.directory.join("services").join(service);
        anyhow::ensure!(directory.join("bridge").as_os_str().as_encoded_bytes().len() <= 100, "The Happy Agent private home is too long for a secure service socket. Use a shorter private home path.");
        let execution = serde_json::json!({"id":service,"directory":directory});
        anyhow::ensure!(schemas.valid("serviceExecution", &execution)?, "The private service execution is invalid.");
        Ok(execution)
    }
    pub fn prepare_service_controls(&self) -> Result<()> { private_directory(&self.paths.directory.join("services")) }
    pub fn service_read_denials(&self) -> Vec<String> {
        let home = &self.os_home;
        let configuration = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|path| path.is_absolute()).unwrap_or_else(|| home.join(".config"));
        // Source resolveServiceInputs deliberately omits the whole-home sentinel
        // while preserving every concrete credential/control path beneath it.
        let mut paths: Vec<String> = [".aws", ".azure", ".bash_history", ".claude", ".codex", ".docker", ".env", ".git-credentials", ".gnupg", ".kube", ".netrc", ".node_repl_history", ".npmrc", ".password-store", ".psql_history", ".pypirc", ".python_history", ".ssh", ".zsh_history", "Library/Keychains", ".local/share/keyrings"].into_iter().map(|relative| home.join(relative).to_string_lossy().into_owned()).collect();
        paths.extend(["1Password", "gcloud", "gh", "glab-cli", "op"].into_iter().map(|relative| configuration.join(relative).to_string_lossy().into_owned()));
        paths.extend(["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "DOCKER_CONFIG", "GIT_CONFIG_GLOBAL", "GNUPGHOME", "KUBECONFIG", "NETRC", "NPM_CONFIG_USERCONFIG"].into_iter().filter_map(|name| std::env::var(name).ok()).filter(|path| !path.is_empty()));
        paths.push(self.paths.directory.to_string_lossy().into_owned());
        paths.sort(); paths.dedup(); paths
    }
    pub async fn service_network_policy(&self, workspace: &Path) -> Result<Option<serde_json::Value>> {
        let mut values = toml::Value::Table(toml::map::Map::new());
        for path in [self.paths.configuration.join("happy.toml"), workspace.join("happy.toml")] {
            let text=read_optional_document(&path,1_048_576).await?;
            if text.is_empty(){continue;}
            let mut parsed=toml::from_str(&text)?;validate_configuration(&parsed)?;
            if path==workspace.join("happy.toml"){strip_project_machine_settings(&mut parsed);}
            merge(&mut values,parsed);
        }
        merge(&mut values, self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone());
        let Some(network) = values.get("network") else { return Ok(None); };
        let mut normalized = serde_json::Map::new();
        for (input, output) in [("allow_local_binding", "allowLocalBinding"), ("allowed_domains", "allowedDomains"), ("allowed_loopback_ports", "allowedLoopbackPorts"), ("allowed_ports", "allowedPorts"), ("denied_domains", "deniedDomains")] {
            if let Some(value) = network.get(input) { normalized.insert(output.to_owned(), serde_json::to_value(value)?); }
        }
        let normalized = serde_json::Value::Object(normalized);
        anyhow::ensure!(super::schemas::Schemas::new()?.valid("ownerManagedNetwork", &normalized)?, "The service network configuration is invalid.");
        let ports = normalized.get("allowedPorts").cloned().unwrap_or_else(|| serde_json::json!([443]));
        let mut policy = serde_json::Map::new();
        for name in ["allowLocalBinding", "allowedLoopbackPorts"] { if let Some(value) = normalized.get(name) { policy.insert(name.to_owned(), value.clone()); } }
        if let Some(domains) = normalized["allowedDomains"].as_array() { policy.insert("allowedDomains".into(), serde_json::json!(domains.iter().map(|domain| serde_json::json!({"domain":domain,"ports":ports})).collect::<Vec<_>>())); }
        if let Some(domains) = normalized["deniedDomains"].as_array() { policy.insert("deniedDomains".into(), serde_json::json!(domains.iter().map(|domain| serde_json::json!({"domain":domain})).collect::<Vec<_>>())); }
        Ok(Some(serde_json::Value::Object(policy)))
    }
    pub fn database_location(&self) -> happy_agent_base::DatabaseLocation {
        happy_agent_base::DatabaseLocation {
            directory: self.paths.directory.clone(),
            database: self.paths.database.clone(),
            ownership: self.paths.directory.join("agent.sqlite.lock"),
            store_lock: self.paths.directory.join("agent.lock"),
        }
    }
    pub fn auto_database_location(&self) -> happy_agent_base::DatabaseLocation {
        happy_agent_base::DatabaseLocation {
            directory: self.paths.directory.clone(),
            database: self.paths.directory.join("auto-agent.sqlite"),
            ownership: self.paths.directory.join("auto-agent.sqlite.lock"),
            store_lock: self.paths.directory.join("auto-agent.lock"),
        }
    }
    pub fn reviewer_models(&self, provider: &str) -> Result<Vec<serde_json::Value>> {
        anyhow::ensure!(self.provider_enabled(provider), "The selected reviewer account is unavailable.");
        let kind = self.compatible_provider_type(provider).context("The selected reviewer account is unknown.")?;
        let models = self.reviewer_catalogs[&kind].as_array().context("The selected reviewer account has no native model catalog.")?;
        let routed=if self.provider_type(provider)==Some("smart"){self.smart_route(provider)?}else{None};
        let private_route=match kind.as_str(){"codex"=>Some("openai/codex-auto-review"),"bedrock"=>Some("openai/gpt-5.4"),"claude"=>Some("anthropic/sonnet-5"),_=>None};
        Ok(models.iter().filter(|model| {
            let id=model["id"].as_str().unwrap_or_default();
            if Some(id)==private_route {return true;}
            self.model_allowed(provider,id)&&routed.as_ref().is_none_or(|route|route.models.iter().any(|route|route.model["id"]==model["id"]&&route.accounts.iter().any(|account|self.provider_enabled(account))))
        }).map(|model| { let mut model = model.clone(); model["providerId"] = serde_json::json!(provider); model }).collect())
    }
    pub fn active_model_route(&self, settings: &serde_json::Value) -> Result<serde_json::Value> {
        let (provider, model) = self.selected_route(settings)?;
        let models = self.reviewer_models(&provider)?;
        let effort = settings["effort"].as_str().or_else(|| self.values.get("defaults").and_then(|defaults| defaults.get("effort")).and_then(toml::Value::as_str)).or_else(|| models.iter().find(|entry| entry["id"] == model).and_then(|model| model["defaultEffort"].as_str())).context("No active model effort is known for automatic review.")?;
        Ok(serde_json::json!({"providerId":provider,"modelId":model,"effort":effort}))
    }
    pub async fn review_documents(&self, configuration: &serde_json::Value) -> Result<(String, String)> {
        let security = self.read_document(Document::Security).await?;
        let instructions = self.read_document(Document::Instructions).await?;
        let root = configuration["modules"]["compute"]["cwd"].as_str().or_else(|| configuration["environment"]["workingDirectory"].as_str()).context("The reviewed agent has no working directory.")?;
        let local_security = read_optional_document(&PathBuf::from(root).join("AGENTS_SECURITY.md"), Document::Security.limit()).await?;
        let local_instructions = read_optional_document(&PathBuf::from(root).join("AGENTS.md"), Document::Instructions.limit()).await?;
        Ok(([security, local_security].into_iter().filter(|text| !text.trim().is_empty()).collect::<Vec<_>>().join("\n\n"), [instructions, local_instructions].into_iter().filter(|text| !text.trim().is_empty()).collect::<Vec<_>>().join("\n\n")))
    }
    pub fn global_skills_root(&self) -> PathBuf {
        self.skills_root.clone()
    }
    pub fn global_skill_enablement(&self) -> BTreeMap<String, bool> {
        self.runtime_values
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get("skill_enablement")
            .and_then(toml::Value::as_table)
            .map(|table| {
                table
                    .iter()
                    .filter_map(|(path, enabled)| {
                        enabled.as_bool().map(|enabled| (path.clone(), enabled))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    pub async fn initial_node_name(&self) -> Result<String> {
        let schemas = super::schemas::Schemas::new()?;
        if let Some(name) = self
            .values
            .get("node")
            .and_then(|node| node.get("name"))
            .and_then(toml::Value::as_str)
        {
            anyhow::ensure!(
                schemas.valid("nodeName", &serde_json::json!(name))?,
                "The node name is invalid."
            );
            return Ok(name.to_owned());
        }
        #[cfg(target_os = "macos")]
        {
            let mut command = tokio::process::Command::new("/usr/sbin/scutil");
            command.args(["--get", "ComputerName"]).kill_on_drop(true);
            if let Ok(Ok(output)) =
                tokio::time::timeout(std::time::Duration::from_secs(1), command.output()).await
            {
                if output.stdout.len() <= 4096 {
                    if let Ok(name) = std::str::from_utf8(&output.stdout) {
                        let name = name.trim();
                        if schemas.valid("nodeName", &serde_json::json!(name))? {
                            return Ok(name.to_owned());
                        }
                    }
                }
            }
        }
        #[cfg(unix)]
        {
            let mut buffer = [0u8; 4096];
            // The operating system writes at most the supplied buffer length.
            if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0 {
                let length = buffer
                    .iter()
                    .position(|byte| *byte == 0)
                    .unwrap_or(buffer.len());
                if let Ok(name) = std::str::from_utf8(&buffer[..length]) {
                    if schemas.valid("nodeName", &serde_json::json!(name))? {
                        return Ok(name.to_owned());
                    }
                }
            }
        }
        Ok("Happy Agent".to_owned())
    }
    pub async fn write_runtime_node_name(&self, name: &str) -> Result<()> {
        anyhow::ensure!(
            super::schemas::Schemas::new()?.valid("nodeName", &serde_json::json!(name))?,
            "The node name is invalid."
        );
        self.write_runtime_field(
            "node",
            toml::Value::try_from(serde_json::json!({"name":name}))?,
        )
        .await
    }
    pub async fn write_runtime_skill_enablement(
        &self,
        enablement: BTreeMap<String, bool>,
    ) -> Result<()> {
        let encoded = serde_json::to_value(&enablement)?;
        anyhow::ensure!(
            super::schemas::Schemas::new()?.valid("ownerSkillEnablement", &encoded)?,
            "The global skill preferences are invalid."
        );
        self.write_runtime_field("skill_enablement", toml::Value::try_from(encoded)?)
            .await
    }
    async fn write_runtime_field(&self, field: &'static str, value: toml::Value) -> Result<()> {
        let _write = self.runtime_writer.lock().await;
        let mut next = self
            .runtime_values
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        next.as_table_mut()
            .context("The generated runtime configuration is invalid.")?
            .insert(field.to_owned(), value);
        let path = self.paths.directory.join("runtime.toml");
        let text = toml::to_string(&next)?;
        tokio::task::spawn_blocking(move || atomic_private(&path, text.as_bytes())).await??;
        *self
            .runtime_values
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = next;
        Ok(())
    }
    fn provider_type(&self, id: &str) -> Option<&str> {
        let entry=self.values.get("providers")?.get(id)?;
        entry.get("type").and_then(toml::Value::as_str).or_else(||["bedrock","claude","codex","grok"].into_iter().find(|kind|*kind==id))
    }
    fn compatible_provider_type(&self, id: &str) -> Option<String> {
        match self.provider_type(id)? {
            "smart" => self.smart_route(id).ok().flatten().map(|route| route.kind),
            kind => Some(kind.to_owned()),
        }
    }
    fn model_allowed(&self, provider: &str, model: &str) -> bool {
        let entry = self.values.get("providers").and_then(|entries| entries.get(provider));
        let contains = |key: &str| entry.and_then(|entry| entry.get(key)).and_then(toml::Value::as_array).map(|values| values.iter().any(|id| id.as_str() == Some(model)));
        contains("include_models") != Some(false) && contains("exclude_models") != Some(true)
    }
    fn model_available_on_account(&self, provider: &str, model: &str) -> bool {
        if self.provider_type(provider) != Some("bedrock") { return true; }
        let transport = self.bedrock_transport(provider, model);
        if matches!(model, "moonshotai/kimi-k3" | "zai/glm-5.3") && transport == "mantle" { return false; }
        if transport != "mantle" { return true; }
        let region = self.model_region(provider, model, false);
        match model {
            "anthropic/sonnet-5-5" => region == "us-gov-west-1",
            "anthropic/sonnet-5" => ["us-east-1", "us-gov-west-1", "eu-north-1", "eu-west-1", "ap-southeast-4"].contains(&region.as_str()),
            _ => true,
        }
    }
    fn bedrock_transport(&self, provider: &str, model: &str) -> &str {
        self.values.get("providers").and_then(|entries| entries.get(provider)).and_then(|entry| entry.get("model_overrides")).and_then(|entries| entries.get(model)).and_then(|entry| entry.get("transport")).and_then(toml::Value::as_str).unwrap_or_else(|| {
            if model.starts_with("anthropic/") && !matches!(model, "anthropic/fable-5-1" | "anthropic/sonnet-5-5") { "mantle" } else if model.starts_with("openai/") { "mantle" } else { "runtime" }
        })
    }
    fn configured_models(&self) -> Result<Vec<serde_json::Value>> {
        let mut models = Vec::new();
        let providers=self.values.get("providers").and_then(toml::Value::as_table);
        for (id, _) in providers.into_iter().flatten().filter(|(id,_)|self.provider_type(id)!=Some("smart")) {
            let Some(kind) = self.provider_type(id) else { continue; };
                for entry in self.catalogs[kind].as_array().into_iter().flatten() {
                    if !self.model_available_on_account(id, entry["id"].as_str().unwrap_or_default()) { continue; }
                    let mut model = entry.clone(); model["providerId"] = serde_json::json!(id); models.push(model);
                }
        }
        for (id,_) in providers.into_iter().flatten().filter(|(id,_)|self.provider_type(id)==Some("smart")) {if let Some(route)=self.smart_route(id)? {for routed in route.models {let mut model=routed.model;model["providerId"]=serde_json::json!(id);models.push(model);}}}
        Ok(models)
    }
    fn smart_route(&self, provider: &str) -> Result<Option<routing::SmartRoute>> {
        if self.provider_type(provider) != Some("smart") { return Ok(None); }
        let accounts = self.values["providers"][provider].get("providers").and_then(toml::Value::as_array).context("The smart account pool is missing its accounts.")?;
        let Some(kind) = accounts.iter().filter_map(toml::Value::as_str).filter_map(|id| self.provider_type(id)).find(|kind| *kind != "smart") else { return Ok(None); };
        let mut models = Vec::<routing::ModelRoute>::new();
        for account in accounts.iter().filter_map(toml::Value::as_str) {
            if self.provider_type(account) != Some(kind) { continue; }
            for model in self.catalogs[kind].as_array().into_iter().flatten() {
                let id = model["id"].as_str().context("The curated model identity is missing.")?;
                if !self.model_available_on_account(account, id) || !self.model_allowed(account, id) { continue; }
                let region = if kind == "bedrock" { self.values["providers"][account].get("model_overrides").and_then(|overrides| overrides.get(id)).and_then(|entry| entry.get("region")).or_else(|| self.values["providers"][account].get("region")).and_then(toml::Value::as_str).map(str::to_owned) } else { None };
                let index = models.iter().position(|entry| entry.model["id"] == id).unwrap_or_else(|| { models.push(routing::ModelRoute { model:model.clone(), accounts:Vec::new(), region:region.clone() }); models.len()-1 });
                let route = &mut models[index];
                if kind == "bedrock" && !route.accounts.is_empty() && (route.region.is_none() || region.is_none() || route.region != region) { continue; }
                route.accounts.push(account.to_owned());
            }
        }
        Ok(Some(routing::SmartRoute { kind:kind.to_owned(), models }))
    }
    fn provider_signal(&self, id: &str) -> tokio_util::sync::CancellationToken {
        let mut signals = self.provider_signals.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        signals.entry(id.to_owned()).or_insert_with(|| { let signal = self.provider_lifetime.child_token(); if !self.provider_enabled(id) { signal.cancel(); } signal }).clone()
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
        let Some(previous_type) = self.compatible_provider_type(previous_provider) else {
            return Ok(false);
        };
        let next_type = self
            .compatible_provider_type(next_provider)
            .context("The selected provider is unavailable.")?;
        let Some(family) = self.compatibility["families"][previous_model].as_str() else {
            return Ok(false);
        };
        if self.compatibility["families"][next_model] != family {
            return Ok(false);
        }
        if !self.compatibility["matrix"][&previous_type][&next_type]
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
        if let Some(enabled) = self.provider_enablement.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(id) { return *enabled; }
        if let Some(enabled)=self.configured_provider_override(id){return enabled;}
        if self.provider_auto_enable(id)==Some(true){return true;}
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
        let routed = if kind == "smart" { self.smart_route(provider).ok().flatten().and_then(|route| route.models.into_iter().find(|route| route.model["id"] == mode["modelId"] && route.accounts.iter().any(|id| self.provider_enabled(id)))).map(|route| route.model) } else { None };
        let Some(model) = (if kind == "smart" { routed.as_ref() } else { self.catalogs.get(kind).and_then(serde_json::Value::as_array).and_then(|catalog| catalog.iter().find(|entry| entry["id"] == mode["modelId"])) }) else {
            return false;
        };
        let model_id = model["id"].as_str().unwrap_or("");
        if !self.model_available_on_account(provider, model_id) { return false; }
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
        let mut environment=self.current_agent_environment()?;
        environment["workingDirectory"]=json!(root);
        Ok(
            json!({"provenance":{"createdAt":created},"environment":environment,"metadata":metadata,"modules":{"compute":{"cwd":root,"secretScope":{"projectId":project,"workspaceId":workspace}}}}),
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
    fn session_configuration(
        &self,
        settings: &serde_json::Value,
    ) -> Result<(String, happy_providers::ProviderConfig)> {
        self.concrete_configuration(settings, true)
    }
    fn selected_route(&self, settings: &serde_json::Value) -> Result<(String, String)> {
        if let (Some(provider),Some(model))=(settings["provider"].as_str(),settings["model"].as_str()){return Ok((provider.to_owned(),model.to_owned()));}
        let provider=settings["provider"].as_str().map(str::to_owned).map(Ok).unwrap_or_else(||self.default_provider())?;
        let selected=self.naming_models()?.into_iter().find(|model|model["providerId"]==provider&&settings["model"].as_str().is_none_or(|id|model["id"]==id)).context("No enabled inference model is selected.")?;
        Ok((selected["providerId"].as_str().context("The default inference account is invalid.")?.to_owned(),selected["id"].as_str().context("The default inference model is invalid.")?.to_owned()))
    }
    pub fn default_provider(&self) -> Result<String> {
        if let Some(provider)=self.default_provider.get(){return Ok(provider.clone());}
        let selected=self.naming_models()?.into_iter().next().or_else(||self.offered_models().ok()?.into_iter().next()).context("No provider model is configured.")?;
        let provider=selected["providerId"].as_str().context("The default inference account is invalid.")?.to_owned();
        let _=self.default_provider.set(provider);
        Ok(self.default_provider.get().expect("The default provider was initialized.").clone())
    }
    fn route_enablement(&self) -> routing::Enablement {
        let defaults = self.values.get("providers").and_then(toml::Value::as_table).into_iter().flatten().filter_map(|(id, _)| self.provider_type(id).map(|_| {let _ = self.provider_signal(id); (id.clone(), self.provider_enabled(id))})).collect();
        routing::Enablement {defaults,overrides:self.provider_enablement.clone(),signals:self.provider_signals.clone(),shutdown:self.provider_lifetime.clone()}
    }
    fn concrete_configuration(&self, settings:&serde_json::Value, require_enabled:bool) -> Result<(String, happy_providers::ProviderConfig)> {
        use happy_providers::{
            BedrockTransport, CredentialSource, ProviderConfig, ProviderKind, Transport,
        };
        let (selected_provider,selected_model)=self.selected_route(settings)?;
        let provider=selected_provider.as_str();
        let model=selected_model.as_str();
        let entry = self
            .values
            .get("providers")
            .and_then(|providers| providers.get(provider));
        let field = |name: &str| entry.and_then(|entry| entry.get(name));
        let configured_kind = field("type")
            .and_then(toml::Value::as_str)
            .unwrap_or(provider);
        anyhow::ensure!(
            !require_enabled || self.provider_enabled(provider),
            "The selected inference provider is disabled."
        );
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
        let credential = if configured_kind=="claude" {
            CredentialSource::Claude {oauth_token:field("oauth_token").and_then(toml::Value::as_str).map(str::to_owned),api_key:field("api_key").and_then(toml::Value::as_str).map(str::to_owned),auth_token:field("auth_token").and_then(toml::Value::as_str).map(str::to_owned),config_dir:field("config_dir").and_then(toml::Value::as_str).map(PathBuf::from),ambient:field("credential_isolation").and_then(toml::Value::as_bool)!=Some(true)}
        } else if let Some(token) = field("api_key").and_then(toml::Value::as_str) {
            CredentialSource::Bearer {
                token: token.to_owned(),
            }
        } else {
            anyhow::ensure!(
                field("credential_isolation").and_then(toml::Value::as_bool) != Some(true)
                    || (matches!(configured_kind,"codex"|"grok")&&field("auth_file").and_then(toml::Value::as_str).is_some()),
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
                (_, ProviderKind::Codex) => CredentialSource::Codex { auth_file,ambient:field("credential_isolation").and_then(toml::Value::as_bool)!=Some(true) },
                (_, ProviderKind::Grok) => CredentialSource::Grok { auth_file,ambient:field("credential_isolation").and_then(toml::Value::as_bool)!=Some(true) },
                (_, ProviderKind::Claude) => CredentialSource::Claude {oauth_token:field("oauth_token").and_then(toml::Value::as_str).map(str::to_owned),api_key:None,auth_token:field("auth_token").and_then(toml::Value::as_str).map(str::to_owned),config_dir:field("config_dir").and_then(toml::Value::as_str).map(PathBuf::from),ambient:field("credential_isolation").and_then(toml::Value::as_bool)!=Some(true)},
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
            endpoint: if configured_kind == "bedrock" {field("model_overrides").and_then(|overrides| overrides.get(model)).and_then(|entry| entry.get("endpoint")).and_then(toml::Value::as_str).map(str::to_owned)} else {field("base_url")
                .and_then(toml::Value::as_str)
                .map(str::to_owned)},
            transport,
            bedrock: if configured_kind == "bedrock" {
                Some(if self.bedrock_transport(provider, model) == "runtime" {
                    BedrockTransport::Runtime
                } else {
                    BedrockTransport::Mantle
                })
            } else {
                None
            },
            region: self.model_region(provider, model, true),
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
        Ok((provider.to_owned(), config))
    }
    pub fn session_key(
        &self,
        settings: &serde_json::Value,
        tools: &[happy_providers::ToolDefinition],
    ) -> Result<String> {
        use sha2::{Digest, Sha256};
        let (provider, model) = self.selected_route(settings)?;
        if self.provider_type(&provider) == Some("smart") {
            let route=self.smart_route(&provider)?.context("The selected account pool has no compatible route.")?;
            let route=route.models.into_iter().find(|route| route.model["id"] == model).context("The selected account pool has no compatible route for this model.")?;
            let configurations=route.accounts.iter().map(|account| self.concrete_configuration(&serde_json::json!({"provider":account,"model":model}),false).map(|(_,configuration)|configuration)).collect::<Result<Vec<_>>>()?;
            return Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(&serde_json::json!([provider,model,configurations,tools]))?)));
        }
        let (_, mut config) = self.session_configuration(settings)?;
        // The request chooses model and effort. Construction owns the account,
        // protocol family, credentials, endpoint, transport and actual tool array.
        config.model.clear();
        let serialized = serde_json::to_vec(&serde_json::json!([provider, config, tools]))?;
        Ok(format!("{:x}", Sha256::digest(serialized)))
    }
    pub async fn session(
        &self,
        agent: &str,
        settings: &serde_json::Value,
        tools: Vec<happy_providers::ToolDefinition>,
    ) -> Result<Box<dyn happy_providers::Session>> {
        self.session_internal(agent,settings,tools,None,true).await
    }
    async fn session_internal(&self,agent:&str,settings:&serde_json::Value,tools:Vec<happy_providers::ToolDefinition>,retry_limit:Option<u32>,retain_route:bool)->Result<Box<dyn happy_providers::Session>> {
        let (provider,model)=self.selected_route(settings)?;
        anyhow::ensure!(self.provider_enabled(&provider),"The selected inference provider is disabled.");
        let enablement=self.route_enablement();
        let inner:Box<dyn happy_providers::Session>=if self.provider_type(&provider)==Some("smart") {
            let route=self.smart_route(&provider)?.context("The selected account pool has no compatible route.")?;
            let route=route.models.into_iter().find(|route| route.model["id"]==model).context("The selected account pool has no compatible route for this model.")?;
            anyhow::ensure!(self.model_allowed(&provider,&model)&&route.accounts.iter().any(|id|self.provider_enabled(id)),"The selected account pool has no enabled account for this model.");
            let candidates=route.accounts.iter().map(|account|self.concrete_configuration(&serde_json::json!({"provider":account,"model":model}),false).map(|(id,mut configuration)|{if let Some(limit)=retry_limit {configuration.inference_max_retries=limit;}(id,configuration)})).collect::<Result<Vec<_>>>()?;
            let state=if retain_route {let mut states=self.route_states.lock().unwrap_or_else(std::sync::PoisonError::into_inner);let key=(provider.clone(),model.clone(),agent.to_owned());anyhow::ensure!(states.contains_key(&key)||states.len()<10_000,"The account pool reached its retained agent route limit.");states.entry(key).or_insert_with(||Arc::new(Mutex::new(routing::RouteState::new(candidates.len())))).clone()}else{Arc::new(Mutex::new(routing::RouteState::new(candidates.len())))};
            Box::new(routing::RoutedSession::new(agent.to_owned(),model,candidates,tools,state,enablement.clone()))
        } else {
            let (_,mut config)=self.session_configuration(settings)?;
            if let Some(limit)=retry_limit {config.inference_max_retries=limit;}
            anyhow::ensure!(self.model_allowed(&provider,&model)&&self.model_available_on_account(&provider,&model),"The selected model is unavailable on this provider account.");
            Box::new(happy_providers::HttpSession::new(agent.into(),config,tools).await?)
        };
        Ok(Box::new(routing::BoundSession {inner,provider,enablement}))
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
        Self::from_home(normalize_path(&home))
    }

    #[cfg(test)]
    pub(super) fn isolated(home: &Path) -> Result<Self> {
        let mut config = Self::from_home(home.to_owned())?;
        config.skills_root = home
            .parent()
            .context("The isolated Happy home has no parent.")?
            .join(".agents/skills");
        config.os_home = home.parent().context("The isolated Happy home has no parent.")?.to_owned();
        config.projects_root = config.os_home.join("Happy/Projects");
        config.workspaces_root = config.os_home.join(if cfg!(target_os = "macos") { "Happy/Workspaces" } else { "happy/workspaces" });
        Ok(config)
    }

    fn from_home(home: PathBuf) -> Result<Self> {
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
        let defaults:serde_json::Value=serde_json::from_str(include_str!("config/default_values.json"))?;
        let mut values:toml::Value=toml::Value::try_from(default_input(&defaults))?;
        let mut global_values=toml::Value::Table(toml::map::Map::new());
        let mut runtime_values = toml::Value::Table(toml::map::Map::new());
        for path in [
            paths.configuration.join("happy.toml"),
            paths.directory.join("runtime.toml"),
        ] {
            match read_text_limited(&path,1_048_576) {
                Ok(text) => merge(&mut values, {
                    let parsed: toml::Value = toml::from_str(&text).with_context(|| {
                        format!("Cannot read configuration at {}.", path.display())
                    })?;
                    anyhow::ensure!(text.len() <= 1_048_576, "Configuration exceeds the 1048576-byte limit.");
                    let parsed=normalize_configuration(&parsed)?;
                    if path == paths.directory.join("runtime.toml") {
                        runtime_values = parsed.clone();
                    } else {
                        global_values=parsed.clone();
                    }
                    parsed
                }),
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
        let reviewer_catalogs = serde_json::from_str(include_str!("auto_model_catalogs.json"))?;
        let compatibility = serde_json::from_str(include_str!("model_compatibility.json"))?;
        anyhow::ensure!(
            super::schemas::Schemas::new()?.valid("nativeCatalog", &catalogs)?,
            "The curated native model catalog is invalid."
        );
        anyhow::ensure!(
            super::schemas::Schemas::new()?.valid("nativeModelCompatibility", &compatibility)?,
            "The curated model compatibility matrix is invalid."
        );
        anyhow::ensure!(super::schemas::Schemas::new()?.valid("autoReviewCatalogs", &reviewer_catalogs)?, "The private reviewer model catalog is invalid.");
        let os_home = home_directory()?;
        let projects_root = managed_root("HAPPY_AGENT_PROJECTS_DIRECTORY", os_home.join("Happy/Projects"))?;
        let workspaces_root = managed_root("HAPPY_AGENT_WORKSPACES_DIRECTORY", os_home.join(if cfg!(target_os = "macos") { "Happy/Workspaces" } else { "happy/workspaces" }))?;
        let runners = normalized_runners(&values)?;
        Ok(Self {
            paths,
            values,
            global_values,
            catalogs,
            reviewer_catalogs,
            compatibility,
            runtime_values: Mutex::new(runtime_values),
            runtime_writer: tokio::sync::Mutex::new(()),
            skills_root: home_directory()?.join(".agents/skills"),
            os_home,
            projects_root,
            workspaces_root,
            runners,
            provider_lifetime: tokio_util::sync::CancellationToken::new(),
            default_provider: OnceLock::new(),
            provider_enablement: Arc::new(Mutex::new(BTreeMap::new())),
            provider_signals: Arc::new(Mutex::new(BTreeMap::new())),
            route_states: Mutex::new(BTreeMap::new()),
            #[cfg(test)]
            cloud_test_deployment: Mutex::new(None),
            #[cfg(test)]
            tailcat_test_executable: None,
            #[cfg(test)]
            tailcat_test_port: None,
            #[cfg(test)]
            workflow_test_executable: None,
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
            match read_text_limited(&self.paths.token,512) {
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
    merge_table(base, next, true);
}
fn default_input(value:&serde_json::Value)->serde_json::Value {
    match value {
        serde_json::Value::Object(values)=>serde_json::Value::Object(values.iter().map(|(key,value)| {
            let key=match key.as_str(){"modelId"=>"model".to_owned(),"providerId"=>"provider".to_owned(),key=>{let mut result=String::new();for character in key.chars(){if character.is_ascii_uppercase(){result.push('_');result.push(character.to_ascii_lowercase());}else{result.push(character);}}result}};
            (key,default_input(value))
        }).collect()),
        serde_json::Value::Array(values)=>serde_json::Value::Array(values.iter().map(default_input).collect()),
        value=>value.clone(),
    }
}
fn merge_table(base: &mut toml::Value, next: toml::Value, root: bool) {
    match (base, next) {
        (toml::Value::Table(base), toml::Value::Table(next)) => {
            for (key, value) in next {
                if let Some(base) = base.get_mut(&key) {
                    if root&&key=="presence"&&value.get("current").is_some() {if let Some(base)=base.as_table_mut(){base.remove("fallback");base.remove("until");}}
                    if root && key == "connections" {
                        match (base, value) { (toml::Value::Table(base), toml::Value::Table(next)) => base.extend(next), (base, next) => *base = next }
                    } else { merge_table(base, value, false); }
                } else {
                    base.insert(key, value);
                }
            }
        }
        (base, next) => *base = next,
    }
}

fn managed_root(variable: &str, fallback: PathBuf) -> Result<PathBuf> {
    let value = std::env::var(variable).unwrap_or_default();
    let value = value.trim();
    if value.is_empty() { return Ok(fallback); }
    let path = PathBuf::from(value);
    anyhow::ensure!(path.is_absolute(), "{variable} must be an absolute path.");
    Ok(normalize_path(&path))
}
fn normalized_runners(values: &toml::Value) -> Result<serde_json::Value> {
    let Some(configuration) = values.get("runners") else { return Ok(serde_json::json!({"entries":{}})); };
    let mut entries = serde_json::to_value(configuration)?;
    let default = entries.as_object_mut().context("The runner configuration must be a table.")?.remove("default");
    let mut result = serde_json::json!({"entries":entries});
    if let Some(default) = default { result["defaultId"] = default; }
    let schemas = super::schemas::Schemas::new()?;
    anyhow::ensure!(schemas.valid("ownerRunnersConfiguration", &result)?, "The runner configuration is invalid.");
    let entries = result["entries"].as_object().unwrap();
    if let Some(default) = result["defaultId"].as_str() { anyhow::ensure!(entries.contains_key(default), "The default runner is not configured."); }
    else if entries.len() == 1 { result["defaultId"] = serde_json::json!(entries.keys().next().unwrap()); }
    else { anyhow::ensure!(entries.is_empty(), "A default runner must be selected when several runners are configured."); }
    Ok(result)
}
fn workspace_folder_settings(values: &toml::Value, defaults: &serde_json::Value) -> serde_json::Value {
    let mut result = defaults.clone();
    if let Some(workspace) = values.get("workspace") {
        for (input, output) in [("keep_copies_on_archive", "keepCopiesOnArchive"), ("keep_worktrees_on_archive", "keepWorktreesOnArchive"), ("protected_sync", "protectedSync"), ("setup_commands", "setupCommands"), ("sync", "sync")] {
            if let Some(value) = workspace.get(input) { if let Ok(value) = serde_json::to_value(value) { result[output] = value; } }
        }
    }
    result
}

fn read_text_limited(path:&Path,limit:usize)->std::io::Result<String> {
    use std::io::Read;
    let file=fs::File::open(path)?;
    let mut bytes=Vec::new();file.take(limit as u64+1).read_to_end(&mut bytes)?;
    if bytes.len()>limit{return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"The configuration file exceeds its size limit."));}
    String::from_utf8(bytes).map_err(|_|std::io::Error::new(std::io::ErrorKind::InvalidData,"The configuration file is not valid UTF-8."))
}
fn strip_project_machine_settings(values:&mut toml::Value) {
    let Some(values)=values.as_table_mut() else{return;};
    for name in ["skill_enablement","api","connections","runners","docker","gemini","observation","p2p","node","profile","provider_default_enable","providers","skills"] {values.remove(name);}
    for (section,fields) in [
        ("defaults",&["permission_mode"][..]),
        ("feature",&["tailcat","team"][..]),
        ("settings",&["daemon_heap_snapshots","durable_global_event_queue","ethan","happy_integration","inference_max_retries","max_collaboration_depth","max_collaborators","menu_bar","tool_result_retention_days"][..]),
    ] {
        if let Some(table)=values.get_mut(section).and_then(toml::Value::as_table_mut) {for name in fields {table.remove(*name);}if table.is_empty(){values.remove(section);}}
    }
}
fn validate_configuration(values: &toml::Value) -> Result<()> {
    normalize_configuration(values).map(|_|())
}
fn normalize_configuration(values: &toml::Value) -> Result<toml::Value> {
    use serde_json::{Value, json};
    static REFERENCE: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    let reference = REFERENCE.get_or_init(|| serde_json::from_str(include_str!("configuration_schemas.json")).expect("The original configuration schemas were generated."));
    let schemas = super::schemas::Schemas::new()?;
    let mut raw = toml_json(values);
    if let Some(until)=values.get("presence").and_then(|presence|presence.get("until")).filter(|value|value.as_datetime().is_some()){raw["presence"]["until"]=json!(presence::date(until)?);}
    anyhow::ensure!(schemas.valid("ownerConfigTable", &raw)?, "The Happy Agent configuration must be a table containing at most 512 properties.");
    if let Some(providers) = raw.get_mut("providers") {
        anyhow::ensure!(schemas.valid("ownerConfigTable", providers)?, "The provider configuration must be a table.");
        let default = providers.as_object_mut().unwrap().remove("default_enable");
        let mut normalized = serde_json::Map::new();
        for (id, value) in providers.as_object().unwrap() {
            let kind = value["type"].as_str().or_else(|| ["bedrock", "claude", "codex", "grok"].contains(&id.as_str()).then_some(id.as_str())).context("Each custom provider must select a supported provider type.")?;
            let schema = reference["providers"].get(kind).context("The configured provider type is unsupported.")?;
            anyhow::ensure!(!["bedrock", "claude", "codex", "grok"].contains(&id.as_str()) || kind == id, "A built-in provider must retain its provider type.");
            let value = selected_fields(value, schema, &schemas)?;
            anyhow::ensure!(schemas.valid(&format!("ownerProviderInput_{kind}"), &value)?, "The configured provider contains an invalid value.");
            normalized.insert(id.clone(), value);
        }
        *providers = Value::Object(normalized);
        if let Some(default) = default { raw["provider_default_enable"] = default; }
    }
    if let Some(runners) = raw.get_mut("runners") {
        anyhow::ensure!(schemas.valid("ownerConfigTable", runners)?, "The runner configuration must be a table.");
        let mut entries = runners.as_object().unwrap().clone();
        let default = entries.remove("default");
        *runners = json!({"entries":entries});
        if let Some(default) = default { runners["default"] = default; }
    }
    let mut normalized = serde_json::Map::new();
    for (name, value) in raw.as_object().unwrap() {
        let Some(schema) = reference["partialValues"]["properties"].get(name) else { continue; };
        let value = if ["defaults", "docker", "features", "gemini", "network", "observation", "p2p", "permissions", "presence", "settings", "skills", "theme", "workspace"].contains(&name.as_str()) { selected_fields(value, schema, &schemas)? } else if name == "feature" {
            let mut feature = selected_fields(value, schema, &schemas)?;
            for (kind, value) in feature.as_object_mut().unwrap() { *value = selected_fields(value, &schema["properties"][kind], &schemas)?; }
            feature
        } else { value.clone() };
        normalized.insert(name.clone(), value);
    }
    let mut normalized=Value::Object(normalized);
    anyhow::ensure!(schemas.valid("ownerConfigPartialValues", &normalized)?, "The Happy Agent configuration contains an invalid value.");
    if let Some(runners)=normalized.get_mut("runners"){let mut entries=runners["entries"].as_object().unwrap().clone();if let Some(default)=runners.get("default"){entries.insert("default".into(),default.clone());}*runners=Value::Object(entries);}
    Ok(toml::Value::try_from(normalized)?)
}
fn selected_fields(value: &serde_json::Value, schema: &serde_json::Value, schemas: &super::schemas::Schemas) -> Result<serde_json::Value> {
    anyhow::ensure!(schemas.valid("ownerConfigTable", value)?, "The configuration section must be a table containing at most 512 properties.");
    let properties = schema["properties"].as_object().context("The original configuration section has no object schema.")?;
    Ok(serde_json::Value::Object(value.as_object().unwrap().iter().filter(|(key, _)| properties.contains_key(*key)).map(|(key,value)| (key.clone(),value.clone())).collect()))
}
fn toml_json(value: &toml::Value) -> serde_json::Value {
    match value {
        toml::Value::Table(table) => serde_json::Value::Object(table.iter().map(|(key,value)| (key.clone(),toml_json(value))).collect()),
        toml::Value::Array(values) => serde_json::json!(values.iter().map(toml_json).collect::<Vec<_>>()),
        // A TOML date must not silently satisfy a TypeBox string field.
        toml::Value::Datetime(_) => serde_json::json!({"nativeTomlDate":true}),
        value => serde_json::to_value(value).expect("The TOML parser produced a JSON scalar."),
    }
}

async fn read_optional_document(path: &Path, limit: usize) -> Result<String> {
    use tokio::io::AsyncReadExt;
    let file = match tokio::fs::File::open(path).await { Ok(file) => file, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()), Err(error) => return Err(error.into()) };
    let mut content = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut content).await?;
    anyhow::ensure!(content.len() <= limit, "The review policy document exceeds its size limit.");
    String::from_utf8(content).context("The review policy document is not valid UTF-8.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn unknown_configuration_fields_are_ignored_before_provider_construction() {
        let directory=tempfile::tempdir().unwrap();let home=directory.path().join(".happy");
        let public=directory.path().join(if cfg!(target_os="macos"){"Happy/Config"}else{"happy/config"});std::fs::create_dir_all(&public).unwrap();
        std::fs::write(public.join("happy.toml"),"unknown_root='ignore'\n[providers.named]\ntype='bedrock'\napi_key='fixture-placeholder-must-not-be-consumed'\nregion='us-east-1'\n[settings]\nshow_reasoning=true\nunknown_setting='ignore'\n").unwrap();
        let config=ConfigModule::isolated(&home).unwrap();
        assert!(config.values.get("unknown_root").is_none());
        assert!(config.values["providers"]["named"].get("api_key").is_none(),"An unrecognized Bedrock API-key field must never become a credential.");
        assert!(config.values["settings"].get("unknown_setting").is_none());
        assert_eq!(config.values["settings"]["show_reasoning"].as_bool(),Some(true));
    }
    #[tokio::test]
    async fn newly_remembered_credentials_reopen_the_owned_provider_signal() {
        let directory=tempfile::tempdir().unwrap();let mut config=ConfigModule::isolated(directory.path()).unwrap();
        config.values.as_table_mut().unwrap().insert("providers".into(),toml::from_str("[fixture]\ntype='codex'\ncredential_isolation=true\n").unwrap());
        config.set_provider_enabled("fixture",false).unwrap();let disabled=config.provider_signal("fixture");assert!(disabled.is_cancelled());
        config.update_runtime_provider_states(&BTreeMap::from([("fixture".to_owned(),json!({"autoEnable":true}))])).await.unwrap();config.set_provider_enabled("fixture",true).unwrap();
        assert!(!config.provider_signal("fixture").is_cancelled(),"A positive scan must reopen the signal used by inference.");
        assert!(disabled.is_cancelled(),"An old disabled lifetime is never revived in place.");
    }
    #[test]
    fn smart_catalog_keeps_exact_models_and_the_first_concrete_family() {
        let directory = tempfile::tempdir().unwrap();
        let mut config = ConfigModule::isolated(directory.path()).unwrap();
        config.values = toml::from_str(r#"
            [providers.anchor]
            type = "codex"
            enabled = false
            include_models = ["openai/gpt-5.6-sol"]
            [providers.other_family]
            type = "claude"
            enabled = true
            [providers.account]
            type = "codex"
            enabled = true
            include_models = ["openai/gpt-5.6-sol", "openai/gpt-5.6-luna"]
            exclude_models = ["openai/gpt-5.6-luna"]
            [providers.pool]
            type = "smart"
            enabled = true
            providers = ["absent", "anchor", "other_family", "account", "pool"]
        "#).unwrap();
        let catalog = config.naming_models().unwrap();
        let pool = catalog.iter().filter(|model| model["providerId"] == "pool").collect::<Vec<_>>();
        assert_eq!(pool.len(), 1);
        assert_eq!(pool[0]["id"], "openai/gpt-5.6-sol");
        let mode = json!({"providerId":"pool","modelId":"openai/gpt-5.6-sol","effort":pool[0]["defaultEffort"],"serviceTier":null});
        assert!(config.mode_available(&mode));
        config.set_provider_enabled("account", false).unwrap();
        assert!(!config.mode_available(&mode));
        assert!(!config.naming_models().unwrap().iter().any(|model| model["providerId"] == "pool"));
        config.set_provider_enabled("anchor", true).unwrap();
        assert!(config.mode_available(&mode));
    }
    #[tokio::test]
    async fn runtime_remote_entries_replace_the_complete_global_authentication_entry() {
        let directory = tempfile::tempdir().unwrap();
        let mut config = ConfigModule::isolated(directory.path()).unwrap();
        config.values.as_table_mut().unwrap().insert("connections".into(), toml::Value::try_from(json!({"remote":{"name":"Remote","address":"tcglobal","token":"x".repeat(43)}})).unwrap());
        config.write_runtime_connection("remote", &json!({"enabled":false})).await.unwrap();
        assert_eq!(config.remote_connections().unwrap()["remote"], json!({"enabled":false}));
        config.write_runtime_connection("remote", &json!({"name":"Team","address":"tcteam","workos_organization_id":"org_fixture"})).await.unwrap();
        let entry = config.remote_connections().unwrap()["remote"].clone();
        assert_eq!(entry, json!({"name":"Team","address":"tcteam","workos_organization_id":"org_fixture"}));
        assert!(!std::fs::read_to_string(config.paths.directory.join("runtime.toml")).unwrap().contains(&"x".repeat(43)));
    }
}
