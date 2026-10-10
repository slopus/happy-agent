use super::*;
use chrono::{Datelike, TimeZone, Timelike};

pub fn zone(name: &str) -> Result<chrono_tz::Tz> {
    name.parse()
        .map_err(|_| anyhow::anyhow!("\"{name}\" is not a time zone this system recognizes."))
}
pub fn effective(schedule: &Value, at: u64) -> Result<bool> {
    let zone = zone(schedule["timeZone"].as_str().unwrap())?;
    let instant = chrono::Utc
        .timestamp_millis_opt(i64::try_from(at)?)
        .single()
        .context("The presence timestamp cannot be interpreted.")?
        .with_timezone(&zone);
    if !schedule["days"]
        .as_array()
        .unwrap()
        .contains(&json!(instant.weekday().num_days_from_sunday()))
    {
        return Ok(false);
    }
    let current = instant.hour() * 60 + instant.minute();
    let start = minutes(schedule["startTime"].as_str().unwrap());
    let end = minutes(schedule["endTime"].as_str().unwrap());
    Ok(if start <= end {
        current >= start && current < end
    } else {
        current >= start || current < end
    })
}
fn minutes(time: &str) -> u32 {
    time[..2].parse::<u32>().unwrap() * 60 + time[3..].parse::<u32>().unwrap()
}
pub fn iso(at: u64) -> Result<String> {
    let instant = chrono::Utc
        .timestamp_millis_opt(i64::try_from(at)?)
        .single()
        .context("The presence timestamp cannot be interpreted.")?;
    Ok(instant.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_iana_windows_match_original_intl_across_dst_and_overnight_boundaries() {
        let cases:Vec<Value>=serde_json::from_str(include_str!("calendar_goldens.json")).unwrap();
        for case in cases {assert_eq!(effective(&case["schedule"],case["at"].as_u64().unwrap()).unwrap(),case["active"].as_bool().unwrap(),"{}",case["schedule"]["timeZone"]);}
        assert!(zone("This/Zone/Does/Not/Exist").is_err());
    }
}
