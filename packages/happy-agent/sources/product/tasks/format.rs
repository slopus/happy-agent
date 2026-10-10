use super::*;
pub fn length(text: &str) -> usize {
    text.encode_utf16().count()
}
pub fn slice(text: &str, start: usize, count: usize) -> String {
    String::from_utf16_lossy(
        &text
            .encode_utf16()
            .skip(start)
            .take(count)
            .collect::<Vec<_>>(),
    )
}
pub fn row(task: &Value) -> String {
    let fixed = format!(
        "{} [{}, {}] ",
        task["id"].as_str().unwrap(),
        task["status"].as_str().unwrap(),
        task["priority"].as_str().unwrap()
    );
    let owner = task["owner"].as_str().map_or(fixed.clone(), |owner| {
        format!("{} ({owner}) ", fixed.trim_end())
    });
    let prefix = if length(&owner) <= 150 { owner } else { fixed };
    let maximum = 200usize.saturating_sub(length(&prefix)).max(1);
    let original = task["title"].as_str().unwrap();
    let title = if length(original) <= maximum {
        original.to_owned()
    } else {
        format!("{}…", slice(original, 0, maximum.saturating_sub(1).max(1)))
    };
    let dependencies = task["dependsOn"].as_array().unwrap();
    let suffix = if dependencies.is_empty() {
        String::new()
    } else {
        format!(
            " [blocked by {}]",
            dependencies
                .iter()
                .map(|id| id.as_str().unwrap())
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let row = format!("{prefix}{title}");
    if length(&row) + length(&suffix) <= 200 {
        format!("{row}{suffix}")
    } else {
        row
    }
}
pub fn tasks(tasks: &[Value]) -> String {
    if tasks.is_empty() {
        return "No tasks.".to_owned();
    }
    let completed = tasks
        .iter()
        .filter(|task| task["status"] == "completed")
        .map(|task| task["id"].clone())
        .collect::<Vec<_>>();
    let full = tasks
        .iter()
        .map(|task| {
            let mut task = task.clone();
            task["dependsOn"]
                .as_array_mut()
                .unwrap()
                .retain(|dependency| !completed.contains(dependency));
            let mut lines = vec![row(&task)];
            for (field, label) in [("activeForm", "Active form"), ("detail", "Detail")] {
                if let Some(value) = task[field].as_str() {
                    lines.push(format!("  {label}: {value}"));
                }
            }
            if let Some(metadata) = task.get("metadata") {
                lines.push(format!("  Metadata: {metadata}"));
            }
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n");
    if length(&full) <= 12000 {
        full
    } else {
        format!("{}\n[task list truncated]", slice(&full, 0, 12000 - 32))
    }
}
pub fn page(page: &Value) -> Result<String> {
    let rows = page["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(row)
        .collect::<Vec<_>>();
    let suffix = page["nextOffset"].as_u64().map_or(String::new(), |offset| {
        format!("\nMore tasks start at offset {offset}.")
    });
    let output = format!(
        "{}{suffix}",
        if rows.is_empty() {
            "No tasks.".to_owned()
        } else {
            rows.join("\n")
        }
    );
    anyhow::ensure!(
        length(&output) <= 12000,
        "Task page exceeds its model-output bound."
    );
    Ok(output)
}
pub fn mutation(text: &str) -> String {
    if length(text) <= 12000 {
        text.to_owned()
    } else {
        let suffix = "\n[truncated]";
        format!("{}{suffix}", slice(text, 0, 12000 - length(suffix)))
    }
}
fn compact_detail(page: &Value, header: bool) -> String {
    let mut lines = Vec::new();
    if header {
        lines.push(page["task"]["id"].as_str().unwrap().to_owned());
    }
    if let Some(detail) = page["detail"].as_str().filter(|detail| !detail.is_empty()) {
        lines.push(format!("Detail: {detail}"));
    }
    if let Some(dependencies) = page["dependencies"]
        .as_array()
        .filter(|values| !values.is_empty())
    {
        lines.push(format!(
            "Depends on: {}",
            dependencies
                .iter()
                .map(|id| id.as_str().unwrap())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    for (field, label) in [
        ("nextDetailOffset", "More detail"),
        ("nextDependencyOffset", "More dependencies"),
    ] {
        if let Some(offset) = page[field].as_u64() {
            lines.push(format!("{label}: {offset}."));
        }
    }
    lines.join("\n")
}
pub fn detail(page: &Value, max: usize) -> Result<String> {
    let task = &page["task"];
    if task.is_null() {
        return Ok("That task does not exist.".to_owned());
    }
    let mut lines = vec![row(task)];
    for (field, label) in [("activeForm", "Active form"), ("owner", "Owner")] {
        if let Some(value) = task[field].as_str() {
            lines.push(format!("{label}: {value}"));
        }
    }
    if !page["detail"].as_str().unwrap().is_empty() {
        lines.push(format!(
            "Detail [{}/{}]: {}",
            page["detailOffset"],
            page["detailTotal"],
            page["detail"].as_str().unwrap()
        ));
    }
    if let Some(dependencies) = page["dependencies"]
        .as_array()
        .filter(|values| !values.is_empty())
    {
        lines.push(format!(
            "Depends on [{}/{}]: {}",
            page["dependencyOffset"],
            page["dependencyTotal"],
            dependencies
                .iter()
                .map(|id| id.as_str().unwrap())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if let Some(blocks) = task["blocks"]
        .as_array()
        .filter(|values| !values.is_empty())
    {
        lines.push(format!(
            "Blocks: {}",
            blocks
                .iter()
                .map(|id| id.as_str().unwrap())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if let Some(metadata) = task.get("metadata") {
        lines.push(format!("Metadata: {metadata}"));
    }
    for (field, label) in [
        ("nextDetailOffset", "More detail"),
        ("nextDependencyOffset", "More dependencies"),
    ] {
        if let Some(offset) = page[field].as_u64() {
            lines.push(format!("{label} starts at offset {offset}."));
        }
    }
    let full = lines.join("\n");
    if length(&full) <= max {
        return Ok(full);
    }
    let compact = compact_detail(page, true);
    if length(&compact) <= max {
        return Ok(compact);
    }
    Ok(compact_detail(page, false))
}
pub fn fit_detail_page(page: &mut Value) -> Result<()> {
    loop {
        let detail_end = page["detailOffset"].as_u64().unwrap()
            + length(page["detail"].as_str().unwrap()) as u64;
        let dependency_end = page["dependencyOffset"].as_u64().unwrap()
            + page["dependencies"].as_array().unwrap().len() as u64;
        for (field, end, total) in [
            (
                "nextDetailOffset",
                detail_end,
                page["detailTotal"].as_u64().unwrap(),
            ),
            (
                "nextDependencyOffset",
                dependency_end,
                page["dependencyTotal"].as_u64().unwrap(),
            ),
        ] {
            if end < total {
                page[field] = json!(end);
            } else {
                page.as_object_mut().unwrap().remove(field);
            }
        }
        let rendered = detail(page, 12000)?;
        if length(&rendered) <= 12000 {
            return Ok(());
        }
        let original = page["detail"].as_str().unwrap();
        let size = length(original);
        if size > 1 {
            page["detail"] = json!(slice(
                original,
                0,
                size.saturating_sub(length(&rendered) - 12000).max(1)
            ));
            continue;
        }
        let dependencies = page["dependencies"].as_array_mut().unwrap();
        if dependencies.len() > 1 {
            dependencies.pop();
            continue;
        }
        anyhow::bail!("The task output bound is too small to show one task identity.");
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_rows_and_detail_match_the_original_source() {
        let golden: Value = serde_json::from_str(include_str!("graph_goldens.json")).unwrap();
        let rows = golden["normalized"]
            .as_array()
            .unwrap()
            .iter()
            .map(row)
            .collect::<Vec<_>>();
        assert_eq!(json!(rows), golden["rows"]);
        assert_eq!(
            detail(&golden["detail"], 12000).unwrap(),
            golden["detailText"]
        );
    }
}
