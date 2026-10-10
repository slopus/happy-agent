//! The project and workspace catalog and the desktop bootstrap: public projections of the
//! Projects, Workspaces and Bots owner records, each embedding its active root-agent series.
use super::*;
use crate::product::{agents::AgentRequestError, identity::resource_version, runtime::Context};

/// Bootstrap carries only the most recently archived agents of its owners.
const ARCHIVED_AGENT_LIMIT: usize = 200;
const PAGE_LIMIT: u64 = 50;

/// An archived member of an owner's series, kept for `archivedAgents`.
struct ArchivedAgent {
    id: String,
    archived_at: u64,
}

impl ApiModule {
    pub(super) async fn catalog_route(self: &Arc<Self>, request: Request<Incoming>) -> Response<Body> {
        let method = request.method().as_str().to_owned();
        let path = request.uri().path().to_owned();
        if (path == "/v0/workspaces" || path.starts_with("/v0/workspaces/")) && !self.workspaces_enabled() {
            return error(503, "unsupported", "Workspaces are disabled in this daemon.");
        }
        if method != "GET" {
            return error(404, "not_found", "Not found.");
        }
        let query = Query::new(&request);
        let api = self.clone();
        let result = if path == "/v0/bootstrap/desktop" {
            self.desktop_bootstrap().await
        } else if path == "/v0/projects" {
            self.runtime.transact(move |ctx| api.project_list(ctx)).await
        } else if let Some(id) = path.strip_prefix("/v0/projects/").filter(|id| identifier(id)).map(str::to_owned) {
            self.runtime.transact(move |ctx| api.focused_project(ctx, &id)).await
        } else if path == "/v0/workspaces" {
            let project = query.get("projectId").map(str::to_owned);
            match boolean_parameter(query.get("includeArchived"), false) {
                Ok(archived) => self.runtime.transact(move |ctx| api.workspace_list(ctx, project.as_deref(), archived)).await,
                Err(failure) => Err(failure),
            }
        } else if let Some(id) = path.strip_prefix("/v0/workspaces/").filter(|id| identifier(id)).map(str::to_owned) {
            self.runtime.transact(move |ctx| Ok(json!({"workspace": api.workspace_with_agents(ctx, &id)?}))).await
        } else {
            return error(404, "not_found", "Not found.");
        };
        match result {
            Ok(value) => response(200, value),
            Err(failure) => internal(failure),
        }
    }

    fn workspaces_enabled(&self) -> bool {
        self.config.values.get("features").and_then(|features| features.get("workspaces")).and_then(toml::Value::as_bool).unwrap_or(true)
    }

    fn project_list(&self, ctx: &Context<'_>) -> anyhow::Result<Value> {
        let mut projects = Vec::new();
        for project in self.all_projects(ctx, true)? {
            projects.push(self.project_with_agents(ctx, &project, None)?);
        }
        Ok(json!({"projects": projects}))
    }

    fn focused_project(&self, ctx: &Context<'_>, id: &str) -> anyhow::Result<Value> {
        let project = self.projects.get(ctx, id)?.ok_or_else(|| not_found("The project was not found."))?;
        Ok(json!({"project": self.project_with_agents(ctx, &project, None)?}))
    }

    /// Root workspaces first, then the child workspaces, as a flat list; bot workspaces are not listed.
    fn workspace_list(&self, ctx: &Context<'_>, project: Option<&str>, archived: bool) -> anyhow::Result<Value> {
        let mut workspaces = Vec::new();
        for root in self.all_projects(ctx, archived)?.into_iter().filter(|root| project.is_none_or(|project| root["id"] == project)) {
            workspaces.push(self.root_workspace_with_agents(ctx, &root, None)?);
        }
        for workspace in self.all_workspaces(ctx, project, archived)? {
            let agents = self.owner_agents(ctx, self.workspaces.list_agents(ctx, text(&workspace["id"]))?, None)?;
            workspaces.push(with_agents(workspace_resource(&workspace), agents));
        }
        Ok(json!({"workspaces": workspaces}))
    }

