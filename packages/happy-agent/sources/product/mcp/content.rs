//! What the model sees of an MCP result: bounded text and images, never more than the declared
//! block and byte budget, with a visible note wherever something was left out.

use serde_json::{Map, Value};

use happy_providers::Block as OutputBlock;
use super::super::text::{js_display, js_json_stringify, js_length, js_slice};

use super::schemas::{MAX_MCP_IMAGE_BASE64_BYTES, MAX_MCP_JSON_DEPTH, MAX_MCP_TEXT_BYTES};

const MAXIMUM_RESULT_BLOCKS: usize = 128;
const MAXIMUM_IMAGE_BLOCKS: usize = 4;
const TRUNCATION_MARKER: &str = "... [truncated]";
const MAXIMUM_JSON_NODES: usize = 128;

struct Budget {
    image_blocks: usize,
    remaining_text_bytes: usize,
}

/// Turn one MCP result into the provider-neutral blocks the model receives.
pub fn result_to_blocks(result: &Value) -> Vec<OutputBlock> {
    let Some(record) = result.as_object() else {
        return vec![OutputBlock::text(truncate_utf8(&js_display(result), MAX_MCP_TEXT_BYTES))];
    };
    let mut blocks = Vec::new();
    let mut budget = Budget { image_blocks: 0, remaining_text_bytes: MAX_MCP_TEXT_BYTES };
    if let Some(Value::Array(content)) = record.get("content") {
        let mut index = 0;
        while index < content.len() && blocks.len() < MAXIMUM_RESULT_BLOCKS {
            for candidate in content_to_blocks(&content[index]) {
                append_within_budget(&mut blocks, candidate, &mut budget);
                if blocks.len() >= MAXIMUM_RESULT_BLOCKS {
                    break;
                }
            }
            if budget.remaining_text_bytes == 0 {
                break;
            }
            index += 1;
        }
        if index < content.len() {
            append_truncation_marker(&mut blocks, &mut budget);
        }
    }
    if !blocks.is_empty() {
        return blocks;
    }
    if let Some(structured) = record.get("structuredContent") {
        return vec![OutputBlock::text(bounded_json_stringify(structured, MAX_MCP_TEXT_BYTES))];
    }
    vec![OutputBlock::text("(empty result)")]
}

/// Say that content was left out without the notice pushing the result past its maximum: a full
/// result gives up its last block to make room for the marker.
fn append_truncation_marker(blocks: &mut Vec<OutputBlock>, budget: &mut Budget) {
    if budget.remaining_text_bytes == 0 {
        return;
    }
    if blocks.len() >= MAXIMUM_RESULT_BLOCKS {
        if let Some(OutputBlock::Image { .. }) = blocks.pop() {
            budget.image_blocks -= 1;
        }
    }
    append_within_budget(blocks, OutputBlock::text(TRUNCATION_MARKER), budget);
}

fn append_within_budget(blocks: &mut Vec<OutputBlock>, block: OutputBlock, budget: &mut Budget) {
    match block {
        OutputBlock::Text { text } => {
            if budget.remaining_text_bytes == 0 {
                return;
            }
            let text = truncate_utf8(&text, budget.remaining_text_bytes);
            if text.is_empty() {
                return;
            }
            budget.remaining_text_bytes -= text.len();
            blocks.push(OutputBlock::Text { text });
        }
        OutputBlock::Image { data, mime_type } => {
            if data.len() > MAX_MCP_IMAGE_BASE64_BYTES {
                append_within_budget(blocks, OutputBlock::text("The MCP tool returned an image that exceeded the size limit."), budget);
                return;
            }
            if budget.image_blocks >= MAXIMUM_IMAGE_BLOCKS {
                append_within_budget(blocks, OutputBlock::text("Additional MCP images were truncated."), budget);
                return;
            }
            blocks.push(OutputBlock::Image { data, mime_type });
            budget.image_blocks += 1;
        }
        // Only text and images are rendered from MCP content.
        _ => {}
    }
}

