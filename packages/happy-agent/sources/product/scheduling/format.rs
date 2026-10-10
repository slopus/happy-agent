use super::*;
pub fn wait(result: &Value) -> String {
    let elapsed = time::human(result["elapsedMs"].as_u64().unwrap());
    if result["outcome"] == "interrupted" {
        format!("The wait ended early because a new message arrived after {elapsed}.")
    } else {
        format!("The wait finished after {elapsed}.")
    }
}
fn status(status: &str) -> &'static str {
    match status {
        "pending" => "waiting to be delivered",
        "delivered" => "delivered",
        "undelivered" => "not delivered",
        "cancelled" => "cancelled before delivery",
        _ => unreachable!("The scheduling state was validated."),
    }
}
pub fn schedule(schedule: &Value) -> Result<String> {
    let recipient = if schedule["senderAgentId"] == schedule["targetAgentId"] {
        "yourself".to_owned()
    } else {
        format!("agent {}", schedule["targetAgentId"].as_str().unwrap())
    };
    Ok(format!(
        "Message {} to {recipient} is {}; due {}.",
        schedule["id"].as_str().unwrap(),
        status(schedule["status"].as_str().unwrap()),
        time::iso(schedule["dueAt"].as_u64().unwrap())?
    ))
}
pub fn cancellation(schedule: &Value) -> String {
    format!(
        "Message {} is now {}.",
        schedule["id"].as_str().unwrap(),
        status(schedule["status"].as_str().unwrap())
    )
}
pub fn page(page: &Value, max: usize) -> Result<String> {
    let schedules = page["schedules"].as_array().unwrap();
    if schedules.is_empty() {
        return Ok("You have no scheduled messages.".to_owned());
    }
    let start = if let Some(next) = page["nextCursor"].as_str() {
        persistence::cursor(next)?
            .checked_sub(schedules.len() as u64)
            .context("Scheduling page cursor precedes its rows.")?
    } else if let Some(previous) = page["previousCursor"].as_str() {
        persistence::cursor(previous)? + page["limit"].as_u64().unwrap()
    } else {
        0
    };
    let mut best = None;
    for visible in 1..=schedules.len() {
        let mut lines = schedules[..visible]
            .iter()
            .map(|schedule| {
                Ok(format!(
                    "{} | to {} | {} | due {}",
                    schedule["id"].as_str().unwrap(),
                    schedule["targetAgentId"].as_str().unwrap(),
                    status(schedule["status"].as_str().unwrap()),
                    time::iso(schedule["dueAt"].as_u64().unwrap())?
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        if let Some(previous) = page["previousCursor"].as_str() {
            lines.push(format!("Earlier messages start at cursor {previous}."));
        }
        if visible < schedules.len() || page.get("nextCursor").is_some() {
            lines.push(format!(
                "More messages start at cursor {}.",
                start + visible as u64
            ));
        }
        let text = lines.join("\n");
        if text.encode_utf16().count() > max {
            break;
        }
        best = Some(text);
    }
    best.context("A scheduled message does not fit the model output budget.")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn user_visible_scheduling_output_matches_original_goldens() {
        let golden: Value = serde_json::from_str(include_str!("time_goldens.json")).unwrap();
        assert_eq!(wait(&golden["wait"]), golden["waitText"]);
        assert_eq!(
            schedule(&golden["schedule"]).unwrap(),
            golden["scheduleText"]
        );
        assert_eq!(
            cancellation(&golden["schedule"]),
            golden["cancellationText"]
        );
        assert_eq!(
            page(&golden["page"], 8000).unwrap(),
            golden["pageText"]["text"]
        );
    }
}
