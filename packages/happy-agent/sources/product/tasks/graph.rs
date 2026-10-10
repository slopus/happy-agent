use super::*;
use std::collections::{BTreeMap, BTreeSet};
pub fn trim(text: &str) -> &str {
    text.trim_matches(|character|matches!(character,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
pub fn normalized(schemas: &Schemas, field: &str, value: &Value) -> Result<Option<Value>> {
    if value.is_null() {
        return Ok(None);
    }
    let text = trim(value.as_str().unwrap());
    let (schema, message) = match field {
        "title" => (
            "ownerTaskTitle",
            "Task title must not be empty and must be at most 500 characters.",
        ),
        "detail" => (
            "ownerTaskDetail",
            "Task detail must be at most 4000 characters.",
        ),
        "activeForm" => (
            "ownerTaskActiveForm",
            "Task active form must not be empty and must be at most 500 characters.",
        ),
        "owner" => (
            "ownerTaskOwner",
            "Task owner must not be empty and must be at most 256 characters.",
        ),
        _ => unreachable!(),
    };
    require(schemas.valid(schema, &json!(text))?, message)?;
    if field == "detail" && text.is_empty() {
        Ok(None)
    } else {
        Ok(Some(json!(text)))
    }
}
pub fn metadata(value: &Value) -> Result<()> {
    let mut pending = vec![(value, 0)];
    while let Some((value, depth)) = pending.pop() {
        require(depth <= 8, "Task metadata is nested too deeply.")?;
        if let Some(values) = value.as_array() {
            pending.extend(values.iter().map(|value| (value, depth + 1)));
        }
        if let Some(values) = value.as_object() {
            pending.extend(values.values().map(|value| (value, depth + 1)));
        }
    }
    require(
        value.to_string().len() <= 16384,
        "Task metadata exceeds its encoded size bound.",
    )
}
pub fn sync(tasks: &mut [Value]) {
    let mut blocks = tasks
        .iter()
        .map(|task| (task["id"].as_str().unwrap().to_owned(), Vec::<Value>::new()))
        .collect::<BTreeMap<_, _>>();
    let mut ordered = tasks.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|task| task["ordering"].as_u64().unwrap());
    for task in ordered {
        for dependency in task["dependsOn"].as_array().unwrap() {
            if let Some(blocked) = blocks.get_mut(dependency.as_str().unwrap()) {
                if !blocked.contains(&task["id"]) {
                    blocked.push(task["id"].clone());
                }
            }
        }
    }
    for task in tasks {
        task["blocks"] = json!(blocks.remove(task["id"].as_str().unwrap()).unwrap());
    }
}
pub fn dependencies(tasks: &[Value], id: &str, dependencies: &[Value]) -> Result<()> {
    for dependency in dependencies {
        let dependency = dependency.as_str().unwrap();
        require(
            dependency != id,
            format!("Task \"{id}\" cannot depend on itself."),
        )?;
        require(
            tasks.iter().any(|task| task["id"] == dependency),
            format!("Task dependency \"{dependency}\" does not exist."),
        )?;
    }
    Ok(())
}
pub fn cycle(tasks: &[Value]) -> bool {
    fn visit<'a>(
        id: &'a str,
        tasks: &'a [Value],
        visiting: &mut BTreeSet<&'a str>,
        visited: &mut BTreeSet<&'a str>,
    ) -> bool {
        if visiting.contains(id) {
            return true;
        }
        if visited.contains(id) {
            return false;
        }
        visiting.insert(id);
        if let Some(task) = tasks.iter().find(|task| task["id"] == id) {
            for dependency in task["dependsOn"].as_array().unwrap() {
                if visit(dependency.as_str().unwrap(), tasks, visiting, visited) {
                    return true;
                }
            }
        }
        visiting.remove(id);
        visited.insert(id);
        false
    }
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    tasks.iter().any(|task| {
        visit(
            task["id"].as_str().unwrap(),
            tasks,
            &mut visiting,
            &mut visited,
        )
    })
}
pub fn validate(schemas: &Schemas, tasks: &[Value]) -> Result<()> {
    require(
        tasks.len() <= 100 && schemas.valid("ownerTaskList", &json!(tasks))?,
        "The task list exceeds its bounds or has an invalid shape.",
    )?;
    let mut ids = BTreeSet::new();
    for task in tasks {
        require(
            ids.insert(task["id"].as_str().unwrap()),
            "Task IDs must be unique.",
        )?;
    }
    let mut orderings = tasks
        .iter()
        .map(|task| task["ordering"].as_u64().unwrap())
        .collect::<Vec<_>>();
    orderings.sort_unstable();
    require(
        orderings
            .iter()
            .enumerate()
            .all(|(index, ordering)| *ordering == index as u64),
        "Task ordering must be unique and contiguous from zero.",
    )?;
    require(!cycle(tasks), "Task dependencies cannot contain a cycle.")?;
    for task in tasks {
        let id = task["id"].as_str().unwrap();
        require(
            task["updatedAt"].as_u64().unwrap() >= task["createdAt"].as_u64().unwrap(),
            format!("Task \"{id}\" has an invalid timestamp order."),
        )?;
        for field in ["title", "detail", "activeForm", "owner"] {
            if let Some(value) = task.get(field) {
                require(
                    normalized(schemas, field, value)?.as_ref() == Some(value),
                    format!("Task \"{id}\" has an invalid {field}."),
                )?;
            }
        }
        if let Some(value) = task.get("metadata") {
            metadata(value)?;
        }
        dependencies(tasks, id, task["dependsOn"].as_array().unwrap())?;
    }
    let mut expected = tasks.to_vec();
    sync(&mut expected);
    for (task, expected) in tasks.iter().zip(expected) {
        require(
            task["blocks"] == expected["blocks"],
            format!(
                "Task \"{}\" has inconsistent reverse dependencies.",
                task["id"].as_str().unwrap()
            ),
        )?;
    }
    Ok(())
}
pub fn append(values: &mut Vec<Value>, additions: &[Value]) {
    for addition in additions {
        if !values.contains(addition) {
            values.push(addition.clone());
        }
    }
}
pub fn same_task(left: &Value, right: &Value) -> bool {
    [
        "id",
        "title",
        "detail",
        "activeForm",
        "owner",
        "status",
        "priority",
        "dependsOn",
        "blocks",
        "createdAt",
        "updatedAt",
        "ordering",
    ]
    .iter()
    .all(|field| left.get(field) == right.get(field))
        && left.get("metadata").map(Value::to_string) == right.get("metadata").map(Value::to_string)
}
pub fn compact(tasks: &mut [Value], at: u64) {
    tasks.sort_by_key(|task| task["ordering"].as_u64().unwrap());
    for (index, task) in tasks.iter_mut().enumerate() {
        if task["ordering"] != index {
            task["ordering"] = json!(index);
            task["updatedAt"] = json!(at);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dependency_edges_and_normalization_match_original_source() {
        let schemas = Schemas::new().unwrap();
        let golden: Value = serde_json::from_str(include_str!("graph_goldens.json")).unwrap();
        let mut tasks = golden["input"].as_array().unwrap().clone();
        sync(&mut tasks);
        assert_eq!(json!(tasks), golden["normalized"]);
        validate(&schemas, &tasks).unwrap();
        let mut cyclic = tasks.clone();
        cyclic[0]["dependsOn"] = json!(["second"]);
        assert_eq!(cycle(&cyclic), golden["cycle"]);
        for case in golden["titleNormalization"].as_array().unwrap() {
            assert_eq!(
                normalized(&schemas, "title", &case["input"])
                    .unwrap()
                    .unwrap(),
                case["normalized"]
            );
        }
        for case in golden["detailNormalization"].as_array().unwrap() {
            assert_eq!(
                normalized(&schemas, "detail", &case["input"])
                    .unwrap()
                    .unwrap_or(Value::Null),
                case["normalized"]
            );
        }
    }
}
