//! MCP: one shared capability serves every agent and owns the live clients, the protocol
//! operations, validation, naming, permission declarations, and model rendering.
//!
//! Servers come from two catalogs: the user's own `mcp.toml` and, while a session works there, the
//! `mcp.toml` at a workspace root. Connections are pooled by their configuration across catalogs,
//! so identical entries share one process, which closes once no catalog references it. Every
//! catalog change happens behind one serialized lifecycle lock, and every connection a change
//! needs is ready, or has failed within its bound, before any catalog visibly changes.

mod connection;
mod content;
mod elicitation;
mod http;
mod names;
mod output;
mod persistence;
mod protocol;
mod runner_stdio;
mod schemas;
mod sdk;
mod stdio;
#[cfg(test)]
mod tests;
mod tools;
mod typebox;

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use anyhow::{Result, anyhow, bail};
use async_trait::async_trait;
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, join_all};
use happy_agent_base::{AgentModule, AgentScope, ToolPermissionPolicy};
use happy_providers::{Message, ToolDefinition};
use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::agent_runtime::AgentRuntimeModule;
use super::config::ConfigModule;
use super::durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration};
use super::identity::now;
use super::lifecycle::LifecycleModule;
use super::owners::{RunnerUnavailableError, RunnersModule};
use super::runtime::{Context, RuntimeModule};
use super::text::{js_is_whitespace, js_length, js_slice, locale_compare};
use super::user_input::UserInputModule;
use super::workspaces::{WorkspaceSubscription, WorkspacesModule};
use connection::{McpConnection, OnRunner};
use protocol::{ElicitationHandler, McpError};
use schemas::{MAX_MCP_CURSOR_LENGTH, MAX_MCP_ERROR_MESSAGE_LENGTH, MAX_MCP_PAGE_SIZE, MAX_MCP_TOTAL_TOOLS};

const DEFAULT_PAGE_SIZE: usize = 50;
const DEFAULT_OUTPUT_CHARACTERS: usize = 12_000;
const GLOBAL_CATALOG: &str = "global";
const WORKSPACE_CATALOG_PREFIX: &str = "workspace:";
/// How many agents' offered tool lists are remembered for permission disclosure.
const MAX_OFFERED_AGENTS: usize = 1_024;
/// The durable call that discovers the user's catalog once the daemon starts; its name is also
/// its operation, so at most one is ever owed.
const DISCOVER_FUNCTION: &str = "mcp.discover";
/// The durable call that applies every workspace change MCP owes, in the order they committed;
/// its name is also its operation, so changes owed while one is pending join it.
const WORKSPACES_FUNCTION: &str = "mcp.workspaces";
/// Every durable call MCP owes holds this key, so they run one at a time in the order they were
/// owed.
const DURABLE_LOCK: &str = "mcp";
const MAX_WORKSPACE_CATALOG_BYTES: usize = 1_048_576;

pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// One server a catalog names: its configuration and, unless disabled, the pooled connection.
#[derive(Clone)]
struct CatalogServer {
    config: Value,
    connection_id: Option<String>,
}

type Catalog = IndexMap<String, CatalogServer>;

/// One pooled connection: the catalogs that reference it, and the live client or why there is none.
struct Pooled {
    references: HashSet<String>,
    connection: Option<Arc<McpConnection>>,
    failure: Option<String>,
}

#[derive(Default)]
struct State {
    catalogs: HashMap<String, Catalog>,
    pool: HashMap<String, Pooled>,
    agent_workspaces: HashMap<String, String>,
    workspace_agents: IndexMap<String, IndexSet<String>>,
    archived_workspaces: HashSet<String>,
    workspace_failures: HashMap<String, String>,
}

/// What one agent was last offered: the connected servers the protocol tools named, the servers
/// a tool-name collision quarantined, and each direct tool's server and server-side name.
#[derive(Default)]
struct Offered {
    connected: Vec<String>,
    quarantined: Vec<Value>,
    direct: HashMap<String, (String, String)>,
}

/// How far the first discovery of the user's catalog has come; agents wait for it before their
/// first tool list once it is owed.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Discovery {
    NotOwed,
    Owed,
    Settled,
}

/// The listings a server pages through.
#[derive(Clone, Copy)]
enum Listing {
    Tools,
    Resources,
    ResourceTemplates,
    Prompts,
}

impl Listing {
    fn key(self) -> &'static str {
        match self {
            Listing::Tools => "tools",
            Listing::Resources => "resources",
            Listing::ResourceTemplates => "resourceTemplates",
            Listing::Prompts => "prompts",
        }
    }
}

pub struct McpModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    user_input: Arc<UserInputModule>,
    runners: Arc<RunnersModule>,
    max_page_size: usize,
    max_output_characters: usize,
    /// Serializes every change to catalogs and connections.
    reload_lock: tokio::sync::Mutex<()>,
    state: Mutex<State>,
    offered: Mutex<IndexMap<String, Offered>>,
    discovery: tokio::sync::watch::Sender<Discovery>,
    closed: AtomicBool,
    close: tokio::sync::OnceCell<()>,
    /// Ends every request a listing or call started outside an agent's own tool call.
    lifetime: CancellationToken,
    /// The daemon's shutdown, which ends every wait for a discovery that will not run now.
    stopping: CancellationToken,
    /// Keeps MCP subscribed to the workspace changes it owes.
    workspace_events: Mutex<Option<WorkspaceSubscription>>,
    owner: Weak<Self>,
}

