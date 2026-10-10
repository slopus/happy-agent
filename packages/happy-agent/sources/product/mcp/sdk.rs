//! What the original's MCP SDK accepted from a server, and how it reshaped it.
//!
//! The SDK parsed every server message with its own schemas before the module saw it: content
//! blocks, tools, resources, and prompts lost unknown keys, results kept theirs, a missing tool
//! result `content` became empty, and malformed values were rejected. The module's own bounded
//! checks then ran on that parsed shape, so which server responses work depends on both. These
//! shapes reproduce the parsing; only the wording of a rejection is this implementation's own.

use std::sync::LazyLock;

use serde_json::{Map, Value};

/// One schema of the SDK's parser.
#[derive(Clone)]
pub(super) enum Shape {
    Unknown,
    String,
    Url,
    Base64,
    IsoDatetime,
    Number,
    NumberBetween(f64, f64),
    Boolean,
    Literal(&'static str),
    Enum(&'static [&'static str]),
    Array(Box<Shape>),
    /// A string-keyed record whose values all match.
    Record(Box<Shape>),
    /// Any object, kept as it is.
    AnyObject,
    Object(Vec<Field>, Unknowns),
    Union(Vec<Shape>),
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Unknowns {
    /// Unknown keys are dropped.
    Strip,
    /// Unknown keys are kept as they are.
    Keep,
}

#[derive(Clone)]
pub(super) struct Field {
    name: &'static str,
    shape: Shape,
    presence: Presence,
}

#[derive(Clone)]
enum Presence {
    Required,
    Optional,
    Default(fn() -> Value),
}

fn field(name: &'static str, shape: Shape) -> Field {
    Field { name, shape, presence: Presence::Required }
}

fn maybe(name: &'static str, shape: Shape) -> Field {
    Field { name, shape, presence: Presence::Optional }
}

fn object(fields: Vec<Field>) -> Shape {
    Shape::Object(fields, Unknowns::Strip)
}

fn loose(fields: Vec<Field>) -> Shape {
    Shape::Object(fields, Unknowns::Keep)
}

fn array(shape: Shape) -> Shape {
    Shape::Array(Box::new(shape))
}

fn record(shape: Shape) -> Shape {
    Shape::Record(Box::new(shape))
}

/// Parse a value the way the SDK did, or say where it does not fit.
pub(super) fn parse(shape: &Shape, value: &Value) -> Result<Value, String> {
    parse_at(shape, value, "")
}

fn mismatch(path: &str, expected: &str) -> String {
    if path.is_empty() { format!("expected {expected}") } else { format!("{path}: expected {expected}") }
}

fn parse_at(shape: &Shape, value: &Value, path: &str) -> Result<Value, String> {
    match shape {
        Shape::Unknown => Ok(value.clone()),
        Shape::String => value.as_str().map(|_| value.clone()).ok_or_else(|| mismatch(path, "a string")),
        Shape::Url => match value.as_str() {
            Some(text) if reqwest::Url::parse(text).is_ok() => Ok(value.clone()),
            _ => Err(mismatch(path, "a URL")),
        },
        Shape::Base64 => match value.as_str() {
            Some(text) if forgiving_base64(text) => Ok(value.clone()),
            _ => Err(mismatch(path, "base64 data")),
        },
        Shape::IsoDatetime => match value.as_str() {
            Some(text) if iso_datetime(text) => Ok(value.clone()),
            _ => Err(mismatch(path, "an ISO 8601 date and time")),
        },
        Shape::Number => value.as_f64().map(|_| value.clone()).ok_or_else(|| mismatch(path, "a number")),
        Shape::NumberBetween(min, max) => match value.as_f64() {
            Some(number) if number >= *min && number <= *max => Ok(value.clone()),
            _ => Err(mismatch(path, &format!("a number from {min} to {max}"))),
        },
        Shape::Boolean => value.as_bool().map(|_| value.clone()).ok_or_else(|| mismatch(path, "a boolean")),
        Shape::Literal(expected) => {
            (value.as_str() == Some(*expected)).then(|| value.clone()).ok_or_else(|| mismatch(path, &format!("\"{expected}\"")))
        }
        Shape::Enum(options) => match value.as_str() {
            Some(text) if options.contains(&text) => Ok(value.clone()),
            _ => Err(mismatch(path, &format!("one of {}", options.join(", ")))),
        },
        Shape::Array(item) => {
            let Some(items) = value.as_array() else { return Err(mismatch(path, "an array")) };
            items.iter().enumerate().map(|(index, entry)| parse_at(item, entry, &format!("{path}/{index}"))).collect::<Result<_, _>>().map(Value::Array)
        }
        Shape::Record(item) => {
            let Some(map) = value.as_object() else { return Err(mismatch(path, "an object")) };
            let mut out = Map::new();
            for (key, entry) in map {
                out.insert(key.clone(), parse_at(item, entry, &format!("{path}/{key}"))?);
            }
            Ok(Value::Object(out))
        }
        Shape::AnyObject => value.is_object().then(|| value.clone()).ok_or_else(|| mismatch(path, "an object")),
        Shape::Object(fields, unknowns) => {
            let Some(map) = value.as_object() else { return Err(mismatch(path, "an object")) };
            let mut out = Map::new();
            for entry in fields {
                match map.get(entry.name) {
                    Some(found) => {
                        out.insert(entry.name.into(), parse_at(&entry.shape, found, &format!("{path}/{}", entry.name))?);
                    }
                    None => match &entry.presence {
                        Presence::Required => return Err(mismatch(&format!("{path}/{}", entry.name), "a value")),
                        Presence::Optional => {}
                        Presence::Default(default) => {
                            out.insert(entry.name.into(), default());
                        }
                    },
                }
            }
            if *unknowns == Unknowns::Keep {
                for (key, entry) in map {
                    if !fields.iter().any(|known| known.name == key) {
                        out.insert(key.clone(), entry.clone());
                    }
                }
            }
            Ok(Value::Object(out))
        }
        Shape::Union(options) => {
            let mut first = None;
            for option in options {
                match parse_at(option, value, path) {
                    Ok(parsed) => return Ok(parsed),
                    Err(error) => {
                        first.get_or_insert(error);
                    }
                }
            }
            Err(first.unwrap_or_else(|| mismatch(path, "a matching value")))
        }
    }
}

/// What `atob` accepts: base64 with ASCII whitespace ignored and padding optional.
fn forgiving_base64(text: &str) -> bool {
    let mut data: Vec<u8> = text.bytes().filter(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r')).collect();
    if data.len() % 4 == 0 {
        for _ in 0..2 {
            if data.last() == Some(&b'=') {
                data.pop();
            }
        }
    }
    data.len() % 4 != 1 && data.iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
}

fn iso_datetime(text: &str) -> bool {
    static PATTERN: LazyLock<Option<regex_lite::Regex>> = LazyLock::new(|| {
        regex_lite::Regex::new(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)$").ok()
    });
    PATTERN.as_ref().is_some_and(|pattern| pattern.is_match(text))
}

fn meta() -> Field {
    maybe("_meta", record(Shape::Unknown))
}

fn annotations() -> Field {
    maybe(
        "annotations",
        object(vec![
            maybe("audience", array(Shape::Enum(&["user", "assistant"]))),
            maybe("priority", Shape::NumberBetween(0.0, 1.0)),
            maybe("lastModified", Shape::IsoDatetime),
        ]),
    )
}

fn icons() -> Field {
    maybe(
        "icons",
        array(object(vec![
            field("src", Shape::String),
            maybe("mimeType", Shape::String),
            maybe("sizes", array(Shape::String)),
            maybe("theme", Shape::Enum(&["light", "dark"])),
        ])),
    )
}

fn resource_fields() -> Vec<Field> {
    vec![
        field("name", Shape::String),
        maybe("title", Shape::String),
        icons(),
        field("uri", Shape::String),
        maybe("description", Shape::String),
        maybe("mimeType", Shape::String),
        maybe("size", Shape::Number),
        annotations(),
        maybe("_meta", loose(Vec::new())),
    ]
}

fn resource_contents(kind: Field) -> Shape {
    object(vec![field("uri", Shape::String), maybe("mimeType", Shape::String), meta(), kind])
}

fn text_resource_contents() -> Shape {
    resource_contents(field("text", Shape::String))
}

fn blob_resource_contents() -> Shape {
    resource_contents(field("blob", Shape::Base64))
}

fn content_block() -> Shape {
    let binary = |kind: &'static str| {
        object(vec![field("type", Shape::Literal(kind)), field("data", Shape::Base64), field("mimeType", Shape::String), annotations(), meta()])
    };
    let mut link = resource_fields();
    link.push(field("type", Shape::Literal("resource_link")));
    Shape::Union(vec![
        object(vec![field("type", Shape::Literal("text")), field("text", Shape::String), annotations(), meta()]),
        binary("image"),
        binary("audio"),
        object(link),
        object(vec![
            field("type", Shape::Literal("resource")),
            field("resource", Shape::Union(vec![text_resource_contents(), blob_resource_contents()])),
            annotations(),
            meta(),
        ]),
    ])
}

/// Every result keeps its unknown keys and may carry `_meta`.
fn result(mut fields: Vec<Field>) -> Shape {
    fields.insert(0, maybe("_meta", loose(Vec::new())));
    loose(fields)
}

fn paginated(key: &'static str, item: Shape) -> Shape {
    result(vec![maybe("nextCursor", Shape::String), field(key, array(item))])
}

fn object_schema() -> Shape {
    loose(vec![
        field("type", Shape::Literal("object")),
        maybe("properties", record(Shape::AnyObject)),
        maybe("required", array(Shape::String)),
    ])
}

pub(super) static INITIALIZE_RESULT: LazyLock<Shape> = LazyLock::new(|| {
    let capabilities = object(vec![
        maybe("experimental", record(Shape::AnyObject)),
        maybe("logging", Shape::AnyObject),
        maybe("completions", Shape::AnyObject),
        maybe("prompts", object(vec![maybe("listChanged", Shape::Boolean)])),
        maybe("resources", object(vec![maybe("subscribe", Shape::Boolean), maybe("listChanged", Shape::Boolean)])),
        maybe("tools", object(vec![maybe("listChanged", Shape::Boolean)])),
        maybe("tasks", loose(Vec::new())),
        maybe("extensions", record(Shape::AnyObject)),
    ]);
    let implementation = object(vec![
        field("name", Shape::String),
        maybe("title", Shape::String),
        icons(),
        field("version", Shape::String),
        maybe("websiteUrl", Shape::String),
        maybe("description", Shape::String),
    ]);
    result(vec![
        field("protocolVersion", Shape::String),
        field("capabilities", capabilities),
        field("serverInfo", implementation),
        maybe("instructions", Shape::String),
    ])
});

pub(super) static LIST_TOOLS_RESULT: LazyLock<Shape> = LazyLock::new(|| {
    let tool = object(vec![
        field("name", Shape::String),
        maybe("title", Shape::String),
        icons(),
        maybe("description", Shape::String),
        field("inputSchema", object_schema()),
        maybe("outputSchema", object_schema()),
        maybe(
            "annotations",
            object(vec![
                maybe("title", Shape::String),
                maybe("readOnlyHint", Shape::Boolean),
                maybe("destructiveHint", Shape::Boolean),
                maybe("idempotentHint", Shape::Boolean),
                maybe("openWorldHint", Shape::Boolean),
            ]),
        ),
        maybe("execution", object(vec![maybe("taskSupport", Shape::Enum(&["required", "optional", "forbidden"]))])),
        meta(),
    ]);
    paginated("tools", tool)
});

pub(super) static CALL_TOOL_RESULT: LazyLock<Shape> = LazyLock::new(|| {
    result(vec![
        Field { name: "content", shape: array(content_block()), presence: Presence::Default(|| Value::Array(Vec::new())) },
        maybe("structuredContent", record(Shape::Unknown)),
        maybe("isError", Shape::Boolean),
    ])
});

pub(super) static LIST_RESOURCES_RESULT: LazyLock<Shape> = LazyLock::new(|| paginated("resources", object(resource_fields())));

pub(super) static LIST_RESOURCE_TEMPLATES_RESULT: LazyLock<Shape> = LazyLock::new(|| {
    paginated(
        "resourceTemplates",
        object(vec![
            field("name", Shape::String),
            maybe("title", Shape::String),
            icons(),
            field("uriTemplate", Shape::String),
            maybe("description", Shape::String),
            maybe("mimeType", Shape::String),
            annotations(),
            maybe("_meta", loose(Vec::new())),
        ]),
    )
});

pub(super) static LIST_PROMPTS_RESULT: LazyLock<Shape> = LazyLock::new(|| {
    let argument = object(vec![field("name", Shape::String), maybe("description", Shape::String), maybe("required", Shape::Boolean)]);
    paginated(
        "prompts",
        object(vec![
            field("name", Shape::String),
            maybe("title", Shape::String),
            icons(),
            maybe("description", Shape::String),
            maybe("arguments", array(argument)),
            maybe("_meta", loose(Vec::new())),
        ]),
    )
});

pub(super) static GET_PROMPT_RESULT: LazyLock<Shape> = LazyLock::new(|| {
    result(vec![
        maybe("description", Shape::String),
        field(
            "messages",
            array(object(vec![field("role", Shape::Enum(&["user", "assistant"])), field("content", content_block())])),
        ),
    ])
});

pub(super) static READ_RESOURCE_RESULT: LazyLock<Shape> =
    LazyLock::new(|| result(vec![field("contents", array(Shape::Union(vec![text_resource_contents(), blob_resource_contents()])))]));

/// An `elicitation/create` request after parsing: the form or the URL variant of its params.
pub(super) static ELICIT_REQUEST: LazyLock<Shape> = LazyLock::new(|| {
    let strings = || array(Shape::String);
    let common = |kind: &'static str, mut fields: Vec<Field>| {
        let mut all = vec![
            field("type", Shape::Literal(kind)),
            maybe("title", Shape::String),
            maybe("description", Shape::String),
        ];
        all.append(&mut fields);
        object(all)
    };
    let option = || object(vec![field("const", Shape::String), field("title", Shape::String)]);
    let primitive = Shape::Union(vec![
        common("string", vec![field("enum", strings()), maybe("enumNames", strings()), maybe("default", Shape::String)]),
        common("string", vec![field("enum", strings()), maybe("default", Shape::String)]),
        common("string", vec![field("oneOf", array(option())), maybe("default", Shape::String)]),
        common(
            "array",
            vec![
                maybe("minItems", Shape::Number),
                maybe("maxItems", Shape::Number),
                field("items", object(vec![field("type", Shape::Literal("string")), field("enum", strings())])),
                maybe("default", strings()),
            ],
        ),
        common(
            "array",
            vec![
                maybe("minItems", Shape::Number),
                maybe("maxItems", Shape::Number),
                field("items", object(vec![field("anyOf", array(option()))])),
                maybe("default", strings()),
            ],
        ),
        common("boolean", vec![maybe("default", Shape::Boolean)]),
        common(
            "string",
            vec![
                maybe("minLength", Shape::Number),
                maybe("maxLength", Shape::Number),
                maybe("format", Shape::Enum(&["email", "uri", "date", "date-time"])),
                maybe("default", Shape::String),
            ],
        ),
        object(vec![
            field("type", Shape::Enum(&["number", "integer"])),
            maybe("title", Shape::String),
            maybe("description", Shape::String),
            maybe("minimum", Shape::Number),
            maybe("maximum", Shape::Number),
            maybe("default", Shape::Number),
        ]),
    ]);
    let base = || vec![maybe("_meta", loose(Vec::new())), maybe("task", object(vec![maybe("ttl", Shape::Number)]))];
    let mut form = base();
    form.extend([
        maybe("mode", Shape::Literal("form")),
        field("message", Shape::String),
        field(
            "requestedSchema",
            object(vec![
                field("type", Shape::Literal("object")),
                field("properties", record(primitive)),
                maybe("required", array(Shape::String)),
            ]),
        ),
    ]);
    let mut link = base();
    link.extend([
        field("mode", Shape::Literal("url")),
        field("message", Shape::String),
        field("elicitationId", Shape::String),
        field("url", Shape::Url),
    ]);
    object(vec![field("method", Shape::Literal("elicitation/create")), field("params", Shape::Union(vec![object(form), object(link)]))])
});

