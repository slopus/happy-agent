//! One live MCP client: its transport, its process, and the server's declared capabilities.
//!
//! Connecting initializes the session within the startup timeout. Listings and reads time out
//! with the server's tool timeout and stop with their caller. Tool calls are serialized per
//! connection, because an elicitation the server sends during a call is answered for that call.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::http::HttpTransport;
use super::lock;
use super::protocol::{ElicitationHandler, INVALID_PARAMS, INVALID_REQUEST, McpError, Protocol, Transport};
use super::sdk::{self, Shape};
use super::stdio::StdioTransport;

const DEFAULT_STARTUP_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS: u64 = 60_000;
const PROTOCOL_VERSION: &str = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

/// What the last tool listing said about each tool, which governs how it may be called.
#[derive(Default)]
struct ToolMetadata {
    output_schemas: HashMap<String, Value>,
    task_required: HashSet<String>,
}

pub(super) struct McpConnection {
    pub name: String,
    pub config: Value,
    protocol: Arc<Protocol>,
    capabilities: Value,
    call_lock: tokio::sync::Mutex<()>,
    tools: Mutex<ToolMetadata>,
}

fn timeout_of(config: &Value, key: &str, default: u64) -> Duration {
    Duration::from_millis(config.get(key).and_then(Value::as_u64).unwrap_or(default))
}

