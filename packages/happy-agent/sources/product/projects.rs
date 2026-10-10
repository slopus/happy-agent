use super::{
    config::ConfigModule,
    durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration},
    events::EventsModule,
    identity::{now, resource_version},
    owners::{AbortModule, GitModule, RunnersModule},
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
    services::ServicesModule,
    workspaces::WorkspacesModule,
};
use anyhow::{Context as _, Result};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[path = "owners/project_avatars.rs"]
mod avatars;
pub use avatars::AvatarAsset;
#[path = "owners/project_catalog.rs"]
mod catalog;
#[path = "owners/project_edits.rs"]
mod edits;
#[path = "owners/project_location.rs"]
mod location;
#[path = "owners/project_registration.rs"]
mod registration;
pub use registration::PreparedProjectRegistration;
#[path = "owners/project_remote.rs"]
mod remote;
pub use remote::PreparedRemoteProject;
#[path = "owners/project_names.rs"]
mod names;
#[path = "owners/projects_persistence.rs"]
mod persistence;
#[path = "owners/project_events.rs"]
mod project_events;
pub use edits::ProjectError;
pub use project_events::{ProjectSubscription, ProjectTransactionalListener};
#[cfg(test)]
#[path = "owners/project_catalog_tests.rs"]
mod catalog_tests;
#[cfg(test)]
#[path = "owners/project_edit_tests.rs"]
mod edit_tests;
#[cfg(test)]
#[path = "owners/project_location_tests.rs"]
mod location_tests;
#[cfg(test)]
#[path = "owners/project_registration_tests.rs"]
mod registration_tests;
#[cfg(test)]
#[path = "owners/project_remote_tests.rs"]
mod remote_tests;

