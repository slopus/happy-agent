//! The MCP tools an agent is offered: the server listing, configuration and reload, the protocol
//! tools over the connected servers, and one direct tool per server tool.
//!
//! Every tool needs Auto or Full access, because a server can act outside the local sandbox.
//! Listing and reading are never reviewed; calling a tool and loading a prompt always are,
//! whatever a server's annotations claim. Configuration edits are reviewed and run with Full
//! access, since they write the user's own configuration and start processes.

use std::sync::Arc;

use anyhow::{Result, bail};
use happy_agent_base::{AgentScope, ToolPermissionPolicy};
use happy_providers::{Block, Message, ToolDefinition};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::super::text::{js_display, js_length, js_slice, quote_visible_exact};
use super::McpModule;
use super::content::{bounded_json_stringify, resource_to_blocks, result_to_blocks};
use super::names::{describe_mcp_call, humanize_mcp_name, normalize_mcp_name};
use super::schemas::{self, Checked};

const MAX_SERVER_NAMES_CHARACTERS: usize = 16_384;
const CONFIGURE_INSTRUCTIONS: &str = "This updates the global Happy MCP configuration and reconnects external servers.";

/// The tools whose names this module owns outright.
pub(super) const FIXED: [&str; 10] = [
    "list_mcp_servers",
    "configure_mcp_server",
    "reload_mcp_servers",
    "list_mcp_tools",
    "call_mcp_tool",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
    "list_mcp_prompts",
    "get_mcp_prompt",
];

