//! Durable questions, explicit outcomes, and the shipped presence waiting policy.
use super::{
    agent_runtime::AgentRuntimeModule,
    durable::DurableFunctionsModule,
    identity::now,
    lifecycle::LifecycleModule,
    presence::PresenceModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
mod format;
mod persistence;
mod tools;
mod validation;
mod waiting;
pub type UserInputEventListener = Arc<dyn Fn(&Value) + Send + Sync>;
pub type UserInputTransactionalListener =
    Arc<dyn for<'a> Fn(&Context<'a>, &Value) -> Result<()> + Send + Sync>;
pub struct UserInputSubscription {
    owner: Weak<UserInputModule>,
    id: u64,
    transactional: bool,
}
impl Drop for UserInputSubscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            if self.transactional {
                owner
                    .transactional
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&self.id);
            } else {
                owner
                    .listeners
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&self.id);
            }
        }
    }
}
pub struct UserInputModule {
    presence: Arc<PresenceModule>,
    runtime: Arc<RuntimeModule>,
    agents: Arc<AgentRuntimeModule>,
    _durable: Arc<DurableFunctionsModule>,
    _lifecycle: Arc<LifecycleModule>,
    schemas: Schemas,
    owner: Weak<Self>,
    listeners: Mutex<BTreeMap<u64, UserInputEventListener>>,
    transactional: Mutex<BTreeMap<u64, UserInputTransactionalListener>>,
    next_listener: AtomicU64,
    changes: watch::Sender<u64>,
}
impl UserInputModule {
    pub fn new(
        presence: Arc<PresenceModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        agents: Arc<AgentRuntimeModule>,
        lifecycle: Arc<LifecycleModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        let (changes, _) = watch::channel(0);
        let owner = Arc::new_cyclic(|owner| Self {
            presence,
            runtime,
            agents: agents.clone(),
            _durable: durable,
            _lifecycle: lifecycle,
            schemas,
            owner: owner.clone(),
            listeners: Mutex::new(BTreeMap::new()),
            transactional: Mutex::new(BTreeMap::new()),
            next_listener: AtomicU64::new(1),
            changes,
        });
        agents.install(owner.clone())?;
        Ok(owner)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime
            .migrate("userInput", persistence::MIGRATIONS)
            .await
    }
    pub fn on_event(
        self: &Arc<Self>,
        listener: UserInputEventListener,
    ) -> Result<UserInputSubscription> {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The user input listener bound was reached."
        );
        let id = self.next_listener.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(UserInputSubscription {
            owner: Arc::downgrade(self),
            id,
            transactional: false,
        })
    }
    pub fn on_event_transactional(
        self: &Arc<Self>,
        listener: UserInputTransactionalListener,
    ) -> Result<UserInputSubscription> {
        let mut listeners = self
            .transactional
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The user input listener bound was reached."
        );
        let id = self.next_listener.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(UserInputSubscription {
            owner: Arc::downgrade(self),
            id,
            transactional: true,
        })
    }
    fn agent(&self, ctx: &Context<'_>, agent: &str) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        validation::schema(
            &self.schemas,
            "ownerUserInputAgentId",
            &json!(agent),
            "agent identity",
        )
    }
    fn authorize(&self, ctx: &Context<'_>, acting: &str, asking: &str) -> Result<()> {
        if acting == asking {
            return Ok(());
        }
        let mut descendant = asking.to_owned();
        for _ in 0..64 {
            let Some(parent) = self.agents.parent(ctx, &descendant)? else {
                break;
            };
            if parent == acting {
                return Ok(());
            }
            descendant = parent;
        }
        anyhow::bail!("User input access is not authorized.")
    }
    pub fn get(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<Option<Value>> {
        self.agent(ctx, agent)?;
        validation::schema(
            &self.schemas,
            "ownerUserInputRequestId",
            &json!(id),
            "user input request ID",
        )?;
        let request = persistence::read(ctx, &self.schemas, id)?;
        if let Some(request) = &request {
            self.authorize(ctx, agent, request["askingAgentId"].as_str().unwrap())?;
        }
        Ok(request)
    }
    pub fn get_owned(&self, ctx: &Context<'_>, asking_agent: &str, id: &str) -> Result<Option<Value>> {
        self.agent(ctx, asking_agent)?;
        validation::schema(&self.schemas, "ownerUserInputRequestId", &json!(id), "user input request ID")?;
        Ok(persistence::read(ctx, &self.schemas, id)?.filter(|request| request["askingAgentId"] == asking_agent))
    }
    fn required(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<Value> {
        self.get(ctx, agent, id)?
            .with_context(|| format!("User input request \"{id}\" was not found."))
    }
    fn persist(
        &self,
        ctx: &Context<'_>,
        acting: &str,
        kind: &str,
        request: Value,
    ) -> Result<Value> {
        persistence::write(ctx, &self.schemas, &request)?;
        let event = json!({"eventId":uuid::Uuid::new_v4().simple().to_string(),"at":now(),"actingAgentId":acting,"requestId":request["id"],"type":kind,"request":request});
        validation::schema(
            &self.schemas,
            "ownerUserInputEvent",
            &event,
            "user input event",
        )?;
        let transactional = self
            .transactional
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for listener in transactional {
            listener(ctx, &event)?;
        }
        let listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let owner = self.owner.clone();
        ctx.after_commit(move||{if let Some(owner)=owner.upgrade(){owner.changes.send_modify(|version|*version=version.wrapping_add(1));}for listener in listeners{if std::panic::catch_unwind(std::panic::AssertUnwindSafe(||listener(&event))).is_err(){tracing::warn!(event_id=%event["eventId"],"A user input listener failed after the request was saved.");}}})?;
        Ok(request)
    }
    pub fn ask(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        input: &Value,
        request_id: Option<&str>,
    ) -> Result<Value> {
        self.agent(ctx, agent)?;
        validation::schema(
            &self.schemas,
            "ownerUserInputAsk",
            input,
            "user input request",
        )?;
        let questions = validation::questions(input)?;
        let id = request_id
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        validation::schema(
            &self.schemas,
            "ownerUserInputRequestId",
            &json!(id),
            "request identity",
        )?;
        if let Some(current) = persistence::read(ctx, &self.schemas, &id)? {
            let prior = validation::questions(&current)?;
            anyhow::ensure!(
                current["askingAgentId"] == agent
                    && current["context"] == input["context"]
                    && prior == questions
                    && current.get("autoResolutionMs") == input.get("autoResolutionMs")
                    && (current.get("deadlineAt") == input.get("deadlineAt")
                        || (input.get("deadlineAt").is_none() && current["status"] == "timed_out")),
                "User input request \"{id}\" belongs to different input."
            );
            return Ok(current);
        }
        let at = now();
        let first = &questions[0];
        let mut request = json!({"id":id,"askingAgentId":agent,"question":first["question"],"context":input["context"],"status":"pending","createdAt":at,"updatedAt":at});
        for field in ["header", "options"] {
            if let Some(value) = first.get(field) {
                request[field] = value.clone();
            }
        }
        if input.get("questions").is_some() {
            request["questions"] = json!(questions);
        }
        for field in ["autoResolutionMs", "deadlineAt"] {
            if let Some(value) = input.get(field) {
                request[field] = value.clone();
            }
        }
        self.persist(ctx, agent, "user_input_requested", request)
    }
    fn prepare_answer(&self, ctx: &Context<'_>, agent: &str, input: &Value) -> Result<Value> {
        self.agent(ctx, agent)?;
        validation::schema(
            &self.schemas,
            "ownerUserInputAnswer",
            input,
            "user input answer",
        )?;
        let characters = if let Some(answer) = input.get("answer") {
            validation::answer_characters(answer)
        } else {
            input["answers"]
                .as_object()
                .unwrap()
                .values()
                .map(validation::answer_characters)
                .sum()
        };
        anyhow::ensure!(
            characters <= 20000,
            "User input answer exceeds its configured bound."
        );
        let mut request = self.required(ctx, agent, input["requestId"].as_str().unwrap())?;
        if request["status"] != "pending" {
            return Ok(request);
        }
        if let Some(answer) = input.get("answer") {
            anyhow::ensure!(
                request["questions"]
                    .as_array()
                    .is_none_or(|questions| questions.len() <= 1),
                "A batched user input request requires one answer for every question."
            );
            validation::answer(answer, &request["options"])?;
            request["answer"] = answer.clone();
            if let Some(id) = request["questions"][0]["id"].as_str().map(str::to_owned) {
                request["answers"] = json!({id:answer});
            }
        } else {
            let questions = request["questions"]
                .as_array()
                .context("A singular user input request cannot receive batch answers.")?;
            validation::batch_answers(&input["answers"], questions)?;
            request["answer"] = input["answers"][questions[0]["id"].as_str().unwrap()].clone();
            request["answers"] = input["answers"].clone();
        }
        Ok(request)
    }
    pub fn validate_answer(&self, ctx: &Context<'_>, agent: &str, input: &Value) -> Result<()> {
        self.prepare_answer(ctx, agent, input).map(|_| ())
    }
    pub fn answer(&self, ctx: &Context<'_>, agent: &str, input: &Value) -> Result<Value> {
        let mut request = self.prepare_answer(ctx, agent, input)?;
        if request["status"] != "pending" {
            return Ok(request);
        }
        let at = now();
        request["status"] = json!("answered");
        request["answeredAt"] = json!(at);
        request["updatedAt"] = json!(at);
        self.persist(ctx, agent, "user_input_answered", request)
    }
    pub fn cancel(&self, ctx: &Context<'_>, agent: &str, input: &Value) -> Result<Value> {
        self.agent(ctx, agent)?;
        validation::schema(
            &self.schemas,
            "ownerUserInputCancel",
            input,
            "user input cancellation",
        )?;
        let request = self.required(ctx, agent, input["requestId"].as_str().unwrap())?;
        if request["status"] != "pending" {
            return Ok(request);
        }
        let request = self.terminal(
            request,
            &json!({"outcome":"cancelled","reason":input["reason"]}),
            false,
        )?;
        self.persist(ctx, agent, "user_input_cancelled", request)
    }
    pub fn complete(&self, ctx: &Context<'_>, agent: &str, input: &Value) -> Result<Value> {
        self.agent(ctx, agent)?;
        validation::schema(
            &self.schemas,
            "ownerUserInputComplete",
            input,
            "user input completion",
        )?;
        let request = self.required(ctx, agent, input["requestId"].as_str().unwrap())?;
        if request["status"] != "pending" {
            if input["outcome"] == "timed_out" {
                self.assert_timeout(
                    &request,
                    input["deadlineAt"].as_u64().unwrap(),
                    false,
                    false,
                )?;
            }
            return Ok(request);
        }
        let request = self.terminal(request, input, false)?;
        self.persist(
            ctx,
            agent,
            if request["status"] == "cancelled" {
                "user_input_cancelled"
            } else {
                "user_input_completed"
            },
            request,
        )
    }
    fn assert_timeout(
        &self,
        request: &Value,
        deadline: u64,
        allow_unconfigured: bool,
        timer: bool,
    ) -> Result<()> {
        let original = validation::deadline(request);
        anyhow::ensure!(
            (original.is_none() && allow_unconfigured) || original == Some(deadline),
            "User input timeout deadline does not match the request."
        );
        anyhow::ensure!(
            timer || now() >= deadline,
            "User input request has not reached its deadline."
        );
        Ok(())
    }
    fn terminal(&self, mut request: Value, outcome: &Value, timer: bool) -> Result<Value> {
        let mut at = now();
        let kind = outcome["outcome"].as_str().unwrap();
        request["status"] = json!(kind);
        let timestamp = match kind {
            "cancelled" => {
                request["reason"] = outcome["reason"].clone();
                "cancelledAt"
            }
            "away" => "completedAt",
            "timed_out" => {
                let deadline = outcome["deadlineAt"].as_u64().unwrap();
                self.assert_timeout(&request, deadline, true, timer)?;
                request["deadlineAt"] = json!(deadline);
                if timer {
                    at = at.max(deadline);
                }
                "timedOutAt"
            }
            _ => anyhow::bail!("The user input outcome is invalid."),
        };
        for field in ["presence", "waitedMs"] {
            if let Some(value) = outcome.get(field) {
                request[field] = value.clone();
            }
        }
        request[timestamp] = json!(at);
        request["updatedAt"] = json!(at);
        validation::request(&self.schemas, &request)?;
        Ok(request)
    }
    pub fn list_page(&self, ctx: &Context<'_>, agent: &str, query: &Value) -> Result<Value> {
        self.agent(ctx, agent)?;
        validation::schema(
            &self.schemas,
            "ownerUserInputListQuery",
            query,
            "user input list query",
        )?;
        let target = query["askingAgentId"].as_str().unwrap_or(agent);
        self.authorize(ctx, agent, target)?;
        let page = persistence::page(ctx, &self.schemas, target, query)?;
        validation::schema(
            &self.schemas,
            "ownerUserInputPage",
            &page,
            "user input page",
        )?;
        format::page(&page, format::OUTPUT)?;
        Ok(page)
    }
    pub fn list(&self, ctx: &Context<'_>, agent: &str, query: &Value) -> Result<Vec<Value>> {
        Ok(self.list_page(ctx, agent, query)?["requests"]
            .as_array()
            .unwrap()
            .clone())
    }
    pub fn latest_question_at(&self, ctx: &Context<'_>, agent: &str) -> Result<Option<u64>> {
        self.agent(ctx, agent)?;
        persistence::latest(ctx, &self.schemas, agent)
    }
    pub fn get_page(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        id: &str,
        query: &Value,
    ) -> Result<Value> {
        validation::schema(
            &self.schemas,
            "ownerUserInputDetailQuery",
            query,
            "user input detail query",
        )?;
        let Some(request) = self.get(ctx, agent, id)? else {
            return Ok(json!({"request":null,"detail":"","cursor":0,"detailTotal":0}));
        };
        anyhow::ensure!(
            query.get("cursor").is_none() || query.get("detailOffset").is_none(),
            "User input detail query cannot specify both cursor and detailOffset."
        );
        anyhow::ensure!(
            query.get("limit").is_none() || query.get("detailLimit").is_none(),
            "User input detail query cannot specify both limit and detailLimit."
        );
        let start = if let Some(cursor) = query["cursor"].as_str() {
            validation::cursor(cursor, "detail")?
        } else {
            query["detailOffset"].as_u64().unwrap_or(0)
        } as usize;
        let detail = format::detail(&request);
        let total = format::length(&detail);
        anyhow::ensure!(
            start <= total,
            "User input detail cursor is past the detail."
        );
        let requested = query["limit"]
            .as_u64()
            .or_else(|| query["detailLimit"].as_u64())
            .unwrap_or(4000) as usize;
        let budget = format::OUTPUT
            .saturating_sub(format::length(&format::request(&request, format::OUTPUT)) + 64)
            .max(1);
        let part = format::slice(&detail, start, requested.min(budget));
        let next = start + format::length(&part);
        let mut page = json!({"request":request,"detail":part,"cursor":start,"detailTotal":total});
        if next < total {
            page["nextCursor"] = json!(next.to_string());
        }
        validation::schema(
            &self.schemas,
            "ownerUserInputDetailPage",
            &page,
            "user input detail page",
        )?;
        Ok(page)
    }
    pub fn format_for_model(&self, request: &Value) -> Result<String> {
        validation::request(&self.schemas, request)?;
        Ok(format::request(request, format::OUTPUT))
    }
    pub fn format_page_for_model(&self, page: &Value) -> Result<String> {
        validation::schema(&self.schemas, "ownerUserInputPage", page, "user input page")?;
        format::page(page, format::OUTPUT)
    }
    pub fn format_detail_page_for_model(&self, page: &Value) -> Result<String> {
        validation::schema(
            &self.schemas,
            "ownerUserInputDetailPage",
            page,
            "user input detail page",
        )?;
        Ok(format::detail_page(page, format::OUTPUT))
    }
    fn cancel_pending(&self, ctx: &Context<'_>, agent: &str) -> Result<()> {
        loop {
            let page = persistence::page(
                ctx,
                &self.schemas,
                agent,
                &json!({"status":"pending","limit":50,"cursor":"0"}),
            )?;
            let requests = page["requests"].as_array().unwrap();
            if requests.is_empty() {
                return Ok(());
            }
            for request in requests {
                self.cancel(
                    ctx,
                    agent,
                    &json!({"requestId":request["id"],"reason":"The agent run was aborted."}),
                )?;
            }
        }
    }
}
#[async_trait]
impl AgentModule for UserInputModule {
    fn name(&self) -> &'static str {
        "userInput"
    }
    fn tools(&self, _: &AgentScope<'_>) -> Vec<happy_providers::ToolDefinition> {
        tools::definitions()
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|tool| tool.name != "cancel_ask")
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|tool| tool.name != "cancel_ask")
    }
    fn permission_policy(
        &self,
        _: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<happy_agent_base::ToolPermissionPolicy>> {
        tools::definition(call).map(|tool| {
            Ok(happy_agent_base::ToolPermissionPolicy {
                should_review_in_auto_mode: false,
                should_run_in_full_access_in_auto_mode: false,
                requires_auto_or_full_access: false,
                action: tool.description,
                instructions: None,
            })
        })
    }
    fn settled_detail(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        status: &str,
        reason: &str,
        _: Option<&str>,
    ) -> Result<()> {
        if status == "aborted" || reason == "aborted" {
            self.cancel_pending(ctx, scope.id)?;
        }
        Ok(())
    }
    fn execute_transactional_tool(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<happy_providers::Message>> {
        self.execute_question_transaction(ctx, scope, call)
    }
    async fn execute_tool(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<happy_providers::Message> {
        self.execute_question_wait(scope, call, cancel).await
    }
}
