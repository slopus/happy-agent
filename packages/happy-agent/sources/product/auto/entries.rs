use crate::product::schemas::Schemas;
use anyhow::Result;
use serde_json::{Value, json};

/// Classify at the original core hooks, where genuine human provenance still
/// exists. Public history and an assistant's claims cannot supply that marker.
pub(super) fn user(message: &Value, metadata: Option<&Value>) -> Result<Option<Value>> {
    let mut input = json!({"message":message});
    if let Some(metadata) = metadata {
        input["metadata"] = metadata.clone();
    }
    anyhow::ensure!(
        Schemas::new()?.valid("autoUserEvidenceInput", &input)?,
        "The automatic permission review input is invalid."
    );
    if metadata.is_some_and(|value| value["hideFromUser"] == true) {
        return Ok(None);
    }
    let blocks: Vec<Value> = message["content"]
        .as_array()
        .expect("validated user content")
        .iter()
        .map(|block| match block["type"].as_str() {
            Some("text") => json!({"type":"text","text":block["text"]}),
            Some("tool_call_request") => block.clone(),
            _ => json!({"type":"image"}),
        })
        .collect();
    let shell = super::transcript::all_text_starts_with(&blocks, "<user_shell_command>");
    let human = metadata.is_some_and(|value| value["messageOrigin"] == "user");
    let mut entry = json!({"role":"user","blocks":blocks});
    if !human {
        entry["provenance"] = json!("agent");
    }
    Ok(Some(evidence(
        if shell { "tool" } else { "message" },
        entry,
        human && !shell,
    )))
}

pub(super) fn text(text: &str) -> Value {
    evidence(
        "message",
        json!({"role":"agent","blocks":[{"type":"text","text":text}]}),
        false,
    )
}

pub(super) fn call(name: &str, arguments: &str) -> Value {
    let arguments: Value = serde_json::from_str(arguments).unwrap_or_else(|_| json!(arguments));
    evidence(
        "message",
        json!({"role":"agent","blocks":[{"type":"tool_call","name":name,"arguments":arguments}]}),
        false,
    )
}

pub(super) fn result(options: &Value) -> Result<Value> {
    anyhow::ensure!(
        Schemas::new()?.valid("autoToolResultEvidenceInput", options)?,
        "The automatic permission review tool result is invalid."
    );
    let rendered: Vec<Value> = options["content"]
        .as_array()
        .expect("validated tool result content")
        .iter()
        .map(|block| {
            if block["type"] == "text" {
                json!({"type":"text","text":block["text"]})
            } else {
                json!({"type":"image"})
            }
        })
        .collect();
    let mut block = json!({"type":"tool_result","toolName":options["toolName"],"rendered":rendered,"isError":options["isError"]});
    let trusted = options.get("trustedUserAnswer");
    if let Some(trusted) = trusted {
        block["trustedUserEvidence"] = trusted.clone();
    }
    Ok(evidence(
        if trusted.is_some() { "message" } else { "tool" },
        json!({"role":"agent","blocks":[block]}),
        trusted.is_some(),
    ))
}

pub(super) fn error(text: &str, retried: bool) -> Value {
    let mut entry = json!({"role":"error","blocks":[{"type":"text","text":text}]});
    if retried {
        entry["outcome"] = json!("retried");
    }
    evidence("message", entry, false)
}

fn evidence(category: &str, entry: Value, trusted: bool) -> Value {
    json!({"category":category,"entry":entry,"trustedUserEvidence":trusted,"trustedUserEvidenceTruncated":false})
}

/// Re-derive only the hook-produced classification after schema validation.
/// Denormalized SQL flags must agree; they cannot promote different content.
pub(super) fn classification(entry: &Value) -> Result<(&'static str, bool)> {
    let blocks = entry["blocks"]
        .as_array()
        .expect("validated evidence blocks");
    match entry["role"].as_str() {
        Some("user") => {
            let shell = super::transcript::all_text_starts_with(blocks, "<user_shell_command>");
            Ok((
                if shell { "tool" } else { "message" },
                !shell && entry["provenance"] != "agent",
            ))
        }
        Some("error") => Ok(("message", false)),
        Some("agent") if blocks.len() == 1 => {
            if blocks[0]["type"] == "tool_result" {
                let trusted = blocks[0].get("trustedUserEvidence").is_some();
                Ok((if trusted { "message" } else { "tool" }, trusted))
            } else {
                Ok(("message", false))
            }
        }
        _ => anyhow::bail!("The automatic permission review evidence classification is invalid."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_classification_requires_human_origin_and_selects_only_the_recorded_answer() {
        let schemas = Schemas::new().unwrap();
        for case in super::super::goldens()["evidenceCases"].as_array().unwrap() {
            let actual = match case["kind"].as_str().unwrap() {
                "user" => user(&case["message"], case.get("metadata"))
                    .unwrap()
                    .unwrap_or(Value::Null),
                "text" => text(case["text"].as_str().unwrap()),
                "call" => call(
                    case["name"].as_str().unwrap(),
                    case["argumentsJson"].as_str().unwrap(),
                ),
                "result" => result(&case["options"]).unwrap(),
                "error" => error(
                    case["text"].as_str().unwrap(),
                    case["retried"].as_bool().unwrap(),
                ),
                _ => unreachable!(),
            };
            assert_eq!(actual, case["expected"], "{}", case["kind"]);
            if actual != Value::Null {
                assert!(schemas.valid("autoEvidenceEntry", &actual).unwrap());
            }
        }
    }
}
