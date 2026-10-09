use crate::{
    Block, Effort, ErrorKind, Message, ProviderConfig, ProviderError, ProviderKind, RunRequest,
    ToolDefinition,
};
use serde_json::{Value, json};

pub(crate) fn chat_request(
    config: &ProviderConfig,
    request: &RunRequest,
    tools: &[ToolDefinition],
) -> Result<Value, ProviderError> {
    let mut messages = Vec::new();
    if !request.context.instructions.is_empty() {
        messages.push(json!({"role":"system","content":request.context.instructions}));
    }
    for message in &request.context.messages {
        if let Some(content) = super::notice(message) {
            messages.push(json!({"role":"system","content":input(&content)?}));
            continue;
        }
        match message {
            Message::User { content } => {
                messages.push(json!({"role":"user","content":input(content)?}))
            }
            Message::Assistant { content } => {
                let calls = content.iter().filter_map(|b| match b { Block::ToolCall { call_id, name, namespace, arguments, server:false, .. } => Some(json!({"id":call_id,"type":"function","function":{"name":tool_name(name, namespace),"arguments":arguments}})), _ => None }).collect::<Vec<_>>();
                if content.iter().any(|b| {
                    matches!(
                        b,
                        Block::ToolCall { server: true, .. } | Block::ToolResult { .. }
                    )
                }) {
                    return Err(invalid(
                        "Chat Completions cannot replay another provider’s opaque output.",
                    ));
                }
                let reasoning = content
                    .iter()
                    .filter_map(|b| match b {
                        Block::Reasoning { text, .. } => text.as_deref(),
                        _ => None,
                    })
                    .collect::<String>();
                let mut item = json!({"role":"assistant","reasoning_content":reasoning});
                let text = super::text(content);
                if !text.is_empty() {
                    item["content"] = json!(text);
                }
                if !calls.is_empty() {
                    item["tool_calls"] = json!(calls);
                }
                messages.push(item);
            }
            Message::Tool {
                call_id, content, ..
            } => messages
                .push(json!({"role":"tool","tool_call_id":call_id,"content":input(content)?})),
            Message::Compaction {
                content,
                encrypted_content,
                vendor,
            } => {
                if encrypted_content.is_some() {
                    return Err(invalid(
                        "Chat Completions cannot replay encrypted compaction.",
                    ));
                }
                if let Some(content) = content {
                    messages.push(json!({"role":"user","content":content}));
                }
                if let Some(continuation) = vendor.as_ref().and_then(|v| v.get("continuation")) {
                    messages.push(json!({"role":"user","content":continuation}));
                }
            }
            _ => {}
        }
    }
    let mut wire_tools = Vec::new();
    for tool in tools {
        if tool.server.is_some() || tool.grammar.is_some() {
            return Err(invalid("This model supports ordinary function tools only."));
        }
        wire_tools.push(json!({"type":"function","function":{"name":tool_name(&tool.name,&tool.namespace),"description":tool.description,"parameters":tool.parameters}}));
    }
    let effort = match request.effort.unwrap_or(Effort::Max) {
        Effort::Low => "low",
        Effort::High => "high",
        Effort::Max => "max",
        _ => {
            return Err(invalid(
                "Kimi and GLM support low, high, and max reasoning effort.",
            ));
        }
    };
    if config.kind == ProviderKind::Glm
        && request
            .context
            .messages
            .iter()
            .any(|m| m.content().iter().any(|b| matches!(b, Block::Image { .. })))
    {
        return Err(invalid("GLM 5.3 supports text input only."));
    }
    let mut value = json!({"model":request.model.as_ref().unwrap_or(&config.model),"messages":messages,"stream":true,"stream_options":{"include_usage":true},"reasoning_effort":effort});
    if !wire_tools.is_empty() {
        value["tools"] = json!(wire_tools);
    }
    if let Some(output) = &request.structured_output {
        value["response_format"] =
            json!({"type":"json_schema","json_schema":{"name":output.name,"schema":output.schema}});
    }
    Ok(value)
}
fn input(content: &[Block]) -> Result<Value, ProviderError> {
    if let [Block::Text { text }] = content {
        return Ok(json!(text));
    }
    Ok(json!(content.iter().map(|b| match b { Block::Text { text } => Ok(json!({"type":"text","text":text})), Block::Image { data, mime_type } => Ok(json!({"type":"image_url","image_url":{"url":format!("data:{mime_type};base64,{data}")}})), _ => Err(invalid("Tool requests must be consumed before inference.")) }).collect::<Result<Vec<_>, _>>()?))
}
pub(crate) fn tool_name(name: &str, namespace: &Option<String>) -> String {
    namespace
        .as_ref()
        .map(|n| format!("{n}__{name}"))
        .unwrap_or_else(|| name.to_owned())
}
fn invalid(message: &str) -> ProviderError {
    ProviderError::new(ErrorKind::Unclassified, message)
}