fn content_to_blocks(content: &Value) -> Vec<OutputBlock> {
    let Some(kind) = content.get("type").and_then(Value::as_str).filter(|_| content.is_object()) else { return Vec::new() };
    let text = |key: &str| content.get(key).and_then(Value::as_str);
    match kind {
        "text" if text("text").is_some() => vec![OutputBlock::text(text("text").unwrap_or_default())],
        "image" if text("data").is_some() && text("mimeType").is_some() => {
            vec![OutputBlock::Image { data: text("data").unwrap_or_default().into(), mime_type: text("mimeType").unwrap_or_default().into() }]
        }
        "resource" if content.get("resource").is_some_and(Value::is_object) => {
            let resource = &content["resource"];
            match resource.get("text").and_then(Value::as_str) {
                Some(inner) => vec![OutputBlock::text(inner)],
                None => vec![OutputBlock::text(format!(
                    "MCP resource: {}",
                    resource.get("uri").and_then(Value::as_str).unwrap_or("embedded content")
                ))],
            }
        }
        "resource_link" => vec![OutputBlock::text(format!("MCP resource: {}", text("uri").unwrap_or("linked content")))],
        "audio" => vec![OutputBlock::text("The MCP tool returned audio content.")],
        _ => Vec::new(),
    }
}

/// A read resource as blocks: text as text, images as images, anything else as bounded JSON.
pub fn resource_to_blocks(result: &Value) -> Vec<OutputBlock> {
    let contents = result.get("contents").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut content: Vec<Value> = contents
        .iter()
        .take(MAXIMUM_RESULT_BLOCKS)
        .map(|entry| {
            if let Some(text) = entry.get("text").and_then(Value::as_str) {
                return serde_json::json!({"type": "text", "text": text});
            }
            if let (Some(blob), Some(mime)) = (entry.get("blob").and_then(Value::as_str), entry.get("mimeType").and_then(Value::as_str)) {
                if mime.starts_with("image/") {
                    return serde_json::json!({"type": "image", "data": blob, "mimeType": mime});
                }
            }
            serde_json::json!({"type": "text", "text": bounded_json_stringify(entry, 4_096)})
        })
        .collect();
    if contents.len() > MAXIMUM_RESULT_BLOCKS {
        content.push(serde_json::json!({"type": "text", "text": TRUNCATION_MARKER}));
    }
    result_to_blocks(&serde_json::json!({"content": content}))
}

struct Preview {
    remaining_characters: usize,
    remaining_nodes: usize,
}

/// A bounded JSON rendering: at most 128 nodes, twelve levels, and `maximum_bytes` of UTF-8,
/// each cut marked.
pub fn bounded_json_stringify(value: &Value, maximum_bytes: usize) -> String {
    let mut state = Preview { remaining_characters: maximum_bytes, remaining_nodes: MAXIMUM_JSON_NODES };
    let preview = preview(value, &mut state, 0);
    truncate_utf8(&js_json_stringify(&preview), maximum_bytes)
}

fn truncated() -> Value {
    Value::String(TRUNCATION_MARKER.into())
}

fn bounded_text(text: &str, state: &mut Preview) -> String {
    let bounded = js_slice(text, 0, state.remaining_characters).to_string();
    state.remaining_characters = state.remaining_characters.saturating_sub(js_length(&bounded));
    bounded
}

fn preview(value: &Value, state: &mut Preview, depth: usize) -> Value {
    if state.remaining_nodes == 0 {
        return truncated();
    }
    state.remaining_nodes -= 1;
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(text) => Value::String(bounded_text(text, state)),
        _ if depth >= MAX_MCP_JSON_DEPTH => truncated(),
        Value::Array(items) => {
            let mut out = Vec::new();
            let mut index = 0;
            while index < items.len() {
                if state.remaining_characters == 0 || state.remaining_nodes == 0 {
                    break;
                }
                out.push(preview(&items[index], state, depth + 1));
                index += 1;
            }
            if index < items.len() {
                out.push(truncated());
            }
            Value::Array(out)
        }
        Value::Object(map) => {
            let mut out = Map::new();
            let mut stopped = false;
            for (source_key, item) in map {
                if state.remaining_characters == 0 || state.remaining_nodes == 0 {
                    stopped = true;
                    break;
                }
                let key = bounded_text(source_key, state);
                let rendered = preview(item, state, depth + 1);
                out.insert(key, rendered);
            }
            if stopped {
                out.insert(TRUNCATION_MARKER.into(), truncated());
            }
            Value::Object(out)
        }
    }
}

