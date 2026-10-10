use crate::protocol::{
    self,
    stream::{BedrockDecoder, Mapper, Protocol, SseDecoder},
};
use crate::{
    Accumulator, Block, Compaction, Credential, CredentialSource, ErrorKind, Event, Message,
    Outcome, ProviderError, RunRequest, Session, SessionContext, ToolDefinition,
};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
use tokio::{net::TcpStream, sync::mpsc};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{self, client::IntoClientRequest},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Codex,
    Responses,
    Grok,
    Claude,
    Kimi,
    Glm,
}
#[derive(Clone, Copy, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    #[default]
    Auto,
    Sse,
    Websocket,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BedrockTransport {
    Mantle,
    Runtime,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub credential: CredentialSource,
    pub model: String,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub transport: Transport,
    #[serde(default)]
    pub bedrock: Option<BedrockTransport>,
    #[serde(default = "default_region")]
    pub region: String,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default = "default_retries")]
    pub inference_max_retries: u32,
    #[serde(default = "default_idle")]
    pub stream_idle_timeout_ms: u64,
    #[serde(default)]
    pub responses_features: bool,
    #[serde(default)]
    pub parallel_tool_calls: bool,
    #[serde(default = "yes")]
    pub native_compaction: bool,
}
fn default_region() -> String {
    std::env::var("AWS_REGION")
        .or_else(|_| std::env::var("AWS_DEFAULT_REGION"))
        .unwrap_or_else(|_| "us-east-1".to_owned())
}
fn default_retries() -> u32 {
    10
}
fn default_idle() -> u64 {
    300_000
}
fn yes() -> bool {
    true
}

