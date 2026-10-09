use crate::product::schemas::Schemas;
use anyhow::Result;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const ENTRY_CHARACTERS: usize = 8_000;
const MESSAGE_CHARACTERS: usize = 40_000;
const TOOL_CHARACTERS: usize = 40_000;
const TRUNCATION: &str = "\n[...entry truncated for permission review...]\n";
pub(super) const EVIDENCE_OMITTED: &str = "[Auto permission review has incomplete user evidence]";

struct Entry {
    tool: bool,
    text: String,
    trusted: bool,
    truncated: bool,
}

/// The original builder retains trusted evidence first, then recent assistant
/// context and tool output under separate budgets. Incomplete trust is explicit.
pub(super) fn create(messages: &[Value]) -> Result<Value> {
    anyhow::ensure!(
        Schemas::new()?.valid("autoTranscriptMessages", &json!(messages))?,
        "The automatic permission review transcript is invalid."
    );
    let entries = collect(messages);
    let mut selected = BTreeSet::new();
    let trusted: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| entry.trusted.then_some(index))
        .collect();
    let total = trusted
        .iter()
        .map(|index| units(&entries[*index].text))
        .sum::<usize>();
    let mut message_characters = 0;
    if total <= MESSAGE_CHARACTERS {
        selected.extend(trusted.iter().copied());
        message_characters = total;
    } else {
        for index in trusted.first().into_iter().chain(trusted.last()) {
            if selected.insert(*index) {
                message_characters += units(&entries[*index].text);
            }
        }
        for index in trusted.iter().rev() {
            let size = units(&entries[*index].text);
            if !selected.contains(index) && message_characters + size <= MESSAGE_CHARACTERS {
                selected.insert(*index);
                message_characters += size;
            }
        }
    }
    let recent: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            (!entry.tool && !entry.trusted && !selected.contains(&index)).then_some(index)
        })
        .collect();
    for index in recent.iter().rev().take(40) {
        let size = units(&entries[*index].text);
        if message_characters + size <= MESSAGE_CHARACTERS {
            selected.insert(*index);
            message_characters += size;
        }
    }
    let mut tool_characters = 0;
    for (index, entry) in entries.iter().enumerate().rev() {
        if entry.tool && tool_characters + units(&entry.text) <= TOOL_CHARACTERS {
            selected.insert(index);
            tool_characters += units(&entry.text);
        }
    }
    let mut retained: Vec<String> = selected
        .iter()
        .map(|index| format!("[{}] {}", index + 1, entries[*index].text))
        .collect();
    let omitted = entries.len() - selected.len();
    let user_omitted = entries
        .iter()
        .enumerate()
        .any(|(index, entry)| entry.trusted && (!selected.contains(&index) || entry.truncated));
    if omitted > 0 {
        retained.push(format!(
            "[Context note] {omitted} transcript entr{} omitted to stay within the review budget.",
            if omitted == 1 { "y was" } else { "ies were" }
        ));
    }
    if user_omitted {
        retained.push(EVIDENCE_OMITTED.to_owned());
    }
    Ok(json!({"text":retained.join("\n\n"),"userEvidenceOmitted":user_omitted}))
}

