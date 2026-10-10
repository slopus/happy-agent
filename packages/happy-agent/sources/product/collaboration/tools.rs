use super::*;
fn definitions() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("tool_definitions.json"))
        .expect("The captured original collaboration tool array is valid.")
}
pub fn definition(call: &Value) -> Option<ToolDefinition> {
    definitions().into_iter().find(|definition| {
        call["call"]["name"] == definition.name
            && call["call"]["namespace"].as_str() == definition.namespace.as_deref()
    })
}
impl CollaborationModule {
    pub(super) fn collaboration_tools(&self, _scope: &AgentScope<'_>) -> Vec<ToolDefinition> {
        let mut tools = definitions();
        let limits = self.config.collaboration_limits();
        if let Some(tool) = tools.iter_mut().find(|tool| tool.name == "create_agent") {
            let available = self
                .available_models()
                .unwrap_or_default()
                .iter()
                .map(|model| {
                    format!(
                        "- {} + {} ({}; effort: {}{})",
                        model["providerId"].as_str().unwrap_or_default(),
                        model["id"].as_str().unwrap_or_default(),
                        model["name"].as_str().unwrap_or_default(),
                        model["effortLevels"]
                            .as_array()
                            .into_iter()
                            .flatten()
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
                .collect::<Vec<_>>();
            let mut lines = vec![
                "Create a hidden collaborator for internal work, such as research. Bots and subtasks use create_subtask only for substantial, distinct workstreams (e.g. changes across projects) or explicit subtask requests, within eligibility and depth limits. Handle small steps inline. Usually create second-level subtasks only on explicit user request.".to_owned(),
                String::new(),
                "The collaborator works on its own. This call returns as soon as the task is delivered, and anything the collaborator has to say arrives later as a message — nothing here waits for it.".to_owned(),
                format!("One root agent tree may contain at most {} ordinary collaborators. Reuse one with send_agent_message after reaching the limit. The maximum depth is {} agents including the root.", limits.max_collaborators, limits.max_collaboration_depth),
                "Choose an exact model and effort. Omitting provider uses your current provider when it serves that model; otherwise provider is optional only when the model ID is unambiguous. This is the only chance to choose: a collaborator's model, effort, and permissions cannot be changed afterwards.".to_owned(),
            ];
            if !available.is_empty() {
                lines.push("Available model/provider pairs:".to_owned());
                lines.extend(available);
            }
            tool.description = lines.join("\n");
        }
        if !self.config.collaboration_limits().cross_workspace {
            if let Some(tool) = tools
                .iter_mut()
                .find(|tool| tool.name == "send_agent_message")
            {
                tool.description="Send a message to a collaborator you created, or back to the agent that created you.\n\nMessages are one-way and steer the recipient's active turn in either direction. This returns as soon as the message is delivered, and there is nothing to wait on.".to_owned();
            }
        }
        tools
    }
    pub(super) fn execute_collaboration_tool(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        let definition = definition(call)?;
        Some((|| {
            let input: Value = serde_json::from_str(
                call["call"]["arguments"]
                    .as_str()
                    .context("The collaboration tool arguments are missing.")?,
            )?;
            anyhow::ensure!(
                self.schemas
                    .valid(&format!("ownerTool_{}", definition.name), &input)?,
                "The collaboration tool arguments are invalid."
            );
            let id = call["id"]
                .as_str()
                .context("The collaboration tool identity is missing.")?;
            let text = match definition.name.as_str() {
                "create_agent" => {
                    self.create_tool_agent(
                        ctx,
                        scope.id,
                        &input,
                        id,
                        scope.settings["provider"].as_str(),
                    )?;
                    format!(
                        "Created collaborator {id} and sent it the task. Anything it has to say will arrive as a message; nothing is waiting on it."
                    )
                }
                "send_agent_message" => {
                    self.send_message(ctx, scope.id, &input, id)?;
                    "Message delivered. Any answer arrives as a message; carry on with other work in the meantime.".to_owned()
                }
                "interrupt_agent" => {
                    self.interrupt_agent(ctx, scope.id, input["targetAgentId"].as_str().unwrap())?;
                    "Aborted the collaborator and every running descendant immediately. Nothing waits for them to settle, and they remain available for follow-up work.".to_owned()
                }
                _ => anyhow::bail!("The collaboration tool is unavailable."),
            };
            Ok(Message::Tool {
                call_id: id.to_owned(),
                content: vec![Block::text(text)],
                is_error: false,
                vendor: None,
            })
        })())
    }
}