impl McpModule {
    /// MCP takes configuration, for the servers it runs and the user's catalog it edits; runtime,
    /// for its durable server index; Durable Functions, which run its discovery; lifecycle, whose
    /// shutdown ends its requests; user input, for the questions a server asks; workspaces,
    /// because an archived workspace's servers stop with it; runners, which own remote catalogs
    /// and stdio programs; and the agent runtime it installs its hooks into.
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        lifecycle: Arc<LifecycleModule>,
        user_input: Arc<UserInputModule>,
        workspaces: Arc<WorkspacesModule>,
        runners: Arc<RunnersModule>,
        agents: Arc<AgentRuntimeModule>,
    ) -> Result<Arc<Self>> {
        let module = Self::with_limits(config, runtime, durable.clone(), &lifecycle, user_input, runners, DEFAULT_PAGE_SIZE, DEFAULT_OUTPUT_CHARACTERS);
        durable.register(Registration {
            name: DISCOVER_FUNCTION.into(),
            arguments_schema: "ownerReconcileArgs",
            result_schema: "ownerNull",
            function: Arc::new(Discover(Arc::downgrade(&module))),
        })?;
        durable.register(Registration {
            name: WORKSPACES_FUNCTION.into(),
            arguments_schema: "ownerReconcileArgs",
            result_schema: "ownerNull",
            function: Arc::new(ApplyWorkspaceChanges(Arc::downgrade(&module))),
        })?;
        // Each workspace change is owed in the transaction that commits it and applied after, in
        // commit order, by one coalesced durable call.
        let weak = Arc::downgrade(&module);
        let subscription = workspaces.on_event_transactional(Arc::new(move |ctx: &Context<'_>, event: &Value| match weak.upgrade() {
            Some(module) => module.record_workspace_event(ctx, event),
            None => Ok(()),
        }))?;
        *lock(&module.workspace_events) = Some(subscription);
        agents.install(module.clone())?;
        Ok(module)
    }

    fn with_limits(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        lifecycle: &LifecycleModule,
        user_input: Arc<UserInputModule>,
        runners: Arc<RunnersModule>,
        max_page_size: usize,
        max_output_characters: usize,
    ) -> Arc<Self> {
        Arc::new_cyclic(|owner| Self {
            config,
            runtime,
            durable,
            user_input,
            runners,
            max_page_size,
            max_output_characters,
            reload_lock: tokio::sync::Mutex::new(()),
            state: Mutex::new(State::default()),
            offered: Mutex::new(IndexMap::new()),
            discovery: tokio::sync::watch::Sender::new(Discovery::NotOwed),
            closed: AtomicBool::new(false),
            close: tokio::sync::OnceCell::new(),
            lifetime: CancellationToken::new(),
            stopping: lifecycle.shutdown.child_token(),
            workspace_events: Mutex::new(None),
            owner: owner.clone(),
        })
    }

    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime.migrate("mcp", persistence::MIGRATIONS).await
    }

    /// Owe the first discovery of the user's catalog to Durable Functions, which run it once this
    /// commits; agents wait for it before their first tool list. A discovery a stopped daemon
    /// still owed is the same operation, so it runs once rather than twice, and one that already
    /// ran since this daemon started is not owed again.
    pub async fn start(self: &Arc<Self>) -> Result<()> {
        let owed = self.discovery.send_if_modified(|discovery| {
            let owed = *discovery == Discovery::NotOwed;
            if owed {
                *discovery = Discovery::Owed;
            }
            owed
        });
        if !owed {
            return Ok(());
        }
        self.watch_runners();
        let module = self.clone();
        self.runtime
            .transact(move |ctx| {
                module.durable.invoke(ctx, &json!({"function": DISCOVER_FUNCTION, "arguments": {}, "operationId": DISCOVER_FUNCTION, "lockKeys": [DURABLE_LOCK]}))?;
                // Changes a drain that failed left behind are owed again after discovery.
                if persistence::query_next_workspace_intent(ctx)?.is_some() {
                    owe_workspace_changes(&module.durable, ctx)?;
                }
                Ok(())
            })
            .await
    }

    fn record_workspace_event(&self, ctx: &Context<'_>, event: &Value) -> Result<()> {
        owe_workspace_event(&self.durable, ctx, event)
    }

    fn watch_runners(self: &Arc<Self>) {
        let mut updates = self.runners.on_updated();
        let (module, lifetime, stopping) = (Arc::downgrade(self), self.lifetime.clone(), self.stopping.clone());
        tokio::spawn(async move {
            let mut connected = connected_runners(&updates.borrow_and_update());
            loop {
                tokio::select! {
                    _ = lifetime.cancelled() => return,
                    _ = stopping.cancelled() => return,
                    changed = updates.changed() => if changed.is_err() { return },
                }
                let current = connected_runners(&updates.borrow_and_update());
                let returned = current.iter().any(|id| !connected.contains(id));
                let Some(module) = module.upgrade() else { return };
                let closing = module.take_absent_runner_connections(&current);
                connected = current;
                // Pool failures are visible before bounded process cleanup begins, and the
                // transport reports closed before waiting for the absent runner's exit report.
                join_all(closing.iter().map(|connection| connection.close())).await;
                if !returned || module.is_closed() || *module.discovery.borrow() == Discovery::NotOwed { continue; }
                module.initial_reload().await;
                let failed = lock(&module.state).pool.values().any(|pooled| pooled.failure.is_some());
                if failed && let Err(error) = module.reload().await {
                    tracing::warn!(error = %error_message(&error), "MCP servers could not start on a runner.");
                }
            }
        });
    }

    fn take_absent_runner_connections(&self, connected: &HashSet<String>) -> Vec<Arc<McpConnection>> {
        let mut state = lock(&self.state);
        state.pool.iter_mut().filter_map(|(id, pooled)| {
            let runner = id.strip_prefix("runner:")?.split_once(':')?.0;
            if connected.contains(runner) { return None; }
            let connection = pooled.connection.take()?;
            pooled.failure = Some(format!("The runner {} is not connected.", self.runners.display_name(runner)));
            Some(connection)
        }).collect()
    }

    /// Apply every owed workspace change, oldest first. A change is settled only after it applies,
    /// so a stopped daemon applies it again on the next start; applying one twice changes nothing.
    async fn apply_workspace_changes(&self, cancel: &CancellationToken) -> Result<()> {
        while !cancel.is_cancelled() {
            let Some(intent) = self.runtime.transact(|ctx| persistence::query_next_workspace_intent(ctx)).await? else {
                return Ok(());
            };
            match intent.change.as_str() {
                "released" => self.release_workspace(&intent.workspace).await,
                _ => self.mark_workspace_active(&intent.workspace).await,
            }
            self.runtime.transact(move |ctx| persistence::settle_workspace_intent(ctx, &intent)).await?;
        }
        Ok(())
    }

    /// Discover the user's catalog, then let every agent waiting for it go on. A stopped daemon
    /// leaves it owed to the next one.
    async fn discover(&self, cancel: &CancellationToken) {
        tokio::select! {
            _ = cancel.cancelled() => {}
            reloaded = self.reload() => {
                if let Err(error) = reloaded {
                    tracing::warn!(error = %error_message(&error), "Initial MCP discovery failed.");
                }
            }
        }
        self.discovery.send_replace(Discovery::Settled);
    }

    async fn release_workspace(&self, workspace: &str) {
        let _lock = self.reload_lock.lock().await;
        {
            let mut state = lock(&self.state);
            state.archived_workspaces.insert(workspace.to_string());
            for agent_id in state.workspace_agents.get(workspace).cloned().unwrap_or_default() {
                state.agent_workspaces.remove(&agent_id);
            }
            state.workspace_agents.shift_remove(workspace);
            state.workspace_failures.remove(workspace);
        }
        self.remove_catalog(&workspace_catalog(workspace)).await;
    }

    async fn mark_workspace_active(&self, workspace: &str) {
        let _lock = self.reload_lock.lock().await;
        if self.is_closed() {
            return;
        }
        let mut state = lock(&self.state);
        state.archived_workspaces.remove(workspace);
        state.workspace_failures.remove(workspace);
    }

    fn assert_open(&self) -> Result<()> {
        if self.is_closed() {
            bail!("The MCP module is closed.");
        }
        Ok(())
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    async fn initial_reload(&self) {
        let mut discovery = self.discovery.subscribe();
        tokio::select! {
            _ = self.lifetime.cancelled() => {}
            _ = self.stopping.cancelled() => {}
            _ = discovery.wait_for(|discovery| *discovery != Discovery::Owed) => {}
        }
    }

    /// Reconcile the global mcp.toml without restarting unchanged shared connections.
    pub async fn reload(&self) -> Result<()> {
        self.assert_open()?;
        let _lock = self.reload_lock.lock().await;
        self.assert_open()?;
        let servers = self.config.read_mcp_servers()?;
        let global_names: HashSet<String> = servers.keys().cloned().collect();
        let workspaces: Vec<String> = lock(&self.state).workspace_agents.keys().cloned().collect();
        let mut catalogs = IndexMap::from([(GLOBAL_CATALOG.to_string(), servers)]);
        for workspace in workspaces {
            match self.read_workspace_servers(&workspace).await {
                Ok(found) => {
                    lock(&self.state).workspace_failures.remove(&workspace);
                    catalogs.insert(workspace_catalog(&workspace), without_server_names(found, &global_names));
                }
                Err(error) => {
                    self.record_workspace_failure(&workspace, &error);
                    let current = lock(&self.state).catalogs.get(&workspace_catalog(&workspace)).map(catalog_server_configs);
                    if let Some(current) = current {
                        catalogs.insert(workspace_catalog(&workspace), without_server_names(current, &global_names));
                    }
                }
            }
        }
        self.reconcile_catalogs(catalogs).await;
        Ok(())
    }

    /// Reconcile only the workspace catalog used by the calling agent.
    pub async fn reload_workspace(&self, agent_id: &str, configuration: &Value) -> Result<()> {
        self.assert_open()?;
        assert_agent_id(agent_id)?;
        self.ensure_agent_workspace(agent_id, configuration).await?;
        let _lock = self.reload_lock.lock().await;
        self.assert_open()?;
        let workspace = {
            let state = lock(&self.state);
            state.agent_workspaces.get(agent_id).cloned().filter(|workspace| {
                !state.archived_workspaces.contains(workspace) && state.workspace_agents.get(workspace).is_some_and(|agents| agents.contains(agent_id))
            })
        };
        let Some(workspace) = workspace else {
            bail!("This session is not attached to an active workspace directory.");
        };
        self.reconcile_workspace(&workspace).await
    }

    /// Add, replace, or remove one server of the user's catalog, then reload.
    pub async fn configure_server(&self, name: &str, server: Option<Value>) -> Result<()> {
        self.assert_open()?;
        self.config.update_mcp_server(name, server).await?;
        self.reload().await
    }

    /// Stop every server; later operations fail as closed.
    async fn shut_down(&self) {
        self.close
            .get_or_init(|| async {
                self.closed.store(true, Ordering::SeqCst);
                self.lifetime.cancel();
                let _lock = self.reload_lock.lock().await;
                let connections: Vec<Arc<McpConnection>> = {
                    let mut state = lock(&self.state);
                    let connections = state.pool.drain().filter_map(|(_, pooled)| pooled.connection).collect();
                    *state = State::default();
                    connections
                };
                lock(&self.offered).clear();
                lock(&self.workspace_events).take();
                join_all(connections.iter().map(|connection| connection.close())).await;
            })
            .await;
    }

    /// One bounded, cursor-paged view of the servers the agent sees.
    pub async fn list_server_page(&self, cancel: &CancellationToken, agent_id: &str, query: &Value) -> Result<Value> {
        assert_agent_id(agent_id)?;
        if !schemas::check(&schemas::SERVER_PAGE_QUERY, query) {
            bail!("MCP server page query is invalid.");
        }
        let limit = self.page_limit(query, 24);
        let mut servers: Vec<(String, CatalogServer)> = self.effective_servers(agent_id).into_iter().collect();
        servers.sort_by(|(left, _), (right, _)| locale_compare(left, right));
        let summaries = join_all(servers.into_iter().map(|(name, server)| self.server_summary(cancel, name, server))).await;
        let cursor = query.get("cursor").and_then(Value::as_str);
        let raw = page_from(summaries, cursor, limit, "servers")?;
        if !schemas::check(&schemas::SERVER_PAGE, &raw) {
            bail!("MCP returned an invalid server page.");
        }
        let visible = raw["servers"].as_array().map_or(0, Vec::len);
        if visible > limit {
            bail!("MCP server page returned more servers than requested.");
        }
        assert_unique(raw["servers"].as_array().into_iter().flatten().map(|server| &server["name"]), "server")?;
        assert_cursor_progress(cursor, raw.get("nextCursor").and_then(Value::as_str), visible)?;
        Ok(raw)
    }

    /// The server page `list_mcp_servers` shows, with any server quarantined for the agent's last
    /// tool list shown as failed.
    async fn list_server_page_for(&self, scope: &AgentScope<'_>, cancel: &CancellationToken, query: &Value) -> Result<Value> {
        let quarantined = lock(&self.offered).get(scope.id).map(|offered| offered.quarantined.clone()).unwrap_or_default();
        let mut page = self.list_server_page(cancel, scope.id, query).await?;
        if let Some(servers) = page["servers"].as_array_mut() {
            for server in servers {
                if let Some(replacement) = quarantined.iter().find(|candidate| candidate["name"] == server["name"]) {
                    *server = replacement.clone();
                }
            }
        }
        Ok(page)
    }

    async fn server_summary(&self, cancel: &CancellationToken, name: String, server: CatalogServer) -> Value {
        let config = &server.config;
        if config["enabled"] == false {
            return json!({"name": name, "status": "disabled", "toolCount": 0});
        }
        let (connection, failure) = self.pooled(server.connection_id.as_deref());
        let Some(connection) = connection else {
            return json!({"name": name, "status": "failed", "toolCount": 0, "errorMessage": failure.unwrap_or_else(|| "Connection failed.".into())});
        };
        match self.all_tools(cancel, &connection).await {
            Ok(tools) => {
                let mut summary = json!({"name": name, "status": "connected", "toolCount": tools.len()});
                for key in ["enabledTools", "disabledTools"] {
                    if let Some(list) = config.get(key) {
                        summary[key] = list.clone();
                    }
                }
                if connection.supports("prompts") {
                    summary["promptSupport"] = json!(true);
                }
                if connection.supports("resources") {
                    summary["resourceSupport"] = json!(true);
                }
                summary
            }
            Err(error) => json!({"name": name, "status": "failed", "toolCount": 0, "errorMessage": error_message(&error)}),
        }
    }

    fn pooled(&self, connection_id: Option<&str>) -> (Option<Arc<McpConnection>>, Option<String>) {
        let state = lock(&self.state);
        match connection_id.and_then(|id| state.pool.get(id)) {
            Some(pooled) => (pooled.connection.clone(), pooled.failure.clone()),
            None => (None, None),
        }
    }

    fn page_limit(&self, query: &Value, row_overhead: usize) -> usize {
        let requested = query.get("limit").and_then(Value::as_u64).map_or(self.max_page_size, |limit| limit as usize);
        requested.min(self.max_page_size).min(self.maximum_visible_rows(row_overhead))
    }

    /// One page of a server's live tool catalog.
    pub async fn list_tool_page(&self, cancel: &CancellationToken, agent_id: &str, query: &Value) -> Result<Value> {
        self.list_page(cancel, agent_id, query, Listing::Tools).await
    }

    pub async fn list_resource_page(&self, cancel: &CancellationToken, agent_id: &str, query: &Value) -> Result<Value> {
        self.list_page(cancel, agent_id, query, Listing::Resources).await
    }

    pub async fn list_resource_template_page(&self, cancel: &CancellationToken, agent_id: &str, query: &Value) -> Result<Value> {
        self.list_page(cancel, agent_id, query, Listing::ResourceTemplates).await
    }

    pub async fn list_prompt_page(&self, cancel: &CancellationToken, agent_id: &str, query: &Value) -> Result<Value> {
        self.list_page(cancel, agent_id, query, Listing::Prompts).await
    }

    async fn list_page(&self, cancel: &CancellationToken, agent_id: &str, query: &Value, listing: Listing) -> Result<Value> {
        assert_agent_id(agent_id)?;
        // How the page is named in errors, its items in the plural and singular, their identity
        // field, and its schema.
        let (page_name, plural, singular, identity, schema): (&str, &str, &str, &str, &schemas::Checked) = match listing {
            Listing::Tools => ("tool", "tools", "tool", "name", &schemas::TOOL_PAGE),
            Listing::Resources => ("resource", "resources", "resource", "uri", &schemas::RESOURCE_PAGE),
            Listing::ResourceTemplates => ("resource-template", "resource templates", "resource template", "uriTemplate", &schemas::RESOURCE_TEMPLATE_PAGE),
            Listing::Prompts => ("prompt", "prompts", "prompt", "name", &schemas::PROMPT_PAGE),
        };
        if !schemas::check(&schemas::SERVER_SCOPED_PAGE_QUERY, query) {
            bail!("MCP {page_name} page query is invalid.");
        }
        let limit = self.page_limit(query, 1);
        let connection = self.connection(agent_id, query["server"].as_str().unwrap_or_default())?;
        let values = match listing {
            Listing::Tools => self.all_tools(cancel, &connection).await?,
            other => self.all_listed(cancel, &connection, other).await?,
        };
        let cursor = query.get("cursor").and_then(Value::as_str);
        let key = listing.key();
        let raw = page_from(values, cursor, limit, key)?;
        if !schemas::check(schema, &raw) {
            bail!("MCP returned an invalid {page_name} page.");
        }
        let visible = raw[key].as_array().map_or(0, Vec::len);
        if visible > limit {
            bail!("MCP server page returned more {plural} than requested.");
        }
        assert_unique(raw[key].as_array().into_iter().flatten().map(|item| &item[identity]), singular)?;
        assert_cursor_progress(cursor, raw.get("nextCursor").and_then(Value::as_str), visible)?;
        Ok(raw)
    }

    /// Call one tool, answering any input its server asks for through the person.
    pub async fn call_tool(&self, cancel: &CancellationToken, agent_id: &str, input: &Value) -> Result<Value> {
        assert_agent_id(agent_id)?;
        if !schemas::check(&schemas::CALL_TOOL_INPUT, input) {
            bail!("MCP tool call input is invalid.");
        }
        let (server, name) = (input["server"].as_str().unwrap_or_default(), input["name"].as_str().unwrap_or_default());
        if let Some(policy) = self.tool_list_policy(cancel, agent_id, server).await?
            && !tool_allowed(&policy, name)
        {
            bail!("The MCP tool \"{name}\" is disabled by the server policy.");
        }
        let connection = self.connection(agent_id, server)?;
        let raw = connection.call_tool(cancel, name, input.get("arguments"), self.elicitation_handler(agent_id, cancel)).await?;
        if !schemas::check(&schemas::TOOL_RESULT, &raw) {
            bail!("MCP server returned an invalid tool result.");
        }
        Ok(raw)
    }

    pub async fn read_resource(&self, cancel: &CancellationToken, agent_id: &str, input: &Value) -> Result<Value> {
        assert_agent_id(agent_id)?;
        if !schemas::check(&schemas::READ_RESOURCE_INPUT, input) {
            bail!("MCP resource read input is invalid.");
        }
        let uri = input["uri"].as_str().unwrap_or_default();
        let connection = self.connection(agent_id, input["server"].as_str().unwrap_or_default())?;
        let raw = connection.read_resource(cancel, uri).await?;
        if !schemas::check(&schemas::READ_RESOURCE_RESULT, &raw) {
            bail!("MCP server returned an invalid resource result.");
        }
        let foreign = raw["contents"].as_array().into_iter().flatten().any(|content| content["uri"].as_str().is_some_and(|other| other != uri));
        if foreign {
            bail!("MCP resource result belongs to a different URI.");
        }
        Ok(raw)
    }

    pub async fn get_prompt(&self, cancel: &CancellationToken, agent_id: &str, input: &Value) -> Result<Value> {
        assert_agent_id(agent_id)?;
        if !schemas::check(&schemas::GET_PROMPT_INPUT, input) {
            bail!("MCP prompt input is invalid.");
        }
        let connection = self.connection(agent_id, input["server"].as_str().unwrap_or_default())?;
        let raw = connection.get_prompt(cancel, input["name"].as_str().unwrap_or_default(), input.get("arguments")).await?;
        if !schemas::check(&schemas::GET_PROMPT_RESULT, &raw) {
            bail!("MCP server returned an invalid prompt result.");
        }
        Ok(raw)
    }

    /// Every tool of one server, paging until the server says there are no more.
    async fn list_all_tools(&self, cancel: &CancellationToken, agent_id: &str, server: &str) -> Result<Vec<Value>> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_MCP_PAGE_SIZE {
            let mut query = json!({"server": server, "limit": self.max_page_size});
            if let Some(cursor) = &cursor {
                query["cursor"] = json!(cursor);
            }
            let page = self.list_tool_page(cancel, agent_id, &query).await?;
            tools.extend(page["tools"].as_array().cloned().unwrap_or_default());
            match page.get("nextCursor").and_then(Value::as_str) {
                None => {
                    assert_unique(tools.iter().map(|tool| &tool["name"]), "tool")?;
                    return Ok(tools);
                }
                Some(next) => cursor = Some(next.to_string()),
            }
        }
        bail!("MCP tool pagination exceeded its bound.")
    }

    /// Every server the agent sees, paging through the bounded view.
    async fn list_all_servers(&self, cancel: &CancellationToken, agent_id: &str) -> Result<Vec<Value>> {
        let mut servers = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_MCP_PAGE_SIZE {
            let mut query = json!({"limit": self.max_page_size});
            if let Some(cursor) = &cursor {
                query["cursor"] = json!(cursor);
            }
            let page = self.list_server_page(cancel, agent_id, &query).await?;
            servers.extend(page["servers"].as_array().cloned().unwrap_or_default());
            match page.get("nextCursor").and_then(Value::as_str) {
                None => {
                    assert_unique(servers.iter().map(|server| &server["name"]), "server")?;
                    return Ok(servers);
                }
                Some(next) => cursor = Some(next.to_string()),
            }
        }
        bail!("MCP server pagination exceeded its bound.")
    }

    /// The servers the protocol tools named when this agent's tools were last offered, or the
    /// connected servers now after a restart forgot them.
    async fn connected_server_names(&self, cancel: &CancellationToken, agent_id: &str) -> Result<Vec<String>> {
        if let Some(offered) = lock(&self.offered).get(agent_id) {
            return Ok(offered.connected.clone());
        }
        let servers = self.list_all_servers(cancel, agent_id).await?;
        Ok(servers.iter().filter(|server| server["status"] == "connected").filter_map(|server| server["name"].as_str().map(str::to_string)).collect())
    }

    /// The direct tool an agent was offered under `name`: its server and server-side name.
    fn offered_direct(&self, agent_id: &str, name: &str) -> Option<(String, String)> {
        lock(&self.offered).get(agent_id).and_then(|offered| offered.direct.get(name).cloned())
    }

    /// How many rows fit one model page with room for the continuation cursor.
    fn maximum_visible_rows(&self, row_overhead: usize) -> usize {
        let continuation_budget = "More results at cursor ".len() + MAX_MCP_CURSOR_LENGTH + 1;
        let row_budget = 128 + row_overhead + 1;
        let available = self.max_output_characters.saturating_sub(continuation_budget);
        ((available + 1) / row_budget).clamp(1, MAX_MCP_PAGE_SIZE)
    }

    /// The server's tool allow and deny lists, as its listing reports them.
    async fn tool_list_policy(&self, cancel: &CancellationToken, agent_id: &str, server_name: &str) -> Result<Option<Value>> {
        let servers = self.list_all_servers(cancel, agent_id).await?;
        let Some(server) = servers.into_iter().find(|candidate| candidate["name"] == server_name) else {
            return Ok(None);
        };
        let mut policy = Map::new();
        for key in ["disabledTools", "enabledTools"] {
            if let Some(list) = server.get(key) {
                policy.insert(key.into(), list.clone());
            }
        }
        Ok(Some(Value::Object(policy)))
    }

    fn connection(&self, agent_id: &str, name: &str) -> Result<Arc<McpConnection>> {
        let server = self.effective_servers(agent_id).shift_remove(name);
        let (connection, failure) = self.pooled(server.and_then(|server| server.connection_id).as_deref());
        if let Some(connection) = connection {
            return Ok(connection);
        }
        Err(match failure {
            None => anyhow!("MCP server \"{name}\" is not connected."),
            Some(failure) => anyhow!("MCP server \"{name}\" failed to connect: {failure}"),
        })
    }

    /// The servers the agent sees: its workspace's, overlaid by the user's own.
    fn effective_servers(&self, agent_id: &str) -> Catalog {
        let state = lock(&self.state);
        let mut servers = Catalog::new();
        if let Some(workspace) = state.agent_workspaces.get(agent_id) {
            for (name, server) in state.catalogs.get(&workspace_catalog(workspace)).into_iter().flatten() {
                servers.insert(name.clone(), server.clone());
            }
        }
        // User configuration is trusted and keeps its name when a workspace declares a collision.
        for (name, server) in state.catalogs.get(GLOBAL_CATALOG).into_iter().flatten() {
            servers.insert(name.clone(), server.clone());
        }
        servers
    }

    async fn ensure_agent_workspace(&self, agent_id: &str, configuration: &Value) -> Result<()> {
        if self.is_closed() {
            return Ok(());
        }
        {
            let state = lock(&self.state);
            if state.agent_workspaces.get(agent_id).is_some_and(|workspace| state.catalogs.contains_key(&workspace_catalog(workspace))) {
                return Ok(());
            }
        }
        self.activate_agent(agent_id, configuration).await
    }

    /// Give the agent's working folder demand for its catalog, loading it on first demand.
    async fn activate_agent(&self, agent_id: &str, configuration: &Value) -> Result<()> {
        if self.is_closed() {
            return Ok(());
        }
        let Some(workspace) = configuration["environment"]["workingDirectory"].as_str() else {
            return self.release_agent(agent_id).await;
        };
        let runner_id = configuration["modules"]["compute"]["runnerId"].as_str();
        let _lock = self.reload_lock.lock().await;
        if self.is_closed() {
            return Ok(());
        }
        let normalized = workspace_key(runner_id, workspace)?;
        let catalog_id = workspace_catalog(&normalized);
        let previous = {
            let state = lock(&self.state);
            if state.archived_workspaces.contains(&normalized) {
                return Ok(());
            }
            let previous = state.agent_workspaces.get(agent_id).cloned();
            if previous.as_deref() == Some(normalized.as_str()) && state.catalogs.contains_key(&catalog_id) {
                return Ok(());
            }
            previous
        };
        if let Some(previous) = previous.filter(|previous| *previous != normalized) {
            self.release_agent_locked(agent_id, &previous).await;
        }
        let needs_catalog = {
            let mut state = lock(&self.state);
            let demand = state.workspace_agents.entry(normalized.clone()).or_default();
            let first = demand.is_empty();
            demand.insert(agent_id.to_string());
            state.agent_workspaces.insert(agent_id.to_string(), normalized.clone());
            first || !state.catalogs.contains_key(&catalog_id)
        };
        if needs_catalog && let Err(error) = self.reconcile_workspace(&normalized).await {
            self.record_workspace_failure(&normalized, &error);
        }
        Ok(())
    }

    async fn release_agent(&self, agent_id: &str) -> Result<()> {
        let _lock = self.reload_lock.lock().await;
        let workspace = lock(&self.state).agent_workspaces.get(agent_id).cloned();
        if let Some(workspace) = workspace {
            self.release_agent_locked(agent_id, &workspace).await;
        }
        Ok(())
    }

    async fn release_agent_locked(&self, agent_id: &str, workspace: &str) {
        {
            let mut state = lock(&self.state);
            state.agent_workspaces.remove(agent_id);
            if let Some(demand) = state.workspace_agents.get_mut(workspace) {
                demand.shift_remove(agent_id);
                if !demand.is_empty() {
                    return;
                }
            }
            state.workspace_agents.shift_remove(workspace);
            state.workspace_failures.remove(workspace);
        }
        self.remove_catalog(&workspace_catalog(workspace)).await;
    }

    async fn reconcile_workspace(&self, workspace: &str) -> Result<()> {
        {
            let state = lock(&self.state);
            if self.is_closed() || state.archived_workspaces.contains(workspace) || state.workspace_agents.get(workspace).is_none_or(IndexSet::is_empty) {
                bail!("The workspace no longer requires an MCP catalog.");
            }
        }
        let servers = self.read_workspace_servers(workspace).await?;
        let global_names: HashSet<String> = lock(&self.state).catalogs.get(GLOBAL_CATALOG).map(|catalog| catalog.keys().cloned().collect()).unwrap_or_default();
        self.reconcile_catalogs(IndexMap::from([(workspace_catalog(workspace), without_server_names(servers, &global_names))])).await;
        lock(&self.state).workspace_failures.remove(workspace);
        Ok(())
    }

    /// Make each catalog what its configuration says, starting what it newly needs and stopping
    /// what nothing needs any more.
    async fn reconcile_catalogs(&self, catalogs: IndexMap<String, Map<String, Value>>) {
        let mut desired_catalogs: IndexMap<String, Catalog> = IndexMap::new();
        let mut inputs: IndexMap<String, (Value, String, Option<String>)> = IndexMap::new();
        for (catalog_id, servers) in catalogs {
            let mut desired = Catalog::new();
            for (name, config) in servers {
                if config["enabled"] == false {
                    desired.insert(name, CatalogServer { config, connection_id: None });
                    continue;
                }
                // A stdio server is a process on one machine, so the same configuration on two
                // machines is two servers. An HTTP server is reached from here either way.
                let runner_id = if config["transport"] == "stdio" { catalog_runner(&catalog_id, self.global_runner()) } else { None };
                let fingerprint = names::connection_fingerprint(&config);
                let connection_id = match &runner_id {
                    None => fingerprint,
                    Some(runner) => format!("runner:{runner}:{fingerprint}"),
                };
                desired.insert(name.clone(), CatalogServer { config: config.clone(), connection_id: Some(connection_id.clone()) });
                inputs.insert(connection_id, (config, name, runner_id));
            }
            desired_catalogs.insert(catalog_id, desired);
        }

        let needed: Vec<(String, (Value, String, Option<String>))> = {
            let state = lock(&self.state);
            inputs.into_iter().filter(|(id, _)| state.pool.get(id).is_none_or(|pooled| pooled.connection.is_none())).collect()
        };
        let attempts = join_all(needed.into_iter().map(|(connection_id, (config, name, runner_id))| async move {
            let runner = runner_id.as_deref().map(|id| OnRunner { runners: &self.runners, id, lifetime: &self.lifetime });
            (connection_id, McpConnection::connect(&name, &config, runner).await)
        }))
        .await;
        let mut started = Vec::new();
        {
            let mut state = lock(&self.state);
            for (connection_id, outcome) in attempts {
                let references = state.pool.remove(&connection_id).map(|pooled| pooled.references).unwrap_or_default();
                let pooled = match outcome {
                    Ok(connection) => {
                        started.push((connection_id.clone(), connection.clone()));
                        Pooled { references, connection: Some(connection), failure: None }
                    }
                    Err(failure) => Pooled { references, connection: None, failure: Some(error_text(&failure)) },
                };
                state.pool.insert(connection_id, pooled);
            }
        }
        for (connection_id, connection) in started {
            let (module, stopped) = (self.owner.clone(), Arc::downgrade(&connection));
            connection.on_close(move || record_stopped(&module, &connection_id, &stopped, "The MCP server stopped."));
        }

        // Every connection the batch needs is ready or has a bounded failure before any visible
        // catalog changes, and the swap below happens under one lock, so readers see the whole
        // old batch or the whole new one rather than a global/workspace half-state.
        let mut closing = {
            let mut state = lock(&self.state);
            for (catalog_id, desired) in &desired_catalogs {
                for connection_id in catalog_connection_ids(state.catalogs.get(catalog_id)) {
                    if let Some(pooled) = state.pool.get_mut(&connection_id) {
                        pooled.references.remove(catalog_id);
                    }
                }
                for connection_id in catalog_connection_ids(Some(desired)) {
                    if let Some(pooled) = state.pool.get_mut(&connection_id) {
                        pooled.references.insert(catalog_id.clone());
                    }
                }
            }
            for (catalog_id, desired) in desired_catalogs {
                state.catalogs.insert(catalog_id, desired);
            }
            take_unreferenced(&mut state)
        };
        // A disconnect can precede the completion of an in-flight handshake. Check the
        // published runner snapshot again after installing it so that completion cannot
        // leave a live-looking connection on a runner that is already absent.
        closing.extend(self.take_absent_runner_connections(&connected_runners(&self.runners.on_updated().borrow())));
        join_all(closing.iter().map(|connection| connection.close())).await;
    }

    async fn remove_catalog(&self, catalog_id: &str) {
        let closing = {
            let mut state = lock(&self.state);
            let catalog = state.catalogs.remove(catalog_id);
            for connection_id in catalog_connection_ids(catalog.as_ref()) {
                if let Some(pooled) = state.pool.get_mut(&connection_id) {
                    pooled.references.remove(catalog_id);
                }
            }
            take_unreferenced(&mut state)
        };
        join_all(closing.iter().map(|connection| connection.close())).await;
    }

    fn global_runner(&self) -> Option<String> {
        if self.runners.enabled() { self.runners.default_runner_id() } else { None }
    }

    /// Read a workspace's catalog on the machine that owns its folder.
    async fn read_workspace_servers(&self, workspace: &str) -> Result<Map<String, Value>> {
        let (path, runner_id) = parse_workspace_key(workspace);
        match runner_id {
            None => self.config.read_workspace_mcp_servers(Path::new(&path)),
            Some(runner) => read_runner_catalog(&self.config, &self.runners, &runner, &path, &self.lifetime.child_token()).await,
        }
    }

    fn record_workspace_failure(&self, workspace: &str, error: &anyhow::Error) {
        let message = error_message(error);
        {
            let mut state = lock(&self.state);
            if state.workspace_failures.get(workspace) == Some(&message) {
                return;
            }
            state.workspace_failures.insert(workspace.to_string(), message.clone());
        }
        tracing::warn!(workspace, error = %message, "Workspace MCP discovery failed.");
    }

    /// Every tool a server lists whose definition is valid and within the MCP limits.
    async fn all_tools(&self, cancel: &CancellationToken, connection: &McpConnection) -> Result<Vec<Value>> {
        let values = collect_pages(cancel, connection, Listing::Tools).await?;
        let mut tools = Vec::new();
        for tool in values {
            let mut candidate = json!({"name": tool["name"]});
            if let Some(description) = tool.get("description") {
                candidate["description"] = description.clone();
            }
            candidate["inputSchema"] = tool.get("inputSchema").cloned().unwrap_or(Value::Null);
            for key in ["title", "_meta"] {
                if let Some(value) = tool.get(key) {
                    candidate[key] = value.clone();
                }
            }
            if !schemas::check(&schemas::TOOL, &candidate) {
                tracing::warn!(
                    tool = %super::text::js_display(&tool["name"]),
                    server = %connection.name,
                    "An MCP tool is unavailable: its definition is invalid or exceeds the MCP limits."
                );
                continue;
            }
            tools.push(candidate);
        }
        Ok(tools)
    }

    async fn all_listed(&self, cancel: &CancellationToken, connection: &McpConnection, listing: Listing) -> Result<Vec<Value>> {
        let (identity, fields): (&[&str], &[&str]) = match listing {
            Listing::Resources => (&["uri", "name"], &["title", "description", "mimeType", "annotations", "_meta"]),
            Listing::ResourceTemplates => (&["uriTemplate", "name"], &["title", "description", "mimeType", "annotations", "_meta"]),
            Listing::Prompts => (&["name"], &["title", "description", "arguments", "_meta"]),
            Listing::Tools => (&["name"], &[]),
        };
        let values = collect_pages(cancel, connection, listing).await?;
        Ok(values
            .into_iter()
            .map(|item| {
                let mut mapped = Map::new();
                for key in identity {
                    mapped.insert((*key).to_string(), item.get(*key).cloned().unwrap_or(Value::Null));
                }
                for key in fields {
                    if let Some(value) = item.get(*key) {
                        mapped.insert((*key).to_string(), value.clone());
                    }
                }
                Value::Object(mapped)
            })
            .collect())
    }

    /// Answer a server's elicitations during one call by asking the person.
    fn elicitation_handler(&self, agent_id: &str, cancel: &CancellationToken) -> ElicitationHandler {
        let (module, agent_id, cancel) = (self.owner.clone(), agent_id.to_string(), cancel.clone());
        Arc::new(move |request: Value| {
            let (module, agent_id, cancel) = (module.clone(), agent_id.clone(), cancel.clone());
            async move {
                if !schemas::check(&schemas::ELICITATION_REQUEST, &request) {
                    return Ok(json!({"action": "decline"}));
                }
                let Some(module) = module.upgrade() else {
                    return Err(McpError::plain("The MCP module is closed.".to_string()));
                };
                elicitation::handle_elicitation(&request, |asked| async move {
                    module.ask_person(&agent_id, &asked, &cancel).await.map_err(|error| McpError::plain(error.to_string()))
                })
                .await
            }
            .boxed()
        })
    }

    /// Ask the elicitation's questions as an ordinary durable question and wait for the outcome.
    async fn ask_person(&self, agent_id: &str, request: &Value, cancel: &CancellationToken) -> Result<Value> {
        let questions: Vec<Value> = request["questions"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|question| {
                let mut asked = json!({
                    "id": question["id"],
                    "header": question["header"],
                    "question": js_slice(question["question"].as_str().unwrap_or_default(), 0, 4_000),
                });
                let options = question["options"].as_array().cloned().unwrap_or_default();
                if !options.is_empty() {
                    asked["options"] = Value::Array(
                        options
                            .iter()
                            .map(|option| json!({"label": option["label"], "description": js_slice(option["description"].as_str().unwrap_or_default(), 0, 2_000)}))
                            .collect(),
                    );
                    asked["multiSelect"] = question["multiSelect"].clone();
                }
                asked
            })
            .collect();
        let input = json!({"context": "An MCP server is asking for additional input.", "questions": questions});
        let request_id = request["requestId"].as_str().map(str::to_owned);
        let (user_input, agent) = (self.user_input.clone(), agent_id.to_owned());
        let pending = self.runtime.transact(move |ctx| user_input.ask(ctx, &agent, &input, request_id.as_deref())).await?;
        let id = pending["id"].as_str().unwrap_or_default().to_owned();
        let settled = self.user_input.wait(agent_id, &id, cancel).await?;
        if settled["status"] != "answered" {
            return Ok(json!({"status": "cancelled"}));
        }
        let answers: Map<String, Value> = match settled["answers"].as_object() {
            Some(answers) => answers.iter().map(|(id, answer)| (id.clone(), json!(answer_strings(answer)))).collect(),
            None => settled["questions"][0]["id"]
                .as_str()
                .map(|id| (id.to_string(), json!(answer_strings(&settled["answer"]))))
                .into_iter()
                .collect(),
        };
        Ok(json!({"status": "answered", "answers": answers}))
    }

    /// Keep a durable, bounded server index for prompt projections and restart diagnostics. The
    /// live connection catalog remains authoritative.
    async fn write_index(&self, cancel: &CancellationToken, agent_id: &str) -> Result<()> {
        let servers = self.list_all_servers(cancel, agent_id).await?;
        let updated_at = now();
        let mut rows = Vec::with_capacity(servers.len());
        for server in &servers {
            let mut entry = json!({"agentId": agent_id});
            if let Some(message) = server.get("errorMessage") {
                entry["errorMessage"] = message.clone();
            }
            if let Some(fingerprint) = server.get("fingerprint") {
                entry["fingerprint"] = fingerprint.clone();
            }
            entry["name"] = server["name"].clone();
            entry["status"] = server["status"].clone();
            entry["toolCount"] = server["toolCount"].clone();
            entry["updatedAt"] = json!(updated_at);
            if !schemas::check(&schemas::INDEXED_SERVER, &entry) {
                bail!("MCP server index entry is invalid.");
            }
            rows.push(entry);
        }
        let agent = agent_id.to_owned();
        self.runtime.transact(move |ctx| persistence::replace_server_index(ctx, &agent, &rows)).await
    }

    /// The tools one agent is offered for this request, rebuilt from the live catalog so an
    /// online reload reaches the next provider request without restarting the daemon.
    async fn agent_tools(&self, scope: &AgentScope<'_>) -> Result<Vec<ToolDefinition>> {
        self.initial_reload().await;
        let agent_id = scope.id;
        assert_agent_id(agent_id)?;
        self.ensure_agent_workspace(agent_id, scope.configuration).await?;
        let cancel = self.lifetime.child_token();
        let servers = self.list_all_servers(&cancel, agent_id).await?;
        let connected: Vec<Value> = servers.into_iter().filter(|server| server["status"] == "connected").collect();
        let mut loaded: Vec<(ToolDefinition, String, String)> = Vec::new();
        for server in &connected {
            let name = server["name"].as_str().unwrap_or_default();
            let listed = self.list_all_tools(&cancel, agent_id, name).await?;
            if loaded.len() + listed.len() > MAX_MCP_TOTAL_TOOLS {
                bail!("MCP tool catalog exceeded its bound.");
            }
            for tool in listed {
                let tool_name = tool["name"].as_str().unwrap_or_default();
                // A server outside this repo may describe its tool with any JSON Schema, but every
                // provider requires an object at the root and refuses the whole request otherwise.
                // Dropping the one tool keeps a single odd server from breaking every turn.
                if tool["inputSchema"]["type"] != "object" {
                    tracing::warn!(tool = tool_name, server = name, "An MCP tool is unavailable: its input schema is not an object at the top level.");
                    continue;
                }
                match tools::direct_tool(name, &tool) {
                    Ok(definition) => loaded.push((definition, name.to_string(), tool_name.to_string())),
                    Err(error) => tracing::warn!(tool = tool_name, server = name, error = %error_message(&error), "An MCP tool is unavailable."),
                }
            }
        }
        let names: Vec<&str> = loaded.iter().map(|(definition, _, _)| definition.name.as_str()).collect();
        let (servers, accepted) = merge_names(connected, &names);
        let direct: Vec<(ToolDefinition, String, String)> = loaded.into_iter().enumerate().filter(|(index, _)| accepted.contains(index)).map(|(_, tool)| tool).collect();
        let quarantined: Vec<Value> = servers.iter().filter(|server| server["status"] == "failed").cloned().collect();
        if !schemas::check(&schemas::SERVER_SUMMARY_LIST, &Value::Array(quarantined.clone())) {
            bail!("MCP quarantined server list is invalid.");
        }
        let available: Vec<String> =
            servers.iter().filter(|server| server["status"] == "connected").filter_map(|server| server["name"].as_str().map(str::to_string)).collect();
        let protocol = if available.is_empty() { Vec::new() } else { tools::protocol_tools(&available)? };
        let mut offered = vec![tools::list_mcp_servers()];
        offered.extend(tools::configuration_tools());
        offered.extend(direct.iter().map(|(definition, _, _)| definition.clone()));
        offered.extend(protocol);
        self.remember_offered(
            agent_id,
            Offered {
                connected: available,
                quarantined,
                direct: direct.into_iter().map(|(definition, server, tool)| (definition.name, (server, tool))).collect(),
            },
        );
        Ok(offered)
    }

    fn remember_offered(&self, agent_id: &str, offered: Offered) {
        let mut remembered = lock(&self.offered);
        remembered.shift_remove(agent_id);
        while remembered.len() >= MAX_OFFERED_AGENTS {
            remembered.shift_remove_index(0);
        }
        remembered.insert(agent_id.to_string(), offered);
    }
}