    /// A bot's own workspace, a project's root workspace, or a child workspace.
    fn workspace_with_agents(&self, ctx: &Context<'_>, id: &str) -> anyhow::Result<Value> {
        if let Some(bot) = self.bots.for_workspace(ctx, id)? {
            let agent = self.agents.resource(ctx, text(&bot["agentId"]))?.ok_or_else(|| anyhow::anyhow!("The bot workspace has no agent."))?;
            return Ok(bot_workspace_resource(&bot, agent));
        }
        if let Some(project) = self.projects.get(ctx, id)? {
            let archived = project["status"] == "archived" || !project["archivedAt"].is_null();
            if !archived {
                if project["status"] != "active" {
                    return Err(conflict("conflict", "The root workspace is not available."));
                }
                if project["initializationStatus"] == "initializing" {
                    return Err(conflict("not_initialized", "The root workspace is still initializing."));
                }
                if project["initializationStatus"] != "ready" {
                    return Err(conflict("conflict", "The root workspace is not available."));
                }
            }
            return self.root_workspace_with_agents(ctx, &project, None);
        }
        let workspace = self.workspaces.get(ctx, id)?.ok_or_else(|| not_found("The workspace was not found."))?;
        let agents = self.owner_agents(ctx, self.workspaces.list_agents(ctx, id)?, None)?;
        Ok(with_agents(workspace_resource(&workspace), agents))
    }

    fn project_with_agents(&self, ctx: &Context<'_>, project: &Value, archived: Option<&mut Vec<ArchivedAgent>>) -> anyhow::Result<Value> {
        let id = text(&project["id"]);
        let settings = self.projects.read_settings(ctx, id)?;
        let compute = self.projects.compute(ctx, project)?;
        let agents = self.owner_agents(ctx, self.projects.list_agents(ctx, id)?, archived)?;
        Ok(with_agents(project_resource(project, &settings, compute), agents))
    }

    fn root_workspace_with_agents(&self, ctx: &Context<'_>, project: &Value, archived: Option<&mut Vec<ArchivedAgent>>) -> anyhow::Result<Value> {
        let compute = self.projects.compute(ctx, project)?;
        let agents = self.owner_agents(ctx, self.projects.list_agents(ctx, text(&project["id"]))?, archived)?;
        Ok(with_agents(root_workspace_resource(project, compute), agents))
    }

    /// One owner's active agent series, in order. An archived member stays out of it and, when
    /// the caller collects them, is remembered for `archivedAgents`.
    fn owner_agents(&self, ctx: &Context<'_>, associations: Vec<Value>, mut archived: Option<&mut Vec<ArchivedAgent>>) -> anyhow::Result<Vec<Value>> {
        let mut agents = Vec::new();
        for association in associations {
            let id = text(&association["agentId"]);
            let Some(configuration) = self.agents.configuration(ctx, id)? else { continue };
            if let Some(archived_at) = archived_at(&configuration) {
                if let Some(archived) = archived.as_deref_mut() {
                    archived.push(ArchivedAgent { id: id.to_owned(), archived_at });
                }
                continue;
            }
            if let Some(agent) = self.agents.resource(ctx, id)? {
                agents.push(agent);
            }
        }
        Ok(agents)
    }

    fn all_projects(&self, ctx: &Context<'_>, archived: bool) -> anyhow::Result<Vec<Value>> {
        let mut projects = Vec::new();
        let mut cursor: Option<Value> = None;
        loop {
            let mut query = json!({"includeArchived": archived, "limit": PAGE_LIMIT});
            if let Some(cursor) = cursor.take() {
                query["cursor"] = cursor;
            }
            let mut page = self.projects.list_catalog_page(ctx, &query)?;
            projects.extend(page["projects"].as_array_mut().map(std::mem::take).unwrap_or_default());
            match page.get("nextCursor") {
                Some(next) => cursor = Some(next.clone()),
                None => return Ok(projects),
            }
        }
    }

    fn all_workspaces(&self, ctx: &Context<'_>, project: Option<&str>, archived: bool) -> anyhow::Result<Vec<Value>> {
        let mut workspaces = Vec::new();
        let mut cursor: Option<Value> = None;
        loop {
            let mut query = json!({"includeArchived": archived, "limit": PAGE_LIMIT});
            if let Some(project) = project {
                query["projectRef"] = json!(project);
            }
            if let Some(cursor) = cursor.take() {
                query["cursor"] = cursor;
            }
            let mut page = self.workspaces.list_catalog_page(ctx, &query)?;
            workspaces.extend(page["workspaces"].as_array_mut().map(std::mem::take).unwrap_or_default());
            match page.get("nextCursor") {
                Some(next) => cursor = Some(next.clone()),
                None => return Ok(workspaces),
            }
        }
    }

