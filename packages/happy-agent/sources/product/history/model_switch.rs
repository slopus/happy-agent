use super::HistoryModule;
use crate::product::runtime::Context;
use anyhow::{Context as _, Result};
use happy_agent_base::AgentScope;
use happy_providers::{Block, Message};
use serde_json::Value;

impl HistoryModule {
    pub(super) fn model_notice(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        previous: &Value,
    ) -> Result<Option<Message>> {
        let next = scope.settings;
        // Model selection participates in the caller's input-acceptance transaction.
        // History owns the optional excerpt; it cannot veto an otherwise valid switch.
        let excerpt = if previous["model"].is_string() {
            self.read_excerpt(ctx, scope.id, 32_000).ok().flatten()
        } else {
            None
        };
        let notice = if previous["model"].is_string() {
            Some(create_notice(
                &self.config.model_label(previous),
                previous["provider"]
                    .as_str()
                    .unwrap_or("an unknown provider"),
                &self.config.model_label(next),
                next["provider"]
                    .as_str()
                    .context("The selected provider is missing.")?,
                excerpt.as_ref(),
            ))
        } else {
            None
        };
        Ok(notice.map(|text| Message::System {
            content: vec![Block::text(text)],
        }))
    }
}

fn create_notice(
    previous_model: &str,
    previous_provider: &str,
    model: &str,
    provider: &str,
    excerpt: Option<&Value>,
) -> String {
    let opening = "Before responding, investigate the prior agent history so you understand the user's request, decisions, work already performed, and relevant subagent findings.";
    let mut lines = vec![
        "<model-switch-history-context>".to_owned(),
        format!(
            "The active model/provider configuration changed from {previous_model} on {previous_provider} to {model} on {provider}."
        ),
        if excerpt.is_some() {
            format!(
                "{opening} Review the bounded excerpt below, then use read_agent_history proactively whenever the excerpt is incomplete or more detail could affect your answer."
            )
        } else {
            format!(
                "{opening} Use read_agent_history proactively whenever more detail could affect your answer."
            )
        },
    ];
    if let Some(excerpt) = excerpt {
        lines.push("The excerpt and tool expose the durable inference-oriented history, not raw provider protocol traffic or hidden reasoning. Exposed thinking and conversation are prioritized; tool calls are summarized and tool outputs are truncated.".into());
        let stats = &excerpt["stats"];
        let prefix = if excerpt["statsAreSampled"] == true {
            "History sample overview (counts cover only the bounded excerpt, not the full archive)"
        } else {
            "History overview"
        };
        lines.push(format!("{prefix}: {} messages, {} user messages, {} assistant messages, {} thinking blocks, {} tool calls, {} tool results, and {} text characters.",stats["messages"],stats["userMessages"],stats["assistantMessages"],stats["thinkingBlocks"],stats["toolCalls"],stats["toolResults"],stats["textCharacters"]));
        lines.push(format!(
            "Beginning history excerpt:\n{}",
            excerpt["beginning"].as_str().unwrap_or("")
        ));
        if let Some(recent) = excerpt["recent"]
            .as_str()
            .filter(|recent| !recent.is_empty())
        {
            lines.push(format!("Recent history excerpt:\n{recent}"));
        }
    } else {
        lines.push("The conversation itself is not part of this context: the two configurations are incompatible, so none of it is visible to you, and the work it describes still stands. Do not repeat or undo work that may already be done.".into());
    }
    lines.push("</model-switch-history-context>".into());
    lines.join("\n")
}
