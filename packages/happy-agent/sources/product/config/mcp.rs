//! The user's MCP catalog: `mcp.toml` in the Config directory, and the one a workspace may carry
//! at its root. Only these dedicated files declare MCP servers; `mcp_servers` in `happy.toml` is
//! ignored, as it was in the original.
use super::*;
use serde_json::{Map, Value, json};

const MAX_CONFIG_FILE_BYTES: usize = 1_048_576;
const MAX_CONFIG_TABLE_ENTRIES: usize = 512;
/// The top-level sections a Happy configuration source may declare. Any of them other than
/// `mcp_servers` is misplaced in an MCP catalog; anything else is ignored as unknown.
const KNOWN_SECTIONS: [&str; 22] = [
    "api", "connections", "defaults", "docker", "feature", "features", "gemini", "mcp_servers", "network", "node", "observation", "p2p",
    "permissions", "presence", "profile", "provider_default_enable", "providers", "runners", "settings", "skills", "theme", "workspace",
];

/// The catalog as last read or written, and the lock that serializes edits to it.
pub(super) struct McpCatalogFile {
    servers: Mutex<Map<String, Value>>,
    writer: tokio::sync::Mutex<()>,
}

impl McpCatalogFile {
    pub(super) fn load(path: &Path) -> Result<Self> {
        Ok(Self { servers: Mutex::new(read_mcp_file(path)?), writer: tokio::sync::Mutex::new(()) })
    }
}

impl ConfigModule {
    pub fn mcp_configuration_path(&self) -> PathBuf {
        self.paths.configuration.join("mcp.toml")
    }

    /// Read the Happy-owned MCP catalog fresh so an online reload sees edits immediately.
    pub fn read_mcp_servers(&self) -> Result<Map<String, Value>> {
        let servers = read_mcp_file(&self.mcp_configuration_path())?;
        *self.mcp.servers.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = servers.clone();
        Ok(servers)
    }

    /// The MCP catalog as last read or written.
    pub fn mcp_servers(&self) -> Map<String, Value> {
        self.mcp.servers.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// Read the MCP catalog one workspace folder owns, without merging it into machine settings.
    pub fn read_workspace_mcp_servers(&self, workspace: &Path) -> Result<Map<String, Value>> {
        let text = workspace.to_string_lossy();
        anyhow::ensure!(!text.is_empty() && text.encode_utf16().count() <= 4_096, "Workspace path is invalid.");
        let root = std::path::absolute(workspace).map_err(|_| anyhow::anyhow!("Workspace path is invalid."))?;
        read_mcp_file(&root.join("mcp.toml"))
    }

    /// Canonically add, replace, or remove one server without exposing the other server values.
    pub async fn update_mcp_server(&self, name: &str, server: Option<Value>) -> Result<Map<String, Value>> {
        let length = name.encode_utf16().count();
        anyhow::ensure!(length > 0 && length <= 128, "MCP server name is invalid.");
        let _write = self.mcp.writer.lock().await;
        let mut current = self.read_mcp_servers()?;
        match server {
            None => {
                current.shift_remove(name);
            }
            Some(server) => {
                current.insert(name.to_owned(), server);
            }
        }
        anyhow::ensure!(
            super::super::schemas::Schemas::new()?.valid("ownerMcpServers", &Value::Object(current.clone()))?,
            "MCP server configuration is invalid."
        );
        let contents = render_mcp_file(&current)?;
        anyhow::ensure!(contents.len() <= MAX_CONFIG_FILE_BYTES, "MCP configuration exceeds the {MAX_CONFIG_FILE_BYTES}-byte limit.");
        let path = self.mcp_configuration_path();
        tokio::task::spawn_blocking(move || atomic_private(&path, contents.as_bytes())).await??;
        *self.mcp.servers.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = current.clone();
        Ok(current)
    }
}

/// `readConfigSource` for an MCP catalog: a missing file is empty; anything else unreadable is an
/// error that names the file.
fn read_mcp_file(path: &Path) -> Result<Map<String, Value>> {
    let text = match read_text_limited(path, MAX_CONFIG_FILE_BYTES) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ENOTDIR) => return Ok(Map::new()),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData && error.to_string().contains("size limit") => {
            bail!("Could not read Happy Agent configuration '{}'. Configuration exceeds the {MAX_CONFIG_FILE_BYTES}-byte limit.", path.display())
        }
        Err(error) => bail!("Could not read Happy Agent configuration '{}'. {error}", path.display()),
    };
    parse_mcp_file(&text).map_err(|error| anyhow::anyhow!("Could not read Happy Agent configuration '{}'. {error}", path.display()))
}

