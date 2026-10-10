//! An MCP server's request for more input, asked as an ordinary question.
//!
//! A server describes the values it wants with a small JSON Schema; each property becomes one
//! question, and the person's answers are turned back into the values the schema declared. A
//! server that named the values it accepts gets one of them or nothing, and anything that does not
//! fit is declined rather than invented.

use std::collections::{HashMap, HashSet};
use std::future::Future;

use serde_json::{Map, Value, json};

use super::super::text::{js_display, js_json_number, js_length, js_slice, js_trim, js_trim_end};

use super::schemas::{self, ELICITATION_REQUEST, ELICITATION_RESULT};

fn decline() -> Value {
    json!({"action": "decline"})
}

fn is_primitive(value: &Value) -> bool {
    value.is_string() || value.as_f64().is_some_and(f64::is_finite) || value.is_boolean()
}

fn constants(items: &[Value]) -> Vec<Value> {
    items.iter().filter_map(|item| item.as_object().and_then(|item| item.get("const")).cloned()).filter(is_primitive).collect()
}

/// The values the server said it accepts, or none when it named none.
fn declared_choices(record: &Map<String, Value>) -> Option<Vec<Value>> {
    if let Some(Value::Array(values)) = record.get("enum") {
        return Some(values.iter().filter(|value| is_primitive(value)).cloned().collect());
    }
    if let Some(Value::Array(options)) = record.get("oneOf") {
        return Some(constants(options));
    }
    let items = record.get("items").and_then(Value::as_object);
    if record.get("type").and_then(Value::as_str) == Some("array") {
        if let Some(Value::Array(values)) = items.and_then(|items| items.get("enum")) {
            return Some(values.iter().filter(|value| is_primitive(value)).cloned().collect());
        }
        if let Some(Value::Array(options)) = items.and_then(|items| items.get("anyOf")) {
            return Some(constants(options));
        }
    }
    None
}

fn titles(options: &[Value]) -> Vec<Option<Value>> {
    options.iter().map(|option| option.as_object().and_then(|option| option.get("title")).filter(|title| !title.is_null()).cloned()).collect()
}

/// The label of each choice, positioned as the original read them.
fn choice_names(record: &Map<String, Value>, values: &[Value]) -> Vec<Option<Value>> {
    if let Some(Value::Array(names)) = record.get("enumNames") {
        return names.iter().map(|name| (!name.is_null()).then(|| name.clone())).collect();
    }
    if let Some(Value::Array(options)) = record.get("oneOf") {
        return titles(options);
    }
    if record.get("type").and_then(Value::as_str) == Some("array") {
        if let Some(Value::Array(options)) = record.get("items").and_then(|items| items.get("anyOf")) {
            return titles(options);
        }
    }
    if record.get("type").and_then(Value::as_str) == Some("boolean") {
        return vec![Some(json!("Yes")), Some(json!("No"))];
    }
    values.iter().cloned().map(Some).collect()
}

