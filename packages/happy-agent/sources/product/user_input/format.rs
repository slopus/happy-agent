use super::*;
pub const OUTPUT: usize = 8000;
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
pub fn fit(text: &str, max: usize) -> String {
    if length(text) <= max {
        text.to_owned()
    } else if max <= 1 {
        "…".chars().take(max).collect()
    } else {
        format!("{}…", slice(text, 0, max - 1))
    }
}
pub fn questions(request: &Value) -> String {
    let questions = if let Some(questions) = request["questions"].as_array() {
        questions.clone()
    } else {
        vec![
            json!({"question":request["question"],"header":request.get("header"),"options":request.get("options")}),
        ]
    };
    questions
        .iter()
        .map(|question| {
            let header = question["header"]
                .as_str()
                .map_or(String::new(), |header| format!("[{header}] "));
            let options =
                question["options"]["choices"]
                    .as_array()
                    .map_or(String::new(), |choices| {
                        format!(
                            "\nOptions:\n{}",
                            choices
                                .iter()
                                .map(|choice| format!(
                                    "- {}: {}",
                                    choice["label"].as_str().unwrap(),
                                    choice["description"].as_str().unwrap()
                                ))
                                .collect::<Vec<_>>()
                                .join("\n")
                        )
                    });
            format!(
                "{header}{}{options}",
                question["question"].as_str().unwrap()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn answer(answer: &Value) -> String {
    if let Some(text) = answer.as_str() {
        return text.to_owned();
    }
    let mut lines = Vec::new();
    if let Some(selected) = answer["selectedOptions"].as_array() {
        lines.push(format!(
            "Selected: {}",
            selected
                .iter()
                .map(|label| label.as_str().unwrap())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if let Some(text) = answer["text"].as_str() {
        lines.push(text.to_owned());
    }
    lines.join("\n")
}
fn answers(request: &Value) -> String {
    if let Some(answers) = request["answers"].as_object() {
        answers
            .iter()
            .map(|(id, value)| format!("{id}: {}", answer(value)))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        answer(&request["answer"])
    }
}
fn duration(milliseconds: u64) -> String {
    let seconds = (milliseconds + 500) / 1000;
    let (count, unit) = if seconds < 90 {
        (seconds, "second")
    } else {
        let minutes = (seconds + 30) / 60;
        if minutes < 60 {
            (minutes, "minute")
        } else {
            let hours = (minutes + 30) / 60;
            if hours < 24 {
                (hours, "hour")
            } else {
                ((hours + 12) / 24, "day")
            }
        }
    };
    format!("{count} {unit}{}", if count == 1 { "" } else { "s" })
}
pub fn label(request: &Value) -> String {
    match request["status"].as_str().unwrap() {
        "pending" => "Waiting for an answer".to_owned(),
        "answered" => "Answered".to_owned(),
        "cancelled" => "Cancelled".to_owned(),
        _ => {
            let presence = &request["presence"];
            let title = presence["title"].as_str().unwrap_or("unavailable");
            let emoji = presence["emoji"].as_str().unwrap_or("⚠️");
            let opening = if request["status"] == "away" {
                format!(
                    "The question was not asked interactively because the user is {title} {emoji}."
                )
            } else {
                let waited = request["waitedMs"]
                    .as_u64()
                    .map_or("the configured wait".to_owned(), duration);
                format!("Nobody answered within {waited}, and the user is {title} {emoji}.")
            };
            let mut sentences = vec![opening];
            if let Some(prompt) = presence["prompt"]
                .as_str()
                .map(str::trim)
                .filter(|prompt| !prompt.is_empty())
            {
                sentences.push(prompt.to_owned());
            }
            if let Some(change) = presence["changesAt"]
                .as_u64()
                .filter(|at| *at > request["updatedAt"].as_u64().unwrap())
            {
                sentences.push(format!(
                    "The user expects to change this state in about {}.",
                    duration(change - request["updatedAt"].as_u64().unwrap())
                ));
            }
            sentences.push(format!("The question is waiting in the user's inbox as ask {}; call cancel_ask with that id if you no longer need an answer.",request["id"].as_str().unwrap()));
            sentences.push("Continue on your own with your best judgement.".to_owned());
            sentences.join(" ")
        }
    }
}
pub fn request(request: &Value, max: usize) -> String {
    let mut lines = vec![
        format!("Request {}:", request["id"].as_str().unwrap()),
        questions(request),
        format!("Status: {}", label(request)),
    ];
    if request["status"] == "answered" {
        lines.push(format!("Answer:\n{}", answers(request)));
    }
    if request["status"] == "cancelled" {
        lines.push(format!("Reason: {}", request["reason"].as_str().unwrap()));
    }
    fit(&lines.join("\n"), max)
}
pub fn detail(request: &Value) -> String {
    let mut lines = vec![
        format!("Questions:\n{}", questions(request)),
        format!("Context:\n{}", request["context"].as_str().unwrap()),
    ];
    if request["status"] == "answered" {
        lines.push(format!("Answer:\n{}", answers(request)));
    }
    if request["status"] == "cancelled" {
        lines.push(format!(
            "Cancellation reason:\n{}",
            request["reason"].as_str().unwrap()
        ));
    }
    lines.join("\n\n")
}
pub fn page(page: &Value, max: usize) -> Result<String> {
    let requests = page["requests"].as_array().unwrap();
    if requests.is_empty() {
        return Ok("No user input requests.".to_owned());
    }
    let mut lines = Vec::new();
    for request in requests {
        let line = format!(
            "{} · {} · {}",
            request["id"].as_str().unwrap(),
            label(request),
            request["question"].as_str().unwrap()
        );
        let candidate = lines
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(line.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
        if length(&candidate) > max {
            break;
        }
        lines.push(line);
    }
    anyhow::ensure!(
        !lines.is_empty(),
        "User input page cannot fit the output budget."
    );
    if lines.len() < requests.len() || page.get("nextCursor").is_some() {
        let next = page["nextCursor"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                (validation::cursor(page["cursor"].as_str().unwrap(), "requests").unwrap()
                    + lines.len() as u64)
                    .to_string()
            });
        lines.push(format!("Next cursor: {next}"));
    }
    Ok(fit(&lines.join("\n"), max))
}
pub fn detail_page(page: &Value, max: usize) -> String {
    if page["request"].is_null() {
        return "User input request not found.".to_owned();
    }
    let continuation = page["nextCursor"]
        .as_str()
        .map_or(String::new(), |cursor| format!("\nNext cursor: {cursor}"));
    fit(
        &format!(
            "{}\n{}{continuation}",
            request(&page["request"], max),
            page["detail"].as_str().unwrap()
        ),
        max,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rendering_matches_the_exported_original_formatter() {
        let goldens: Value = serde_json::from_str(include_str!("format_goldens.json")).unwrap();
        for case in goldens["requests"].as_array().unwrap() {
            assert_eq!(request(&case["request"], OUTPUT), case["text"]);
            assert_eq!(request(&case["request"], 20), case["short"]);
        }
        assert_eq!(page(&goldens["page"], OUTPUT).unwrap(), goldens["pageText"]);
        assert_eq!(
            detail_page(&goldens["detail"], OUTPUT),
            goldens["detailText"]
        );
    }
}
