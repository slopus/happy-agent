//! Builders for the exact JSON Schema TypeBox serialized, key order included, for the MCP
//! protocol values whose recursive JSON depth makes a captured copy impractical.
//!
//! Model-facing tool schemas travel to providers verbatim, so they must match what the original
//! `Type.*` constructors produced: options first, then `type`, then `required`, then
//! `properties`.

use serde_json::{Map, Value, json};

fn merge(options: Value, schema: Value) -> Value {
    let mut out = match options {
        Value::Object(options) => options,
        _ => Map::new(),
    };
    if let Value::Object(schema) = schema {
        for (key, value) in schema {
            out.insert(key, value);
        }
    }
    Value::Object(out)
}

pub fn string_with(options: Value) -> Value {
    merge(options, json!({"type": "string"}))
}

pub fn number() -> Value {
    json!({"type": "number"})
}

pub fn integer_with(options: Value) -> Value {
    merge(options, json!({"type": "integer"}))
}

pub fn boolean() -> Value {
    json!({"type": "boolean"})
}

pub fn boolean_with(options: Value) -> Value {
    merge(options, json!({"type": "boolean"}))
}

pub fn null() -> Value {
    json!({"type": "null"})
}

/// `Type.Literal(value)`: `{ const, type }`.
pub fn literal(value: impl Into<Value>) -> Value {
    let value = value.into();
    let kind = match &value {
        Value::String(_) => "string",
        Value::Bool(_) => "boolean",
        _ => "number",
    };
    json!({"const": value, "type": kind})
}

pub fn union(variants: Vec<Value>) -> Value {
    json!({"anyOf": variants})
}

pub fn array_with(items: Value, options: Value) -> Value {
    merge(options, json!({"type": "array", "items": items}))
}

/// One object property: its name, schema, and whether it is required.
pub struct Property {
    pub name: String,
    pub schema: Value,
    pub required: bool,
}

pub fn required(name: &str, schema: Value) -> Property {
    Property { name: name.to_string(), schema, required: true }
}

pub fn optional(name: &str, schema: Value) -> Property {
    Property { name: name.to_string(), schema, required: false }
}

/// `Type.Object(properties, options)`.
fn object_with(properties: Vec<Property>, options: Value) -> Value {
    let mut schema = Map::new();
    schema.insert("type".into(), Value::String("object".into()));
    let required: Vec<Value> =
        properties.iter().filter(|property| property.required).map(|property| Value::String(property.name.clone())).collect();
    if !required.is_empty() {
        schema.insert("required".into(), Value::Array(required));
    }
    let mut map = Map::new();
    for property in properties {
        map.insert(property.name, property.schema);
    }
    schema.insert("properties".into(), Value::Object(map));
    merge(options, Value::Object(schema))
}

/// `Type.Object(properties, { additionalProperties: false })`.
pub fn closed_object(properties: Vec<Property>) -> Value {
    object_with(properties, json!({"additionalProperties": false}))
}

/// `Type.Record(Type.String(), value)`.
pub fn record(value: Value) -> Value {
    json!({"type": "object", "patternProperties": {"^(.*)$": value}})
}
