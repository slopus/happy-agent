use super::*;
use happy_providers::{Block, Message, ToolDefinition};
pub fn definitions() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("tool_definitions.json"))
        .expect("The original question tool array is valid.")
}
pub fn definition(call: &Value) -> Option<ToolDefinition> {
    definitions().into_iter().find(|tool| {
        call["call"]["name"] == tool.name
            && call["call"]["namespace"].as_str() == tool.namespace.as_deref()
    })
}
fn reply(call: &Value, text: String, is_error: bool) -> Message {
    Message::Tool {
        call_id: call["id"].as_str().unwrap_or("").to_owned(),
        content: vec![Block::text(text)],
        is_error,
        vendor: None,
    }
}
impl UserInputModule {
    fn tool_arguments(&self, call: &Value, name: &str) -> Result<Value> {
        let input = serde_json::from_str(
            call["call"]["arguments"]
                .as_str()
                .context("The user input tool arguments are missing.")?,
        )?;
        validation::schema(
            &self.schemas,
            &format!("ownerTool_{name}"),
            &input,
            "user input tool arguments",
        )?;
        Ok(input)
    }
    pub(super) fn execute_question_transaction(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        let tool = definition(call)?;
        if tool.name == "request_user_input" {
            return None;
        }
        Some((|| {
            let mut input = self.tool_arguments(call, &tool.name)?;
            let text = match tool.name.as_str() {
                "read_user_input" => {
                    let id = input["requestId"].as_str().unwrap().to_owned();
                    input.as_object_mut().unwrap().remove("requestId");
                    let page = self.get_page(ctx, scope.id, &id, &input)?;
                    self.format_detail_page_for_model(&page)?
                }
                "cancel_ask" => {
                    let input = &input["input"];
                    let request=self.cancel(ctx,scope.id,&json!({"requestId":input.get("requestId").or_else(||input.get("ask_id")).unwrap(),"reason":input["reason"].as_str().unwrap_or("The answer is no longer needed.")}))?;
                    self.format_for_model(&request)?
                }
                _ => anyhow::bail!("The user input tool is unavailable."),
            };
            Ok(reply(call, text, false))
        })())
    }
    pub(super) async fn execute_question_wait(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        let tool = definition(call)?;
        if tool.name != "request_user_input" {
            return None;
        }
        let outcome = async {
            let input = self.tool_arguments(call, &tool.name)?;
            let owner = self
                .owner
                .upgrade()
                .context("The user input owner was closed.")?;
            let acting = scope.id.to_owned();
            let id = call["id"]
                .as_str()
                .context("The user input call identity is missing.")?
                .to_owned();
            let creator = owner.clone();
            let agent = acting.clone();
            let request_id = id.clone();
            owner
                .runtime
                .transact(move |ctx| creator.ask(ctx, &agent, &input, Some(&request_id)))
                .await?;
            let request = owner.wait(&acting, &id, &cancel).await?;
            self.format_for_model(&request)
        }
        .await;
        Some(match outcome {
            Ok(text) => reply(call, text, false),
            Err(error) => reply(call, format!("{error:#}"), true),
        })
    }
}