#[async_trait]
impl AgentModule for McpModule {
    fn name(&self) -> &'static str {
        "mcp"
    }

    async fn available_tools(&self, scope: &AgentScope<'_>) -> Result<Vec<ToolDefinition>> {
        self.agent_tools(scope).await
    }

    async fn before_loop(&self, scope: &AgentScope<'_>, cancel: CancellationToken) -> Result<()> {
        self.initial_reload().await;
        self.ensure_agent_workspace(scope.id, scope.configuration).await?;
        self.write_index(&cancel, scope.id).await
    }

    fn reloadable(&self, call: &Value) -> Option<bool> {
        // Only fixed listings are reloadable, so which agent was offered a direct tool is moot.
        let scope = AgentScope { id: "", configuration: &Value::Null, settings: &Value::Null };
        Some(tools::is_reloadable(&self.called(&scope, call)?))
    }

    fn permission_policy(&self, scope: &AgentScope<'_>, call: &Value) -> Option<Result<ToolPermissionPolicy>> {
        let called = self.called(scope, call)?;
        Some(tools::policy(&called, call))
    }

    async fn execute_tool(&self, scope: &AgentScope<'_>, call: &Value, cancel: CancellationToken) -> Option<Message> {
        let called = self.called(scope, call)?;
        let module = self.owner.upgrade()?;
        Some(module.execute(scope, called, call, cancel).await)
    }

    async fn close(&self) {
        self.shut_down().await;
    }
}