/// One incoming JSON-RPC message, classified the way the SDK's strict message schemas did.
pub(super) enum Incoming {
    Request { id: Value, method: String, params: Option<Value> },
    Notification { method: String, params: Option<Value> },
    Result { id: Value, result: Value },
    Error { id: Option<Value>, code: i64, message: String },
}

fn request_id(value: &Value) -> bool {
    value.is_string() || value.as_f64().is_some_and(|number| number.fract() == 0.0)
}

/// Classify one message, or reject it as the SDK did anything else.
pub(super) fn classify(message: &Value) -> Option<Incoming> {
    let map = message.as_object()?;
    if map.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return None;
    }
    let only = |allowed: &[&str]| map.keys().all(|key| allowed.contains(&key.as_str()));
    let params = map.get("params");
    if params.is_some_and(|params| !params.is_object()) {
        return None;
    }
    if let Some(method) = map.get("method").and_then(Value::as_str) {
        if let Some(id) = map.get("id") {
            return (request_id(id) && only(&["jsonrpc", "id", "method", "params"]))
                .then(|| Incoming::Request { id: id.clone(), method: method.into(), params: params.cloned() });
        }
        return only(&["jsonrpc", "method", "params"]).then(|| Incoming::Notification { method: method.into(), params: params.cloned() });
    }
    if let Some(result) = map.get("result") {
        let id = map.get("id")?;
        return (request_id(id) && result.is_object() && only(&["jsonrpc", "id", "result"]))
            .then(|| Incoming::Result { id: id.clone(), result: result.clone() });
    }
    let error = map.get("error")?.as_object()?;
    if !only(&["jsonrpc", "id", "error"]) || map.get("id").is_some_and(|id| !request_id(id)) {
        return None;
    }
    let code = error.get("code")?.as_f64().filter(|code| code.fract() == 0.0)? as i64;
    let message = error.get("message")?.as_str()?.to_string();
    Some(Incoming::Error { id: map.get("id").cloned(), code, message })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn content_loses_unknown_keys_while_results_keep_theirs() {
        let parsed = parse(
            &CALL_TOOL_RESULT,
            &json!({"content": [{"type": "text", "text": "hi", "extra": 1}], "vendor": true}),
        )
        .unwrap();
        assert_eq!(parsed, json!({"content": [{"type": "text", "text": "hi"}], "vendor": true}));
        assert_eq!(parse(&CALL_TOOL_RESULT, &json!({})).unwrap(), json!({"content": []}));
        assert!(parse(&CALL_TOOL_RESULT, &json!({"content": [{"type": "image", "data": "%%", "mimeType": "image/png"}]})).is_err());
    }

    #[test]
    fn elicitation_properties_take_the_first_schema_they_fit() {
        let parsed = parse(
            &ELICIT_REQUEST,
            &json!({"method": "elicitation/create", "params": {"message": "m", "requestedSchema": {"type": "object", "$schema": "x",
                "properties": {"a": {"type": "string", "enum": ["x"], "enumNames": ["X"], "other": 1}, "b": {"type": "integer", "title": "B"}}}}}),
        )
        .unwrap();
        assert_eq!(
            parsed["params"],
            json!({"message": "m", "requestedSchema": {"type": "object", "properties": {
                "a": {"type": "string", "enum": ["x"], "enumNames": ["X"]}, "b": {"type": "integer", "title": "B"}}}})
        );
    }

    #[test]
    fn messages_are_classified_strictly() {
        assert!(matches!(classify(&json!({"jsonrpc": "2.0", "id": 1, "result": {}})), Some(Incoming::Result { .. })));
        assert!(classify(&json!({"jsonrpc": "2.0", "id": 1, "result": {}, "extra": 1})).is_none());
        assert!(matches!(classify(&json!({"jsonrpc": "2.0", "method": "ping", "id": "a"})), Some(Incoming::Request { .. })));
        assert!(matches!(
            classify(&json!({"jsonrpc": "2.0", "id": 3, "error": {"code": -32601, "message": "Method not found"}})),
            Some(Incoming::Error { code: -32601, .. })
        ));
        assert!(forgiving_base64("aGk=") && forgiving_base64("aGk") && !forgiving_base64("a"));
    }
}
