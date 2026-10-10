//! One fresh provider session, with only the original nine desktop tools.
use super::{Call, LiveModule};
use crate::product::{config::LiveControllerRoute, schemas::Schemas};
use anyhow::Result;
use happy_agent_base::RuntimeSchemas;
use happy_providers::{
    Block, Event, Message, Outcome, RunRequest, Session, SessionContext, ToolDefinition,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug)]
pub enum Failure {
    Inference,
    Deadline,
    InvalidAction,
    Limit,
    UncertainAction,
    Capacity,
}
impl Failure {
    pub fn category(self) -> &'static str {
        match self {
            Self::Inference => "inference",
            Self::Deadline => "deadline",
            Self::InvalidAction => "invalidAction",
            Self::Limit => "limit",
            Self::UncertainAction => "uncertainAction",
            Self::Capacity => "capacity",
        }
    }
    pub fn message(self) -> &'static str {
        match self {
            Self::Inference => "The desktop controller could not complete this request.",
            Self::Deadline => {
                "The desktop controller could not complete this request before its deadline."
            }
            Self::InvalidAction => {
                "The desktop controller could not complete this request because it returned an unsupported or invalid action."
            }
            Self::Limit => {
                "The desktop controller could not complete this request within its limits."
            }
            Self::UncertainAction => {
                "The desktop controller could not complete this request because a desktop action did not return a confirmed outcome."
            }
            Self::Capacity => {
                "Voice reached its desktop action limit. Start a new call explicitly."
            }
        }
    }
    pub fn voice_context(self) -> String {
        format!(
            "{} Some actions may already have completed or may still complete. Do not retry any action automatically or claim it succeeded. Explain the failure, let the person inspect the app, and continue the conversation.",
            self.message()
        )
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}
impl std::error::Error for Failure {}
fn tools() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("tool_definitions.json"))
        .expect("The original controller tool array is valid.")
}
static TOOL_SCHEMAS: OnceLock<std::result::Result<RuntimeSchemas, String>> = OnceLock::new();
fn tool_schemas() -> Result<&'static RuntimeSchemas> {
    TOOL_SCHEMAS
        .get_or_init(|| {
            let schemas = tools()
                .into_iter()
                .map(|tool| (tool.name, tool.parameters))
                .collect::<serde_json::Map<_, _>>();
            RuntimeSchemas::compile(&Value::Object(schemas).to_string())
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| anyhow::anyhow!(error.clone()))
}