/// One row per server: name, status and tool count, with any failure after it.
pub(super) fn format_server_page(page: &Value, maximum: usize) -> Result<String> {
    if !schemas::check(&schemas::SERVER_PAGE, page) {
        bail!("Cannot format an invalid MCP server page.");
    }
    let servers = page["servers"].as_array().cloned().unwrap_or_default();
    let identities: Vec<String> = servers
        .iter()
        .map(|server| format!("{}\t{}\t{} tools", server["name"].as_str().unwrap_or_default(), server["status"].as_str().unwrap_or_default(), server["toolCount"]))
        .collect();
    let suffixes: Vec<Option<String>> = servers.iter().map(|server| server["errorMessage"].as_str().map(|message| format!(" — {message}"))).collect();
    format_identity_rows(&identities, &suffixes, next_cursor(page), maximum, "No MCP servers.")
}

pub(super) fn format_tool_page(page: &Value, maximum: usize) -> Result<String> {
    if !schemas::check(&schemas::TOOL_PAGE, page) {
        bail!("Cannot format an invalid MCP tool page.");
    }
    format_rows(page, maximum, "tools", "name", |tool| tool["description"].as_str().map(|description| format!(" — {description}")), "No MCP tools.")
}

pub(super) fn format_resource_page(page: &Value, maximum: usize) -> Result<String> {
    if !schemas::check(&schemas::RESOURCE_PAGE, page) {
        bail!("Cannot format an invalid MCP resource page.");
    }
    format_rows(page, maximum, "resources", "uri", |resource| named_differently(resource, "uri"), "No MCP resources.")
}

