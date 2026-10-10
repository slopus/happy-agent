use super::*;

impl WorkspacesModule {
    pub fn project_for_creation(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        self.owners()?.projects.get(ctx, id)
    }
    /// Connect before entering a catalog transaction; machine startup owns a separate lifetime.
    pub async fn prepare_creation(
        &self,
        project: &Value,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.owners()?
            .runners
            .prepare_machine(project["runnerId"].as_str(), cancel)
            .await
    }
    pub fn create_workspace(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        project_id: &str,
        request: &Value,
        creator: Option<&str>,
        subtask: Option<&str>,
    ) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        let owners = self.owners()?;
        anyhow::ensure!(
            owners
                .schemas
                .valid("ownerWorkspaceDomainCreate", request)?,
            "The workspace creation request is invalid."
        );
        let Some(mut project) = owners.projects.get(ctx, project_id)? else {
            return Ok(None);
        };
        let runner = project["runnerId"].as_str();
        let path = Path::new(
            project["repositoryRef"]
                .as_str()
                .context("The project folder is missing.")?,
        );
        let cancel = CancellationToken::new();
        let handle = tokio::runtime::Handle::current();
        anyhow::ensure!(
            project["status"] == "active"
                && project["initializationStatus"] == "ready"
                && project["presence"] == "present"
                && handle.block_on(owners.runners.exists(runner, path, &cancel))?,
            "The project root must be active and ready before creating a workspace."
        );
        let id = request["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(cuid2::create_id);
        anyhow::ensure!(
            owners.schemas.valid("cuid2", &json!(id))? && id != project_id,
            "A workspace cannot use its project's implicit root ID."
        );
        let name = owners
            .projects
            .validate_name(request["name"].as_str().unwrap())?;
        let parent_id = request["parentId"].as_str().unwrap_or(project_id);
        anyhow::ensure!(parent_id != id, "A workspace cannot be its own parent.");
        let parent = if parent_id == project_id {
            None
        } else {
            let parent = self
                .get(ctx, parent_id)?
                .context("The workspace parent was not found.")?;
            anyhow::ensure!(
                parent["projectRef"] == project_id,
                "A workspace parent must belong to the same project."
            );
            persistence::ancestor_ids(ctx, &owners.schemas, &parent)?;
            anyhow::ensure!(
                parent["status"] == "ready"
                    && parent["presence"] == "present"
                    && handle.block_on(owners.runners.exists(
                        parent["runnerId"].as_str(),
                        Path::new(parent["path"].as_str().unwrap()),
                        &cancel
                    ))?,
                "A workspace parent must be active, ready, and available."
            );
            Some(parent)
        };
        let base = owners
            .projects
            .validate_base_ref(request["baseRef"].as_str())?
            .or_else(|| {
                parent
                    .as_ref()
                    .and_then(|parent| parent["branch"].as_str().map(str::to_owned))
            });
        if project["worktreeSupport"] == "unknown" {
            let probe = handle.block_on(owners.git.probe(runner, path, false, &cancel))?;
            owners.projects.record_probe(ctx, project_id, &probe)?;
            project = owners
                .projects
                .get(ctx, project_id)?
                .context("The project disappeared during its probe.")?;
        }
        let kind = if project["worktreeSupport"] == "supported" {
            "git_worktree"
        } else {
            "directory"
        };
        let runner = project["runnerId"].as_str();
        let root = handle
            .block_on(owners.runners.workspaces_home(runner, &cancel))?
            .join(
                project["storageKey"]
                    .as_str()
                    .context("The project folder key is missing.")?,
            );
        // One real snapshot keeps filesystem and Git waits out of the candidate loop.
        let mut complete = true;
        let folders = match handle.block_on(owners.runners.entries(runner, &root, &cancel)) {
            Ok(entries) => entries.into_iter().collect::<BTreeSet<_>>(),
            Err(_) => {
                if handle
                    .block_on(owners.runners.exists(runner, &root, &cancel))
                    .unwrap_or(true)
                {
                    complete = false;
                }
                BTreeSet::new()
            }
        };
        let branches = if kind == "git_worktree" {
            match handle.block_on(owners.git.run(
                runner,
                Path::new(project["repositoryRef"].as_str().unwrap()),
                &["for-each-ref", "--format=%(refname)", "refs/heads"],
                &cancel,
            )) {
                Ok(list) => list.lines().map(str::to_owned).collect::<BTreeSet<_>>(),
                Err(_) => {
                    complete = false;
                    BTreeSet::new()
                }
            }
        } else {
            BTreeSet::new()
        };
        let seed = if complete {
            workspace_identity::storage_key(&name)
        } else {
            format!(
                "{}-{id}",
                owners
                    .projects
                    .storage_key_for(&name)
                    .chars()
                    .take(20)
                    .collect::<String>()
            )
        };
        if let Some(existing) = self.get(ctx, &id)? {
            anyhow::ensure!(
                existing["projectRef"] == project_id
                    && existing["parentId"] == parent_id
                    && existing["kind"] == kind
                    && existing.get("runnerId") == project.get("runnerId")
                    && existing["subtaskAgentId"].as_str() == subtask,
                "That workspace identity already belongs to another reservation."
            );
            anyhow::ensure!(
                existing["nameConfigured"]
                    == request
                        .get("nameConfigured")
                        .cloned()
                        .unwrap_or(json!(false)),
                "That workspace identity was configured differently."
            );
            if existing["version"] == 1 || base.is_some() {
                anyhow::ensure!(
                    existing["baseRef"].as_str() == base.as_deref(),
                    "That workspace identity names another base."
                );
            }
            let existing_name = existing["name"].as_str().unwrap();
            let stripped = regex_lite::Regex::new(r" \(\d+\)$")?.replace(existing_name, "");
            anyhow::ensure!(
                workspace_identity::name_key(existing_name) == workspace_identity::name_key(&name)
                    || workspace_identity::name_key(&stripped)
                        == workspace_identity::name_key(&name),
                "That workspace identity names another workspace."
            );
            if let Some(creator) = creator {
                anyhow::ensure!(
                    existing["creatorSessionId"] == creator,
                    "That workspace identity belongs to another creator."
                );
            }
            return Ok(Some(existing));
        }
        let rows = persistence::project_workspaces(ctx, &owners.schemas, project_id)?;
        let name = workspace_identity::unique(&name, 500, true, |name| {
            rows.iter().any(|row| {
                workspace_identity::name_key(row["name"].as_str().unwrap())
                    == workspace_identity::name_key(name)
            })
        })?;
        let storage = workspace_identity::unique(&seed, 128, false, |key| {
            rows.iter().any(|row| {
                row["storageKey"]
                    .as_str()
                    .unwrap()
                    .eq_ignore_ascii_case(key)
            }) || folders.contains(key)
                || branches.contains(&format!("refs/heads/worktree/{key}"))
        })?;
        let branch = workspace_identity::unique(
            &format!(
                "worktree/{}",
                workspace_identity::storage_key(if complete { &name } else { &seed })
            ),
            512,
            false,
            |branch| {
                rows.iter().any(|row| row["branch"] == branch)
                    || branches.contains(&format!("refs/heads/{branch}"))
            },
        )?;
        let first = rows
            .iter()
            .filter(|row| row["parentId"] == parent_id)
            .filter_map(|row| row["orderKey"].as_str())
            .min();
        let at = now();
        let mut row = json!({"id":id,"projectRef":project_id,"parentId":parent_id,"name":name,"branch":branch,"storageKey":storage,"kind":kind,"path":root.join(&storage),"presence":"missing","status":"initializing","orderKey":workspace_identity::between(None,first)?,"version":1,"gitAhead":0,"gitBehind":0,"gitDetached":false,"initializationAttempt":1,"createdAt":at,"updatedAt":at});
        row["nameConfigured"] = request
            .get("nameConfigured")
            .cloned()
            .unwrap_or(json!(false));
        for field in ["runnerId"] {
            if let Some(value) = project.get(field) {
                row[field] = value.clone();
            }
        }
        let settings = owners.projects.read_settings(ctx, project_id)?;
        if settings["defaultWorkspaceCompute"]["type"] == "docker" {
            row["dockerImage"] = settings["defaultWorkspaceCompute"]["image"].clone();
        }
        if let Some(base) = base {
            row["baseRef"] = json!(base);
        }
        if let Some(creator) = creator {
            row["creatorSessionId"] = json!(creator);
        }
        if let Some(subtask) = subtask {
            row["subtaskAgentId"] = json!(subtask);
        }
        Ok(Some(self.reserve(ctx, &row)?))
    }
    pub fn attach_subtask_agent(
        &self,
        ctx: &Context<'_>,
        workspace: &str,
        agent: &str,
    ) -> Result<Value> {
        self.attach_agent_catalog(ctx, workspace, agent, true)
    }
    pub fn attach_agent(&self, ctx: &Context<'_>, workspace: &str, agent: &str) -> Result<Value> {
        self.attach_agent_catalog(ctx, workspace, agent, false)
    }
    fn attach_agent_catalog(
        &self,
        ctx: &Context<'_>,
        workspace: &str,
        agent: &str,
        subtask: bool,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        self.assert_catalog_enabled()?;
        let owners = self.owners()?;
        anyhow::ensure!(
            owners.schemas.valid(
                "ownerWorkspaceAgentAttachment",
                &json!({"workspaceId":workspace,"agentId":agent})
            )?,
            "The workspace agent attachment is invalid."
        );
        let parent = self.runtime.parent_of(ctx, agent)?;
        if subtask {
            anyhow::ensure!(
                parent.is_some(),
                "A workspace subtask must have a parent agent."
            );
        } else {
            anyhow::ensure!(
                parent.is_none(),
                "Only a top-level agent can be attached to a workspace."
            );
        }
        let before = self
            .get(ctx, workspace)?
            .context("The workspace was not found.")?;
        persistence::ancestor_ids(ctx, &owners.schemas, &before)?;
        if subtask {
            anyhow::ensure!(
                before["subtaskAgentId"] == agent,
                "This workspace is not reserved for that subtask."
            );
        }
        anyhow::ensure!(
            before["status"] != "archiving" && before["status"] != "archived",
            "The workspace is being archived, so no agent can be attached."
        );
        if let Some((current, key)) = persistence::agent_association(ctx, agent)? {
            anyhow::ensure!(
                current == workspace,
                "The agent is already attached to another workspace."
            );
            return Ok(json!({"workspaceId":workspace,"agentId":agent,"orderKey":key}));
        }
        let key = workspace_identity::between(
            persistence::last_agent_order(ctx, workspace)?.as_deref(),
            None,
        )?;
        let association = json!({"workspaceId":workspace,"agentId":agent,"orderKey":key});
        anyhow::ensure!(
            owners
                .schemas
                .valid("ownerWorkspaceAgentAssociation", &association)?,
            "The workspace association is invalid."
        );
        persistence::attach(ctx, workspace, agent, &key)?;
        let mut after = before.clone();
        after["version"] = json!(before["version"].as_u64().unwrap() + 1);
        after["updatedAt"] = json!(now().max(before["updatedAt"].as_u64().unwrap() + 1));
        let after = persistence::write(ctx, &owners.schemas, &before, &after)?;
        self.observe(ctx,json!({"type":"workspace_agent_attached","association":association,"workspace":after,"previousWorkspace":before}))?;
        Ok(association)
    }
}
