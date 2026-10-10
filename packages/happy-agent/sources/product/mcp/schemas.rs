//! MCP protocol values as the original described them, independently of any client, so the
//! model-facing and persistence boundaries stay validated with the same bounds.
//!
//! Every builder reproduces the JSON Schema the original TypeBox definition serialized to, key
//! order included, because the tool parameters among them travel to providers verbatim.
//!
//! JSON values nest twelve collections deep, and TypeBox expanded that recursion in place, so the
//! original schemas run to megabytes; a tool result's alone serializes to twelve. Here each depth
//! is defined once and the schemas name it by reference, which `check` resolves through `$defs`.
//! `expand` writes the references out again, giving the original schema exactly: for the
//! parameters a provider receives, and for the tests that hold every schema to the original's.

use std::sync::LazyLock;

use happy_agent_base::RuntimeSchemas;
use serde_json::{Map, Value, json};

use super::typebox::{self as t, optional, required};

pub const MAX_MCP_SERVER_NAME_LENGTH: usize = 128;
pub const MAX_MCP_TOOL_NAME_LENGTH: usize = 128;
pub const MAX_MCP_DESCRIPTION_LENGTH: usize = 16_384;
pub const MAX_MCP_ERROR_MESSAGE_LENGTH: usize = 2_000;
pub const MAX_MCP_URI_LENGTH: usize = 128;
pub const MAX_MCP_CURSOR_LENGTH: usize = 32;
pub const MAX_MCP_PAGE_SIZE: usize = 100;
pub const MAX_MCP_TOTAL_TOOLS: usize = MAX_MCP_PAGE_SIZE * MAX_MCP_PAGE_SIZE;
pub const MAX_MCP_IMAGE_BASE64_BYTES: usize = 5 * 1024 * 1024;
const MAX_MCP_INPUT_IMAGE_BASE64_BYTES: usize = 10 * 1024 * 1024;
const MAX_MCP_INPUT_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_MCP_INPUT_CONTENT_BLOCKS: usize = 2_048;
const MAX_MCP_INPUT_RESOURCE_CONTENTS: usize = 2_048;
pub const MAX_MCP_TEXT_BYTES: usize = 512 * 1024;
pub const MAX_MCP_JSON_DEPTH: usize = 12;
const MAX_MCP_JSON_STRING_LENGTH: usize = 1_000_000;
const MAX_MCP_JSON_ARRAY_ITEMS: usize = 2_048;
const MAX_MCP_JSON_OBJECT_PROPERTIES: usize = 2_048;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn string(options: Value) -> Value {
    t::string_with(options)
}

/// `Type.Record(Type.String(..), value, { maxProperties })`; TypeBox keeps no key bound.
fn record(value: Value, max_properties: Option<usize>) -> Value {
    match max_properties {
        Some(max) => json!({"maxProperties": max, "type": "object", "patternProperties": {"^(.*)$": value}}),
        None => t::record(value),
    }
}

fn literals(values: &[&str]) -> Value {
    t::union(values.iter().map(|value| t::literal(*value)).collect())
}

pub fn agent_id() -> Value {
    string(json!({"minLength": 1, "maxLength": 256, "pattern": "^[^\\u0000\\r\\n]+$"}))
}

pub fn server_name() -> Value {
    string(json!({"minLength": 1, "maxLength": MAX_MCP_SERVER_NAME_LENGTH}))
}

pub fn tool_name() -> Value {
    string(json!({"minLength": 1, "maxLength": MAX_MCP_TOOL_NAME_LENGTH}))
}

fn uri() -> Value {
    string(json!({"minLength": 1, "maxLength": MAX_MCP_URI_LENGTH}))
}

fn cursor() -> Value {
    string(json!({"minLength": 1, "maxLength": MAX_MCP_CURSOR_LENGTH}))
}

fn description() -> Value {
    string(json!({"maxLength": MAX_MCP_DESCRIPTION_LENGTH}))
}

fn mime_type() -> Value {
    string(json!({"maxLength": 128}))
}

fn json_leaf() -> Value {
    t::union(vec![string(json!({"maxLength": MAX_MCP_JSON_STRING_LENGTH})), t::number(), t::boolean(), t::null()])
}

