//! Source model prompts, live compute instruction discovery and durable delivery notices.
use super::{
    config::ConfigModule,
    durable::DurableFunctionsModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
    tools::ToolsModule,
};
use anyhow::{Context as _, Result, ensure};
use async_trait::async_trait;
use happy_agent_base::{AcceptedInput, AgentModule, AgentScope};
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};
use tokio_util::sync::CancellationToken;
mod discovery;
mod format;
mod state;
#[cfg(test)]
mod tests;

const MAX_OUTPUT: usize = 1_000_000;
pub struct SystemPromptModule {
    config: Arc<ConfigModule>,
    compute: Arc<ToolsModule>,
    runtime: Arc<RuntimeModule>,
    _durable: Arc<DurableFunctionsModule>,
    schemas: Schemas,
    owner: std::sync::Weak<SystemPromptModule>,
}
impl SystemPromptModule {
    pub fn new(
        config: Arc<ConfigModule>,
        compute: Arc<ToolsModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        Ok(Arc::new_cyclic(|owner| Self {
            config,
            compute,
            runtime,
            _durable: durable,
            schemas,
            owner: owner.clone(),
        }))
    }
    pub fn prompt_for(&self, selection: &Value) -> Result<String> {
        ensure!(
            self.schemas
                .valid("ownerSystemPromptSelection", selection)?,
            "System prompt model selection is invalid."
        );
        let prompt = template(selection)
            .replace("{{name}}", "Happy Agent")
            .replacen("{{identity}}", "You are Happy Agent, built by Happy", 1);
        ensure!(
            prompt.len() <= MAX_OUTPUT,
            "The system prompt exceeds the configured output bound."
        );
        Ok(prompt)
    }
    async fn assemble(&self, scope: &AgentScope<'_>) -> Result<String> {
        let mut sections =
            vec![self.prompt_for(&self.config.system_prompt_selection(scope.settings)?)?];
        if let Some(environment) = scope.configuration.get("environment") {
            ensure!(
                self.schemas
                    .valid("agentConfig", &json!({"environment":environment}))?,
                "The agent environment is invalid."
            );
            let models = self.config.system_prompt_models()?;
            ensure!(
                self.schemas
                    .valid("ownerSystemPromptModels", &json!(models))?,
                "System prompt available models are invalid."
            );
            ensure!(
                format::models(&models).len() <= 512_000,
                "System prompt available models exceed the configured UTF-8 byte bound."
            );
            let (documentation, design) = self.config.system_prompt_documentation_paths();
            let mut input = json!({"environment":environment,"availableModels":models,"currentProvider":scope.settings["provider"].as_str().unwrap_or(""),"documentationPath":documentation,"designSystemPath":design});
            if let Some(model) = scope.settings.get("model") {
                input["currentModel"] = model.clone();
            }
            sections.push(format::environment(&input));
        }
        let instructions = self.instructions_snapshot(scope).await?;
        let before = sections.join("\n\n");
        let budget = MAX_OUTPUT as isize
            - before.len() as isize
            - if instructions.is_empty() { 0 } else { 2 };
        let bounded = format::fit_instructions(&instructions, budget);
        if !bounded.is_empty() {
            sections.push(bounded);
        }
        let prompt = sections.join("\n\n");
        ensure!(
            prompt.len() <= MAX_OUTPUT,
            "The system prompt exceeds the configured output bound."
        );
        Ok(prompt)
    }
}
fn template(selection: &Value) -> &'static str {
    static PROMPTS: OnceLock<Vec<Value>> = OnceLock::new();
    let prompts = PROMPTS.get_or_init(|| {
        serde_json::from_str(include_str!("system_prompt/prompts.json"))
            .expect("Captured Source prompts are valid.")
    });
    let model = selection["model"].as_str();
    let exact = model.and_then(|model| {
        prompts[..10]
            .iter()
            .find(|entry| entry["selection"]["model"] == model)
    });
    let family = model.and_then(|model| {
        [
            ("anthropic/", "anthropic/future"),
            ("openai/", "openai/future"),
            ("xai/", "xai/future"),
        ]
        .iter()
        .find_map(|(prefix, model_case)| {
            model.starts_with(prefix).then(|| {
                prompts
                    .iter()
                    .find(|entry| entry["selection"]["model"] == *model_case)
                    .unwrap()
            })
        })
    });
    let provider = selection["providerKind"]
        .as_str()
        .filter(|kind| matches!(*kind, "claude" | "codex" | "grok"))
        .and_then(|kind| {
            prompts.iter().find(|entry| {
                entry["selection"].get("model").is_none()
                    && entry["selection"]["providerKind"] == kind
            })
        });
    exact
        .or(family)
        .or(provider)
        .unwrap_or_else(|| prompts.last().unwrap())["template"]
        .as_str()
        .unwrap()
}
#[async_trait]
impl AgentModule for SystemPromptModule {
    fn name(&self) -> &'static str {
        "system-prompt"
    }
    async fn instructions(&self, scope: &AgentScope<'_>) -> Result<String> {
        self.assemble(scope).await
    }
    fn accepted(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        inputs: &[AcceptedInput],
        steering: bool,
    ) -> Result<()> {
        self.accept_notices(ctx, scope, inputs, steering)
    }
}
