use crate::{
    Block, ErrorKind, Message, ProviderConfig, ProviderError, ProviderKind, RunRequest,
    ToolDefinition,
};
use serde_json::{Value, json};

pub(crate) fn responses_request(
    config: &ProviderConfig,
    id: &str,
    request: &RunRequest,
    tools: &[ToolDefinition],
) -> Result<Value, ProviderError> {
    let mut input = Vec::new();
    let mut message_id = 0;
    for message in &request.context.messages {
        if let Some(content) = super::notice(message) {
            input.push(
                json!({"type":"message","role":"developer","content":input_blocks(&content)?}),
            );
            continue;
        }
        match message {
            Message::User { content } => input.push(json!({"type":"message","role":"user","content":input_content(content)?})),
            Message::Assistant { content } => for block in content { match block {
                Block::Text { text } => { input.push(json!({"type":"message","id":format!("msg_rig_{message_id}"),"role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})); message_id += 1; },
                Block::Reasoning { reasoning: Some(encoded), .. } => if let Ok(item) = serde_json::from_str::<Value>(encoded) && item["type"] == "reasoning" { input.push(item); },
                Block::ToolCall { vendor:Some(vendor), server:true, .. } | Block::ToolResult { vendor:Some(vendor), .. } if vendor["protocol"] == "responses" => { input.push(vendor["item"].clone()); },
                Block::ToolCall { call_id, name, namespace, arguments, vendor, server:false, .. } => {
                    let kind = vendor.as_ref().and_then(|v| v.get("type")).and_then(Value::as_str).filter(|t| *t == "custom_tool_call").unwrap_or("function_call");
                    let mut item = json!({"type":kind,"call_id":call_id,"name":name});
                    item[if kind == "custom_tool_call" { "input" } else { "arguments" }] = json!(arguments);
                    if let Some(namespace) = namespace { item["namespace"] = json!(namespace); }
                    input.push(item);
                },
                Block::ToolCallRequest { .. } => return Err(invalid("Tool requests must be executed before inference.")),
                _ => {},
            } },
            Message::Tool { call_id, content, vendor, .. } => input.push(json!({"type":if vendor.as_ref().is_some_and(|v| v["type"] == "custom_tool_call") { "custom_tool_call_output" } else { "function_call_output" },"call_id":call_id,"output":input_content(content)?})),
            Message::Compaction { encrypted_content, .. } => { let encrypted = encrypted_content.as_ref().ok_or_else(|| invalid("Responses compaction is missing its encrypted checkpoint."))?; input.push(json!({"type":"compaction","encrypted_content":encrypted})); },
            _ => {},
        }
    }
    let mut value = json!({"model":request.model.as_ref().unwrap_or(&config.model),"input":input,"stream":true,"store":false,"instructions":request.context.instructions,"prompt_cache_key":id});
    let full = matches!(config.kind, ProviderKind::Codex | ProviderKind::Grok)
        || config.responses_features;
    if full {
        value["parallel_tool_calls"] = json!(config.parallel_tool_calls);
        value["text"] = json!({"verbosity":"low"});
        let effort = request.effort.unwrap_or(crate::Effort::Medium).as_str();
        value["reasoning"] = json!({"effort":effort});
        if effort != "none" {
            value["include"] = json!(["reasoning.encrypted_content"]);
        }
    }
    if let Some(format) = &request.structured_output {
        value["text"]["format"] =
            json!({"type":"json_schema","name":format.name,"schema":format.schema,"strict":true});
    }
    if let Some(tier) = &request.service_tier {
        if config.bedrock.is_some()
            || !matches!(tier.as_str(), "priority" | "ultrafast")
            || config.kind != ProviderKind::Codex
        {
            return Err(invalid(
                "This provider does not support the selected service tier.",
            ));
        }
        value["service_tier"] = json!(tier);
    }
    let mapped = tools.iter().map(|tool| {
        if let Some(native) = &tool.server { return Ok(native.clone()); }
        if let Some(grammar) = &tool.grammar { return Ok(json!({"type":"custom","name":tool.name,"description":tool.description,"format":{"type":"grammar","syntax":"lark","definition":grammar["grammar"]}})); }
        let deferred = tool.defer;
        let mut tool = json!({"type":"function","name":tool.name,"description":tool.description,"parameters":tool.parameters,"strict":false});
        // Native tool search descriptors are passed through; the protocol owns discovery.
        if tools.iter().any(|t| t.server.as_ref().is_some_and(|s| s["type"] == "tool_search")) && deferred { tool["defer_loading"] = json!(true); }
        Ok(tool)
    }).collect::<Result<Vec<Value>, ProviderError>>()?;
    value["tools"] = json!(mapped);
    value["tool_choice"] = json!("auto");
    Ok(value)
}

pub(crate) fn responses_lite_request(mut value: Value, instructions: &str, tools: Value) -> Value {
    if let Some(v) = value.as_object_mut() {
        v.remove("instructions");
        v.remove("tools");
    }
    value["parallel_tool_calls"] = json!(false);
    if value.get("reasoning").is_some() {
        value["reasoning"]["context"] = json!("all_turns");
    }
    let mut input = vec![
        json!({"type":"additional_tools","role":"developer","tools":tools}),
        json!({"type":"message","role":"developer","content":[{"type":"input_text","text":instructions}]}),
    ];
    input.extend(value["input"].as_array().cloned().unwrap_or_default());
    value["input"] = json!(input);
    value
}

fn input_blocks(content: &[Block]) -> Result<Vec<Value>, ProviderError> {
    content.iter().map(|block| match block {
    Block::Text { text } => Ok(json!({"type":"input_text","text":text})),
    Block::Image { data, mime_type } => Ok(json!({"type":"input_image","detail":"auto","image_url":format!("data:{mime_type};base64,{data}")})),
    _ => Err(invalid("Only text and images may appear in a provider input message.")),
}).collect()
}
fn input_content(content: &[Block]) -> Result<Value, ProviderError> {
    if let [Block::Text { text }] = content {
        Ok(json!(text))
    } else {
        Ok(json!(input_blocks(content)?))
    }
}
fn invalid(message: &str) -> ProviderError {
    ProviderError::new(ErrorKind::Unclassified, message)
}