pub struct ProjectsModule {
    runtime: Arc<RuntimeModule>,
    schemas: Schemas,
    owners: Option<Owners>,
    workspace_listeners: Mutex<Vec<Weak<WorkspacesModule>>>,
    event_listeners: Mutex<std::collections::BTreeMap<u64, ProjectTransactionalListener>>,
    next_event_listener: std::sync::atomic::AtomicU64,
}
struct Owners {
    config: Arc<ConfigModule>,
    git: Arc<GitModule>,
    abort: Arc<AbortModule>,
    durable: Arc<DurableFunctionsModule>,
    runners: Arc<RunnersModule>,
    services: Arc<ServicesModule>,
    events: Arc<EventsModule>,
}
#[derive(Clone, Copy)]
enum Kind {
    Provision,
    Archive,
    Cleanup,
}
struct Procedure {
    owner: Weak<ProjectsModule>,
    kind: Kind,
}
impl ProjectsModule {
    pub fn validate_name(&self, value: &str) -> Result<String> {
        names::name(value)
    }
    pub fn validate_base_ref(&self, value: Option<&str>) -> Result<Option<String>> {
        names::base_ref(value)
    }
    pub fn storage_key_for(&self, value: &str) -> String {
        names::storage_key(value)
    }
    pub fn read_settings(&self, ctx: &Context<'_>, id: &str) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(self.get(ctx, id)?.is_some(), "The project was not found.");
        persistence::settings(ctx, &self.schemas, id)
    }
    pub fn record_probe(&self, ctx: &Context<'_>, id: &str, probe: &Value) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("ownerGitProbe", probe)?,
            "The project probe is invalid."
        );
        let before = self.get(ctx, id)?.context("The project was not found.")?;
        let mut after = before.clone();
        after["presence"] = probe["presence"].clone();
        after["worktreeSupport"] = probe["worktreeSupport"].clone();
        if let Some(reason) = probe.get("worktreeSupportReason") {
            after["worktreeUnsupportedReason"] = reason.clone();
        } else {
            after
                .as_object_mut()
                .unwrap()
                .remove("worktreeUnsupportedReason");
        }
        if let Some(facts) = probe.get("facts") {
            for (source, target) in [
                ("ahead", "gitAhead"),
                ("behind", "gitBehind"),
                ("detached", "gitDetached"),
                ("branch", "gitBranch"),
                ("head", "gitHead"),
                ("upstream", "gitUpstream"),
            ] {
                if let Some(value) = facts.get(source) {
                    after[target] = value.clone();
                } else {
                    after.as_object_mut().unwrap().remove(target);
                }
            }
        }
        self.write_state(ctx, &before, &mut after, "probe")
    }
    pub fn new(runtime: Arc<RuntimeModule>) -> Result<Self> {
        Ok(Self {
            runtime,
            schemas: Schemas::new()?,
            owners: None,
            workspace_listeners: Mutex::new(Vec::new()),
            event_listeners: Mutex::new(std::collections::BTreeMap::new()),
            next_event_listener: std::sync::atomic::AtomicU64::new(1),
        })
    }
    #[expect(clippy::too_many_arguments)]
    pub fn install(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        git: Arc<GitModule>,
        abort: Arc<AbortModule>,
        durable: Arc<DurableFunctionsModule>,
        runners: Arc<RunnersModule>,
        services: Arc<ServicesModule>,
        events: Arc<EventsModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in [
            "ownerProject",
            "ownerProjectArgs",
            "ownerProjectProvision",
            "ownerNull",
            "ownerProjectAvatarAssetMetadata",
            "ownerProjectPageQuery",
            "ownerProjectPage",
            "ownerProjectAgentOrders",
            "ownerProjectId",
            "ownerProjectRepositoryRef",
            "ownerProjectRunnerId",
            "ownerCatalogCompute",
            "ownerProjectEvent",
            "ownerProjectRename",
            "ownerProjectReorder",
            "ownerProjectClearAvatar",
            "ownerProjectPreparedAvatar",
            "ownerProjectSettingsUpdate",
            "ownerProjectRegistration",
            "ownerProjectRemoteRequest",
            "ownerProjectManagedFolderName",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        let module = Arc::new(Self {
            runtime,
            schemas,
            owners: Some(Owners {
                config,
                git,
                abort,
                durable: durable.clone(),
                runners,
                services,
                events,
            }),
            workspace_listeners: Mutex::new(Vec::new()),
            event_listeners: Mutex::new(std::collections::BTreeMap::new()),
            next_event_listener: std::sync::atomic::AtomicU64::new(1),
        });
        for (name, kind, result) in [
            (
                "projects.provision",
                Kind::Provision,
                "ownerProjectProvision",
            ),
            ("projects.archive", Kind::Archive, "ownerNull"),
            ("projects.cleanup", Kind::Cleanup, "ownerNull"),
        ] {
            durable.register(Registration {
                name: name.to_owned(),
                arguments_schema: "ownerProjectArgs",
                result_schema: result,
                function: Arc::new(Procedure {
                    owner: Arc::downgrade(&module),
                    kind,
                }),
            })?;
        }
        Ok(module)
    }
    fn owners(&self) -> Result<&Owners> {
        self.owners
            .as_ref()
            .context("The project execution owner is not installed.")
    }
    pub async fn normalize_avatar(
        &self,
        bytes: Vec<u8>,
        content_type: Option<String>,
    ) -> Result<AvatarAsset> {
        avatars::normalize_declared(bytes, content_type).await
    }
    pub fn listen_archives(&self, workspaces: Weak<WorkspacesModule>) -> Result<()> {
        let mut listeners = self
            .workspace_listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        listeners.retain(|listener| listener.strong_count() > 0);
        anyhow::ensure!(
            listeners.len() < 32,
            "The project archive observer catalog exceeds its bound."
        );
        listeners.push(workspaces);
        Ok(())
    }
    pub fn root_workspace(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        if !persistence::available(ctx)? {
            return Ok(None);
        }
        let Some(project) = self.get(ctx, id)? else {
            return Ok(None);
        };
        let location = self.location(ctx, &project)?;
        let scope = json!({"id":project["id"],"root":location["path"],"status":project["status"],"runnerId":location["runnerId"].as_str().unwrap_or(""),"updatedAt":project["updatedAt"],"version":project["version"]});
        anyhow::ensure!(
            self.schemas.valid("projectScope", &scope)?,
            "The project workspace is invalid."
        );
        Ok(Some(scope))
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime
            .migrate("projects", persistence::MIGRATIONS)
            .await
    }
    pub fn get(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        if !persistence::available(ctx)? {
            return Ok(None);
        }
        persistence::read(ctx, &self.schemas, id)
    }
    pub fn has_active_project(&self, ctx: &Context<'_>) -> Result<bool> {
        self.runtime.assert_context(ctx)?;
        if !persistence::available(ctx)? {
            return Ok(false);
        }
        persistence::has_active_project(ctx)
    }
    pub fn attach_agent(&self, ctx: &Context<'_>, project: &str, agent: &str) -> Result<Value> {
        let before = self
            .root_workspace(ctx, project)?
            .ok_or_else(|| anyhow::anyhow!("The project workspace does not exist."))?;
        anyhow::ensure!(
            before["status"] == "active",
            "The project workspace is not active."
        );
        if let Some((owner, _)) = persistence::agent_association(ctx, agent)? {
            anyhow::ensure!(
                owner == project,
                "The agent already belongs to another project."
            );
            let ids = persistence::agent_ids(ctx, project)?;
            let version = resource_version(
                before["updatedAt"].as_u64().unwrap_or(0),
                before["version"].as_u64().unwrap_or(1),
                project,
            );
            return Ok(
                json!({"projectId":project,"agentIds":ids,"previousVersion":version,"version":version,"updatedAt":before["updatedAt"],"changed":false}),
            );
        }
        let last = persistence::last_agent_order(ctx, project)?;
        let mut prefix = String::new();
        let key = loop {
            let digit = last
                .as_deref()
                .unwrap_or("")
                .as_bytes()
                .get(prefix.len())
                .copied()
                .unwrap_or(b'0');
            if digit < b'9' {
                prefix.push(char::from(digit + (b'9' + 1 - digit) / 2));
                break prefix;
            }
            prefix.push('9');
            anyhow::ensure!(
                prefix.len() < 128,
                "Project agent order key space is exhausted."
            );
        };
        anyhow::ensure!(
            self.schemas.valid("projectOrderKey", &json!(key))?,
            "The agent order key is invalid."
        );
        let updated = i64::try_from(now())?;
        let stored = self
            .get(ctx, project)?
            .ok_or_else(|| anyhow::anyhow!("The project disappeared."))?;
        let mut after = stored.clone();
        after["updatedAt"] = json!(updated);
        after["version"] = json!(stored["version"].as_u64().unwrap_or_default() + 1);
        persistence::attach(ctx, project, agent, &key)?;
        let after = persistence::write(ctx, &self.schemas, &stored, &after)?;
        self.observe(ctx, json!({"type":"project_agent_attached","association":{"projectId":project,"agentId":agent,"orderKey":key},"project":after,"previousProject":stored}))?;
        let ids = persistence::agent_ids(ctx, project)?;
        Ok(
            json!({"projectId":project,"agentIds":ids,"previousVersion":resource_version(before["updatedAt"].as_u64().unwrap_or(0),before["version"].as_u64().unwrap_or(1),project),"version":resource_version(updated as u64,before["version"].as_u64().unwrap_or(1)+1,project),"updatedAt":updated}),
        )
    }
    pub fn agent_association(
        &self,
        ctx: &Context<'_>,
        agent: &str,
    ) -> Result<Option<(String, String)>> {
        self.runtime.assert_context(ctx)?;
        if !persistence::available(ctx)? {
            return Ok(None);
        }
        persistence::agent_association(ctx, agent)
    }
    pub fn register(self: &Arc<Self>, ctx: &Context<'_>, project: &Value) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let owners = self.owners()?;
        persistence::validate(&self.schemas, project)?;
        persistence::insert(ctx, &self.schemas, project)?;
        if project["kind"] != "home"
            && project["status"] == "active"
            && project["initializationStatus"] == "initializing"
        {
            self.schedule_provision(ctx, project)?;
        }
        self.observe(ctx, json!({"type":"project_created","project":project}))?;
        let _ = owners;
        Ok(project.clone())
    }
    fn schedule_provision(&self, ctx: &Context<'_>, project: &Value) -> Result<()> {
        let id = project["id"].as_str().unwrap_or_default();
        let mut locks = vec![json!(format!("project.{id}"))];
        if project.get("remoteSource").is_some() {
            locks.push(json!("projects.clone"));
        }
        self.owners()?.durable.invoke(ctx,&json!({"function":"projects.provision","arguments":{"id":id},"operationId":format!("project-create.{id}"),"lockKeys":locks}))?;
        Ok(())
    }
    pub fn archive(self: &Arc<Self>, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        let owners = self.owners()?;
        let Some(before) = self.get(ctx, id)? else {
            return Ok(None);
        };
        if before["status"] == "archived" {
            return Ok(Some(before));
        }
        let mut after = before.clone();
        after["status"] = json!("archived");
        after["archivedAt"] = json!(now());
        owners.services.close_project_admission(ctx, &before)?;
        self.write_event(ctx, &before, &mut after, json!({"type":"project_archived"}))?;
        owners
            .durable
            .cancel(ctx, &format!("project-create.{id}"))?;
        owners.durable.invoke(ctx,&json!({"function":"projects.archive","arguments":{"id":id},"operationId":format!("project-archive.{id}"),"lockKeys":[format!("project.{id}")]}))?;
        let listeners = self
            .workspace_listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        if listeners.is_empty() {
            self.schedule_archived_cleanup(ctx, id)?;
        } else {
            for listener in listeners {
                listener.archive_project(ctx, id)?;
            }
        }
        Ok(Some(after))
    }
    pub fn schedule_archived_cleanup(&self, ctx: &Context<'_>, id: &str) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        if self
            .get(ctx, id)?
            .is_none_or(|project| project["status"] != "archived")
        {
            return Ok(());
        }
        self.owners()?.durable.invoke(ctx,&json!({"function":"projects.cleanup","arguments":{"id":id},"operationId":format!("project-cleanup.{id}"),"lockKeys":[format!("project.{id}")]}))?;
        Ok(())
    }
    pub fn record_workspace_setup_commands(
        &self,
        ctx: &Context<'_>,
        id: &str,
        commands: Value,
    ) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        let Some(before) = self.get(ctx, id)? else {
            return Ok(());
        };
        let mut after = before.clone();
        after["workspaceSetupCommands"] = commands;
        self.write_state(ctx, &before, &mut after, "workspace_setup_commands")
    }
    fn write_state(
        &self,
        ctx: &Context<'_>,
        before: &Value,
        after: &mut Value,
        reason: &str,
    ) -> Result<()> {
        self.write_event(
            ctx,
            before,
            after,
            json!({"type":"project_state_changed","reason":reason}),
        )
    }
    async fn current(self: &Arc<Self>, id: &str) -> Result<Option<Value>> {
        let module = self.clone();
        let id = id.to_owned();
        self.runtime.transact(move |ctx| module.get(ctx, &id)).await
    }
    async fn state(self: &Arc<Self>, id: &str, changes: Value, reason: &'static str) -> Result<()> {
        let module = self.clone();
        let id = id.to_owned();
        self.runtime
            .transact(move |ctx| {
                let Some(before) = module.get(ctx, &id)? else {
                    return Ok(());
                };
                if before["status"] != "active" || before["initializationStatus"] != "initializing"
                {
                    return Ok(());
                }
                let mut after = before.clone();
                for (field, value) in changes
                    .as_object()
                    .context("The project state report is invalid.")?
                {
                    if value.is_null() {
                        after.as_object_mut().unwrap().remove(field);
                    } else {
                        after[field] = value.clone();
                    }
                }
                module.write_state(ctx, &before, &mut after, reason)
            })
            .await
    }
    async fn provision(
        self: &Arc<Self>,
        id: &str,
        kv: &CallKv,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let owners = self.owners()?;
        let _lock = owners.git.project_lock(id, cancel).await?;
        let work=async {
            let Some(project)=self.current(id).await? else {
                return Ok(json!({"outcome":"superseded"}));
            };
            if project["initializationStatus"]=="ready" {
                return Ok(json!({"outcome":"ready"}));
            }
            if project["kind"]=="home" || project["status"]!="active" || project["initializationStatus"]!="initializing" {
                return Ok(json!({"outcome":"superseded"}));
            }
            let runner=project["runnerId"].as_str();let path=Path::new(project["repositoryRef"].as_str().unwrap_or_default());
            if let Some(source)=project.get("remoteSource") {if !checkpoint(kv,"clone").await? {
                if owners.runners.exists(runner,path,cancel).await? {anyhow::ensure!(owners.git.top_level(runner,path,cancel).await?==path,"The managed project folder is not the expected repository root.");let origin=owners.git.run(runner,path,&["remote","get-url","origin"],cancel).await?;anyhow::ensure!(owners.git.source_matches(&origin,source)?,"The managed project folder has a different origin repository.");}
                else {let runtime=self.runtime.clone();let creator=self.runtime.transact(move|ctx|Ok(json!({"instanceId":runtime.installation_epoch(ctx)?,"profileId":"local"}))).await?;owners.git.clone_project(id,&creator,runner,path,source,project["requiredSecretKind"].as_str(),cancel).await?;}
                self.state(id,json!({"presence":"present"}),"clone_ready").await?;complete(kv,"clone").await?;
            }}else {anyhow::ensure!(owners.runners.exists(runner,path,cancel).await?,"The project folder is not available.");}
            if !checkpoint(kv,"probe").await? {let probe=owners.git.probe(runner,path,false,cancel).await?;let mut changes=json!({"presence":probe["presence"],"worktreeSupport":probe["worktreeSupport"],"worktreeUnsupportedReason":probe.get("worktreeSupportReason").cloned().unwrap_or(Value::Null)});if let Some(facts)=probe.get("facts") {for(source,target)in [("ahead","gitAhead"),("behind","gitBehind"),("detached","gitDetached"),("branch","gitBranch"),("head","gitHead"),("upstream","gitUpstream")] {changes[target]=facts.get(source).cloned().unwrap_or(Value::Null);}}self.state(id,changes,"probe").await?;complete(kv,"probe").await?;}
            let root=owners.git.top_level(runner,path,cancel).await.ok().is_some_and(|root|root==path);anyhow::ensure!(!cancel.is_cancelled(),"Project setup was cancelled.");let remote=if root {owners.git.remote_url(runner,path,cancel).await?}else{None};
            if root && !checkpoint(kv,"default-branch").await? {if self.current(id).await?.is_some_and(|project|project.get("defaultBranch").is_none()) && let Some(branch)=owners.git.default_branch(runner,path,cancel).await? {self.state(id,json!({"defaultBranch":branch}),"default_branch").await?;}complete(kv,"default-branch").await?;}
            if let Some(remote)=&remote && let Some(name)=owners.git.remote_name(remote) && self.current(id).await?.is_some_and(|project|project["nameSource"]=="folder") && !checkpoint(kv,"remote-name").await? {self.state(id,json!({"name":name,"nameSource":"remote"}),"remote_name").await?;complete(kv,"remote-name").await?;}
            if self.current(id).await?.is_some_and(|project|project.get("avatar").is_none()) && !checkpoint(kv,"avatar").await? {
                let repository=if root {avatars::discover_repository(owners.runners.clone(),runner,path,cancel).await?}else{None};let candidate=if repository.is_some(){repository}else if let Some(remote)=&remote {avatars::discover_hosting(remote,cancel).await?}else{None};
                if let Some(asset)=candidate {let module=self.clone();let id=id.to_owned();self.runtime.transact(move|ctx|{let Some(before)=module.get(ctx,&id)? else{return Ok(());};if before.get("avatar").is_some() || before["status"]!="active" {return Ok(());}anyhow::ensure!(module.schemas.valid("ownerProjectAvatarAssetMetadata",&asset.metadata)?,"The normalized project avatar metadata is invalid.");persistence::save_avatar(ctx,&id,&asset.bytes,&asset.metadata)?;let mut after=before.clone();after["avatar"]=json!({"kind":"image","source":"generated","thumbhash":asset.metadata["thumbhash"]});module.write_event(ctx,&before,&mut after,json!({"type":"project_avatar_updated"}))}).await?;}complete(kv,"avatar").await?;
            }
            Ok(json!({"outcome":"ready"}))
        }.await;
        anyhow::ensure!(!cancel.is_cancelled(), "Project setup was cancelled.");
        match work {
            Ok(value) => Ok(value),
            Err(error) if error.downcast_ref::<rusqlite::Error>().is_some() => Err(error),
            Err(error) => Ok(json!({"outcome":"failed","error":bounded_error(&error.to_string())})),
        }
    }
    async fn stop_agents(
        self: &Arc<Self>,
        id: &str,
        kv: &CallKv,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let module = self.clone();
        let id_owned = id.to_owned();
        let agents = self
            .runtime
            .transact(move |ctx| {
                module.runtime.assert_context(ctx)?;
                persistence::agent_ids(ctx, &id_owned)
            })
            .await?;
        for agent in agents {
            let key = format!("agent-{agent}");
            if checkpoint(kv, &key).await? {
                continue;
            }
            let mut delay = Duration::from_millis(100);
            loop {
                match self.owners()?.abort.abort_current(agent.clone()).await {
                    Ok(()) => break,
                    Err(error) => {
                        anyhow::ensure!(!cancel.is_cancelled(), "Project archival was cancelled.");
                        if error.downcast_ref::<rusqlite::Error>().is_some() {
                            return Err(error);
                        }
                        eprintln!("Work in project {id} could not be stopped yet: {error:#}");
                        backoff_wait(cancel, delay).await?;
                        delay = (delay * 2).min(Duration::from_secs(60));
                    }
                }
            }
            complete(kv, &key).await?;
        }
        Ok(())
    }
    async fn cleanup(
        self: &Arc<Self>,
        id: &str,
        kv: &CallKv,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if self
            .current(id)
            .await?
            .is_none_or(|project| project["status"] != "archived")
        {
            return Ok(());
        }
        self.stop_agents(id, kv, cancel).await?;
        let owners = self.owners()?;
        let mut delay = Duration::from_millis(100);
        loop {
            let work = async {
                owners.services.confirm_project_removal(id, cancel).await?;
                let _lock = owners.git.project_lock(id, cancel).await?;
                let Some(project) = self.current(id).await? else {
                    return Ok(());
                };
                if project["status"] != "archived" {
                    return Ok(());
                }
                anyhow::ensure!(!cancel.is_cancelled(), "Project cleanup was cancelled.");
                if project.get("remoteSource").is_none() {
                    return Ok(());
                }
                let runner = project["runnerId"].as_str();
                if runner.is_none() && owners.runners.enabled() {
                    return Ok(());
                }
                let expected = owners
                    .runners
                    .projects_home(runner, cancel)
                    .await?
                    .join(project["storageKey"].as_str().unwrap_or_default());
                let path = Path::new(project["repositoryRef"].as_str().unwrap_or_default());
                if expected != path {
                    return Ok(());
                }
                if owners.runners.exists(runner, path, cancel).await? {
                    owners.git.real_directory(runner, path, cancel).await?;
                    owners.runners.remove(runner, path, cancel).await?;
                }
                Ok(())
            }
            .await;
            match work {
                Ok(()) => break,
                Err(error) => {
                    anyhow::ensure!(!cancel.is_cancelled(), "Project cleanup was cancelled.");
                    if error.downcast_ref::<rusqlite::Error>().is_some() {
                        return Err(error);
                    }
                    eprintln!("Project {id} managed folder cleanup remains owed: {error:#}");
                    backoff_wait(cancel, delay).await?;
                    delay = (delay * 2).min(Duration::from_secs(60));
                }
            }
        }
        owners.git.revoke_credentials(id).await;
        Ok(())
    }
}

