use super::*;
fn definitions() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("tool_definitions.json"))
        .expect("The original subtask tool array is valid.")
}
pub fn definition(call: &Value) -> Option<ToolDefinition> {
    definitions().into_iter().find(|definition| {
        call["call"]["name"] == definition.name
            && call["call"]["namespace"].as_str() == definition.namespace.as_deref()
    })
}
fn message(call: &Value, text: String, is_error: bool) -> Message {
    Message::Tool {
        call_id: call["id"].as_str().unwrap_or_default().to_owned(),
        content: vec![Block::text(text)],
        is_error,
        vendor: None,
    }
}
impl SubtasksModule {
    pub(super) fn subtask_tools(&self, _scope: &AgentScope<'_>) -> Vec<ToolDefinition> {
        let mut definitions = definitions();
        if let Some(create) = definitions
            .iter_mut()
            .find(|definition| definition.name == "create_subtask")
        {
            let models = self
                .collaboration
                .available_models()
                .unwrap_or_default()
                .iter()
                .map(|model| {
                    format!(
                        "- {} + {} ({}; effort: {}{})",
                        model["providerId"].as_str().unwrap(),
                        model["id"].as_str().unwrap(),
                        model["name"].as_str().unwrap(),
                        model["effortLevels"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", "),
                        model["serviceTiers"]
                            .as_array()
                            .map(|tiers| format!(
                                "; tiers: {}",
                                tiers
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ))
                            .unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            create.description.push_str(&models);
        }
        definitions
    }
    fn arguments(&self, call: &Value) -> Result<Value> {
        let definition = definition(call).context("The subtask tool is unavailable.")?;
        let args: Value = serde_json::from_str(
            call["call"]["arguments"]
                .as_str()
                .context("The subtask tool arguments are missing.")?,
        )?;
        anyhow::ensure!(
            self.schemas
                .valid(&format!("ownerTool_{}", definition.name), &args)?,
            "The subtask tool arguments are invalid."
        );
        Ok(args)
    }
    pub(super) fn execute_archive_tool(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        if definition(call)?.name != "archive_subtask" {
            return None;
        }
        Some((|| {
            let args = self.arguments(call)?;
            let id = args["agentId"].as_str().unwrap();
            self.archive(ctx, scope.id, id)?;
            Ok(message(
                call,
                format!(
                    "Archived subtask {id} together with its own workspace, if it had one. Its conversation history is preserved; descendants were stopped, not archived."
                ),
                false,
            ))
        })())
    }
    pub(super) async fn execute_create_tool(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        if definition(call)?.name != "create_subtask" {
            return None;
        }
        let operation=async{let input=self.arguments(call)?;let owner=self.owner.upgrade().context("The subtasks module was closed.")?;let call_id=call["id"].as_str().context("The subtask tool identity is missing.")?.to_owned();let actor=scope.id.to_owned();let needs_workspace=input.get("workspace").is_some();let module=owner.clone();let (id,workspace)=self.runtime.transact(move|ctx|{let id_key=format!("kv.{actor}.call.{call_id}.agentId");let id=if let Some(id)=ctx.value(&actor,&id_key)?{module.assert_id(id.as_str().context("The retained subtask identity is invalid.")?)?;id}else{let id=json!(cuid2::create_id());ctx.put_value(&actor,&id_key,&id)?;id};let workspace=if needs_workspace{let key=format!("kv.{actor}.call.{call_id}.workspaceId");let value=if let Some(value)=ctx.value(&actor,&key)?{module.assert_id(value.as_str().context("The retained workspace identity is invalid.")?)?;value}else{let value=json!(cuid2::create_id());ctx.put_value(&actor,&key,&value)?;value};Some(value.as_str().unwrap().to_owned())}else{None};Ok((id.as_str().unwrap().to_owned(),workspace))}).await?;
        if let Some(project)=input["workspace"]["projectId"].as_str(){let module=owner.clone();let project=project.to_owned();let project=self.runtime.transact(move|ctx|module.workspaces.project_for_creation(ctx,&project)).await?.context("The subtask's project was not found.")?;self.workspaces.prepare_creation(&project,&cancel).await?;}
        anyhow::ensure!(!cancel.is_cancelled(),"The subtask creation was cancelled.");let actor=scope.id.to_owned();let provider=scope.settings["provider"].as_str().map(str::to_owned);let created=self.runtime.transact(move|ctx|owner.create(ctx,&actor,&input,&id,workspace.as_deref(),provider.as_deref())).await?;let id=created["agentId"].as_str().unwrap();Ok::<_,anyhow::Error>(format!("Created subtask {id}{}. It runs independently; use send_agent_message to coordinate with it.",created["workspaceId"].as_str().map(|workspace|format!(" in workspace {workspace}")).unwrap_or_else(||" sharing your filesystem".to_owned())))}.await;
        Some(match operation {
            Ok(text) => message(call, text, false),
            Err(error) => message(call, error.to_string(), true),
        })
    }
}
