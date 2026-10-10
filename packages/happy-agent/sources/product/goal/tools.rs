use super::*;
use happy_providers::{Block, Message, ToolDefinition};
pub fn definitions() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("tool_definitions.json"))
        .expect("The original goal tools are valid.")
}
pub fn definition(call: &Value) -> Option<ToolDefinition> {
    definitions().into_iter().find(|tool| {
        call["call"]["name"] == tool.name
            && call["call"]["namespace"].as_str() == tool.namespace.as_deref()
    })
}
impl GoalModule {
    pub(super) fn execute_goal_tool(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        let tool = definition(call)?;
        Some((|| {
            let input: Value = serde_json::from_str(
                call["call"]["arguments"]
                    .as_str()
                    .context("Goal arguments are missing.")?,
            )?;
            anyhow::ensure!(
                self.schemas
                    .valid(&format!("ownerTool_{}", tool.name), &input)?,
                "The goal tool input is invalid."
            );
            let text = match tool.name.as_str() {
                "create_goal" => {
                    let activation = self.set(
                        ctx,
                        scope.id,
                        input["objective"].as_str().unwrap(),
                        Some(
                            call["id"]
                                .as_str()
                                .context("The goal call has no identity.")?,
                        ),
                        false,
                    )?;
                    ctx.put_value(
                        scope.id,
                        &Self::run_key(scope.id, "observedLifecycleId"),
                        &activation["lifecycleId"],
                    )?;
                    format::goal(Some(&activation["goal"]), 12000)
                }
                "get_goal" => format::goal(self.goal(ctx, scope.id)?.as_ref(), 12000),
                "update_goal" => format::goal(
                    Some(&self.change(ctx, scope.id, input["status"].as_str().unwrap(), false)?),
                    12000,
                ),
                "clear_goal" => {
                    if self.clear(ctx, scope.id, false)? {
                        "Goal cleared.".to_owned()
                    } else {
                        "This agent had no goal to clear.".to_owned()
                    }
                }
                _ => anyhow::bail!("The goal tool is unavailable."),
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
