use crate::product::schemas::Schemas;
use anyhow::Result;
use serde_json::{Value, json};

/// Tags are read from the last original `<review>` block. Classifications are
/// closed word lists; unreadable output never becomes an approval.
pub(super) fn parse(text: &str) -> Option<Value> {
    let block = text.rfind("<review>").map_or(text, |start| {
        let rest = &text[start + "<review>".len()..];
        rest.find("</review>").map_or(rest, |end| &rest[..end])
    });
    let outcome = word(tag(block, "outcome"))?;
    if outcome != "allow" && outcome != "deny" {
        return None;
    }
    let risk = word(tag(block, "risk_level"));
    if risk
        .as_ref()
        .is_some_and(|risk| !["low", "medium", "high", "critical"].contains(&risk.as_str()))
    {
        return None;
    }
    let authorization = word(tag(block, "user_authorization"));
    if authorization.as_ref().is_some_and(|authorization| {
        !["unknown", "low", "medium", "high"].contains(&authorization.as_str())
    }) {
        return None;
    }
    let rationale = tag(block, "rationale");
    let reason = rationale
        .filter(|reason| {
            !reason
                .trim_matches(super::transcript::js_whitespace)
                .is_empty()
        })
        .unwrap_or(if outcome == "allow" {
            "Auto-review returned a low-risk allow decision."
        } else {
            "Auto-review returned a deny decision without a rationale."
        });
    let mut review = json!({
        "decision":outcome,"reason":normalize(reason),
        "risk":risk.unwrap_or_else(|| if outcome == "allow" { "low" } else { "high" }.to_owned()),
        "userAuthorization":authorization.unwrap_or_else(|| "unknown".to_owned())
    });
    if outcome == "deny" {
        review["denialKind"] = json!("rejected");
    }
    Some(review)
}

/// The reviewer owns critical-risk decisions. High risk independently requires
/// at least medium user authorization, matching the original policy.
pub(super) fn convert(text: &str, user_evidence_omitted: bool) -> Result<Value> {
    let review = parse(text).unwrap_or_else(|| {
        json!({
            "decision":"deny","denialKind":"rejected",
            "reason":"The automatic permission review returned an unreadable decision.",
            "risk":"medium","userAuthorization":"low"
        })
    });
    let allowed = review["decision"] == "allow"
        && (review["risk"] != "high"
            || review["userAuthorization"] == "medium"
            || review["userAuthorization"] == "high");
    let mut decision = json!({"outcome":if allowed {"allowed"} else {"denied"},"reason":review["reason"],"risk":review["risk"],"userAuthorization":review["userAuthorization"]});
    if user_evidence_omitted {
        decision["userEvidenceOmitted"] = json!(true);
    }
    anyhow::ensure!(
        Schemas::new()?.valid("permissionDecision", &decision)?,
        "The automatic permission review decision is invalid."
    );
    Ok(decision)
}

/// Current permission policy fails closed even when a normally completed
/// reviewer allows an action after required human evidence was omitted.
pub(super) fn completed(text: &str, user_evidence_omitted: bool) -> Result<Value> {
    let mut decision = convert(text, user_evidence_omitted)?;
    if user_evidence_omitted {
        decision["outcome"] = json!("denied");
        decision["reason"] = json!(
            "Automatic permission review could not retain complete user authorization evidence. The action has not been proven safe to execute."
        );
    }
    Ok(decision)
}

fn tag<'a>(block: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let start = block.find(&open)? + open.len();
    let rest = &block[start..];
    Some(
        rest.find(&format!("</{name}>"))
            .map_or(rest, |end| &rest[..end]),
    )
}
fn word(value: Option<&str>) -> Option<String> {
    value
        .map(|value| {
            value
                .trim_matches(super::transcript::js_whitespace)
                .to_lowercase()
        })
        .filter(|value| !value.is_empty())
}
fn normalize(reason: &str) -> String {
    let normalized = reason
        .split(super::transcript::js_whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if super::transcript::units(&normalized) <= 240 {
        normalized
    } else {
        let units: Vec<u16> = normalized.encode_utf16().take(237).collect();
        format!("{}…", String::from_utf16_lossy(&units))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_tagged_verdict_defaults_last_block_policy_and_reasons_match_source() {
        for case in super::super::goldens()["reviewCases"].as_array().unwrap() {
            let text = case["text"].as_str().unwrap();
            assert_eq!(parse(text).unwrap_or(Value::Null), case["expected"]);
            assert_eq!(convert(text, false).unwrap(), case["decision"]);
            assert_eq!(convert(text, true).unwrap(), case["omittedDecision"]);
        }
    }

    #[test]
    fn incomplete_user_evidence_never_executes_even_when_the_reviewer_answers_allow() {
        let allow = "<review><outcome>allow</outcome><risk_level>critical</risk_level><user_authorization>high</user_authorization></review>";
        assert_eq!(completed(allow, false).unwrap()["outcome"], "allowed");
        let decision = completed(allow, true).unwrap();
        assert_eq!(decision["outcome"], "denied");
        assert_eq!(decision["userEvidenceOmitted"], true);
        assert!(
            decision["reason"]
                .as_str()
                .unwrap()
                .contains("not been proven")
        );
    }
}
