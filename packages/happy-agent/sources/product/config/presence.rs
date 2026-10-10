//! Normalize the original Presence configuration at Config's public seam.
use anyhow::{Context as _,Result};
use serde_json::{Value,json};
use std::sync::OnceLock;
pub(super) fn normalize(input:Option<&toml::Value>)->Result<Value> {
    let mut output=json!({"states":{}});
    if let Some(input)=input {
        for key in ["current","fallback"] {if let Some(value)=input.get(key){output[key]=serde_json::to_value(value)?;}}
        if let Some(until)=input.get("until") {output["until"]=json!(date(until)?);}
        if let Some(states)=input.get("states").and_then(toml::Value::as_table) {for (id,input) in states {
            let mut state=json!({});for key in ["emoji","prompt","title"] {if let Some(value)=input.get(key){state[key]=serde_json::to_value(value)?;}}
            if let Some(value)=input.get("answer_wait") {state["answerWaitMs"]=answer_wait(value.as_str().context("The presence answer wait must be a duration.")?)?;}
            output["states"][id]=state;
        }}
    }
    anyhow::ensure!(super::super::schemas::Schemas::new()?.valid("ownerPresenceConfiguration",&output)?,"The normalized presence configuration is invalid.");Ok(output)
}
fn answer_wait(input:&str)->Result<Value> {
    let input=input.trim().to_ascii_lowercase();
    match input.as_str(){"unlimited"|"forever"=>return Ok(Value::Null),"none"|"never"=>return Ok(json!(0)),_=>{}}
    static DURATION:OnceLock<regex_lite::Regex>=OnceLock::new();
    let captures=DURATION.get_or_init(||regex_lite::Regex::new(r"^([0-9]+(?:\.[0-9]+)?)\s*(milliseconds?|ms|seconds?|s|minutes?|m|hours?|h|days?|d)$").unwrap()).captures(&input).context("The presence answer wait must be a duration.")?;
    let unit=&captures[2];let scale=if unit=="ms"||unit.starts_with("millisecond"){1.0}else if unit.starts_with('s'){1000.0}else if unit.starts_with('m'){60_000.0}else if unit.starts_with('h'){3_600_000.0}else{86_400_000.0};
    let value=(captures[1].parse::<f64>()?*scale).round();
    anyhow::ensure!(value.is_finite()&&value<=9_007_199_254_740_991.0,"The presence answer wait exceeds the supported duration.");Ok(json!(value as u64))
}
pub(super) fn date(input:&toml::Value)->Result<i64> {
    if let Some(value)=input.as_integer(){anyhow::ensure!(value.unsigned_abs()<=9_007_199_254_740_991,"The presence expiration must be a date.");return Ok(value);}
    if let Some(value)=input.as_float(){anyhow::ensure!(value.is_finite()&&value.fract()==0.0&&value.abs()<=9_007_199_254_740_991.0,"The presence expiration must be a date.");return Ok(value as i64);}
    let value=input.as_str().map(str::to_owned).or_else(||input.as_datetime().map(ToString::to_string)).context("The presence expiration must be a date.")?;
    if let Ok(date)=chrono::DateTime::parse_from_rfc3339(&value){return Ok(date.timestamp_millis());}
    if let Ok(date)=chrono::DateTime::parse_from_rfc2822(&value){return Ok(date.timestamp_millis());}
    if let Ok(date)=chrono::NaiveDate::parse_from_str(&value,"%Y-%m-%d"){return Ok(date.and_hms_opt(0,0,0).unwrap().and_utc().timestamp_millis());}
    if let Ok(date)=chrono::NaiveDateTime::parse_from_str(&value,"%Y-%m-%dT%H:%M:%S%.f"){return Ok(date.and_utc().timestamp_millis());}
    anyhow::bail!("The presence expiration must be a date.")
}