    /// One snapshot of everything the desktop renders first. The cursor is captured before any
    /// read, so a change concurrent with the snapshot is replayed by the stream rather than lost.
    async fn desktop_bootstrap(self: &Arc<Self>) -> anyhow::Result<Value> {
        let cursor = self.events.cursor();
        let onboarding = self.onboarding_state().await?;
        let api = self.clone();
        let mut snapshot = self
            .runtime
            .transact(move |ctx| {
                let config = api.config.public_snapshot(api.node.get(ctx)?, api.presence.public_configuration(ctx)?)?;
                let profile = api.profile.resource(&api.profile.ensure(ctx)?);
                let mut archived = Vec::new();
                let mut projects = Vec::new();
                let mut workspaces = Vec::new();
                for project in api.all_projects(ctx, false)? {
                    let resource = api.project_with_agents(ctx, &project, Some(&mut archived))?;
                    workspaces.push(with_agents(root_workspace_resource(&project, api.projects.compute(ctx, &project)?), resource["agents"].as_array().cloned().unwrap_or_default()));
                    projects.push(resource);
                }
                if api.workspaces_enabled() {
                    for workspace in api.all_workspaces(ctx, None, false)? {
                        if workspace["parentId"] != workspace["projectRef"] {
                            continue;
                        }
                        let agents = api.owner_agents(ctx, api.workspaces.list_agents(ctx, text(&workspace["id"]))?, Some(&mut archived))?;
                        workspaces.push(with_agents(workspace_resource(&workspace), agents));
                    }
                }
                let mut bots = Vec::new();
                for bot in api.bots.list(ctx)? {
                    let agent = api.agents.resource(ctx, text(&bot["agentId"]))?.ok_or_else(|| anyhow::anyhow!("The bot has no agent."))?;
                    bots.push(bot_resource(&bot, agent));
                }
                archived.sort_by(|left, right| right.archived_at.cmp(&left.archived_at).then_with(|| left.id.cmp(&right.id)));
                archived.truncate(ARCHIVED_AGENT_LIMIT);
                let mut archived_agents = Vec::new();
                for agent in &archived {
                    if let Some(resource) = api.agents.resource(ctx, &agent.id)? {
                        archived_agents.push(resource);
                    }
                }
                Ok(json!({"config": config, "profile": profile, "cloud": api.cloud.status(), "bots": bots, "projects": projects, "workspaces": workspaces, "archivedAgents": archived_agents}))
            })
            .await?;
        snapshot["onboarding"] = onboarding;
        snapshot["cursor"] = json!(cursor);
        Ok(snapshot)
    }
}

