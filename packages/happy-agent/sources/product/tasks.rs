//! The original bounded, per-agent persistent task dependency graph.
use super::{
    agent_runtime::AgentRuntimeModule,
    durable::DurableFunctionsModule,
    identity::now,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope};
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
mod graph;
mod tools;
#[derive(Debug)]
pub struct TaskValidationError(String);
impl std::fmt::Display for TaskValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for TaskValidationError {}
fn require(condition: bool, message: impl Into<String>) -> Result<()> {
    if !condition {
        return Err(TaskValidationError(message.into()).into());
    }
    Ok(())
}
pub type TaskEventListener = Arc<dyn Fn(&Value) + Send + Sync>;
pub type TaskTransactionalListener =
    Arc<dyn for<'a> Fn(&Context<'a>, &Value) -> Result<()> + Send + Sync>;
pub struct TaskSubscription {
    owner: Weak<TasksModule>,
    id: u64,
    transactional: bool,
}
impl Drop for TaskSubscription {
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
pub struct TasksModule {
    runtime: Arc<RuntimeModule>,
    _durable: Arc<DurableFunctionsModule>,
    schemas: Schemas,
    owner: Weak<Self>,
    listeners: Mutex<BTreeMap<u64, TaskEventListener>>,
    transactional: Mutex<BTreeMap<u64, TaskTransactionalListener>>,
    next: AtomicU64,
}
const MIGRATIONS: &[(&str, &str)] = &[(
    "001-task-state",
    "CREATE TABLE IF NOT EXISTS happy_agent_task_state(agent_id TEXT PRIMARY KEY,tasks_json TEXT NOT NULL);",
)];
impl TasksModule {
    pub fn new(
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        agents: Arc<AgentRuntimeModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        let module = Arc::new_cyclic(|owner| Self {
            runtime,
            _durable: durable,
            schemas,
            owner: owner.clone(),
            listeners: Mutex::new(BTreeMap::new()),
            transactional: Mutex::new(BTreeMap::new()),
            next: AtomicU64::new(1),
        });
        agents.install(module.clone())?;
        Ok(module)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime.migrate("tasks", MIGRATIONS).await
    }
    pub fn on_event(self: &Arc<Self>, listener: TaskEventListener) -> Result<TaskSubscription> {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(listeners.len() < 64, "The task listener bound was reached.");
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(TaskSubscription {
            owner: Arc::downgrade(self),
            id,
            transactional: false,
        })
    }
    pub fn on_event_transactional(
        self: &Arc<Self>,
        listener: TaskTransactionalListener,
    ) -> Result<TaskSubscription> {
        let mut listeners = self
            .transactional
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(listeners.len() < 64, "The task listener bound was reached.");
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(TaskSubscription {
            owner: Arc::downgrade(self),
            id,
            transactional: true,
        })
    }
    fn agent(&self, ctx: &Context<'_>, agent: &str) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        require(
            self.schemas.valid("ownerTaskAgentId", &json!(agent))?,
            "Task agent ID is invalid.",
        )
    }
    fn id(&self, id: &str) -> Result<()> {
        require(
            self.schemas.valid("ownerTaskId", &json!(id))?,
            "Task ID is invalid.",
        )
    }
    fn input(&self, name: &str, input: &Value, action: &str) -> Result<()> {
        if let Some(metadata) = input.get("metadata") {
            graph::metadata(metadata)?;
        }
        require(
            self.schemas.valid(name, input)?,
            format!("Invalid task {action} input."),
        )
    }
    pub fn list(&self, ctx: &Context<'_>, agent: &str) -> Result<Vec<Value>> {
        self.agent(ctx, agent)?;
        let encoded = ctx
            .database()
            .query_row(
                "SELECT tasks_json FROM happy_agent_task_state WHERE agent_id=?1 LIMIT 1",
                [agent],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(encoded) = encoded else {
            return Ok(Vec::new());
        };
        anyhow::ensure!(
            encoded.len() <= 4 * 1024 * 1024,
            "The stored task list exceeds its byte bound."
        );
        let value: Value = serde_json::from_str(&encoded)?;
        anyhow::ensure!(
            self.schemas.valid("ownerTaskList", &value)?,
            "The stored task list is invalid."
        );
        let mut tasks = value.as_array().unwrap().clone();
        graph::validate(&self.schemas, &tasks)?;
        tasks.sort_by_key(|task| task["ordering"].as_u64().unwrap());
        Ok(tasks)
    }
    fn commit(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        tasks: &[Value],
        mut event: Value,
        at: u64,
    ) -> Result<()> {
        graph::validate(&self.schemas, tasks)?;
        ctx.database().execute("INSERT INTO happy_agent_task_state(agent_id,tasks_json) VALUES(?1,?2) ON CONFLICT(agent_id) DO UPDATE SET tasks_json=excluded.tasks_json",rusqlite::params![agent,json!(tasks).to_string()])?;
        event["agentId"] = json!(agent);
        event["eventId"] = json!(uuid::Uuid::new_v4().to_string());
        event["at"] = json!(at);
        anyhow::ensure!(
            self.schemas.valid("ownerTaskEvent", &event)?,
            "Tasks module created an invalid event."
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
        ctx.after_commit(move||{for listener in listeners{if std::panic::catch_unwind(std::panic::AssertUnwindSafe(||listener(&event))).is_err(){tracing::warn!(event_id=%event["eventId"],"A task subscriber failed after commit.");}}})
    }
    pub fn get(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<Option<Value>> {
        self.id(id)?;
        Ok(self
            .list(ctx, agent)?
            .into_iter()
            .find(|task| task["id"] == id))
    }
    pub fn create(&self, ctx: &Context<'_>, agent: &str, input: &Value) -> Result<Value> {
        self.agent(ctx, agent)?;
        self.input("ownerTaskCreate", input, "create")?;
        let id = input["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        self.id(&id)?;
        let mut tasks = self.list(ctx, agent)?;
        require(
            !tasks.iter().any(|task| task["id"] == id),
            format!("Task \"{id}\" already exists."),
        )?;
        require(
            tasks.len() < 100,
            "This agent already has the maximum of 100 tasks.",
        )?;
        let depends = input["dependsOn"].as_array().cloned().unwrap_or_default();
        graph::dependencies(&tasks, &id, &depends)?;
        let at = now();
        let mut task = json!({"id":id,"title":graph::normalized(&self.schemas,"title",&input["title"])?.unwrap(),"blocks":[],"dependsOn":depends,"status":"pending","priority":input.get("priority").cloned().unwrap_or(json!("normal")),"createdAt":at,"updatedAt":at,"ordering":tasks.len()});
        for field in ["detail", "activeForm", "owner"] {
            if let Some(value) = input.get(field) {
                if let Some(value) = graph::normalized(&self.schemas, field, value)? {
                    task[field] = value;
                }
            }
        }
        if let Some(metadata) = input.get("metadata") {
            task["metadata"] = metadata.clone();
        }
        tasks.push(task);
        graph::sync(&mut tasks);
        let task = tasks.last().unwrap().clone();
        self.commit(
            ctx,
            agent,
            &tasks,
            json!({"type":"task_created","task":task}),
            at,
        )?;
        Ok(task)
    }
    pub fn update(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        id: &str,
        changes: &Value,
    ) -> Result<Value> {
        self.agent(ctx, agent)?;
        self.id(id)?;
        self.input("ownerTaskUpdate", changes, "update")?;
        let mut tasks = self.list(ctx, agent)?;
        let original = tasks.clone();
        let index = tasks
            .iter()
            .position(|task| task["id"] == id)
            .ok_or_else(|| TaskValidationError(format!("Task \"{id}\" does not exist.")))?;
        for field in ["title", "detail", "activeForm", "owner"] {
            if let Some(value) = changes.get(field) {
                if let Some(value) = graph::normalized(&self.schemas, field, value)? {
                    tasks[index][field] = value;
                } else {
                    tasks[index].as_object_mut().unwrap().remove(field);
                }
            }
        }
        for field in ["priority", "status", "dependsOn"] {
            if let Some(value) = changes.get(field) {
                tasks[index][field] = value.clone();
            }
        }
        if let Some(patch) = changes["metadata"].as_object() {
            let mut metadata = tasks[index]["metadata"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            for (key, value) in patch {
                if value.is_null() {
                    metadata.remove(key);
                } else {
                    metadata.insert(key.clone(), value.clone());
                }
            }
            graph::metadata(&json!(metadata))?;
            tasks[index]["metadata"] = json!(metadata);
        }
        for field in [
            "dependsOn",
            "addBlockedBy",
            "removeBlockedBy",
            "addBlocks",
            "removeBlocks",
        ] {
            if let Some(values) = changes[field].as_array() {
                graph::dependencies(&tasks, id, values)?;
            }
        }
        if let Some(additions) = changes["addBlockedBy"].as_array() {
            graph::append(tasks[index]["dependsOn"].as_array_mut().unwrap(), additions);
        }
        if let Some(removals) = changes["removeBlockedBy"].as_array() {
            tasks[index]["dependsOn"]
                .as_array_mut()
                .unwrap()
                .retain(|value| !removals.contains(value));
        }
        for (field, add) in [("addBlocks", true), ("removeBlocks", false)] {
            if let Some(blocked) = changes[field].as_array() {
                for blocked in blocked {
                    let target = tasks
                        .iter_mut()
                        .find(|task| task["id"] == *blocked)
                        .unwrap();
                    let dependencies = target["dependsOn"].as_array_mut().unwrap();
                    if add {
                        graph::append(dependencies, &[json!(id)]);
                    } else {
                        dependencies.retain(|dependency| dependency != id);
                    }
                }
            }
        }
        if tasks
            .iter()
            .zip(&original)
            .all(|(left, right)| graph::same_task(left, right))
        {
            return Ok(original[index].clone());
        }
        let at = now();
        for (task, before) in tasks.iter_mut().zip(&original) {
            if !graph::same_task(task, before) {
                task["updatedAt"] = json!(at);
            }
        }
        graph::sync(&mut tasks);
        graph::validate(&self.schemas, &tasks)?;
        let task = tasks[index].clone();
        let event = if task["status"] == "completed" && original[index]["status"] != "completed" {
            json!({"type":"task_completed","task":task})
        } else {
            json!({"type":"task_updated","task":task,"changes":changes})
        };
        self.commit(ctx, agent, &tasks, event, at)?;
        Ok(task)
    }
    pub fn complete(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<Value> {
        self.agent(ctx, agent)?;
        self.id(id)?;
        let mut tasks = self.list(ctx, agent)?;
        let index = tasks
            .iter()
            .position(|task| task["id"] == id)
            .ok_or_else(|| TaskValidationError(format!("Task \"{id}\" does not exist.")))?;
        if tasks[index]["status"] == "completed" {
            return Ok(tasks[index].clone());
        }
        let at = now();
        tasks[index]["status"] = json!("completed");
        tasks[index]["updatedAt"] = json!(at);
        let task = tasks[index].clone();
        self.commit(
            ctx,
            agent,
            &tasks,
            json!({"type":"task_completed","task":task}),
            at,
        )?;
        Ok(task)
    }
    pub fn remove(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<bool> {
        self.agent(ctx, agent)?;
        self.id(id)?;
        let mut tasks = self.list(ctx, agent)?;
        let length = tasks.len();
        tasks.retain(|task| task["id"] != id);
        if tasks.len() == length {
            return Ok(false);
        }
        let at = now();
        graph::compact(&mut tasks, at);
        for task in &mut tasks {
            let dependencies = task["dependsOn"].as_array_mut().unwrap();
            let before = dependencies.len();
            dependencies.retain(|dependency| dependency != id);
            if before != dependencies.len() {
                task["updatedAt"] = json!(at);
            }
        }
        graph::sync(&mut tasks);
        self.commit(
            ctx,
            agent,
            &tasks,
            json!({"type":"task_removed","taskId":id}),
            at,
        )?;
        Ok(true)
    }
    pub fn reorder(&self, ctx: &Context<'_>, agent: &str, ids: &Value) -> Result<Vec<Value>> {
        self.agent(ctx, agent)?;
        require(
            self.schemas.valid("ownerTaskReorder", ids)?,
            "Task reorder expects a unique bounded list of task IDs.",
        )?;
        let tasks = self.list(ctx, agent)?;
        let ids = ids.as_array().unwrap();
        require(
            ids.len() == tasks.len(),
            "Task reorder must include every current task exactly once.",
        )?;
        let at = now();
        let mut reordered = Vec::new();
        for (index, id) in ids.iter().enumerate() {
            let mut task = tasks
                .iter()
                .find(|task| task["id"] == *id)
                .cloned()
                .ok_or_else(|| {
                    TaskValidationError(format!(
                        "Task \"{}\" does not exist.",
                        id.as_str().unwrap()
                    ))
                })?;
            if task["ordering"] != index {
                task["ordering"] = json!(index);
                task["updatedAt"] = json!(at);
            }
            reordered.push(task);
        }
        graph::sync(&mut reordered);
        if reordered
            .iter()
            .zip(&tasks)
            .all(|(left, right)| left["id"] == right["id"])
        {
            return Ok(tasks);
        }
        self.commit(
            ctx,
            agent,
            &reordered,
            json!({"type":"tasks_reordered","tasks":reordered}),
            at,
        )?;
        Ok(reordered)
    }
    pub fn reset(&self, ctx: &Context<'_>, agent: &str) -> Result<usize> {
        self.agent(ctx, agent)?;
        let tasks = self.list(ctx, agent)?;
        if tasks.is_empty() {
            return Ok(0);
        }
        self.commit(
            ctx,
            agent,
            &[],
            json!({"type":"tasks_reset","removed":tasks.len()}),
            now(),
        )?;
        Ok(tasks.len())
    }
    pub fn list_page(&self, ctx: &Context<'_>, agent: &str, query: &Value) -> Result<Value> {
        self.agent(ctx, agent)?;
        require(
            self.schemas.valid("ownerTaskPageQuery", query)?,
            "Invalid task page query.",
        )?;
        let tasks = self.list(ctx, agent)?;
        let offset = query["offset"].as_u64().unwrap_or(0) as usize;
        let limit = query["limit"].as_u64().unwrap_or(50) as usize;
        let completed = tasks
            .iter()
            .filter(|task| task["status"] == "completed")
            .map(|task| task["id"].clone())
            .collect::<Vec<_>>();
        let mut visible = Vec::new();
        for task in tasks.iter().skip(offset).take(limit) {
            let mut task = task.clone();
            task["dependsOn"]
                .as_array_mut()
                .unwrap()
                .retain(|dependency| !completed.contains(dependency));
            let candidate = visible
                .iter()
                .chain(std::iter::once(&task))
                .collect::<Vec<_>>();
            let suffix = if offset + candidate.len() < tasks.len() {
                format!("\nMore tasks start at offset {}.", offset + candidate.len())
            } else {
                String::new()
            };
            let text = format!(
                "{}{suffix}",
                candidate
                    .into_iter()
                    .map(|task| format::row(task))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            if format::length(&text) > 12000 {
                break;
            }
            visible.push(task);
        }
        anyhow::ensure!(
            offset >= tasks.len() || !visible.is_empty(),
            "The task output bound is too small to show one task identity."
        );
        let next = offset + visible.len();
        let mut page = json!({"tasks":visible,"offset":offset,"limit":limit,"total":tasks.len()});
        if next < tasks.len() {
            page["nextOffset"] = json!(next);
        }
        anyhow::ensure!(
            self.schemas.valid("ownerTaskPage", &page)?,
            "Tasks module created an invalid task page."
        );
        Ok(page)
    }
    pub fn get_page(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        id: &str,
        query: &Value,
    ) -> Result<Value> {
        self.agent(ctx, agent)?;
        self.id(id)?;
        require(
            self.schemas.valid("ownerTaskDetailQuery", query)?,
            "Invalid task detail query.",
        )?;
        let Some(task) = self.get(ctx, agent, id)? else {
            return Ok(json!({"task":null}));
        };
        let detail = task["detail"].as_str().unwrap_or("");
        let detail_total = format::length(detail);
        let detail_offset = query["detailOffset"].as_u64().unwrap_or(0) as usize;
        let detail_limit = query["detailLimit"]
            .as_u64()
            .unwrap_or(detail_total.clamp(1, 1024) as u64) as usize;
        let dependencies = task["dependsOn"].as_array().unwrap();
        let dependency_offset = query["dependencyOffset"].as_u64().unwrap_or(0) as usize;
        let dependency_limit = query["dependencyLimit"].as_u64().unwrap_or(64) as usize;
        let mut page = json!({"task":task,"detail":format::slice(detail,detail_offset,detail_limit),"detailOffset":detail_offset,"detailTotal":detail_total,"dependencies":dependencies.iter().skip(dependency_offset).take(dependency_limit).cloned().collect::<Vec<_>>(),"dependencyOffset":dependency_offset,"dependencyTotal":dependencies.len()});
        format::fit_detail_page(&mut page)?;
        anyhow::ensure!(
            self.schemas.valid("ownerTaskDetailPage", &page)?,
            "Tasks module created an invalid task detail page."
        );
        Ok(page)
    }
    pub fn format_for_model(&self, tasks: &[Value]) -> String {
        format::tasks(tasks)
    }
    pub fn format_page_for_model(&self, page: &Value) -> Result<String> {
        anyhow::ensure!(
            self.schemas.valid("ownerTaskPage", page)?,
            "Cannot format an invalid task page."
        );
        format::page(page)
    }
    pub fn format_detail_page_for_model(&self, page: &Value) -> Result<String> {
        anyhow::ensure!(
            self.schemas.valid("ownerTaskDetailPage", page)?,
            "Cannot format an invalid task detail page."
        );
        format::detail(page, 12000)
    }
    pub fn format_mutation_for_model(&self, text: &str) -> String {
        format::mutation(text)
    }
}
#[async_trait]
impl AgentModule for TasksModule {
    fn name(&self) -> &'static str {
        "tasks"
    }
    fn tools(&self, _: &AgentScope<'_>) -> Vec<happy_providers::ToolDefinition> {
        tools::definitions()
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|_| true)
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|tool| matches!(tool.name.as_str(), "get_task" | "list_tasks"))
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
        self.execute_task_tool(ctx, scope, call)
    }
}
