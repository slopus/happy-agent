use super::*;
use happy_providers::{Block, Message, ToolDefinition};

pub fn definitions() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("tool_definitions.json"))
        .expect("The original presence tool array is valid.")
}
pub fn definition(call: &Value) -> Option<ToolDefinition> {
    definitions().into_iter().find(|definition| {
        call["call"]["name"] == definition.name
            && call["call"]["namespace"].as_str() == definition.namespace.as_deref()
    })
}
impl PresenceModule {
    pub(super) fn execute_presence_tool(
        &self,
        ctx: &Context<'_>,
        _: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        let definition = definition(call)?;
        Some((|| {
            let input: Value = serde_json::from_str(
                call["call"]["arguments"]
                    .as_str()
                    .context("The presence tool arguments are missing.")?,
            )?;
            anyhow::ensure!(
                self.schemas
                    .valid(&format!("ownerTool_{}", definition.name), &input)?,
                "The presence tool arguments are invalid."
            );
            let text = match definition.name.as_str() {
                "get_presence" => self
                    .read(ctx)?
                    .map_or(Ok("No presence is configured.".to_owned()), |state| {
                        display(&state)
                    }),
                "list_presences" => Ok(display_catalog(&self.list_presences(ctx)?)),
                "set_presence" => {
                    let state = self.set_presence(ctx, &input["input"])?;
                    let message = state["message"]
                        .as_str()
                        .map_or(String::new(), |message| format!(" — {message}"));
                    let expiry = state["expiresAt"]
                        .as_u64()
                        .map(|at| calendar::iso(at).map(|time| format!(" until {time}")))
                        .transpose()?
                        .unwrap_or_default();
                    let fallback = state["fallbackPresenceId"]
                        .as_str()
                        .map_or(String::new(), |id| format!(", then {id}"));
                    Ok(format!(
                        "Presence set to {} {}{message}{expiry}{fallback}.",
                        state["title"].as_str().unwrap(),
                        state["emoji"].as_str().unwrap()
                    ))
                }
                _ => anyhow::bail!("The presence tool is unavailable."),
            }?;
            Ok(Message::Tool {
                call_id: call["id"]
                    .as_str()
                    .context("The presence tool identity is missing.")?
                    .to_owned(),
                content: vec![Block::text(text)],
                is_error: false,
                vendor: None,
            })
        })())
    }
}
fn wait(state: &Value) -> String {
    match state["answerWaitMs"].as_u64() {
        None => "wait indefinitely".to_owned(),
        Some(0) => "do not wait".to_owned(),
        Some(duration) => format!("wait {}", duration_text(duration)),
    }
}
fn duration_text(duration: u64) -> String {
    if duration < 60000 {
        format!("{} seconds", ((duration + 500) / 1000).max(1))
    } else if duration < 3600000 {
        format!("{} minutes", (duration + 30000) / 60000)
    } else if duration < 86400000 {
        format!("{} hours", (duration + 1800000) / 3600000)
    } else {
        format!("{} days", (duration + 43200000) / 86400000)
    }
}
fn display(state: &Value) -> Result<String> {
    let message = state["message"].as_str().map_or(String::new(), |message| {
        format!(" Status message: {message}.")
    });
    let expiry = state["expiresAt"]
        .as_u64()
        .map(|at| calendar::iso(at).map(|time| format!(" This state expires at {time}.")))
        .transpose()?
        .unwrap_or_default();
    Ok(format!(
        "Current presence: {} {}.{message} {} ({}).{expiry}",
        state["title"].as_str().unwrap(),
        state["emoji"].as_str().unwrap(),
        state["prompt"].as_str().unwrap(),
        wait(state)
    ))
}
fn display_catalog(catalog: &[Value]) -> String {
    if catalog.is_empty() {
        return "No presence states are configured.".to_owned();
    }
    let detailed = catalog
        .iter()
        .map(|state| {
            format!(
                "{}: {} {} ({}) — {}",
                state["id"].as_str().unwrap(),
                state["title"].as_str().unwrap(),
                state["emoji"].as_str().unwrap(),
                wait(state),
                state["prompt"].as_str().unwrap()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    if detailed.encode_utf16().count() <= 100000 {
        return detailed;
    }
    let compact = catalog
        .iter()
        .map(|state| {
            format!(
                "{}: {} {} ({})",
                state["id"].as_str().unwrap(),
                state["title"].as_str().unwrap(),
                state["emoji"].as_str().unwrap(),
                wait(state)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "The catalog is bounded, so detailed prompts were omitted. Use the listed IDs with set_presence; get_presence provides the active state's full guidance.\n{compact}"
    )
}
