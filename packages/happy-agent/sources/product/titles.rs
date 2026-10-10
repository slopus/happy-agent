//! Detached first-message naming and one provenance-preserving refinement.
use super::{
    agent_runtime::AgentRuntimeModule,
    config::ConfigModule,
    durable::DurableFunctionsModule,
    history::HistoryModule,
    lifecycle::LifecycleModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
    workspaces::WorkspacesModule,
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use happy_agent_base::{AcceptedInput, AgentModule, AgentScope};
use happy_providers::{Event, Message, Outcome, RunRequest, SessionContext};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;
mod hooks;
mod naming;

pub struct TitlesModule {
    config: Arc<ConfigModule>,
    _durable: Arc<DurableFunctionsModule>,
    runtime: Arc<RuntimeModule>,
    agents: Arc<AgentRuntimeModule>,
    history: Arc<HistoryModule>,
    workspaces: Arc<WorkspacesModule>,
    owner: Weak<Self>,
    tasks: Mutex<BTreeMap<String, tokio::task::JoinHandle<()>>>,
    lifetime: CancellationToken,
    slots: Semaphore,
    schemas: Schemas,
}
impl TitlesModule {
    #[expect(clippy::too_many_arguments)]
    pub fn new(
        config: Arc<ConfigModule>,
        durable: Arc<DurableFunctionsModule>,
        lifecycle: Arc<LifecycleModule>,
        runtime: Arc<RuntimeModule>,
        agents: Arc<AgentRuntimeModule>,
        history: Arc<HistoryModule>,
        workspaces: Arc<WorkspacesModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in [
            "ownerTitleWanted",
            "ownerTitleNameRequest",
            "ownerTitleRefineRequest",
            "ownerTitleUserMessageCount",
            "ownerTitleGeneratedRecord",
            "ownerTitleWorkspaceId",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        let module = Arc::new_cyclic(|owner| Self {
            config,
            _durable: durable,
            runtime,
            agents: agents.clone(),
            history,
            workspaces,
            owner: owner.clone(),
            tasks: Mutex::new(BTreeMap::new()),
            lifetime: lifecycle.shutdown.child_token(),
            slots: Semaphore::new(8),
            schemas,
        });
        agents.install(module.clone())?;
        Ok(module)
    }
    pub async fn suggest_names(
        &self,
        request: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        anyhow::ensure!(
            self.schemas.valid("ownerTitleNameRequest", request)?,
            "Naming request is invalid."
        );
        let message = request["firstMessage"].as_str().unwrap();
        let wanted = &request["wanted"];
        if message.trim().is_empty() || (wanted["title"] != true && wanted["slug"] != true) {
            return Ok(json!({}));
        }
        let Some(route) = self.route(request["providerId"].as_str())? else {
            return Ok(json!({}));
        };
        let (instructions, prompt) = naming::request(wanted, message);
        let answer = self.infer(&route, instructions, prompt, cancel).await?;
        Ok(naming::parse(&answer, wanted))
    }
    pub async fn suggest_bot_name(
        &self,
        message: &str,
        provider: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Option<String>> {
        if message.trim().is_empty() {
            return Ok(None);
        }
        let Some(route) = self.route(provider)? else {
            return Ok(None);
        };
        let (instructions, prompt) = naming::bot_request(message);
        let answer = self.infer(&route, instructions, prompt, cancel).await?;
        let names = naming::parse(&answer, &json!({"title":true}));
        Ok(names["title"].as_str().map(|name| {
            naming::prefix(
                &name
                    .split_whitespace()
                    .take(3)
                    .collect::<Vec<_>>()
                    .join(" "),
                40,
            )
            .trim_end()
            .to_owned()
        }))
    }
    pub async fn refine_chat(
        &self,
        request: &Value,
        cancel: &CancellationToken,
    ) -> Result<Option<String>> {
        anyhow::ensure!(
            self.schemas.valid("ownerTitleRefineRequest", request)?,
            "Title refinement request is invalid."
        );
        let transcript = request["transcript"].as_str().unwrap();
        if transcript.trim().is_empty() {
            return Ok(None);
        }
        let Some(route) = self.route(request["providerId"].as_str())? else {
            return Ok(None);
        };
        let (instructions, prompt) =
            naming::refine_request(transcript, request["currentTitle"].as_str());
        let answer = self.infer(&route, instructions, prompt, cancel).await?;
        Ok(naming::parse(&answer, &json!({"title":true}))["title"]
            .as_str()
            .map(str::to_owned))
    }
    fn route(&self, preferred: Option<&str>) -> Result<Option<Value>> {
        let models = self.config.naming_models()?;
        let provider = preferred
            .filter(|provider| models.iter().any(|model| model["providerId"] == *provider))
            .or_else(|| {
                models
                    .first()
                    .and_then(|model| model["providerId"].as_str())
            });
        let served = models
            .iter()
            .filter(|model| provider.is_none_or(|provider| model["providerId"] == provider))
            .collect::<Vec<_>>();
        let Some(model) = served
            .iter()
            .find(|model| {
                [
                    "anthropic/sonnet-5",
                    "openai/gpt-5.6-luna",
                    "xai/grok-composer-2.5-fast",
                ]
                .iter()
                .any(|id| model["id"] == *id)
            })
            .copied()
            .or_else(|| served.first().copied())
        else {
            return Ok(None);
        };
        let efforts = model["effortLevels"]
            .as_array()
            .context("The naming model has no effort catalog.")?;
        let effort = ["off", "minimal", "low", "medium"]
            .into_iter()
            .find(|effort| efforts.contains(&json!(effort)))
            .map(Value::from)
            .unwrap_or_else(|| model["defaultEffort"].clone());
        Ok(Some(
            json!({"provider":model["providerId"],"model":model["id"],"effort":effort}),
        ))
    }
    async fn infer(
        &self,
        route: &Value,
        instructions: String,
        prompt: String,
        cancel: &CancellationToken,
    ) -> Result<String> {
        let expires = tokio::time::Instant::now() + Duration::from_secs(10);
        let _slot = tokio::select! {_=self.lifetime.cancelled()=>anyhow::bail!("Naming was stopped."),_=cancel.cancelled()=>anyhow::bail!("Naming was cancelled."),permit=tokio::time::timeout_at(expires,self.slots.acquire())=>permit.context("Naming did not finish within ten seconds.")??};
        let request_cancel = self.lifetime.child_token();
        let session_id = format!("naming:{}", cuid2::create_id());
        let mut session = tokio::select! {_=cancel.cancelled()=>anyhow::bail!("Naming was cancelled."),_=request_cancel.cancelled()=>anyhow::bail!("Naming was stopped."),session=tokio::time::timeout_at(expires,self.config.naming_session(&session_id,route))=>session.context("Naming did not finish within ten seconds.")??};
        let request = RunRequest {
            context: SessionContext {
                instructions,
                messages: vec![Message::user(prompt)],
            },
            model: route["model"].as_str().map(str::to_owned),
            effort: Some(serde_json::from_value(route["effort"].clone())?),
            ..Default::default()
        };
        let answer=async {
            let(sender,mut receiver)=mpsc::channel(32);let run=session.run(request,request_cancel.clone(),sender);tokio::pin!(run);let deadline=tokio::time::sleep_until(expires);tokio::pin!(deadline);let mut completed=false;let mut text=String::new();
            loop {tokio::select! {
                _=cancel.cancelled()=>anyhow::bail!("Naming was cancelled."),
                _=request_cancel.cancelled()=>anyhow::bail!("Naming was stopped."),
                _=&mut deadline=>anyhow::bail!("Naming did not finish within ten seconds."),
                _=&mut run,if !completed=>completed=true,
                event=receiver.recv()=>match event.context("The provider session ended without a name.")? {
                    Event::TextDelta{delta}=>{anyhow::ensure!(text.len()+delta.len()<=65536,"The naming response exceeded its byte bound.");text.push_str(&delta);},
                    Event::Done{outcome:Outcome::Cancelled}=>anyhow::bail!("Naming was cancelled."),
                    Event::Done{outcome:Outcome::Error{..}}=>anyhow::bail!("The naming provider could not finish its request."),
                    Event::Done{..}=>return Ok(text.trim().to_owned()),
                    _=>{},
                }
            }}
        }.await;
        request_cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), session.destroy()).await;
        answer
    }
    pub async fn close(&self) {
        self.lifetime.cancel();
        let tasks = std::mem::take(
            &mut *self
                .tasks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        for (_, task) in tasks {
            let _ = task.await;
        }
    }
}
