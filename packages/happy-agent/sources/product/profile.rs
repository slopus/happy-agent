//! The existing singleton profile, with private identity and transactional changes.
use super::{
    agent_runtime::AgentRuntimeModule,
    bots::BotsModule,
    config::ConfigModule,
    durable::DurableFunctionsModule,
    identity::now,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result, ensure};
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope, ToolPermissionPolicy};
use happy_providers::{Block, Message, ToolDefinition};
use rand::Rng;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, OnceLock, Weak};
mod photo;
pub use photo::ProfilePhotoAsset;
const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-profile",
        "CREATE TABLE IF NOT EXISTS happy_agent_profile(singleton_id INTEGER PRIMARY KEY,profile_json TEXT NOT NULL);",
    ),
    (
        "002-profile-photo",
        "CREATE TABLE IF NOT EXISTS happy_agent_profile_photo(singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),photo_bytes BLOB NOT NULL,content_type TEXT NOT NULL,content_hash TEXT NOT NULL,thumbhash TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL);",
    ),
];
pub type ProfileEventListener = Arc<dyn Fn(&Value, &Value) -> Result<()> + Send + Sync>;
pub type ProfileTransactionalListener =
    Arc<dyn for<'a> Fn(&Context<'a>, &Value, &Value) -> Result<()> + Send + Sync>;