/// `[a-z][a-z0-9]*`: one project or workspace identifier, not a nested route.
fn identifier(id: &str) -> bool {
    id.starts_with(|character: char| character.is_ascii_lowercase()) && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn boolean_parameter(value: Option<&str>, fallback: bool) -> anyhow::Result<bool> {
    match value {
        None => Ok(fallback),
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(_) => Err(AgentRequestError { status: 400, code: "invalid_request", message: "A boolean query parameter must be true or false." }.into()),
    }
}

fn not_found(message: &'static str) -> anyhow::Error {
    AgentRequestError { status: 404, code: "not_found", message }.into()
}

fn conflict(code: &'static str, message: &'static str) -> anyhow::Error {
    AgentRequestError { status: 409, code, message }.into()
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn or_null(record: &Value, field: &str) -> Value {
    record.get(field).cloned().unwrap_or(Value::Null)
}

fn with_agents(mut resource: Value, agents: Vec<Value>) -> Value {
    resource["agents"] = Value::Array(agents);
    resource
}

/// The agent's archival time, when it is one the resource would report.
fn archived_at(configuration: &Value) -> Option<u64> {
    configuration["metadata"]["archivedAt"].as_u64().filter(|archived| *archived <= 9_007_199_254_740_991)
}

fn version(record: &Value, updated: &str, version: &str, id: &str) -> String {
    resource_version(record[updated].as_u64().unwrap_or(0), record[version].as_u64().unwrap_or(0), id)
}

fn project_git(project: &Value) -> Value {
    let present = ["gitBranch", "gitHead", "gitUpstream"].iter().any(|field| project.get(*field).is_some()) || project["gitDetached"] == true;
    if !present {
        return Value::Null;
    }
    json!({"branch": or_null(project, "gitBranch"), "head": or_null(project, "gitHead"), "upstream": or_null(project, "gitUpstream"), "ahead": project["gitAhead"], "behind": project["gitBehind"], "detached": project["gitDetached"]})
}

fn initialization(record: &Value, status: Value) -> Value {
    json!({"status": status, "attempt": record["initializationAttempt"].as_u64().unwrap_or(0), "error": or_null(record, "initializationError")})
}

/// Where new workspaces of a project run, as clients are shown it.
fn workspace_compute_selection(settings: &Value, compute: &Value) -> Value {
    let selected = settings.get("defaultWorkspaceCompute");
    if compute["type"] == "runner" {
        return match selected {
            Some(selected) if selected["type"] == "docker" => json!({"type": "docker", "image": selected["image"], "runnerId": compute["runnerId"]}),
            _ => json!({"type": "runner", "runnerId": compute["runnerId"]}),
        };
    }
    match selected {
        Some(selected) if selected["type"] != "local" => selected.clone(),
        _ => json!({"type": "host"}),
    }
}

fn project_resource(project: &Value, settings: &Value, compute: Value) -> Value {
    let id = text(&project["id"]);
    let avatar = if project["kind"] == "home" {
        json!({"kind": "home"})
    } else {
        match project.get("avatar") {
            Some(avatar) => json!({"kind": "image", "source": avatar["source"], "thumbhash": avatar["thumbhash"]}),
            None => Value::Null,
        }
    };
    let mut resource = json!({
        "id": id,
        "name": project["name"],
        "nameSource": if project["nameSource"] == "user" { "user" } else { "folder" },
        "compute": compute,
        "status": project["status"],
        "initialization": initialization(project, project["initializationStatus"].clone()),
        "git": project_git(project),
        "defaultBranch": or_null(project, "defaultBranch"),
        "worktreeSupport": project["worktreeSupport"],
    });
    if let Some(reason) = project.get("worktreeUnsupportedReason") {
        resource["worktreeUnsupportedReason"] = reason.clone();
    }
    for (field, value) in [
        ("remoteSource", or_null(project, "remoteSource")),
        ("avatar", avatar),
        ("description", or_null(project, "description")),
        ("workspaceSetupCommands", project.get("workspaceSetupCommands").cloned().unwrap_or_else(|| json!([]))),
        ("settings", json!({"defaultWorkspaceCompute": workspace_compute_selection(settings, &resource["compute"]), "workspaceInitialPrompt": or_null(settings, "workspaceInitialPrompt")})),
        ("orderKey", project["orderKey"].clone()),
        ("version", json!(version(project, "updatedAt", "version", id))),
        ("createdAt", project["createdAt"].clone()),
        ("updatedAt", project["updatedAt"].clone()),
        ("archivedAt", or_null(project, "archivedAt")),
    ] {
        resource[field] = value;
    }
    resource
}

fn root_workspace_resource(project: &Value, compute: Value) -> Value {
    let id = text(&project["id"]);
    json!({
        "subtaskAgentId": null,
        "id": id,
        "projectId": id,
        "parentId": null,
        "botId": null,
        "name": project["name"],
        "nameSource": if project["nameSource"] == "user" { "user" } else { "generated" },
        "kind": "root",
        "compute": compute,
        "status": project["status"],
        "initialization": initialization(project, project["initializationStatus"].clone()),
        "base": null,
        "git": project_git(project),
        "creatorAgentId": null,
        "orderKey": project["orderKey"],
        "version": version(project, "updatedAt", "version", id),
        "createdAt": project["createdAt"],
        "updatedAt": project["updatedAt"],
        "archivedAt": or_null(project, "archivedAt"),
    })
}

fn workspace_resource(workspace: &Value) -> Value {
    let id = text(&workspace["id"]);
    let path = or_null(workspace, "path");
    let compute = match (workspace.get("dockerImage"), workspace.get("runnerId")) {
        (Some(image), runner) => {
            let mut compute = json!({"type": "docker", "image": image, "path": path});
            if let Some(runner) = runner {
                compute["runnerId"] = runner.clone();
            }
            compute
        }
        (None, Some(runner)) => json!({"type": "runner", "runnerId": runner, "path": path}),
        (None, None) => json!({"type": "host", "path": path}),
    };
    let status = text(&workspace["status"]);
    let branch = text(&workspace["branch"]);
    let git = if workspace.get("gitHead").is_some() || workspace.get("gitUpstream").is_some() || workspace["gitDetached"] == true || !branch.is_empty() {
        json!({"branch": branch, "head": or_null(workspace, "gitHead"), "upstream": or_null(workspace, "gitUpstream"), "ahead": workspace["gitAhead"].as_u64().unwrap_or(0), "behind": workspace["gitBehind"].as_u64().unwrap_or(0), "detached": workspace["gitDetached"] == true})
    } else {
        Value::Null
    };
    let base = if workspace.get("baseRef").is_none() && workspace.get("baseCommit").is_none() {
        Value::Null
    } else {
        json!({"ref": or_null(workspace, "baseRef"), "commit": or_null(workspace, "baseCommit")})
    };
    let mut resource = json!({
        "id": id,
        "projectId": or_null(workspace, "projectRef"),
        "parentId": or_null(workspace, "parentId"),
        "botId": null,
        "name": workspace["name"],
        "nameSource": if workspace["nameConfigured"] == true { "user" } else { "generated" },
        "kind": if workspace["kind"] == "git_worktree" { "worktree" } else { "copy" },
        "compute": compute,
        "status": if matches!(status, "archiving" | "archived") { status } else { "active" },
        "initialization": initialization(workspace, json!(match status { "initializing" => "initializing", "failed" => "failed", _ => "ready" })),
        "base": base,
        "git": git,
        "creatorAgentId": or_null(workspace, "creatorSessionId"),
        "subtaskAgentId": or_null(workspace, "subtaskAgentId"),
        "orderKey": workspace["orderKey"],
        "version": version(workspace, "updatedAt", "version", id),
        "createdAt": workspace["createdAt"],
        "updatedAt": workspace["updatedAt"],
        "archivedAt": or_null(workspace, "archivedAt"),
    });
    if let Some(cleanup) = workspace.get("serviceCleanup") {
        resource["serviceCleanup"] = cleanup.clone();
    }
    resource
}

fn bot_compute(bot: &Value) -> Value {
    match bot.get("runnerId") {
        Some(runner) => json!({"type": "runner", "runnerId": runner, "path": bot["path"]}),
        None => json!({"type": "host", "path": bot["path"]}),
    }
}

fn bot_resource(bot: &Value, agent: Value) -> Value {
    let id = text(&bot["id"]);
    json!({
        "id": id,
        "isAdmin": bot["isAdmin"],
        "name": bot["name"],
        "username": bot["username"],
        "workspaceId": bot["workspaceId"],
        "compute": bot_compute(bot),
        "status": bot["status"],
        "systemKey": or_null(bot, "systemKey"),
        "avatar": or_null(bot, "avatar"),
        "agent": agent,
        "orderKey": bot["orderKey"],
        "version": version(bot, "updatedAt", "version", id),
        "createdAt": bot["createdAt"],
        "updatedAt": bot["updatedAt"],
        "archivedAt": or_null(bot, "archivedAt"),
    })
}

/// The unlisted workspace one bot owns.
fn bot_workspace_resource(bot: &Value, agent: Value) -> Value {
    let id = text(&bot["workspaceId"]);
    json!({
        "id": id,
        "projectId": null,
        "parentId": null,
        "botId": bot["id"],
        "name": bot["username"],
        "nameSource": "user",
        "kind": "bot",
        "compute": bot_compute(bot),
        "status": bot["status"],
        "initialization": {"status": "ready", "attempt": 0, "error": null},
        "base": null,
        "git": null,
        "creatorAgentId": null,
        "orderKey": "5",
        "version": version(bot, "workspaceUpdatedAt", "workspaceVersion", id),
        "createdAt": bot["createdAt"],
        "updatedAt": bot["workspaceUpdatedAt"],
        "archivedAt": or_null(bot, "archivedAt"),
        "agents": [agent],
        "subtaskAgentId": null,
    })
}