impl McpConnection {
    /// Start the server or reach it, and initialize the session.
    pub async fn connect(name: &str, config: &Value) -> Result<Arc<McpConnection>, String> {
        let http = config["transport"] == "http";
        if http && ["oauthClientIdEnvVar", "oauthClientSecretEnvVar", "oauthScopes"].iter().any(|key| config.get(*key).is_some()) {
            return Err("Interactive MCP OAuth is not configured; use HTTP headers or bearer_token_env_var.".into());
        }
        let (transport, events): (Arc<dyn Transport>, _) = if http {
            let (transport, events) = HttpTransport::new(config)?;
            (transport, events)
        } else {
            let (transport, events) = StdioTransport::spawn(config)?;
            (transport, events)
        };
        let protocol = Protocol::start(transport, events);
        let initialized = async {
            let result = protocol
                .request(
                    "initialize",
                    Some(json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {"elicitation": {}},
                        "clientInfo": {"name": "happy-agent", "version": "1.0.0"}
                    })),
                    &sdk::INITIALIZE_RESULT,
                    timeout_of(config, "startupTimeoutMs", DEFAULT_STARTUP_TIMEOUT_MS),
                    None,
                )
                .await?;
            let version = result["protocolVersion"].as_str().unwrap_or_default();
            if !SUPPORTED_PROTOCOL_VERSIONS.contains(&version) {
                return Err(McpError::plain(format!("Server's protocol version is not supported: {version}")));
            }
            protocol.transport().set_protocol_version(version);
            protocol.notify("notifications/initialized").await?;
            Ok::<Value, McpError>(result["capabilities"].clone())
        };
        match initialized.await {
            Ok(capabilities) => Ok(Arc::new(McpConnection {
                name: name.to_string(),
                config: config.clone(),
                protocol,
                capabilities,
                call_lock: tokio::sync::Mutex::new(()),
                tools: Mutex::new(ToolMetadata::default()),
            })),
            Err(error) => {
                protocol.close().await;
                Err(error.to_string())
            }
        }
    }

    /// Whether the server declared the capability, as `getServerCapabilities()?.<name>` read it.
    pub fn supports(&self, capability: &str) -> bool {
        self.capabilities.get(capability).is_some()
    }

    /// Run once when the connection ends, whether the server stopped or it was closed.
    pub fn on_close(&self, callback: impl FnOnce() + Send + 'static) {
        self.protocol.on_close(callback);
    }

    pub async fn close(&self) {
        self.protocol.close().await;
    }

    async fn request(&self, cancel: &CancellationToken, method: &str, params: Value, shape: &Shape) -> anyhow::Result<Value> {
        let timeout = timeout_of(&self.config, "toolTimeoutMs", DEFAULT_TOOL_TIMEOUT_MS);
        Ok(self.protocol.request(method, Some(params), shape, timeout, Some(cancel)).await?)
    }

    fn paging(cursor: Option<&str>) -> Value {
        cursor.map_or_else(|| json!({}), |cursor| json!({"cursor": cursor}))
    }

    /// One page of the live tool catalog; what it says about output schemas and task support
    /// governs the calls that follow, as it did for the SDK.
    pub async fn list_tools(&self, cancel: &CancellationToken, cursor: Option<&str>) -> anyhow::Result<Value> {
        let page = self.request(cancel, "tools/list", Self::paging(cursor), &sdk::LIST_TOOLS_RESULT).await?;
        let mut metadata = ToolMetadata::default();
        for tool in page["tools"].as_array().into_iter().flatten() {
            let name = tool["name"].as_str().unwrap_or_default().to_string();
            if let Some(schema) = tool.get("outputSchema") {
                metadata.output_schemas.insert(name.clone(), schema.clone());
            }
            if tool["execution"]["taskSupport"] == "required" {
                metadata.task_required.insert(name);
            }
        }
        *lock(&self.tools) = metadata;
        Ok(page)
    }

    pub async fn list_resources(&self, cancel: &CancellationToken, cursor: Option<&str>) -> anyhow::Result<Value> {
        self.request(cancel, "resources/list", Self::paging(cursor), &sdk::LIST_RESOURCES_RESULT).await
    }

    pub async fn list_resource_templates(&self, cancel: &CancellationToken, cursor: Option<&str>) -> anyhow::Result<Value> {
        self.request(cancel, "resources/templates/list", Self::paging(cursor), &sdk::LIST_RESOURCE_TEMPLATES_RESULT).await
    }

    pub async fn list_prompts(&self, cancel: &CancellationToken, cursor: Option<&str>) -> anyhow::Result<Value> {
        self.request(cancel, "prompts/list", Self::paging(cursor), &sdk::LIST_PROMPTS_RESULT).await
    }

    pub async fn read_resource(&self, cancel: &CancellationToken, uri: &str) -> anyhow::Result<Value> {
        self.request(cancel, "resources/read", json!({"uri": uri}), &sdk::READ_RESOURCE_RESULT).await
    }

    pub async fn get_prompt(&self, cancel: &CancellationToken, name: &str, arguments: Option<&Value>) -> anyhow::Result<Value> {
        let mut params = json!({"name": name});
        if let Some(arguments) = arguments {
            params["arguments"] = arguments.clone();
        }
        self.request(cancel, "prompts/get", params, &sdk::GET_PROMPT_RESULT).await
    }

    /// Call one tool, answering any elicitation it raises with `elicitation`.
    pub async fn call_tool(&self, cancel: &CancellationToken, name: &str, arguments: Option<&Value>, elicitation: ElicitationHandler) -> anyhow::Result<Value> {
        let _call = self.call_lock.lock().await;
        if lock(&self.tools).task_required.contains(name) {
            return Err(McpError::coded(
                INVALID_REQUEST,
                format!("Tool \"{name}\" requires task-based execution. Use client.experimental.tasks.callToolStream() instead."),
            )
            .into());
        }
        let mut params = json!({"name": name});
        if let Some(arguments) = arguments {
            params["arguments"] = arguments.clone();
        }
        self.protocol.set_elicitation(Some(elicitation));
        let timeout = timeout_of(&self.config, "toolTimeoutMs", DEFAULT_TOOL_TIMEOUT_MS);
        let outcome = self.protocol.request("tools/call", Some(params), &sdk::CALL_TOOL_RESULT, timeout, Some(cancel)).await;
        self.protocol.set_elicitation(None);
        let result = outcome?;
        let output_schema = lock(&self.tools).output_schemas.get(name).cloned();
        if let Some(schema) = output_schema {
            let structured = result.get("structuredContent").filter(|value| !value.is_null());
            let is_error = result["isError"] == true;
            match structured {
                None if !is_error => {
                    return Err(McpError::coded(INVALID_REQUEST, format!("Tool {name} has an output schema but did not return structured content")).into());
                }
                Some(structured) => {
                    if let Some(error) = super::output::first_error(&schema, structured) {
                        return Err(McpError::coded(INVALID_PARAMS, format!("Structured content does not match the tool's output schema: {error}")).into());
                    }
                }
                None => {}
            }
        }
        Ok(result)
    }
}