fn parse_mcp_file(text: &str) -> Result<Map<String, Value>> {
    let table: toml::Table = text.parse().map_err(|error: toml::de::Error| {
        let message = error.message().trim().to_owned();
        match error.span() {
            Some(span) => anyhow::anyhow!("Invalid TOML ({message}) at byte {}.", span.start),
            None => anyhow::anyhow!("Invalid TOML ({message})."),
        }
    })?;
    anyhow::ensure!(table.len() <= MAX_CONFIG_TABLE_ENTRIES, "configuration must contain at most {MAX_CONFIG_TABLE_ENTRIES} properties.");
    let misplaced: Vec<&str> = table.keys().map(String::as_str).filter(|key| *key != "mcp_servers" && KNOWN_SECTIONS.contains(key)).collect();
    anyhow::ensure!(misplaced.is_empty(), "MCP configuration may contain only mcp_servers, not {}.", misplaced.join(", "));
    let Some(servers) = table.get("mcp_servers") else { return Ok(Map::new()) };
    normalize_mcp_servers(&read_mcp_servers_input(servers)?)
}

/// The original's `readMcpServers`: every entry a table, unknown keys dropped, and the entry and
/// the whole catalog checked against the captured input schemas.
fn read_mcp_servers_input(value: &toml::Value) -> Result<Map<String, Value>> {
    static INPUT: OnceLock<Value> = OnceLock::new();
    let input = INPUT.get_or_init(|| {
        let schemas: Value = serde_json::from_str(include_str!("../request_schemas.json")).unwrap_or(Value::Null);
        schemas["ownerMcpServersInput"].clone()
    });
    let entry_schema = &input["patternProperties"]["^(.*)$"];
    let known = entry_schema["properties"].as_object().context("The MCP server input schema is unavailable.")?;
    let table = value.as_table().context("mcp_servers must be a TOML table.")?;
    anyhow::ensure!(table.len() <= MAX_CONFIG_TABLE_ENTRIES, "mcp_servers must contain at most {MAX_CONFIG_TABLE_ENTRIES} properties.");
    let schemas = super::super::schemas::Schemas::new()?;
    static ENTRY: OnceLock<std::result::Result<happy_agent_base::RuntimeSchemas, String>> = OnceLock::new();
    let entry_checker = ENTRY
        .get_or_init(|| happy_agent_base::RuntimeSchemas::compile(&json!({ "entry": entry_schema }).to_string()).map_err(|error| format!("{error:#}")))
        .as_ref()
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    let mut result = Map::new();
    for (name, server) in table {
        let server = server.as_table().with_context(|| format!("mcp_servers.{name} must be a TOML table."))?;
        anyhow::ensure!(server.len() <= MAX_CONFIG_TABLE_ENTRIES, "mcp_servers.{name} must contain at most {MAX_CONFIG_TABLE_ENTRIES} properties.");
        let parsed: Map<String, Value> =
            server.iter().filter(|(key, _)| known.contains_key(*key)).map(|(key, item)| (key.clone(), toml_json(item))).collect();
        anyhow::ensure!(entry_checker.valid("entry", &Value::Object(parsed.clone()))?, "mcp_servers.{name} contains an invalid value.");
        let (command, url, transport) = (parsed.get("command"), parsed.get("url"), parsed.get("transport"));
        anyhow::ensure!(command.is_none() != url.is_none(), "MCP server \"{name}\" must configure either command or url.");
        anyhow::ensure!(url.is_none() || transport.is_none_or(|transport| transport == "http"), "MCP server \"{name}\" uses unsupported transport.");
        anyhow::ensure!(
            command.is_none() || transport.is_none(),
            "MCP server \"{name}\" runs a command, so it always speaks stdio and cannot set transport."
        );
        result.insert(name.clone(), Value::Object(parsed));
    }
    anyhow::ensure!(schemas.valid("ownerMcpServersInput", &Value::Object(result.clone()))?, "mcp_servers contains an invalid server.");
    Ok(result)
}