pub(super) fn format_resource_template_page(page: &Value, maximum: usize) -> Result<String> {
    if !schemas::check(&schemas::RESOURCE_TEMPLATE_PAGE, page) {
        bail!("Cannot format an invalid MCP resource-template page.");
    }
    format_rows(page, maximum, "resourceTemplates", "uriTemplate", |template| named_differently(template, "uriTemplate"), "No MCP resource templates.")
}

pub(super) fn format_prompt_page(page: &Value, maximum: usize) -> Result<String> {
    if !schemas::check(&schemas::PROMPT_PAGE, page) {
        bail!("Cannot format an invalid MCP prompt page.");
    }
    format_rows(page, maximum, "prompts", "name", |prompt| prompt["description"].as_str().map(|description| format!(" — {description}")), "No MCP prompts.")
}

fn format_rows(page: &Value, maximum: usize, key: &str, identity: &str, suffix: impl Fn(&Value) -> Option<String>, empty: &str) -> Result<String> {
    let items = page[key].as_array().cloned().unwrap_or_default();
    let identities: Vec<String> = items.iter().map(|item| item[identity].as_str().unwrap_or_default().to_string()).collect();
    let suffixes: Vec<Option<String>> = items.iter().map(suffix).collect();
    format_identity_rows(&identities, &suffixes, next_cursor(page), maximum, empty)
}

