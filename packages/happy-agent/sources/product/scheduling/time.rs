use super::*;
pub const DAY: u64 = 86_400_000;
pub fn duration(schemas: &Schemas, input: &Value) -> Result<u64> {
    valid(
        schemas,
        "ownerSchedulingDuration",
        input,
        "Scheduling duration",
    )?;
    let amount = if let Some(text) = input.as_str() {
        let normalized = text.trim().to_lowercase();
        anyhow::ensure!(!normalized.is_empty(), "Provide a duration.");
        let expression = regex_lite::Regex::new(r"(\d+(?:\.\d+)?)\s*([a-z]+)")?;
        let mut total = 0.0;
        let mut end = 0;
        for captures in expression.captures_iter(&normalized) {
            let matched = captures.get(0).unwrap();
            let between = normalized[end..matched.start()].trim();
            anyhow::ensure!(
                between.is_empty() || between == ",",
                "The duration could not be understood near {}.",
                json!(between)
            );
            let unit = &captures[2];
            let multiplier = match unit {
                "d" | "day" | "days" => DAY as f64,
                "h" | "hour" | "hours" => 3_600_000.0,
                "m" | "min" | "mins" | "minute" | "minutes" => 60_000.0,
                "s" | "sec" | "secs" | "second" | "seconds" => 1000.0,
                _ => anyhow::bail!("Unknown duration unit {}.", json!(unit)),
            };
            total += captures[1].parse::<f64>()? * multiplier;
            end = matched.end();
        }
        anyhow::ensure!(
            end > 0 && normalized[end..].trim().is_empty(),
            "The duration could not be understood. Examples: 90 seconds, 2 hours, 1h 30m."
        );
        total
    } else {
        [
            ("seconds", 1000.0),
            ("minutes", 60_000.0),
            ("hours", 3_600_000.0),
            ("days", DAY as f64),
        ]
        .into_iter()
        .map(|(key, multiplier)| input[key].as_f64().unwrap_or(0.0) * multiplier)
        .sum()
    };
    let rounded = amount.round();
    anyhow::ensure!(
        rounded.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&rounded),
        "Scheduling duration must resolve to a finite whole number of milliseconds."
    );
    Ok(rounded as u64)
}
pub fn instant(schemas: &Schemas, input: &Value) -> Result<i64> {
    valid(schemas, "ownerSchedulingInstant", input, "Scheduling time")?;
    if let Some(number) = input.as_f64() {
        return unix(number);
    }
    let text = input.as_str().unwrap().trim();
    anyhow::ensure!(!text.is_empty(), "Provide a scheduled date.");
    if regex_lite::Regex::new(r"^[+-]?\d+(?:\.\d+)?$")?.is_match(text) {
        return unix(text.parse()?);
    }
    let parsed = chrono::DateTime::parse_from_rfc3339(text)
        .or_else(|_| chrono::DateTime::parse_from_rfc2822(text))
        .map(|date| date.timestamp_millis())
        .ok()
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date| date.and_utc().timestamp_millis())
        });
    parsed.context("The date could not be understood. Use ISO 8601, RFC 2822, or a Unix timestamp.")
}
fn unix(number: f64) -> Result<i64> {
    let milliseconds = if number.abs() < 1_000_000_000_000.0 {
        number * 1000.0
    } else {
        number
    };
    let rounded = (milliseconds + 0.5).floor();
    anyhow::ensure!(
        rounded.is_finite() && rounded.abs() <= 9_007_199_254_740_991.0,
        "The scheduled date must resolve to a whole millisecond timestamp."
    );
    Ok(rounded as i64)
}
pub fn due(schemas: &Schemas, input: &Value, started: u64, relative: bool) -> Result<u64> {
    let requested = if relative {
        let amount = duration(schemas, input)?;
        anyhow::ensure!(amount <= DAY, "That is longer than the 1 day limit.");
        started.saturating_add(amount)
    } else {
        let requested = instant(schemas, input)?;
        let due = if requested < 0 {
            started
        } else {
            started.max(requested as u64)
        };
        anyhow::ensure!(
            due - started <= DAY,
            "That is further away than the 1 day limit."
        );
        due
    };
    anyhow::ensure!(
        requested <= 8_640_000_000_000_000,
        "That resolves to a time scheduling cannot represent."
    );
    Ok(requested)
}
pub fn human(milliseconds: u64) -> String {
    if milliseconds < 1000 {
        return format!("{milliseconds} milliseconds");
    }
    let (amount, unit) = if milliseconds < 60000 {
        (milliseconds as f64 / 1000.0, "second")
    } else if milliseconds < 3600000 {
        (milliseconds as f64 / 60000.0, "minute")
    } else if milliseconds < DAY {
        (milliseconds as f64 / 3600000.0, "hour")
    } else {
        (milliseconds as f64 / DAY as f64, "day")
    };
    let shown = if amount.fract() == 0.0 {
        format!("{amount:.0}")
    } else {
        format!("{amount:.2}").trim_end_matches('0').to_owned()
    };
    format!(
        "{shown} {unit}{}",
        if shown.parse::<f64>().unwrap() == 1.0 {
            ""
        } else {
            "s"
        }
    )
}
pub fn iso(timestamp: u64) -> Result<String> {
    let date = chrono::DateTime::from_timestamp_millis(timestamp.try_into()?)
        .context("The scheduled date cannot be represented.")?;
    Ok(date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn times_and_human_durations_match_the_original_source() {
        let schemas = Schemas::new().unwrap();
        let goldens: Value = serde_json::from_str(include_str!("time_goldens.json")).unwrap();
        for case in goldens["durations"].as_array().unwrap() {
            assert_eq!(
                duration(&schemas, &case["input"]).unwrap(),
                case["milliseconds"]
            );
        }
        for case in goldens["instants"].as_array().unwrap() {
            assert_eq!(
                instant(&schemas, &case["input"]).unwrap(),
                case["milliseconds"]
            );
        }
        for case in goldens["human"].as_array().unwrap() {
            assert_eq!(human(case["input"].as_u64().unwrap()), case["text"]);
        }
        for invalid in [
            json!("-1 hours"),
            json!("1 fortnight"),
            json!("one hour"),
            json!("1 hour and 30 minutes"),
        ] {
            assert!(duration(&schemas, &invalid).is_err());
        }
    }
}