/// `Number(text)` for an answer string.
pub(super) fn js_to_number(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, base: u32| u64::from_str_radix(digits, base).map(|value| value as f64).unwrap_or(f64::NAN);
    match trimmed.get(..2) {
        Some("0x" | "0X") => return radix(&trimmed[2..], 16),
        Some("0o" | "0O") => return radix(&trimmed[2..], 8),
        Some("0b" | "0B") => return radix(&trimmed[2..], 2),
        _ => {}
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let decimal = trimmed.chars().all(|character| character.is_ascii_digit() || matches!(character, '.' | 'e' | 'E' | '+' | '-'));
    if !decimal {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// Ask the questions an elicitation describes through `ask`, which takes the question batch and
/// answers `{ status, answers? }` with each answer as a list of strings. A question that could not
/// be asked fails the elicitation, which the server receives as an error.
pub async fn handle_elicitation<F, Fut, E>(request: &Value, ask: F) -> Result<Value, E>
where
    F: FnOnce(Value) -> Fut,
    Fut: Future<Output = Result<Value, E>>,
{
    if !schemas::check(&ELICITATION_REQUEST, request) {
        return Ok(decline());
    }
    let message = request["params"]["message"].as_str().unwrap_or_default().to_string();
    let requested = &request["params"]["requestedSchema"];
    let required: HashSet<&str> =
        requested.get("required").and_then(Value::as_array).map(|keys| keys.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let empty = Map::new();
    let entries: Vec<(&String, &Map<String, Value>)> =
        requested["properties"].as_object().unwrap_or(&empty).iter().map(|(id, property)| (id, property.as_object().unwrap_or(&empty))).collect();
    let mut labels_by_id: HashMap<&str, HashMap<String, Value>> = HashMap::new();
    let mut declared_ids: HashSet<&str> = HashSet::new();
    let mut questions = Vec::new();
    for (id, record) in &entries {
        let declared = declared_choices(record);
        if declared.is_some() {
            declared_ids.insert(id.as_str());
        }
        let values = declared.unwrap_or_else(|| {
            if record.get("type").and_then(Value::as_str) == Some("boolean") { vec![json!("true"), json!("false")] } else { Vec::new() }
        });
        let names = choice_names(record, &values);
        let label = |index: usize, value: &Value| js_display(names.get(index).cloned().flatten().as_ref().unwrap_or(value));
        let mut labels = HashMap::new();
        for (index, value) in values.iter().enumerate() {
            labels.insert(label(index, value), value.clone());
        }
        labels_by_id.insert(id.as_str(), labels);
        let raw_title = match record.get("title").and_then(Value::as_str) {
            Some(title) => js_trim(title).to_string(),
            None => id.to_string(),
        };
        let header = if js_length(&raw_title) > 12 { format!("{}…", js_trim_end(js_slice(&raw_title, 0, 11))) } else { raw_title };
        let description = record.get("description").and_then(Value::as_str);
        let kind = record.get("type").and_then(Value::as_str);
        let options: Vec<Value> = values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                let text = label(index, value);
                let detail = match (description, kind) {
                    (Some(description), _) => description.to_string(),
                    (None, Some("boolean")) => format!("Answer {text}."),
                    (None, _) => format!("Use {}.", js_display(value)),
                };
                json!({"label": text, "description": detail})
            })
            .collect();
        let mut question = json!({
            "header": if header.is_empty() { "MCP request".to_string() } else { header },
            "id": id,
            "multiSelect": kind == Some("array"),
            "options": options,
            "question": description.map_or_else(|| message.clone(), str::to_string),
        });
        if required.contains(id.as_str()) {
            question["required"] = json!(true);
        }
        questions.push(question);
    }
    // The original named the question `mcp:<uuid>`, which the answer route never accepted, so no
    // client could answer it. The question is named like every other identifier instead.
    let request_id = cuid2::create_id();

    if questions.is_empty() {
        let response = ask(json!({
            "requestId": request_id,
            "questions": [{
                "header": "MCP request",
                "id": "confirmation",
                "multiSelect": false,
                "options": [
                    {"label": "Continue", "description": "Accept this request without providing additional values."},
                    {"label": "Decline", "description": "Reject this request."}
                ],
                "question": message
            }]
        }))
        .await?;
        let continued = response["status"] == "answered"
            && response["answers"]["confirmation"].as_array().is_some_and(|answers| answers.iter().any(|answer| answer == "Continue"));
        return Ok(if continued { json!({"action": "accept", "content": {}}) } else { decline() });
    }

    let response = ask(json!({"requestId": request_id, "questions": questions})).await?;
    if response["status"] != "answered" {
        return Ok(decline());
    }
    let mut content = Map::new();
    for (id, record) in &entries {
        let answers: Vec<String> = response["answers"]
            .get(id.as_str())
            .and_then(Value::as_array)
            .map(|answers| answers.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let labels = &labels_by_id[id.as_str()];
        if declared_ids.contains(id.as_str()) && answers.iter().any(|answer| !labels.contains_key(answer)) {
            return Ok(decline());
        }
        let normalized: Vec<Value> = answers.iter().map(|answer| labels.get(answer).cloned().unwrap_or_else(|| json!(answer))).collect();
        let kind = record.get("type").and_then(Value::as_str);
        let raw = if kind == Some("array") { Some(Value::Array(normalized)) } else { normalized.into_iter().next() };
        let raw = match raw {
            Some(Value::Array(items)) if items.is_empty() => None,
            other => other,
        };
        let Some(raw) = raw else {
            if required.contains(id.as_str()) {
                return Ok(decline());
            }
            continue;
        };
        let value = match (kind, &raw) {
            (Some("boolean"), Value::String(text)) => match text.as_str() {
                "true" => json!(true),
                "false" => json!(false),
                _ => return Ok(decline()),
            },
            (Some("number" | "integer"), Value::String(text)) => {
                let number = js_to_number(text);
                if !number.is_finite() || (kind == Some("integer") && number.fract() != 0.0) {
                    return Ok(decline());
                }
                js_json_number(number)
            }
            _ => raw,
        };
        content.insert(id.to_string(), value);
    }
    let result = json!({"action": "accept", "content": content});
    Ok(if schemas::check(&ELICITATION_RESULT, &result) { result } else { decline() })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn elicit(request: Value, answer: Value) -> Value {
        let asked = std::sync::Arc::new(std::sync::Mutex::new(None));
        let seen = asked.clone();
        let result = handle_elicitation(&request, move |questions| {
            *seen.lock().unwrap() = Some(questions);
            async move { Ok::<Value, std::convert::Infallible>(answer) }
        })
        .await
        .unwrap();
        let mut asked = asked.lock().unwrap().take();
        if let Some(asked) = asked.as_mut() {
            asked["requestId"] = json!("mcp:<uuid>");
        }
        match asked {
            Some(asked) => json!({"asked": asked, "result": result}),
            None => json!({"result": result}),
        }
    }

    #[tokio::test]
    async fn elicitations_become_the_questions_and_values_the_original_produced() {
        let golden: Value = serde_json::from_str(include_str!("goldens/elicitation.json")).unwrap();
        let request = |params: Value| json!({"method": "elicitation/create", "params": params});
        let empty = || json!({"message": "Proceed?", "requestedSchema": {"type": "object", "properties": {}}});
        let cases = [
            ("confirmation", request(empty()), json!({"status": "answered", "answers": {"confirmation": ["Continue"]}})),
            ("confirmationDeclined", request(empty()), json!({"status": "answered", "answers": {"confirmation": ["Decline"]}})),
            (
                "form",
                request(json!({"message": "Configure the deploy.", "requestedSchema": {"type": "object", "properties": {
                    "environment": {"type": "string", "title": "Target environment name", "enum": ["staging", "production"], "enumNames": ["Staging", "Production"]},
                    "replicas": {"type": "integer", "description": "How many replicas?"},
                    "confirm": {"type": "boolean", "title": "Confirm"},
                    "regions": {"type": "array", "items": {"anyOf": [{"const": "eu", "title": "Europe"}, {"const": "us", "title": "United States"}]}},
                    "note": {"type": "string"}
                }, "required": ["environment", "replicas"]}})),
                json!({"status": "answered", "answers": {"environment": ["Production"], "replicas": ["3"], "confirm": ["Yes"], "regions": ["Europe", "United States"]}}),
            ),
            (
                "invalidChoice",
                request(json!({"message": "Pick", "requestedSchema": {"type": "object", "properties": {"env": {"type": "string", "enum": ["a", "b"]}}}})),
                json!({"status": "answered", "answers": {"env": ["c"]}}),
            ),
            (
                "fractional",
                request(json!({"message": "N", "requestedSchema": {"type": "object", "properties": {"n": {"type": "integer"}}}})),
                json!({"status": "answered", "answers": {"n": ["1.5"]}}),
            ),
            (
                "cancelled",
                request(json!({"message": "N", "requestedSchema": {"type": "object", "properties": {"n": {"type": "number"}}}})),
                json!({"status": "cancelled"}),
            ),
            (
                "missingRequired",
                request(json!({"message": "N", "requestedSchema": {"type": "object", "properties": {"n": {"type": "number"}}, "required": ["n"]}})),
                json!({"status": "answered", "answers": {}}),
            ),
            (
                "withMode",
                request(json!({"mode": "form", "message": "N", "requestedSchema": {"type": "object", "properties": {}}})),
                json!({"status": "answered", "answers": {"confirmation": ["Continue"]}}),
            ),
        ];
        for (name, request, answer) in cases {
            assert_eq!(elicit(request, answer).await, golden[name], "{name}");
        }
        assert_eq!(js_to_number(" 0x10 "), 16.0);
        assert_eq!(js_to_number(""), 0.0);
        assert!(js_to_number("3abc").is_nan());
    }
}