/// The MCP tool one call names, if it is one.
pub(super) enum Called {
    Fixed(&'static str),
    Direct { server: String, tool: String },
}

fn definition(name: &str, description: String, parameters: Value) -> ToolDefinition {
    ToolDefinition { name: name.into(), namespace: None, description, parameters, server: None, grammar: None, defer: true }
}

/// The configured servers and their status.
pub(super) fn list_mcp_servers() -> ToolDefinition {
    definition(
        "list_mcp_servers",
        "List configured MCP servers and their current connection status. Results are bounded and cursor-paged.".into(),
        schemas::server_page_query(),
    )
}

/// `configure_mcp_server` and `reload_mcp_servers`.
pub(super) fn configuration_tools() -> Vec<ToolDefinition> {
    vec![
        definition(
            "configure_mcp_server",
            "Adds, replaces, or removes one server in ~/Happy/Config/mcp.toml, then reloads the live MCP connections. Existing unrelated servers are preserved."
                .into(),
            schemas::configure_server_input(),
        ),
        definition(
            "reload_mcp_servers",
            "Reconciles this workspace's mcp.toml with the live shared MCP connections. Set global to true to reconcile ~/Happy/Config/mcp.toml instead. Unchanged connections keep running."
                .into(),
            schemas::reload_servers_input(),
        ),
    ]
}

/// The connected servers' humanized names for a description, bounded.
fn bounded_server_names(names: &[String]) -> String {
    let text = names.iter().map(|name| humanize_mcp_name(name)).collect::<Vec<_>>().join(", ");
    if js_length(&text) <= MAX_SERVER_NAMES_CHARACTERS {
        return text;
    }
    format!("{} … [truncated; use list_mcp_servers]", js_slice(&text, 0, MAX_SERVER_NAMES_CHARACTERS - 25))
}

/// The connected servers in the order and form their descriptions name them.
fn connected_names(connected: &[String]) -> Result<Vec<String>> {
    let listed = Value::Array(connected.iter().map(|name| json!({"name": name})).collect());
    if !schemas::check(&schemas::CONNECTED_SERVER_LIST, &listed) {
        bail!("MCP connected server list is invalid.");
    }
    // `Array.prototype.sort`: UTF-16 code unit order.
    let mut names: Vec<String> = connected.to_vec();
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    names.dedup();
    if names.len() != connected.len() {
        bail!("MCP connected server list contains duplicate names.");
    }
    Ok(names)
}

/// The tools that work over any connected server by name.
pub(super) fn protocol_tools(connected: &[String]) -> Result<Vec<ToolDefinition>> {
    let server_names = bounded_server_names(&connected_names(connected)?);
    Ok(vec![
        definition(
            "list_mcp_tools",
            format!("Lists the current live tool catalog from an MCP server, including tools added after the session started. Available servers: {server_names}."),
            schemas::listing_input(),
        ),
        definition(
            "call_mcp_tool",
            format!(
                "Calls a tool from an MCP server by its live server-side name. Use list_mcp_tools for tools added after session startup. Available servers: {server_names}."
            ),
            schemas::CALL_TOOL_PARAMETERS.clone(),
        ),
        definition(
            "list_mcp_resources",
            format!("Lists resources exposed by an MCP server. Available servers: {server_names}. Use the returned next cursor to continue pagination."),
            schemas::listing_input(),
        ),
        definition(
            "list_mcp_resource_templates",
            format!(
                "Lists parameterized resource templates exposed by an MCP server. Available servers: {server_names}. Use the returned next cursor to continue pagination."
            ),
            schemas::listing_input(),
        ),
        definition(
            "read_mcp_resource",
            format!(
                "Reads a resource from an MCP server. Available servers: {server_names}. Use a URI returned by list_mcp_resources or constructed from a listed resource template."
            ),
            schemas::read_resource_input(),
        ),
        definition(
            "list_mcp_prompts",
            format!("Lists reusable prompts exposed by an MCP server. Available servers: {server_names}. Use the returned next cursor to continue pagination."),
            schemas::listing_input(),
        ),
        definition(
            "get_mcp_prompt",
            format!("Gets a reusable prompt from an MCP server. Available servers: {server_names}."),
            schemas::get_prompt_input(),
        ),
    ])
}

/// The model-facing name of one server tool.
pub(super) fn direct_name(server: &str, tool: &str) -> String {
    format!("mcp__{}__{}", normalize_mcp_name(server), normalize_mcp_name(tool))
}

/// One server tool offered under its own qualified name, with the server's schema as its
/// parameters. The server alone judges the arguments, as it did in the original.
pub(super) fn direct_tool(server: &str, listed: &Value) -> Result<ToolDefinition> {
    if !schemas::check(&schemas::SERVER_NAME, &json!(server)) || !schemas::check(&schemas::TOOL, listed) {
        bail!("MCP direct tool definition is invalid.");
    }
    let tool = listed["name"].as_str().unwrap_or_default();
    Ok(definition(
        &direct_name(server, tool),
        listed["description"].as_str().map_or_else(|| format!("Use {tool} from {server}."), str::to_string),
        listed["inputSchema"].clone(),
    ))
}

fn is_error_result(result: &Value) -> bool {
    result.get("isError") == Some(&Value::Bool(true))
}

fn tool_message(call: &Value, content: Vec<Block>, is_error: bool) -> Message {
    Message::Tool { call_id: call["id"].as_str().unwrap_or_default().into(), content, is_error, vendor: None }
}

fn text(call: &Value, text: String, is_error: bool) -> Message {
    tool_message(call, vec![Block::text(text)], is_error)
}

/// The JSON arguments of one call, as the original read them: empty text is an empty object.
pub(super) fn arguments(call: &Value) -> Result<Value> {
    let name = call["call"]["name"].as_str().unwrap_or_default();
    let raw = call["call"]["arguments"].as_str().unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(raw).map_err(|_| anyhow::anyhow!("The arguments for \"{name}\" were not valid JSON."))
}

fn validated(call: &Value, schema: &Checked) -> Result<Value> {
    let input = arguments(call)?;
    if !schemas::check(schema, &input) {
        bail!("The arguments for \"{}\" did not match its schema.", call["call"]["name"].as_str().unwrap_or_default());
    }
    Ok(input)
}

/// Listings and reads may be stopped and run again; calls, prompts and edits may not.
pub(super) fn is_reloadable(called: &Called) -> bool {
    matches!(
        called,
        Called::Fixed("list_mcp_servers" | "list_mcp_tools" | "list_mcp_resources" | "list_mcp_resource_templates" | "read_mcp_resource" | "list_mcp_prompts")
    )
}

/// Every MCP tool needs Auto or Full access; calls, prompts and configuration edits are reviewed.
pub(super) fn policy(called: &Called, call: &Value) -> Result<ToolPermissionPolicy> {
    let input = arguments(call)?;
    let field = |name: &str| input[name].as_str().unwrap_or_default().to_string();
    let (review, full_access, action, instructions) = match called {
        Called::Fixed("configure_mcp_server") => (
            true,
            true,
            format!(
                "{} MCP server “{}” in ~/Happy/Config/mcp.toml and reloading external MCP connections",
                if input["action"] == "remove" { "removing" } else { "updating" },
                js_display(&input["name"])
            ),
            Some(CONFIGURE_INSTRUCTIONS.to_string()),
        ),
        Called::Fixed("reload_mcp_servers") => (
            true,
            true,
            if input["global"] == true {
                "reconciling external MCP servers from ~/Happy/Config/mcp.toml".into()
            } else {
                "reconciling external MCP servers from this workspace's mcp.toml".into()
            },
            None,
        ),
        // readOnlyHint and all other server annotations are untrusted metadata.
        Called::Fixed("call_mcp_tool") => (true, false, describe_mcp_call(input.get("arguments").unwrap_or(&Value::Null), &field("server"), &field("name")), None),
        Called::Fixed("get_mcp_prompt") => (
            true,
            false,
            format!(
                "loading prompt {} from {}. Access: the MCP server can return instructions from outside Happy Agent’s local sandbox",
                quote_visible_exact(&humanize_mcp_name(&field("name"))),
                quote_visible_exact(&humanize_mcp_name(&field("server")))
            ),
            None,
        ),
        Called::Fixed(name) => (false, false, format!("using the read-only MCP operation {name}"), None),
        // Every direct invocation is reviewed in Auto mode, even when a server claims that it
        // is read-only.
        Called::Direct { server, tool } => (true, false, describe_mcp_call(&input, server, tool), None),
    };
    Ok(ToolPermissionPolicy {
        should_review_in_auto_mode: review,
        should_run_in_full_access_in_auto_mode: full_access,
        requires_auto_or_full_access: true,
        action,
        instructions,
    })
}

impl McpModule {
    /// The MCP tool a call names: one of the fixed tools, or a direct tool this agent was offered
    /// or whose qualified name still resolves.
    pub(super) fn called(&self, scope: &AgentScope<'_>, call: &Value) -> Option<Called> {
        let native = &call["call"];
        if native.get("namespace").is_some_and(|namespace| !namespace.is_null()) {
            return None;
        }
        let name = native["name"].as_str()?;
        if let Some(fixed) = FIXED.iter().find(|fixed| **fixed == name) {
            return Some(Called::Fixed(fixed));
        }
        if let Some((server, tool)) = self.offered_direct(scope.id, name) {
            return Some(Called::Direct { server, tool });
        }
        // A restart forgets what was offered; the qualified name still says which server it is.
        let rest = name.strip_prefix("mcp__")?;
        let (server, tool) = rest.split_once("__")?;
        Some(Called::Direct { server: server.into(), tool: tool.into() })
    }

