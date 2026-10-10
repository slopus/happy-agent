//! The shipped per-agent goal lifecycle and autonomous loop continuation.
use super::{
    agent_runtime::AgentRuntimeModule,
    durable::DurableFunctionsModule,
    identity::now,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope, Inference};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
};
mod format;
mod tools;
pub type GoalEventListener = Arc<dyn Fn(&Value) + Send + Sync>;
pub type GoalTransactionalListener =
    Arc<dyn for<'a> Fn(&Context<'a>, &Value) -> Result<()> + Send + Sync>;
pub struct GoalSubscription {
    owner: Weak<GoalModule>,
    id: u64,
    transactional: bool,
}
impl Drop for GoalSubscription {
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
pub struct GoalModule {
    runtime: Arc<RuntimeModule>,
    _durable: Arc<DurableFunctionsModule>,
    agents: Arc<AgentRuntimeModule>,
    schemas: Schemas,
    listeners: Mutex<BTreeMap<u64, GoalEventListener>>,
    transactional: Mutex<BTreeMap<u64, GoalTransactionalListener>>,
    next: AtomicU64,
}
struct State {
    goal: Option<Value>,
    lifecycle: Option<Value>,
    failure_count: Option<Value>,
}
const MIGRATIONS: &[(&str, &str)] = &[(
    "001-goal-state",
    "CREATE TABLE IF NOT EXISTS happy_agent_goal_state(agent_id TEXT NOT NULL,state_key TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(agent_id,state_key));",
)];
impl GoalModule {
    pub fn new(
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        agents: Arc<AgentRuntimeModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        let module = Arc::new(Self {
            runtime,
            _durable: durable,
            agents: agents.clone(),
            schemas,
            listeners: Mutex::new(BTreeMap::new()),
            transactional: Mutex::new(BTreeMap::new()),
            next: AtomicU64::new(1),
        });
        agents.install(module.clone())?;
        Ok(module)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime.migrate("goal", MIGRATIONS).await
    }
    pub fn on_event(self: &Arc<Self>, listener: GoalEventListener) -> Result<GoalSubscription> {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(listeners.len() < 64, "The goal listener bound was reached.");
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(GoalSubscription {
            owner: Arc::downgrade(self),
            id,
            transactional: false,
        })
    }
    pub fn on_event_transactional(
        self: &Arc<Self>,
        listener: GoalTransactionalListener,
    ) -> Result<GoalSubscription> {
        let mut listeners = self
            .transactional
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The transactional goal listener bound was reached."
        );
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(GoalSubscription {
            owner: Arc::downgrade(self),
            id,
            transactional: true,
        })
    }
    fn agent(&self, ctx: &Context<'_>, agent: &str) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("ownerGoalAgentId", &json!(agent))?,
            "Goal agent ID is invalid."
        );
        Ok(())
    }
    fn read(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        key: &str,
        schema: &str,
    ) -> Result<Option<Value>> {
        self.agent(ctx, agent)?;
        let encoded=ctx.database().query_row("SELECT value_json FROM happy_agent_goal_state WHERE agent_id=?1 AND state_key=?2 LIMIT 1",rusqlite::params![agent,key],|row|row.get::<_,String>(0)).optional()?;
        let Some(encoded) = encoded else {
            return Ok(None);
        };
        anyhow::ensure!(
            encoded.len() <= 1024 * 1024,
            "Stored Goal state exceeds its byte bound."
        );
        let value: Value = serde_json::from_str(&encoded)?;
        anyhow::ensure!(
            self.schemas.valid(schema, &value)?,
            "The stored Goal {key} is invalid."
        );
        Ok(Some(value))
    }
    fn write(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        key: &str,
        value: &Value,
        schema: &str,
    ) -> Result<()> {
        self.agent(ctx, agent)?;
        anyhow::ensure!(
            self.schemas.valid(schema, value)?,
            "Goal {key} state is invalid."
        );
        ctx.database().execute("INSERT INTO happy_agent_goal_state(agent_id,state_key,value_json) VALUES(?1,?2,?3) ON CONFLICT(agent_id,state_key) DO UPDATE SET value_json=excluded.value_json",rusqlite::params![agent,key,value.to_string()])?;
        Ok(())
    }
    fn delete(&self, ctx: &Context<'_>, agent: &str, key: &str) -> Result<()> {
        self.agent(ctx, agent)?;
        ctx.database().execute(
            "DELETE FROM happy_agent_goal_state WHERE agent_id=?1 AND state_key=?2",
            rusqlite::params![agent, key],
        )?;
        Ok(())
    }
    fn semantics(goal: &Value) -> Result<()> {
        anyhow::ensure!(
            goal["updatedAt"].as_u64().unwrap() >= goal["createdAt"].as_u64().unwrap(),
            "The stored goal has invalid timestamps."
        );
        Ok(())
    }
    fn state(&self, ctx: &Context<'_>, agent: &str) -> Result<State> {
        let goal = self.read(ctx, agent, "goal", "ownerGoalRecord")?;
        let lifecycle = self.read(ctx, agent, "lifecycle", "ownerGoalLifecycle")?;
        let failure_count = self.read(ctx, agent, "failureCount", "ownerGoalFailureCount")?;
        if let Some(goal) = &goal {
            Self::semantics(goal)?;
        }
        if let Some(lifecycle) = &lifecycle {
            Self::semantics(&lifecycle["goal"])?;
        }
        if goal.as_ref().is_some_and(|goal| goal["status"] == "active") {
            anyhow::ensure!(
                lifecycle
                    .as_ref()
                    .is_some_and(|lifecycle| Some(&lifecycle["goal"]) == goal.as_ref()),
                "An active Goal requires its exact lifecycle sidecar."
            );
        } else {
            anyhow::ensure!(
                lifecycle.is_none() && failure_count.is_none(),
                "An inactive Goal retains active-lifecycle state."
            );
        }
        Ok(State {
            goal,
            lifecycle,
            failure_count,
        })
    }
    pub fn goal(&self, ctx: &Context<'_>, agent: &str) -> Result<Option<Value>> {
        Ok(self.state(ctx, agent)?.goal)
    }
    fn publish(&self, ctx: &Context<'_>, mut event: Value) -> Result<()> {
        event["eventId"] = json!(uuid::Uuid::new_v4().to_string());
        event["at"] = json!(now());
        anyhow::ensure!(
            self.schemas.valid("ownerGoalEvent", &event)?,
            "Goal event is invalid."
        );
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
        ctx.after_commit(move||{for listener in listeners{if std::panic::catch_unwind(std::panic::AssertUnwindSafe(||listener(&event))).is_err(){tracing::warn!(event_id=%event["eventId"],"A goal subscriber failed after the change committed.");}}})
    }
    fn deactivate(&self, ctx: &Context<'_>, agent: &str) -> Result<()> {
        self.delete(ctx, agent, "lifecycle")?;
        self.delete(ctx, agent, "failureCount")
    }
    fn activate(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        lifecycle: &str,
        goal: &Value,
        external: bool,
    ) -> Result<()> {
        self.write(
            ctx,
            agent,
            "lifecycle",
            &json!({"activation":if external{"external"}else{"agent"},"id":lifecycle,"goal":goal}),
            "ownerGoalLifecycle",
        )?;
        self.delete(ctx, agent, "failureCount")
    }
    fn enqueue(&self, ctx: &Context<'_>, agent: &str, goal: &Value, id: &str) -> Result<()> {
        self.agents.enqueue(ctx,agent,&json!({"id":id,"message":{"role":"user","content":[{"type":"text","text":format::prompt(&self.schemas,goal)?}]},"options":{},"metadata":{"messageOrigin":"agent","senderAgentId":agent}}),false)
    }
    fn wake(&self, ctx: &Context<'_>, agent: &str, lifecycle: &str, goal: &Value) -> Result<()> {
        let id = format::hash(
            &self.schemas,
            &json!([
                "goal-external-wake",
                agent,
                lifecycle,
                goal["objective"],
                goal["createdAt"]
            ]),
        )?;
        self.enqueue(ctx, agent, goal, &id)
    }
    fn set(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        objective: &str,
        lifecycle: Option<&str>,
        external: bool,
    ) -> Result<Value> {
        self.agent(ctx, agent)?;
        let objective = format::objective(&self.schemas, objective)?;
        if let Some(lifecycle) = lifecycle {
            anyhow::ensure!(
                self.schemas
                    .valid("ownerGoalOperationId", &json!(lifecycle))?,
                "Goal lifecycle ID is invalid."
            );
        }
        let state = self.state(ctx, agent)?;
        if let Some(goal) = &state.goal {
            if goal["status"] != "complete" {
                anyhow::ensure!(
                    goal["status"] == "active" && goal["objective"] == objective,
                    "This agent already has an unfinished goal. Complete or clear it before starting another."
                );
                return Ok(
                    json!({"goal":goal,"lifecycleId":state.lifecycle.context("An active Goal requires its exact lifecycle sidecar.")?["id"]}),
                );
            }
        }
        let lifecycle = lifecycle
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let at = now();
        let goal = json!({"createdAt":at,"objective":objective,"status":"active","updatedAt":at});
        self.write(ctx, agent, "goal", &goal, "ownerGoalRecord")?;
        self.activate(ctx, agent, &lifecycle, &goal, external)?;
        self.publish(ctx, json!({"type":"goal_set","agentId":agent,"goal":goal}))?;
        if external {
            self.wake(ctx, agent, &lifecycle, &goal)?;
        }
        Ok(json!({"goal":goal,"lifecycleId":lifecycle}))
    }
    pub fn set_goal(&self, ctx: &Context<'_>, agent: &str, objective: &str) -> Result<Value> {
        Ok(self.set(ctx, agent, objective, None, true)?["goal"].clone())
    }
    pub fn set_goal_with_lifecycle(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        objective: &str,
        lifecycle: &str,
    ) -> Result<Value> {
        self.set(ctx, agent, objective, Some(lifecycle), true)
    }
    fn change(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        status: &str,
        external: bool,
    ) -> Result<Value> {
        self.agent(ctx, agent)?;
        anyhow::ensure!(
            self.schemas.valid("ownerGoalStatus", &json!(status))?,
            "Goal status is invalid."
        );
        let state = self.state(ctx, agent)?;
        let mut goal = state.goal.context("This agent does not have a goal.")?;
        anyhow::ensure!(
            !(goal["status"] == "complete" && status == "active"),
            "A completed goal cannot be resumed. Start a new goal instead."
        );
        if goal["status"] == status {
            return Ok(goal);
        }
        goal["status"] = json!(status);
        goal["updatedAt"] = json!(now());
        self.write(ctx, agent, "goal", &goal, "ownerGoalRecord")?;
        let lifecycle = if status == "active" {
            let id = uuid::Uuid::new_v4().to_string();
            self.activate(ctx, agent, &id, &goal, external)?;
            Some(id)
        } else {
            self.deactivate(ctx, agent)?;
            None
        };
        self.publish(
            ctx,
            json!({"type":"goal_status_changed","agentId":agent,"goal":goal}),
        )?;
        if let Some(lifecycle) = lifecycle {
            if external {
                self.wake(ctx, agent, &lifecycle, &goal)?;
            }
        } else if external && matches!(status, "paused" | "blocked") {
            self.agents.abort(ctx, agent)?;
        }
        Ok(goal)
    }
    pub fn change_goal_status(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        status: &str,
    ) -> Result<Value> {
        self.change(ctx, agent, status, true)
    }
    fn clear(&self, ctx: &Context<'_>, agent: &str, external: bool) -> Result<bool> {
        if self.state(ctx, agent)?.goal.is_none() {
            return Ok(false);
        }
        self.delete(ctx, agent, "goal")?;
        self.deactivate(ctx, agent)?;
        self.publish(ctx, json!({"type":"goal_cleared","agentId":agent}))?;
        if external {
            self.agents.abort(ctx, agent)?;
        }
        Ok(true)
    }
    pub fn clear_goal(&self, ctx: &Context<'_>, agent: &str) -> Result<bool> {
        self.clear(ctx, agent, true)
    }
    fn pause(&self, ctx: &Context<'_>, agent: &str) -> Result<bool> {
        let state = self.state(ctx, agent)?;
        let Some(mut goal) = state.goal.filter(|goal| goal["status"] == "active") else {
            return Ok(false);
        };
        goal["status"] = json!("paused");
        goal["updatedAt"] = json!(now());
        self.write(ctx, agent, "goal", &goal, "ownerGoalRecord")?;
        self.deactivate(ctx, agent)?;
        self.publish(
            ctx,
            json!({"type":"goal_status_changed","agentId":agent,"goal":goal}),
        )?;
        Ok(true)
    }
    fn run_key(agent: &str, key: &str) -> String {
        format!("kv.{agent}.run.module.goal.{key}")
    }
    fn run_read(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        key: &str,
        schema: &str,
    ) -> Result<Option<Value>> {
        let value = ctx.value(agent, &Self::run_key(agent, key))?;
        if let Some(value) = &value {
            anyhow::ensure!(
                self.schemas.valid(schema, value)?,
                "The stored Goal {key} is invalid."
            );
        }
        Ok(value)
    }
    pub fn create_title(&self, objective: &str) -> Result<String> {
        format::title(&self.schemas, objective)
    }
    pub fn format_for_model(&self, goal: Option<&Value>, maximum: usize) -> Result<String> {
        if let Some(goal) = goal {
            anyhow::ensure!(
                self.schemas.valid("ownerGoalRecord", goal)?,
                "The goal is invalid."
            );
            Self::semantics(goal)?;
        }
        Ok(format::goal(goal, maximum))
    }
}
#[async_trait]
impl AgentModule for GoalModule {
    fn name(&self) -> &'static str {
        "goal"
    }
    fn tools(&self, _: &AgentScope<'_>) -> Vec<happy_providers::ToolDefinition> {
        tools::definitions()
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|_| true)
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|tool| tool.name == "get_goal")
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
        self.execute_goal_tool(ctx, scope, call)
    }
    fn before_loop_transactional(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        _: &str,
    ) -> Result<()> {
        let state = self.state(ctx, scope.id)?;
        ctx.delete_value(scope.id, &Self::run_key(scope.id, "continuationId"))?;
        if state
            .goal
            .as_ref()
            .is_some_and(|goal| goal["status"] == "active")
        {
            ctx.put_value(
                scope.id,
                &Self::run_key(scope.id, "observedLifecycleId"),
                &state
                    .lifecycle
                    .context("An active Goal requires its exact lifecycle sidecar.")?["id"],
            )?;
        } else {
            ctx.delete_value(scope.id, &Self::run_key(scope.id, "observedLifecycleId"))?;
        }
        Ok(())
    }
    fn after_inference(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        inference: &Inference<'_>,
    ) -> Result<()> {
        let state = match inference.outcome {
            happy_providers::Outcome::Normal { .. } => "normal",
            happy_providers::Outcome::ToolCall { .. } => "tool_call",
            happy_providers::Outcome::Length { .. } => "length",
            happy_providers::Outcome::Cancelled => "cancelled",
            happy_providers::Outcome::Error { .. } => "error",
        };
        ctx.put_value(
            scope.id,
            &Self::run_key(scope.id, "lastInference"),
            &json!({"state":state}),
        )
    }
    fn after_turn_transactional(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        _: &str,
        _: Option<&str>,
        aborted: bool,
    ) -> Result<()> {
        let inference = self.run_read(ctx, scope.id, "lastInference", "ownerGoalInference")?;
        if aborted
            || inference.as_ref().is_none_or(|inference| {
                inference["state"].is_null()
                    || matches!(inference["state"].as_str(), Some("cancelled" | "error"))
            })
        {
            self.pause(ctx, scope.id)?;
        }
        Ok(())
    }
    fn after_loop_transactional(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        _: &str,
    ) -> Result<()> {
        let Some(observed) =
            self.run_read(ctx, scope.id, "observedLifecycleId", "ownerGoalOperationId")?
        else {
            return Ok(());
        };
        let state = self.state(ctx, scope.id)?;
        let Some(goal) = state.goal.filter(|goal| goal["status"] == "active") else {
            return Ok(());
        };
        if state
            .lifecycle
            .as_ref()
            .is_none_or(|lifecycle| lifecycle["id"] != observed)
        {
            return Ok(());
        }
        let inference = self.run_read(ctx, scope.id, "lastInference", "ownerGoalInference")?;
        if inference
            .as_ref()
            .is_some_and(|inference| inference["state"] == "cancelled")
        {
            return Ok(());
        }
        if inference
            .as_ref()
            .is_none_or(|inference| inference["state"].is_null() || inference["state"] == "error")
        {
            let failures = state
                .failure_count
                .and_then(|value| value.as_u64())
                .unwrap_or(0)
                + 1;
            if failures < 3 {
                self.write(
                    ctx,
                    scope.id,
                    "failureCount",
                    &json!(failures),
                    "ownerGoalFailureCount",
                )?;
            } else {
                let mut goal = goal;
                goal["status"] = json!("blocked");
                goal["updatedAt"] = json!(now());
                self.write(ctx, scope.id, "goal", &goal, "ownerGoalRecord")?;
                self.deactivate(ctx, scope.id)?;
                self.publish(
                    ctx,
                    json!({"type":"goal_status_changed","agentId":scope.id,"goal":goal}),
                )?;
            }
            return Ok(());
        }
        self.delete(ctx, scope.id, "failureCount")?;
        let id = if let Some(id) =
            self.run_read(ctx, scope.id, "continuationId", "ownerGoalMessageId")?
        {
            id.as_str().unwrap().to_owned()
        } else {
            let id = format::hash(
                &self.schemas,
                &json!([
                    "goal-continuation",
                    scope.id,
                    uuid::Uuid::new_v4().to_string()
                ]),
            )?;
            ctx.put_value(
                scope.id,
                &Self::run_key(scope.id, "continuationId"),
                &json!(id),
            )?;
            id
        };
        self.enqueue(ctx, scope.id, &goal, &id)
    }
    fn metadata_changed(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        change: &Value,
    ) -> Result<()> {
        if self
            .schemas
            .valid("ownerGoalArchivedMetadata", &change["update"])?
        {
            self.pause(ctx, scope.id)?;
        }
        Ok(())
    }
}