const JSON_REFERENCE_PREFIX: &str = "mcp-json-";

/// One more level of JSON value above `child`.
fn json_value_over(child: Value) -> Value {
    t::union(vec![
        json_leaf(),
        t::array_with(child.clone(), json!({"maxItems": MAX_MCP_JSON_ARRAY_ITEMS})),
        record(child, Some(MAX_MCP_JSON_OBJECT_PROPERTIES)),
    ])
}

fn json_reference(depth: usize) -> Value {
    json!({"$ref": format!("{JSON_REFERENCE_PREFIX}{depth}")})
}

/// Each depth's definition, naming the depth below it.
static JSON_DEFINITIONS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    (0..=MAX_MCP_JSON_DEPTH).map(|depth| if depth == 0 { json_leaf() } else { json_value_over(json_reference(depth - 1)) }).collect()
});

fn json_definition(name: &str) -> Option<&'static Value> {
    name.strip_prefix(JSON_REFERENCE_PREFIX)?.parse::<usize>().ok().and_then(|depth| JSON_DEFINITIONS.get(depth))
}

/// The JSON value of `depth` as the original wrote it out.
fn json_value_at_depth(depth: usize) -> Value {
    if depth == 0 { json_leaf() } else { json_value_over(json_value_at_depth(depth - 1)) }
}

/// A finite JSON value: untrusted MCP data is bounded in depth and collection size.
fn json_value() -> Value {
    json_reference(MAX_MCP_JSON_DEPTH)
}

fn json_object() -> Value {
    record(json_value(), Some(MAX_MCP_JSON_OBJECT_PROPERTIES))
}

/// One schema compiled once with the serialized TypeBox semantics, string lengths in UTF-16 units
/// included.
pub struct Checked {
    pub schema: Value,
    compiled: Option<RuntimeSchemas>,
}

impl Checked {
    pub fn new(schema: Value) -> Self {
        let mut root = local_references(&schema);
        if let Value::Object(object) = &mut root
            && contains_reference(&schema)
        {
            let definitions: Map<String, Value> =
                JSON_DEFINITIONS.iter().enumerate().map(|(depth, definition)| (format!("{JSON_REFERENCE_PREFIX}{depth}"), local_references(definition))).collect();
            object.insert("$defs".into(), Value::Object(definitions));
        }
        let compiled = RuntimeSchemas::compile(&json!({ "schema": root }).to_string());
        if let Err(error) = &compiled {
            tracing::error!(error = %error, "An MCP schema did not compile.");
        }
        Self { schema, compiled: compiled.ok() }
    }
}

/// TypeBox's `Value.Check` against one of these schemas. A schema that did not compile admits
/// nothing.
pub fn check(schema: &Checked, value: &Value) -> bool {
    schema.compiled.as_ref().is_some_and(|compiled| compiled.valid("schema", value).unwrap_or(false))
}

fn contains_reference(schema: &Value) -> bool {
    match schema {
        Value::Object(object) => object.get("$ref").and_then(Value::as_str).is_some_and(|name| json_definition(name).is_some()) || object.values().any(contains_reference),
        Value::Array(items) => items.iter().any(contains_reference),
        _ => false,
    }
}

