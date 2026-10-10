//! One installation's durable presence selection, catalog, and recurring windows.
use super::{
    agent_runtime::AgentRuntimeModule,
    config::ConfigModule,
    durable::DurableFunctionsModule,
    lifecycle::LifecycleModule,
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
};
use tokio::sync::watch;
mod calendar;
mod persistence;
mod tools;

pub type PresenceEventListener = Arc<dyn Fn(&Value) + Send + Sync>;
pub type PresenceTransactionalListener =
    Arc<dyn for<'a> Fn(&Context<'a>, &Value) -> Result<()> + Send + Sync>;
pub struct PresenceSubscription {
    owner: Weak<PresenceModule>,
    id: u64,
    transactional: bool,
}
impl Drop for PresenceSubscription {
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
pub struct PresenceModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    _durable: Arc<DurableFunctionsModule>,
    _lifecycle: Arc<LifecycleModule>,
    schemas: Schemas,
    configured: Vec<Value>,
    initial: Option<Value>,
    owner: Weak<Self>,
    listeners: Mutex<BTreeMap<u64, PresenceEventListener>>,
    transactional: Mutex<BTreeMap<u64, PresenceTransactionalListener>>,
    next_listener: AtomicU64,
    input_changes: watch::Sender<Option<Value>>,
}
impl PresenceModule {
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        lifecycle: Arc<LifecycleModule>,
        agents: Arc<AgentRuntimeModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        let configured = config.presence_configuration()?;
        let builtins: Vec<Value> = serde_json::from_str(include_str!("presence/catalog.json"))?;
        let mut definitions = Vec::new();
        for (id, fields) in configured["states"]
            .as_object()
            .context("The configured presence catalog is invalid.")?
        {
            let original = builtins.iter().find(|state| state["id"] == *id);
            let default = |field: &str, fallback: Value| {
                fields
                    .get(field)
                    .cloned()
                    .or_else(|| original.and_then(|original| original.get(field)).cloned())
                    .unwrap_or(fallback)
            };
            definitions.push(json!({"id":id,"status":original.map_or(json!("custom"),|original|original["status"].clone()),"title":default("title",json!(id)),"emoji":default("emoji",json!("🟣")),"prompt":default("prompt",json!("")),"answerWaitMs":default("answerWaitMs",json!(0))}));
        }
        anyhow::ensure!(
            schemas.valid("ownerPresenceCatalog", &json!(definitions))?,
            "Presence catalog is invalid."
        );
        let known = |id: &str| {
            builtins
                .iter()
                .chain(definitions.iter())
                .any(|state| state["id"] == id)
        };
        let mut ids = builtins
            .iter()
            .chain(definitions.iter())
            .filter_map(|state| state["id"].as_str())
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        anyhow::ensure!(
            ids.len() <= 64,
            "Presence settings define more than 64 states."
        );
        let initial = if let Some(current) = configured["current"].as_str() {
            anyhow::ensure!(
                known(current),
                "The configured current presence is not defined."
            );
            let mut state = json!({"presenceId":current});
            if let Some(until) = configured.get("until") {
                state["expiresAt"] = until.clone();
            }
            if let Some(fallback) = configured["fallback"].as_str() {
                anyhow::ensure!(
                    known(fallback),
                    "The configured fallback presence is not defined."
                );
                state["fallbackPresenceId"] = json!(fallback);
            } else if state.get("expiresAt").is_some() {
                state["fallbackPresenceId"] = json!("online");
            }
            persistence::validate_stored(&schemas, &state)?;
            Some(state)
        } else {
            None
        };
        let (changes, _) = watch::channel(None);
        let module = Arc::new_cyclic(|owner| Self {
            config,
            runtime,
            _durable: durable,
            _lifecycle: lifecycle,
            schemas,
            configured: definitions,
            initial,
            owner: owner.clone(),
            listeners: Mutex::new(BTreeMap::new()),
            transactional: Mutex::new(BTreeMap::new()),
            next_listener: AtomicU64::new(1),
            input_changes: changes,
        });
        agents.install(module.clone())?;
        Ok(module)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime
            .migrate("presence", persistence::MIGRATIONS)
            .await?;
        let owner = self.clone();
        self.runtime
            .transact(move |ctx| {
                if persistence::read(ctx, &owner.schemas)?.is_none() {
                    if let Some(initial) = &owner.initial {
                        owner.assert_selection(ctx, initial)?;
                        persistence::write(ctx, &owner.schemas, initial)?;
                    }
                }
                Ok(())
            })
            .await
    }
    pub fn on_event(
        self: &Arc<Self>,
        listener: PresenceEventListener,
    ) -> Result<PresenceSubscription> {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The presence listener bound was reached."
        );
        let id = self.next_listener.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(PresenceSubscription {
            owner: Arc::downgrade(self),
            id,
            transactional: false,
        })
    }
    pub fn on_event_transactional(
        self: &Arc<Self>,
        listener: PresenceTransactionalListener,
    ) -> Result<PresenceSubscription> {
        let mut listeners = self
            .transactional
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The presence listener bound was reached."
        );
        let id = self.next_listener.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(PresenceSubscription {
            owner: Arc::downgrade(self),
            id,
            transactional: true,
        })
    }
    pub fn subscribe_user_input(&self) -> watch::Receiver<Option<Value>> {
        self.input_changes.subscribe()
    }
    pub fn list_presences(&self, ctx: &Context<'_>) -> Result<Vec<Value>> {
        self.runtime.assert_context(ctx)?;
        let mut catalog: Vec<Value> = serde_json::from_str(include_str!("presence/catalog.json"))?;
        for definition in self
            .configured
            .iter()
            .cloned()
            .chain(persistence::catalog(ctx, &self.schemas)?)
        {
            if let Some(existing) = catalog
                .iter_mut()
                .find(|existing| existing["id"] == definition["id"])
            {
                *existing = definition;
            } else {
                catalog.push(definition);
            }
        }
        anyhow::ensure!(catalog.len() <= 64, "Presence catalog exceeds its bound.");
        Ok(catalog)
    }
    fn assert_selection(&self, ctx: &Context<'_>, state: &Value) -> Result<()> {
        let catalog = self.list_presences(ctx)?;
        for field in ["presenceId", "fallbackPresenceId"] {
            if let Some(id) = state[field].as_str() {
                anyhow::ensure!(
                    catalog.iter().any(|definition| definition["id"] == id),
                    "There is no presence called \"{id}\"."
                );
            }
        }
        Ok(())
    }
    fn materialize(&self, ctx: &Context<'_>, stored: &Value) -> Result<Value> {
        let catalog = self.list_presences(ctx)?;
        let id = stored["presenceId"].as_str().unwrap();
        let definition = catalog
            .iter()
            .find(|definition| definition["id"] == id)
            .context("The presence definition is not configured.")?;
        let mut state = definition.clone();
        state.as_object_mut().unwrap().remove("id");
        state["presenceId"] = json!(id);
        for field in [
            "message",
            "effectiveFrom",
            "expiresAt",
            "fallbackPresenceId",
        ] {
            if let Some(value) = stored.get(field) {
                state[field] = value.clone();
            }
        }
        if let Some(expires) = stored.get("expiresAt") {
            state["changesAt"] = expires.clone();
        }
        if let Some(fallback) = stored.get("fallbackPresenceId") {
            state["fallback"] = json!({"presenceId":fallback});
        }
        anyhow::ensure!(
            self.schemas.valid("ownerPresenceState", &state)?,
            "Presence state is invalid."
        );
        Ok(state)
    }
    fn read_at(&self, ctx: &Context<'_>, at: u64) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        if let Some(configured) = persistence::read(ctx, &self.schemas)? {
            if configured["effectiveFrom"]
                .as_u64()
                .is_some_and(|from| at < from)
            {
                return Ok(None);
            }
            if let Some(expires) = configured["expiresAt"]
                .as_u64()
                .filter(|expires| at >= *expires)
            {
                return configured["fallbackPresenceId"]
                    .as_str()
                    .map(|id| {
                        self.materialize(ctx, &json!({"presenceId":id,"effectiveFrom":expires}))
                    })
                    .transpose();
            }
            return self.materialize(ctx, &configured).map(Some);
        }
        for schedule in persistence::schedules(ctx, &self.schemas)? {
            if calendar::effective(&schedule, at)? {
                let reference = &schedule["presence"];
                let mut stored = json!({"presenceId":reference["presenceId"].as_str().or_else(||reference["status"].as_str()).unwrap()});
                if let Some(message) = reference.get("message") {
                    stored["message"] = message.clone();
                }
                return self.materialize(ctx, &stored).map(Some);
            }
        }
        Ok(None)
    }
    pub fn read(&self, ctx: &Context<'_>) -> Result<Option<Value>> {
        self.read_at(ctx, super::identity::now())
    }
    /// Configuration clients receive the effective state and the complete owner catalog.
    pub fn public_configuration(&self, ctx: &Context<'_>) -> Result<Value> {
        let configured = self.config.presence_configuration()?;
        let effective = self.read(ctx)?;
        let current = effective.as_ref().and_then(|state| state["presenceId"].as_str()).or_else(|| configured["current"].as_str()).unwrap_or("online");
        let fallback = effective.as_ref().and_then(|state| state["fallbackPresenceId"].as_str()).or_else(|| configured["fallback"].as_str()).unwrap_or("online");
        let states = self.list_presences(ctx)?.into_iter().map(|state| {
            let id = state["id"].as_str().context("The presence identity is missing.")?.to_owned();
            Ok((id, json!({"title":state["title"],"emoji":state["emoji"],"prompt":state["prompt"],"answerWaitMs":state["answerWaitMs"]})))
        }).collect::<Result<serde_json::Map<String,Value>>>()?;
        Ok(json!({"current":current,"fallback":fallback,"states":states}))
    }
    pub fn user_input_state(&self, ctx: &Context<'_>) -> Result<Option<Value>> {
        self.read(ctx)?.map(|state|{let mut projected=json!({"answerWaitMs":state["answerWaitMs"],"title":state["title"],"emoji":state["emoji"],"prompt":state["prompt"]});if let Some(expires)=state.get("expiresAt"){projected["changesAt"]=expires.clone();}anyhow::ensure!(self.schemas.valid("ownerPresenceUserInput",&projected)?,"Presence user-input state is invalid.");Ok(projected)}).transpose()
    }
    fn publish(&self, ctx: &Context<'_>, mut event: Value) -> Result<()> {
        event["eventId"] = json!(uuid::Uuid::new_v4().to_string());
        event["at"] = json!(super::identity::now());
        anyhow::ensure!(
            self.schemas.valid("ownerPresenceEvent", &event)?,
            "The presence event is invalid."
        );
        let listeners = self
            .transactional
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for listener in listeners {
            listener(ctx, &event)?;
        }
        let current = self.user_input_state(ctx)?;
        let owner = self.owner.clone();
        ctx.after_commit(move || {
            if let Some(owner) = owner.upgrade() {
                owner.input_changes.send_replace(current);
                let listeners = owner
                    .listeners
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .values()
                    .cloned()
                    .collect::<Vec<_>>();
                for listener in listeners {
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(&event)))
                        .is_err()
                    {
                        tracing::warn!("A presence listener failed after the change was saved.");
                    }
                }
            }
        })
    }
    pub fn set_presence(&self, ctx: &Context<'_>, input: &Value) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let is_tool = self.schemas.valid("ownerPresenceToolInput", input)?;
        anyhow::ensure!(
            is_tool || self.schemas.valid("ownerPresenceMutation", input)?,
            "Presence mutation input is invalid."
        );
        let at = super::identity::now();
        let id = input["presenceId"]
            .as_str()
            .or_else(|| input["status"].as_str())
            .unwrap();
        let mut requested = json!({"presenceId":id});
        for field in [
            "message",
            "effectiveFrom",
            "expiresAt",
            "fallbackPresenceId",
        ] {
            if let Some(value) = input.get(field) {
                requested[field] = value.clone();
            }
        }
        if is_tool {
            requested.as_object_mut().unwrap().remove("effectiveFrom");
            requested.as_object_mut().unwrap().remove("expiresAt");
            if let Some(until) = input.get("until") {
                requested["expiresAt"] = until.clone();
            }
        }
        if let Some(fallback) = input.get("fallback") {
            let id = fallback["presenceId"]
                .as_str()
                .or_else(|| fallback["status"].as_str())
                .unwrap();
            anyhow::ensure!(
                requested["fallbackPresenceId"]
                    .as_str()
                    .is_none_or(|existing| existing == id),
                "Presence fallback IDs disagree."
            );
            requested["fallbackPresenceId"] = json!(id);
        }
        if let Some(expires) = requested["expiresAt"].as_u64() {
            anyhow::ensure!(expires > at, "A presence must expire in the future.");
            if requested.get("effectiveFrom").is_none() {
                requested["effectiveFrom"] = json!(at);
            }
            if requested.get("fallbackPresenceId").is_none() {
                requested["fallbackPresenceId"] = json!("online");
            }
        }
        persistence::validate_stored(&self.schemas, &requested)?;
        self.assert_selection(ctx, &requested)?;
        let current = self.materialize(ctx, &requested)?;
        let previous = persistence::read(ctx, &self.schemas)?;
        if previous.as_ref() != Some(&requested) {
            persistence::write(ctx, &self.schemas, &requested)?;
            let previous = previous
                .map(|previous| self.materialize(ctx, &previous))
                .transpose()?
                .unwrap_or(Value::Null);
            self.publish(
                ctx,
                json!({"type":"presence_changed","previous":previous,"current":current}),
            )?;
        }
        Ok(current)
    }
    pub fn clear(&self, ctx: &Context<'_>) -> Result<bool> {
        self.runtime.assert_context(ctx)?;
        let Some(previous) = persistence::read(ctx, &self.schemas)? else {
            return Ok(false);
        };
        let previous = self.materialize(ctx, &previous)?;
        ctx.database()
            .execute("DELETE FROM happy_agent_presence WHERE singleton_id=1", [])?;
        self.publish(ctx, json!({"type":"presence_cleared","previous":previous}))?;
        Ok(true)
    }
    pub fn set_definition(&self, ctx: &Context<'_>, definition: &Value) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("ownerPresenceDefinition", definition)?,
            "Presence definition is invalid."
        );
        let id = definition["id"].as_str().unwrap();
        anyhow::ensure!(
            !["online", "away", "offline", "dnd"].contains(&id),
            "Built-in presence definitions cannot be replaced."
        );
        let catalog = self.list_presences(ctx)?;
        let existing = catalog.iter().find(|existing| existing["id"] == id);
        if existing == Some(definition) {
            return Ok(definition.clone());
        }
        anyhow::ensure!(
            existing.is_some() || catalog.len() < 64,
            "Presence catalog limit reached."
        );
        persistence::write_definition(ctx, definition)?;
        self.publish(
            ctx,
            json!({"type":"presence_definition_set","definition":definition}),
        )?;
        Ok(definition.clone())
    }
    pub fn clear_definition(&self, ctx: &Context<'_>, id: &str) -> Result<bool> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("ownerPresenceId", &json!(id))?,
            "Presence ID is invalid."
        );
        anyhow::ensure!(
            !["online", "away", "offline", "dnd"].contains(&id)
                && !self.configured.iter().any(|state| state["id"] == id),
            "Configured presence definitions cannot be cleared."
        );
        if let Some(current) = persistence::read(ctx, &self.schemas)? {
            anyhow::ensure!(
                current["presenceId"] != id,
                "The active presence definition cannot be cleared."
            );
            anyhow::ensure!(
                current["fallbackPresenceId"] != id,
                "This presence is the fallback of the current presence and cannot be cleared."
            );
        }
        anyhow::ensure!(
            !persistence::schedules(ctx, &self.schemas)?
                .iter()
                .any(|schedule| schedule["presence"]["presenceId"] == id
                    || schedule["presence"]["status"] == id),
            "This presence is used by a schedule and cannot be cleared."
        );
        let removed = ctx
            .database()
            .execute("DELETE FROM happy_agent_presence_catalog WHERE id=?1", [id])?
            > 0;
        if removed {
            self.publish(
                ctx,
                json!({"type":"presence_definition_cleared","presenceId":id}),
            )?;
        }
        Ok(removed)
    }
    pub fn list_schedules(&self, ctx: &Context<'_>) -> Result<Vec<Value>> {
        self.runtime.assert_context(ctx)?;
        let schedules = persistence::schedules(ctx, &self.schemas)?;
        for schedule in &schedules {
            let days = schedule["days"].as_array().unwrap();
            anyhow::ensure!(
                days.windows(2)
                    .all(|pair| pair[0].as_u64() < pair[1].as_u64()),
                "Presence schedule days must use canonical ascending order."
            );
        }
        Ok(schedules)
    }
    pub fn set_schedule(&self, ctx: &Context<'_>, input: &Value) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("ownerPresenceScheduleInput", input)?,
            "Presence schedule input is invalid."
        );
        calendar::zone(input["timeZone"].as_str().unwrap())?;
        let mut requested = input.clone();
        requested["days"]
            .as_array_mut()
            .unwrap()
            .sort_by_key(|value| value.as_u64());
        let reference=requested["presence"].clone();
        requested["presence"]=if let Some(id)=reference.get("presenceId"){json!({"presenceId":id})}else{json!({"status":reference["status"]})};
        if let Some(message)=reference.get("message"){requested["presence"]["message"]=message.clone();}
        let id = requested["presence"]["presenceId"]
            .as_str()
            .or_else(|| requested["presence"]["status"].as_str())
            .unwrap();
        self.assert_selection(ctx, &json!({"presenceId":id}))?;
        let existing = self.list_schedules(ctx)?;
        if let Some(duplicate) = existing.iter().find(|schedule| {
            ["days","startTime","endTime","timeZone"].iter().all(|field|schedule[*field]==requested[*field])
                && schedule["presence"]["presenceId"].as_str().or_else(||schedule["presence"]["status"].as_str())==Some(id)
                && schedule["presence"].get("message")==requested["presence"].get("message")
        }) {
            return Ok(duplicate.clone());
        }
        anyhow::ensure!(existing.len() < 64, "Presence schedule limit reached.");
        requested["id"] = json!(uuid::Uuid::new_v4().to_string());
        persistence::write_schedule(ctx, &requested)?;
        self.publish(
            ctx,
            json!({"type":"presence_schedule_set","schedule":requested}),
        )?;
        Ok(requested)
    }
    pub fn clear_schedule(&self, ctx: &Context<'_>, id: &str) -> Result<bool> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("ownerPresenceId", &json!(id))?,
            "Presence schedule ID is invalid."
        );
        let removed = ctx.database().execute(
            "DELETE FROM happy_agent_presence_schedules WHERE id=?1",
            [id],
        )? > 0;
        if removed {
            self.publish(
                ctx,
                json!({"type":"presence_schedule_cleared","scheduleId":id}),
            )?;
        }
        Ok(removed)
    }
}

#[async_trait]
impl AgentModule for PresenceModule {
    fn name(&self) -> &'static str {
        "presence"
    }
    fn tools(&self, _: &AgentScope<'_>) -> Vec<happy_providers::ToolDefinition> {
        tools::definitions()
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|tool| tool.name != "set_presence")
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|_| true)
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
        self.execute_presence_tool(ctx, scope, call)
    }
    async fn instructions(&self, _: &AgentScope<'_>) -> Result<String> {
        let owner = self
            .owner
            .upgrade()
            .context("The presence module was closed.")?;
        let state = self.runtime.transact(move |ctx| owner.read(ctx)).await?;
        Ok(state.map_or(String::new(), |state| {
            let message = state["message"].as_str().map_or(String::new(), |message| {
                format!(" The user's status message is: {message}.")
            });
            let prompt = state["prompt"].as_str().unwrap().trim();
            format!(
                "Current user presence: {} {}.{message}{}",
                state["title"].as_str().unwrap(),
                state["emoji"].as_str().unwrap(),
                if prompt.is_empty() {
                    String::new()
                } else {
                    format!(" {prompt}")
                }
            )
        }))
    }
}
