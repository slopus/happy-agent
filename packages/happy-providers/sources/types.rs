use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text {
        text: String,
    },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    Reasoning {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning: Option<String>,
    },
    ToolCall {
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
        arguments: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        incomplete: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vendor: Option<Value>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        server: bool,
    },
    ToolCallRequest {
        name: String,
        #[serde(default)]
        arguments: serde_json::Map<String, Value>,
    },
    ToolResult {
        #[serde(rename = "callId")]
        call_id: String,
        content: Vec<Block>,
        #[serde(
            default,
            rename = "isError",
            skip_serializing_if = "std::ops::Not::not"
        )]
        is_error: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        incomplete: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vendor: Option<Value>,
    },
}
impl Block {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Message {
    User {
        content: Vec<Block>,
    },
    System {
        content: Vec<Block>,
    },
    Agent {
        author: AgentAuthor,
        content: Vec<Block>,
    },
    Assistant {
        content: Vec<Block>,
    },
    Tool {
        #[serde(rename = "callId")]
        call_id: String,
        content: Vec<Block>,
        #[serde(
            default,
            rename = "isError",
            skip_serializing_if = "std::ops::Not::not"
        )]
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vendor: Option<Value>,
    },
    Compaction {
        content: Option<String>,
        #[serde(rename = "encryptedContent")]
        encrypted_content: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vendor: Option<Value>,
    },
}
impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Self::User {
            content: vec![Block::text(text)],
        }
    }
    pub fn content(&self) -> &[Block] {
        match self {
            Self::User { content }
            | Self::System { content }
            | Self::Agent { content, .. }
            | Self::Assistant { content }
            | Self::Tool { content, .. } => content,
            Self::Compaction { .. } => &[],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentAuthor {
    pub id: String,
    pub description: String,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionContext {
    pub instructions: String,
    pub messages: Vec<Message>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolDefinition {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default = "empty_parameters")]
    pub parameters: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grammar: Option<Value>,
    #[serde(default)]
    pub defer: bool,
}
fn empty_parameters() -> Value {
    serde_json::json!({"type":"object","properties":{}})
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    pub context: SessionContext,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<Effort>,
    #[serde(default)]
    pub service_tier: Option<String>,
    #[serde(default)]
    pub structured_output: Option<StructuredOutput>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}
impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "xhigh",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StructuredOutput {
    pub name: String,
    pub schema: Value,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    BlockStart,
    BlockStop,
    BlockReset,
    TextStart,
    TextDelta {
        delta: String,
    },
    TextEnd,
    ReasoningStart,
    ReasoningDelta {
        delta: String,
    },
    ReasoningEnd {
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning: Option<String>,
    },
    #[serde(rename = "toolcall_start")]
    ToolCallStart {
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        server: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vendor: Option<Value>,
    },
    #[serde(rename = "toolcall_delta")]
    ToolCallDelta {
        #[serde(rename = "callId")]
        call_id: String,
        delta: String,
    },
    #[serde(rename = "toolcall_end")]
    ToolCallEnd {
        #[serde(rename = "callId")]
        call_id: String,
        arguments: String,
        #[serde(default)]
        incomplete: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        vendor: Option<Value>,
    },
    #[serde(rename = "toolcall_result_start")]
    ToolCallResultStart {
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vendor: Option<Value>,
    },
    #[serde(rename = "toolcall_result_delta")]
    ToolCallResultDelta {
        #[serde(rename = "callId")]
        call_id: String,
        delta: String,
    },
    #[serde(rename = "toolcall_result_end")]
    ToolCallResultEnd {
        #[serde(rename = "callId")]
        call_id: String,
        content: Vec<Block>,
        #[serde(default, rename = "isError")]
        is_error: bool,
        #[serde(default)]
        incomplete: bool,
    },
    Retrying {
        attempt: u32,
        reason: String,
    },
    TokenUsage {
        usage: Usage,
    },
    Done {
        #[serde(flatten)]
        outcome: Outcome,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Outcome {
    Normal { usage: Usage },
    ToolCall { usage: Usage },
    Length { usage: Usage },
    Cancelled,
    Error { error: crate::ProviderError },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Compaction {
    Completed {
        context: SessionContext,
        usage: Usage,
    },
    Cancelled {
        context: SessionContext,
    },
    Failed {
        error: crate::ProviderError,
    },
}

/// Borrowing a session mutably serializes inference and compaction at compile time.
#[async_trait]
pub trait Session: Send {
    async fn run(
        &mut self,
        request: RunRequest,
        cancel: CancellationToken,
        events: mpsc::Sender<Event>,
    );
    async fn compact(
        &mut self,
        context: SessionContext,
        instructions: Option<String>,
        cancel: CancellationToken,
    ) -> Compaction;
    async fn destroy(&mut self) {}
}

#[derive(Default)]
pub struct Accumulator {
    pub committed: Vec<Block>,
    pending: Vec<Block>,
    checkpoint: usize,
}
impl Accumulator {
    pub fn add(&mut self, event: &Event) {
        match event {
            Event::BlockStart => {
                self.checkpoint = self.committed.len();
                self.pending.clear();
            }
            Event::BlockReset => {
                self.pending.clear();
                self.committed.truncate(self.checkpoint);
            }
            Event::BlockStop => self.committed.append(&mut self.pending),
            Event::TextStart => self.pending.push(Block::text("")),
            Event::TextDelta { delta } => {
                if let Some(Block::Text { text }) = self.pending.last_mut() {
                    text.push_str(delta);
                }
            }
            Event::ReasoningStart => self.pending.push(Block::Reasoning {
                text: Some(String::new()),
                reasoning: None,
            }),
            Event::ReasoningDelta { delta } => {
                if let Some(Block::Reasoning {
                    text: Some(text), ..
                }) = self.pending.last_mut()
                {
                    text.push_str(delta);
                }
            }
            Event::ReasoningEnd { reasoning } => {
                if let Some(Block::Reasoning {
                    reasoning: stored, ..
                }) = self.pending.last_mut()
                {
                    *stored = reasoning.clone();
                }
            }
            Event::ToolCallStart {
                call_id,
                name,
                namespace,
                server,
                vendor,
            } => self.pending.push(Block::ToolCall {
                call_id: call_id.clone(),
                name: name.clone(),
                namespace: namespace.clone(),
                arguments: String::new(),
                incomplete: false,
                vendor: vendor.clone(),
                server: *server,
            }),
            Event::ToolCallDelta { call_id, delta } => {
                if let Some(Block::ToolCall { arguments, .. }) = self
                    .pending
                    .iter_mut()
                    .find(|b| matches!(b, Block::ToolCall { call_id: id, .. } if id == call_id))
                {
                    arguments.push_str(delta);
                }
            }
            Event::ToolCallEnd {
                call_id,
                arguments,
                incomplete,
                vendor,
            } => {
                if let Some(Block::ToolCall {
                    arguments: stored,
                    incomplete: flag,
                    vendor: native,
                    ..
                }) = self
                    .pending
                    .iter_mut()
                    .find(|b| matches!(b, Block::ToolCall { call_id: id, .. } if id == call_id))
                {
                    *stored = arguments.clone();
                    *flag = *incomplete;
                    *native = vendor.clone();
                }
            }
            Event::ToolCallResultStart { call_id, vendor } => {
                self.pending.push(Block::ToolResult {
                    call_id: call_id.clone(),
                    content: Vec::new(),
                    is_error: false,
                    incomplete: false,
                    vendor: vendor.clone(),
                })
            }
            Event::ToolCallResultEnd {
                call_id,
                content,
                is_error,
                incomplete,
            } => {
                if let Some(Block::ToolResult {
                    content: stored,
                    is_error: flag,
                    incomplete: pending,
                    ..
                }) = self.pending.iter_mut().find(
                    |block| matches!(block, Block::ToolResult { call_id: id, .. } if id==call_id),
                ) {
                    *stored = content.clone();
                    *flag = *is_error;
                    *pending = *incomplete;
                }
            }
            _ => {}
        }
    }
}