impl DurableFunction for Procedure {
    fn execute(
        self: Arc<Self>,
        call: Value,
        kv: CallKv,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            let module = self
                .owner
                .upgrade()
                .context("The project owner has closed.")?;
            let id = call["arguments"]["id"]
                .as_str()
                .context("The project ID is missing.")?;
            match self.kind {
                Kind::Provision => module.provision(id, &kv, &cancel).await,
                Kind::Archive => {
                    module.stop_agents(id, &kv, &cancel).await?;
                    module.owners()?.git.revoke_credentials(id).await;
                    Ok(Value::Null)
                }
                Kind::Cleanup => {
                    module.cleanup(id, &kv, &cancel).await?;
                    Ok(Value::Null)
                }
            }
        })
    }
    fn success(&self, ctx: &Context<'_>, call: &Value, result: &Value) -> Result<()> {
        if !matches!(self.kind, Kind::Provision) || result["outcome"] == "superseded" {
            return Ok(());
        }
        let module = self
            .owner
            .upgrade()
            .context("The project owner has closed.")?;
        let id = call["arguments"]["id"].as_str().unwrap_or_default();
        let Some(before) = module.get(ctx, id)? else {
            return Ok(());
        };
        if before["initializationStatus"] != "initializing" {
            return Ok(());
        }
        let mut after = before.clone();
        after["initializationAttempt"] = json!(
            before["initializationAttempt"]
                .as_u64()
                .unwrap_or_default()
                .saturating_add(1)
                .min(1000000)
        );
        if result["outcome"] == "ready" {
            after["initializationStatus"] = json!("ready");
            after.as_object_mut().unwrap().remove("initializationError");
        } else {
            after["initializationStatus"] = json!("failed");
            after["initializationError"] = result["error"].clone();
        }
        module.write_state(
            ctx,
            &before,
            &mut after,
            if result["outcome"] == "ready" {
                "initialization_ready"
            } else {
                "initialization_failed"
            },
        )
    }
}
async fn checkpoint(kv: &CallKv, key: &str) -> Result<bool> {
    let key = key.to_owned();
    kv.transact(move |ctx, kv| Ok(kv.read(ctx, &key)? == Some(json!(true))))
        .await
}
async fn complete(kv: &CallKv, key: &str) -> Result<()> {
    let key = key.to_owned();
    kv.transact(move |ctx, kv| kv.write(ctx, &key, &json!(true)))
        .await
}
fn bounded_error(text: &str) -> String {
    let mut length = 0;
    let text = text
        .chars()
        .filter(|character| !character.is_control() || ['\n', '\r', '\t'].contains(character))
        .take_while(|character| {
            length += character.len_utf16();
            length <= 500
        })
        .collect::<String>();
    if text.trim().is_empty() {
        "Project setup failed.".to_owned()
    } else {
        text
    }
}
async fn backoff_wait(cancel: &CancellationToken, delay: Duration) -> Result<()> {
    tokio::select! {_=cancel.cancelled()=>anyhow::bail!("Project archival was cancelled."),_=tokio::time::sleep(delay)=>Ok(())}
}