    /// Run one MCP tool call to its message, failures included.
    pub(super) async fn execute(self: &Arc<Self>, scope: &AgentScope<'_>, called: Called, call: &Value, cancel: CancellationToken) -> Message {
        match self.run(scope, called, call, &cancel).await {
            Ok(message) => message,
            Err(error) => text(call, error.to_string(), true),
        }
    }

    async fn run(self: &Arc<Self>, scope: &AgentScope<'_>, called: Called, call: &Value, cancel: &CancellationToken) -> Result<Message> {
        let agent = scope.id;
        let name = match called {
            Called::Direct { server, tool } => {
                let arguments = arguments(call)?;
                let input = json!({"arguments": if arguments.is_object() { arguments } else { json!({}) }, "name": tool, "server": server});
                let result = self.call_tool(cancel, agent, &input).await?;
                return Ok(tool_message(call, result_to_blocks(&result), is_error_result(&result)));
            }
            Called::Fixed(name) => name,
        };
        match name {
            "list_mcp_servers" => {
                let query = validated(call, &schemas::SERVER_PAGE_QUERY)?;
                let page = self.list_server_page_for(scope, cancel, &query).await?;
                Ok(text(call, super::format_server_page(&page, self.max_output_characters)?, false))
            }
            "configure_mcp_server" => {
                let input = validated(call, &schemas::CONFIGURE_SERVER_INPUT)?;
                let set = input["action"] == "set";
                if set != input.get("server").is_some() {
                    bail!(if set { "Setting an MCP server requires its configuration." } else { "Removing an MCP server must not include configuration." });
                }
                let server = if set { input.get("server").cloned() } else { None };
                self.configure_server(input["name"].as_str().unwrap_or_default(), server).await?;
                let page = self.list_server_page(cancel, agent, &json!({})).await?;
                Ok(text(call, super::format_server_page(&page, self.max_output_characters)?, false))
            }
            "reload_mcp_servers" => {
                let input = validated(call, &schemas::RELOAD_SERVERS_INPUT)?;
                if input["global"] == true {
                    self.reload().await?;
                } else {
                    self.reload_workspace(agent, scope.configuration).await?;
                }
                let page = self.list_server_page(cancel, agent, &json!({})).await?;
                Ok(text(call, super::format_server_page(&page, self.max_output_characters)?, false))
            }
            "call_mcp_tool" => {
                let input = validated(call, &schemas::CALL_TOOL_INPUT)?;
                self.assert_connected_server(cancel, agent, &input).await?;
                let result = self.call_tool(cancel, agent, &input).await?;
                Ok(tool_message(call, result_to_blocks(&result), is_error_result(&result)))
            }
            "read_mcp_resource" => {
                let input = validated(call, &schemas::READ_RESOURCE_INPUT)?;
                self.assert_connected_server(cancel, agent, &input).await?;
                let result = self.read_resource(cancel, agent, &input).await?;
                Ok(tool_message(call, resource_to_blocks(&result), false))
            }
            "get_mcp_prompt" => {
                let input = validated(call, &schemas::GET_PROMPT_INPUT)?;
                self.assert_connected_server(cancel, agent, &input).await?;
                let result = self.get_prompt(cancel, agent, &input).await?;
                Ok(text(call, bounded_json_stringify(&result, 512 * 1024), false))
            }
            listing => {
                let input = validated(call, &schemas::LISTING_INPUT)?;
                self.assert_connected_server(cancel, agent, &input).await?;
                let mut query = json!({"server": input["server"]});
                if let Some(cursor) = input.get("cursor") {
                    query["cursor"] = cursor.clone();
                }
                let page = match listing {
                    "list_mcp_tools" => self.list_tool_page(cancel, agent, &query).await,
                    "list_mcp_resources" => self.list_resource_page(cancel, agent, &query).await,
                    "list_mcp_resource_templates" => self.list_resource_template_page(cancel, agent, &query).await,
                    _ => self.list_prompt_page(cancel, agent, &query).await,
                }?;
                let rendered = match listing {
                    "list_mcp_tools" => super::format_tool_page(&page, self.max_output_characters),
                    "list_mcp_resources" => super::format_resource_page(&page, self.max_output_characters),
                    "list_mcp_resource_templates" => super::format_resource_template_page(&page, self.max_output_characters),
                    _ => super::format_prompt_page(&page, self.max_output_characters),
                };
                Ok(text(call, rendered.unwrap_or_else(|error| error.to_string()), false))
            }
        }
    }

    /// The protocol tools name the servers connected when they were offered; a call naming any
    /// other server is refused with the list it could have used.
    async fn assert_connected_server(&self, cancel: &CancellationToken, agent: &str, input: &Value) -> Result<()> {
        let server = input["server"].as_str().unwrap_or_default();
        let connected = self.connected_server_names(cancel, agent).await?;
        if !connected.iter().any(|name| name == server) {
            bail!("Unknown MCP server \"{server}\". Available servers: {}.", bounded_server_names(&connected_names(&connected)?));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_protocol_tool_names_only_connected_servers() {
        assert_eq!(protocol_tools(&["docs".into(), "docs".into()]).err().unwrap().to_string(), "MCP connected server list contains duplicate names.");
        assert_eq!(bounded_server_names(&["linear_app".into(), "my-docs__server".into()]), "Linear App, My Docs Server");
        let many: Vec<String> = (0..2_000).map(|index| format!("server{index:05}")).collect();
        let bounded = bounded_server_names(&many);
        assert!(bounded.ends_with(" … [truncated; use list_mcp_servers]"));
        assert_eq!(js_length(&bounded), MAX_SERVER_NAMES_CHARACTERS - 25 + js_length(" … [truncated; use list_mcp_servers]"));
    }
}
