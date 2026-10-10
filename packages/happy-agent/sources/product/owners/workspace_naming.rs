use super::*;

pub(super) struct Rename {
    pub owner: Weak<WorkspacesModule>,
}

impl WorkspacesModule {
    pub fn name_with_preserved_prefix(&self, current: &str, generated: &str) -> String {
        let expression = regex_lite::Regex::new(r"^\d{1,4}[-_ ]+")
            .expect("The original numeric prefix expression is valid.");
        expression.find(current).map_or_else(
            || generated.to_owned(),
            |prefix| format!("{}{generated}", prefix.as_str()),
        )
    }
    pub fn inherit_name(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        id: &str,
        requested: &str,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let owners = self.owners()?;
        anyhow::ensure!(
            owners.schemas.valid(
                "ownerWorkspaceInheritName",
                &json!({"workspaceId":id,"name":requested})
            )?,
            "Workspace workspace name inheritance input is invalid."
        );
        self.rename_catalog(ctx, id, requested, None, true)
    }
    pub(super) fn rename_catalog(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        id: &str,
        requested: &str,
        expected: Option<u64>,
        inherit: bool,
    ) -> Result<Value> {
        let owners = self.owners()?;
        let before = self.required_version(ctx, id, expected)?;
        persistence::ancestor_ids(ctx, &owners.schemas, &before)?;
        if (inherit && before["nameConfigured"] == true)
            || ["archiving", "archived"]
                .iter()
                .any(|status| before["status"] == *status)
        {
            return Ok(before);
        }
        let requested = requested.to_owned();
        let others = persistence::project_workspaces(
            ctx,
            &owners.schemas,
            before["projectRef"].as_str().unwrap(),
        )?
        .into_iter()
        .filter(|workspace| workspace["id"] != id)
        .collect::<Vec<_>>();
        let name = workspace_identity::unique(&requested, 500, true, |candidate| {
            others.iter().any(|other| {
                workspace_identity::name_key(other["name"].as_str().unwrap())
                    == workspace_identity::name_key(candidate)
            })
        })?;
        let project = owners
            .projects
            .get(ctx, before["projectRef"].as_str().unwrap())?
            .context("The workspace project was not found.")?;
        let handle = tokio::runtime::Handle::current();
        let cancel = CancellationToken::new();
        let refs = if project["worktreeSupport"] == "supported" {
            handle
                .block_on(owners.git.run(
                    project["runnerId"].as_str(),
                    Path::new(project["repositoryRef"].as_str().unwrap()),
                    &["for-each-ref", "--format=%(refname)", "refs/heads"],
                    &cancel,
                ))?
                .lines()
                .map(str::to_owned)
                .collect::<BTreeSet<_>>()
        } else {
            BTreeSet::new()
        };
        let branch = workspace_identity::unique(
            &format!("worktree/{}", workspace_identity::storage_key(&name)),
            512,
            false,
            |candidate| {
                candidate != before["branch"].as_str().unwrap()
                    && (others.iter().any(|other| other["branch"] == candidate)
                        || refs.contains(&format!("refs/heads/{candidate}")))
            },
        )?;
        let mut after = before.clone();
        after["name"] = json!(name);
        after["branch"] = json!(branch);
        if !inherit {
            after["nameConfigured"] = json!(true);
        }
        if before["name"] != after["name"] {
            self.write_event(
                ctx,
                &before,
                &mut after,
                json!({"type":"workspace_renamed","previousName":before["name"]}),
            )?;
        } else {
            self.store_row(ctx, &before, &mut after)?;
        }
        if before["branch"] != after["branch"]
            && after["status"] == "ready"
            && after["gitCommonDir"].is_string()
        {
            owners.durable.invoke(ctx,&json!({"function":"workspaces.rename","arguments":{"workspaceId":id,"from":before["branch"],"to":after["branch"]},"operationId":format!("workspace-rename.{id}.{}",after["version"]),"lockKeys":[format!("workspace.{id}")]}))?;
        }
        Ok(after)
    }
}

impl DurableFunction for Rename {
    fn execute(
        self: Arc<Self>,
        call: Value,
        _kv: CallKv,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            let owner = self
                .owner
                .upgrade()
                .context("The workspace module was closed.")?;
            let owners = owner.owners()?;
            let args = call["arguments"].clone();
            let id = args["workspaceId"].as_str().unwrap().to_owned();
            let Some(workspace) = owner.current(&id).await? else {
                return Ok(Value::Null);
            };
            let _lock = owners
                .git
                .project_lock(workspace["projectRef"].as_str().unwrap(), &cancel)
                .await?;
            let Some(workspace) = owner.current(&id).await? else {
                return Ok(Value::Null);
            };
            if workspace["branch"] != args["to"] || workspace["status"] != "ready" {
                return Ok(Value::Null);
            }
            let path = Path::new(workspace["path"].as_str().unwrap());
            let runner = workspace["runnerId"].as_str();
            let result = async {
                anyhow::ensure!(
                    owners.git.top_level(runner, path, &cancel).await? == path,
                    "The workspace is not the top level of its own worktree."
                );
                anyhow::ensure!(
                    owners.git.common_dir(runner, path, &cancel).await?
                        == Path::new(workspace["gitCommonDir"].as_str().unwrap()),
                    "The workspace belongs to an unexpected repository."
                );
                let current = owners
                    .git
                    .run(runner, path, &["branch", "--show-current"], &cancel)
                    .await?;
                if current == args["to"].as_str().unwrap() {
                    return Ok(());
                }
                anyhow::ensure!(
                    current == args["from"].as_str().unwrap(),
                    "The workspace is no longer on the branch the rename expected."
                );
                owners
                    .git
                    .run(
                        runner,
                        path,
                        &[
                            "branch",
                            "-m",
                            args["from"].as_str().unwrap(),
                            args["to"].as_str().unwrap(),
                        ],
                        &cancel,
                    )
                    .await?;
                Ok::<(), anyhow::Error>(())
            }
            .await;
            if cancel.is_cancelled() {
                anyhow::bail!("The workspace branch rename was cancelled.");
            }
            if let Err(error) = result {
                tracing::warn!(workspace_id=%id,%error,"The workspace was renamed, but Git kept its old branch.");
                let module = owner.clone();
                owner
                    .runtime
                    .transact(move |ctx| {
                        if let Some(before) = module.get(ctx, &id)? {
                            if before["branch"] == args["to"] && before["status"] == "ready" {
                                let mut after = before.clone();
                                after["branch"] = args["from"].clone();
                                module.write(ctx, &before, &mut after, "set_branch")?;
                            }
                        }
                        Ok(())
                    })
                    .await?;
            }
            Ok(Value::Null)
        })
    }
}
