use super::*;
use std::collections::BTreeSet;
pub const MAX_TIME: u64 = 8_640_000_000_000_000;
pub fn schema(schemas: &Schemas, name: &str, value: &Value, label: &str) -> Result<()> {
    anyhow::ensure!(schemas.valid(name, value)?, "Invalid {label}.");
    Ok(())
}
pub fn cursor(text: &str, label: &str) -> Result<u64> {
    anyhow::ensure!(
        !text.is_empty()
            && (text == "0"
                || (!text.starts_with('0') && text.bytes().all(|byte| byte.is_ascii_digit()))),
        "User input {label} cursor is invalid."
    );
    let value = text
        .parse::<u64>()
        .context(format!("User input {label} cursor is too large."))?;
    anyhow::ensure!(
        value <= 9_007_199_254_740_991,
        "User input {label} cursor is too large."
    );
    Ok(value)
}
pub fn options(options: &Value) -> Result<()> {
    if let Some(choices) = options["choices"].as_array() {
        let mut labels = BTreeSet::new();
        for choice in choices {
            anyhow::ensure!(
                labels.insert(choice["label"].as_str().unwrap()),
                "User input choices must have unique labels."
            );
        }
    }
    Ok(())
}
pub fn answer(answer: &Value, options: &Value) -> Result<()> {
    if answer.is_string() {
        return Ok(());
    }
    if let Some(selected) = answer["selectedOptions"].as_array() {
        let mut seen = BTreeSet::new();
        for label in selected {
            let label = label.as_str().unwrap();
            anyhow::ensure!(
                seen.insert(label),
                "User input answers cannot select one option twice."
            );
            anyhow::ensure!(
                options["choices"]
                    .as_array()
                    .is_some_and(|choices| choices.iter().any(|choice| choice["label"] == label)),
                "User input answer selected an undeclared option \"{label}\"."
            );
        }
        anyhow::ensure!(
            options["multiSelect"] == true || selected.len() <= 1,
            "This user input request permits only one selected option."
        );
    }
    Ok(())
}
pub fn batch_answers(answers: &Value, questions: &[Value]) -> Result<()> {
    let answers = answers.as_object().unwrap();
    anyhow::ensure!(
        answers.len() == questions.len(),
        "A batched user input answer must answer every question."
    );
    for (id, answer_value) in answers {
        let question = questions
            .iter()
            .find(|question| question["id"] == *id)
            .with_context(|| format!("User input answer references unknown question \"{id}\"."))?;
        answer(answer_value, &question["options"])?;
    }
    Ok(())
}
pub fn questions(input: &Value) -> Result<Vec<Value>> {
    let questions = if let Some(questions) = input["questions"].as_array() {
        questions.iter().enumerate().map(|(index,question)|{let mut result=json!({"id":question.get("id").cloned().unwrap_or(json!(format!("question_{}",index+1))),"question":question["question"]});if let Some(header)=question.get("header"){result["header"]=header.clone();}if let Some(options)=question.get("options"){result["options"]=if options.is_array(){json!({"choices":options,"multiSelect":question["multiSelect"].as_bool().unwrap_or(false)})}else{anyhow::ensure!(question.get("multiSelect").is_none()||question["multiSelect"]==options["multiSelect"],"User input question multiSelect disagrees with its options.");options.clone()};}Ok(result)}).collect::<Result<Vec<_>>>()?
    } else {
        let mut question = json!({"id":"question_1","question":input["question"]});
        for field in ["header", "options"] {
            if let Some(value) = input.get(field) {
                question[field] = value.clone();
            }
        }
        vec![question]
    };
    let mut ids = BTreeSet::new();
    for question in &questions {
        anyhow::ensure!(
            ids.insert(question["id"].as_str().unwrap()),
            "Batched user input questions must have unique IDs."
        );
        options(&question["options"])?;
    }
    Ok(questions)
}
pub fn request(schemas: &Schemas, request: &Value) -> Result<()> {
    schema(
        schemas,
        "ownerUserInputRequest",
        request,
        "user input request",
    )?;
    let created = request["createdAt"].as_u64().unwrap();
    anyhow::ensure!(
        request["updatedAt"].as_u64().unwrap() >= created,
        "User input request timestamps are out of order."
    );
    if let Some(deadline) = request["deadlineAt"].as_u64() {
        anyhow::ensure!(
            deadline >= created,
            "User input request deadline precedes its creation."
        );
    }
    options(&request["options"])?;
    if let Some(batch) = request["questions"].as_array() {
        let normalized = questions(&json!({"questions":batch}))?;
        anyhow::ensure!(
            normalized == *batch,
            "User input question batch is invalid."
        );
        let first = &batch[0];
        for field in ["question", "header", "options"] {
            anyhow::ensure!(
                request.get(field) == first.get(field),
                "User input request primary question disagrees with its batch."
            );
        }
    }
    if request["status"] == "answered" {
        answer(&request["answer"], &request["options"])?;
        if let Some(batch) = request["questions"].as_array() {
            anyhow::ensure!(
                request["answers"].is_object(),
                "An answered batch user input request must contain batch answers."
            );
            batch_answers(&request["answers"], batch)?;
        } else {
            anyhow::ensure!(
                request.get("answers").is_none(),
                "A singular user input request cannot contain batch answers."
            );
        }
    }
    for field in ["answeredAt", "cancelledAt", "completedAt", "timedOutAt"] {
        if let Some(at) = request[field].as_u64() {
            anyhow::ensure!(
                at >= created,
                "User input outcome timestamp precedes request creation."
            );
        }
    }
    if request["status"] == "timed_out" {
        if let Some(at) = request["timedOutAt"].as_u64() {
            anyhow::ensure!(
                at >= request["deadlineAt"].as_u64().unwrap(),
                "User input timeout timestamp precedes its deadline."
            );
        }
    }
    Ok(())
}
pub fn deadline(request: &Value) -> Option<u64> {
    let absolute = request["deadlineAt"].as_u64();
    let relative = request["autoResolutionMs"].as_u64().map(|duration| {
        request["createdAt"]
            .as_u64()
            .unwrap()
            .saturating_add(duration)
            .min(MAX_TIME)
    });
    match (absolute, relative) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (left, right) => left.or(right),
    }
}
pub fn answer_characters(answer: &Value) -> usize {
    if let Some(text) = answer.as_str() {
        return text.encode_utf16().count();
    }
    answer["text"]
        .as_str()
        .map_or(0, |text| text.encode_utf16().count())
        + answer["selectedOptions"].as_array().map_or(0, |selected| {
            selected
                .iter()
                .map(|label| label.as_str().unwrap().encode_utf16().count())
                .sum()
        })
}
