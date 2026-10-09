use super::{HistoryModule, stats};
use crate::product::runtime::Context;
use anyhow::{Context as _, Result};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::sync::Arc;

const FILTER: &str = "agent_id=?1 AND (?2 IS NULL OR role IN (SELECT value FROM json_each(?2))) AND (?3 IS NULL OR instr(search_text,?3)>0)";
const COUNTERS: &str = "count(*),coalesce(sum(assistant_messages),0),coalesce(sum(user_messages),0),coalesce(sum(text_characters),0),coalesce(sum(thinking_blocks),0),coalesce(sum(tool_calls),0),coalesce(sum(tool_results),0)";
const MAX_CHARACTERS: usize = 80_000;

impl HistoryModule {
    pub async fn read_tool(self: &Arc<Self>, requester: &str, arguments: Value) -> Result<Value> {
        anyhow::ensure!(
            self.schemas.valid("historyTool", &arguments)?,
            "The history tool arguments are invalid."
        );
        anyhow::ensure!(
            arguments.get("cursor").is_none() || arguments.get("from").is_none(),
            "Use either cursor or from, not both."
        );
        let target = arguments["target"].as_str().unwrap_or(requester).to_owned();
        anyhow::ensure!(
            self.schemas.valid("historyAgentId", &json!(requester))?
                && self.schemas.valid("historyAgentId", &json!(target))?,
            "The history target identity is invalid."
        );
        let requester = requester.to_owned();
        let history = self.clone();
        self.runtime
            .transact(move |ctx| history.read_tool_transact(ctx, &requester, &target, &arguments))
            .await
    }

