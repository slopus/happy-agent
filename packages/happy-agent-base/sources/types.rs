use happy_providers::{Block, Event, Message, ProviderConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    ReadOnly,
    #[default]
    WorkspaceWrite,
    Auto,
    FullAccess,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    pub id: String,
    pub instructions: String,
    pub provider: ProviderConfig,
    #[serde(default)]
    pub permission_mode: PermissionMode,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryOptions {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub id: String,
    pub created: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: String,
    pub message: Message,
    pub options: DeliveryOptions,
    pub steering: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum Stage {
    Idle,
    Inference {
        #[serde(rename = "inferenceId")]
        inference_id: String,
        #[serde(rename = "completedBlocks")]
        completed_blocks: Vec<Block>,
        #[serde(rename = "acceptSend")]
        accept_send: bool,
        prepared: bool,
    },
    Tools {
        calls: Vec<PendingCall>,
    },
    Compaction {
        instructions: Option<String>,
    },
    Settlement {
        #[serde(rename = "settlementId")]
        settlement_id: String,
    },
}
impl Stage {
    pub fn active(&self) -> bool {
        !matches!(self, Self::Idle)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCall {
    pub id: String,
    pub provider_call_id: String,
    pub name: String,
    pub namespace: Option<String>,
    pub arguments: String,
    pub incomplete: bool,
    pub dispatched: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    MessageAccepted {
        #[serde(rename = "agentId")]
        agent_id: String,
        delivery: QueuedMessage,
    },
    Provider {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "inferenceId")]
        inference_id: String,
        event: Event,
    },
    ToolStarted {
        #[serde(rename = "agentId")]
        agent_id: String,
        call: PendingCall,
    },
    ToolCompleted {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "callId")]
        call_id: String,
        message: Message,
    },
    Compacted {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "replacedIds")]
        replaced_ids: Vec<String>,
        usage: happy_providers::Usage,
    },
    Settled {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "settlementId")]
        settlement_id: String,
        aborted: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub config: AgentConfig,
    pub stage: Stage,
    pub profile: Option<String>,
    pub history: Vec<(String, Message)>,
}
pub(crate) fn identity() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