/// Cut text to `maximum_bytes` of UTF-8 at a character boundary, the marker counted inside it.
pub fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value.to_string();
    }
    if maximum_bytes == 0 {
        return String::new();
    }
    if maximum_bytes <= TRUNCATION_MARKER.len() {
        return TRUNCATION_MARKER[..maximum_bytes].to_string();
    }
    let prefix_bytes = maximum_bytes - TRUNCATION_MARKER.len();
    let mut end = prefix_bytes.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{TRUNCATION_MARKER}", &value[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn blocks(value: &[OutputBlock]) -> Value {
        serde_json::to_value(value).unwrap()
    }

    #[test]
    fn results_render_exactly_as_the_original_rendered_them() {
        let golden: Value = serde_json::from_str(include_str!("goldens/results.json")).unwrap();
        let image = || json!({"type": "image", "data": "aGk=", "mimeType": "image/png"});
        assert_eq!(blocks(&result_to_blocks(&json!({"content": [{"type": "text", "text": "hello"}]}))), golden["text"]);
        assert_eq!(blocks(&result_to_blocks(&json!({"content": []}))), golden["empty"]);
        let structured: Value = serde_json::from_str(r#"{"content": [], "structuredContent": {"a": [1, 2.5, "x"], "b": {"c": null}}}"#).unwrap();
        assert_eq!(blocks(&result_to_blocks(&structured)), golden["structured"]);
        let mixed = json!({"content": [
            image(),
            {"type": "resource", "resource": {"uri": "file:///x", "text": "inside"}},
            {"type": "resource", "resource": {"uri": "file:///y", "blob": "aGk="}},
            {"type": "resource_link", "uri": "file:///z", "name": "z"},
            {"type": "audio", "data": "aGk=", "mimeType": "audio/wav"},
        ]});
        assert_eq!(blocks(&result_to_blocks(&mixed)), golden["mixed"]);
        assert_eq!(blocks(&result_to_blocks(&json!({"content": (0..6).map(|_| image()).collect::<Vec<_>>()}))), golden["images"]);
        let many: Vec<Value> = (0..130).map(|index| json!({"type": "text", "text": format!("t{index}")})).collect();
        assert_eq!(blocks(&result_to_blocks(&json!({"content": many}))), golden["manyBlocks"]);
        let big = result_to_blocks(&json!({"content": [{"type": "text", "text": "é".repeat(300_000)}, {"type": "text", "text": "after"}]}));
        let summary: Vec<Value> = big
            .iter()
            .map(|block| match block {
                OutputBlock::Text { text } => {
                    let tail: String = text.chars().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect();
                    json!({"type": "text", "length": js_length(text), "tail": tail})
                }
                _ => json!({}),
            })
            .collect();
        assert_eq!(Value::Array(summary), golden["bigText"]);
        let mut deep = json!("x");
        for _ in 0..14 {
            deep = json!([deep]);
        }
        assert_eq!(Value::String(bounded_json_stringify(&json!({"deep": deep, "s": "y".repeat(50)}), 1_000)), golden["bounded"]);
        assert_eq!(Value::String(bounded_json_stringify(&json!({"alpha": "a".repeat(40), "beta": [1, 2, 3]}), 30)), golden["boundedSmall"]);
        assert_eq!(Value::String(bounded_json_stringify(&json!((0..200).collect::<Vec<_>>()), 100_000)), golden["boundedNodes"]);
    }
}
