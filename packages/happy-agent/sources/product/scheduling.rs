//! Durable timed waits and scheduled messages owned by the scheduling feature.
use super::{
    agent_runtime::AgentRuntimeModule,
    durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration},
    identity::now,
    lifecycle::LifecycleModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use happy_agent_base::{AcceptedInput, AgentModule, AgentScope};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
mod delivery;
mod format;
mod persistence;
mod time;
mod tools;
pub type SchedulingEventListener = Arc<dyn Fn(&Value) + Send + Sync>;
pub type SchedulingTransactionalListener =
    Arc<dyn for<'a> Fn(&Context<'a>, &Value) -> Result<()> + Send + Sync>;
pub struct SchedulingSubscription {
    owner: Weak<SchedulingModule>,
    id: u64,
    transactional: bool,
}
impl Drop for SchedulingSubscription {
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
pub struct SchedulingModule {
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    agents: Arc<AgentRuntimeModule>,
    lifecycle: Arc<LifecycleModule>,
    schemas: Schemas,
    owner: Weak<Self>,
    listeners: Mutex<BTreeMap<u64, SchedulingEventListener>>,
    transactional: Mutex<BTreeMap<u64, SchedulingTransactionalListener>>,
    next: AtomicU64,
    suspended: Mutex<BTreeMap<String, BTreeMap<u64, CancellationToken>>>,
}
fn valid(schemas: &Schemas, name: &str, value: &Value, label: &str) -> Result<()> {
    anyhow::ensure!(schemas.valid(name, value)?, "The {label} is invalid.");
    Ok(())
}
impl SchedulingModule {
    pub fn new(
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        agents: Arc<AgentRuntimeModule>,
        lifecycle: Arc<LifecycleModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        let module = Arc::new_cyclic(|owner| Self {
            runtime,
            durable: durable.clone(),
            agents: agents.clone(),
            lifecycle,
            schemas,
            owner: owner.clone(),
            listeners: Mutex::new(BTreeMap::new()),
            transactional: Mutex::new(BTreeMap::new()),
            next: AtomicU64::new(1),
            suspended: Mutex::new(BTreeMap::new()),
        });
        durable.register(Registration {
            name: "scheduling.deliver".to_owned(),
            arguments_schema: "ownerSchedulingDelivery",
            result_schema: "ownerSchedulingDeliveryResult",
            function: Arc::new(delivery::Delivery {
                owner: Arc::downgrade(&module),
            }),
        })?;
        agents.install(module.clone())?;
        Ok(module)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime
            .migrate("scheduling", persistence::MIGRATIONS)
            .await
    }
    pub fn on_event(
        self: &Arc<Self>,
        listener: SchedulingEventListener,
    ) -> Result<SchedulingSubscription> {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The scheduling listener bound was reached."
        );
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(SchedulingSubscription {
            owner: Arc::downgrade(self),
            id,
            transactional: false,
        })
    }
    pub fn on_event_transactional(
        self: &Arc<Self>,
        listener: SchedulingTransactionalListener,
    ) -> Result<SchedulingSubscription> {
        let mut listeners = self
            .transactional
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The scheduling listener bound was reached."
        );
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(SchedulingSubscription {
            owner: Arc::downgrade(self),
            id,
            transactional: true,
        })
    }
    fn event(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        kind: &str,
        field: &str,
        record: &Value,
        result: Option<&Value>,
    ) -> Result<()> {
        let mut event = json!({"eventId":cuid2::create_id(),"at":now(),"agentId":agent,"type":kind,field:record});
        if let Some(result) = result {
            event["result"] = result.clone();
        }
        valid(
            &self.schemas,
            "ownerSchedulingEvent",
            &event,
            "scheduling event",
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
        ctx.after_commit(move||{for listener in listeners{if std::panic::catch_unwind(std::panic::AssertUnwindSafe(||listener(&event))).is_err(){tracing::warn!(event_id=%event["eventId"],"A scheduling subscriber failed after commit.");}}})
    }
    fn agent(&self, ctx: &Context<'_>, agent: &str) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        valid(
            &self.schemas,
            "ownerSchedulingId",
            &json!(agent),
            "acting agent ID",
        )
    }
    fn intent(&self, ctx: &Context<'_>, id: &str) -> Result<()> {
        self.durable.invoke(ctx,&json!({"function":"scheduling.deliver","arguments":{"scheduleId":id},"operationId":format!("scheduling.deliver.{id}"),"lockKeys":[format!("scheduled-message.{id}")]}))?;
        Ok(())
    }
    pub fn schedule(&self, ctx: &Context<'_>, agent: &str, input: &Value) -> Result<Value> {
        self.agent(ctx, agent)?;
        valid(
            &self.schemas,
            "ownerSchedulingInput",
            input,
            "schedule message",
        )?;
        let target = input["targetAgentId"].as_str().unwrap_or(agent);
        let id = input["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(cuid2::create_id);
        if let Some(existing) = persistence::read_schedule(ctx, &self.schemas, &id)? {
            anyhow::ensure!(
                existing["senderAgentId"] == agent
                    && existing["targetAgentId"] == target
                    && existing["message"] == input["message"],
                "Scheduled message \"{id}\" already exists."
            );
            return Ok(existing);
        }
        let at = now();
        let relative = input.get("in").is_some();
        let due = time::due(
            &self.schemas,
            if relative { &input["in"] } else { &input["at"] },
            at,
            relative,
        )?;
        let schedule = json!({"id":id,"senderAgentId":agent,"targetAgentId":target,"message":input["message"],"dueAt":due,"status":"pending","createdAt":at,"updatedAt":at});
        persistence::write_schedule(ctx, &self.schemas, &schedule)?;
        self.event(ctx, agent, "message_scheduled", "schedule", &schedule, None)?;
        self.intent(ctx, &id)?;
        Ok(schedule)
    }
    pub fn cancel_schedule(&self, ctx: &Context<'_>, agent: &str, input: &Value) -> Result<Value> {
        self.agent(ctx, agent)?;
        valid(
            &self.schemas,
            "ownerSchedulingCancel",
            input,
            "schedule cancellation",
        )?;
        let id = input["scheduleId"].as_str().unwrap();
        let mut schedule = persistence::read_schedule(ctx, &self.schemas, id)?
            .with_context(|| format!("Scheduled message \"{id}\" does not exist."))?;
        anyhow::ensure!(
            schedule["senderAgentId"] == agent,
            "Scheduled message \"{id}\" does not exist."
        );
        if schedule["status"] != "pending" {
            return Ok(schedule);
        }
        schedule["status"] = json!("cancelled");
        schedule["updatedAt"] = json!(now());
        persistence::write_schedule(ctx, &self.schemas, &schedule)?;
        self.event(
            ctx,
            agent,
            "scheduled_message_cancelled",
            "schedule",
            &schedule,
            None,
        )?;
        self.durable
            .cancel(ctx, &format!("scheduling.deliver.{id}"))?;
        Ok(schedule)
    }
    pub fn list_schedule_page(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        query: &Value,
    ) -> Result<Value> {
        self.agent(ctx, agent)?;
        valid(
            &self.schemas,
            "ownerSchedulingPageQuery",
            query,
            "schedule page query",
        )?;
        persistence::page(ctx, &self.schemas, agent, query)
    }
    pub fn get_schedule(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<Option<Value>> {
        self.agent(ctx, agent)?;
        valid(
            &self.schemas,
            "ownerSchedulingId",
            &json!(id),
            "schedule ID",
        )?;
        Ok(
            persistence::read_schedule(ctx, &self.schemas, id)?.filter(|schedule| {
                schedule["senderAgentId"] == agent || schedule["targetAgentId"] == agent
            }),
        )
    }
    pub fn interrupt_waits(&self, agent: &str) -> Result<()> {
        valid(
            &self.schemas,
            "ownerSchedulingId",
            &json!(agent),
            "acting agent ID",
        )?;
        if let Some(waits) = self
            .suspended
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(agent)
        {
            for token in waits.into_values() {
                token.cancel();
            }
        }
        Ok(())
    }
    pub fn stop(&self) {
        let waits = std::mem::take(
            &mut *self
                .suspended
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        for token in waits.into_values().flat_map(BTreeMap::into_values) {
            token.cancel();
        }
    }
    #[cfg(test)]
    pub fn suspension_count(&self) -> usize {
        self.suspended
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .map(BTreeMap::len)
            .sum()
    }
    pub async fn wait(
        self: &Arc<Self>,
        agent: &str,
        input: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.wait_inner(agent, input, false, cancel).await
    }
    pub async fn wait_until(
        self: &Arc<Self>,
        agent: &str,
        input: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.wait_inner(agent, input, true, cancel).await
    }
    async fn wait_inner(
        self: &Arc<Self>,
        agent: &str,
        input: &Value,
        until: bool,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        valid(
            &self.schemas,
            if until {
                "ownerSchedulingUntilInput"
            } else {
                "ownerSchedulingWaitInput"
            },
            input,
            "wait input",
        )?;
        let owner = self.clone();
        let acting = agent.to_owned();
        let input = input.clone();
        let kind = if until { "wait_until" } else { "wait" };
        let claimed=self.runtime.transact(move|ctx|{owner.agent(ctx,&acting)?;let id=input["id"].as_str().map(str::to_owned).unwrap_or_else(cuid2::create_id);if let Some(existing)=persistence::read_wait(ctx,&owner.schemas,&acting,&id)?{anyhow::ensure!(existing["kind"]==kind,"That wait identity belongs to another kind of wait.");return Ok(existing);}let at=now();let due=time::due(&owner.schemas,if until{&input["at"]}else{&input["duration"]},at,!until)?;let wait=json!({"id":id,"agentId":acting,"kind":kind,"status":"waiting","dueAt":due,"createdAt":at,"updatedAt":at,"startedAt":at});persistence::write_wait(ctx,&owner.schemas,&wait)?;owner.event(ctx,&acting,"wait_started","wait",&wait,None)?;Ok(wait)}).await?;
        if claimed["status"] != "waiting" {
            return wait_result(&self.schemas, &claimed);
        }
        let due = claimed["dueAt"].as_u64().unwrap();
        let outcome = if cancel.is_cancelled() {
            "interrupted"
        } else if due <= now() {
            "elapsed"
        } else {
            let token = CancellationToken::new();
            let id = self.next.fetch_add(1, Ordering::Relaxed);
            {
                let mut suspended = self
                    .suspended
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                anyhow::ensure!(
                    suspended.values().map(BTreeMap::len).sum::<usize>() < 1024,
                    "The scheduling suspension bound was reached."
                );
                suspended
                    .entry(agent.to_owned())
                    .or_default()
                    .insert(id, token.clone());
            }
            let guard = Suspension {
                owner: Arc::downgrade(self),
                agent: agent.to_owned(),
                id,
            };
            let outcome = tokio::select! {biased;_=cancel.cancelled()=>"interrupted",_=self.lifecycle.shutdown.cancelled()=>"interrupted",_=token.cancelled()=>"interrupted",_=tokio::time::sleep(Duration::from_millis(due.saturating_sub(now())))=>"elapsed"};
            drop(guard);
            outcome
        };
        let owner = self.clone();
        let acting = agent.to_owned();
        let id = claimed["id"].as_str().unwrap().to_owned();
        self.runtime
            .transact(move |ctx| {
                let mut before = persistence::read_wait(ctx, &owner.schemas, &acting, &id)?
                    .context("That durable wait no longer exists.")?;
                if before["status"] != "waiting" {
                    return wait_result(&owner.schemas, &before);
                }
                let started = before["startedAt"].as_u64().unwrap();
                let ended = now().max(if outcome == "elapsed" {
                    before["dueAt"].as_u64().unwrap()
                } else {
                    started
                });
                before["status"] = json!(outcome);
                before["updatedAt"] = json!(ended);
                before["finishedAt"] = json!(ended);
                before["elapsedMs"] = json!(ended - started);
                persistence::write_wait(ctx, &owner.schemas, &before)?;
                let result = wait_result(&owner.schemas, &before)?;
                owner.event(
                    ctx,
                    &acting,
                    "wait_finished",
                    "wait",
                    &before,
                    Some(&result),
                )?;
                Ok(result)
            })
            .await
    }
    pub fn format_wait_for_model(&self, result: &Value) -> Result<String> {
        valid(
            &self.schemas,
            "ownerSchedulingWaitResult",
            result,
            "wait result",
        )?;
        Ok(format::wait(result))
    }
    pub fn format_schedule_for_model(&self, schedule: &Value) -> Result<String> {
        persistence::validate_schedule(&self.schemas, schedule)?;
        format::schedule(schedule)
    }
    pub fn format_cancellation_for_model(&self, schedule: &Value) -> Result<String> {
        persistence::validate_schedule(&self.schemas, schedule)?;
        Ok(format::cancellation(schedule))
    }
    pub fn format_schedule_page_for_model(&self, page: &Value) -> Result<String> {
        valid(&self.schemas, "ownerSchedulingPage", page, "schedule page")?;
        format::page(page, 8000)
    }
}
struct Suspension {
    owner: Weak<SchedulingModule>,
    agent: String,
    id: u64,
}
impl Drop for Suspension {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            let mut waits = owner
                .suspended
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(agent) = waits.get_mut(&self.agent) {
                agent.remove(&self.id);
                if agent.is_empty() {
                    waits.remove(&self.agent);
                }
            }
        }
    }
}
fn wait_result(schemas: &Schemas, wait: &Value) -> Result<Value> {
    anyhow::ensure!(
        wait["status"] != "waiting",
        "A waiting record has no final result."
    );
    let result = json!({"waitId":wait["id"],"agentId":wait["agentId"],"outcome":wait["status"],"kind":wait["kind"],"dueAt":wait["dueAt"],"startedAt":wait["startedAt"],"endedAt":wait["finishedAt"],"elapsedMs":wait["elapsedMs"]});
    valid(schemas, "ownerSchedulingWaitResult", &result, "wait result")?;
    Ok(result)
}
#[async_trait]
impl AgentModule for SchedulingModule {
    fn name(&self) -> &'static str {
        "scheduling"
    }
    async fn available_tools(
        &self,
        scope: &AgentScope<'_>,
    ) -> Result<Vec<happy_providers::ToolDefinition>> {
        let owner = self
            .owner
            .upgrade()
            .context("The scheduling owner was closed.")?;
        let id = scope.id.to_owned();
        let child = self
            .runtime
            .transact(move |ctx| owner.agents.parent(ctx, &id))
            .await?
            .is_some();
        Ok(if child {
            tools::definitions().into_iter().take(2).collect()
        } else {
            tools::definitions()
        })
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|tool| tool.name == "list_scheduled_messages")
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|_| true)
    }
    fn steerable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|tool| matches!(tool.name.as_str(), "wait" | "wait_until"))
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
    fn execute_transactional_tool(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<happy_providers::Message>> {
        self.execute_schedule_transaction(ctx, scope, call)
    }
    async fn execute_tool(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<happy_providers::Message> {
        self.execute_schedule_wait(scope, call, cancel).await
    }
    fn accepted(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        _: &[AcceptedInput],
        _: bool,
    ) -> Result<()> {
        let owner = self.owner.clone();
        let id = scope.id.to_owned();
        ctx.after_commit(move || {
            if let Some(owner) = owner.upgrade() {
                let _ = owner.interrupt_waits(&id);
            }
        })
    }
    async fn after_start(&self) -> Result<()> {
        let owner = self
            .owner
            .upgrade()
            .context("The scheduling owner was closed.")?;
        let mut after = None;
        loop {
            let module = owner.clone();
            let pending = self
                .runtime
                .transact(move |ctx| {
                    let pending = persistence::pending(ctx, &module.schemas, after)?;
                    for schedule in &pending {
                        module.intent(ctx, schedule["id"].as_str().unwrap())?;
                    }
                    Ok(pending)
                })
                .await?;
            if pending.len() < 1000 {
                return Ok(());
            }
            after = pending.last().unwrap()["dueAt"].as_u64();
        }
    }
    async fn close(&self) {
        self.stop();
    }
}
