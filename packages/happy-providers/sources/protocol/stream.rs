use crate::{ErrorKind, Event, Outcome, ProviderError, Usage};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const MAX_FRAME: usize = 8 * 1024 * 1024;

fn hosted_events(protocol: &str, item: Value) -> Vec<Event> {
    let call_id = item["call_id"]
        .as_str()
        .or_else(|| item["tool_use_id"].as_str())
        .or_else(|| item["id"].as_str())
        .unwrap_or("hosted-output")
        .to_owned();
    let vendor = Some(json!({"protocol":protocol,"item":item}));
    let kind = string(&item, "type");
    if kind.ends_with("_call") || kind == "server_tool_use" {
        let name = item["name"].as_str().unwrap_or(kind).to_owned();
        let arguments = item["input"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                item.get("input")
                    .or_else(|| item.get("action"))
                    .unwrap_or(&json!({}))
                    .to_string()
            });
        let mut events = vec![
            Event::ToolCallStart {
                call_id: call_id.clone(),
                name,
                namespace: None,
                server: true,
                vendor: vendor.clone(),
            },
            Event::ToolCallEnd {
                call_id: call_id.clone(),
                arguments,
                incomplete: item["status"] == "incomplete",
                vendor,
            },
        ];
        if kind != "server_tool_use" {
            events.push(Event::ToolCallResultStart {
                call_id: call_id.clone(),
                vendor: None,
            });
            events.push(Event::ToolCallResultEnd {
                call_id,
                content: Vec::new(),
                is_error: false,
                incomplete: false,
            });
        }
        events
    } else {
        vec![
            Event::ToolCallResultStart {
                call_id: call_id.clone(),
                vendor,
            },
            Event::ToolCallResultEnd {
                call_id,
                content: Vec::new(),
                is_error: false,
                incomplete: false,
            },
        ]
    }
}

/// Bytes remain bytes until a whole SSE record exists, including split UTF-8.
#[derive(Default)]
pub(crate) struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
}
impl SseDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, ProviderError> {
        let mut output = Vec::new();
        for &byte in bytes {
            if byte != b'\n' {
                self.line.push(byte);
                if self.line.len() + self.data.len() > MAX_FRAME {
                    return Err(invalid("The provider sent an oversized stream record."));
                }
                continue;
            }
            if self.line.last() == Some(&b'\r') {
                self.line.pop();
            }
            if self.line.is_empty() {
                if !self.data.is_empty() {
                    if self.data.last() == Some(&b'\n') {
                        self.data.pop();
                    }
                    if self.data == b"[DONE]" {
                        output.push(json!({"type":"stream.done"}));
                    } else {
                        output.push(serde_json::from_slice(&self.data).map_err(|_| {
                            invalid("The provider sent invalid JSON in its stream.")
                        })?);
                    }
                    self.data.clear();
                }
            } else if self.line.starts_with(b"data:") {
                let value = &self.line[5..];
                self.data
                    .extend_from_slice(value.strip_prefix(b" ").unwrap_or(value));
                self.data.push(b'\n');
            }
            self.line.clear();
        }
        Ok(output)
    }
}