fn timeout_milliseconds(seconds: f64, name: &str) -> Result<i64> {
    let milliseconds = seconds * 1_000.0;
    anyhow::ensure!(
        milliseconds.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&milliseconds),
        "MCP {name} must resolve to a whole millisecond."
    );
    Ok(milliseconds as i64)
}

/// The original's `normalizeMcpServers`: TOML names become the resolved camel-case fields, with
/// timeouts in milliseconds, in the original's key order.
fn normalize_mcp_servers(input: &Map<String, Value>) -> Result<Map<String, Value>> {
    let mut result = Map::new();
    for (name, server) in input {
        let startup = server.get("startup_timeout_sec").and_then(Value::as_f64).map(|seconds| timeout_milliseconds(seconds, &format!("{name}.startup_timeout_sec"))).transpose()?;
        let tool = server.get("tool_timeout_sec").and_then(Value::as_f64).map(|seconds| timeout_milliseconds(seconds, &format!("{name}.tool_timeout_sec"))).transpose()?;
        anyhow::ensure!(server.get("command").is_some() != server.get("url").is_some(), "MCP server \"{name}\" must configure either command or url.");
        let mut entry = Map::new();
        let copy = |entry: &mut Map<String, Value>, from: &str, to: &str| {
            if let Some(value) = server.get(from) {
                entry.insert(to.to_owned(), value.clone());
            }
        };
        if let Some(command) = server.get("command") {
            for (from, to) in [("args", "args"), ("cwd", "cwd"), ("disabled_tools", "disabledTools"), ("enabled", "enabled"), ("enabled_tools", "enabledTools"), ("env", "env")] {
                copy(&mut entry, from, to);
            }
            if let Some(startup) = startup {
                entry.insert("startupTimeoutMs".into(), json!(startup));
            }
            if let Some(tool) = tool {
                entry.insert("toolTimeoutMs".into(), json!(tool));
            }
            entry.insert("command".into(), command.clone());
            entry.insert("transport".into(), json!("stdio"));
        } else {
            for (from, to) in [
                ("bearer_token_env_var", "bearerTokenEnvVar"),
                ("disabled_tools", "disabledTools"),
                ("enabled", "enabled"),
                ("enabled_tools", "enabledTools"),
                ("http_headers", "headers"),
                ("oauth_client_id_env_var", "oauthClientIdEnvVar"),
                ("oauth_client_secret_env_var", "oauthClientSecretEnvVar"),
                ("oauth_scopes", "oauthScopes"),
            ] {
                copy(&mut entry, from, to);
            }
            if let Some(startup) = startup {
                entry.insert("startupTimeoutMs".into(), json!(startup));
            }
            if let Some(tool) = tool {
                entry.insert("toolTimeoutMs".into(), json!(tool));
            }
            entry.insert("transport".into(), json!("http"));
            entry.insert("url".into(), server["url"].clone());
        }
        result.insert(name.clone(), Value::Object(entry));
    }
    Ok(result)
}