/// The first discovery of the user's catalog, run in Durable Functions' lifetime.
struct Discover(Weak<McpModule>);

impl DurableFunction for Discover {
    fn execute(self: Arc<Self>, _call: Value, _kv: CallKv, cancel: CancellationToken) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            self.0.upgrade().ok_or_else(|| anyhow!("The MCP module has stopped."))?.discover(&cancel).await;
            Ok(Value::Null)
        })
    }
}

/// The catalog change one workspace event implies, by workspace key: a new workspace may be a
/// folder an archived one used to occupy, and an archived one takes its servers with it.
fn workspace_change(event: &Value) -> Option<(String, &'static str)> {
    let change = match (event["type"].as_str(), event["change"].as_str()) {
        (Some("workspace_created"), _) => "active",
        (Some("workspace_updated"), Some("begin_archive")) | (Some("workspace_archived"), _) => "released",
        _ => return None,
    };
    let workspace = &event["workspace"];
    let key = workspace_key(workspace["runnerId"].as_str(), workspace["path"].as_str().unwrap_or_default()).ok()?;
    Some((key, change))
}

/// Owe the change a workspace event implies inside the transaction that commits the event, so it
/// is applied after the commit and never for a change that rolled back.
fn owe_workspace_event(durable: &Arc<DurableFunctionsModule>, ctx: &Context<'_>, event: &Value) -> Result<()> {
    let Some((workspace, change)) = workspace_change(event) else { return Ok(()) };
    persistence::record_workspace_intent(ctx, &workspace, change)?;
    owe_workspace_changes(durable, ctx)
}

