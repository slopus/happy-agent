use crate::product::schemas::Schemas;
use anyhow::Result;
use serde_json::{Value, json};
use std::sync::OnceLock;

pub(super) fn instructions() -> &'static Value {
    static INSTRUCTIONS: OnceLock<Value> = OnceLock::new();
    INSTRUCTIONS.get_or_init(|| {
        serde_json::from_str(include_str!("instructions.json"))
            .expect("source-generated permission instructions")
    })
}

pub(super) fn create(first: bool, conversation: &str, action: &str) -> Result<String> {
    let options = json!({"first":first,"conversation":conversation,"action":action});
    anyhow::ensure!(
        Schemas::new()?.valid("permissionPromptOptions", &options)?,
        "The automatic permission review prompt is invalid."
    );
    let mut lines = Vec::new();
    if !first {
        lines.push(instructions()["followup"].as_str().unwrap());
        lines.push("");
    }
    lines.extend([
        if first {
            "<conversation>"
        } else {
            "<conversation continued=\"true\">"
        },
        if conversation.is_empty() {
            "No new conversation since your last review."
        } else {
            conversation
        },
        "</conversation>",
        "",
        "<proposed_action>",
        action,
        "</proposed_action>",
    ]);
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_first_followup_and_empty_review_prompts_match_source() {
        for case in super::super::goldens()["promptCases"].as_array().unwrap() {
            let options = &case["options"];
            assert_eq!(
                create(
                    options["first"].as_bool().unwrap(),
                    options["conversation"].as_str().unwrap(),
                    options["action"].as_str().unwrap(),
                )
                .unwrap(),
                case["expected"].as_str().unwrap()
            );
        }
    }
}
