use super::*;

const SHARED: &str = "kv.modules.titles";

impl TitlesModule {
    fn generated(&self, ctx: &Context<'_>, agent: &str, title: &str) -> Result<bool> {
        let Some(record) = ctx.value("", &format!("{SHARED}.generated-titles.{agent}"))? else {
            return Ok(false);
        };
        Ok(self.schemas.valid("ownerTitleGeneratedRecord", &record)? && record["title"] == title)
    }
    fn record_generated(&self, ctx: &Context<'_>, agent: &str, title: &str) -> Result<()> {
        let record = json!({"title":title});
        anyhow::ensure!(
            self.schemas.valid("ownerTitleGeneratedRecord", &record)?,
            "Generated title is invalid."
        );
        ctx.put_value("", &format!("{SHARED}.generated-titles.{agent}"), &record)
    }
    pub fn workspace_was_named(&self, ctx: &Context<'_>, workspace: &str) -> Result<bool> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas
                .valid("ownerTitleWorkspaceId", &json!(workspace))?,
            "Workspace ID is invalid."
        );
        Ok(ctx
            .value("", &format!("{SHARED}.named.{workspace}"))?
            .is_some())
    }
    pub fn mark_workspace_named(&self, ctx: &Context<'_>, workspace: &str) -> Result<()> {
        self.workspace_was_named(ctx, workspace)?;
        ctx.put_value(
            "",
            &format!("{SHARED}.named.{workspace}"),
            &json!({"at":crate::product::identity::now()}),
        )
    }
    fn enqueue(
        self: &Arc<Self>,
        agent: String,
        provider: Option<String>,
        text: String,
        refine: bool,
    ) {
        if self.lifetime.is_cancelled() {
            return;
        }
        let mut tasks = self
            .tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        tasks.retain(|_, task| !task.is_finished());
        // Each agent can contribute only its first and second user message. Completed
        // handles are reaped and the installation bounds independently active requests.
        if tasks.len() >= 10000 && !tasks.contains_key(&agent) {
            tracing::debug!(agent_id=%agent,"Optional naming work exceeded its installation bound.");
            return;
        }
        let previous = tasks.remove(&agent);
        let owner = self.clone();
        let id = agent.clone();
        let task = tokio::spawn(async move {
            if let Some(previous) = previous {
                let _ = previous.await;
            }
            if owner.lifetime.is_cancelled() {
                return;
            }
            let result = if refine {
                owner.refine_agent(&id, provider.as_deref(), &text).await
            } else {
                owner.name_agent(&id, provider.as_deref(), &text).await
            };
            if let Err(error) = result {
                tracing::debug!(agent_id=%id,%error,"Optional agent naming did not happen.");
            }
        });
        tasks.insert(agent, task);
    }
    fn workspace_for_agent(&self, ctx: &Context<'_>, agent: &str) -> Result<Option<Value>> {
        let mut current = agent.to_owned();
        for _ in 0..64 {
            if let Some((workspace, _)) = self.workspaces.agent_association(ctx, &current)? {
                return self.workspaces.get(ctx, &workspace);
            }
            let Some(parent) = self.runtime.parent_of(ctx, &current)? else {
                return Ok(None);
            };
            current = parent;
        }
        anyhow::bail!("The agent ancestry exceeds the supported depth.")
    }
    async fn name_agent(
        self: &Arc<Self>,
        agent: &str,
        provider: Option<&str>,
        message: &str,
    ) -> Result<()> {
        let owner = self.clone();
        let id = agent.to_owned();
        let (configuration,workspace)=self.runtime.transact(move|ctx|{
            let configuration=owner.agents.configuration(ctx,&id)?;
            let workspace=match owner.workspace_for_agent(ctx,&id) {
                Ok(Some(workspace)) if workspace["nameConfigured"]!=true && !owner.workspace_was_named(ctx,workspace["id"].as_str().unwrap())?=>Some(workspace),
                Ok(_)=>None,
                Err(error)=>{tracing::debug!(agent_id=%id,%error,"The workspace for first-message naming could not be resolved.");None},
            };
            Ok((configuration,workspace))
        }).await?;
        let Some(configuration) = configuration else {
            return Ok(());
        };
        let want_title = configuration["metadata"]["title"].as_str().is_none();
        if !want_title && workspace.is_none() {
            return Ok(());
        }
        let mut request = json!({"firstMessage":message,"wanted":{"slug":workspace.is_some(),"title":want_title}});
        if let Some(provider) = provider {
            request["providerId"] = json!(provider);
        }
        let names = self.suggest_names(&request, &self.lifetime).await?;
        if self.lifetime.is_cancelled() {
            return Ok(());
        }
        let owner = self.clone();
        let id = agent.to_owned();
        self.runtime
            .transact(move |ctx| {
                if let (Some(workspace), Some(slug)) = (workspace, names["slug"].as_str()) {
                    let workspace_id = workspace["id"].as_str().unwrap();
                    let name = owner
                        .workspaces
                        .name_with_preserved_prefix(workspace["name"].as_str().unwrap(), slug);
                    owner.workspaces.inherit_name(ctx, workspace_id, &name)?;
                    owner.mark_workspace_named(ctx, workspace_id)?;
                }
                if let Some(title) = names["title"].as_str() {
                    if let Some(latest) = owner.agents.configuration(ctx, &id)? {
                        if latest["metadata"]["title"].as_str().is_none() {
                            owner
                                .agents
                                .update_metadata(ctx, &id, &json!({"title":title}))?;
                            owner.record_generated(ctx, &id, title)?;
                        }
                    }
                }
                Ok(())
            })
            .await
    }
    async fn refine_agent(
        self: &Arc<Self>,
        agent: &str,
        provider: Option<&str>,
        transcript: &str,
    ) -> Result<()> {
        let owner = self.clone();
        let id = agent.to_owned();
        let current = self
            .runtime
            .transact(move |ctx| {
                let Some(configuration) = owner.agents.configuration(ctx, &id)? else {
                    return Ok(None);
                };
                let title = configuration["metadata"]["title"]
                    .as_str()
                    .map(str::to_owned);
                if let Some(title) = title.as_deref() {
                    if !owner.generated(ctx, &id, title)? {
                        return Ok(None);
                    }
                }
                Ok(Some(title))
            })
            .await?;
        let Some(current) = current else {
            return Ok(());
        };
        let mut request = json!({"transcript":transcript});
        if let Some(current) = current.as_deref() {
            request["currentTitle"] = json!(current);
        }
        if let Some(provider) = provider {
            request["providerId"] = json!(provider);
        }
        let Some(title) = self.refine_chat(&request, &self.lifetime).await? else {
            return Ok(());
        };
        if self.lifetime.is_cancelled() || current.as_deref() == Some(&title) {
            return Ok(());
        }
        let owner = self.clone();
        let id = agent.to_owned();
        self.runtime
            .transact(move |ctx| {
                let Some(latest) = owner.agents.configuration(ctx, &id)? else {
                    return Ok(());
                };
                if latest["metadata"]["title"].as_str() != current.as_deref() {
                    return Ok(());
                }
                owner
                    .agents
                    .update_metadata(ctx, &id, &json!({"title":title}))?;
                owner.record_generated(ctx, &id, &title)
            })
            .await
    }
}