/// Owe one drain of every owed workspace change; changes owed while one is pending join it.
fn owe_workspace_changes(durable: &Arc<DurableFunctionsModule>, ctx: &Context<'_>) -> Result<()> {
    durable.invoke(ctx, &json!({"function": WORKSPACES_FUNCTION, "arguments": {}, "operationId": WORKSPACES_FUNCTION, "lockKeys": [DURABLE_LOCK]}))?;
    Ok(())
}

/// Every workspace change MCP owes, applied in Durable Functions' lifetime.
struct ApplyWorkspaceChanges(Weak<McpModule>);

impl DurableFunction for ApplyWorkspaceChanges {
    fn execute(self: Arc<Self>, _call: Value, _kv: CallKv, cancel: CancellationToken) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            self.0.upgrade().ok_or_else(|| anyhow!("The MCP module has stopped."))?.apply_workspace_changes(&cancel).await?;
            Ok(Value::Null)
        })
    }

    /// A change committed after the drain last looked joined this call while it was still owed.
    /// The call is settled in this same transaction, so owing a new one here loses nothing.
    fn success(&self, ctx: &Context<'_>, _call: &Value, _result: &Value) -> Result<()> {
        let Some(module) = self.0.upgrade() else { return Ok(()) };
        if persistence::query_next_workspace_intent(ctx)?.is_some() {
            owe_workspace_changes(&module.durable, ctx)?;
        }
        Ok(())
    }
}

/// A live connection that ended is a failure, which the next reload starts again.
fn record_stopped(module: &Weak<McpModule>, connection_id: &str, connection: &Weak<McpConnection>, failure: &str) {
    let (Some(module), Some(connection)) = (module.upgrade(), connection.upgrade()) else { return };
    let mut state = lock(&module.state);
    let Some(pooled) = state.pool.get_mut(connection_id) else { return };
    if pooled.connection.as_ref().is_some_and(|current| Arc::ptr_eq(current, &connection)) {
        pooled.connection = None;
        pooled.failure = Some(failure.to_string());
    }
}

/// Remove every pooled connection no catalog references, answering the live ones to close.
fn take_unreferenced(state: &mut State) -> Vec<Arc<McpConnection>> {
    let unreferenced: Vec<String> = state.pool.iter().filter(|(_, pooled)| pooled.references.is_empty()).map(|(id, _)| id.clone()).collect();
    unreferenced.into_iter().filter_map(|id| state.pool.remove(&id).and_then(|pooled| pooled.connection)).collect()
}

async fn collect_pages(cancel: &CancellationToken, connection: &McpConnection, listing: Listing) -> Result<Vec<Value>> {
    let mut collected = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_MCP_PAGE_SIZE {
        let page = match listing {
            Listing::Tools => connection.list_tools(cancel, cursor.as_deref()).await?,
            Listing::Resources => connection.list_resources(cancel, cursor.as_deref()).await?,
            Listing::ResourceTemplates => connection.list_resource_templates(cancel, cursor.as_deref()).await?,
            Listing::Prompts => connection.list_prompts(cancel, cursor.as_deref()).await?,
        };
        collected.extend(page[listing.key()].as_array().cloned().unwrap_or_default());
        if collected.len() > MAX_MCP_TOTAL_TOOLS {
            bail!("MCP catalog exceeded its configured bound.");
        }
        let Some(next) = page.get("nextCursor").and_then(Value::as_str) else { return Ok(collected) };
        if cursor.as_deref() == Some(next) {
            bail!("MCP cursor did not advance.");
        }
        cursor = Some(next.to_string());
    }
    bail!("MCP pagination exceeded its configured bound.")
}

/// The `limit` items after the decimal offset `cursor`, and the cursor after them when more remain.
fn page_from(values: Vec<Value>, cursor: Option<&str>, limit: usize, key: &str) -> Result<Value> {
    let offset = cursor.map_or(0.0, elicitation::js_to_number);
    let safe = offset.fract() == 0.0 && offset.abs() <= 9_007_199_254_740_991.0;
    if !safe || offset < 0.0 || offset > values.len() as f64 {
        bail!("MCP cursor is invalid.");
    }
    let offset = offset as usize;
    let total = values.len();
    let selected: Vec<Value> = values.into_iter().skip(offset).take(limit).collect();
    let end = offset + selected.len();
    let mut page = Map::new();
    page.insert(key.to_string(), Value::Array(selected));
    if end < total {
        page.insert("nextCursor".into(), json!(end.to_string()));
    }
    Ok(Value::Object(page))
}

fn next_cursor(page: &Value) -> Option<&str> {
    page.get("nextCursor").and_then(Value::as_str)
}

fn named_differently(item: &Value, identity: &str) -> Option<String> {
    (item["name"] != item[identity]).then(|| format!(" — {}", item["name"].as_str().unwrap_or_default()))
}

fn assert_agent_id(agent_id: &str) -> Result<()> {
    if !schemas::check(&schemas::AGENT_ID, &json!(agent_id)) {
        bail!("MCP agent identity is invalid.");
    }
    Ok(())
}

fn assert_unique<'a>(values: impl Iterator<Item = &'a Value>, kind: &str) -> Result<()> {
    let mut seen = HashSet::new();
    for value in values {
        if !seen.insert(value.to_string()) {
            bail!("MCP server returned duplicate {kind} identities.");
        }
    }
    Ok(())
}

fn assert_cursor_progress(requested: Option<&str>, next: Option<&str>, visible: usize) -> Result<()> {
    let Some(next) = next else { return Ok(()) };
    if visible == 0 || Some(next) == requested {
        bail!("MCP server returned a non-advancing cursor.");
    }
    Ok(())
}

fn tool_allowed(policy: &Value, name: &str) -> bool {
    let listed = |key: &str| policy.get(key).and_then(Value::as_array).map(|names| names.iter().any(|candidate| candidate == name));
    listed("enabledTools").unwrap_or(true) && !listed("disabledTools").unwrap_or(false)
}

/// One stored answer as the strings an elicitation reads: the text, or the chosen labels and any
/// added text.
fn answer_strings(answer: &Value) -> Vec<String> {
    match answer {
        Value::String(text) => vec![text.clone()],
        Value::Object(structured) => {
            let mut strings: Vec<String> = structured.get("selectedOptions").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
            strings.extend(structured.get("text").and_then(Value::as_str).map(str::to_string));
            strings
        }
        _ => Vec::new(),
    }
}

