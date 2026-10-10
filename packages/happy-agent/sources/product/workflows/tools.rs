use super::*;
use happy_providers::ToolDefinition;
pub fn definitions() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("tool_definitions.json"))
        .expect("The original workflow tool array is valid.")
}
fn definition(call: &Value) -> Option<ToolDefinition> {
    definitions().into_iter().find(|tool| {
        call["call"]["name"] == tool.name
            && call["call"]["namespace"].as_str() == tool.namespace.as_deref()
    })
}
pub fn lifetime(call: &Value, field: &str) -> Option<bool> {
    let tool = definition(call)?;
    let lifetimes: Value = serde_json::from_str(include_str!("tool_lifetimes.json"))
        .expect("The original workflow lifetimes are valid.");
    lifetimes
        .as_array()?
        .iter()
        .find(|value| value["name"] == tool.name)?[field]
        .as_bool()
}
fn reply(call: &Value, text: String, error: bool) -> Message {
    Message::Tool {
        call_id: call["id"].as_str().unwrap_or("").to_owned(),
        content: vec![Block::text(text)],
        is_error: error,
        vendor: None,
    }
}
impl WorkflowsModule {
    fn arguments(&self, call: &Value, name: &str) -> Result<Value> {
        let arguments = serde_json::from_str(
            call["call"]["arguments"]
                .as_str()
                .context("The workflow tool arguments are missing.")?,
        )?;
        valid(
            &self.schemas,
            &format!("ownerTool_{name}"),
            &arguments,
            "workflow tool arguments",
        )?;
        Ok(arguments)
    }
    pub(super) fn workflow_policy(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<ToolPermissionPolicy>> {
        let tool = definition(call)?;
        Some((|| {
            let arguments = self.arguments(call, &tool.name)?;
            if tool.name == "run_workflow"
                && let Some(path) = arguments["input"]["scriptPath"].as_str()
            {
                return self.tools.workflow_script_policy(scope, path);
            }
            Ok(ToolPermissionPolicy {
                should_review_in_auto_mode: false,
                should_run_in_full_access_in_auto_mode: false,
                requires_auto_or_full_access: false,
                action: if tool.name == "run_workflow" {
                    "starting an inline workflow".to_owned()
                } else {
                    tool.description
                },
                instructions: None,
            })
        })())
    }
    pub(super) fn workflow_transaction(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        let tool = definition(call)?;
        if tool.name == "wait_workflow" || tool.name == "run_workflow" {
            return None;
        }
        Some((|| {
            let input = self.arguments(call, &tool.name)?;
            let text = match tool.name.as_str() {
                "workflow_status" => self
                    .status(ctx, scope.id, input["id"].as_str().unwrap())?
                    .map(|run| format::run(&run))
                    .unwrap_or_else(|| "There is no workflow with that ID.".to_owned()),
                "list_workflows" => format::page(&self.list(ctx, scope.id, &input["input"])?),
                "workflow_logs" => format::logs(&self.logs(ctx, scope.id, &input["input"])?),
                "cancel_workflow" => {
                    format::run(&self.cancel(ctx, scope.id, input["id"].as_str().unwrap())?)
                }
                "resume_workflow" => {
                    format::run(&self.resume(ctx, scope.id, input["id"].as_str().unwrap())?)
                }
                _ => anyhow::bail!("The workflow tool is unavailable."),
            };
            Ok(reply(call, text, false))
        })())
    }
    pub(super) async fn workflow_async(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        let tool = definition(call)?;
        if !matches!(tool.name.as_str(), "run_workflow" | "wait_workflow") {
            return None;
        }
        let result = async {
            let input = self.arguments(call, &tool.name)?;
            let owner = self
                .owner
                .upgrade()
                .context("The workflow owner was closed.")?;
            let run = if tool.name == "wait_workflow" {
                owner
                    .wait(scope.id, input["id"].as_str().unwrap(), cancel)
                    .await?
            } else {
                let input = input["input"].clone();
                let script = if let Some(script) = input["script"].as_str() {
                    script.to_owned()
                } else {
                    self.tools
                        .read_workflow_script(scope, input["scriptPath"].as_str().unwrap(), &cancel)
                        .await?
                };
                let agent = scope.id.to_owned();
                let id = call["id"]
                    .as_str()
                    .context("The workflow tool call ID is missing.")?
                    .to_owned();
                self.runtime
                    .transact(move |ctx| owner.launch_resolved(ctx, &agent, &input, &id, &script))
                    .await?
            };
            Ok::<String, anyhow::Error>(format::run(&run))
        }
        .await;
        Some(match result {
            Ok(text) => reply(call, text, false),
            Err(error) => reply(call, error.to_string(), true),
        })
    }
}