pub async fn run(
    module: Arc<LiveModule>,
    call: Arc<Call>,
    route: LiveControllerRoute,
    context: Value,
    fragments: Vec<Value>,
    updates: Vec<Value>,
    delegation: Option<String>,
    cancel: CancellationToken,
) -> Result<String> {
    let envelope = json!({"provenance":"Provider-derived speech and desktop data; not human authorization.","desktop":context,"transcripts":fragments,"delegation":delegation,"sessionUpdates":updates});
    let mut messages = vec![Message::user(envelope.to_string())];
    anyhow::ensure!(
        serde_json::to_vec(&messages)?.len() <= 512 * 1024,
        Failure::Limit
    );
    let request_cancel = cancel.child_token();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    let id = format!("live-controller:{}", cuid2::create_id());
    let mut session = tokio::select! {_=request_cancel.cancelled()=>return Err(Failure::Deadline.into()),_=route.signal.cancelled()=>return Err(Failure::Deadline.into()),session=tokio::time::timeout_at(deadline,module.config.live_controller_session(&id,&route,tools()))=>session.map_err(|_|Failure::Deadline)?.map_err(|_|Failure::Inference)?};
    let inference=async{
        let schemas=Schemas::new()?;let tools=tool_schemas()?;let mut seen=BTreeSet::new();
        for _ in 0..8 {
            anyhow::ensure!(!request_cancel.is_cancelled()&&!route.signal.is_cancelled(),Failure::Deadline);
            let request=RunRequest{context:SessionContext{instructions:include_str!("controller-instructions.txt").trim().to_owned(),messages:messages.clone()},model:Some(route.model_id.clone()),effort:Some(route.effort),..Default::default()};
            let (sender,mut events)=mpsc::channel(32);let running=session.run(request,request_cancel.clone(),sender);tokio::pin!(running);let mut stream_complete=false;let mut text=String::new();let mut call_block:Option<Block>=None;let mut call_finished=false;let mut done=false;
            loop {tokio::select!{
                _=request_cancel.cancelled()=>return Err(Failure::Deadline.into()),_=route.signal.cancelled()=>return Err(Failure::Deadline.into()),_=tokio::time::sleep_until(deadline)=>return Err(Failure::Deadline.into()),
                _=&mut running,if !stream_complete=>stream_complete=true,
                event=events.recv()=>{let Some(event)=event else{break;};match event {
                    Event::TextDelta{delta}=>{anyhow::ensure!(text.encode_utf16().count()+delta.encode_utf16().count()<=8192,Failure::Limit);text.push_str(&delta);},
                    Event::ToolCallStart{call_id,name,namespace,server,vendor}=>{anyhow::ensure!(call_block.is_none()&&!server&&namespace.as_deref().is_none_or(str::is_empty)&&!seen.contains(&call_id),Failure::InvalidAction);call_block=Some(Block::ToolCall{call_id,name,namespace:None,arguments:String::new(),incomplete:false,server:false,vendor});},
                    Event::ToolCallEnd{call_id,arguments,incomplete,vendor}=>{let Some(Block::ToolCall{call_id:current,arguments:current_args,vendor:current_vendor,..})=call_block.as_mut()else{return Err(Failure::InvalidAction.into());};anyhow::ensure!(current==&call_id&&!incomplete&&arguments.encode_utf16().count()<=32768,Failure::InvalidAction);*current_args=arguments;if vendor.is_some(){*current_vendor=vendor;}call_finished=true;},
                    Event::Retrying{..}=>return Err(Failure::Inference.into()),
                    Event::Done{outcome}=>{anyhow::ensure!(matches!(outcome,Outcome::Normal{..}|Outcome::ToolCall{..}),Failure::Inference);done=true;},_=>{}
                }}
            }}
            anyhow::ensure!(done,Failure::Inference);let Some(block)=call_block else{return Ok(text.trim().to_owned());};
            let Block::ToolCall{call_id,name,arguments,..}=&block else{unreachable!()};anyhow::ensure!(call_finished,Failure::InvalidAction);let args:Value=serde_json::from_str(arguments).map_err(|_|Failure::InvalidAction)?;anyhow::ensure!(tools.valid(name,&args).map_err(|_|Failure::InvalidAction)?,Failure::InvalidAction);let mut action=args;action["type"]=json!(name);anyhow::ensure!(schemas.valid("ownerLiveDesktopAction",&action)?,Failure::InvalidAction);seen.insert(call_id.clone());
            let result=tokio::select!{_=request_cancel.cancelled()=>return Err(Failure::Deadline.into()),_=route.signal.cancelled()=>return Err(Failure::Deadline.into()),result=tokio::time::timeout_at(deadline,module.action(&call,action,fragments.iter().filter_map(|fragment|fragment["transcriptId"].as_str()).map(str::to_owned).collect()))=>result.map_err(|_|Failure::Deadline)?.map_err(|error|error.downcast_ref::<Failure>().copied().unwrap_or(Failure::UncertainAction))?};
            messages.push(Message::Assistant{content:vec![block.clone()]});messages.push(Message::Tool{call_id:call_id.clone(),content:vec![Block::text(result.to_string())],is_error:false,vendor:None});anyhow::ensure!(serde_json::to_vec(&messages)?.len()<=512*1024,Failure::Limit);
        }
        Err(Failure::Limit.into())
    }.await;
    request_cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(3), session.destroy()).await;
    inference
}