fn collect(messages: &[Value]) -> Vec<Entry> {
    let mut entries = Vec::new();
    for message in messages {
        if message["internal"] == true || message["role"] == "system" {
            continue;
        }
        let blocks = message["blocks"].as_array().expect("validated blocks");
        if message["role"] == "user" {
            if all_text_starts_with(blocks, "<conversation_summary>") {
                continue;
            }
            let text = render(blocks, "[Image shared by user]");
            if !text.is_empty() {
                let shell = all_text_starts_with(blocks, "<user_shell_command>");
                let agent = message["provenance"] == "agent";
                push(
                    &mut entries,
                    shell,
                    format!(
                        "{}:\n{text}",
                        if shell {
                            "Tool result (direct user shell command)"
                        } else if agent {
                            "Agent message"
                        } else {
                            "User"
                        }
                    ),
                    !shell && !agent,
                );
            }
            continue;
        }
        if message["role"] == "error" {
            if message["context"] == "excluded" {
                continue;
            }
            let text = render(blocks, "[Image attached to inference error]");
            if !text.is_empty() {
                push(
                    &mut entries,
                    false,
                    format!(
                        "{}:\n{text}",
                        if message["outcome"] == "retried" {
                            "Retried inference error"
                        } else {
                            "Run error"
                        }
                    ),
                    false,
                );
            }
            continue;
        }
        for block in blocks {
            let (tool, text, trusted) = match block["type"].as_str() {
                Some("thinking") => continue,
                Some("text") => (
                    false,
                    format!("Assistant:\n{}", block["text"].as_str().unwrap()),
                    false,
                ),
                Some("image") => (
                    false,
                    "Assistant:\n[Image shared by assistant]".to_owned(),
                    false,
                ),
                Some("tool_call" | "tool_call_request") => (
                    false,
                    format!(
                        "Assistant tool call ({}):\n{}",
                        block["name"].as_str().unwrap(),
                        block
                            .get("arguments")
                            .map_or_else(|| "undefined".to_owned(), Value::to_string)
                    ),
                    false,
                ),
                Some("tool_result") => {
                    let trusted = block.get("trustedUserEvidence");
                    let rendered = render(
                        trusted.unwrap_or(&block["rendered"]).as_array().unwrap(),
                        if trusted.is_some() {
                            "[Image selected by user]"
                        } else {
                            "[Image returned by tool]"
                        },
                    );
                    let name = block["toolName"].as_str().unwrap();
                    (
                        trusted.is_none(),
                        if trusted.is_some() {
                            format!("User response through {name}:\n{rendered}")
                        } else {
                            format!(
                                "Tool result ({name}{}):\n{rendered}",
                                if block["isError"] == true {
                                    ", error"
                                } else {
                                    ""
                                }
                            )
                        },
                        trusted.is_some(),
                    )
                }
                _ => unreachable!("validated transcript block"),
            };
            push(&mut entries, tool, text, trusted);
        }
    }
    entries
}

pub(super) fn retains_trusted_entry(entry: &Value) -> bool {
    collect(std::slice::from_ref(entry))
        .iter()
        .any(|entry| entry.trusted)
}

fn push(entries: &mut Vec<Entry>, tool: bool, text: String, trusted: bool) {
    let truncated = units(&text) > ENTRY_CHARACTERS;
    let text = if truncated {
        let side = (ENTRY_CHARACTERS - units(TRUNCATION)) / 2;
        let units: Vec<u16> = text.encode_utf16().collect();
        format!(
            "{}{TRUNCATION}{}",
            String::from_utf16_lossy(&units[..side]),
            String::from_utf16_lossy(&units[units.len() - side..])
        )
    } else {
        text
    };
    entries.push(Entry {
        tool,
        text,
        trusted,
        truncated: trusted && truncated,
    });
}

pub(super) fn all_text_starts_with(blocks: &[Value], prefix: &str) -> bool {
    !blocks.is_empty()
        && blocks.iter().all(|block| block["type"] == "text")
        && blocks
            .iter()
            .map(|block| block["text"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            .trim_start_matches(js_whitespace)
            .starts_with(prefix)
}

fn render(blocks: &[Value], image: &str) -> String {
    blocks
        .iter()
        .map(|block| match block["type"].as_str() {
            Some("tool_call_request") => format!(
                "Requested tool ({}):\n{}",
                block["name"].as_str().unwrap(),
                block.get("arguments").cloned().unwrap_or_else(|| json!({}))
            ),
            Some("text") => block["text"].as_str().unwrap().to_owned(),
            _ => image.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

// ECMAScript trim/\s differ from Rust's Unicode White_Space (notably FEFF/0085).
pub(super) fn js_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_transcript_budgets_roles_and_trusted_answers_match_source_goldens() {
        for (index, case) in super::super::goldens()["transcriptCases"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let actual = create(case["messages"].as_array().unwrap()).unwrap();
            assert_eq!(actual, case["expected"], "transcript case {index}");
        }
    }
}
