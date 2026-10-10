use super::*;
use happy_providers::{Block, Message, ToolDefinition};
pub fn definitions() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("tool_definitions.json"))
        .expect("The original scheduling tool array is valid.")
}
pub fn definition(call: &Value) -> Option<ToolDefinition> {
    definitions().into_iter().find(|tool| {
        call["call"]["name"] == tool.name
            && call["call"]["namespace"].as_str() == tool.namespace.as_deref()
    })
}
fn reply(call: &Value, text: String, error: bool) -> Message {
    Message::Tool {
        call_id: call["id"].as_str().unwrap_or("").to_owned(),
        content: vec![Block::text(text)],
        is_error: error,
        vendor: None,
    }
}
impl SchedulingModule {
    fn arguments(&self, call: &Value, name: &str) -> Result<Value> {
        let input = serde_json::from_str(
            call["call"]["arguments"]
                .as_str()
                .context("The scheduling tool arguments are missing.")?,
        )?;
        valid(
            &self.schemas,
            &format!("ownerTool_{name}"),
            &input,
            "scheduling tool arguments",
        )?;
        Ok(input)
    }
    pub(super) fn execute_schedule_transaction(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        let tool = definition(call)?;
        if matches!(tool.name.as_str(), "wait" | "wait_until") {
            return None;
        }
        Some((|| {
            let input = self.arguments(call, &tool.name)?;
            let text = match tool.name.as_str() {
                "schedule_message" => {
                    let mut request = input["input"].clone();
                    request["targetAgentId"] = request["agent_id"].clone();
                    request.as_object_mut().unwrap().remove("agent_id");
                    request["id"] = call["id"].clone();
                    self.format_schedule_for_model(&self.schedule(ctx, scope.id, &request)?)?
                }
                "cancel_scheduled_message" => self
                    .format_cancellation_for_model(&self.cancel_schedule(ctx, scope.id, &input)?)?,
                "list_scheduled_messages" => self.format_schedule_page_for_model(
                    &self.list_schedule_page(ctx, scope.id, &input)?,
                )?,
                _ => anyhow::bail!("The scheduling tool is unavailable."),
            };
            Ok(reply(call, text, false))
        })())
    }
    pub(super) async fn execute_schedule_wait(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        let tool = definition(call)?;
        if !matches!(tool.name.as_str(), "wait" | "wait_until") {
            return None;
        }
        let result = async {
            let mut input = self.arguments(call, &tool.name)?;
            input["id"] = call["id"].clone();
            let owner = self
                .owner
                .upgrade()
                .context("The scheduling owner was closed.")?;
            let result = if tool.name == "wait" {
                owner.wait(scope.id, &input, &cancel).await?
            } else {
                owner.wait_until(scope.id, &input, &cancel).await?
            };
            self.format_wait_for_model(&result)
        }
        .await;
        Some(match result {
            Ok(text) => reply(call, text, false),
            Err(error) => reply(call, format!("{error:#}"), true),
        })
    }
}