/// The original's `writeMcpConfigurationFile`: resolved values rendered back to their TOML names.
fn render_mcp_file(servers: &Map<String, Value>) -> Result<String> {
    let seconds = |milliseconds: &Value| -> toml::Value {
        let seconds = milliseconds.as_f64().unwrap_or_default() / 1_000.0;
        if seconds.fract() == 0.0 { toml::Value::Integer(seconds as i64) } else { toml::Value::Float(seconds) }
    };
    let mut rendered = toml::Table::new();
    for (name, server) in servers {
        let mut entry = toml::Table::new();
        let copy = |entry: &mut toml::Table, from: &str, to: &str| -> Result<()> {
            if let Some(value) = server.get(from) {
                entry.insert(to.to_owned(), toml::Value::try_from(value)?);
            }
            Ok(())
        };
        if server["transport"] == "stdio" {
            for (from, to) in [("command", "command"), ("args", "args"), ("cwd", "cwd"), ("env", "env"), ("enabled", "enabled")] {
                copy(&mut entry, from, to)?;
            }
        } else {
            for (from, to) in [
                ("url", "url"),
                ("headers", "http_headers"),
                ("bearerTokenEnvVar", "bearer_token_env_var"),
                ("oauthClientIdEnvVar", "oauth_client_id_env_var"),
                ("oauthClientSecretEnvVar", "oauth_client_secret_env_var"),
                ("oauthScopes", "oauth_scopes"),
                ("enabled", "enabled"),
            ] {
                copy(&mut entry, from, to)?;
            }
        }
        if let Some(milliseconds) = server.get("startupTimeoutMs") {
            entry.insert("startup_timeout_sec".into(), seconds(milliseconds));
        }
        if let Some(milliseconds) = server.get("toolTimeoutMs") {
            entry.insert("tool_timeout_sec".into(), seconds(milliseconds));
        }
        copy(&mut entry, "enabledTools", "enabled_tools")?;
        copy(&mut entry, "disabledTools", "disabled_tools")?;
        rendered.insert(name.clone(), toml::Value::Table(entry));
    }
    let mut document = toml::Table::new();
    if !rendered.is_empty() {
        document.insert("mcp_servers".into(), toml::Value::Table(rendered));
    }
    let encoded = toml::to_string(&document)?;
    Ok(if encoded.is_empty() || encoded.ends_with('\n') { encoded } else { format!("{encoded}\n") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_catalog_reads_normalizes_and_renders_back_like_the_original() {
        let servers = parse_mcp_file(
            "unknown_root = 1\n[mcp_servers.local]\ncommand = \"server\"\nargs = [\"--stdio\"]\nstartup_timeout_sec = 1.5\nignored = true\n\n[mcp_servers.remote]\nurl = \"https://example.com/mcp\"\nhttp_headers = { X-Key = \"v\" }\ntool_timeout_sec = 30\n",
        )
        .unwrap();
        assert_eq!(
            Value::Object(servers.clone()),
            json!({
                "local": {"args": ["--stdio"], "startupTimeoutMs": 1500, "command": "server", "transport": "stdio"},
                "remote": {"headers": {"X-Key": "v"}, "toolTimeoutMs": 30000, "transport": "http", "url": "https://example.com/mcp"}
            })
        );
        let rendered = render_mcp_file(&servers).unwrap();
        assert_eq!(parse_mcp_file(&rendered).unwrap(), servers);
        assert_eq!(render_mcp_file(&Map::new()).unwrap(), "");
    }

    #[test]
    fn a_catalog_refuses_what_the_original_refused() {
        let error = |text: &str| parse_mcp_file(text).unwrap_err().to_string();
        assert_eq!(error("[defaults]\nmodel = \"x\"\n"), "MCP configuration may contain only mcp_servers, not defaults.");
        assert_eq!(error("[mcp_servers.x]\nargs = []\n"), "MCP server \"x\" must configure either command or url.");
        assert_eq!(error("[mcp_servers.x]\ncommand = \"a\"\ntransport = \"http\"\n"), "MCP server \"x\" runs a command, so it always speaks stdio and cannot set transport.");
        assert_eq!(error("[mcp_servers.x]\ncommand = \"a\"\ntransport = \"stdio\"\n"), "mcp_servers.x contains an invalid value.");
        assert_eq!(
            error("[mcp_servers.x]\ncommand = \"a\"\nurl = \"https://example.com\"\n"),
            "MCP server \"x\" must configure either command or url."
        );
        assert_eq!(error("mcp_servers = 1\n"), "mcp_servers must be a TOML table.");
        assert_eq!(error("[mcp_servers]\nx = 1\n"), "mcp_servers.x must be a TOML table.");
        assert!(error("[mcp_servers.x\n").starts_with("Invalid TOML ("));
        assert_eq!(error("[mcp_servers.x]\ncommand = \"a\"\nstartup_timeout_sec = 0.0001\n"), "MCP x.startup_timeout_sec must resolve to a whole millisecond.");
    }
}
