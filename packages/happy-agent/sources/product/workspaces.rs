use super::{
    config::ConfigModule,
    durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration},
    events::EventsModule,
    identity::{now, resource_version},
    owners::{AbortModule, GitModule, RunOptions, RunnersModule},
    projects::ProjectsModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
    services::ServicesModule,
    subtasks::SubtasksModule,
};
use anyhow::{Context as _, Result};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[path = "owners/workspaces_persistence.rs"]
mod persistence;
#[path = "owners/workspace_catalog.rs"]
mod catalog;
#[path = "owners/workspaces_reservation.rs"]
mod reservation;
#[path = "owners/workspace_identity.rs"]
mod workspace_identity;
#[path = "owners/workspace_naming.rs"]
mod naming;

pub struct WorkspacesModule {
    runtime: Arc<RuntimeModule>,
    owners: Option<Owners>,
    subtask_listener: Mutex<Weak<SubtasksModule>>,
}
struct Owners {
    config: Arc<ConfigModule>,
    projects: Arc<ProjectsModule>,
    git: Arc<GitModule>,
    abort: Arc<AbortModule>,
    durable: Arc<DurableFunctionsModule>,
    runners: Arc<RunnersModule>,
    services: Arc<ServicesModule>,
    events: Arc<EventsModule>,
    schemas: Schemas,
}
struct Procedure {
    owner: Weak<WorkspacesModule>,
    archive: bool,
}
impl WorkspacesModule {
    pub fn new(runtime: Arc<RuntimeModule>) -> Self {
        Self {
            runtime,
            owners: None,
            subtask_listener: Mutex::new(Weak::new()),
        }
    }
    #[expect(clippy::too_many_arguments)]
    pub fn install(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        projects: Arc<ProjectsModule>,
        git: Arc<GitModule>,
        abort: Arc<AbortModule>,
        durable: Arc<DurableFunctionsModule>,
        runners: Arc<RunnersModule>,
        services: Arc<ServicesModule>,
        events: Arc<EventsModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in [
            "ownerWorkspace",
            "ownerWorkspaceArgs",
            "ownerWorkspaceProvision",
            "ownerNull",
            "ownerFolderSettings",
            "ownerWorkspacePageQuery",
            "ownerWorkspacePage",
            "ownerWorkspaceAgentOrders",
            "ownerWorkspaceId",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        let module = Arc::new(Self {
            runtime,
            subtask_listener: Mutex::new(Weak::new()),
            owners: Some(Owners {
                config,
                projects,
                git,
                abort,
                durable: durable.clone(),
                runners,
                services,
                events,
                schemas,
            }),
        });
        for (name, archive, result) in [
            ("workspaces.provision", false, "ownerWorkspaceProvision"),
            ("workspaces.archive", true, "ownerNull"),
        ] {
            durable.register(Registration {
                name: name.to_owned(),
                arguments_schema: "ownerWorkspaceArgs",
                result_schema: result,
                function: Arc::new(Procedure {
                    owner: Arc::downgrade(&module),
                    archive,
                }),
            })?;
        }
        module
            .owners()?
            .projects
            .listen_archives(Arc::downgrade(&module))?;
        durable.register(Registration {
            name: "workspaces.rename".to_owned(),
            arguments_schema: "ownerWorkspaceRenameIntent",
            result_schema: "ownerNull",
            function: Arc::new(naming::Rename { owner: Arc::downgrade(&module) }),
        })?;
        Ok(module)
    }
    fn owners(&self) -> Result<&Owners> {
        self.owners
            .as_ref()
            .context("The workspace execution owner is not installed.")
    }
    pub fn listen_subtasks(&self, module: Weak<SubtasksModule>) -> Result<()> {
        let mut listener = self
            .subtask_listener
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            listener.upgrade().is_none(),
            "The workspace subtask listener is already installed."
        );
        *listener = module;
        Ok(())
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime
            .migrate("workspaces", persistence::MIGRATIONS)
            .await
    }
    pub fn get(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        if !persistence::available(ctx)? {
            return Ok(None);
        }
        persistence::read(ctx, &Schemas::new()?, id)
    }
    pub fn has_identity(&self, ctx: &Context<'_>, id: &str) -> Result<bool> {
        self.runtime.assert_context(ctx)?;
        if !persistence::available(ctx)? {
            return Ok(false);
        }
        persistence::has_identity(ctx, id)
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
    pub fn reserve(self: &Arc<Self>, ctx: &Context<'_>, workspace: &Value) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let owners = self.owners()?;
        persistence::validate(&owners.schemas, workspace)?;
        anyhow::ensure!(
            workspace["status"] == "initializing"
                && workspace["presence"] == "missing"
                && workspace["version"] == 1,
            "A workspace must start as an empty reservation."
        );
        let project = owners
            .projects
            .get(ctx, workspace["projectRef"].as_str().unwrap_or_default())?
            .context("The workspace's project was not found.")?;
        anyhow::ensure!(
            project["status"] == "active" && project["initializationStatus"] == "ready",
            "The workspace's project is not ready."
        );
        persistence::insert(ctx, &owners.schemas, workspace)?;
        owners.durable.invoke(ctx,&json!({"function":"workspaces.provision","arguments":{"id":workspace["id"]},"operationId":format!("workspace-create.{}",workspace["id"].as_str().unwrap_or_default()),"lockKeys":[format!("workspace.{}",workspace["id"].as_str().unwrap_or_default())]}))?;
        Ok(workspace.clone())
    }
    pub fn archive_project(self: &Arc<Self>, ctx: &Context<'_>, project: &str) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        let owners = self.owners()?;
        let ids = persistence::project_ids(ctx, project)?;
        for id in &ids {
            let workspace = self
                .get(ctx, id)?
                .context("A workspace disappeared during project archival.")?;
            persistence::ancestor_ids(ctx, &owners.schemas, &workspace)?;
        }
        for id in ids {
            self.begin_archive(ctx, &id)?;
        }
        if !persistence::has_unarchived(ctx, project)? {
            owners.projects.schedule_archived_cleanup(ctx, project)?;
        }
        Ok(())
    }
    pub fn begin_archive(self: &Arc<Self>, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        let owners = self.owners()?;
        let Some(root) = self.get(ctx, id)? else {
            return Ok(None);
        };
        persistence::ancestor_ids(ctx, &owners.schemas, &root)?;
        let mut tree = vec![id.to_owned()];
        let mut visited = BTreeSet::new();
        let mut index = 0;
        while index < tree.len() {
            let current = tree[index].clone();
            anyhow::ensure!(
                visited.len() < 10000 && visited.insert(current.clone()),
                "The workspace archive tree is cyclic or exceeds its snapshot bound."
            );
            tree.extend(persistence::child_ids(
                ctx,
                root["projectRef"].as_str().unwrap_or_default(),
                &current,
            )?);
            index += 1;
        }
        for child in tree.into_iter().rev() {
            self.begin_archive_one(ctx, &child)?;
        }
        self.get(ctx, id)
    }
    fn begin_archive_one(self: &Arc<Self>, ctx: &Context<'_>, id: &str) -> Result<()> {
        let owners = self.owners()?;
        let Some(before) = self.get(ctx, id)? else {
            return Ok(());
        };
        if before["status"] == "archived" {
            return Ok(());
        }
        let mut after = before.clone();
        if before["status"] != "archiving" {
            after["status"] = json!("archiving");
            after["archivedAt"] = json!(now());
            if let Some(cleanup) = owners.services.close_workspace_admission(ctx, &before)? {
                after["serviceCleanup"] = cleanup;
            }
            self.write(ctx, &before, &mut after)?;
            let subtasks = self
                .subtask_listener
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .upgrade();
            if let Some(subtasks) = subtasks {
                subtasks.workspace_archived(ctx, &after)?;
            }
        }
        owners
            .durable
            .cancel(ctx, &format!("workspace-create.{id}"))?;
        owners.durable.invoke(ctx,&json!({"function":"workspaces.archive","arguments":{"id":id},"operationId":format!("workspace-archive.{id}"),"lockKeys":[format!("workspace.{id}")]}))?;
        Ok(())
    }
    fn write(&self, ctx: &Context<'_>, before: &Value, after: &mut Value) -> Result<()> {
        let owners = self.owners()?;
        if before == after {
            return Ok(());
        }
        after["version"] = json!(before["version"].as_u64().unwrap_or_default() + 1);
        after["updatedAt"] = json!(now());
        *after = persistence::write(ctx, &owners.schemas, before, after)?;
        let mut changes = json!({"updatedAt":after["updatedAt"]});
        for field in ["name", "nameConfigured", "branch"] {
            if before.get(field)!=after.get(field) {changes[field]=after[field].clone();}
        }
        if before["status"] != after["status"] {
            changes["status"] = json!(if after["status"] == "archiving"
                || after["status"] == "archived"
            {
                after["status"].as_str().unwrap_or_default()
            } else {
                "active"
            });
        }
        if before["status"] != after["status"]
            || before["initializationAttempt"] != after["initializationAttempt"]
            || before["initializationError"] != after["initializationError"]
        {
            changes["initialization"] = json!({"status":if after["status"]=="initializing"{"initializing"}else if after["status"]=="failed"{"failed"}else{"ready"},"attempt":after["initializationAttempt"],"error":after.get("initializationError").cloned().unwrap_or(Value::Null)});
        }
        if before.get("serviceCleanup") != after.get("serviceCleanup") {
            changes["serviceCleanup"] = after.get("serviceCleanup").cloned().unwrap_or(Value::Null);
        }
        if before.get("baseCommit") != after.get("baseCommit")
            || before.get("baseRef") != after.get("baseRef")
        {
            changes["base"] = json!({"ref":after.get("baseRef").cloned().unwrap_or(Value::Null),"commit":after.get("baseCommit").cloned().unwrap_or(Value::Null)});
        }
        if before.get("archivedAt") != after.get("archivedAt") {
            changes["archivedAt"] = after.get("archivedAt").cloned().unwrap_or(Value::Null);
        }
        let id = after["id"].as_str().unwrap_or_default();
        owners.events.record(ctx,None,"workspace.updated",json!({"workspaceId":id,"previousVersion":resource_version(before["updatedAt"].as_u64().unwrap_or_default(),before["version"].as_u64().unwrap_or_default(),id),"version":resource_version(after["updatedAt"].as_u64().unwrap_or_default(),after["version"].as_u64().unwrap_or_default(),id),"changes":changes}))?;
        Ok(())
    }
    async fn current(self: &Arc<Self>, id: &str) -> Result<Option<Value>> {
        let module = self.clone();
        let id = id.to_owned();
        self.runtime.transact(move |ctx| module.get(ctx, &id)).await
    }
    async fn settings(
        &self,
        runner: Option<&str>,
        folder: &Path,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let owners = self.owners()?;
        let defaults = owners.config.workspace_folder_defaults();
        let loaded = async {
            let bytes = owners
                .runners
                .read(runner, &folder.join("happy.toml"), 1048576, cancel)
                .await?;
            owners
                .config
                .parse_workspace_folder_settings(std::str::from_utf8(&bytes)?)
        }
        .await;
        anyhow::ensure!(!cancel.is_cancelled(), "Workspace setup was cancelled.");
        let settings = loaded.unwrap_or(defaults);
        anyhow::ensure!(
            owners.schemas.valid("ownerFolderSettings", &settings)?,
            "The workspace folder settings are invalid."
        );
        Ok(settings)
    }
    async fn provision(
        self: &Arc<Self>,
        id: &str,
        kv: &CallKv,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let work=async {
            let Some(workspace)=self.current(id).await? else {
                return Ok(json!({"outcome":"superseded"}));
            };
            if workspace["status"]=="ready" {
                return Ok(json!({"outcome":"ready"}));
            }
            if workspace["status"]!="initializing" {
                return Ok(json!({"outcome":"superseded"}));
            }
            let module=self.clone();
            let project_id=workspace["projectRef"].as_str().unwrap_or_default().to_owned();
            let project=self.runtime.transact(move|ctx|module.owners()?.projects.get(ctx,&project_id)).await?
                .context("The workspace's project was not found.")?;
            if !checkpoint(kv,"contents",&json!(true)).await? {
                self.contents(&workspace,&project,cancel).await?;
                complete(kv,"contents",json!(true)).await?;
            }
            let Some(current)=self.current(id).await? else {
                return Ok(json!({"outcome":"superseded"}));
            };
            if current["status"]=="ready" {
                return Ok(json!({"outcome":"ready"}));
            }
            if current["status"]!="initializing" {
                return Ok(json!({"outcome":"superseded"}));
            }
            let owners=self.owners()?;
            let runner=current["runnerId"].as_str();
            let path=Path::new(current["path"].as_str().unwrap_or_default());
            if !checkpoint(kv,"initial-sync",&json!(true)).await? {
                let project_path=Path::new(project["repositoryRef"].as_str().unwrap_or_default());
                let settings=self.settings(runner,project_path,cancel).await?;
                let projects=owners.projects.clone();
                let project_id=project["id"].as_str().unwrap_or_default().to_owned();
                let commands=settings["setupCommands"].clone();
                self.runtime.transact(move|ctx|projects.record_workspace_setup_commands(ctx,&project_id,commands)).await?;
                let paths=settings["sync"].as_array().into_iter().flatten()
                    .chain(settings["protectedSync"].as_array().into_iter().flatten())
                    .filter_map(Value::as_str).collect::<Vec<_>>();
                self.sync_files(runner,project_path,path,&paths,cancel).await?;
                complete(kv,"initial-sync",json!(true)).await?;
            }
            let settings=self.settings(runner,path,cancel).await?;
            for(index,command)in settings["setupCommands"].as_array().into_iter().flatten().enumerate() {
                let command=command.as_str().context("The setup command is invalid.")?;
                let key=format!("setup-{index}");
                if checkpoint(kv,&key,&json!(command)).await? {continue;}
                match owners.runners.run_shell(runner,command,path,cancel).await {
                    Ok(result) if result.code==0 && !result.timed_out=>{},
                    Ok(result)=>eprintln!("Workspace {id} setup failed, but the checkout remains usable: {}",bounded_error(&result.stderr)),
                    Err(error)=>{
                        anyhow::ensure!(!cancel.is_cancelled(),"Workspace setup was cancelled.");
                        eprintln!("Workspace {id} setup failed, but the checkout remains usable: {error:#}");
                    }
                }
                complete(kv,&key,json!(command)).await?;
            }
            Ok(json!({"outcome":"ready"}))
        }.await;
        anyhow::ensure!(!cancel.is_cancelled(), "Workspace setup was cancelled.");
        match work {
            Ok(value) => Ok(value),
            Err(error) if error.downcast_ref::<rusqlite::Error>().is_some() => Err(error),
            Err(error) => Ok(json!({"outcome":"failed","error":bounded_error(&error.to_string())})),
        }
    }
    async fn contents(
        self: &Arc<Self>,
        workspace: &Value,
        project: &Value,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let owners = self.owners()?;
        let _lock = owners
            .git
            .project_lock(workspace["projectRef"].as_str().unwrap_or_default(), cancel)
            .await?;
        let mut current = self
            .current(workspace["id"].as_str().unwrap_or_default())
            .await?
            .context("The workspace disappeared before setup.")?;
        if current["status"] != "initializing" {
            return Ok(());
        }
        let parent = {
            let module = self.clone();
            let current = current.clone();
            self.runtime
                .transact(move |ctx| {
                    persistence::ancestor_ids(ctx, &module.owners()?.schemas, &current)?;
                    if current["parentId"] == current["projectRef"] {
                        Ok(None)
                    } else {
                        let parent = module
                            .get(ctx, current["parentId"].as_str().unwrap_or_default())?
                            .context("The workspace's parent was not found.")?;
                        anyhow::ensure!(
                            parent["status"] == "ready" && parent["presence"] == "present",
                            "The workspace's parent is not ready."
                        );
                        Ok(Some(parent))
                    }
                })
                .await?
        };
        let runner = current["runnerId"].as_str();
        let path = Path::new(current["path"].as_str().unwrap_or_default());
        let project_path = Path::new(project["repositoryRef"].as_str().unwrap_or_default());
        if current["kind"] == "directory" {
            if owners.runners.exists(runner, path, cancel).await? {
                return Ok(());
            }
            let source = parent
                .as_ref()
                .and_then(|parent| parent["path"].as_str())
                .map(Path::new)
                .unwrap_or(project_path);
            self.copy_folder(runner, source, path, cancel).await?;
            return Ok(());
        }
        let common = if let Some(common) = current["gitCommonDir"].as_str() {
            PathBuf::from(common)
        } else {
            owners.git.common_dir(runner, project_path, cancel).await?
        };
        let base = if current["baseCommit"].as_str().is_none() {
            Some(
                owners
                    .git
                    .resolve_base(
                        runner,
                        project_path,
                        current["baseRef"].as_str(),
                        project["defaultBranch"].as_str(),
                        cancel,
                    )
                    .await?,
            )
        } else {
            None
        };
        if current["gitCommonDir"].as_str().is_none() || base.is_some() {
            let module = self.clone();
            let before = current.clone();
            let common = common.clone();
            current = self
                .runtime
                .transact(move |ctx| {
                    let mut after = before.clone();
                    after["gitCommonDir"] = json!(common);
                    if let Some(base) = base {
                        after["baseCommit"] = base["commit"].clone();
                        after["baseRef"] = base["ref"].clone();
                    }
                    module.write(ctx, &before, &mut after)?;
                    Ok(after)
                })
                .await?;
        }
        let runner = current["runnerId"].as_str();
        let path = Path::new(current["path"].as_str().unwrap_or_default());
        let commit = current["baseCommit"]
            .as_str()
            .context("The workspace has no anchored base commit.")?;
        if owners.runners.exists(runner, path, cancel).await? {
            if owners
                .git
                .is_worktree(runner, path, &common, cancel)
                .await?
            {
                return Ok(());
            }
            self.remove_folder(&current, project, false, false, cancel)
                .await?;
        }
        owners
            .git
            .create_worktree(
                runner,
                project_path,
                path,
                current["branch"].as_str().unwrap_or_default(),
                commit,
                &common,
                cancel,
            )
            .await
    }
    async fn copy_folder(
        &self,
        runner: Option<&str>,
        source: &Path,
        destination: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let owners = self.owners()?;
        owners
            .runners
            .mkdir(
                runner,
                destination
                    .parent()
                    .context("The workspace has no parent directory.")?,
                cancel,
            )
            .await?;
        let staging = PathBuf::from(format!("{}.partial", destination.display()));
        owners.runners.remove(runner, &staging, cancel).await?;
        owners.runners.mkdir(runner, &staging, cancel).await?;
        let copy = async {
            let entries = owners
                .runners
                .entries(runner, source, cancel)
                .await?
                .into_iter()
                .filter(|entry| entry != ".git" && entry != "node_modules")
                .collect::<Vec<_>>();
            if !entries.is_empty() {
                let windows = owners.runners.platform(runner, cancel).await? == "win32";
                let mut args = if windows {
                    vec![
                        source.to_string_lossy().into_owned(),
                        staging.to_string_lossy().into_owned(),
                        "/E".to_owned(),
                        "/SL".to_owned(),
                        "/XD".to_owned(),
                        source.join(".git").to_string_lossy().into_owned(),
                        source.join("node_modules").to_string_lossy().into_owned(),
                        "/NFL".to_owned(),
                        "/NDL".to_owned(),
                        "/NJH".to_owned(),
                        "/NJS".to_owned(),
                        "/NP".to_owned(),
                    ]
                } else {
                    vec!["-R".to_owned(), "-P".to_owned(), "--".to_owned()]
                };
                if !windows {
                    args.extend(
                        entries
                            .iter()
                            .map(|entry| source.join(entry).to_string_lossy().into_owned()),
                    );
                    args.push(staging.to_string_lossy().into_owned());
                }
                let result = owners
                    .runners
                    .run(
                        runner,
                        RunOptions {
                            command: if windows { "robocopy" } else { "cp" }.to_owned(),
                            args,
                            cwd: None,
                            environment: BTreeMap::new(),
                            maximum_bytes: 65536,
                            timeout: Duration::from_secs(1800),
                        },
                        cancel,
                    )
                    .await?;
                anyhow::ensure!(
                    (if windows {
                        result.code < 8
                    } else {
                        result.code == 0
                    }) && !result.timed_out,
                    "The project folder could not be copied: {}",
                    result.stderr
                );
            }
            owners.runners.remove(runner, destination, cancel).await?;
            owners
                .runners
                .move_path(runner, &staging, destination, cancel)
                .await
        }
        .await;
        if copy.is_err() {
            let _ = owners
                .runners
                .remove(runner, &staging, &CancellationToken::new())
                .await;
        }
        copy
    }
    async fn sync_files(
        &self,
        runner: Option<&str>,
        project: &Path,
        workspace: &Path,
        paths: &[&str],
        cancel: &CancellationToken,
    ) -> Result<()> {
        let owners = self.owners()?;
        if !owners.runners.exists(runner, workspace, cancel).await? {
            return Ok(());
        }
        let root = owners
            .runners
            .canonical_path(runner, workspace, cancel)
            .await?;
        let mut seen = BTreeSet::new();
        for path in paths {
            if !seen.insert(*path) {
                continue;
            }
            let relative = Path::new(path);
            anyhow::ensure!(
                !relative.is_absolute()
                    && relative
                        .components()
                        .all(|component| matches!(component, Component::Normal(_))),
                "Workspace sync paths must stay inside the project."
            );
            let source = project.join(relative);
            let target = workspace.join(relative);
            let copy = async {
                let canonical = owners.runners.future_path(runner, &target, cancel).await?;
                if canonical == root
                    || !canonical.starts_with(&root)
                    || !owners.runners.exists(runner, &source, cancel).await?
                {
                    return Ok(());
                }
                owners
                    .runners
                    .mkdir(
                        runner,
                        canonical.parent().context("The sync path has no parent.")?,
                        cancel,
                    )
                    .await?;
                owners.runners.remove(runner, &canonical, cancel).await?;
                let windows=owners.runners.platform(runner,cancel).await?=="win32";
                let args=if windows {
                    let resolved=owners.runners.canonical_path(runner,&source,cancel).await?;
                    let directory=owners.runners.inspect(runner,&resolved,cancel).await?["isDirectory"]==true;
                    let mut args=if directory {vec![source.to_string_lossy().into_owned(),canonical.to_string_lossy().into_owned(),"/E".to_owned()]}else{vec![source.parent().context("The sync source has no parent.")?.to_string_lossy().into_owned(),canonical.parent().context("The sync destination has no parent.")?.to_string_lossy().into_owned(),source.file_name().context("The sync source has no name.")?.to_string_lossy().into_owned()]};
                    args.extend(["/NFL","/NDL","/NJH","/NJS","/NP"].map(str::to_owned));args
                }else{vec!["-R".to_owned(),"-L".to_owned(),"--".to_owned(),source.to_string_lossy().into_owned(),canonical.to_string_lossy().into_owned()]};
                let result = owners
                    .runners
                    .run(
                        runner,
                        RunOptions {
                            command: if windows{"robocopy"}else{"cp"}.to_owned(),
                            args,
                            cwd: None,
                            environment: BTreeMap::new(),
                            maximum_bytes: 65536,
                            timeout: Duration::from_secs(300),
                        },
                        cancel,
                    )
                    .await?;
                anyhow::ensure!(
                    (if windows{result.code<8}else{result.code==0}) && !result.timed_out,
                    "The sync copy failed."
                );
                Ok::<_, anyhow::Error>(())
            }
            .await;
            anyhow::ensure!(!cancel.is_cancelled(), "Workspace sync was cancelled.");
            if let Err(error) = copy {
                eprintln!("A workspace sync path remains owed: {error:#}");
            }
        }
        Ok(())
    }
    async fn remove_folder(
        &self,
        workspace: &Value,
        project: &Value,
        keep_copies: bool,
        keep_worktrees: bool,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let owners = self.owners()?;
        let runner = workspace["runnerId"].as_str();
        let path = Path::new(workspace["path"].as_str().unwrap_or_default());
        let home = owners.runners.workspaces_home(runner, cancel).await?;
        let expected = home
            .join(project["storageKey"].as_str().unwrap_or_default())
            .join(workspace["storageKey"].as_str().unwrap_or_default());
        anyhow::ensure!(
            path == expected,
            "The workspace path is outside its managed folder."
        );
        for key in [&workspace["storageKey"], &project["storageKey"]] {
            let key = key.as_str().unwrap_or_default();
            anyhow::ensure!(
                key.len() <= 64
                    && !key.is_empty()
                    && key.bytes().all(|byte| byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || byte == b'-'),
                "The workspace storage identity is invalid."
            );
        }
        anyhow::ensure!(
            path.file_name()
                .is_some_and(|name| name == workspace["storageKey"].as_str().unwrap_or_default())
                && path
                    .parent()
                    .and_then(Path::file_name)
                    .is_some_and(|name| name == project["storageKey"].as_str().unwrap_or_default()),
            "The workspace path does not match its managed storage identity."
        );
        if if workspace["kind"] == "git_worktree" {
            keep_worktrees
        } else {
            keep_copies
        } {
            return Ok(());
        }
        let exists = owners.runners.exists(runner, path, cancel).await?;
        if exists {
            owners.git.real_directory(runner, path, cancel).await?;
        }
        let Some(common) = workspace["gitCommonDir"]
            .as_str()
            .filter(|_| workspace["kind"] == "git_worktree")
        else {
            if exists {
                owners.runners.remove(runner, path, cancel).await?;
            }
            return Ok(());
        };
        let project_path = Path::new(project["repositoryRef"].as_str().unwrap_or_default());
        if owners.runners.exists(runner, project_path, cancel).await? {
            owners
                .git
                .remove_worktree(
                    runner,
                    project_path,
                    path,
                    Path::new(common),
                    exists,
                    cancel,
                )
                .await?;
        } else {
            anyhow::ensure!(
                !owners
                    .runners
                    .exists(runner, Path::new(common), cancel)
                    .await?,
                "The source project is unavailable while its shared Git directory still exists."
            );
            if exists {
                owners.runners.remove(runner, path, cancel).await?;
            }
        }
        Ok(())
    }
    async fn cleanup_phase(
        self: &Arc<Self>,
        id: &str,
        phase: &str,
        error: Option<Value>,
    ) -> Result<()> {
        let module = self.clone();
        let id = id.to_owned();
        let phase = phase.to_owned();
        self.runtime
            .transact(move |ctx| {
                let Some(before) = module.get(ctx, &id)? else {
                    return Ok(());
                };
                if before["status"] != "archiving" || before["serviceCleanup"].is_null() {
                    return Ok(());
                }
                let mut after = before.clone();
                after["serviceCleanup"]["phase"] = json!(phase);
                after["serviceCleanup"]["error"] = error.unwrap_or(Value::Null);
                module.write(ctx, &before, &mut after)
            })
            .await
    }
    async fn archive_folder(
        self: &Arc<Self>,
        id: &str,
        kv: &CallKv,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let Some(workspace) = self.current(id).await? else {
            return Ok(());
        };
        if workspace["status"] == "archived" {
            return Ok(());
        }
        anyhow::ensure!(
            workspace["status"] == "archiving",
            "The workspace is not being archived."
        );
        let owners = self.owners()?;
        let ids = {
            let module = self.clone();
            let id = id.to_owned();
            self.runtime
                .transact(move |ctx| {
                    module.runtime.assert_context(ctx)?;
                    persistence::agent_ids(ctx, &id)
                })
                .await?
        };
        for agent in ids {
            let key = format!("agent-{agent}");
            if checkpoint(kv, &key, &json!(true)).await? {
                continue;
            }
            let mut delay = Duration::from_millis(100);
            loop {
                match owners.abort.abort_current(agent.clone()).await {
                    Ok(()) => break,
                    Err(error) => {
                        anyhow::ensure!(
                            !cancel.is_cancelled(),
                            "Workspace archival was cancelled."
                        );
                        if error.downcast_ref::<rusqlite::Error>().is_some() {
                            return Err(error);
                        }
                        eprintln!("Work in workspace {id} could not be stopped yet: {error:#}");
                        backoff_wait(cancel, delay).await?;
                        delay = (delay * 2).min(Duration::from_secs(60));
                    }
                }
            }
            complete(kv, &key, json!(true)).await?;
        }
        let project = {
            let module = self.clone();
            let project = workspace["projectRef"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            self.runtime
                .transact(move |ctx| module.owners()?.projects.get(ctx, &project))
                .await?
        }
        .context("The workspace's project was not found.")?;
        let mut delay = Duration::from_millis(100);
        loop {
            self.cleanup_phase(id, "stopping_services", None).await?;
            match owners.services.confirm_workspace_removal(id, cancel).await {
                Ok(()) => break,
                Err(error) => {
                    anyhow::ensure!(!cancel.is_cancelled(), "Workspace archival was cancelled.");
                    if error.downcast_ref::<rusqlite::Error>().is_some() {
                        return Err(error);
                    }
                    self.cleanup_phase(id,"blocked",Some(json!({"code":"service_cleanup_unconfirmed","message":"Service cleanup is not confirmed. Workspace files have been retained."}))).await?;
                    eprintln!("Workspace {id} removal awaits runtime cleanup: {error:#}");
                    backoff_wait(cancel, delay).await?;
                    delay = (delay * 2).min(Duration::from_secs(60));
                }
            }
        }
        let settings = self
            .settings(
                workspace["runnerId"].as_str(),
                Path::new(project["repositoryRef"].as_str().unwrap_or_default()),
                cancel,
            )
            .await?;
        delay = Duration::from_millis(100);
        loop {
            self.cleanup_phase(id, "removing_files", None).await?;
            let removed = async {
                let _lock = owners
                    .git
                    .project_lock(project["id"].as_str().unwrap_or_default(), cancel)
                    .await?;
                let Some(current) = self.current(id).await? else {
                    return Ok(());
                };
                if current["status"] == "archived" {
                    return Ok(());
                }
                anyhow::ensure!(
                    current["status"] == "archiving",
                    "Workspace archival was superseded."
                );
                self.remove_folder(
                    &current,
                    &project,
                    settings["keepCopiesOnArchive"].as_bool().unwrap_or(true),
                    settings["keepWorktreesOnArchive"]
                        .as_bool()
                        .unwrap_or(false),
                    cancel,
                )
                .await
            }
            .await;
            match removed {
                Ok(()) => break,
                Err(error) => {
                    anyhow::ensure!(!cancel.is_cancelled(), "Workspace archival was cancelled.");
                    self.cleanup_phase(id,"blocked",Some(json!({"code":"folder_cleanup_failed","message":"The workspace folder could not be removed yet. Its services are stopped."}))).await?;
                    eprintln!("Workspace {id} folder cleanup remains owed: {error:#}");
                    backoff_wait(cancel, delay).await?;
                    delay = (delay * 2).min(Duration::from_secs(60));
                }
            }
        }
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
                .context("The workspace owner has closed.")?;
            let id = call["arguments"]["id"]
                .as_str()
                .context("The workspace ID is missing.")?;
            if self.archive {
                module.archive_folder(id, &kv, &cancel).await?;
                Ok(Value::Null)
            } else {
                module.provision(id, &kv, &cancel).await
            }
        })
    }
    fn success(&self, ctx: &Context<'_>, call: &Value, result: &Value) -> Result<()> {
        let module = self
            .owner
            .upgrade()
            .context("The workspace owner has closed.")?;
        let id = call["arguments"]["id"].as_str().unwrap_or_default();
        let Some(before) = module.get(ctx, id)? else {
            return Ok(());
        };
        let mut after = before.clone();
        if self.archive {
            if before["status"] == "archiving" {
                after["status"] = json!("archived");
                if before.get("serviceCleanup").is_some() {
                    after["serviceCleanup"] = Value::Null;
                }
                after.as_object_mut().unwrap().remove("initializationError");
                module.write(ctx, &before, &mut after)?;
            }
            if !persistence::has_unarchived(ctx, before["projectRef"].as_str().unwrap_or_default())?
            {
                module.owners()?.projects.schedule_archived_cleanup(
                    ctx,
                    before["projectRef"].as_str().unwrap_or_default(),
                )?;
            }
            return Ok(());
        }
        if before["status"] != "initializing" || result["outcome"] == "superseded" {
            return Ok(());
        }
        if result["outcome"] == "ready" {
            after["status"] = json!("ready");
            after["presence"] = json!("present");
            after.as_object_mut().unwrap().remove("initializationError");
        } else {
            after["status"] = json!("failed");
            after["initializationError"] = result["error"].clone();
            after["initializationAttempt"] = json!(
                before["initializationAttempt"]
                    .as_u64()
                    .unwrap_or_default()
                    .saturating_add(1)
                    .min(1000000)
            );
        }
        module.write(ctx, &before, &mut after)
    }
}
async fn checkpoint(kv: &CallKv, key: &str, marker: &Value) -> Result<bool> {
    let key = key.to_owned();
    let marker = marker.clone();
    kv.transact(move |ctx, kv| Ok(kv.read(ctx, &key)?.as_ref() == Some(&marker)))
        .await
}
async fn complete(kv: &CallKv, key: &str, marker: Value) -> Result<()> {
    let key = key.to_owned();
    kv.transact(move |ctx, kv| kv.write(ctx, &key, &marker))
        .await
}
fn bounded_error(text: &str) -> String {
    let value = text
        .chars()
        .filter(|character| !character.is_control() || ['\n', '\r', '\t'].contains(character))
        .scan(0, |length, character| {
            *length += character.len_utf16();
            Some((*length <= 500).then_some(character))
        })
        .take_while(Option::is_some)
        .flatten()
        .collect::<String>();
    if value.trim().is_empty() {
        "Workspace setup failed.".to_owned()
    } else {
        value
    }
}
async fn backoff_wait(cancel: &CancellationToken, delay: Duration) -> Result<()> {
    tokio::select! {_=cancel.cancelled()=>anyhow::bail!("Workspace archival was cancelled."),_=tokio::time::sleep(delay)=>Ok(())}
}
