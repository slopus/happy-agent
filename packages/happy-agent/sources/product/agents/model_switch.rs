use super::{AgentSystemModule, delete_scope};
use crate::product::runtime::Context;
use anyhow::{Context as _, Result};
use serde_json::{Value, json};

impl AgentSystemModule {
    pub(super) fn adopt_model(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        previous: &Value,
        next: &Value,
    ) -> Result<()> {
        if previous["provider"] == next["provider"] && previous["model"] == next["model"] {
            return Ok(());
        }
        if self.config.models_compatible(previous, next)? {
            return Ok(());
        }
        // Model selection participates in the caller's input-acceptance transaction.
        // History owns the optional excerpt; it cannot veto an otherwise valid switch.
        let excerpt = if previous["model"].is_string() {
            self.history.read_excerpt(ctx, agent, 32_000).ok().flatten()
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
        ctx.database().execute("DELETE FROM happy_agent_values WHERE owner_id=?1 AND key IN(SELECT 'message.'||json_extract(record_json,'$.id') FROM happy_agent_records WHERE owner_id=?1 AND json_extract(record_json,'$.type')='user')",[agent])?;
        ctx.database()
            .execute("DELETE FROM happy_agent_records WHERE owner_id=?1", [agent])?;
        delete_scope(ctx, agent, &format!("kv.{agent}.history."))?;
        self.usage.clear_context(ctx, agent)?;
        if let Some(text) = notice {
            let record = json!({"type":"system","message":{"role":"system","content":[{"type":"text","text":text}]}});
            self.append_record(ctx, agent, &record)?;
        }
        Ok(())
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