pub struct ProfileSubscription {
    owner: Weak<ProfileModule>,
    id: u64,
}
impl Drop for ProfileSubscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            owner
                .listeners
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&self.id);
            owner
                .transactional
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&self.id);
        }
    }
}
pub struct ProfileModule {
    config: Arc<ConfigModule>,
    bots: Arc<BotsModule>,
    runtime: Arc<RuntimeModule>,
    _durable: Arc<DurableFunctionsModule>,
    schemas: Schemas,
    instance: OnceLock<String>,
    listeners: Mutex<std::collections::BTreeMap<u64, ProfileEventListener>>,
    next_listener: std::sync::atomic::AtomicU64,
    transactional: Mutex<std::collections::BTreeMap<u64, ProfileTransactionalListener>>,
}
#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("The profile version changed.")]
    Conflict(Value),
    #[error("{0}")]
    Invalid(String),
}
fn definitions() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("profile/tool_definitions.json"))
        .expect("The Source profile tool array is valid.")
}
fn selected(call: &Value) -> bool {
    call["call"]["name"] == "get_local_profile"
        && call["call"].get("namespace").is_none_or(Value::is_null)
}
fn resource(profile: &Value) -> Value {
    if profile.is_null() {
        return json!({"userId":null,"name":null,"email":null,"photo":null,"version":super::identity::resource_version(0,1,"profile"),"updatedAt":0});
    }
    json!({"userId":null,"name":profile["name"],"email":profile["email"],"photo":if profile["photo"].is_null(){Value::Null}else{json!({"thumbhash":profile["photo"]["thumbhash"]})},"version":profile["version"],"updatedAt":profile["updatedAt"]})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_values_versions_and_public_projection_match_original_source() {
        let source: Value =
            serde_json::from_str(include_str!("profile/source_goldens.json")).unwrap();
        let schemas = Schemas::new().unwrap();
        for case in source["validations"].as_array().unwrap() {
            assert_eq!(
                schemas
                    .valid(case["schema"].as_str().unwrap(), &case["value"])
                    .unwrap(),
                case["valid"].as_bool().unwrap(),
                "{case}"
            );
        }
        for case in source["versions"].as_array().unwrap() {
            assert_eq!(
                version(case["previous"].as_str(), case["now"].as_u64().unwrap()).unwrap(),
                case["result"].as_str().unwrap()
            );
        }
        for case in source["projections"].as_array().unwrap() {
            assert_eq!(resource(&case["profile"]), case["result"]);
        }
    }
}
fn version(previous: Option<&str>, at: u64) -> Result<String> {
    const MASK: u128 = (1u128 << 74) - 1;
    const LOW: u128 = (1u128 << 62) - 1;
    let prior = previous
        .map(uuid::Uuid::parse_str)
        .transpose()?
        .map(|id| id.as_u128());
    let mut timestamp = at;
    let mut tail = rand::rng().random::<u128>() & MASK;
    if let Some(prior) = prior
        && timestamp <= (prior >> 80) as u64
    {
        timestamp = (prior >> 80) as u64;
        tail = (((((prior >> 64) & 0xfff) << 62) | (prior & LOW)) + 1) & MASK;
        if tail == 0 {
            timestamp += 1;
        }
    }
    ensure!(
        timestamp < (1u64 << 48),
        "The system clock is outside the UUIDv7 timestamp range."
    );
    Ok(uuid::Uuid::from_u128(
        ((timestamp as u128) << 80) | (7 << 76) | ((tail >> 62) << 64) | (2 << 62) | (tail & LOW),
    )
    .to_string())
}
impl ProfileModule {
    pub fn resource(&self, profile: &Value) -> Value {
        resource(profile)
    }
    pub fn new(
        config: Arc<ConfigModule>,
        bots: Arc<BotsModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        agents: Arc<AgentRuntimeModule>,
    ) -> Result<Arc<Self>> {
        let owner = Arc::new(Self {
            config,
            bots,
            runtime,
            _durable: durable,
            schemas: Schemas::new()?,
            instance: OnceLock::new(),
            listeners: Mutex::new(std::collections::BTreeMap::new()),
            next_listener: std::sync::atomic::AtomicU64::new(1),
            transactional: Mutex::new(std::collections::BTreeMap::new()),
        });
        agents.install(owner.clone())?;
        Ok(owner)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime.migrate("profile", MIGRATIONS).await?;
        let owner = self.clone();
        self.runtime
            .transact(move |ctx| {
                let id = owner.runtime.installation_epoch(ctx)?;
                ensure!(
                    owner.schemas.valid("ownerProfileInstanceId", &json!(id))?,
                    "The installation identity is not valid."
                );
                if let Some(previous) = owner.instance.get() {
                    ensure!(
                        previous == &id,
                        "Only this profile's own installation may change it."
                    );
                } else {
                    let _ = owner.instance.set(id);
                }
                if owner.config.team_enabled() {
                    return Ok(());
                }
                let Some(configured) = owner.config.values.get("profile") else {
                    return Ok(());
                };
                let before = owner.ensure(ctx)?;
                owner.owned(&before)?;
                if !before["name"].is_null() && !before["email"].is_null() {
                    return Ok(());
                }
                let mut after = before.clone();
                for field in ["name", "email"] {
                    if after[field].is_null() {
                        after[field] = configured
                            .get(field)
                            .and_then(toml::Value::as_str)
                            .map(|value| json!(value))
                            .unwrap_or(Value::Null);
                    }
                }
                after["updatedAt"] = json!(now());
                after["version"] = json!(version(before["version"].as_str(), now())?);
                owner.write(ctx, &after)?;
                owner.publish(ctx, &before, &after)
            })
            .await
    }
    pub fn on_event(
        self: &Arc<Self>,
        listener: ProfileEventListener,
    ) -> Result<ProfileSubscription> {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        ensure!(
            listeners.len() < 64,
            "The profile subscriber limit has been reached."
        );
        let id = self
            .next_listener
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(ProfileSubscription {
            owner: Arc::downgrade(self),
            id,
        })
    }
    pub fn on_event_transactional(
        self: &Arc<Self>,
        listener: ProfileTransactionalListener,
    ) -> Result<ProfileSubscription> {
        let mut listeners = self
            .transactional
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        ensure!(
            listeners.len() < 64,
            "The profile subscriber limit has been reached."
        );
        let id = self
            .next_listener
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(ProfileSubscription {
            owner: Arc::downgrade(self),
            id,
        })
    }
    pub fn get(&self, ctx: &Context<'_>) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        let record:Option<(usize,String)>=ctx.database().query_row("SELECT length(CAST(profile_json AS BLOB)),CASE WHEN length(CAST(profile_json AS BLOB))<=16384 THEN profile_json ELSE '' END FROM happy_agent_profile WHERE singleton_id=1",[],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        record
            .map(|(length, encoded)| {
                ensure!(length <= 16384, "The stored profile exceeds its bound.");
                let value = serde_json::from_str(&encoded)?;
                ensure!(
                    self.schemas.valid("ownerProfile", &value)?,
                    "The stored profile is invalid."
                );
                Ok(value)
            })
            .transpose()
    }
    pub fn ensure(&self, ctx: &Context<'_>) -> Result<Value> {
        if let Some(profile) = self.get(ctx)? {
            return Ok(profile);
        }
        let instance = self
            .instance
            .get()
            .context("The profile is not open yet.")?;
        let at = now();
        let profile = json!({"createdAt":at,"email":null,"id":cuid2::create_id(),"name":null,"parentInstanceId":instance,"photo":null,"updatedAt":at,"version":version(None,at)?});
        ensure!(
            self.schemas.valid("ownerProfile", &profile)?,
            "The profile is not valid."
        );
        ctx.database().execute("INSERT INTO happy_agent_profile(singleton_id,profile_json) VALUES(1,?1) ON CONFLICT(singleton_id) DO NOTHING",[profile.to_string()])?;
        self.get(ctx)?
            .context("The profile could not be initialized.")
    }
    pub fn get_by_id(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        Ok(self.get(ctx)?.filter(|profile| profile["id"] == id))
    }
    pub fn is_local(&self, ctx: &Context<'_>, id: &str) -> Result<bool> {
        Ok(self.get_by_id(ctx, id)?.is_some_and(|profile| {
            self.instance
                .get()
                .is_some_and(|instance| profile["parentInstanceId"] == *instance)
        }))
    }
    pub fn create(&self, ctx: &Context<'_>, input: &Value) -> Result<Value> {
        self.validate(
            "ownerProfileCreate",
            input,
            "The profile name or email address is not valid.",
        )?;
        ensure!(
            self.get(ctx)?.is_none(),
            "This installation already has a profile."
        );
        let instance = self
            .instance
            .get()
            .context("The profile is not open yet.")?;
        let at = now();
        let profile = json!({"createdAt":at,"email":input["email"],"id":cuid2::create_id(),"name":input["name"],"parentInstanceId":instance,"photo":null,"updatedAt":at,"version":version(None,at)?});
        self.validate("ownerProfile", &profile, "The profile is not valid.")?;
        ctx.database().execute(
            "INSERT INTO happy_agent_profile(singleton_id,profile_json) VALUES(1,?1)",
            [profile.to_string()],
        )?;
        self.publish(ctx, &Value::Null, &profile)?;
        Ok(profile)
    }
    pub fn update(
        &self,
        ctx: &Context<'_>,
        id: &str,
        input: &Value,
        expected: Option<&str>,
    ) -> Result<Option<Value>> {
        self.validate(
            "ownerProfileUpdate",
            input,
            "The profile update is not valid.",
        )?;
        self.options(expected, "The profile update is not valid.")?;
        let Some(before) = self.get_by_id(ctx, id)? else {
            return Ok(None);
        };
        self.owned(&before)?;
        self.expected(&before, expected)?;
        let mut after = before.clone();
        for field in ["name", "email"] {
            if let Some(value) = input.get(field) {
                after[field] = value.clone();
            }
        }
        let at = now();
        after["updatedAt"] = json!(at);
        after["version"] = json!(version(before["version"].as_str(), at)?);
        self.write(ctx, &after)?;
        self.publish(ctx, &before, &after)?;
        Ok(Some(after))
    }
    fn validate(&self, name: &str, value: &Value, message: &str) -> Result<()> {
        if !self.schemas.valid(name, value)? {
            return Err(ProfileError::Invalid(message.into()).into());
        }
        Ok(())
    }
    fn owned(&self, profile: &Value) -> Result<()> {
        ensure!(
            self.instance
                .get()
                .is_some_and(|instance| profile["parentInstanceId"] == *instance),
            "Only this profile's own installation may change it."
        );
        Ok(())
    }
    fn expected(&self, profile: &Value, expected: Option<&str>) -> Result<()> {
        if expected.is_some_and(|expected| profile["version"] != expected) {
            return Err(ProfileError::Conflict(profile.clone()).into());
        }
        Ok(())
    }
    fn options(&self, expected: Option<&str>, message: &str) -> Result<()> {
        self.validate(
            "ownerProfileMutationOptions",
            &expected
                .map(|version| json!({"expectedVersion":version}))
                .unwrap_or(json!({})),
            message,
        )
    }
    fn write(&self, ctx: &Context<'_>, profile: &Value) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        self.validate("ownerProfile", profile, "The profile is not valid.")?;
        ctx.database().execute(
            "UPDATE happy_agent_profile SET profile_json=?1 WHERE singleton_id=1",
            [profile.to_string()],
        )?;
        Ok(())
    }
    fn publish(&self, ctx: &Context<'_>, before: &Value, after: &Value) -> Result<()> {
        let event = json!({"createdAt":after["updatedAt"],"data":{"previousVersion":before["version"],"profileId":after["id"],"version":after["version"]},"id":after["version"],"type":"profile_changed"});
        self.validate(
            "ownerProfileChanged",
            &event,
            "The profile event is invalid.",
        )?;
        let transactional = self
            .transactional
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for listener in transactional {
            listener(ctx, &event, after)?;
        }
        let listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let profile = after.clone();
        ctx.after_commit(move||{for listener in listeners{match std::panic::catch_unwind(std::panic::AssertUnwindSafe(||listener(&event,&profile))){Ok(Ok(()))=>{},Ok(Err(error))=>tracing::warn!(%error,"A profile listener failed after the change was saved."),Err(_)=>tracing::warn!("A profile listener panicked after the change was saved.")}}})
    }
    fn admin(&self, ctx: &Context<'_>, agent: &str) -> Result<bool> {
        Ok(!self.config.team_enabled()
            && self.runtime.parent_of(ctx, agent)?.is_none()
            && self
                .bots
                .for_agent(ctx, agent)?
                .is_some_and(|bot| bot["isAdmin"] == true && bot["status"] == "active"))
    }
    pub fn local_for_admin(&self, ctx: &Context<'_>, agent: &str) -> Result<Value> {
        ensure!(
            self.admin(ctx, agent)?,
            "Only an active admin bot can read the local profile."
        );
        let profile = self.get(ctx)?.unwrap_or(Value::Null);
        let value = json!({"name":profile["name"],"email":profile["email"]});
        self.validate("ownerProfileLocal", &value, "The local profile is invalid.")?;
        Ok(value)
    }
}
#[async_trait]
impl AgentModule for ProfileModule {
    fn name(&self) -> &'static str {
        "profile"
    }
    async fn available_tools(&self, scope: &AgentScope<'_>) -> Result<Vec<ToolDefinition>> {
        let bots = self.bots.clone();
        let runtime = self.runtime.clone();
        let agent = scope.id.to_owned();
        let team = self.config.team_enabled();
        let allowed = self
            .runtime
            .transact(move |ctx| {
                Ok(!team
                    && runtime.parent_of(ctx, &agent)?.is_none()
                    && bots
                        .for_agent(ctx, &agent)?
                        .is_some_and(|bot| bot["isAdmin"] == true && bot["status"] == "active"))
            })
            .await?;
        Ok(if allowed { definitions() } else { Vec::new() })
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        selected(call).then_some(true)
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        selected(call).then_some(true)
    }
    fn permission_policy(
        &self,
        _: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<ToolPermissionPolicy>> {
        if !selected(call) {
            return None;
        }
        Some(Ok(ToolPermissionPolicy {
            should_review_in_auto_mode: false,
            should_run_in_full_access_in_auto_mode: false,
            requires_auto_or_full_access: false,
            action: definitions()[0].description.clone(),
            instructions: None,
        }))
    }
    fn execute_transactional_tool(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        if !selected(call) {
            return None;
        }
        Some((|| {
            let input: Value = serde_json::from_str(
                call["call"]["arguments"]
                    .as_str()
                    .context("The profile tool arguments are missing.")?,
            )?;
            self.validate(
                "ownerTool_get_local_profile",
                &input,
                "The profile tool arguments are invalid.",
            )?;
            let value = self.local_for_admin(ctx, scope.id)?;
            Ok(Message::Tool {
                call_id: call["id"].as_str().unwrap_or("").to_owned(),
                content: vec![Block::text(value.to_string())],
                is_error: false,
                vendor: None,
            })
        })())
    }
}