/// Bedrock Runtime uses AWS event-stream framing rather than SSE.
#[derive(Default)]
pub(crate) struct BedrockDecoder {
    bytes: Vec<u8>,
}
impl BedrockDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, ProviderError> {
        use base64::Engine;
        self.bytes.extend_from_slice(chunk);
        let mut output = Vec::new();
        while self.bytes.len() >= 12 {
            let total = u32::from_be_bytes(
                self.bytes[..4]
                    .try_into()
                    .map_err(|_| invalid("Invalid Bedrock frame."))?,
            ) as usize;
            let headers = u32::from_be_bytes(
                self.bytes[4..8]
                    .try_into()
                    .map_err(|_| invalid("Invalid Bedrock frame."))?,
            ) as usize;
            if !(16..=MAX_FRAME).contains(&total) || headers > total - 16 {
                return Err(invalid(
                    "The provider sent an invalid Bedrock frame length.",
                ));
            }
            if crc32fast::hash(&self.bytes[..8])
                != u32::from_be_bytes(
                    self.bytes[8..12]
                        .try_into()
                        .map_err(|_| invalid("Invalid Bedrock checksum."))?,
                )
            {
                return Err(invalid("The Bedrock stream prelude checksum failed."));
            }
            if self.bytes.len() < total {
                break;
            }
            if crc32fast::hash(&self.bytes[..total - 4])
                != u32::from_be_bytes(
                    self.bytes[total - 4..total]
                        .try_into()
                        .map_err(|_| invalid("Invalid Bedrock checksum."))?,
                )
            {
                return Err(invalid("The Bedrock stream checksum failed."));
            }
            let payload = &self.bytes[12 + headers..total - 4];
            let value: Value = serde_json::from_slice(payload)
                .map_err(|_| invalid("The Bedrock stream payload was invalid."))?;
            if let Some(encoded) = value["bytes"].as_str() {
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| invalid("The Bedrock stream payload encoding was invalid."))?;
                output.push(
                    serde_json::from_slice(&decoded)
                        .map_err(|_| invalid("The Bedrock stream event was invalid."))?,
                );
            } else {
                // Exception frames carry structured JSON instead of a bytes envelope.
                return Err(ProviderError::response(
                    500,
                    &reqwest::header::HeaderMap::new(),
                    payload,
                ));
            }
            self.bytes.drain(..total);
        }
        if self.bytes.len() > MAX_FRAME {
            return Err(invalid("The Bedrock stream buffer exceeded its limit."));
        }
        Ok(output)
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Protocol {
    Responses,
    Anthropic,
    Chat,
}
#[derive(Default)]
struct Call {
    id: String,
    name: String,
    arguments: String,
    started: bool,
}
pub(crate) struct Mapper {
    protocol: Protocol,
    calls: BTreeMap<String, Call>,
    anthropic_blocks: BTreeMap<u64, Value>,
    signature: String,
    usage: Usage,
    finish: Option<String>,
    pub outcome: Option<Outcome>,
    pub response: Option<Value>,
    pub compact_block: Option<Value>,
    pub saw_content: bool,
    text_open: bool,
    reasoning_open: bool,
    server_x_search: bool,
    hosted_items: BTreeSet<String>,
    opaque_items: Vec<Value>,
}
impl Mapper {
    pub fn new(protocol: Protocol, tools: &[crate::ToolDefinition]) -> Self {
        Self {
            protocol,
            calls: BTreeMap::new(),
            anthropic_blocks: BTreeMap::new(),
            signature: String::new(),
            usage: Usage::default(),
            finish: None,
            outcome: None,
            response: None,
            compact_block: None,
            saw_content: false,
            text_open: false,
            reasoning_open: false,
            server_x_search: tools.iter().any(|tool| {
                tool.server
                    .as_ref()
                    .is_some_and(|server| server["type"] == "x_search")
            }),
            hosted_items: BTreeSet::new(),
            opaque_items: Vec::new(),
        }
    }
    pub fn consume(&mut self, value: Value) -> Result<Vec<Event>, ProviderError> {
        if self.outcome.is_some() {
            return Ok(Vec::new());
        }
        match self.protocol {
            Protocol::Responses => self.responses(value),
            Protocol::Anthropic => self.anthropic(value),
            Protocol::Chat => self.chat(value),
        }
    }
    fn responses(&mut self, value: Value) -> Result<Vec<Event>, ProviderError> {
        let mut events = Vec::new();
        let item = &value["item"];
        let hosted = self.server_x_search
            && item["type"] == "custom_tool_call"
            && string(item, "call_id").starts_with("xs_call-");
        if value["type"] == "response.output_item.added" && hosted {
            self.hosted_items.insert(string(item, "id").to_owned());
            self.saw_content = true;
            return Ok(events);
        }
        if value["type"] == "response.custom_tool_call_input.delta"
            && self.hosted_items.contains(string(&value, "item_id"))
        {
            return Ok(events);
        }
        if value["type"] == "response.output_item.done" && hosted {
            self.opaque_items.push(item.clone());
            return Ok(events);
        }
        match string(&value, "type") {
            "response.output_item.added" => {
                let item = &value["item"];
                match string(item, "type") {
                    "function_call" | "custom_tool_call" => {
                        let id = string(item, "call_id").to_owned();
                        let key = string(item, "id").to_owned();
                        let name = string(item, "name").to_owned();
                        if id.is_empty() || name.is_empty() {
                            return Err(invalid(
                                "The provider returned a tool call without its identity or name.",
                            ));
                        }
                        self.calls.insert(
                            key,
                            Call {
                                id: id.clone(),
                                name: name.clone(),
                                arguments: String::new(),
                                started: true,
                            },
                        );
                        events.push(Event::ToolCallStart {
                            call_id: id,
                            name,
                            namespace: item["namespace"].as_str().map(str::to_owned),
                            server: false,
                            vendor: None,
                        });
                        self.saw_content = true;
                    }
                    "reasoning" => {
                        self.reasoning_open = true;
                        events.push(Event::ReasoningStart);
                    }
                    _ => {}
                }
            }
            "response.content_part.added" if value["part"]["type"] == "output_text" => {
                self.text_open = true;
                events.push(Event::TextStart);
                self.saw_content = true;
            }
            "response.output_text.delta" => {
                if !self.text_open {
                    self.text_open = true;
                    events.push(Event::TextStart);
                }
                events.push(Event::TextDelta {
                    delta: string(&value, "delta").to_owned(),
                });
                self.saw_content = true;
            }
            "response.output_text.done" => {
                if self.text_open {
                    events.push(Event::TextEnd);
                    self.text_open = false;
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if !self.reasoning_open {
                    events.push(Event::ReasoningStart);
                    self.reasoning_open = true;
                }
                events.push(Event::ReasoningDelta {
                    delta: string(&value, "delta").to_owned(),
                });
                self.saw_content = true;
            }
            "response.function_call_arguments.delta" | "response.custom_tool_call_input.delta" => {
                let key = string(&value, "item_id");
                let call = self.calls.get_mut(key).ok_or_else(|| {
                    invalid("The provider streamed arguments for an unknown tool call.")
                })?;
                let delta = string(&value, "delta");
                call.arguments.push_str(delta);
                if call.arguments.len() > MAX_FRAME {
                    return Err(invalid("The provider returned oversized tool arguments."));
                }
                events.push(Event::ToolCallDelta {
                    call_id: call.id.clone(),
                    delta: delta.to_owned(),
                });
            }
            "response.output_item.done" => {
                let item = &value["item"];
                match string(item, "type") {
                    "function_call" | "custom_tool_call" => {
                        let call = self.calls.get_mut(string(item, "id")).ok_or_else(|| {
                            invalid("The provider completed an unknown tool call.")
                        })?;
                        let field = if item["type"] == "custom_tool_call" {
                            "input"
                        } else {
                            "arguments"
                        };
                        let arguments = item[field].as_str().unwrap_or(&call.arguments).to_owned();
                        call.arguments = arguments.clone();
                        events.push(Event::ToolCallEnd {
                            call_id: call.id.clone(),
                            arguments,
                            incomplete: item["status"] == "incomplete",
                            vendor: Some(json!({"provider":"responses","type":item["type"]})),
                        });
                    }
                    "reasoning" => {
                        if !self.reasoning_open {
                            events.push(Event::ReasoningStart);
                        }
                        events.push(Event::ReasoningEnd {
                            reasoning: Some(
                                serde_json::to_string(item).map_err(|_| {
                                    invalid("Reasoning state could not be encoded.")
                                })?,
                            ),
                        });
                        self.reasoning_open = false;
                        self.saw_content = true;
                    }
                    "message" => {}
                    "compaction" => {
                        self.compact_block = Some(item.clone());
                        self.saw_content = true;
                    }
                    _ => {
                        self.opaque_items.push(item.clone());
                        self.saw_content = true;
                    }
                }
            }
            "response.completed" | "response.incomplete" => {
                let response = &value["response"];
                self.usage = response_usage(&response["usage"]);
                if self.text_open {
                    events.push(Event::TextEnd);
                    self.text_open = false;
                }
                if self.reasoning_open {
                    events.push(Event::ReasoningEnd { reasoning: None });
                    self.reasoning_open = false;
                }
                let length = value["type"] == "response.incomplete";
                if length && response["incomplete_details"]["reason"] != "max_output_tokens" {
                    return Err(ProviderError::transport(
                        "The provider did not finish its response.",
                    ));
                }
                self.response = Some(response.clone());
                // The terminal snapshot may enrich hosted output after output_item.done.
                for item in response["output"].as_array().into_iter().flatten() {
                    if matches!(
                        item["type"].as_str(),
                        Some("message" | "reasoning" | "function_call" | "compaction")
                    ) || (item["type"] == "custom_tool_call"
                        && !self.hosted_items.contains(string(item, "id")))
                    {
                        continue;
                    }
                    if let Some(previous) = self
                        .opaque_items
                        .iter_mut()
                        .find(|previous| previous["id"] == item["id"])
                    {
                        *previous = item.clone();
                    } else {
                        self.opaque_items.push(item.clone());
                    }
                }
                for item in self.opaque_items.drain(..) {
                    events.extend(hosted_events("responses", item));
                }
                self.outcome = Some(if length {
                    Outcome::Length { usage: self.usage }
                } else if !self.calls.is_empty() {
                    Outcome::ToolCall { usage: self.usage }
                } else {
                    Outcome::Normal { usage: self.usage }
                });
                events.push(Event::TokenUsage { usage: self.usage });
            }
            "response.failed" | "error" => {
                let source = if value["type"] == "response.failed" {
                    &value["response"]
                } else {
                    &value
                };
                return Err(ProviderError::response(
                    source["status"].as_u64().unwrap_or(400) as u16,
                    &reqwest::header::HeaderMap::new(),
                    &serde_json::to_vec(source).unwrap_or_default(),
                ));
            }
            _ => {}
        }
        Ok(events)
    }
    fn anthropic(&mut self, value: Value) -> Result<Vec<Event>, ProviderError> {
        let mut events = Vec::new();
        let index = value["index"].as_u64().unwrap_or(0);
        match string(&value, "type") {
            "message_start" => {
                self.usage = anthropic_usage(&value["message"]["usage"]);
            }
            "content_block_start" => {
                let block = value["content_block"].clone();
                match string(&block, "type") {
                    "text" => {
                        events.push(Event::TextStart);
                        if let Some(text) = block["text"].as_str().filter(|s| !s.is_empty()) {
                            events.push(Event::TextDelta {
                                delta: text.to_owned(),
                            });
                        }
                        self.saw_content = true;
                    }
                    "thinking" => {
                        self.signature.clear();
                        events.push(Event::ReasoningStart);
                        self.saw_content = true;
                    }
                    "redacted_thinking" => {
                        events.push(Event::ReasoningStart);
                        events.push(Event::ReasoningEnd {
                            reasoning: block["data"].as_str().map(str::to_owned),
                        });
                        self.saw_content = true;
                    }
                    "tool_use" => {
                        let id = string(&block, "id").to_owned();
                        let name = string(&block, "name").to_owned();
                        self.calls.insert(
                            index.to_string(),
                            Call {
                                id: id.clone(),
                                name: name.clone(),
                                arguments: String::new(),
                                started: true,
                            },
                        );
                        events.push(Event::ToolCallStart {
                            call_id: id,
                            name,
                            namespace: None,
                            server: false,
                            vendor: None,
                        });
                        self.saw_content = true;
                    }
                    _ => {}
                }
                self.anthropic_blocks.insert(index, block);
            }
            "content_block_delta" => {
                let delta = &value["delta"];
                match string(delta, "type") {
                    "text_delta" => events.push(Event::TextDelta {
                        delta: string(delta, "text").to_owned(),
                    }),
                    "thinking_delta" => events.push(Event::ReasoningDelta {
                        delta: string(delta, "thinking").to_owned(),
                    }),
                    "signature_delta" => self.signature.push_str(string(delta, "signature")),
                    "input_json_delta" => {
                        let call = self.calls.get_mut(&index.to_string()).ok_or_else(|| {
                            invalid("The provider streamed an unknown tool call.")
                        })?;
                        let part = string(delta, "partial_json");
                        call.arguments.push_str(part);
                        events.push(Event::ToolCallDelta {
                            call_id: call.id.clone(),
                            delta: part.to_owned(),
                        });
                    }
                    "compaction_delta" => {
                        if let Some(block) = self.anthropic_blocks.get_mut(&index) {
                            let text =
                                string(block, "content").to_owned() + string(delta, "content");
                            block["content"] = json!(text);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let block = self
                    .anthropic_blocks
                    .remove(&index)
                    .ok_or_else(|| invalid("The provider ended an unknown content block."))?;
                match string(&block, "type") {
                    "text" => events.push(Event::TextEnd),
                    "thinking" => events.push(Event::ReasoningEnd {
                        reasoning: Some(self.signature.clone()),
                    }),
                    "tool_use" => {
                        let call = self
                            .calls
                            .get(&index.to_string())
                            .ok_or_else(|| invalid("The provider ended an unknown tool call."))?;
                        events.push(Event::ToolCallEnd {
                            call_id: call.id.clone(),
                            arguments: if call.arguments.is_empty() {
                                serde_json::to_string(&block["input"])
                                    .unwrap_or_else(|_| "{}".to_owned())
                            } else {
                                call.arguments.clone()
                            },
                            incomplete: false,
                            vendor: None,
                        });
                    }
                    "compaction" => {
                        self.compact_block = Some(block);
                        self.saw_content = true;
                    }
                    "redacted_thinking" => {}
                    _ => {
                        events.extend(hosted_events("anthropic", block));
                        self.saw_content = true;
                    }
                }
            }
            "message_delta" => {
                self.finish = value["delta"]["stop_reason"].as_str().map(str::to_owned);
                self.usage.output = value["usage"]["output_tokens"]
                    .as_u64()
                    .unwrap_or(self.usage.output);
                self.usage.total_tokens = self.usage.input + self.usage.output;
            }
            "message_stop" => {
                if !self.anthropic_blocks.is_empty() {
                    return Err(invalid(
                        "The provider ended a response with unfinished content blocks.",
                    ));
                }
                self.outcome = Some(match self.finish.as_deref() {
                    Some("tool_use") => Outcome::ToolCall { usage: self.usage },
                    Some("max_tokens") => Outcome::Length { usage: self.usage },
                    Some("end_turn" | "stop_sequence" | "pause_turn" | "compaction") => {
                        Outcome::Normal { usage: self.usage }
                    }
                    _ => {
                        return Err(invalid(
                            "The provider response omitted its completion reason.",
                        ));
                    }
                });
                events.push(Event::TokenUsage { usage: self.usage });
            }
            "error" => {
                return Err(ProviderError::response(
                    if value["error"]["type"] == "overloaded_error" {
                        529
                    } else {
                        400
                    },
                    &reqwest::header::HeaderMap::new(),
                    &serde_json::to_vec(&value).unwrap_or_default(),
                ));
            }
            _ => {}
        }
        Ok(events)
    }
    fn chat(&mut self, value: Value) -> Result<Vec<Event>, ProviderError> {
        let mut events = Vec::new();
        if value["type"] == "stream.done" {
            for call in self.calls.values_mut() {
                if !call.started || call.id.is_empty() || call.name.is_empty() {
                    return Err(invalid(
                        "The provider returned an incomplete tool identity.",
                    ));
                }
                events.push(Event::ToolCallEnd {
                    call_id: call.id.clone(),
                    arguments: call.arguments.clone(),
                    incomplete: false,
                    vendor: None,
                });
            }
            if self.text_open {
                events.push(Event::TextEnd);
            }
            if self.reasoning_open {
                events.push(Event::ReasoningEnd { reasoning: None });
            }
            self.outcome = Some(match self.finish.as_deref() {
                Some("tool_calls") => Outcome::ToolCall { usage: self.usage },
                Some("length") => Outcome::Length { usage: self.usage },
                Some("stop") => Outcome::Normal { usage: self.usage },
                _ => {
                    return Err(invalid(
                        "The provider stream ended before its completion reason.",
                    ));
                }
            });
            events.push(Event::TokenUsage { usage: self.usage });
            return Ok(events);
        }
        if value.get("error").is_some() {
            return Err(ProviderError::response(
                400,
                &reqwest::header::HeaderMap::new(),
                &serde_json::to_vec(&value).unwrap_or_default(),
            ));
        }
        if value.get("usage").is_some_and(|v| !v.is_null()) {
            self.usage = chat_usage(&value["usage"]);
        }
        if let Some(choices) = value["choices"].as_array() {
            for choice in choices {
                if choice["index"].as_u64().unwrap_or(0) != 0 {
                    continue;
                }
                if let Some(reason) = choice["finish_reason"].as_str() {
                    self.finish = Some(reason.to_owned());
                }
                let delta = &choice["delta"];
                if let Some(text) = delta["reasoning_content"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                {
                    if !self.reasoning_open {
                        events.push(Event::ReasoningStart);
                        self.reasoning_open = true;
                    }
                    events.push(Event::ReasoningDelta {
                        delta: text.to_owned(),
                    });
                    self.saw_content = true;
                }
                if let Some(text) = delta["content"].as_str().filter(|s| !s.is_empty()) {
                    if self.reasoning_open {
                        events.push(Event::ReasoningEnd { reasoning: None });
                        self.reasoning_open = false;
                    }
                    if !self.text_open {
                        events.push(Event::TextStart);
                        self.text_open = true;
                    }
                    events.push(Event::TextDelta {
                        delta: text.to_owned(),
                    });
                    self.saw_content = true;
                }
                if let Some(calls) = delta["tool_calls"].as_array() {
                    for item in calls {
                        let key = item["index"]
                            .as_u64()
                            .ok_or_else(|| invalid("The provider omitted a tool call index."))?
                            .to_string();
                        let call = self.calls.entry(key).or_default();
                        if let Some(id) = item["id"].as_str() {
                            call.id.push_str(id);
                        }
                        if let Some(name) = item["function"]["name"].as_str() {
                            call.name.push_str(name);
                        }
                        if !call.started && !call.id.is_empty() && !call.name.is_empty() {
                            call.started = true;
                            events.push(Event::ToolCallStart {
                                call_id: call.id.clone(),
                                name: call.name.clone(),
                                namespace: None,
                                server: false,
                                vendor: None,
                            });
                        }
                        if let Some(arguments) = item["function"]["arguments"].as_str() {
                            call.arguments.push_str(arguments);
                            if call.started {
                                events.push(Event::ToolCallDelta {
                                    call_id: call.id.clone(),
                                    delta: arguments.to_owned(),
                                });
                            }
                        }
                        self.saw_content = true;
                    }
                }
            }
        }
        Ok(events)
    }
}
pub(crate) fn response_usage(value: &Value) -> Usage {
    let input = value["input_tokens"].as_u64().unwrap_or(0);
    let output = value["output_tokens"].as_u64().unwrap_or(0);
    Usage {
        input,
        output,
        cache_read: value["input_tokens_details"]["cached_tokens"]
            .as_u64()
            .unwrap_or(0),
        cache_write: 0,
        total_tokens: input + output,
    }
}
fn chat_usage(value: &Value) -> Usage {
    let input = value["prompt_tokens"].as_u64().unwrap_or(0);
    let output = value["completion_tokens"].as_u64().unwrap_or(0);
    Usage {
        input,
        output,
        cache_read: value["prompt_tokens_details"]["cached_tokens"]
            .as_u64()
            .unwrap_or(0),
        cache_write: 0,
        total_tokens: input + output,
    }
}
fn anthropic_usage(value: &Value) -> Usage {
    let cache_read = value["cache_read_input_tokens"].as_u64().unwrap_or(0);
    let cache_write = value["cache_creation_input_tokens"].as_u64().unwrap_or(0);
    let input = value["input_tokens"].as_u64().unwrap_or(0) + cache_read + cache_write;
    let output = value["output_tokens"].as_u64().unwrap_or(0);
    Usage {
        input,
        output,
        cache_read,
        cache_write,
        total_tokens: input + output,
    }
}
fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn invalid(message: &str) -> ProviderError {
    ProviderError::new(ErrorKind::Unclassified, message)
}
