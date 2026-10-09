use super::{
    HistoryModule,
    read_tool::{COUNTERS, counters, format_message, truncate},
    stats,
};
use crate::product::runtime::Context;
use anyhow::{Context as _, Result};
use rusqlite::params;
use serde_json::{Value, json};

impl HistoryModule {
    pub fn read_excerpt(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        budget: usize,
    ) -> Result<Option<Value>> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("historyExcerptBudget", &json!(budget))?,
            "A history excerpt budget must be a bounded positive integer."
        );
        let total = counters(
            ctx,
            &format!("SELECT {COUNTERS} FROM happy_agent_module_history WHERE agent_id=?1"),
            params![agent],
        )?;
        let total_resource = resource(total);
        anyhow::ensure!(
            self.schemas.valid("historyStats", &total_resource)?,
            "The history statistics are invalid."
        );
        let mut statement=ctx.database().prepare("SELECT position,message_json FROM happy_agent_module_history WHERE agent_id=?1 AND position IN (SELECT position FROM (SELECT position FROM happy_agent_module_history WHERE agent_id=?1 ORDER BY position LIMIT 100) UNION SELECT position FROM (SELECT position FROM happy_agent_module_history WHERE agent_id=?1 ORDER BY position DESC LIMIT 100)) ORDER BY position")?;
        let mut rows = statement.query([agent])?;
        let mut beginning = Vec::new();
        let mut recent = std::collections::VecDeque::new();
        let mut sampled = [0i64; 7];
        let mut bytes = 0;
        while let Some(row) = rows.next()? {
            let position: i64 = row.get(0)?;
            let encoded: String = row.get(1)?;
            bytes += encoded.len();
            anyhow::ensure!(
                bytes <= 16 * 1024 * 1024,
                "The optional history excerpt exceeds its read budget."
            );
            let message: Value = serde_json::from_str(&encoded)?;
            anyhow::ensure!(
                self.schemas.valid("historyMessage", &message)?,
                "An excerpt history message is invalid."
            );
            let blocks = message["blocks"]
                .as_array()
                .context("The excerpt history blocks are invalid.")?;
            let counted = stats(message["role"].as_str().unwrap_or(""), blocks);
            for (destination, value) in sampled.iter_mut().zip([
                1, counted.0, counted.1, counted.2, counted.3, counted.4, counted.5,
            ]) {
                *destination += value;
            }
            if beginning.len() < 4 {
                beginning.push(format_message(&message, position + 1, true, 1500));
            } else {
                recent.push_back(format_message(&message, position + 1, true, 1500));
                if recent.len() > 8 {
                    recent.pop_front();
                }
            }
        }
        if beginning.is_empty() {
            return Ok(None);
        }
        let beginning_budget = if recent.is_empty() {
            budget
        } else {
            budget / 3
        };
        let beginning = render(&beginning, beginning_budget, false);
        let recent = render(
            &recent.into_iter().collect::<Vec<_>>(),
            budget.saturating_sub(beginning.encode_utf16().count()),
            true,
        );
        let exact = total
            .iter()
            .zip(sampled)
            .all(|(total, sampled)| *total >= sampled);
        let excerpt = json!({"beginning":beginning,"recent":recent,"stats":if exact{total_resource}else{resource(sampled)},"statsAreSampled":!exact});
        anyhow::ensure!(
            self.schemas.valid("historyExcerpt", &excerpt)?,
            "The history excerpt is invalid."
        );
        Ok(Some(excerpt))
    }
}
fn render(messages: &[String], budget: usize, from_end: bool) -> String {
    let mut selected = Vec::new();
    let mut characters = 0;
    for offset in 0..messages.len() {
        let index = if from_end {
            messages.len() - offset - 1
        } else {
            offset
        };
        let message = &messages[index];
        let separator = if selected.is_empty() { 0 } else { 2 };
        let remaining = budget.saturating_sub(characters + separator);
        if remaining == 0 || (!selected.is_empty() && message.encode_utf16().count() > remaining) {
            break;
        }
        let bounded = truncate(message, remaining);
        characters += separator + bounded.encode_utf16().count();
        selected.push(bounded);
    }
    if from_end {
        selected.reverse();
    }
    selected.join("\n\n")
}
fn resource(counts: [i64; 7]) -> Value {
    json!({"messages":counts[0],"assistantMessages":counts[1],"userMessages":counts[2],"textCharacters":counts[3],"thinkingBlocks":counts[4],"toolCalls":counts[5],"toolResults":counts[6]})
}
