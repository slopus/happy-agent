//! The original bot catalog, dedicated folders and permanent system seed ledger.
use super::{
    agent_runtime::AgentRuntimeModule,
    config::ConfigModule,
    durable::DurableFunctionsModule,
    events::EventsModule,
    identity::now,
    lifecycle::LifecycleModule,
    owners::{AbortModule, RunnersModule},
    projects::{AvatarAsset, ProjectsModule},
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
    titles::TitlesModule,
    workspaces::WorkspacesModule,
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use happy_agent_base::{AcceptedInput, AgentModule, AgentScope};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
mod identity;
mod persistence;
mod tools;

pub type BotEventListener = Arc<dyn Fn(Value) + Send + Sync>;
pub struct BotSubscription {
    owner: Weak<BotsModule>,
    id: u64,
}
impl Drop for BotSubscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            owner
                .listeners
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&self.id);
        }
    }
}
pub struct BotsModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    agents: Arc<AgentRuntimeModule>,
    abort: Arc<AbortModule>,
    titles: Arc<TitlesModule>,
    projects: Arc<ProjectsModule>,
    workspaces: Arc<WorkspacesModule>,
    runners: Arc<RunnersModule>,
    _durable: Arc<DurableFunctionsModule>,
    _events: Arc<EventsModule>,
    schemas: Schemas,
    lifetime: CancellationToken,
    owner: Weak<Self>,
    listeners: Mutex<BTreeMap<u64, BotEventListener>>,
    next_listener: AtomicU64,
    naming: Mutex<BTreeSet<String>>,
    naming_changed: tokio::sync::Notify,
}
impl BotsModule {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        agents: Arc<AgentRuntimeModule>,
        abort: Arc<AbortModule>,
        titles: Arc<TitlesModule>,
        projects: Arc<ProjectsModule>,
        workspaces: Arc<WorkspacesModule>,
        runners: Arc<RunnersModule>,
        durable: Arc<DurableFunctionsModule>,
        events: Arc<EventsModule>,
        lifecycle: Arc<LifecycleModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in [
            "ownerBotRecord",
            "ownerBotCreate",
            "ownerBotAvatarMetadata",
            "ownerBotEvent",
            "ownerBotSystemKey",
            "ownerBotUsername",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        let module = Arc::new_cyclic(|owner| Self {
            config,
            runtime,
            agents: agents.clone(),
            abort,
            titles,
            projects,
            workspaces,
            runners,
            _durable: durable,
            _events: events,
            schemas,
            lifetime: lifecycle.shutdown.child_token(),
            owner: owner.clone(),
            listeners: Mutex::new(BTreeMap::new()),
            next_listener: AtomicU64::new(1),
            naming: Mutex::new(BTreeSet::new()),
            naming_changed: tokio::sync::Notify::new(),
        });
        agents.install(module.clone())?;
        Ok(module)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime.migrate("bots", persistence::MIGRATIONS).await
    }
    pub fn get(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        if !persistence::available(ctx)? {
            return Ok(None);
        }
        persistence::read(ctx, &self.schemas, id)
    }
    pub fn for_agent(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        if !persistence::available(ctx)? {
            return Ok(None);
        }
        persistence::for_agent(ctx, &self.schemas, id)
    }
    pub fn for_workspace(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        if !persistence::available(ctx)? {
            return Ok(None);
        }
        persistence::for_workspace(ctx, &self.schemas, id)
    }
    pub fn list(&self, ctx: &Context<'_>) -> Result<Vec<Value>> {
        self.runtime.assert_context(ctx)?;
        persistence::list(ctx, &self.schemas)
    }
    pub fn on_event(self: &Arc<Self>, listener: BotEventListener) -> Result<BotSubscription> {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listeners.len() < 64,
            "The bot event subscriber bound was reached."
        );
        let id = self.next_listener.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(BotSubscription {
            owner: Arc::downgrade(self),
            id,
        })
    }
    fn publish(&self, ctx: &Context<'_>, event: Value) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid("ownerBotEvent", &event)?,
            "The bot event is invalid."
        );
        let listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        ctx.after_commit(move || {
            for listener in listeners {
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    listener(event.clone())
                }))
                .is_err()
                {
                    tracing::warn!(event_id=%event["eventId"],"A bot subscriber failed.");
                }
            }
        })
    }
    fn identity_in_use(&self, ctx: &Context<'_>, id: &str) -> Result<bool> {
        Ok(self.get(ctx, id)?.is_some()
            || self.for_agent(ctx, id)?.is_some()
            || self.for_workspace(ctx, id)?.is_some()
            || self.agents.configuration(ctx, id)?.is_some()
            || self.projects.get(ctx, id)?.is_some()
            || self.workspaces.has_identity(ctx, id)?)
    }
    fn unused_identity(&self, ctx: &Context<'_>, reserved: &BTreeSet<String>) -> Result<String> {
        for _ in 0..128 {
            let id = cuid2::create_id();
            if !reserved.contains(&id) && !self.identity_in_use(ctx, &id)? {
                return Ok(id);
            }
        }
        anyhow::bail!("An unused bot identity could not be chosen.")
    }
    fn choose_username(
        &self,
        ctx: &Context<'_>,
        name: &str,
        supplied: Option<&str>,
    ) -> Result<String> {
        if let Some(username) = supplied {
            anyhow::ensure!(
                persistence::for_username(ctx, &self.schemas, username)?.is_none(),
                "That bot username is already in use."
            );
            return Ok(username.to_owned());
        }
        let base = identity::username(name);
        for suffix in 1..1_000_000 {
            let tail = if suffix == 1 {
                String::new()
            } else {
                format!("_{suffix}")
            };
            let username = format!("{}{}", &base[..base.len().min(64 - tail.len())], tail);
            if persistence::for_username(ctx, &self.schemas, &username)?.is_none() {
                return Ok(username);
            }
        }
        anyhow::bail!("A unique bot username could not be chosen.")
    }
    pub async fn prepare_creation(&self, cancel: &CancellationToken) -> Result<()> {
        let runner = self.runners.place(None)?;
        tokio::time::timeout(
            Duration::from_secs(10),
            self.runners.prepare_machine(runner.as_deref(), cancel),
        )
        .await
        .context("The runner did not become available for bot creation.")?
    }
    /// Called on the runtime's blocking transaction thread; folder creation is last.
    pub fn create(&self, ctx: &Context<'_>, input: &Value) -> Result<Value> {
        Ok(self.create_with_result(ctx, input)?["bot"].clone())
    }
    pub fn create_with_result(&self, ctx: &Context<'_>, input: &Value) -> Result<Value> {
        self.create_inner(ctx, input, None, None)
    }
    pub fn send_message(
        &self,
        ctx: &Context<'_>,
        sender: &str,
        bot_id: &str,
        text: &str,
        message_id: &str,
    ) -> Result<Value> {
        let bot = self.required(ctx, bot_id)?;
        anyhow::ensure!(
            bot["status"] == "active",
            "The bot is archived and cannot receive messages."
        );
        anyhow::ensure!(
            bot["agentId"] != sender,
            "A bot cannot send a message to itself."
        );
        self.agents.enqueue(ctx,bot["agentId"].as_str().unwrap(),&json!({"id":message_id,"message":{"role":"agent","author":{"id":sender,"description":format!("Agent {sender}")},"content":[{"type":"text","text":format!("Message from agent {sender}:\n\n{text}")}]},"metadata":{"bots":{"fromAgentId":sender,"botId":bot_id},"senderAgentId":sender}}),false)?;
        Ok(bot)
    }
    fn create_inner(
        &self,
        ctx: &Context<'_>,
        input: &Value,
        system_key: Option<&str>,
        avatar: Option<&AvatarAsset>,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("ownerBotCreate", input)?,
            "The bot creation request is invalid."
        );
        if let Some(id) = input["id"].as_str() {
            if let Some(existing) = self.get(ctx, id)? {
                for field in ["workspaceId", "agentId"] {
                    anyhow::ensure!(
                        input[field].is_null() || input[field] == existing[field],
                        "The requested identities do not match this bot."
                    );
                }
                return Ok(json!({"bot":existing,"created":false}));
            }
        }
        let supplied = ["id", "workspaceId", "agentId"]
            .into_iter()
            .filter_map(|field| input[field].as_str())
            .collect::<Vec<_>>();
        let mut reserved = supplied
            .iter()
            .map(|id| (*id).to_owned())
            .collect::<BTreeSet<_>>();
        anyhow::ensure!(
            reserved.len() == supplied.len(),
            "The bot, workspace, and agent must have distinct identities."
        );
        for id in &reserved {
            anyhow::ensure!(
                !self.identity_in_use(ctx, id)?,
                "A requested identity is already in use."
            );
        }
        let mut ids = Vec::new();
        for field in ["id", "workspaceId", "agentId"] {
            let id = input[field]
                .as_str()
                .map(str::to_owned)
                .map(Ok)
                .unwrap_or_else(|| self.unused_identity(ctx, &reserved))?;
            reserved.insert(id.clone());
            ids.push(id);
        }
        let name = input["name"].as_str().unwrap_or("New Bot");
        let username = self.choose_username(
            ctx,
            input["name"].as_str().unwrap_or("bot"),
            input["username"].as_str(),
        )?;
        let runner = self.runners.place(None)?;
        let path = if let Some(runner) = runner.as_deref() {
            let machine=self.runners.known_machine(ctx,runner)?.context("The default runner has never connected, so it has nowhere to put a bot's folder yet.")?;
            self.config.bot_path_on(
                Path::new(
                    machine["home"]
                        .as_str()
                        .context("The runner home folder is missing.")?,
                ),
                machine["platform"].as_str().unwrap_or("linux"),
                &username,
            )?
        } else {
            self.config.bot_path(&username)?
        };
        let path = path.to_string_lossy().into_owned();
        let timestamp = now();
        let configuration =
            self.config
                .bot_configuration(&path, &ids[1], name, runner.as_deref())?;
        self.agents.create(ctx, &ids[2], &configuration)?;
        let ordered = self.list(ctx)?;
        let order = identity::between(
            ordered.last().and_then(|bot| bot["orderKey"].as_str()),
            None,
        )?;
        let mut bot = json!({"id":ids[0],"isAdmin":input["isAdmin"].as_bool().unwrap_or(false),"name":name,"nameConfigured":input.get("name").is_some(),"username":username,"workspaceId":ids[1],"workspaceVersion":1,"workspaceUpdatedAt":timestamp,"agentId":ids[2],"path":path,"status":"active","orderKey":order,"version":1,"createdAt":timestamp,"updatedAt":timestamp});
        if let Some(key) = system_key {
            bot["systemKey"] = json!(key);
        }
        if let Some(runner) = &runner {
            bot["runnerId"] = json!(runner);
        }
        if let Some(avatar) = avatar {
            bot["avatar"] = json!({"kind":"image","source":"generated","thumbhash":avatar.metadata["thumbhash"]});
        }
        persistence::insert(ctx, &self.schemas, &bot)?;
        if let Some(avatar) = avatar {
            persistence::save_avatar(
                ctx,
                &self.schemas,
                bot["id"].as_str().unwrap(),
                &avatar.bytes,
                &identity::avatar_metadata(&avatar.metadata),
            )?;
        }
        if runner.is_none() {
            match std::fs::metadata(&path) {
                Ok(facts) => {
                    anyhow::ensure!(facts.is_dir(), "The bot folder path is already in use.")
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            };
            std::fs::create_dir_all(&path)?;
        } else {
            let cancel = self.lifetime.child_token();
            tokio::runtime::Handle::current().block_on(async {
                tokio::time::timeout(Duration::from_secs(10), async {
                    if self
                        .runners
                        .exists(runner.as_deref(), Path::new(&path), &cancel)
                        .await?
                    {
                        let facts = self
                            .runners
                            .inspect(runner.as_deref(), Path::new(&path), &cancel)
                            .await?;
                        anyhow::ensure!(
                            facts["isDirectory"] == true,
                            "The bot folder path is already in use."
                        );
                    }
                    self.runners
                        .mkdir(runner.as_deref(), Path::new(&path), &cancel)
                        .await
                })
                .await
                .context("The runner did not finish creating the bot folder.")?
            })?;
        }
        self.publish(ctx,json!({"eventId":uuid::Uuid::new_v4().to_string(),"at":timestamp,"type":"bot_created","bot":bot}))?;
        Ok(json!({"bot":bot,"created":true}))
    }
    fn required(&self, ctx: &Context<'_>, id: &str) -> Result<Value> {
        self.get(ctx, id)?.context("The bot was not found.")
    }
    fn assert_version(&self, bot: &Value, expected: u64) -> Result<()> {
        anyhow::ensure!(
            bot["version"].as_u64() == Some(expected),
            "The bot has changed."
        );
        Ok(())
    }
    fn change(&self, ctx: &Context<'_>, before: &Value, mut after: Value) -> Result<Value> {
        after["version"] = json!(before["version"].as_u64().unwrap() + 1);
        after["updatedAt"] = json!(now().max(before["updatedAt"].as_u64().unwrap() + 1));
        if before["status"] != after["status"] || before["archivedAt"] != after["archivedAt"] {
            after["workspaceVersion"] = json!(before["workspaceVersion"].as_u64().unwrap() + 1);
            after["workspaceUpdatedAt"] = after["updatedAt"].clone();
        }
        let stored = persistence::update(ctx, &self.schemas, before, &after)?;
        self.publish(ctx,json!({"eventId":uuid::Uuid::new_v4().to_string(),"at":stored["updatedAt"],"type":"bot_updated","bot":stored,"previousBot":before}))?;
        Ok(stored)
    }
    fn update_metadata(&self, ctx: &Context<'_>, id: &str, mut update: Value) -> Result<()> {
        let config = self
            .agents
            .configuration(ctx, id)?
            .context("The bot agent was not found.")?;
        update["version"] = json!(config["metadata"]["version"].as_u64().unwrap_or(0) + 1);
        update["updatedAt"] = json!(now());
        self.agents.update_metadata(ctx, id, &update)
    }
    pub fn rename(&self, ctx: &Context<'_>, id: &str, name: &str, expected: u64) -> Result<Value> {
        let before = self.required(ctx, id)?;
        self.assert_version(&before, expected)?;
        let mut after = before.clone();
        after["name"] = json!(name);
        after["nameConfigured"] = json!(true);
        anyhow::ensure!(
            self.schemas.valid("ownerBotRecord", &after)?,
            "The bot name is invalid."
        );
        if after == before {
            return Ok(before);
        }
        self.update_metadata(
            ctx,
            before["agentId"].as_str().unwrap(),
            json!({"title":name}),
        )?;
        self.change(ctx, &before, after)
    }
    pub fn archive(&self, ctx: &Context<'_>, id: &str, expected: u64) -> Result<Value> {
        let before = self.required(ctx, id)?;
        self.assert_version(&before, expected)?;
        if before["status"] == "archived" {
            return Ok(before);
        }
        let agent = before["agentId"].as_str().unwrap();
        self.abort.abort(ctx, agent)?;
        self.update_metadata(ctx, agent, json!({"archivedAt":now()}))?;
        let mut after = before.clone();
        after["status"] = json!("archived");
        after["archivedAt"] = json!(now());
        self.change(ctx, &before, after)
    }
    pub fn unarchive(&self, ctx: &Context<'_>, id: &str, expected: u64) -> Result<Value> {
        let before = self.required(ctx, id)?;
        self.assert_version(&before, expected)?;
        if before["status"] == "active" {
            return Ok(before);
        }
        self.update_metadata(
            ctx,
            before["agentId"].as_str().unwrap(),
            json!({"archivedAt":null}),
        )?;
        let mut after = before.clone();
        after["status"] = json!("active");
        after.as_object_mut().unwrap().remove("archivedAt");
        self.change(ctx, &before, after)
    }
    pub fn reorder(
        &self,
        ctx: &Context<'_>,
        id: &str,
        after_id: Option<&str>,
        expected: u64,
    ) -> Result<Value> {
        anyhow::ensure!(after_id != Some(id), "A bot cannot be placed after itself.");
        let before = self.required(ctx, id)?;
        self.assert_version(&before, expected)?;
        let ordered = self
            .list(ctx)?
            .into_iter()
            .filter(|bot| bot["id"] != id)
            .collect::<Vec<_>>();
        let position = if let Some(after_id) = after_id {
            ordered
                .iter()
                .position(|bot| bot["id"] == after_id)
                .context("The bot to place after was not found.")?
                .checked_add(1)
                .unwrap()
        } else {
            0
        };
        let key = identity::between(
            position
                .checked_sub(1)
                .and_then(|index| ordered.get(index))
                .and_then(|bot| bot["orderKey"].as_str()),
            ordered
                .get(position)
                .and_then(|bot| bot["orderKey"].as_str()),
        )?;
        if before["orderKey"] == key {
            return Ok(before);
        }
        let mut after = before.clone();
        after["orderKey"] = json!(key);
        self.change(ctx, &before, after)
    }
    pub fn avatar(&self, ctx: &Context<'_>, id: &str) -> Result<Option<(Vec<u8>, Value)>> {
        let bot = self.required(ctx, id)?;
        if bot.get("avatar").is_none() {
            return Ok(None);
        }
        persistence::avatar(ctx, &self.schemas, id)
    }
    pub fn set_avatar(
        &self,
        ctx: &Context<'_>,
        id: &str,
        asset: &AvatarAsset,
        expected: u64,
    ) -> Result<Value> {
        let before = self.required(ctx, id)?;
        self.assert_version(&before, expected)?;
        self.write_avatar(ctx, &before, asset, "user")
    }
    pub fn set_avatar_for_agent(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        target: Option<&str>,
        asset: &AvatarAsset,
    ) -> Result<Value> {
        let actor = self
            .for_agent(ctx, agent)?
            .context("Only a bot can set its own avatar.")?;
        anyhow::ensure!(
            actor["status"] == "active",
            "An archived bot cannot change avatars."
        );
        let target = target.unwrap_or(actor["id"].as_str().unwrap());
        anyhow::ensure!(
            target == actor["id"].as_str().unwrap() || actor["isAdmin"] == true,
            "Only an admin bot can set another bot's avatar."
        );
        let before = self.required(ctx, target)?;
        self.write_avatar(ctx, &before, asset, "generated")
    }
    fn write_avatar(
        &self,
        ctx: &Context<'_>,
        before: &Value,
        asset: &AvatarAsset,
        source: &str,
    ) -> Result<Value> {
        persistence::save_avatar(
            ctx,
            &self.schemas,
            before["id"].as_str().unwrap(),
            &asset.bytes,
            &identity::avatar_metadata(&asset.metadata),
        )?;
        let mut after = before.clone();
        after["avatar"] =
            json!({"kind":"image","source":source,"thumbhash":asset.metadata["thumbhash"]});
        self.change(ctx, before, after)
    }
    pub fn clear_avatar(&self, ctx: &Context<'_>, id: &str, expected: u64) -> Result<Value> {
        let before = self.required(ctx, id)?;
        self.assert_version(&before, expected)?;
        if before.get("avatar").is_none() {
            return Ok(before);
        }
        persistence::clear_avatar(ctx, id)?;
        let mut after = before.clone();
        after.as_object_mut().unwrap().remove("avatar");
        self.change(ctx, &before, after)
    }
    async fn seed(self: &Arc<Self>) -> Result<bool> {
        let owner = self.clone();
        let existing = self
            .runtime
            .transact(move |ctx| persistence::system_seed(ctx, &owner.schemas, "chief_of_staff"))
            .await?;
        if existing.is_some() {
            return Ok(true);
        }
        let runner = self.runners.place(None)?;
        if let Some(id) = runner.as_deref() {
            if !self.runners.is_connected(id) {
                return Ok(false);
            }
            let owner = self.clone();
            let id = id.to_owned();
            if self
                .runtime
                .transact(move |ctx| owner.runners.known_machine(ctx, &id))
                .await?
                .is_none()
            {
                return Ok(false);
            }
        }
        if let Err(error) = self.prepare_creation(&self.lifetime).await {
            if runner
                .as_deref()
                .is_some_and(|id| !self.runners.is_connected(id))
            {
                return Ok(false);
            }
            return Err(error);
        }
        let asset = self
            .projects
            .normalize_avatar(
                include_bytes!("bots/assets/chief-of-staff.webp").to_vec(),
                Some("image/webp".to_owned()),
            )
            .await?;
        let owner = self.clone();
        self.runtime
            .transact(move |ctx| {
                if persistence::system_seed(ctx, &owner.schemas, "chief_of_staff")?.is_some() {
                    return Ok(());
                }
                let result = owner.create_inner(
                    ctx,
                    &json!({"isAdmin":true,"name":"Chief of Staff"}),
                    Some("chief_of_staff"),
                    Some(&asset),
                )?;
                persistence::seed(ctx, "chief_of_staff", result["bot"]["id"].as_str().unwrap())
            })
            .await?;
        Ok(true)
    }
    fn start_naming(self: &Arc<Self>, id: String, provider: Option<String>, message: String) {
        let mut jobs = self
            .naming
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.lifetime.is_cancelled() || jobs.len() >= 256 || !jobs.insert(id.clone()) {
            return;
        }
        drop(jobs);
        let owner = self.clone();
        tokio::spawn(async move {
            let result = async {
                let reader = owner.clone();
                let bot_id = id.clone();
                let eligible = owner
                    .runtime
                    .transact(move |ctx| {
                        Ok(reader.get(ctx, &bot_id)?.is_some_and(|bot| {
                            bot["status"] == "active" && bot["nameConfigured"] == false
                        }))
                    })
                    .await?;
                if !eligible {
                    return Ok::<_, anyhow::Error>(());
                }
                let Some(name) = owner
                    .titles
                    .suggest_bot_name(&message, provider.as_deref(), &owner.lifetime)
                    .await?
                else {
                    return Ok(());
                };
                if owner.lifetime.is_cancelled() {
                    return Ok(());
                }
                let writer = owner.clone();
                let bot_id = id.clone();
                owner
                    .runtime
                    .transact(move |ctx| {
                        let current = writer.required(ctx, &bot_id)?;
                        if current["status"] == "active" && current["nameConfigured"] == false {
                            writer.rename(
                                ctx,
                                &bot_id,
                                &name,
                                current["version"].as_u64().unwrap(),
                            )?;
                        }
                        Ok(())
                    })
                    .await
            }
            .await;
            if let Err(error) = result {
                tracing::debug!(%error,bot_id=%id,"Naming a bot from its first user message did not happen.");
            }
            owner
                .naming
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&id);
            owner.naming_changed.notify_waiters();
        });
    }
}
#[async_trait]
impl AgentModule for BotsModule {
    fn name(&self) -> &'static str {
        "bots"
    }
    async fn available_tools(
        &self,
        scope: &AgentScope<'_>,
    ) -> Result<Vec<happy_providers::ToolDefinition>> {
        self.available_bot_tools(scope).await
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|definition| definition.name == "list_bots")
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|definition| definition.name != "list_bots")
    }
    fn permission_policy(
        &self,
        _scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<happy_agent_base::ToolPermissionPolicy>> {
        tools::definition(call).map(|definition| {
            Ok(happy_agent_base::ToolPermissionPolicy {
                should_review_in_auto_mode: false,
                should_run_in_full_access_in_auto_mode: false,
                requires_auto_or_full_access: false,
                action: definition.description,
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
        self.execute_bot_transaction(ctx, scope, call)
    }
    async fn execute_tool(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<happy_providers::Message> {
        self.execute_bot_avatar(scope, call, cancel).await
    }
    async fn after_start(&self) -> Result<()> {
        let owner = self.owner.upgrade().context("The bot module was closed.")?;
        let mut updates = self.runners.on_updated();
        if owner.seed().await? {
            return Ok(());
        }
        tokio::spawn(async move {
            loop {
                tokio::select! {_=owner.lifetime.cancelled()=>return,changed=updates.changed()=>if changed.is_err(){return;}}
                match owner.seed().await {
                    Ok(true) => return,
                    Ok(false) => {}
                    Err(error) => {
                        tracing::warn!(%error,"The Chief of Staff could not be created.");
                        return;
                    }
                }
            }
        });
        Ok(())
    }
    fn accepted(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        inputs: &[AcceptedInput],
        _steering: bool,
    ) -> Result<()> {
        let Some(bot) = self.for_agent(ctx, scope.id)? else {
            return Ok(());
        };
        let key = format!("kv.{}.module.bots.bot-name-attempted", scope.id);
        if bot["nameConfigured"] == true || ctx.value(scope.id, &key)?.is_some() {
            return Ok(());
        }
        let Some(message) = identity::first_text(inputs) else {
            return Ok(());
        };
        ctx.put_value(scope.id, &key, &json!({"at":now()}))?;
        let owner = self.owner.clone();
        let id = bot["id"].as_str().unwrap().to_owned();
        let provider = scope.settings["provider"].as_str().map(str::to_owned);
        ctx.after_commit(move || {
            if let Some(owner) = owner.upgrade() {
                owner.start_naming(id, provider, message);
            }
        })
    }
    async fn instructions(&self, scope: &AgentScope<'_>) -> Result<String> {
        let owner = self.owner.upgrade().context("The bot module was closed.")?;
        let id = scope.id.to_owned();
        let bot = self
            .runtime
            .transact(move |ctx| owner.for_agent(ctx, &id))
            .await?;
        Ok(bot.as_ref().map(identity::instructions).unwrap_or_default())
    }
    async fn close(&self) {
        self.lifetime.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                let notified = self.naming_changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self
                    .naming
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .is_empty()
                {
                    return;
                }
                notified.await;
            }
        })
        .await;
    }
}

#[cfg(test)]
mod tests;