    fn read_tool_transact(
        &self,
        ctx: &Context<'_>,
        requester: &str,
        target: &str,
        arguments: &Value,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let roles = arguments.get("roles").map(Value::to_string);
        let query = arguments["query"]
            .as_str()
            .map(|text| text.trim().replace('\0', "").to_lowercase())
            .filter(|text| !text.is_empty());
        let from_end = matches!(arguments["from"].as_str(), Some("end" | "last"));
        let anchor = arguments["cursor"].as_i64().unwrap_or(0);
        let limit = arguments["limit"].as_i64().unwrap_or(100);
        let total = counters(
            ctx,
            &format!("SELECT {COUNTERS} FROM happy_agent_module_history WHERE agent_id=?1"),
            params![target],
        )?;
        let matched = counters(
            ctx,
            &format!("SELECT {COUNTERS} FROM happy_agent_module_history WHERE {FILTER}"),
            params![target, roles, query],
        )?;
        let start_index = if from_end {
            (matched[0] - limit).max(0)
        } else {
            ctx.database().query_row(
                &format!(
                    "SELECT count(*) FROM happy_agent_module_history WHERE {FILTER} AND position<?4"
                ),
                params![target, roles, query, anchor],
                |row| row.get::<_, i64>(0),
            )?
        };
        let direction = if from_end { "DESC" } else { "ASC" };
        let cursor_bound = if from_end { None } else { Some(anchor) };
        let select = format!(
            "SELECT position,message_json FROM happy_agent_module_history WHERE {FILTER} AND (?4 IS NULL OR position>=?4) ORDER BY position {direction} LIMIT ?5"
        );
        let page_first: Option<i64> = ctx.database().query_row(
            &format!("SELECT min(position) FROM ({select})"),
            params![target, roles, query, cursor_bound, limit],
            |row| row.get(0),
        )?;
        let mut statement = ctx.database().prepare(&select)?;
        let mut rows = statement.query(params![target, roles, query, cursor_bound, limit])?;
        let mut rendered = Vec::new();
        let mut returned = [0i64; 7];
        let mut characters = 0;
        let mut first_position = None;
        let mut last_position = None;
        while let Some(row) = rows.next()? {
            let position: i64 = row.get(0)?;
            let encoded: String = row.get(1)?;
            anyhow::ensure!(
                encoded.len() <= 64 * 1024 * 1024,
                "The history message exceeds its allowed byte size."
            );
            let message: Value = serde_json::from_str(&encoded)?;
            anyhow::ensure!(
                self.schemas.valid("historyMessage", &message)?,
                "A durable history message is invalid."
            );
            let text = format_message(&message, position + 1, arguments["include_tools"] != false);
            let separator = if rendered.is_empty() { 0 } else { 2 };
            let remaining = MAX_CHARACTERS.saturating_sub(characters + separator);
            let length = text.encode_utf16().count();
            if !rendered.is_empty() && length > remaining {
                break;
            }
            let bounded = truncate(&text, remaining);
            characters += separator + bounded.encode_utf16().count();
            first_position =
                Some(first_position.map_or(position, |previous: i64| previous.min(position)));
            last_position =
                Some(last_position.map_or(position, |previous: i64| previous.max(position)));
            rendered.push(bounded);
            let blocks = message["blocks"]
                .as_array()
                .context("The history blocks are invalid.")?;
            let counted = stats(message["role"].as_str().unwrap_or(""), blocks);
            for (destination, value) in returned.iter_mut().zip([
                1, counted.0, counted.1, counted.2, counted.3, counted.4, counted.5,
            ]) {
                *destination += value;
            }
            if characters >= MAX_CHARACTERS {
                break;
            }
        }
        if from_end {
            rendered.reverse();
        }
        let archive_last: Option<i64> = ctx.database().query_row(
            "SELECT max(position) FROM happy_agent_module_history WHERE agent_id=?1",
            [target],
            |row| row.get(0),
        )?;
        let cursor = first_position.unwrap_or(if from_end {
            archive_last.map_or(0, |position| {
                position.saturating_add(1).min(9_007_199_254_740_991)
            })
        } else {
            anchor
        });
        let next: Option<i64> = if !from_end && let Some(last) = last_position {
            ctx.database().query_row(&format!("SELECT min(position) FROM happy_agent_module_history WHERE {FILTER} AND position>?4"),params![target,roles,query,last],|row|row.get(0))?
        } else {
            None
        };
        let page_count = if from_end {
            matched[0].min(limit)
        } else {
            (matched[0] - start_index).min(limit)
        };
        let previous = if from_end && first_position != page_first {
            page_first
        } else if matched[0] > page_count && (from_end || start_index > 0) {
            ctx.database().query_row(&format!("SELECT position FROM happy_agent_module_history WHERE {FILTER} ORDER BY position LIMIT 1 OFFSET ?4"),params![target,roles,query,(start_index-limit).max(0)],|row|row.get::<_,i64>(0)).optional()?
        } else {
            None
        };
        let mut ids = vec![requester, target];
        ids.sort_unstable();
        ids.dedup();
        let agents = ids
            .into_iter()
            .map(|id| {
                let count: i64 = ctx.database().query_row(
                    "SELECT count(*) FROM happy_agent_module_history WHERE agent_id=?1",
                    [id],
                    |row| row.get(0),
                )?;
                Ok(json!({"agent_id":id,"path":id,"status":"unknown","message_count":count}))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut result = json!({"agents":agents,"cursor":cursor,"history":rendered.join("\n\n"),"matched_messages":matched[0],"returned_messages":returned[0],"stats":{"matched":stats_resource(matched),"returned":stats_resource(returned),"total":stats_resource(total)},"target":target,"total_messages":total[0]});
        if let Some(next) = next {
            result["next_cursor"] = json!(next);
        }
        if let Some(previous) = previous {
            result["previous_cursor"] = json!(previous);
        }
        anyhow::ensure!(
            self.schemas.valid("historyToolResult", &result)?,
            "The history tool produced an invalid result."
        );
        Ok(result)
    }
}

fn counters(ctx: &Context<'_>, query: &str, parameters: impl rusqlite::Params) -> Result<[i64; 7]> {
    Ok(ctx.database().query_row(query, parameters, |row| {
        Ok([
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
        ])
    })?)
}
fn stats_resource(counters: [i64; 7]) -> Value {
    json!({"messages":counters[0],"assistant_messages":counters[1],"user_messages":counters[2],"text_characters":counters[3],"thinking_blocks":counters[4],"tool_calls":counters[5],"tool_results":counters[6]})
}
pub(super) fn format_message(message: &Value, position: i64, include_tools: bool) -> String {
    let sender = message["senderAgentId"]
        .as_str()
        .map(|id| format!(" ({id})"))
        .unwrap_or_default();
    let attribution = message["provider"]
        .as_str()
        .map(|provider| {
            format!(
                " ({provider}{})",
                message["model"]
                    .as_str()
                    .map(|model| format!(", {model}"))
                    .unwrap_or_default()
            )
        })
        .unwrap_or_default();
    let mut lines = vec![format!(
        "{position}. {}{sender}{attribution}",
        message["role"].as_str().unwrap_or("").to_uppercase()
    )];
    for block in message["blocks"].as_array().into_iter().flatten() {
        match block["type"].as_str() {
            Some("text") => lines.push(format!(
                "Text: {}",
                truncate(block["text"].as_str().unwrap_or(""), 12_000)
            )),
            Some("thinking") => lines.push(if block["redacted"] == true {
                "Thinking: [redacted]".into()
            } else {
                format!(
                    "Thinking: {}",
                    truncate(block["thinking"].as_str().unwrap_or(""), 12_000)
                )
            }),
            Some("image") => lines.push(format!(
                "[Image: {}]",
                block["mediaType"].as_str().unwrap_or("")
            )),
            Some("tool_call_request") => lines.push(format!(
                "Requested tool: {} {}",
                block["name"].as_str().unwrap_or(""),
                truncate(
                    &block
                        .get("arguments")
                        .cloned()
                        .unwrap_or(json!({}))
                        .to_string(),
                    1500
                )
            )),
            Some("tool_call") if include_tools => lines.push(format!(
                "Tool call: {} {}",
                block["name"].as_str().unwrap_or(""),
                truncate(
                    &block.get("arguments").unwrap_or(&Value::Null).to_string(),
                    1500
                )
            )),
            Some("tool_result") if include_tools => {
                let summary = block["display"]
                    .as_str()
                    .map(|display| format!("\nSummary: {}", truncate(display, 1000)))
                    .unwrap_or_default();
                lines.push(format!(
                    "Tool result: {} ({}){summary}\nOutput: {}",
                    block["toolName"].as_str().unwrap_or(""),
                    if block["isError"] == true {
                        "error"
                    } else {
                        "ok"
                    },
                    truncate(block["output"].as_str().unwrap_or(""), 4000)
                ));
            }
            Some("tool_call" | "tool_result") => {}
            _ => {
                let tokens = block["tokensBefore"]
                    .as_u64()
                    .map(|before| {
                        format!(
                            " ({before} → {} tokens)",
                            block["tokensAfter"]
                                .as_u64()
                                .map(|after| after.to_string())
                                .unwrap_or_else(|| "unknown".into())
                        )
                    })
                    .unwrap_or_default();
                let failure = block["failureReason"]
                    .as_str()
                    .map(|reason| format!(": {reason}"))
                    .unwrap_or_default();
                lines.push(format!(
                    "Compaction: {}{tokens}{failure}",
                    block["status"].as_str().unwrap_or("")
                ));
            }
        }
    }
    lines.join("\n")
}
pub(super) fn truncate(text: &str, limit: usize) -> String {
    let length = text.encode_utf16().count();
    if length <= limit {
        return text.into();
    }
    let suffix = format!("\n...[truncated {} chars]", length - limit);
    let suffix_length = suffix.encode_utf16().count();
    if suffix_length >= limit {
        return head(&suffix, limit);
    }
    format!("{}{suffix}", head(text, limit - suffix_length))
}
fn head(text: &str, limit: usize) -> String {
    text.chars()
        .scan(0, |units, character| {
            *units += character.len_utf16();
            (*units <= limit).then_some(character)
        })
        .collect()
}
