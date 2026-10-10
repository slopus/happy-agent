//! Services owns admission, original durable records, native execution and teardown.
mod execution;
#[cfg(target_os = "linux")]
mod io;
mod paging;
mod persistence;
mod readers;
mod tokens;
pub use execution::Connection;
#[cfg(test)]
mod tests;

use super::{
    config::ConfigModule,
    durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration},
    events::EventsModule,
    identity::{Versions, now},
    lifecycle::LifecycleModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result, bail, ensure};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub struct ServicesModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    lifecycle: Arc<LifecycleModule>,
    events: Arc<EventsModule>,
    schemas: Schemas,
    versions: Mutex<Versions>,
    live: Mutex<BTreeMap<String, Live>>,
    teardown: Mutex<BTreeMap<String, Weak<tokio::sync::Mutex<()>>>>,
    closed: AtomicBool,
    tokens: tokens::AccessTokens,
}
struct Live {
    execution: Arc<execution::Execution>,
    workspace: String,
    ended_at: Option<u64>,
    readers: Arc<readers::Readers>,
    retirement: Option<tokio::task::JoinHandle<()>>,
}
impl Drop for Live {
    fn drop(&mut self) {
        if let Some(task) = self.retirement.take() {
            task.abort();
        }
    }
}
struct ServiceExecutor(Weak<ServicesModule>);