/// The schema with each JSON depth named as a local definition.
fn local_references(schema: &Value) -> Value {
    match schema {
        Value::Object(object) => {
            if let (1, Some(Value::String(name))) = (object.len(), object.get("$ref"))
                && json_definition(name).is_some()
            {
                return json!({ "$ref": format!("#/$defs/{name}") });
            }
            Value::Object(object.iter().map(|(key, value)| (key.clone(), local_references(value))).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(local_references).collect()),
        other => other.clone(),
    }
}

/// The schema with every JSON value written out, as the original serialized it.
pub fn expand(schema: &Value) -> Value {
    match schema {
        Value::Object(object) => {
            if let (1, Some(Value::String(name))) = (object.len(), object.get("$ref")) {
                if let Some(depth) = name.strip_prefix(JSON_REFERENCE_PREFIX).and_then(|depth| depth.parse::<usize>().ok()) {
                    return json_value_at_depth(depth);
                }
            }
            Value::Object(object.iter().map(|(key, value)| (key.clone(), expand(value))).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(expand).collect()),
        other => other.clone(),
    }
}

fn annotations() -> Value {
    t::closed_object(vec![
        optional("audience", t::array_with(literals(&["user", "assistant"]), json!({"maxItems": 2}))),
        optional("priority", t::number()),
        optional("lastModified", string(json!({"maxLength": 128}))),
    ])
}

fn text_content() -> Value {
    t::closed_object(vec![
        required("type", t::literal("text")),
        required("text", string(json!({"maxLength": MAX_MCP_INPUT_TEXT_BYTES}))),
        optional("annotations", annotations()),
        optional("_meta", json_object()),
    ])
}

fn binary_content(kind: &str) -> Value {
    t::closed_object(vec![
        required("type", t::literal(kind)),
        required("data", string(json!({"maxLength": MAX_MCP_INPUT_IMAGE_BASE64_BYTES}))),
        required("mimeType", string(json!({"minLength": 1, "maxLength": 128}))),
        optional("annotations", annotations()),
        optional("_meta", json_object()),
    ])
}

fn resource_link() -> Value {
    t::closed_object(vec![
        required("type", t::literal("resource_link")),
        optional("name", string(json!({"minLength": 1, "maxLength": MAX_MCP_TOOL_NAME_LENGTH}))),
        optional("title", description()),
        required("uri", uri()),
        optional("description", description()),
        optional("mimeType", mime_type()),
        optional("size", t::integer_with(json!({"minimum": 0, "maximum": MAX_SAFE_INTEGER}))),
        optional("annotations", annotations()),
        optional("_meta", json_object()),
    ])
}

fn text_resource_contents() -> Value {
    t::closed_object(vec![
        required("uri", uri()),
        optional("mimeType", mime_type()),
        required("text", string(json!({"maxLength": MAX_MCP_INPUT_TEXT_BYTES}))),
        optional("_meta", json_object()),
    ])
}

fn blob_resource_contents() -> Value {
    t::closed_object(vec![
        required("uri", uri()),
        optional("mimeType", mime_type()),
        required("blob", string(json!({"maxLength": MAX_MCP_INPUT_IMAGE_BASE64_BYTES}))),
        optional("_meta", json_object()),
    ])
}

fn embedded_resource() -> Value {
    t::closed_object(vec![
        required("type", t::literal("resource")),
        required("resource", t::union(vec![text_resource_contents(), blob_resource_contents()])),
        optional("annotations", annotations()),
        optional("_meta", json_object()),
    ])
}

fn content_block() -> Value {
    t::union(vec![text_content(), binary_content("image"), binary_content("audio"), resource_link(), embedded_resource()])
}

pub static TOOL_RESULT: LazyLock<Checked> = LazyLock::new(|| {
    Checked::new({
    t::closed_object(vec![
        optional("_meta", json_object()),
        optional("content", t::array_with(content_block(), json!({"maxItems": MAX_MCP_INPUT_CONTENT_BLOCKS}))),
        optional("isError", t::boolean()),
        optional("structuredContent", json_value()),
    ])
    })
});

pub static READ_RESOURCE_RESULT: LazyLock<Checked> = LazyLock::new(|| {
    Checked::new({
    t::closed_object(vec![
        optional("_meta", json_object()),
        required(
            "contents",
            t::array_with(
                t::union(vec![text_resource_contents(), blob_resource_contents()]),
                json!({"maxItems": MAX_MCP_INPUT_RESOURCE_CONTENTS}),
            ),
        ),
    ])
    })
});

fn tool() -> Value {
    t::closed_object(vec![
        optional("annotations", annotations()),
        optional("description", description()),
        required("inputSchema", json_object()),
        required("name", tool_name()),
        optional("title", description()),
        optional("_meta", json_object()),
    ])
}

pub static TOOL: LazyLock<Checked> = LazyLock::new(|| Checked::new(tool()));

fn resource() -> Value {
    t::closed_object(vec![
        optional("annotations", annotations()),
        optional("description", description()),
        optional("mimeType", mime_type()),
        required("name", string(json!({"minLength": 1, "maxLength": MAX_MCP_TOOL_NAME_LENGTH}))),
        optional("title", description()),
        required("uri", uri()),
        optional("_meta", json_object()),
    ])
}

fn resource_template() -> Value {
    t::closed_object(vec![
        optional("annotations", annotations()),
        optional("description", description()),
        optional("mimeType", mime_type()),
        required("name", string(json!({"minLength": 1, "maxLength": MAX_MCP_TOOL_NAME_LENGTH}))),
        optional("title", description()),
        required("uriTemplate", uri()),
        optional("_meta", json_object()),
    ])
}

fn prompt_argument() -> Value {
    t::closed_object(vec![
        optional("description", description()),
        required("name", string(json!({"minLength": 1, "maxLength": MAX_MCP_TOOL_NAME_LENGTH}))),
        optional("required", t::boolean()),
        optional("title", description()),
    ])
}

fn prompt() -> Value {
    t::closed_object(vec![
        optional("arguments", t::array_with(prompt_argument(), json!({"maxItems": MAX_MCP_PAGE_SIZE}))),
        optional("description", description()),
        required("name", string(json!({"minLength": 1, "maxLength": MAX_MCP_TOOL_NAME_LENGTH}))),
        optional("title", description()),
        optional("_meta", json_object()),
    ])
}

pub static GET_PROMPT_RESULT: LazyLock<Checked> = LazyLock::new(|| {
    Checked::new({
    let message = t::closed_object(vec![required("content", content_block()), required("role", literals(&["user", "assistant"]))]);
    t::closed_object(vec![
        optional("description", description()),
        required("messages", t::array_with(message, json!({"maxItems": MAX_MCP_PAGE_SIZE}))),
        optional("_meta", json_object()),
    ])
    })
});

fn server_status() -> Value {
    literals(&["blocked", "connected", "disabled", "failed"])
}

fn fingerprint() -> Value {
    string(json!({"minLength": 64, "maxLength": 64, "pattern": "^[0-9a-f]{64}$"}))
}

fn tool_list() -> Value {
    t::array_with(tool_name(), json!({"maxItems": MAX_MCP_PAGE_SIZE, "uniqueItems": true}))
}

fn server_summary() -> Value {
    t::closed_object(vec![
        optional("disabledTools", tool_list()),
        optional("enabledTools", tool_list()),
        optional("errorMessage", string(json!({"maxLength": MAX_MCP_ERROR_MESSAGE_LENGTH}))),
        optional("fingerprint", fingerprint()),
        required("name", server_name()),
        optional("promptSupport", t::boolean()),
        optional("resourceSupport", t::boolean()),
        required("status", server_status()),
        required("toolCount", t::integer_with(json!({"minimum": 0, "maximum": MAX_MCP_PAGE_SIZE * MAX_MCP_PAGE_SIZE}))),
    ])
}

pub fn server_summary_list() -> Value {
    t::array_with(server_summary(), json!({"maxItems": MAX_MCP_PAGE_SIZE * MAX_MCP_PAGE_SIZE}))
}

fn page_limit() -> Value {
    t::integer_with(json!({"minimum": 1, "maximum": MAX_MCP_PAGE_SIZE}))
}

pub fn server_page_query() -> Value {
    t::closed_object(vec![optional("cursor", cursor()), optional("limit", page_limit())])
}

pub fn server_page() -> Value {
    t::closed_object(vec![
        optional("nextCursor", cursor()),
        required("servers", t::array_with(server_summary(), json!({"maxItems": MAX_MCP_PAGE_SIZE}))),
    ])
}

pub static SERVER_PAGE: LazyLock<Checked> = LazyLock::new(|| Checked::new(server_page()));

pub fn indexed_server() -> Value {
    t::closed_object(vec![
        required("agentId", agent_id()),
        optional("errorMessage", description()),
        optional("fingerprint", fingerprint()),
        required("name", server_name()),
        required("status", server_status()),
        required("toolCount", t::integer_with(json!({"minimum": 0}))),
        required("updatedAt", t::integer_with(json!({"minimum": 0}))),
    ])
}

/// The page query every per-server listing takes.
pub fn server_scoped_page_query() -> Value {
    t::closed_object(vec![optional("cursor", cursor()), optional("limit", page_limit()), required("server", server_name())])
}

fn page(key: &str, item: Value) -> Value {
    t::closed_object(vec![
        optional("nextCursor", cursor()),
        required(key, t::array_with(item, json!({"maxItems": MAX_MCP_PAGE_SIZE}))),
    ])
}

pub static TOOL_PAGE: LazyLock<Checked> = LazyLock::new(|| Checked::new(page("tools", tool())));
pub static RESOURCE_PAGE: LazyLock<Checked> = LazyLock::new(|| Checked::new(page("resources", resource())));
pub static RESOURCE_TEMPLATE_PAGE: LazyLock<Checked> = LazyLock::new(|| Checked::new(page("resourceTemplates", resource_template())));
pub static PROMPT_PAGE: LazyLock<Checked> = LazyLock::new(|| Checked::new(page("prompts", prompt())));

/// The input of every listing tool: a server and an optional cursor.
pub fn listing_input() -> Value {
    t::closed_object(vec![required("server", server_name()), optional("cursor", cursor())])
}

pub static CALL_TOOL_INPUT: LazyLock<Checked> = LazyLock::new(|| {
    Checked::new({
    t::closed_object(vec![optional("arguments", json_object()), required("name", tool_name()), required("server", server_name())])
    })
});

/// The call tool's parameters as a provider receives them.
pub static CALL_TOOL_PARAMETERS: LazyLock<Value> = LazyLock::new(|| expand(&CALL_TOOL_INPUT.schema));

pub fn read_resource_input() -> Value {
    t::closed_object(vec![required("server", server_name()), required("uri", uri())])
}

pub fn get_prompt_input() -> Value {
    t::closed_object(vec![
        optional(
            "arguments",
            record(string(json!({"maxLength": MAX_MCP_JSON_STRING_LENGTH})), Some(MAX_MCP_JSON_OBJECT_PROPERTIES)),
        ),
        required("name", tool_name()),
        required("server", server_name()),
    ])
}

fn common_config() -> Vec<t::Property> {
    let timeout = || t::integer_with(json!({"minimum": 1, "maximum": 600_000}));
    vec![
        optional("disabledTools", tool_list()),
        optional("enabledTools", tool_list()),
        optional("enabled", t::boolean()),
        optional("startupTimeoutMs", timeout()),
        optional("toolTimeoutMs", timeout()),
    ]
}

fn string_map() -> Value {
    record(string(json!({"maxLength": 16_384})), Some(MAX_MCP_JSON_OBJECT_PROPERTIES))
}

pub fn server_config() -> Value {
    let mut stdio = common_config();
    stdio.extend([
        optional("args", t::array_with(string(json!({"maxLength": 4_096})), json!({"maxItems": MAX_MCP_PAGE_SIZE}))),
        required("command", string(json!({"minLength": 1, "maxLength": 4_096}))),
        optional("cwd", string(json!({"minLength": 1, "maxLength": 4_096}))),
        optional("env", string_map()),
        required("transport", t::literal("stdio")),
    ]);
    let mut http = common_config();
    http.extend([
        optional("bearerTokenEnvVar", string(json!({"minLength": 1, "maxLength": 256}))),
        optional("headers", string_map()),
        optional("oauthClientIdEnvVar", string(json!({"minLength": 1, "maxLength": 256}))),
        optional("oauthClientSecretEnvVar", string(json!({"minLength": 1, "maxLength": 256}))),
        optional(
            "oauthScopes",
            t::array_with(string(json!({"minLength": 1, "maxLength": 256})), json!({"maxItems": MAX_MCP_PAGE_SIZE})),
        ),
        required("transport", t::literal("http")),
        required("url", string(json!({"minLength": 1, "maxLength": MAX_MCP_URI_LENGTH}))),
    ]);
    t::union(vec![t::closed_object(stdio), t::closed_object(http)])
}

pub fn configure_server_input() -> Value {
    t::closed_object(vec![
        required("action", literals(&["set", "remove"])),
        required("name", string(json!({"minLength": 1, "maxLength": 128}))),
        optional("server", server_config()),
    ])
}

pub fn reload_servers_input() -> Value {
    t::closed_object(vec![optional(
        "global",
        t::boolean_with(json!({
            "description": "Reload the user-wide ~/Happy/Config/mcp.toml catalog instead of this workspace's mcp.toml."
        })),
    )])
}

pub static ELICITATION_REQUEST: LazyLock<Checked> = LazyLock::new(|| {
    Checked::new({
    let property = record(json_value(), Some(MAX_MCP_JSON_OBJECT_PROPERTIES));
    let requested = t::closed_object(vec![
        optional("$schema", uri()),
        optional("additionalProperties", t::boolean()),
        required("properties", record(property, Some(MAX_MCP_JSON_OBJECT_PROPERTIES))),
        optional(
            "required",
            t::array_with(string(json!({"maxLength": 256})), json!({"maxItems": MAX_MCP_JSON_OBJECT_PROPERTIES})),
        ),
        required("type", t::literal("object")),
    ]);
    t::closed_object(vec![
        required("method", t::literal("elicitation/create")),
        required("params", t::closed_object(vec![required("message", description()), required("requestedSchema", requested)])),
    ])
    })
});

pub static ELICITATION_RESULT: LazyLock<Checked> = LazyLock::new(|| {
    Checked::new({
    t::union(vec![
        t::closed_object(vec![required("action", t::literal("accept")), required("content", json_object())]),
        t::closed_object(vec![required("action", t::literal("decline"))]),
    ])
    })
});

pub static AGENT_ID: LazyLock<Checked> = LazyLock::new(|| Checked::new(agent_id()));
pub static SERVER_NAME: LazyLock<Checked> = LazyLock::new(|| Checked::new(server_name()));
pub static SERVER_PAGE_QUERY: LazyLock<Checked> = LazyLock::new(|| Checked::new(server_page_query()));
pub static SERVER_SCOPED_PAGE_QUERY: LazyLock<Checked> = LazyLock::new(|| Checked::new(server_scoped_page_query()));
pub static READ_RESOURCE_INPUT: LazyLock<Checked> = LazyLock::new(|| Checked::new(read_resource_input()));
pub static GET_PROMPT_INPUT: LazyLock<Checked> = LazyLock::new(|| Checked::new(get_prompt_input()));
pub static INDEXED_SERVER: LazyLock<Checked> = LazyLock::new(|| Checked::new(indexed_server()));
pub static SERVER_SUMMARY_LIST: LazyLock<Checked> = LazyLock::new(|| Checked::new(server_summary_list()));
pub static CONNECTED_SERVER_LIST: LazyLock<Checked> = LazyLock::new(|| {
    Checked::new(t::array_with(t::closed_object(vec![required("name", server_name())]), json!({"maxItems": MAX_MCP_PAGE_SIZE * MAX_MCP_PAGE_SIZE})))
});
pub static LISTING_INPUT: LazyLock<Checked> = LazyLock::new(|| Checked::new(listing_input()));
pub static CONFIGURE_SERVER_INPUT: LazyLock<Checked> = LazyLock::new(|| Checked::new(configure_server_input()));
pub static RELOAD_SERVERS_INPUT: LazyLock<Checked> = LazyLock::new(|| Checked::new(reload_servers_input()));

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::text::js_json_stringify;
    use sha2::{Digest, Sha256};

    fn digest(value: &Value) -> String {
        Sha256::digest(js_json_stringify(value).as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn every_schema_is_the_one_the_original_serialized() {
        let golden: Value = serde_json::from_str(include_str!("goldens/schema-hashes.json")).unwrap();
        let built: Vec<(&str, Value)> = vec![
            ("mcpAgentIdSchema", agent_id()),
            ("mcpAnnotationsSchema", annotations()),
            ("mcpAudioContentSchema", binary_content("audio")),
            ("mcpBlobResourceContentsSchema", blob_resource_contents()),
            ("mcpCallToolInputSchema", CALL_TOOL_INPUT.schema.clone()),
            ("mcpContentBlockSchema", content_block()),
            ("mcpCursorSchema", cursor()),
            ("mcpElicitationRequestSchema", ELICITATION_REQUEST.schema.clone()),
            ("mcpElicitationResultSchema", ELICITATION_RESULT.schema.clone()),
            ("mcpEmbeddedResourceSchema", embedded_resource()),
            ("mcpFingerprintSchema", fingerprint()),
            ("mcpGetPromptInputSchema", get_prompt_input()),
            ("mcpGetPromptResultSchema", GET_PROMPT_RESULT.schema.clone()),
            ("mcpImageContentSchema", binary_content("image")),
            ("mcpIndexedServerSchema", indexed_server()),
            ("mcpInputSchemaSchema", json_object()),
            ("mcpJsonObjectSchema", json_object()),
            ("mcpJsonValueSchema", json_value()),
            ("mcpListPromptsInputSchema", listing_input()),
            ("mcpListResourcesInputSchema", listing_input()),
            ("mcpListToolsInputSchema", listing_input()),
            ("mcpPromptArgumentSchema", prompt_argument()),
            ("mcpPromptPageQuerySchema", server_scoped_page_query()),
            ("mcpPromptPageSchema", PROMPT_PAGE.schema.clone()),
            ("mcpPromptSchema", prompt()),
            ("mcpReadResourceInputSchema", read_resource_input()),
            ("mcpReadResourceResultSchema", READ_RESOURCE_RESULT.schema.clone()),
            ("mcpResourceLinkSchema", resource_link()),
            ("mcpResourcePageQuerySchema", server_scoped_page_query()),
            ("mcpResourcePageSchema", RESOURCE_PAGE.schema.clone()),
            ("mcpResourceSchema", resource()),
            ("mcpResourceTemplatePageSchema", RESOURCE_TEMPLATE_PAGE.schema.clone()),
            ("mcpResourceTemplateSchema", resource_template()),
            ("mcpServerConfigSchema", server_config()),
            ("mcpServerNameSchema", server_name()),
            ("mcpServerPageQuerySchema", server_page_query()),
            ("mcpServerPageSchema", server_page()),
            ("mcpServerStatusSchema", server_status()),
            ("mcpServerSummarySchema", server_summary()),
            ("mcpTextContentSchema", text_content()),
            ("mcpTextResourceContentsSchema", text_resource_contents()),
            ("mcpToolNameSchema", tool_name()),
            ("mcpToolPageQuerySchema", server_scoped_page_query()),
            ("mcpToolPageSchema", TOOL_PAGE.schema.clone()),
            ("mcpToolResultSchema", TOOL_RESULT.schema.clone()),
            ("mcpToolSchema", tool()),
            ("mcpUriSchema", uri()),
        ];
        for (name, schema) in built {
            assert_eq!(golden[name].as_str(), Some(digest(&expand(&schema)).as_str()), "{name}");
        }
    }

    #[test]
    fn a_referenced_schema_admits_exactly_what_its_expansion_admits() {
        let nested = |depth: usize| (0..depth).fold(json!("leaf"), |inner, _| json!([inner]));
        let object = |depth: usize| (0..depth).fold(json!(1), |inner, _| json!({"k": inner}));
        let result = |structured: Value| json!({"content": [], "structuredContent": structured});
        let values = [
            result(nested(12)),
            result(nested(13)),
            result(object(12)),
            result(object(13)),
            result(json!({"text": "x".repeat(1_000_001)})),
            result(Value::Array(vec![json!(1); 2_049])),
            json!({"content": [{"type": "text", "text": "hi", "_meta": {"a": nested(12)}}]}),
            json!({"content": [{"type": "text", "text": "hi", "_meta": {"a": nested(13)}}]}),
            json!({"content": [{"type": "text", "text": "hi", "extra": true}]}),
        ];
        let expanded = Checked::new(expand(&TOOL_RESULT.schema));
        for value in &values {
            assert_eq!(check(&TOOL_RESULT, value), check(&expanded, value), "{}", js_json_stringify(value).len());
        }
        assert!(check(&TOOL_RESULT, &values[0]) && !check(&TOOL_RESULT, &values[1]));
        assert!(check(&TOOL_RESULT, &values[6]) && !check(&TOOL_RESULT, &values[7]));
    }
}