#[cfg(test)]
pub(in crate::product) mod tests {
    use super::*;
    use crate::product::{
        agent_runtime::AgentRuntimeModule, auto::AutoModule, history::HistoryModule,
        owners::Fixture, permissions::PermissionsModule, secrets::SecretsModule,
        tools::ToolsModule, usage::UsageModule,
    };
    pub(in crate::product) struct Graph {
        pub(in crate::product) fixture: Fixture,
        pub(in crate::product) agents: Arc<AgentRuntimeModule>,
        abort: Arc<AbortModule>,
        runners: Arc<RunnersModule>,
        git: Arc<GitModule>,
        services: Arc<ServicesModule>,
        pub(in crate::product) projects: Arc<ProjectsModule>,
        pub(in crate::product) workspaces: Arc<WorkspacesModule>,
    }
    impl Graph {
        pub(in crate::product) async fn new() -> Self {
            Self::install(Fixture::new().await).await
        }
        pub(in crate::product) async fn install(fixture: Fixture) -> Self {
            let usage = Arc::new(
                UsageModule::new(
                    fixture.runtime.clone(),
                    fixture.events.clone(),
                    fixture.config.clone(),
                )
                .unwrap(),
            );
            usage.load().await.unwrap();
            let history = Arc::new(
                HistoryModule::new(
                    fixture.config.clone(),
                    fixture.runtime.clone(),
                    fixture.events.clone(),
                    usage.clone(),
                )
                .unwrap(),
            );
            history.load().await.unwrap();
            let secrets = SecretsModule::new(
                fixture.config.clone(),
                fixture.runtime.clone(),
                fixture.durable.clone(),
                fixture.events.clone(),
            )
            .unwrap();
            secrets.load().await.unwrap();
            let services = ServicesModule::new(
                fixture.config.clone(),
                fixture.runtime.clone(),
                fixture.durable.clone(),
                fixture.lifecycle.clone(),
                fixture.events.clone(),
            )
            .unwrap();
            services.load().await.unwrap();
            let runners = RunnersModule::new(
                fixture.config.clone(),
                fixture.runtime.clone(),
                fixture.lifecycle.clone(),
            )
            .unwrap();
            runners.load().await.unwrap();
            let tools = Arc::new(
                ToolsModule::new(
                    fixture.config.clone(),
                    history.clone(),
                    fixture.lifecycle.clone(),
                    fixture.runtime.clone(),
                    secrets,
                    services.clone(),
                    fixture.events.clone(),
                    runners.clone(),
                    crate::product::docker::DockerModule::new(
                        fixture.config.clone(),
                        fixture.runtime.clone(),
                        fixture.durable.clone(),
                        fixture.lifecycle.clone(),
                        runners.clone(),
                    )
                    .unwrap(),
                )
                .unwrap(),
            );
            let system_prompt = crate::product::system_prompt::SystemPromptModule::new(
                fixture.config.clone(),
                tools.clone(),
                fixture.runtime.clone(),
                fixture.durable.clone(),
            )
            .unwrap();
            let auto = AutoModule::new(
                fixture.config.clone(),
                fixture.runtime.clone(),
                fixture.durable.clone(),
                tools.clone(),
                fixture.lifecycle.clone(),
                system_prompt.clone(),
            )
            .unwrap();
            auto.load().await.unwrap();
            let permissions = Arc::new(
                PermissionsModule::new(auto.clone(), fixture.runtime.clone(), history.clone())
                    .unwrap(),
            );
            let agents = Arc::new(AgentRuntimeModule::new(
                fixture.config.clone(),
                fixture.runtime.clone(),
                history,
                tools.clone(),
                usage,
                fixture.lifecycle.clone(),
                auto,
                permissions,
                fixture.events.clone(),
                system_prompt,
            ));
            agents.prepare().unwrap();
            agents.load().await.unwrap();
            let git = GitModule::new(fixture.config.clone(), runners.clone()).unwrap();
            let abort = AbortModule::new(
                fixture.runtime.clone(),
                agents.clone(),
                tools,
                services.clone(),
            );
            let projects = ProjectsModule::install(
                fixture.config.clone(),
                fixture.runtime.clone(),
                git.clone(),
                abort.clone(),
                fixture.durable.clone(),
                runners.clone(),
                services.clone(),
                fixture.events.clone(),
            )
            .unwrap();
            projects.load().await.unwrap();
            let workspaces = WorkspacesModule::install(
                fixture.config.clone(),
                fixture.runtime.clone(),
                projects.clone(),
                git.clone(),
                abort.clone(),
                fixture.durable.clone(),
                runners.clone(),
                services.clone(),
                fixture.events.clone(),
            )
            .unwrap();
            workspaces.load().await.unwrap();
            Self {
                fixture,
                agents,
                abort,
                runners,
                git,
                services,
                projects,
                workspaces,
            }
        }
        pub(in crate::product) async fn close(&self) {
            self.fixture.lifecycle.begin_shutdown();
            self.fixture.durable.stop().await;
            self.agents.close().await;
            self.runners.close().await;
            self.git.close().await;
            self.services.close().await.unwrap();
            self.fixture.close().await;
        }
        pub(in crate::product) async fn restart(self) -> Self {
            self.close().await;
            let mut fixture = self.fixture;
            fixture.restart().await;
            Self::install(fixture).await
        }
        fn project(&self, ready: bool) -> Value {
            let id = cuid2::create_id();
            json!({"id":id,"repositoryRef":self.fixture.directory.path().join("original-folder"),"kind":"regular","storageKey":"original-project","name":"Original project","nameSource":"folder","status":"active","presence":"present","initializationStatus":if ready{"ready"}else{"initializing"},"initializationAttempt":0,"worktreeSupport":"unknown","gitAhead":0,"gitBehind":0,"gitDetached":false,"orderKey":"500","version":1,"createdAt":100,"updatedAt":100})
        }
        fn workspace(&self, project: &Value, name: &str) -> Value {
            let id = cuid2::create_id();
            json!({"id":id,"projectRef":project["id"],"parentId":project["id"],"name":name,"nameConfigured":true,"branch":format!("worktree/{name}"),"storageKey":name,"kind":"directory","path":self.fixture.config.workspaces_home().join(project["storageKey"].as_str().unwrap()).join(name),"presence":"missing","status":"initializing","orderKey":"500","version":1,"gitAhead":0,"gitBehind":0,"gitDetached":false,"initializationAttempt":0,"createdAt":100,"updatedAt":100})
        }
        async fn wait_workspace(&self, id: &str, status: &str) -> Value {
            tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    let module = self.workspaces.clone();
                    let id = id.to_owned();
                    let record = self
                        .fixture
                        .runtime
                        .transact(move |ctx| module.get(ctx, &id))
                        .await
                        .unwrap()
                        .unwrap();
                    if record["status"] == status {
                        return record;
                    }
                    if record["status"] == "failed" {
                        panic!("Workspace setup failed: {record}");
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap()
        }
    }
    #[tokio::test]
    async fn project_reservation_and_archive_intents_roll_back_with_the_catalog() {
        let graph = Graph::new().await;
        let project = graph.project(false);
        let id = project["id"].as_str().unwrap().to_owned();
        let before = graph.fixture.pending().await.unwrap();
        let cursor = graph.fixture.events.cursor();
        let projects = graph.projects.clone();
        let proposed = project.clone();
        let result: Result<()> = graph
            .fixture
            .runtime
            .transact(move |ctx| {
                projects.register(ctx, &proposed)?;
                anyhow::bail!("Deliberate reservation rollback.");
            })
            .await;
        assert!(result.is_err());
        let projects = graph.projects.clone();
        let identity = id.clone();
        assert!(
            graph
                .fixture
                .runtime
                .transact(move |ctx| projects.get(ctx, &identity))
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(graph.fixture.pending().await.unwrap(), before);
        assert_eq!(graph.fixture.events.cursor(), cursor);
        let projects = graph.projects.clone();
        graph
            .fixture
            .runtime
            .transact(move |ctx| projects.register(ctx, &project))
            .await
            .unwrap();
        let calls = graph.fixture.pending().await.unwrap();
        let provision = calls
            .iter()
            .find(|call| call["function"] == "projects.provision")
            .unwrap();
        assert_eq!(provision["operationId"], format!("project-create.{id}"));
        assert_eq!(provision["lockKeys"], json!([format!("project.{id}")]));
        let projects = graph.projects.clone();
        let identity = id.clone();
        let result: Result<()> = graph
            .fixture
            .runtime
            .transact(move |ctx| {
                projects.archive(ctx, &identity)?;
                anyhow::bail!("Deliberate archive rollback.");
            })
            .await;
        assert!(result.is_err());
        assert_eq!(graph.fixture.pending().await.unwrap(), calls);
        let projects = graph.projects.clone();
        assert_eq!(
            graph
                .fixture
                .runtime
                .transact(move |ctx| projects.get(ctx, &id))
                .await
                .unwrap()
                .unwrap()["status"],
            "active"
        );
        graph.close().await;
    }
    #[tokio::test]
    #[cfg(unix)]
    async fn native_directory_provision_runs_setup_once_and_archive_retains_copies() {
        let graph = Graph::new().await;
        let project = graph.project(true);
        let path = Path::new(project["repositoryRef"].as_str().unwrap());
        tokio::fs::create_dir_all(path.join("node_modules"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(path.join(".git")).await.unwrap();
        tokio::fs::write(path.join("original.txt"), "source\n")
            .await
            .unwrap();
        tokio::fs::write(path.join("node_modules/excluded"), "dependency")
            .await
            .unwrap();
        tokio::fs::write(
            path.join("happy.toml"),
            "[workspace]\nsetup_commands = [\"printf 'ran\\n' >> setup-count\", \"exit 7\"]\n",
        )
        .await
        .unwrap();
        let projects = graph.projects.clone();
        let inserted = project.clone();
        graph
            .fixture
            .runtime
            .transact(move |ctx| projects.register(ctx, &inserted))
            .await
            .unwrap();
        let workspace = graph.workspace(&project, "native-copy");
        let id = workspace["id"].as_str().unwrap().to_owned();
        let workspace_path = Path::new(workspace["path"].as_str().unwrap()).to_owned();
        let workspaces = graph.workspaces.clone();
        graph
            .fixture
            .runtime
            .transact(move |ctx| workspaces.reserve(ctx, &workspace))
            .await
            .unwrap();
        graph.fixture.durable.start().await.unwrap();
        let ready = graph.wait_workspace(&id, "ready").await;
        assert_eq!(ready["presence"], "present");
        assert_eq!(
            tokio::fs::read_to_string(workspace_path.join("original.txt"))
                .await
                .unwrap(),
            "source\n"
        );
        assert_eq!(
            tokio::fs::read_to_string(workspace_path.join("setup-count"))
                .await
                .unwrap(),
            "ran\n"
        );
        assert!(!workspace_path.join(".git").exists());
        assert!(!workspace_path.join("node_modules").exists());
        let projects = graph.projects.clone();
        let project_id = project["id"].as_str().unwrap().to_owned();
        graph
            .fixture
            .runtime
            .transact(move |ctx| projects.archive(ctx, &project_id))
            .await
            .unwrap();
        let archived = graph.wait_workspace(&id, "archived").await;
        assert_eq!(archived["serviceCleanup"], Value::Null);
        assert!(workspace_path.join("original.txt").exists());
        assert!(path.join("original.txt").exists());
        graph.close().await;
    }
    #[tokio::test]
    #[cfg(unix)]
    async fn original_workspace_checkpoints_survive_restart_without_replaying_setup() {
        let graph = Graph::new().await;
        let project = graph.project(true);
        let root = Path::new(project["repositoryRef"].as_str().unwrap()).to_owned();
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(root.join("source.txt"), "new source contents")
            .await
            .unwrap();
        let projects = graph.projects.clone();
        let original = project.clone();
        graph
            .fixture
            .runtime
            .transact(move |ctx| projects.register(ctx, &original))
            .await
            .unwrap();
        let workspace = graph.workspace(&project, "restored-copy");
        let id = workspace["id"].as_str().unwrap().to_owned();
        let path = Path::new(workspace["path"].as_str().unwrap()).to_owned();
        tokio::fs::create_dir_all(&path).await.unwrap();
        tokio::fs::write(path.join("source.txt"), "original copied contents")
            .await
            .unwrap();
        tokio::fs::write(path.join("setup-count"), "ran\n")
            .await
            .unwrap();
        let command = "printf 'ran\\n' >> setup-count";
        tokio::fs::write(
            path.join("happy.toml"),
            format!(
                "[workspace]\nsetup_commands = [{}]\n",
                serde_json::to_string(command).unwrap()
            ),
        )
        .await
        .unwrap();
        let workspaces = graph.workspaces.clone();
        graph
            .fixture
            .runtime
            .transact(move |ctx| workspaces.reserve(ctx, &workspace))
            .await
            .unwrap();
        let calls = graph.fixture.pending().await.unwrap();
        let call = calls
            .iter()
            .find(|call| call["function"] == "workspaces.provision")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let durable = graph.fixture.durable.clone();
        graph
            .fixture
            .runtime
            .transact(move |ctx| {
                for (key, value) in [
                    ("contents", json!(true)),
                    ("initial-sync", json!(true)),
                    ("setup-0", json!(command)),
                ] {
                    durable.write_test_checkpoint(ctx, &call, key, &value)?;
                }
                Ok(())
            })
            .await
            .unwrap();
        let graph = graph.restart().await;
        graph.fixture.durable.start().await.unwrap();
        graph.wait_workspace(&id, "ready").await;
        assert_eq!(
            tokio::fs::read_to_string(path.join("source.txt"))
                .await
                .unwrap(),
            "original copied contents"
        );
        assert_eq!(
            tokio::fs::read_to_string(path.join("setup-count"))
                .await
                .unwrap(),
            "ran\n"
        );
        graph.close().await;
    }
    #[tokio::test]
    async fn subtree_abort_deduplicates_only_within_the_current_transaction() {
        let graph = Graph::new().await;
        let root = cuid2::create_id();
        let child = cuid2::create_id();
        let leaf = cuid2::create_id();
        let configuration = graph
            .fixture
            .config
            .agent_configuration(
                graph.fixture.directory.path().to_str().unwrap(),
                &cuid2::create_id(),
                &cuid2::create_id(),
                None,
            )
            .unwrap();
        let agents = graph.agents.clone();
        let identities = [root.clone(), child.clone(), leaf.clone()];
        graph
            .fixture
            .runtime
            .transact(move |ctx| {
                for id in &identities {
                    agents.create(ctx, id, &configuration)?;
                }
                agents.set_parent(ctx, &identities[1], &identities[0])?;
                agents.set_parent(ctx, &identities[2], &identities[1])
            })
            .await
            .unwrap();
        let abort = graph.abort.clone();
        let identities = [root.clone(), child.clone(), leaf.clone()];
        let result: Result<()> = graph
            .fixture
            .runtime
            .transact(move |ctx| {
                abort.abort(ctx, &identities[0])?;
                abort.abort(ctx, &identities[1])?;
                for id in &identities {
                    assert!(!ctx.claim_once("abort-agent", id)?);
                }
                anyhow::bail!("Deliberate subtree abort rollback.");
            })
            .await;
        assert!(result.is_err());
        let abort = graph.abort.clone();
        let identities = [root, child, leaf];
        graph
            .fixture
            .runtime
            .transact(move |ctx| {
                abort.abort(ctx, &identities[0])?;
                for id in &identities {
                    assert!(!ctx.claim_once("abort-agent", id)?);
                }
                Ok(())
            })
            .await
            .unwrap();
        let abort = graph.abort.clone();
        assert!(
            graph
                .fixture
                .runtime
                .transact(move |ctx| abort.abort(ctx, "missing-original-agent"))
                .await
                .is_err()
        );
        graph.close().await;
    }
}