pub struct HttpSession {
    id: String,
    config: ProviderConfig,
    tools: Vec<ToolDefinition>,
    credential: Credential,
    endpoint: String,
    client: reqwest::Client,
    websocket: Option<WebSocketStream<MaybeTlsStream<TcpStream>>>,
    sse_only: bool,
    turn_state: Option<String>,
    warm: Option<Value>,
    previous: Option<Value>,
    previous_input: Vec<Value>,
    window_id: String,
}
impl HttpSession {
    pub async fn new(
        id: String,
        config: ProviderConfig,
        tools: Vec<ToolDefinition>,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            !config.model.trim().is_empty(),
            "A provider model is required."
        );
        anyhow::ensure!(
            config.inference_max_retries <= 100,
            "Inference retry budgets cannot exceed 100."
        );
        anyhow::ensure!(
            config.stream_idle_timeout_ms > 0,
            "Stream idle timeout must be positive."
        );
        let credential = Credential::load(config.credential.clone(), &config.region).await?;
        let endpoint = if let Some(endpoint) = &config.endpoint {
            endpoint.clone()
        } else if let Some(transport) = config.bedrock {
            match (config.kind, transport) {
                (ProviderKind::Claude, BedrockTransport::Mantle) => {
                    format!("https://bedrock-mantle.{}.api.aws/anthropic", config.region)
                }
                (ProviderKind::Claude, BedrockTransport::Runtime) => {
                    format!("https://bedrock-runtime.{}.amazonaws.com", config.region)
                }
                (ProviderKind::Kimi | ProviderKind::Glm, _) => format!(
                    "https://bedrock-runtime.{}.amazonaws.com/openai/v1",
                    config.region
                ),
                (_, _) => format!("https://bedrock-mantle.{}.api.aws/openai/v1", config.region),
            }
        } else {
            match config.kind {
                ProviderKind::Codex if credential.is_codex_session().await => {
                    "https://chatgpt.com/backend-api".to_owned()
                }
                ProviderKind::Codex => "https://api.openai.com/v1".to_owned(),
                ProviderKind::Grok => "https://cli-chat-proxy.grok.com/v1".to_owned(),
                ProviderKind::Claude => "https://api.anthropic.com/v1".to_owned(),
                ProviderKind::Responses => {
                    anyhow::bail!("Responses providers require an explicit endpoint.")
                }
                _ => anyhow::bail!("Kimi and GLM require a Bedrock transport."),
            }
        };
        let parsed = reqwest::Url::parse(&endpoint)?;
        anyhow::ensure!(
            matches!(parsed.scheme(), "http" | "https")
                && parsed.username().is_empty()
                && parsed.password().is_none(),
            "Provider endpoints must be HTTP URLs without embedded credentials."
        );
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let sse_only = config.transport == Transport::Sse
            || config.kind != ProviderKind::Codex
            || config.bedrock.is_some();
        Ok(Self {
            id,
            config,
            tools,
            credential,
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            client,
            websocket: None,
            sse_only,
            turn_state: None,
            warm: None,
            previous: None,
            previous_input: Vec::new(),
            window_id: uuid::Uuid::new_v4().to_string(),
        })
    }
    fn protocol(&self) -> Protocol {
        match self.config.kind {
            ProviderKind::Claude => Protocol::Anthropic,
            ProviderKind::Kimi | ProviderKind::Glm => Protocol::Chat,
            _ => Protocol::Responses,
        }
    }
    fn model(&self, selected: Option<&str>) -> Result<String, ProviderError> {
        let model = selected.unwrap_or(&self.config.model);
        let canonical = model.strip_prefix("openai/").unwrap_or(model);
        if self.config.bedrock.is_none() {
            return Ok(canonical
                .strip_prefix("anthropic/")
                .map(|m| format!("claude-{m}"))
                .unwrap_or_else(|| canonical.to_owned()));
        }
        let geo = if self.config.region.starts_with("us-") {
            "us"
        } else {
            "global"
        };
        match self.config.kind {
            ProviderKind::Kimi if matches!(model, "moonshotai/kimi-k3" | "kimi-k3") => {
                Ok(format!("{geo}.moonshotai.kimi-k3"))
            }
            ProviderKind::Glm if matches!(model, "zai/glm-5.3" | "glm-5.3") => {
                Ok(format!("{geo}.zai.glm-5.3"))
            }
            ProviderKind::Codex if canonical.starts_with("gpt-") => {
                Ok(format!("openai.{canonical}"))
            }
            ProviderKind::Claude if model.starts_with("anthropic/") => {
                let name = model.trim_start_matches("anthropic/");
                if !matches!(
                    name,
                    "fable-5-1" | "fable-5" | "opus-5-5" | "opus-5" | "opus-4-8" | "sonnet-5-5" | "sonnet-5"
                ) {
                    return Err(invalid(&format!(
                        "Anthropic model \"{model}\" is not available through Rig's Bedrock catalog. Pass a Bedrock model or inference-profile ID directly to use an unlisted model."
                    )));
                }
                let base = format!("anthropic.claude-{name}");
                if self.config.bedrock == Some(BedrockTransport::Mantle) {
                    return Ok(base);
                }
                let geo = if name == "sonnet-5-5" {
                    "global"
                } else if name.starts_with("opus-")
                    && matches!(
                        self.config.region.as_str(),
                        "ap-northeast-1" | "ap-northeast-3"
                    )
                {
                    "jp"
                } else if (self.config.region == "ap-southeast-2" && name.starts_with("opus-"))
                    || (name == "sonnet-5"
                        && matches!(self.config.region.as_str(), "ap-southeast-2" | "ap-southeast-4"))
                {
                    "au"
                } else if self.config.region.starts_with("eu-") && name != "fable-5-1" {
                    "eu"
                } else {
                    geo
                };
                Ok(format!("{geo}.{base}"))
            }
            _ => Ok(model.to_owned()),
        }
    }
    fn lite(&self, model: &str) -> bool {
        self.config.kind == ProviderKind::Codex
            && self.config.bedrock.is_none()
            && !self.config.parallel_tool_calls
            && matches!(
                model,
                "gpt-6.1-sol"
                    | "gpt-6-astra"
                    | "gpt-6-sol"
                    | "gpt-6-luna"
                    | "gpt-5.6-sol"
                    | "gpt-5.6-luna"
                    | "gpt-5.6-terra"
            )
    }
    async fn payload(
        &self,
        request: &RunRequest,
        compact: Option<Option<String>>,
    ) -> Result<Value, ProviderError> {
        let model = self.model(request.model.as_deref())?;
        let mut request = request.clone();
        request.model = Some(model.clone());
        let mut value = match self.protocol() {
            Protocol::Responses => {
                protocol::responses_request(&self.config, &self.id, &request, &self.tools)?
            }
            Protocol::Chat => protocol::chat_request(&self.config, &request, &self.tools)?,
            Protocol::Anthropic => {
                protocol::anthropic_request(&model, &request, &self.tools, compact)?
            }
        };
        if self.config.kind == ProviderKind::Codex && self.config.bedrock.is_none() {
            let turn_id = uuid::Uuid::new_v4().to_string();
            let metadata = json!({"session_id":self.id,"thread_id":self.id,"turn_id":turn_id,"window_id":self.window_id,"request_kind":"turn"});
            value["client_metadata"] = json!({"turn_id":turn_id,"session_id":self.id,"thread_id":self.id,"x-codex-window-id":self.window_id,"x-codex-turn-metadata":metadata.to_string()});
        }
        if self.lite(&model) {
            let tools = value["tools"].clone();
            value = protocol::responses_lite_request(value, &request.context.instructions, tools);
        }
        Ok(value)
    }
    async fn url(&self, value: &mut Value, compact: bool) -> Result<String, ProviderError> {
        match self.protocol() {
            Protocol::Responses => Ok(format!(
                "{}/{}responses{}",
                self.endpoint,
                if self.credential.is_codex_session().await && self.config.bedrock.is_none() {
                    "codex/"
                } else {
                    ""
                },
                if compact { "/compact" } else { "" }
            )),
            Protocol::Chat => Ok(format!("{}/chat/completions", self.endpoint)),
            Protocol::Anthropic if self.config.bedrock == Some(BedrockTransport::Runtime) => {
                let model = value["model"]
                    .as_str()
                    .unwrap_or(&self.config.model)
                    .to_owned();
                if let Some(object) = value.as_object_mut() {
                    object.remove("model");
                    object.remove("stream");
                }
                value["anthropic_version"] = json!("bedrock-2023-05-31");
                value["anthropic_beta"] = json!([
                    "context-1m-2025-08-07",
                    "interleaved-thinking-2025-05-14",
                    "compact-2026-01-12"
                ]);
                Ok(format!(
                    "{}/model/{}/invoke-with-response-stream",
                    self.endpoint,
                    url_model(&model)
                ))
            }
            Protocol::Anthropic => Ok(format!("{}/messages", self.endpoint)),
        }
    }
    async fn headers(
        &self,
        url: &str,
        body: &[u8],
        model: &str,
    ) -> Result<reqwest::header::HeaderMap, ProviderError> {
        let mut headers = self
            .credential
            .headers(
                "POST",
                url,
                body,
                &self.config.region,
                if self.config.bedrock == Some(BedrockTransport::Mantle)
                    || self.config.kind == ProviderKind::Codex && self.config.bedrock.is_some()
                {
                    "bedrock-mantle"
                } else {
                    "bedrock"
                },
            )
            .await?;
        headers.insert(
            "content-type",
            "application/json"
                .parse()
                .map_err(|_| invalid("Invalid content type."))?,
        );
        headers.insert(
            "accept",
            if self.config.bedrock == Some(BedrockTransport::Runtime)
                && self.config.kind == ProviderKind::Claude
            {
                "application/vnd.amazon.eventstream"
            } else {
                "text/event-stream"
            }
            .parse()
            .map_err(|_| invalid("Invalid stream content type."))?,
        );
        let agent = self
            .config
            .user_agent
            .as_deref()
            .unwrap_or("happy-agent-rust/0.1");
        headers.insert(
            "user-agent",
            agent
                .parse()
                .map_err(|_| invalid("The configured user agent is invalid."))?,
        );
        if self.config.kind == ProviderKind::Codex {
            headers.insert(
                "session_id",
                self.id
                    .parse()
                    .map_err(|_| invalid("The session identifier is invalid."))?,
            );
            headers.insert(
                "x-codex-window-id",
                self.window_id
                    .parse()
                    .map_err(|_| invalid("The window identifier is invalid."))?,
            );
            if self.lite(model) {
                headers.insert(
                    "x-openai-internal-codex-responses-lite",
                    "true"
                        .parse()
                        .map_err(|_| invalid("Invalid protocol header."))?,
                );
            }
            if let Some(state) = &self.turn_state {
                headers.insert(
                    "x-codex-turn-state",
                    state
                        .parse()
                        .map_err(|_| invalid("The provider returned an invalid turn state."))?,
                );
            }
        }
        if self.config.kind == ProviderKind::Claude {
            headers.insert(
                "anthropic-version",
                "2023-06-01"
                    .parse()
                    .map_err(|_| invalid("Invalid Anthropic version."))?,
            );
            headers.insert("anthropic-beta","context-1m-2025-08-07,interleaved-thinking-2025-05-14,compact-2026-01-12,structured-outputs-2025-12-15".parse().map_err(|_| invalid("Invalid Anthropic beta header."))?);
            if self.config.bedrock.is_none() {
                let (bearer,oauth)=self.credential.anthropic_authentication().await;
                if bearer {
                    if oauth {let beta=headers["anthropic-beta"].to_str().map_err(|_|invalid("The Anthropic beta header is invalid."))?;headers.insert("anthropic-beta",format!("{beta},oauth-2025-04-20").parse().map_err(|_|invalid("The Anthropic beta header is invalid."))?);}
                } else {
                    headers.remove("authorization");
                    headers.insert("x-api-key",self.credential.anthropic_api_key().await.parse().map_err(|_| invalid("The Anthropic API key is invalid."))?);
                }
            }
        }
        if self.config.kind == ProviderKind::Grok {
            for (key, value) in [
                ("x-grok-agent-id", self.id.as_str()),
                ("x-grok-client-identifier", "grok-shell"),
                ("x-grok-client-version", "1.0.46"),
                ("x-grok-conv-id", self.id.as_str()),
                ("x-grok-model-override", model),
                ("x-grok-session-id", self.id.as_str()),
            ] {
                headers.insert(
                    reqwest::header::HeaderName::from_bytes(key.as_bytes())
                        .map_err(|_| invalid("Invalid Grok header."))?,
                    value
                        .parse()
                        .map_err(|_| invalid("Invalid Grok session header."))?,
                );
            }
            headers.insert(
                "x-grok-req-id",
                uuid::Uuid::new_v4()
                    .to_string()
                    .parse()
                    .map_err(|_| invalid("Invalid Grok request identity."))?,
            );
            if self.endpoint.contains("cli-chat-proxy.grok.com") {
                headers.insert(
                    "x-authenticateresponse",
                    "authenticate-response"
                        .parse()
                        .map_err(|_| invalid("Invalid Grok header."))?,
                );
                headers.insert(
                    "x-grok-client-mode",
                    "headless"
                        .parse()
                        .map_err(|_| invalid("Invalid Grok header."))?,
                );
                headers.insert(
                    "x-xai-token-auth",
                    "xai-grok-cli"
                        .parse()
                        .map_err(|_| invalid("Invalid Grok header."))?,
                );
            }
        }
        for (name, value) in &self.config.headers {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| invalid("A configured provider header name is invalid."))?,
                value
                    .parse()
                    .map_err(|_| invalid("A configured provider header value is invalid."))?,
            );
        }
        Ok(headers)
    }
    async fn sse(
        &mut self,
        mut value: Value,
        events: &mpsc::Sender<Event>,
    ) -> Result<Mapper, ProviderError> {
        let model = value["model"]
            .as_str()
            .unwrap_or(&self.config.model)
            .to_owned();
        let url = self.url(&mut value, false).await?;
        let body = serde_json::to_vec(&value)
            .map_err(|_| invalid("The provider request could not be encoded."))?;
        let headers = self.headers(&url, &body, &model).await?;
        let mut response = self
            .client
            .post(url)
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(|_| {
                ProviderError::transport("The provider connection could not be established.")
            })?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let headers = response.headers().clone();
            let body = crate::credentials::bounded_body(response, 256 * 1024).await?;
            return Err(ProviderError::response(status, &headers, &body));
        }
        self.turn_state = response
            .headers()
            .get("x-codex-turn-state")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .or_else(|| self.turn_state.clone());
        let mut mapper = Mapper::new(self.protocol(), &self.tools);
        let mut decoder = SseDecoder::default();
        let mut bedrock = BedrockDecoder::default();
        loop {
            let chunk = tokio::time::timeout(
                Duration::from_millis(self.config.stream_idle_timeout_ms),
                response.chunk(),
            )
            .await
            .map_err(|_| ProviderError::transport("The provider stream was idle for too long."))?
            .map_err(|_| {
                ProviderError::transport("The provider stream connection was interrupted.")
            })?;
            let Some(chunk) = chunk else {
                return Err(ProviderError::transport(
                    "The provider stream ended before its completion event.",
                ));
            };
            let values = if self.config.bedrock == Some(BedrockTransport::Runtime)
                && self.config.kind == ProviderKind::Claude
            {
                bedrock.push(&chunk)?
            } else {
                decoder.push(&chunk)?
            };
            for value in values {
                for event in mapper.consume(value)? {
                    events
                        .send(event)
                        .await
                        .map_err(|_| invalid("The stream consumer closed."))?;
                }
                if mapper.outcome.is_some() {
                    return Ok(mapper);
                }
            }
        }
    }
    async fn websocket(
        &mut self,
        mut value: Value,
        events: &mpsc::Sender<Event>,
    ) -> Result<Mapper, ProviderError> {
        let model = value["model"]
            .as_str()
            .unwrap_or(&self.config.model)
            .to_owned();
        if self.websocket.is_none() {
            let mut payload = value.clone();
            let http_url = self.url(&mut payload, false).await?;
            let mut url = reqwest::Url::parse(&http_url)
                .map_err(|_| invalid("The WebSocket endpoint is invalid."))?;
            let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
            url.set_scheme(scheme)
                .map_err(|_| invalid("The WebSocket endpoint is invalid."))?;
            let mut request = url
                .as_str()
                .into_client_request()
                .map_err(|_| invalid("The WebSocket request is invalid."))?;
            let headers = self.headers(&http_url, &[], &model).await?;
            for (name, entry) in &headers {
                request.headers_mut().insert(name.clone(), entry.clone());
            }
            request.headers_mut().insert(
                "openai-beta",
                "responses_websockets=2026-02-06"
                    .parse()
                    .map_err(|_| invalid("Invalid WebSocket version."))?,
            );
            let (socket, response) = tokio::time::timeout(
                Duration::from_secs(30),
                tokio_tungstenite::connect_async(request),
            )
            .await
            .map_err(|_| ProviderError::transport("The provider WebSocket connection timed out."))?
            .map_err(|error| match error {
                tungstenite::Error::Http(response) => ProviderError::response(
                    response.status().as_u16(),
                    response.headers(),
                    response.body().as_deref().unwrap_or_default(),
                ),
                _ => ProviderError::transport(
                    "The provider WebSocket connection could not be established.",
                ),
            })?;
            self.turn_state = response
                .headers()
                .get("x-codex-turn-state")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
                .or_else(|| self.turn_state.clone());
            self.websocket = Some(socket);
            self.warm = None;
        }
        if let Some(object) = value.as_object_mut() {
            object.remove("stream");
        }
        value["type"] = json!("response.create");
        if self.lite(&model) {
            let warm = json!({"model":model,"input":value["input"].as_array().map(|a| a.iter().take(2).cloned().collect::<Vec<_>>()).unwrap_or_default(),"reasoning":value["reasoning"],"parallel_tool_calls":false,"store":false,"generate":false,"type":"response.create"});
            if self.warm.as_ref() != Some(&warm) {
                self.ws_send(warm.clone()).await?;
                let (tx, _rx) = mpsc::channel(32);
                let _ = self.ws_read(&tx).await?;
                self.warm = Some(warm);
            }
            if let Some(input) = value["input"].as_array_mut() {
                input.drain(..input.len().min(2));
            }
        }
        let full_input = value["input"].as_array().cloned().unwrap_or_default();
        if let Some(previous) = &self.previous
            && matches_previous_input(&full_input, &self.previous_input)
            && previous["id"].is_string()
        {
            value["previous_response_id"] = previous["id"].clone();
            value["input"] = json!(&full_input[self.previous_input.len()..]);
        }
        self.ws_send(value).await?;
        let mapper = self.ws_read(events).await?;
        if let Some(response) = &mapper.response {
            self.previous_input = full_input;
            self.previous_input
                .extend(response["output"].as_array().cloned().unwrap_or_default());
            self.previous = Some(response.clone());
        }
        Ok(mapper)
    }
    async fn ws_send(&mut self, value: Value) -> Result<(), ProviderError> {
        let socket = self
            .websocket
            .as_mut()
            .ok_or_else(|| ProviderError::transport("The provider WebSocket is closed."))?;
        socket
            .send(tungstenite::Message::Text(value.to_string().into()))
            .await
            .map_err(|_| ProviderError::transport("The provider WebSocket send failed."))
    }
    async fn ws_read(&mut self, events: &mpsc::Sender<Event>) -> Result<Mapper, ProviderError> {
        let socket = self
            .websocket
            .as_mut()
            .ok_or_else(|| ProviderError::transport("The provider WebSocket is closed."))?;
        let mut mapper = Mapper::new(Protocol::Responses, &self.tools);
        loop {
            let frame = tokio::time::timeout(
                Duration::from_millis(self.config.stream_idle_timeout_ms),
                socket.next(),
            )
            .await
            .map_err(|_| ProviderError::transport("The provider WebSocket was idle for too long."))?
            .ok_or_else(|| {
                ProviderError::transport(
                    "The provider WebSocket closed before completing the response.",
                )
            })?
            .map_err(|_| {
                ProviderError::transport("The provider WebSocket stream was interrupted.")
            })?;
            match frame {
                tungstenite::Message::Text(text) => {
                    if text.len() > 8 * 1024 * 1024 {
                        return Err(invalid("The provider sent an oversized WebSocket event."));
                    }
                    let value = serde_json::from_str(&text)
                        .map_err(|_| invalid("The provider sent an invalid WebSocket event."))?;
                    for event in mapper.consume(value)? {
                        events
                            .send(event)
                            .await
                            .map_err(|_| invalid("The stream consumer closed."))?;
                    }
                    if mapper.outcome.is_some() {
                        return Ok(mapper);
                    }
                }
                tungstenite::Message::Ping(bytes) => socket
                    .send(tungstenite::Message::Pong(bytes))
                    .await
                    .map_err(|_| {
                        ProviderError::transport("The provider WebSocket keep-alive failed.")
                    })?,
                tungstenite::Message::Close(_) => {
                    return Err(ProviderError::transport(
                        "The provider WebSocket closed before completing the response.",
                    ));
                }
                _ => {}
            }
        }
    }
    async fn clear_connection(&mut self) {
        self.websocket = None;
        self.previous = None;
        self.previous_input.clear();
        self.warm = None;
    }
    async fn run_payload(
        &mut self,
        value: Value,
        cancel: CancellationToken,
        events: &mpsc::Sender<Event>,
        compaction: bool,
    ) -> Result<Mapper, ProviderError> {
        let mut attempt = 0;
        let mut refreshed_grok = false;
        while attempt <= self.config.inference_max_retries {
            if cancel.is_cancelled() {
                return Err(cancelled());
            }
            events
                .send(Event::BlockStart)
                .await
                .map_err(|_| invalid("The stream consumer closed."))?;
            let use_socket = !self.sse_only;
            let result = tokio::select! { biased; _ = cancel.cancelled() => Err(cancelled()), result = async { if use_socket { self.websocket(value.clone(),events).await } else { self.sse(value.clone(),events).await } } => result };
            match result {
                Ok(mapper) if mapper.saw_content || compaction => {
                    if !compaction && mapper.compact_block.is_some() {
                        let error =
                            invalid("The provider attempted compaction during ordinary inference.");
                        events.send(Event::BlockReset).await.ok();
                        return Err(error);
                    }
                    events
                        .send(Event::BlockStop)
                        .await
                        .map_err(|_| invalid("The stream consumer closed."))?;
                    if let Some(outcome) = &mapper.outcome {
                        events
                            .send(Event::Done {
                                outcome: outcome.clone(),
                            })
                            .await
                            .ok();
                    }
                    return Ok(mapper);
                }
                result => {
                    let mut error = match result {
                        Err(error) => error,
                        _ => {
                            let mut error = ProviderError::new(
                                ErrorKind::EmptyResponse,
                                "The provider returned no usable response.",
                            );
                            error.retryable = true;
                            error
                        }
                    };
                    events.send(Event::BlockReset).await.ok();
                    self.clear_connection().await;
                    if cancel.is_cancelled() {
                        return Err(cancelled());
                    }
                    // A rejected Grok CLI session is rotated once and replayed outside the retry budget.
                    if error.kind == ErrorKind::Authentication
                        && self.config.kind == ProviderKind::Grok
                        && !refreshed_grok
                    {
                        refreshed_grok = true;
                        if self.credential.refresh_grok_after_unauthorized().await {
                            continue;
                        }
                    }
                    let fallback = use_socket
                        && self.config.transport == Transport::Auto
                        && (error.retryable || matches!(error.status, Some(404 | 405 | 426)));
                    if fallback {
                        self.sse_only = true;
                        error.retryable = true;
                    }
                    if error.kind == ErrorKind::Authentication
                        && self.config.kind == ProviderKind::Codex
                        && attempt < self.config.inference_max_retries
                        && self
                            .credential
                            .refresh_codex(&self.client)
                            .await
                            .unwrap_or(false)
                    {
                        error.retryable = true;
                    }
                    if !error.retryable || attempt == self.config.inference_max_retries {
                        return Err(error);
                    }
                    events
                        .send(Event::Retrying {
                            attempt: attempt + 1,
                            reason: error.message.clone(),
                        })
                        .await
                        .map_err(|_| invalid("The stream consumer closed."))?;
                    let wait = if fallback {
                        0
                    } else {
                        error
                            .retry_after_ms
                            .unwrap_or(200u64.saturating_mul(1u64 << attempt.min(8)))
                            .min(60_000)
                    };
                    tokio::select! { _ = cancel.cancelled() => return Err(cancelled()), _ = tokio::time::sleep(Duration::from_millis(wait)) => {} }
                    attempt += 1;
                }
            }
        }
        Err(invalid("The provider exhausted its retry budget."))
    }
}