/// An error as one bounded line, the way failures are shown beside a server.
fn error_message(error: &anyhow::Error) -> String {
    error_text(&error.to_string())
}

fn error_text(text: &str) -> String {
    let mut collapsed = String::with_capacity(text.len());
    let mut in_space = false;
    for character in text.chars() {
        let space = js_is_whitespace(character);
        if !(space && in_space) {
            collapsed.push(if space { ' ' } else { character });
        }
        in_space = space;
    }
    let bounded = js_slice(&collapsed, 0, MAX_MCP_ERROR_MESSAGE_LENGTH).to_string();
    if bounded.is_empty() { "Connection failed.".into() } else { bounded }
}

/// The page text a model reads: every row with its detail while the page fits, then as many bare
/// identities as fit with the details that still fit, and the continuation cursor always.
fn format_identity_rows(identities: &[String], suffixes: &[Option<String>], next_cursor: Option<&str>, maximum: usize, empty: &str) -> Result<String> {
    let continuation = next_cursor.map(|cursor| format!("More results at cursor {cursor}."));
    let rows: Vec<String> = identities.iter().zip(suffixes).map(|(identity, suffix)| format!("{identity}{}", suffix.as_deref().unwrap_or(""))).collect();
    let mut output = if rows.is_empty() { empty.to_string() } else { rows.join("\n") };
    if let Some(continuation) = &continuation {
        output = format!("{output}\n{continuation}");
    }
    if js_length(&output) <= maximum {
        return Ok(output);
    }
    let continuation_size = continuation.as_ref().map_or(0, |continuation| js_length(continuation) + 1);
    let (mut size, mut count) = (0usize, 0usize);
    for identity in identities {
        let next_size = size + js_length(identity) + usize::from(count != 0);
        if next_size + continuation_size > maximum {
            break;
        }
        count += 1;
        size = next_size;
    }
    if count == 0 {
        bail!("MCP model output cannot fit a complete identity.");
    }
    let joined = |rows: &[String]| match &continuation {
        None => rows.join("\n"),
        Some(continuation) => format!("{}\n{continuation}", rows.join("\n")),
    };
    let mut compact: Vec<String> = identities[..count].to_vec();
    for index in 0..count {
        let Some(suffix) = &suffixes[index] else { continue };
        let mut candidate = compact.clone();
        candidate[index] = format!("{}{suffix}", candidate[index]);
        if js_length(&joined(&candidate)) <= maximum {
            compact[index] = candidate[index].clone();
        }
    }
    let output = joined(&compact);
    if continuation.is_some() && js_length(&output) > maximum {
        bail!("MCP model output cannot fit its continuation cursor.");
    }
    Ok(output)
}

/// Merge the servers' direct tool names into one ordinary array: the servers it reports and the
/// indexes of the tools it keeps. A name collision quarantines every server contributing to it
/// while unrelated servers stay available.
fn merge_names(servers: Vec<Value>, names: &[&str]) -> (Vec<Value>, HashSet<usize>) {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for name in names {
        *counts.entry(name).or_default() += 1;
    }
    let conflicting: IndexSet<&str> = names.iter().copied().filter(|name| counts[name] > 1).collect();
    if conflicting.is_empty() {
        return (servers, (0..names.len()).collect());
    }
    let prefix = |server: &Value| format!("mcp__{}__", names::normalize_mcp_name(server["name"].as_str().unwrap_or_default()));
    let prefixes: Vec<String> = servers.iter().map(prefix).collect();
    let mut quarantined_prefixes = Vec::new();
    let mut merged: Vec<Value> = servers
        .into_iter()
        .zip(&prefixes)
        .map(|(mut server, prefix)| {
            let conflicts: Vec<&str> = conflicting.iter().copied().filter(|name| name.starts_with(prefix.as_str())).collect();
            if conflicts.is_empty() {
                return server;
            }
            quarantined_prefixes.push(prefix.clone());
            let name = server["name"].clone();
            server["errorMessage"] = json!(collision_message(&conflicts));
            server["name"] = name;
            server["status"] = json!("failed");
            server["toolCount"] = json!(0);
            server
        })
        .collect();
    let unresolved: Vec<&str> = conflicting.iter().copied().filter(|name| !prefixes.iter().any(|prefix| name.starts_with(prefix.as_str()))).collect();
    if !unresolved.is_empty() {
        merged.push(json!({"errorMessage": format!("Tool name conflict: {}", unresolved.join(", ")), "name": "MCP tools", "status": "failed", "toolCount": 0}));
    }
    let accepted = names
        .iter()
        .enumerate()
        .filter(|(_, name)| !conflicting.contains(*name) && !quarantined_prefixes.iter().any(|prefix| name.starts_with(prefix.as_str())))
        .map(|(index, _)| index)
        .collect();
    (merged, accepted)
}

fn collision_message(names: &[&str]) -> String {
    let message = format!("Tool name conflict (collision after normalization): {}. The server was quarantined.", names.join(", "));
    if js_length(&message) <= MAX_MCP_ERROR_MESSAGE_LENGTH {
        return message;
    }
    let suffix = "… [truncated]";
    format!("{}{suffix}", js_slice(&message, 0, MAX_MCP_ERROR_MESSAGE_LENGTH - js_length(suffix)))
}

/// `path.resolve`: absolute, with `.` and `..` collapsed, without touching the filesystem.
fn resolve(path: &str) -> PathBuf {
    let path = Path::new(path);
    let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut resolved = PathBuf::from("/");
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(part) => resolved.push(part),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    resolved
}

/// One workspace folder: its path on this machine, or its runner and its path there. The same path
/// on two machines is two folders.
fn workspace_key(runner_id: Option<&str>, path: &str) -> Result<String> {
    if path.is_empty() || js_length(path) > 4_096 {
        bail!("Workspace path is invalid.");
    }
    let resolved = resolve(path).display().to_string();
    Ok(match runner_id {
        None => resolved,
        Some(runner) => format!("runner:{runner}:{resolved}"),
    })
}

fn parse_workspace_key(key: &str) -> (String, Option<String>) {
    let parsed = key.strip_prefix("runner:").and_then(|rest| {
        let (runner, path) = rest.split_once(':')?;
        let mut characters = runner.chars();
        let valid = characters.next().is_some_and(|first| first.is_ascii_lowercase())
            && runner.len() <= 64
            && characters.all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_' || character == '-')
            && !path.is_empty();
        valid.then(|| (path.to_string(), Some(runner.to_string())))
    });
    parsed.unwrap_or_else(|| (key.to_string(), None))
}

fn workspace_catalog(workspace: &str) -> String {
    format!("{WORKSPACE_CATALOG_PREFIX}{workspace}")
}

/// The runner a catalog's stdio servers start on, or none for this machine.
fn catalog_runner(catalog_id: &str, global_runner: Option<String>) -> Option<String> {
    if catalog_id == GLOBAL_CATALOG {
        return global_runner;
    }
    parse_workspace_key(&catalog_id[WORKSPACE_CATALOG_PREFIX.len()..]).1
}

fn catalog_connection_ids(catalog: Option<&Catalog>) -> HashSet<String> {
    catalog.into_iter().flat_map(|catalog| catalog.values()).filter_map(|server| server.connection_id.clone()).collect()
}

async fn read_runner_catalog(config: &ConfigModule, runners: &RunnersModule, runner: &str, workspace: &str, cancel: &CancellationToken) -> Result<Map<String, Value>> {
    let file = Path::new(workspace).join("mcp.toml");
    match runners.read(Some(runner), &file, MAX_WORKSPACE_CATALOG_BYTES, cancel).await {
        Ok(bytes) => config.parse_mcp_servers(&String::from_utf8_lossy(&bytes)),
        Err(error) if error.downcast_ref::<RunnerUnavailableError>().is_some() => Err(error),
        Err(error) if matches!(runners.error_code(&error), Some("ENOENT" | "ENOTDIR")) => Ok(Map::new()),
        Err(error) => bail!("Could not read Happy Agent configuration '{}'. {}", file.display(), error_message(&error)),
    }
}

fn connected_runners(snapshot: &Value) -> HashSet<String> {
    snapshot["runners"].as_array().into_iter().flatten()
        .filter(|runner| runner["status"] == "connected")
        .filter_map(|runner| runner["id"].as_str().map(str::to_owned)).collect()
}

fn without_server_names(servers: Map<String, Value>, omitted: &HashSet<String>) -> Map<String, Value> {
    servers.into_iter().filter(|(name, _)| !omitted.contains(name)).collect()
}

fn catalog_server_configs(catalog: &Catalog) -> Map<String, Value> {
    catalog.iter().map(|(name, server)| (name.clone(), server.config.clone())).collect()
}
