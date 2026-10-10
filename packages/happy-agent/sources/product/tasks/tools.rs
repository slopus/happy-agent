use super::*;
use happy_providers::{Block, Message, ToolDefinition};
pub fn definitions() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("tool_definitions.json"))
        .expect("The original task tool array is valid.")
}
pub fn definition(call: &Value) -> Option<ToolDefinition> {
    definitions().into_iter().find(|tool| {
        call["call"]["name"] == tool.name
            && call["call"]["namespace"].as_str() == tool.namespace.as_deref()
    })
}
impl TasksModule {
    pub(super) fn execute_task_tool(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        let tool = definition(call)?;
        Some((|| {
            let mut input: Value = serde_json::from_str(
                call["call"]["arguments"]
                    .as_str()
                    .context("The task tool arguments are missing.")?,
            )?;
            anyhow::ensure!(
                self.schemas
                    .valid(&format!("ownerTool_{}", tool.name), &input)?,
                "The task tool arguments are invalid."
            );
            let text = match tool.name.as_str() {
                "list_tasks" => {
                    self.format_page_for_model(&self.list_page(ctx, scope.id, &input)?)?
                }
                "get_task" => {
                    let id = input["id"].as_str().unwrap().to_owned();
                    input.as_object_mut().unwrap().remove("id");
                    self.format_detail_page_for_model(&self.get_page(ctx, scope.id, &id, &input)?)?
                }
                name => {
                    let id = if name == "create_task" {
                        call["id"]
                            .as_str()
                            .context("The task call has no identity.")?
                            .to_owned()
                    } else {
                        input["id"].as_str().unwrap().to_owned()
                    };
                    let action = match name {
                        "create_task" => "created",
                        "update_task" => "updated",
                        "complete_task" => "completed",
                        "remove_task" => "removed",
                        _ => anyhow::bail!("The task tool is unavailable."),
                    };
                    let mutation = (|| -> Result<String> {
                        match name {
                            "create_task" => {
                                input["id"] = json!(id);
                                let task = self.create(ctx, scope.id, &input)?;
                                Ok(format!(
                                    "Task created: {id}\n{}",
                                    task["title"].as_str().unwrap()
                                ))
                            }
                            "update_task" => {
                                input.as_object_mut().unwrap().remove("id");
                                if input["status"] == "deleted" {
                                    require(
                                        self.remove(ctx, scope.id, &id)?,
                                        format!("Task \"{id}\" does not exist."),
                                    )?;
                                    Ok(format!("Task removed: {id}"))
                                } else {
                                    let task = self.update(ctx, scope.id, &id, &input)?;
                                    Ok(format!(
                                        "Task updated: {id}\n{}",
                                        task["title"].as_str().unwrap()
                                    ))
                                }
                            }
                            "complete_task" => {
                                let task = self.complete(ctx, scope.id, &id)?;
                                Ok(format!(
                                    "Task completed: {id}\n{}",
                                    task["title"].as_str().unwrap()
                                ))
                            }
                            "remove_task" => {
                                require(
                                    self.remove(ctx, scope.id, &id)?,
                                    format!("Task \"{id}\" does not exist."),
                                )?;
                                Ok(format!("Task removed: {id}"))
                            }
                            _ => unreachable!(),
                        }
                    })();
                    let text = match mutation {
                        Ok(text) => text,
                        Err(error) => {
                            if error.downcast_ref::<TaskValidationError>().is_none() {
                                return Err(error);
                            }
                            format!("Task {id} could not be {action}: {error}")
                        }
                    };
                    self.format_mutation_for_model(&text)
                }
            };
            Ok(Message::Tool {
                call_id: call["id"].as_str().unwrap().to_owned(),
                content: vec![Block::text(text)],
                is_error: false,
                vendor: None,
            })
        })())
    }
}