#[async_trait]
impl AgentModule for TitlesModule {
    fn name(&self) -> &'static str {
        "titles"
    }
    fn accepted(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        inputs: &[AcceptedInput],
        _steering: bool,
    ) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        for accepted in inputs {
            if accepted.input["message"]["role"] != "user" {
                continue;
            }
            let text = accepted.input["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|block| block["type"] == "text")
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_owned();
            if text.is_empty() {
                continue;
            }
            let key = format!("kv.{}.module.titles.title-user-messages", scope.id);
            let stored = ctx.value(scope.id, &key)?.unwrap_or(Value::Null);
            let count = if self.schemas.valid("ownerTitleUserMessageCount", &stored)? {
                stored.as_u64().unwrap()
            } else {
                0
            };
            if count >= 2 {
                continue;
            }
            let next = count + 1;
            ctx.put_value(scope.id, &key, &json!(next))?;
            let text = if next == 2 {
                if let Some(title) = scope.configuration["metadata"]["title"].as_str() {
                    if !self.generated(ctx, scope.id, title)? {
                        continue;
                    }
                }
                let excerpt = match self.history.read_excerpt(ctx, scope.id, 12000) {
                    Ok(excerpt) => excerpt,
                    Err(error) => {
                        tracing::debug!(agent_id=%scope.id,%error,"History could not be read for title refinement.");
                        continue;
                    }
                };
                let Some(excerpt) = excerpt else { continue };
                let text = [
                    excerpt["beginning"].as_str().unwrap_or(""),
                    excerpt["recent"].as_str().unwrap_or(""),
                ]
                .into_iter()
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
                if text.is_empty() {
                    continue;
                }
                text
            } else {
                text
            };
            let owner = self.owner.clone();
            let id = scope.id.to_owned();
            let provider = scope.settings["provider"].as_str().map(str::to_owned);
            ctx.after_commit(move || {
                if let Some(owner) = owner.upgrade() {
                    owner.enqueue(id, provider, text, next == 2);
                }
            })?;
        }
        Ok(())
    }
    async fn close(&self) {
        TitlesModule::close(self).await;
    }
}
