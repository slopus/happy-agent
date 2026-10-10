//! Docker file calls retain the exact native vendor result and commit their
//! knowledge in the daemon's owning final-result transaction.
use super::*;
impl ToolsModule {
    pub(super) async fn prepare_docker_policy(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
    ) -> Result<()> {
        if scope.configuration["modules"]["compute"]
            .get("docker")
            .is_none()
            || scope.configuration["modules"]["compute"]["runnerId"].is_string()
        {
            return Ok(());
        };
        let Some(tool) = self.definition_for(scope.settings, call)? else {
            return Ok(());
        };
        if !matches!(
            tool.implementation,
            Implementation::ReadFile
                | Implementation::WriteFile
                | Implementation::EditFile
                | Implementation::Glob
                | Implementation::Grep
                | Implementation::ListDirectory
                | Implementation::ApplyPatch
                | Implementation::ViewImage
                | Implementation::KimiMedia
        ) {
            return Ok(());
        };
        let key = (
            scope.id.to_owned(),
            call["id"]
                .as_str()
                .context("The file operation identity is missing.")?
                .to_owned(),
        );
        {
            let mut policies = self
                .docker_policies
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            ensure!(
                policies.len() < 64,
                "The bounded container file policy catalog is full."
            );
            policies.insert(key.clone(), Value::Null);
        }
        let cancel = self.lifecycle.shutdown.child_token();
        let _cancel_on_return = cancel.clone().drop_guard();
        let result=tokio::time::timeout(std::time::Duration::from_secs(60),async {
            let compute=self.docker.agent_compute(scope.id,scope.configuration,&cancel).await?;
            compute.file_policy(json!({"computeId":"pending","agent":scope.id,"vendor":tool.vendor.unwrap().as_str(),"mode":self.mode(scope.settings)?,"call":call,"reads":[]}),&cancel).await
        }).await.context("The container permission inspection did not complete in time.").and_then(|result|result).and_then(|value| {
            ensure!(value["requires"]==false && value["full"]==value["review"],"The container returned inconsistent native file policy facts.");Ok(value)
        });
        let mut policies = self
            .docker_policies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match result {
            Ok(value) => {
                // The peer supplies canonical path facts, never authorization. These
                // fixed native file definitions own review and temporary elevation;
                // the agent loop still decides and supplies the actual execution mode.
                let policy = json!({"call":call,"compute":scope.configuration["modules"]["compute"],"vendor":tool.vendor.unwrap().as_str(),"policy":value});
                policies.insert(key, policy);
                Ok(())
            }
            Err(error) => {
                policies.remove(&key);
                Err(error)
            }
        }
    }
    pub fn container_file_policy(&self, configuration: &Value, params: &Value) -> Result<Value> {
        ensure!(
            self.schemas
                .valid("ownerRunnerParams_compute_filePolicy", params)?,
            "The container file policy request is invalid."
        );
        let vendor = params["vendor"].as_str().unwrap();
        let call = &params["call"];
        let tool = self
            .vendor
            .iter()
            .find(|set| set.vendor.as_str() == vendor)
            .and_then(|set| {
                set.ordinary.iter().find(|tool| {
                    call["call"]["name"] == tool.definition.name
                        && call["call"]["namespace"].as_str()
                            == tool.definition.namespace.as_deref()
                })
            })
            .context("The requested vendor file tool is unavailable.")?;
        ensure!(
            matches!(
                tool.implementation,
                Implementation::ReadFile
                    | Implementation::WriteFile
                    | Implementation::EditFile
                    | Implementation::Glob
                    | Implementation::Grep
                    | Implementation::ListDirectory
                    | Implementation::ApplyPatch
                    | Implementation::ViewImage
                    | Implementation::KimiMedia
            ),
            "This operation requires a native file tool definition."
        );
        let settings = json!({"permissionMode":params["mode"]});
        let policy = self.surface_policy(
            &happy_agent_base::AgentScope {
                id: params["agent"].as_str().unwrap(),
                configuration: &configuration,
                settings: &settings,
            },
            call,
            tool,
        )?;
        let args = self.surface_arguments(call, tool)?;
        let bindings = if matches!(tool.implementation, Implementation::ApplyPatch) {
            let paths = self.files.patch_paths(&configuration, &args)?;
            paths
                .iter()
                .map(|path| self.files.review_binding(&configuration, path, true))
                .collect::<Result<Vec<_>>>()?
        } else {
            let path = if vendor == "kimi"
                || matches!(
                    tool.implementation,
                    Implementation::ViewImage | Implementation::Glob | Implementation::Grep
                ) {
                args["path"].as_str().unwrap_or(".")
            } else if matches!(tool.implementation, Implementation::ListDirectory) {
                args["target_directory"].as_str().unwrap()
            } else if vendor == "grok" && matches!(tool.implementation, Implementation::ReadFile) {
                args["target_file"].as_str().unwrap()
            } else {
                args["file_path"].as_str().unwrap()
            };
            vec![self.files.review_binding(
                &configuration,
                path,
                matches!(
                    tool.implementation,
                    Implementation::WriteFile | Implementation::EditFile
                ),
            )?]
        };
        Ok(
            json!({"review":policy.should_review_in_auto_mode,"full":policy.should_run_in_full_access_in_auto_mode,"requires":policy.requires_auto_or_full_access,"action":format!("{}. Execution environment: the selected Docker container. Canonical paths: {}",policy.action,json!(bindings)),"instructions":policy.instructions,"bindings":bindings}),
        )
    }
    pub(super) async fn docker_file_tool(
        &self,
        agent: &str,
        configuration: &Value,
        mode: &str,
        call: &Value,
        tool: &NativeTool,
        cancel: &CancellationToken,
    ) -> Result<(Vec<Block>, bool)> {
        let id = agent.to_owned();
        let reads = self
            .runtime
            .transact(move |ctx| {
                Ok(ctx
                    .value(&id, &format!("kv.{id}.module.compute.reads"))?
                    .unwrap_or(json!([])))
            })
            .await?;
        ensure!(
            self.schemas.valid("computeFileReadLog", &reads)?,
            "The stored file read knowledge is invalid."
        );
        let key = (
            agent.to_owned(),
            call["id"]
                .as_str()
                .context("The file operation identity is missing.")?
                .to_owned(),
        );
        {
            let mut prepared = self
                .prepared_reads
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            ensure!(
                prepared.len() < 64 && !prepared.contains_key(&key),
                "The bounded file operation catalog is full or this operation is already executing."
            );
            prepared.insert(
                key.clone(),
                PreparedFile {
                    reads: Vec::new(),
                    presentation: None,
                },
            );
        }
        let result=async {
            let compute=self.docker.agent_compute(agent,configuration,cancel).await?;
            let cached=self.docker_policies.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&key).cloned();
            ensure!(cached.as_ref().is_some_and(|cached|cached["call"]==*call && cached["compute"]==configuration["modules"]["compute"]),"The file operation changed after permission inspection.");
            let bindings=cached.map(|cached|cached["policy"]["bindings"].clone());
            ensure!(bindings.is_some(),"The Docker file operation has no bound permission inspection.");
            let answer=compute.file_tool(json!({"computeId":"pending","agent":agent,"vendor":tool.vendor.unwrap().as_str(),"mode":mode,"call":call,"reads":reads,"bindings":bindings}),cancel).await?;
            let blocks:Vec<Block>=serde_json::from_value(answer["blocks"].clone())?;
            let staged=PreparedFile {reads:answer["reads"].as_array().unwrap().clone(),presentation:answer.get("presentation").cloned()};
            if let Some(slot)=self.prepared_reads.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get_mut(&key) {*slot=staged;}
            Ok((blocks,answer["isError"].as_bool().unwrap()))
        }.await;
        if result.is_err() {
            self.prepared_reads
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&key);
        }
        result
    }
    pub async fn container_file_tool(
        &self,
        configuration: &Value,
        params: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        ensure!(
            self.schemas
                .valid("ownerRunnerParams_compute_fileTool", params)?,
            "The container file operation is invalid."
        );
        let vendor = params["vendor"].as_str().unwrap();
        let call = &params["call"];
        let tool = self
            .vendor
            .iter()
            .find(|set| set.vendor.as_str() == vendor)
            .and_then(|set| {
                set.ordinary.iter().find(|tool| {
                    call["call"]["name"] == tool.definition.name
                        && call["call"]["namespace"].as_str()
                            == tool.definition.namespace.as_deref()
                })
            })
            .context("The requested vendor file tool is unavailable.")?;
        ensure!(
            matches!(
                tool.implementation,
                Implementation::ReadFile
                    | Implementation::WriteFile
                    | Implementation::EditFile
                    | Implementation::Glob
                    | Implementation::Grep
                    | Implementation::ListDirectory
                    | Implementation::ApplyPatch
                    | Implementation::ViewImage
                    | Implementation::KimiMedia
            ),
            "This operation requires a native file tool definition."
        );
        let agent = params["agent"].as_str().unwrap().to_owned();
        let reads = params["reads"].clone();
        let id = agent.clone();
        self.runtime
            .transact(move |ctx| {
                ctx.put_value(&id, &format!("kv.{id}.module.compute.reads"), &reads)
            })
            .await?;
        let mut configuration = configuration.clone();
        if let Some(bindings) = params.get("bindings") {
            configuration["_dockerReviewedPaths"] = bindings.clone();
        }
        let settings = json!({"permissionMode":params["mode"]});
        let outcome = self
            .execute_surface(
                &agent,
                &configuration,
                &settings,
                call,
                tool,
                cancel.clone(),
            )
            .await;
        let Message::Tool {
            content, is_error, ..
        } = outcome.message
        else {
            unreachable!()
        };
        let prepared = self
            .prepared_reads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&(agent, call["id"].as_str().unwrap().to_owned()));
        let mut answer = json!({"blocks":content,"isError":is_error,"reads":prepared.as_ref().map(|prepared|prepared.reads.clone()).unwrap_or_default()});
        if let Some(presentation) = prepared.and_then(|prepared| prepared.presentation) {
            answer["presentation"] = presentation;
        }
        ensure!(
            self.schemas
                .valid("ownerRunnerResult_compute_fileTool", &answer)?,
            "The container file operation result is invalid."
        );
        Ok(answer)
    }
}