impl ServicesModule {
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        lifecycle: Arc<LifecycleModule>,
        events: Arc<EventsModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for schema in [
            "serviceExecutionCall",
            "serviceDefinition",
            "serviceInputOptions",
            "serviceReader",
            "serviceStoredRecord",
            "serviceHeader",
            "serviceIndexPage",
            "serviceExecution",
            "serviceLifetime",
            "serviceEvent",
            "workspaceServiceCleanup",
            "supervisorPolicy",
            "serviceAccessScope",
            "serviceAccessPayload",
            "serviceAccessToken",
        ] {
            let _ = schemas.valid(schema, &Value::Null)?;
        }
        let module = Arc::new(Self {
            config,
            runtime,
            durable: durable.clone(),
            lifecycle,
            events,
            schemas,
            versions: Mutex::new(Versions::new()),
            live: Mutex::new(BTreeMap::new()),
            teardown: Mutex::new(BTreeMap::new()),
            closed: AtomicBool::new(false),
            tokens: tokens::AccessTokens::new(),
        });
        durable.register(Registration {
            name: "services.execution".into(),
            arguments_schema: "serviceExecutionCall",
            result_schema: "ownerNull",
            function: Arc::new(ServiceExecutor(Arc::downgrade(&module))),
        })?;
        Ok(module)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        // Services originally declares no SQL migration: these exact keys live in
        // the main AgentStorage root, which Runtime already opened and migrated.
        Ok(())
    }
    /// Preparation owns filesystem and policy reads; creation below participates
    /// in the caller's atomic workspace/agent mutation without launching a process.
    pub async fn prepare_options(
        &self,
        configuration: &Value,
        definition: &Value,
        mode: &str,
    ) -> Result<Value> {
        ensure!(
            self.schemas.valid("serviceDefinition", definition)?,
            "The service definition is invalid."
        );
        ensure!(
            matches!(mode, "auto" | "full_access"),
            "Starting a sandboxed service requires Auto or Full access."
        );
        let workspace = self
            .config
            .execution_environment(configuration, &json!({}))?
            .root;
        let id = cuid2::create_id();
        let execution = self.config.service_execution(&id)?;
        let mut sandbox = definition["sandbox"].clone();
        let mut outbound = Vec::new();
        for value in sandbox["outbound"].as_array().expect("validated sandbox") {
            let host = value["hostname"]
                .as_str()
                .expect("validated hostname")
                .to_ascii_lowercase();
            let value = json!({"hostname":host.trim_end_matches('.'),"port":value["port"]});
            if !outbound.contains(&value) {
                outbound.push(value);
            }
        }
        sandbox["outbound"] = json!(outbound);
        let network = json!({"egress":mode=="full_access"||!outbound.is_empty(),"localBinding":mode=="full_access","allowedHosts":if mode=="full_access"{Vec::<Value>::new()}else{outbound.iter().map(|value|value["hostname"].clone()).collect()}});
        let mut options = json!({"execution":execution,"command":definition["command"],"cwd":definition["cwd"],"port":definition["port"],"tty":definition["tty"],"sandbox":sandbox,"permissions":{"mode":mode,"network":network}});
        if let Some(policy) = self.config.service_network_policy(&workspace).await? {
            options["networkPolicy"] = policy;
        }
        Ok(options)
    }
    /// The caller supplies workspace placement resolved through its owning module,
    /// never a model-selected workspace. Options were prepared before entering TX.
    pub fn create(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        workspace: &str,
        agent: &str,
        definition: &Value,
        options: &Value,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        ensure!(
            !self.closed.load(Ordering::Acquire) && !self.lifecycle.is_draining(),
            "Workspace services are shutting down."
        );
        ensure!(
            self.schemas.valid("serviceDefinition", definition)?,
            "The service definition is invalid."
        );
        let id = options["execution"]["id"]
            .as_str()
            .context("The service execution identity is missing.")?;
        let call = json!({"workspaceId":workspace,"serviceId":id,"daemonId":self.lifecycle.daemon_id(),"options":options});
        ensure!(
            self.schemas.valid("serviceExecutionCall", &call)?,
            "The service execution options are invalid."
        );
        self.available_owner(ctx, agent)?;
        for field in ["command", "cwd", "port", "tty"] {
            ensure!(
                definition[field] == options[field],
                "The service execution does not match its reviewed definition."
            );
        }
        ensure!(
            options["execution"] == self.config.service_execution(id)?,
            "The service execution does not belong to this installation."
        );
        let service = json!({"id":id,"workspaceId":workspace,"agentId":agent,"processId":null,"name":definition["name"],"command":options["command"],"cwd":options["cwd"],"port":options["port"],"tty":options["tty"],"protocol":"http","access":"workspace","sandbox":options["sandbox"],"status":"starting","endpointStatus":"waiting","exitCode":null,"error":null,"version":self.version(None)?,"createdAt":now(),"updatedAt":now(),"startedAt":null,"endedAt":null});
        let record = persistence::create(
            ctx,
            &self.schemas,
            json!({"service":service,"execution":options["execution"]}),
        )?;
        self.durable.invoke(ctx,&json!({"function":"services.execution","operationId":format!("service.execution.{id}"),"lockKeys":[format!("service.{id}")],"arguments":call}))?;
        self.publish(
            ctx,
            json!({"type":"service.created","service":record["service"]}),
        )?;
        Ok(record["service"].clone())
    }
    fn available_owner(&self, ctx: &Context<'_>, agent: &str) -> Result<Value> {
        let config = self
            .runtime
            .agent_config(ctx, agent)?
            .context("The service owner was not found.")?;
        ensure!(
            self.schemas
                .valid("serviceAgentCompute", &config["modules"]["compute"])?,
            "The service owner has an invalid compute configuration."
        );
        ensure!(
            config["metadata"]["archived"] != true && config["metadata"]["archivedAt"].is_null(),
            "This agent is not available for new services."
        );
        // Remote providers cannot enforce this native service boundary.
        ensure!(
            config["modules"]["compute"]["runnerId"].is_null()
                && config["modules"]["compute"]["docker"].is_null(),
            "This machine cannot enforce the sandbox services need."
        );
        Ok(config)
    }
    pub fn get(&self, ctx: &Context<'_>, workspace: &str, id: &str) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        Ok(persistence::required(ctx, &self.schemas, workspace, id)?["service"].clone())
    }
    pub fn list(
        &self,
        ctx: &Context<'_>,
        workspace: &str,
        include_stopped: bool,
        limit: usize,
        before: Option<u64>,
    ) -> Result<(Vec<Value>, Option<u64>)> {
        self.runtime.assert_context(ctx)?;
        let (records, next) = persistence::page(
            ctx,
            &self.schemas,
            workspace,
            include_stopped,
            limit,
            before,
        )?;
        Ok((
            records
                .into_iter()
                .map(|record| record["service"].clone())
                .collect(),
            next,
        ))
    }
    pub fn list_page(&self, ctx: &Context<'_>, workspace: &str, query: &Value) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        ensure!(
            self.schemas.valid("serviceListQuery", query)?,
            "The service list query is invalid."
        );
        let stopped = query["includeStopped"].as_bool().unwrap_or(false);
        let before = paging::read(
            &self.schemas,
            workspace,
            stopped,
            query["pageCursor"].as_str(),
        )?;
        let (services, next) = self.list(
            ctx,
            workspace,
            stopped,
            query["limit"].as_u64().unwrap_or(50) as usize,
            before,
        )?;
        Ok(
            json!({"services":services,"nextPageCursor":paging::write(&self.schemas,workspace,stopped,next)?}),
        )
    }
    pub fn list_for_tool(
        &self,
        ctx: &Context<'_>,
        workspace: &str,
        include_stopped: bool,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let (active, _) = persistence::page(ctx, &self.schemas, workspace, false, 32, None)?;
        if !include_stopped {
            return Ok(
                json!({"services":active.into_iter().map(|record|record["service"].clone()).collect::<Vec<_>>(),"omittedHistory":false}),
            );
        }
        let (history, _) = persistence::page(ctx, &self.schemas, workspace, true, 288, None)?;
        let total = history
            .first()
            .map(|record| record["sequence"].as_u64().expect("validated record") + 1)
            .unwrap_or(0);
        let stopped: Vec<_> = history
            .into_iter()
            .filter(|record| persistence::terminal(&record["service"]))
            .take(256)
            .collect();
        let omitted = total.saturating_sub(active.len() as u64) > stopped.len() as u64;
        let mut records = active;
        records.extend(stopped);
        records.sort_by_key(|record| {
            std::cmp::Reverse(record["sequence"].as_u64().expect("validated record"))
        });
        Ok(
            json!({"services":records.into_iter().map(|record|record["service"].clone()).collect::<Vec<_>>(),"omittedHistory":omitted}),
        )
    }
    pub async fn input(
        self: &Arc<Self>,
        workspace: &str,
        id: &str,
        reader: &Value,
        options: &Value,
        mode: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        ensure!(
            self.schemas.valid("serviceInputOptions", options)?
                && self.schemas.valid("serviceReader", reader)?,
            "The service input request is invalid."
        );
        let chars = options["chars"].as_str().unwrap_or("");
        let wait = options["waitMs"].as_u64().expect("validated wait");
        let max = options["maxOutputBytes"]
            .as_u64()
            .expect("validated byte limit") as usize;
        ensure!(
            chars.len() <= 65536 && (chars.is_empty() || wait <= 30000),
            "Service input exceeds its byte or write-wait limit."
        );
        let start = tokio::time::Instant::now();
        let deadline = start + Duration::from_millis(wait);
        let mut current = self.snapshot(workspace, id).await?;
        if let Some((_, readers)) = self.output_view(id) {
            readers.reserve(reader)?;
        } else {
            ensure!(
                !persistence::terminal(&current),
                "This service's runtime output is no longer available."
            );
        }
        if !chars.is_empty() {
            ensure!(
                matches!(mode, "auto" | "full_access"),
                "Sending service input requires Auto or Full access and never widens its sandbox."
            );
            let execution = self.running(&current)?;
            ensure!(
                execution.write(chars, cancel).await?,
                "The service is no longer accepting input."
            );
        }
        loop {
            ensure!(
                !cancel.is_cancelled(),
                "The service input request was stopped."
            );
            let view = self.output_view(id);
            let (output, truncated) = if let Some((execution, readers)) = &view {
                readers.read(execution, reader, max)?
            } else {
                ensure!(
                    !persistence::terminal(&current),
                    "This service's runtime output is no longer available."
                );
                (String::new(), false)
            };
            if !output.is_empty()
                || truncated
                || persistence::terminal(&current)
                || view
                    .as_ref()
                    .is_some_and(|(execution, _)| execution.finished())
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(
                    json!({"service":self.snapshot(workspace,id).await?,"output":output,"truncated":truncated,"wallTimeSeconds":start.elapsed().as_secs_f64()}),
                );
            }
            tokio::select! {_=cancel.cancelled()=>bail!("The service input request was stopped."),_=tokio::time::sleep_until(deadline.min(tokio::time::Instant::now()+Duration::from_millis(50)))=>{}}
            current = self.snapshot(workspace, id).await?;
        }
    }
    pub fn access_token(
        &self,
        ctx: &Context<'_>,
        principal: &str,
        workspace: &str,
        id: &str,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let record = persistence::required(ctx, &self.schemas, workspace, id)?;
        self.running(&record["service"])?;
        self.tokens.issue(&self.schemas,&json!({"principalId":principal,"workspaceId":workspace,"serviceId":id,"executionId":record["execution"]["id"]}))
    }
    pub async fn connect(
        self: &Arc<Self>,
        principal: &str,
        workspace: &str,
        id: &str,
        token: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Connection> {
        let module = self.clone();
        let owned_workspace = workspace.to_owned();
        let owned_id = id.to_owned();
        let record = self
            .runtime
            .transact(move |ctx| {
                persistence::required(ctx, &module.schemas, &owned_workspace, &owned_id)
            })
            .await?;
        self.tokens.authorize(&self.schemas,&json!({"principalId":principal,"workspaceId":workspace,"serviceId":id,"executionId":record["execution"]["id"]}),token)?;
        self.running(&record["service"])?
            .connect(cancel)
            .await
            .context("The service endpoint is not accepting connections yet.")
    }
    async fn snapshot(self: &Arc<Self>, workspace: &str, id: &str) -> Result<Value> {
        let module = self.clone();
        let workspace = workspace.to_owned();
        let id = id.to_owned();
        self.runtime
            .transact(move |ctx| module.get(ctx, &workspace, &id))
            .await
    }
    fn running(&self, service: &Value) -> Result<Arc<execution::Execution>> {
        ensure!(
            !self.closed.load(Ordering::Acquire) && service["status"] == "running",
            "The service is not running."
        );
        let execution = self
            .execution(&id_for(service)?)
            .context("The service is not running.")?;
        ensure!(!execution.finished(), "The service is not running.");
        Ok(execution)
    }
    fn output_view(&self, id: &str) -> Option<(Arc<execution::Execution>, Arc<readers::Readers>)> {
        self.trim();
        self.live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .map(|live| (live.execution.clone(), live.readers.clone()))
    }
    pub fn stop(self: &Arc<Self>, ctx: &Context<'_>, workspace: &str, id: &str) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let before = self.get(ctx, workspace, id)?;
        let module = self.clone();
        let id = id.to_owned();
        ctx.after_commit(move || {
            if let Some(execution) = module.execution(&id) {
                execution.revoke();
            }
        })?;
        if persistence::terminal(&before) || before["status"] == "stopping" {
            return Ok(before);
        }
        self.change(ctx,workspace,&id_for(&before)?,json!({"status":"stopping","endpointStatus":"unavailable","updatedAt":now().max(before["updatedAt"].as_u64().unwrap_or(0))}),false)
    }
    pub fn stop_owner(self: &Arc<Self>, ctx: &Context<'_>, agent: &str) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        let Some(workspace) = persistence::owner_workspace(ctx, &self.schemas, agent)? else {
            return Ok(());
        };
        let (records, _) = persistence::page(ctx, &self.schemas, &workspace, false, 32, None)?;
        for record in records {
            if record["service"]["agentId"] == agent {
                self.stop(ctx, &workspace, &id_for(&record["service"])?)?;
            }
        }
        Ok(())
    }
    /// Archival waits for positive teardown of every execution owned by this
    /// exact agent. Persist stop intent before touching any controller.
    pub async fn stop_owner_and_wait(
        self: &Arc<Self>,
        agent: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let module = self.clone();
        let agent = agent.to_owned();
        let records = self
            .runtime
            .transact(move |ctx| {
                let Some(workspace) = persistence::owner_workspace(ctx, &module.schemas, &agent)?
                else {
                    return Ok(Vec::new());
                };
                let (records, next) =
                    persistence::page(ctx, &module.schemas, &workspace, false, 32, None)?;
                ensure!(
                    next.is_none(),
                    "The active service catalog exceeds its workspace bound."
                );
                let owned = records
                    .into_iter()
                    .filter(|record| record["service"]["agentId"] == agent)
                    .map(|record| Ok((workspace.clone(), id_for(&record["service"])?)))
                    .collect::<Result<Vec<_>>>()?;
                module.stop_owner(ctx, &agent)?;
                Ok(owned)
            })
            .await?;
        for (workspace, id) in records {
            self.stop_and_wait(&workspace, &id, cancel).await?;
        }
        Ok(())
    }
    pub async fn stop_and_wait(
        self: &Arc<Self>,
        workspace: &str,
        id: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let before = self.snapshot(workspace, id).await?;
        if persistence::terminal(&before) {
            return Ok(json!({"service":before,"stopped":false}));
        }
        let module = self.clone();
        let owned_workspace = workspace.to_owned();
        let owned_id = id.to_owned();
        let record = self
            .runtime
            .transact(move |ctx| {
                persistence::required(ctx, &module.schemas, &owned_workspace, &owned_id)
            })
            .await?;
        tokio::time::timeout(
            Duration::from_secs(12),
            self.confirm_record(
                record,
                cancel,
                "runtime_lost",
                "The service was interrupted and was not restarted.",
            ),
        )
        .await
        .context("Service teardown is not confirmed. Its workspace files must be retained.")??;
        Ok(json!({"service":self.snapshot(workspace,id).await?,"stopped":true}))
    }
    pub fn close_workspace_admission(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        workspace: &Value,
    ) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        let workspace = workspace["id"]
            .as_str()
            .or_else(|| workspace.as_str())
            .context("The workspace identity is missing.")?;
        let ids = persistence::close_admission(ctx, &self.schemas, workspace)?;
        for id in &ids {
            self.stop(ctx, workspace, id)?;
        }
        if ids.is_empty() {
            return Ok(None);
        }
        let cleanup = json!({"phase":"stopping_services","serviceIds":ids,"error":null});
        ensure!(
            self.schemas.valid("workspaceServiceCleanup", &cleanup)?,
            "The workspace service cleanup identities are invalid."
        );
        Ok(Some(cleanup))
    }
    pub fn close_project_admission(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        project: &Value,
    ) -> Result<()> {
        self.close_workspace_admission(ctx, project)?;
        Ok(())
    }
    pub fn reopen_admission(&self, ctx: &Context<'_>, workspace: &str) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        persistence::reopen_admission(ctx, &self.schemas, workspace)
    }
    pub async fn confirm_workspace_removal(
        self: &Arc<Self>,
        workspace: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let module = self.clone();
        let workspace = workspace.to_owned();
        let records = self
            .runtime
            .transact(move |ctx| {
                persistence::page(ctx, &module.schemas, &workspace, false, 32, None)
                    .map(|page| page.0)
            })
            .await?;
        // Attempt every cleanup, even if another execution's proof fails.
        let results = futures_util::future::join_all(records.into_iter().map(|record| {
            let module = self.clone();
            let cancel = cancel.clone();
            async move {
                module
                    .confirm_record(
                        record,
                        &cancel,
                        "runtime_lost",
                        "The service was interrupted and was not restarted.",
                    )
                    .await
            }
        }))
        .await;
        let failures: Vec<_> = results.into_iter().filter_map(Result::err).collect();
        ensure!(
            failures.is_empty(),
            "Workspace service teardown is not confirmed. Its workspace files must be retained. {}",
            failures
                .first()
                .map(|error| format!("{error:#}"))
                .unwrap_or_default()
        );
        Ok(())
    }
    pub async fn confirm_project_removal(
        self: &Arc<Self>,
        project: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.confirm_workspace_removal(project, cancel).await
    }
    async fn confirm_record(
        self: &Arc<Self>,
        record: Value,
        cancel: &CancellationToken,
        code: &str,
        message: &str,
    ) -> Result<()> {
        let workspace = record["service"]["workspaceId"]
            .as_str()
            .context("The service workspace is invalid.")?
            .to_owned();
        let id = id_for(&record["service"])?;
        let lease = self.teardown_lease(&id)?;
        let _guard = tokio::select! {guard=lease.lock()=>guard,_=cancel.cancelled()=>bail!("Service teardown was stopped. Its workspace files must be retained.")};
        let record = {
            let module = self.clone();
            let workspace = workspace.clone();
            let id = id.clone();
            self.runtime
                .transact(move |ctx| persistence::required(ctx, &module.schemas, &workspace, &id))
                .await?
        };
        if persistence::terminal(&record["service"]) {
            return Ok(());
        }
        let module = self.clone();
        let owned_workspace = workspace.clone();
        let owned_id = id.clone();
        self.runtime
            .transact(move |ctx| module.stop(ctx, &owned_workspace, &owned_id).map(|_| ()))
            .await?;
        let live = self.execution(&id);
        let proof = async {
            let exit = if let Some(execution) = &live {
                execution.revoke();
                Some(
                    tokio::time::timeout(Duration::from_secs(12), execution.wait(cancel))
                        .await
                        .context("Service shutdown teardown remains unconfirmed.")??,
                )
            } else {
                None
            };
            execution::reconcile(
                &record["execution"],
                &self.schemas,
                live.as_ref().is_some_and(|execution| execution.finished()),
                cancel,
            )
            .await?;
            Ok::<_, anyhow::Error>(exit)
        }
        .await;
        let exit = match proof {
            Err(error) => {
                let module = self.clone();
                self.runtime.transact(move|ctx|{let current=module.get(ctx,&workspace,&id)?;if !persistence::terminal(&current){module.change(ctx,&workspace,&id,json!({"status":"stopping","endpointStatus":"unavailable","error":{"code":"cleanup_unconfirmed","message":"The service sandbox cleanup is not confirmed. Its workspace files must be retained."},"updatedAt":now().max(current["updatedAt"].as_u64().unwrap_or(0))}),false)?;}Ok(())}).await?;
                return Err(error);
            }
            Ok(exit) => exit,
        };
        let module = self.clone();
        let code = code.to_owned();
        let message = message.to_owned();
        self.runtime.transact(move|ctx|{let current=module.get(ctx,&workspace,&id)?;if !persistence::terminal(&current){let mut changes=json!({"status":"failed","endpointStatus":"unavailable","error":{"code":code,"message":message},"endedAt":now().max(current["updatedAt"].as_u64().unwrap_or(0)),"updatedAt":now().max(current["updatedAt"].as_u64().unwrap_or(0))});if let Some(exit)=exit{changes["exitCode"]=json!(exit.code);if exit.admitted&&code=="runtime_lost"{changes["status"]=json!(if exit.killed||current["status"]=="stopping"{"killed"}else{"completed"});changes["error"]=Value::Null;}}module.change(ctx,&workspace,&id,changes,true)?;}Ok(())}).await
    }
    fn change(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        workspace: &str,
        id: &str,
        changes: Value,
        confirmed: bool,
    ) -> Result<Value> {
        let before = self.get(ctx, workspace, id)?;
        if persistence::terminal(&before) {
            return Ok(before);
        }
        let previous = before["version"]
            .as_str()
            .context("The service version is invalid.")?;
        let mut next = before.clone();
        for (key, value) in changes
            .as_object()
            .context("The service changes are invalid.")?
        {
            next[key] = value.clone();
        }
        next["version"] = json!(self.version(Some(previous))?);
        persistence::replace(ctx, &self.schemas, &next, previous, confirmed)?;
        self.publish(ctx,json!({"type":"service.updated","serviceId":id,"workspaceId":workspace,"previousVersion":previous,"version":next["version"],"changes":changes}))?;
        if confirmed {
            let module = self.clone();
            let id = id.to_owned();
            let ended = next["endedAt"].as_u64();
            ctx.after_commit(move || module.retire(&id, ended))?;
        }
        Ok(next)
    }
    fn publish(self: &Arc<Self>, ctx: &Context<'_>, event: Value) -> Result<()> {
        ensure!(
            self.schemas.valid("serviceEvent", &event)?,
            "The service lifecycle event is invalid."
        );
        let kind = event["type"]
            .as_str()
            .context("The service event type is missing.")?
            .to_owned();
        let mut payload = event.clone();
        payload
            .as_object_mut()
            .expect("validated event")
            .remove("type");
        // The Events owner publishes only after the same durable transaction commits.
        self.events.record(ctx, None, &kind, payload)?;
        Ok(())
    }
    fn version(&self, previous: Option<&str>) -> Result<String> {
        let mut versions = self
            .versions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(previous) = previous {
            versions.observe(uuid::Uuid::parse_str(previous)?);
        }
        Ok(versions.next())
    }
    fn execution(&self, id: &str) -> Option<Arc<execution::Execution>> {
        self.live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .map(|live| live.execution.clone())
    }
    fn teardown_lease(&self, id: &str) -> Result<Arc<tokio::sync::Mutex<()>>> {
        let mut leases = self
            .teardown
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        leases.retain(|_, lease| lease.strong_count() > 0);
        if let Some(lease) = leases.get(id).and_then(Weak::upgrade) {
            return Ok(lease);
        }
        ensure!(
            leases.len() < 10000,
            "The service teardown admission limit has been reached."
        );
        let lease = Arc::new(tokio::sync::Mutex::new(()));
        leases.insert(id.to_owned(), Arc::downgrade(&lease));
        Ok(lease)
    }
    fn retire(self: &Arc<Self>, id: &str, ended: Option<u64>) {
        if let Some(ended) = ended {
            let owner = Arc::downgrade(self);
            let id = id.to_owned();
            let lifetime = self.lifecycle.shutdown.clone();
            let mut live = self
                .live
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(value) = live.get_mut(&id) {
                value.ended_at = Some(ended);
                if value.retirement.is_none() {
                    value.retirement = Some(tokio::spawn(async move {
                        tokio::select! {_=lifetime.cancelled()=>{},_=tokio::time::sleep(Duration::from_millis(ended.saturating_add(3_600_000).saturating_sub(now())))=>{if let Some(owner)=owner.upgrade(){owner.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id);}}}
                    }));
                }
            }
        }
        self.trim();
    }
    fn trim(&self) {
        let mut live = self
            .live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut completed: Vec<_> = live
            .iter()
            .filter_map(|(id, value)| {
                value
                    .ended_at
                    .map(|ended| (id.clone(), value.workspace.clone(), ended))
            })
            .collect();
        completed.sort_by_key(|(_, _, ended)| *ended);
        let mut counts = BTreeMap::<String, usize>::new();
        for (_, workspace, _) in &completed {
            *counts.entry(workspace.clone()).or_default() += 1;
        }
        let mut total = completed.len();
        for (id, workspace, ended) in completed {
            if ended.saturating_add(3_600_000) <= now() || total > 4096 || counts[&workspace] > 256
            {
                live.remove(&id);
                total -= 1;
                *counts.get_mut(&workspace).expect("counted workspace") -= 1;
            }
        }
    }
    pub async fn close(self: &Arc<Self>) -> Result<()> {
        self.closed.store(true, Ordering::Release);
        let live: Vec<_> = self
            .live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|(_, live)| live.ended_at.is_none())
            .map(|(id, live)| (id.clone(), live.workspace.clone(), live.execution.clone()))
            .collect();
        for (_, _, execution) in &live {
            execution.revoke();
        }
        let cancel = CancellationToken::new();
        let mut errors = Vec::new();
        for (id, workspace, _) in live {
            let module = self.clone();
            match self
                .runtime
                .transact(move |ctx| persistence::required(ctx, &module.schemas, &workspace, &id))
                .await
            {
                Ok(record) => {
                    if let Err(error) = self
                        .confirm_record(
                            record,
                            &cancel,
                            "runtime_lost",
                            "The service was stopped when its daemon shut down.",
                        )
                        .await
                    {
                        errors.push(error);
                    }
                }
                Err(error) => errors.push(error),
            }
        }
        self.live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, live| live.ended_at.is_none());
        ensure!(
            errors.is_empty(),
            "Service shutdown teardown remains unconfirmed. {}",
            errors
                .first()
                .map(|error| format!("{error:#}"))
                .unwrap_or_default()
        );
        Ok(())
    }
    async fn execute(
        self: Arc<Self>,
        call: Value,
        kv: CallKv,
        cancel: CancellationToken,
        reported_error: &mut bool,
    ) -> Result<Value> {
        let arguments = &call["arguments"];
        let workspace = arguments["workspaceId"]
            .as_str()
            .context("The service workspace is missing.")?
            .to_owned();
        let id = arguments["serviceId"]
            .as_str()
            .context("The service identity is missing.")?
            .to_owned();
        loop {
            ensure!(!cancel.is_cancelled(), "Service execution was stopped.");
            // An absent control directory is proof only while no controller can
            // still create it. The same per-execution lease covers startup and
            // positive cleanup; weak entries retire when their owners finish.
            let lease = self.teardown_lease(&id)?;
            let startup = tokio::select! {guard=lease.lock()=>guard,_=cancel.cancelled()=>bail!("Service execution was stopped.")};
            let module = self.clone();
            let owned_workspace = workspace.clone();
            let owned_id = id.clone();
            let guard = kv.clone();
            let state = self
                .runtime
                .transact(move |ctx| {
                    Ok((
                        persistence::required(ctx, &module.schemas, &owned_workspace, &owned_id)?,
                        guard.read(ctx, "spawn-attempted!")?,
                    ))
                })
                .await?;
            let (record, attempted) = state;
            if persistence::terminal(&record["service"]) {
                return Ok(Value::Null);
            }
            ensure!(
                attempted.is_none() || attempted == Some(json!(true)),
                "The service spawn claim is invalid."
            );
            if attempted == Some(json!(true))
                || arguments["daemonId"] != self.lifecycle.daemon_id()
                || record["service"]["status"] != "starting"
                || self.closed.load(Ordering::Acquire)
            {
                drop(startup);
                match self
                    .confirm_record(
                        record,
                        &cancel,
                        "runtime_lost",
                        "The service was interrupted and was not restarted.",
                    )
                    .await
                {
                    Ok(()) => return Ok(Value::Null),
                    Err(error) => {
                        report_execution_error(reported_error, &error);
                        if cancel.is_cancelled() {
                            return Err(error);
                        }
                        tokio::select! {_=cancel.cancelled()=>bail!("Service cleanup was stopped."),_=tokio::time::sleep(Duration::from_millis(100))=>{}}
                        continue;
                    }
                }
            }
            // Preparation may fail; a claim is committed before any spawn attempt.
            self.config.prepare_service_controls()?;
            let module = self.clone();
            let owned_workspace = workspace.clone();
            let owned_id = id.clone();
            let configuration = kv
                .transact(move |ctx, kv| {
                    let current = module.get(ctx, &owned_workspace, &owned_id)?;
                    ensure!(
                        current["status"] == "starting" && !module.closed.load(Ordering::Acquire),
                        "The service was stopped before startup."
                    );
                    let config = module.available_owner(
                        ctx,
                        current["agentId"]
                            .as_str()
                            .context("The service owner is missing.")?,
                    )?;
                    kv.write(ctx, "spawn-attempted!", &json!(true))?;
                    Ok(config)
                })
                .await?;
            let options = &arguments["options"];
            ensure!(
                options["execution"] == record["execution"],
                "The service execution intent does not match its durable record."
            );
            for field in ["command", "cwd", "port", "tty", "sandbox"] {
                ensure!(
                    options[field] == record["service"][field],
                    "The service execution intent changed its recorded sandbox or command."
                );
            }
            let environment = self
                .config
                .execution_environment(&configuration, &json!({}))?;
            let started = execution::Execution::start(
                &environment.root,
                &self.config.paths.directory,
                &self.config.service_read_denials(),
                options,
                &self.schemas,
                cancel.child_token(),
            )
            .await;
            let execution = match started {
                Ok(execution) => execution,
                Err(error) => {
                    report_execution_error(reported_error, &error);
                    drop(startup);
                    self.confirm_record(
                        record,
                        &cancel,
                        "startup_failed",
                        "The service runtime could not be established or was lost.",
                    )
                    .await?;
                    return Ok(Value::Null);
                }
            };
            self.live
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(
                    id.clone(),
                    Live {
                        execution: execution.clone(),
                        workspace: workspace.clone(),
                        ended_at: None,
                        readers: Arc::new(readers::Readers::new()),
                        retirement: None,
                    },
                );
            let module = self.clone();
            let owned_workspace = workspace.clone();
            let owned_id = id.clone();
            let process_id = execution.process_id.clone();
            let revoke = execution.clone();
            self.runtime
                .transact(move |ctx| {
                    let current=module.get(ctx,&owned_workspace,&owned_id)?;
                    if current["status"]!="starting"||module.closed.load(Ordering::Acquire){ctx.after_commit(move||revoke.revoke())?;}
                    module
                        .change(
                            ctx,
                            &owned_workspace,
                            &owned_id,
                            json!({"processId":process_id,"updatedAt":now().max(current["updatedAt"].as_u64().unwrap_or(0))}),
                            false,
                        )
                        .map(|_| ())
                })
                .await?;
            drop(startup);
            loop {
                if execution.finished() {
                    break;
                }
                if execution.admitted()? {
                    let module = self.clone();
                    let owned_workspace = workspace.clone();
                    let owned_id = id.clone();
                    let started = execution.started_at;
                    self.runtime.transact(move|ctx|{let current=module.get(ctx,&owned_workspace,&owned_id)?;if current["status"]=="starting"{module.change(ctx,&owned_workspace,&owned_id,json!({"status":"running","startedAt":started,"updatedAt":now().max(current["updatedAt"].as_u64().unwrap_or(0))}),false)?;}Ok(())}).await?;
                    break;
                }
                tokio::select! {_=cancel.cancelled()=>{execution.revoke();bail!("Service execution was stopped.");},_=tokio::time::sleep(Duration::from_millis(25))=>{}}
            }
            let exit = loop {
                tokio::select! {
                    exit=execution.wait(&cancel)=>break exit?,
                    _=tokio::time::sleep(Duration::from_millis(500))=>{}
                }
                let endpoint = if execution.connect(&cancel).await.is_ok() {
                    "reachable"
                } else {
                    "waiting"
                };
                let module = self.clone();
                let owned_workspace = workspace.clone();
                let owned_id = id.clone();
                // Endpoint reachability is bounded enrichment. A transient
                // observation or metadata error must not kill a healthy service.
                let _=self.runtime.transact(move|ctx|{let current=module.get(ctx,&owned_workspace,&owned_id)?;if current["status"]=="running"&&current["endpointStatus"]!=endpoint{module.change(ctx,&owned_workspace,&owned_id,json!({"endpointStatus":endpoint,"updatedAt":now().max(current["updatedAt"].as_u64().unwrap_or(0))}),false)?;}Ok(())}).await;
            };
            let cleanup = tokio::select! {guard=lease.lock()=>guard,_=cancel.cancelled()=>bail!("Service teardown was stopped.")};
            if let Err(error) =
                execution::reconcile(&record["execution"], &self.schemas, true, &cancel).await
            {
                report_execution_error(reported_error, &error);
                drop(cleanup);
                self.confirm_record(
                    record,
                    &cancel,
                    "startup_failed",
                    "The service runtime could not be established or was lost.",
                )
                .await?;
                return Err(error);
            }
            let module = self.clone();
            let owned_workspace = workspace.clone();
            let owned_id = id.clone();
            self.runtime.transact(move|ctx|{let current=module.get(ctx,&owned_workspace,&owned_id)?;if !persistence::terminal(&current){module.change(ctx,&owned_workspace,&owned_id,json!({"status":if !exit.admitted{"failed"}else if exit.killed||current["status"]=="stopping"{"killed"}else{"completed"},"endpointStatus":"unavailable","exitCode":exit.code,"error":if !exit.admitted{json!({"code":"startup_failed","message":"The service sandbox or command could not be started."})}else{Value::Null},"endedAt":now().max(current["updatedAt"].as_u64().unwrap_or(0)),"updatedAt":now().max(current["updatedAt"].as_u64().unwrap_or(0))}),true)?;}Ok(())}).await?;
            return Ok(Value::Null);
        }
    }
}
fn id_for(service: &Value) -> Result<String> {
    service["id"]
        .as_str()
        .map(str::to_owned)
        .context("The service identity is invalid.")
}
fn report_execution_error(reported: &mut bool, error: &anyhow::Error) {
    if *reported {
        return;
    }
    let detail = format!("{error:#}")
        .chars()
        .take(1024)
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    eprintln!("Service execution remains pending after an error: {detail}");
    *reported = true;
}
impl DurableFunction for ServiceExecutor {
    fn execute(
        self: Arc<Self>,
        call: Value,
        kv: CallKv,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            let module = self
                .0
                .upgrade()
                .context("The services owner is no longer available.")?;
            let mut delay = 100;
            let mut reported_error = false;
            loop {
                match module
                    .clone()
                    .execute(
                        call.clone(),
                        kv.clone(),
                        cancel.clone(),
                        &mut reported_error,
                    )
                    .await
                {
                    Ok(result) => return Ok(result),
                    Err(error) if cancel.is_cancelled() => return Err(error),
                    Err(error) => {
                        report_execution_error(&mut reported_error, &error);
                        // DF deliberately never retries errors. This feature must retain its
                        // durable intent while cleanup remains unproven. The committed claim
                        // makes every resumed attempt reconciliation, never another spawn.
                        tokio::select! {_=cancel.cancelled()=>bail!("Service cleanup was stopped; its durable execution remains pending."),_=tokio::time::sleep(Duration::from_millis(delay))=>{}}
                        delay = (delay * 2).min(5000);
                    }
                }
            }
        })
    }
}
