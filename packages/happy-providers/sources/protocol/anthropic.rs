use crate::{Block, Effort, ErrorKind, Message, ProviderError, RunRequest, ToolDefinition};
use serde_json::{Value, json};

pub(crate) fn anthropic_request(
    model: &str,
    request: &RunRequest,
    tools: &[ToolDefinition],
    compact: Option<Option<String>>,
) -> Result<Value, ProviderError> {
    let mut messages = Vec::new();
    for message in &request.context.messages {
        if let Some(content) = super::notice(message) {
            messages.push(json!({"role":"user","content":format!("<system-reminder>\n{}\n</system-reminder>", super::text(&content))}));
            continue;
        }
        match message {
            Message::User { content } => messages.push(json!({"role":"user","content":input(content)?})),
            Message::Tool { call_id, content, is_error, .. } => messages.push(json!({"role":"user","content":[{"type":"tool_result","tool_use_id":call_id,"content":input(content)?,"is_error":is_error}]})),
            Message::Compaction { content, encrypted_content, vendor } => {
                let block = vendor.as_ref().and_then(|v| v.get("block")).cloned().unwrap_or_else(|| json!({"type":"compaction","content":content,"encrypted_content":encrypted_content}));
                messages.push(json!({"role":"assistant","content":[block]}));
            },
            Message::Assistant { content } => {
                let mut blocks = Vec::new();
                for block in content { match block {
                    Block::Text { text } => blocks.push(json!({"type":"text","text":text})),
                    Block::Reasoning { text: Some(text), reasoning: Some(signature) } => blocks.push(json!({"type":"thinking","thinking":text,"signature":signature})),
                    Block::Reasoning { text: None, reasoning: Some(data) } => blocks.push(json!({"type":"redacted_thinking","data":data})),
                    Block::ToolCall { vendor:Some(vendor), server:true, .. } | Block::ToolResult { vendor:Some(vendor), .. } if vendor["protocol"] == "anthropic" => blocks.push(vendor["item"].clone()),
                    Block::ToolCall { call_id, name, namespace, arguments, server:false, .. } => blocks.push(json!({"type":"tool_use","id":call_id,"name":super::chat_completions::tool_name(name,namespace),"input":serde_json::from_str::<Value>(arguments).map_err(|_| invalid("The stored tool arguments are not valid JSON."))?})),
                    _ => {},
                } }
                if !blocks.is_empty() { messages.push(json!({"role":"assistant","content":blocks})); }
            },
            _ => {},
        }
    }
    // Cache control belongs on the final eligible block, never on signed thinking.
    if let Some(last) = messages.last_mut() {
        if let Some(text) = last["content"].as_str() {
            last["content"] = json!([{"type":"text","text":text}]);
        }
        if let Some(blocks) = last["content"].as_array_mut()
            && let Some(block) = blocks.iter_mut().rev().find(|b| {
                matches!(
                    b["type"].as_str(),
                    Some("text" | "image" | "tool_use" | "tool_result")
                )
            })
        {
            block["cache_control"] = json!({"type":"ephemeral"});
        }
    }
    let mut wire_tools = tools.iter().map(|tool| tool.server.clone().unwrap_or_else(|| json!({"name":super::chat_completions::tool_name(&tool.name,&tool.namespace),"description":tool.description,"input_schema":tool.parameters}))).collect::<Vec<_>>();
    if let Some(tool) = wire_tools.last_mut() {
        tool["cache_control"] = json!({"type":"ephemeral"});
    }
    let mut value = json!({"model":model,"max_tokens":64000,"messages":messages,"stream":true,"thinking":if matches!(request.effort,Some(Effort::Off)) { json!({"type":"disabled"}) } else { json!({"type":"adaptive"}) }});
    if !request.context.instructions.is_empty() {
        value["system"] = json!([{"type":"text","text":request.context.instructions,"cache_control":{"type":"ephemeral"}}]);
    }
    if !wire_tools.is_empty() {
        value["tools"] = json!(wire_tools);
    }
    if !matches!(request.effort, Some(Effort::Off)) {
        value["output_config"] = json!({"effort":match request.effort.unwrap_or(Effort::High) { Effort::Minimal => "low", Effort::Max => "max", other => other.as_str() }});
    }
    if let Some(output) = &request.structured_output {
        value["output_config"]["format"] = json!({"type":"json_schema","schema":output.schema});
    }
    if compact.is_some()
        || request
            .context
            .messages
            .iter()
            .any(|m| matches!(m, Message::Compaction { .. }))
    {
        let mut edit = json!({"type":"compact_20260112","trigger":{"type":"input_tokens","value":if compact.is_some() { 50000 } else { 2000000 }}});
        if let Some(instructions) = compact {
            edit["pause_after_compaction"] = json!(true);
            if let Some(instructions) = instructions {
                edit["instructions"] = json!(instructions);
            }
        }
        value["context_management"] = json!({"edits":[edit]});
    }
    Ok(value)
}
fn input(content: &[Block]) -> Result<Value, ProviderError> {
    if let [Block::Text { text }] = content {
        return Ok(json!(text));
    }
    Ok(json!(content.iter().map(|block| match block { Block::Text { text } => Ok(json!({"type":"text","text":text})), Block::Image { data,mime_type } => Ok(json!({"type":"image","source":{"type":"base64","media_type":mime_type,"data":data}})), _ => Err(invalid("Only text and images may appear in an Anthropic input message.")) }).collect::<Result<Vec<_>,_>>()?))
}
fn invalid(message: &str) -> ProviderError {
    ProviderError::new(ErrorKind::Unclassified, message)
}