#[async_trait]
impl Session for HttpSession {
    async fn run(
        &mut self,
        request: RunRequest,
        cancel: CancellationToken,
        events: mpsc::Sender<Event>,
    ) {
        let result = match self.payload(&request, None).await {
            Ok(value) => self
                .run_payload(value, cancel.clone(), &events, false)
                .await
                .map(|_| ()),
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            events
                .send(Event::Done {
                    outcome: if cancel.is_cancelled() {
                        Outcome::Cancelled
                    } else {
                        Outcome::Error { error }
                    },
                })
                .await
                .ok();
        }
    }
    async fn compact(
        &mut self,
        context: SessionContext,
        instructions: Option<String>,
        cancel: CancellationToken,
    ) -> Compaction {
        if cancel.is_cancelled() {
            return Compaction::Cancelled { context };
        }
        if !self.config.native_compaction {
            return Compaction::Failed {
                error: invalid("This endpoint does not support native compaction."),
            };
        }
        let result = async {
            let request = RunRequest {
                context: context.clone(),
                ..Default::default()
            };
            match self.protocol() {
                Protocol::Responses
                    if self.config.kind != ProviderKind::Grok
                        && !(self.config.kind == ProviderKind::Codex
                            && self.credential.is_codex_session().await) =>
                {
                    let payload = self.payload(&request, None).await?;
                    let mut value = json!({"model":payload["model"],"input":payload["input"],"instructions":context.instructions});
                    let url = self.url(&mut value, true).await?;
                    let body = serde_json::to_vec(&value)
                        .map_err(|_| invalid("Compaction could not be encoded."))?;
                    let headers = self
                        .headers(&url, &body, self.config.model.as_str())
                        .await?;
                    let response = self
                        .client
                        .post(url)
                        .headers(headers)
                        .body(body)
                        .timeout(Duration::from_secs(300))
                        .send()
                        .await
                        .map_err(|_| {
                            ProviderError::transport("Native compaction failed to connect.")
                        })?;
                    let status = response.status().as_u16();
                    let headers = response.headers().clone();
                    let bytes = crate::credentials::bounded_body(response, 8 * 1024 * 1024).await?;
                    if !(200..300).contains(&status) {
                        return Err(ProviderError::response(status, &headers, &bytes));
                    }
                    let value: Value = serde_json::from_slice(&bytes)
                        .map_err(|_| invalid("Native compaction returned invalid JSON."))?;
                    let items = value["output"]
                        .as_array()
                        .ok_or_else(|| invalid("Native compaction returned no checkpoint."))?;
                    let checkpoint = items
                        .iter()
                        .find(|v| v["type"] == "compaction")
                        .ok_or_else(|| invalid("Native compaction returned no checkpoint."))?;
                    let encrypted = checkpoint["encrypted_content"].as_str().ok_or_else(|| {
                        invalid("Native compaction returned no encrypted checkpoint.")
                    })?;
                    // Preserve only user messages the native output explicitly retained.
                    let mut messages = Vec::new();
                    for item in items.iter().filter(|v| v["role"] == "user") {
                        if let Some(original) = context.messages.iter().find(|m| {
                            matches!(m, Message::User { .. })
                                && native_user_text(m) == native_item_text(item)
                        }) {
                            messages.push(original.clone());
                        }
                    }
                    messages.push(Message::Compaction {
                        content: None,
                        encrypted_content: Some(encrypted.to_owned()),
                        vendor: Some(json!({"type":"responses_compaction","id":checkpoint["id"]})),
                    });
                    Ok((
                        SessionContext {
                            instructions: context.instructions.clone(),
                            messages,
                        },
                        protocol::stream::response_usage(&value["usage"]),
                    ))
                }
                Protocol::Responses if self.config.kind == ProviderKind::Codex => {
                    let mut value = self.payload(&request, None).await?;
                    if let Some(input) = value["input"].as_array_mut() {
                        input.push(json!({"type":"compaction_trigger"}));
                    }
                    let (events, mut receiver) = mpsc::channel(128);
                    let drain =
                        tokio::spawn(async move { while receiver.recv().await.is_some() {} });
                    let mapper = self.run_payload(value, cancel.clone(), &events, true).await;
                    drop(events);
                    let _ = drain.await;
                    let mapper = mapper?;
                    let checkpoint = mapper
                        .compact_block
                        .or_else(|| {
                            mapper
                                .response
                                .as_ref()?
                                .get("output")?
                                .as_array()?
                                .iter()
                                .find(|v| v["type"] == "compaction")
                                .cloned()
                        })
                        .ok_or_else(|| invalid("Codex compaction returned no checkpoint."))?;
                    let encrypted = checkpoint["encrypted_content"].as_str().ok_or_else(|| {
                        invalid("Codex compaction returned no encrypted checkpoint.")
                    })?;
                    let messages = vec![Message::Compaction {
                        content: None,
                        encrypted_content: Some(encrypted.to_owned()),
                        vendor: Some(json!({"type":"codex_compaction","id":checkpoint["id"]})),
                    }];
                    Ok((
                        SessionContext {
                            instructions: context.instructions.clone(),
                            messages,
                        },
                        match mapper.outcome {
                            Some(Outcome::Normal { usage })
                            | Some(Outcome::ToolCall { usage })
                            | Some(Outcome::Length { usage }) => usage,
                            _ => Default::default(),
                        },
                    ))
                }
                Protocol::Anthropic => {
                    let value = self.payload(&request, Some(instructions.clone())).await?;
                    let (events, mut receiver) = mpsc::channel(128);
                    let drain =
                        tokio::spawn(async move { while receiver.recv().await.is_some() {} });
                    let mapper = self.run_payload(value, cancel.clone(), &events, true).await;
                    drop(events);
                    let _ = drain.await;
                    let mapper = mapper?;
                    let block = mapper
                        .compact_block
                        .ok_or_else(|| invalid("Anthropic compaction returned no checkpoint."))?;
                    let messages = vec![Message::Compaction {
                        content: block["content"].as_str().map(str::to_owned),
                        encrypted_content: block["encrypted_content"].as_str().map(str::to_owned),
                        vendor: Some(json!({"block":block})),
                    }];
                    let usage = match mapper.outcome {
                        Some(Outcome::Normal { usage }) => usage,
                        _ => Default::default(),
                    };
                    Ok((
                        SessionContext {
                            instructions: context.instructions.clone(),
                            messages,
                        },
                        usage,
                    ))
                }
                _ => {
                    let prompt = match self.config.kind {
                        ProviderKind::Grok => native_prompt(include_str!(
                            "vendors/grok/prompts/grok_compaction_prompt.ts"
                        )),
                        ProviderKind::Kimi => native_prompt(include_str!(
                            "vendors/kimi/prompts/kimi_compaction_instructions.ts"
                        )),
                        _ => native_prompt(include_str!(
                            "vendors/glm/prompts/glm_compaction_instructions.ts"
                        )),
                    };
                    let prompt = prompt.replace(
                        "${custom_instruction_block}",
                        instructions.as_deref().unwrap_or(""),
                    );
                    let mut request = request;
                    request.context.messages.push(Message::user(prompt));
                    let value = self.payload(&request, None).await?;
                    let (events, mut receiver) = mpsc::channel(128);
                    let collector = tokio::spawn(async move {
                        let mut accumulator = Accumulator::default();
                        while let Some(event) = receiver.recv().await {
                            accumulator.add(&event);
                        }
                        accumulator
                    });
                    let mapper = self.run_payload(value, cancel.clone(), &events, true).await;
                    drop(events);
                    let accumulator = collector
                        .await
                        .map_err(|_| invalid("Compaction collection failed."))?;
                    let mapper = mapper?;
                    if matches!(mapper.outcome, Some(Outcome::ToolCall { .. })) {
                        return Err(invalid("The provider called a tool while compacting."));
                    }
                    let summary = accumulator
                        .committed
                        .iter()
                        .filter_map(|b| match b {
                            Block::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<String>();
                    if summary.trim().is_empty() {
                        return Err(invalid(
                            "The provider returned an empty compaction summary.",
                        ));
                    }
                    let mut messages = if self.config.kind == ProviderKind::Kimi {
                        context
                            .messages
                            .iter()
                            .filter(|m| matches!(m, Message::User { .. }))
                            .cloned()
                            .collect::<Vec<_>>()
                    } else {
                        Vec::new()
                    };
                    let prefix = if self.config.kind == ProviderKind::Kimi {
                        "The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over.\n\n"
                    } else {
                        "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n"
                    };
                    messages.push(Message::Compaction { content:Some(format!("{prefix}{}",summary.trim())),encrypted_content:None,vendor:if self.config.kind==ProviderKind::Kimi { Some(json!({"type":"kimi_summary","continuation":"<system-reminder>\nContext compaction is complete — continue the work that was in progress when it began.\n</system-reminder>"})) } else { None } });
                    let usage = match mapper.outcome {
                        Some(Outcome::Normal { usage }) | Some(Outcome::Length { usage }) => usage,
                        _ => Default::default(),
                    };
                    Ok((
                        SessionContext {
                            instructions: context.instructions.clone(),
                            messages,
                        },
                        usage,
                    ))
                }
            }
        };
        let result = tokio::select! { biased; _=cancel.cancelled()=>return Compaction::Cancelled { context },result=result=>result };
        match result {
            Ok((context, usage)) => {
                self.clear_connection().await;
                Compaction::Completed { context, usage }
            }
            Err(error) => {
                if cancel.is_cancelled() {
                    Compaction::Cancelled { context }
                } else {
                    Compaction::Failed { error }
                }
            }
        }
    }
    async fn destroy(&mut self) {
        self.clear_connection().await;
    }
}
fn invalid(message: &str) -> ProviderError {
    ProviderError::new(ErrorKind::Unclassified, message)
}
fn matches_previous_input(input: &[Value], previous: &[Value]) -> bool {
    input.len() >= previous.len()
        && input.iter().zip(previous).all(|(current, previous)| {
            if current == previous {
                return true;
            }
            if current["type"] != "message" || previous["type"] != "message" {
                return false;
            }
            // Assistant text is reconstructed from immutable history; its local wire ID differs
            // from the server ID while the completed message remains the same.
            let mut current = current.clone();
            let mut previous = previous.clone();
            if let Some(object) = current.as_object_mut() {
                object.remove("id");
            }
            if let Some(object) = previous.as_object_mut() {
                object.remove("id");
            }
            current == previous
        })
}
fn cancelled() -> ProviderError {
    invalid("Inference was cancelled.")
}
fn url_model(model: &str) -> String {
    model
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn native_prompt(source: &str) -> String {
    source
        .split_once('`')
        .and_then(|(_, text)| text.split_once('`').map(|(prompt, _)| prompt.to_owned()))
        .unwrap_or_default()
}
fn native_user_text(message: &Message) -> String {
    protocol::text(message.content())
}
fn native_item_text(item: &Value) -> String {
    item["content"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            item["content"]
                .as_array()
                .map(|a| a.iter().filter_map(|b| b["text"].as_str()).collect())
                .unwrap_or_default()
        })
}
