use super::*;
pub fn length(text: &str) -> usize {
    text.encode_utf16().count()
}
pub fn slice(text: &str, count: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(count).collect::<Vec<_>>())
}
pub fn trim(text: &str) -> &str {
    text.trim_matches(|character|matches!(character,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(|character|matches!(character,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
pub fn terminal(run: &Value) -> bool {
    matches!(
        run["status"].as_str(),
        Some("completed" | "failed" | "cancelled")
    )
}
pub fn status(run: &Value) -> &str {
    if run["status"] == "paused" {
        "paused, and can be resumed"
    } else {
        run["status"].as_str().unwrap()
    }
}
pub fn bound(text: String) -> String {
    if length(&text) <= 12000 {
        text
    } else {
        format!("{}…", slice(&text, 11999))
    }
}
pub fn run(run: &Value) -> String {
    let mut lines = vec![
        format!(
            "{} ({}) is {}.",
            run["workflow"].as_str().unwrap(),
            run["id"].as_str().unwrap(),
            status(run)
        ),
        run["description"].as_str().unwrap().to_owned(),
        format!("Agents started: {}.", run["agentCount"]),
    ];
    if let Some(phase) = run["phase"].as_str() {
        lines.push(format!("Current phase: {phase}."));
    }
    if let Some(error) = run["error"].as_str() {
        lines.push(format!("It failed with: {error}"));
    }
    if let Some(output) = run["output"].as_str() {
        lines.extend([String::new(), "Result:".to_owned(), output.to_owned()]);
    }
    let logs = run["logs"].as_array().unwrap();
    if !logs.is_empty() {
        lines.extend([
            String::new(),
            if run["logsTruncated"] == true {
                "Latest progress notes:"
            } else {
                "Progress notes:"
            }
            .to_owned(),
        ]);
        lines.extend(logs.iter().map(|line| line.as_str().unwrap().to_owned()));
    }
    bound(lines.join("\n"))
}
pub fn page(page: &Value) -> String {
    let runs = page["runs"].as_array().unwrap();
    if runs.is_empty() {
        return "No workflow runs.".to_owned();
    }
    let mut lines = runs
        .iter()
        .map(|run| {
            format!(
                "{} ({}) — {}, {} agents.",
                run["workflow"].as_str().unwrap(),
                run["id"].as_str().unwrap(),
                status(run),
                run["agentCount"]
            )
        })
        .collect::<Vec<_>>();
    if let Some(cursor) = page["nextCursor"].as_u64() {
        lines.push(format!("More runs follow; read from {cursor}."));
    }
    bound(lines.join("\n"))
}
pub fn logs(page: &Value) -> String {
    let lines = page["lines"].as_array().unwrap();
    if lines.is_empty() {
        return "This workflow has recorded no progress notes.".to_owned();
    }
    let mut lines = lines
        .iter()
        .map(|line| {
            format!(
                "{}. {}",
                line["position"].as_u64().unwrap() + 1,
                line["text"].as_str().unwrap()
            )
        })
        .collect::<Vec<_>>();
    if let Some(cursor) = page["nextCursor"].as_u64() {
        lines.push(format!("More notes follow; read from {cursor}."));
    }
    bound(lines.join("\n"))
}
pub fn serialize(value: &Value) -> Result<String> {
    let serialized = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or(serde_json::to_string_pretty(value)?);
    Ok(if length(&serialized) <= 100000 {
        serialized
    } else {
        format!("{}\n… output truncated", slice(&serialized, 100000))
    })
}
pub fn base(run: &Value) -> Value {
    let mut run = run.clone();
    for field in ["status", "pausedAt", "finishedAt", "output", "error"] {
        run.as_object_mut().unwrap().remove(field);
    }
    run
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workflow_display_matches_original_source() {
        let golden: Value = serde_json::from_str(include_str!("format_goldens.json")).unwrap();
        for case in golden["runs"].as_array().unwrap() {
            assert_eq!(run(&case["run"]), case["text"]);
        }
        assert_eq!(page(&golden["page"]["page"]), golden["page"]["text"]);
        assert_eq!(logs(&golden["logs"]["page"]), golden["logs"]["text"]);
        assert_eq!(page(&json!({"runs":[]})), golden["emptyPage"]);
        assert_eq!(logs(&json!({"lines":[]})), golden["emptyLogs"]);
        for case in golden["serialized"].as_array().unwrap() {
            assert_eq!(serialize(&case["value"]).unwrap(), case["text"]);
        }
    }
}
