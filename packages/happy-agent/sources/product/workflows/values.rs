use super::*;
use monty_types::MontyObject;
fn js_keys(map: serde_json::Map<String, Value>) -> serde_json::Map<String, Value> {
    let mut indices = BTreeMap::new();
    let mut ordinary = Vec::new();
    for (key, value) in map {
        if let Ok(index) = key.parse::<u32>() {
            if index != u32::MAX && index.to_string() == key {
                indices.insert(index, value);
                continue;
            }
        }
        ordinary.push((key, value));
    }
    indices
        .into_iter()
        .map(|(index, value)| (index.to_string(), value))
        .chain(ordinary)
        .collect()
}
pub fn normalize(value: Value) -> Value {
    match value {
        Value::Array(values) => json!(values.into_iter().map(normalize).collect::<Vec<_>>()),
        Value::Object(map) => Value::Object(js_keys(
            map.into_iter()
                .map(|(key, value)| (key, normalize(value)))
                .collect(),
        )),
        Value::Number(number) => {
            if let Some(value) = number.as_f64() {
                if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
                    return json!(value as i64);
                }
            }
            json!(number)
        }
        value => value,
    }
}
fn number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(value)) => value.as_f64().unwrap(),
        Some(Value::String(value)) => {
            let value = format::trim(value);
            if value.is_empty() {
                0.0
            } else {
                value.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}
pub fn input(value: &Value) -> Result<MontyObject> {
    Ok(match value {
        Value::Null => MontyObject::None,
        Value::Bool(value) => MontyObject::Bool(*value),
        Value::String(value) => MontyObject::String(value.clone()),
        Value::Number(value) => {
            let value = value.as_f64().unwrap();
            if value.fract() == 0.0
                && (value.abs() <= 9_007_199_254_740_991.0 || value == i64::MIN as f64)
            {
                MontyObject::Int(value as i64)
            } else {
                MontyObject::Float(value)
            }
        }
        Value::Array(values) => {
            MontyObject::List(values.iter().map(input).collect::<Result<Vec<_>>>()?)
        }
        Value::Object(map) if map.contains_key("__monty_type__") => {
            use monty_types::{
                MontyDate, MontyDateTime, MontyFileHandle, MontyTimeDelta, MontyTimeZone,
            };
            let num = |key: &str| number(map.get(key));
            match value["__monty_type__"].as_str() {
                Some("Ellipsis") => MontyObject::Ellipsis,
                Some("NotImplemented") => MontyObject::NotImplemented,
                Some("Date") => MontyObject::Date(MontyDate {
                    year: num("year") as i32,
                    month: num("month") as u8,
                    day: num("day") as u8,
                }),
                Some("DateTime") => {
                    let offset = map
                        .get("offsetSeconds")
                        .filter(|value| !value.is_null())
                        .map(|_| num("offsetSeconds") as i32);
                    MontyObject::DateTime(MontyDateTime {
                        year: num("year") as i32,
                        month: num("month") as u8,
                        day: num("day") as u8,
                        hour: num("hour") as u8,
                        minute: num("minute") as u8,
                        second: num("second") as u8,
                        microsecond: num("microsecond") as u32,
                        offset_seconds: offset,
                        timezone_name: offset
                            .and_then(|_| value["timezoneName"].as_str().map(str::to_owned)),
                    })
                }
                Some("TimeDelta") => MontyObject::TimeDelta(MontyTimeDelta {
                    days: num("days") as i32,
                    seconds: num("seconds") as i32,
                    microseconds: num("microseconds") as i32,
                }),
                Some("TimeZone") => MontyObject::TimeZone(MontyTimeZone {
                    offset_seconds: num("offsetSeconds") as i32,
                    name: value["name"].as_str().map(str::to_owned),
                }),
                Some("Type") => MontyObject::Type(
                    monty_types::MontyType::from_type_name(
                        value["value"].as_str().unwrap_or("undefined"),
                    )
                    .context("The workflow argument names an unknown Python type.")?,
                ),
                Some("BuiltinFunction") => MontyObject::BuiltinFunction(
                    value["value"]
                        .as_str()
                        .unwrap_or("undefined")
                        .parse()
                        .map_err(|_| {
                            anyhow::anyhow!(
                                "The workflow argument names an unknown Python builtin."
                            )
                        })?,
                ),
                Some("Exception") => MontyObject::Exception {
                    exc_type: value["excType"]
                        .as_str()
                        .unwrap_or("undefined")
                        .parse()
                        .map_err(|_| {
                            anyhow::anyhow!(
                                "The workflow argument names an unknown Python exception."
                            )
                        })?,
                    arg: value["message"].as_str().map(str::to_owned),
                },
                Some("Dataclass") => anyhow::bail!(
                    "Object property 'typeId' type mismatch. Expect value to be BigInt, but received Number"
                ),
                Some("FileHandle") => {
                    anyhow::ensure!(
                        Schemas::new()?.valid("ownerWorkflowFileMarker", value)?,
                        "The workflow file handle argument is invalid."
                    );
                    MontyObject::FileHandle(MontyFileHandle {
                        path: value["path"].as_str().unwrap().to_owned(),
                        mode: value["mode"]
                            .as_str()
                            .unwrap()
                            .parse()
                            .map_err(|error| anyhow::anyhow!("{error}"))?,
                        position: value["position"].as_u64().unwrap_or(0),
                    })
                }
                Some(marker) => anyhow::bail!("Unknown Monty marker type: {marker}"),
                None => anyhow::bail!("Unknown Monty marker type: {}", value["__monty_type__"]),
            }
        }
        Value::Object(values) => MontyObject::dict(
            js_keys(values.clone())
                .iter()
                .map(|(key, value)| Ok((MontyObject::String(key.clone()), input(value)?)))
                .collect::<Result<Vec<_>>>()?,
        ),
    })
}
fn key(value: &MontyObject) -> String {
    match value {
        MontyObject::None => "null".to_owned(),
        MontyObject::Bool(value) => value.to_string(),
        MontyObject::String(value)
        | MontyObject::Path(value)
        | MontyObject::Repr(value)
        | MontyObject::Cycle(_, value) => value.clone(),
        MontyObject::Function { name, .. } => name.clone(),
        MontyObject::Int(value) => value.to_string(),
        MontyObject::BigInt(value) => value.to_string(),
        MontyObject::Float(value) => value.to_string(),
        MontyObject::List(values)
        | MontyObject::Tuple(values)
        | MontyObject::NamedTuple { values, .. } => values
            .iter()
            .map(|value| {
                if matches!(value, MontyObject::None) {
                    String::new()
                } else {
                    key(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        MontyObject::Bytes(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        MontyObject::Dict(_) => "[object Map]".to_owned(),
        MontyObject::Set(_) | MontyObject::FrozenSet(_) => "[object Set]".to_owned(),
        _ => "[object Object]".to_owned(),
    }
}
pub fn output(value: MontyObject) -> Result<Value> {
    let value = match value {
        MontyObject::None => Value::Null,
        MontyObject::Bool(value) => json!(value),
        MontyObject::Int(value) => {
            anyhow::ensure!(
                value.unsigned_abs() <= 9_007_199_254_740_991,
                "Do not know how to serialize a BigInt"
            );
            json!(value)
        }
        MontyObject::BigInt(_) | MontyObject::Dataclass { .. } => {
            anyhow::bail!("Do not know how to serialize a BigInt")
        }
        MontyObject::Float(value) => {
            serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
        }
        MontyObject::String(value)
        | MontyObject::Path(value)
        | MontyObject::Repr(value)
        | MontyObject::Cycle(_, value) => json!(value),
        MontyObject::Function { name, .. } => json!(name),
        MontyObject::List(values)
        | MontyObject::Tuple(values)
        | MontyObject::NamedTuple { values, .. } => {
            json!(values.into_iter().map(output).collect::<Result<Vec<_>>>()?)
        }
        MontyObject::Dict(pairs) => {
            let mut map = serde_json::Map::new();
            for (k, value) in pairs {
                map.insert(key(&k), output(value)?);
            }
            Value::Object(map)
        }
        MontyObject::Set(_) | MontyObject::FrozenSet(_) => json!({}),
        MontyObject::Bytes(values) => json!(
            values
                .into_iter()
                .enumerate()
                .map(|(index, value)| (index.to_string(), json!(value)))
                .collect::<serde_json::Map<_, _>>()
        ),
        MontyObject::Ellipsis => json!({"__monty_type__":"Ellipsis"}),
        MontyObject::NotImplemented => json!({"__monty_type__":"NotImplemented"}),
        MontyObject::Type(value) => json!({"__monty_type__":"Type","value":value.to_string()}),
        MontyObject::BuiltinFunction(value) => {
            json!({"__monty_type__":"BuiltinFunction","value":value.to_string()})
        }
        MontyObject::Exception { exc_type, arg } => {
            let mut value = json!({"__monty_type__":"Exception","excType":exc_type.to_string()});
            if let Some(arg) = arg {
                value["message"] = json!(arg);
            }
            value
        }
        MontyObject::Date(value) => {
            json!({"__monty_type__":"Date","year":value.year,"month":value.month,"day":value.day})
        }
        MontyObject::DateTime(value) => {
            let mut mapped = json!({"__monty_type__":"DateTime","year":value.year,"month":value.month,"day":value.day,"hour":value.hour,"minute":value.minute,"second":value.second,"microsecond":value.microsecond});
            if let Some(offset) = value.offset_seconds {
                mapped["offsetSeconds"] = json!(offset);
            }
            if let Some(name) = value.timezone_name {
                mapped["timezoneName"] = json!(name);
            }
            mapped
        }
        MontyObject::TimeDelta(value) => {
            json!({"__monty_type__":"TimeDelta","days":value.days,"seconds":value.seconds,"microseconds":value.microseconds})
        }
        MontyObject::TimeZone(value) => {
            let mut mapped =
                json!({"__monty_type__":"TimeZone","offsetSeconds":value.offset_seconds});
            if let Some(name) = value.name {
                mapped["name"] = json!(name);
            }
            mapped
        }
        MontyObject::FileHandle(value) => {
            anyhow::ensure!(
                value.position <= 9_007_199_254_740_991,
                "MontyFileHandle position exceeds JavaScript's maximum safe integer"
            );
            json!({"path":value.path,"mode":value.mode.as_str(),"position":value.position})
        }
    };
    Ok(normalize(value))
}
pub fn structured(schemas: &Schemas, text: &str, schema: &Value) -> Result<Value> {
    fn adapt(schemas: &Schemas, schema: &Value, depth: usize) -> Result<Value> {
        anyhow::ensure!(
            depth <= 256,
            "The workflow result schema exceeds its depth bound."
        );
        if let Some(choices) = schema["anyOf"].as_array() {
            let mut choices = choices
                .iter()
                .filter(|choice| choice.is_object())
                .map(|choice| adapt(schemas, choice, depth + 1))
                .collect::<Result<Vec<_>>>()?;
            if choices.is_empty() {
                choices.push(json!({"not":{}}));
            }
            return Ok(json!({"anyOf":choices}));
        }
        let mut result = json!({});
        if let Some(choices) = schema["enum"].as_array() {
            let choices = choices
                .iter()
                .filter(|value| !value.is_array() && !value.is_object())
                .cloned()
                .collect::<Vec<_>>();
            if choices.is_empty() {
                return Ok(json!({"not":{}}));
            }
            result["enum"] = json!(choices);
        }
        if let Some(value) = schema.get("const") {
            if value.is_array() || value.is_object() {
                return Ok(json!({"not":{}}));
            }
            result["const"] = value.clone();
        }
        if let Some(kind) = schema["type"].as_str().filter(|kind| {
            matches!(
                *kind,
                "array" | "boolean" | "integer" | "null" | "number" | "object" | "string"
            )
        }) {
            result["type"] = json!(kind);
            if kind == "array" && schema["items"].is_object() {
                result["items"] = adapt(schemas, &schema["items"], depth + 1)?;
            }
            if kind == "object" {
                if let Some(required) = schema["required"].as_array() {
                    result["required"] = json!(
                        required
                            .iter()
                            .filter(|key| key.is_string())
                            .cloned()
                            .collect::<Vec<_>>()
                    );
                }
                if schemas.valid("ownerWorkflowSchemaRecord", &schema["properties"])? {
                    let properties = schema["properties"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .map(|(key, value)| Ok((key.clone(), adapt(schemas, value, depth + 1)?)))
                        .collect::<Result<serde_json::Map<_, _>>>()?;
                    result["properties"] = json!(properties);
                }
            }
        }
        Ok(result)
    }
    let adapted = adapt(schemas, schema, 0)?;
    let validator =
        happy_agent_base::RuntimeSchemas::compile(&json!({"workflow":adapted}).to_string())?;
    let fenced = regex_lite::Regex::new(r"(?is)```(?:json)?\s*(.*?)```")?
        .captures(text)
        .and_then(|captures| captures.get(1).map(|matched| matched.as_str()));
    for candidate in fenced.into_iter().chain(std::iter::once(text)) {
        if let Ok(value) = serde_json::from_str::<Value>(format::trim(candidate)) {
            if validator.valid("workflow", &value)? {
                return Ok(normalize(value));
            }
            break;
        }
    }
    anyhow::bail!("The workflow agent did not return JSON matching its schema.")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_workflow_schema_subset_and_normalization_are_preserved() {
        let schemas = Schemas::new().unwrap();
        let golden: Value = serde_json::from_str(include_str!("format_goldens.json")).unwrap();
        for case in golden["structured"].as_array().unwrap() {
            let result = structured(&schemas, case["text"].as_str().unwrap(), &case["schema"]);
            if let Some(expected) = case.get("error") {
                assert_eq!(result.unwrap_err().to_string(), expected.as_str().unwrap());
            } else {
                assert_eq!(result.unwrap(), case["output"]);
            }
        }
        assert_eq!(
            output(MontyObject::dict(vec![
                (MontyObject::String("2".into()), MontyObject::Float(2.0)),
                (MontyObject::String("1".into()), MontyObject::Int(1))
            ]))
            .unwrap()
            .to_string(),
            r#"{"1":1,"2":2}"#
        );
    }
    #[test]
    fn workflow_inputs_match_the_original_monty_javascript_wire_values() {
        use base64::Engine;
        let cases: Value = serde_json::from_str(include_str!("input_goldens.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let encoded = base64::engine::general_purpose::STANDARD
                .decode(case["encoded"].as_str().unwrap())
                .unwrap();
            let mut frame = (encoded.len() as u32).to_le_bytes().to_vec();
            frame.extend(encoded);
            let original = monty_proto::FrameReader::new(std::io::Cursor::new(frame))
                .read::<monty_proto::WireObject>()
                .unwrap()
                .unwrap()
                .0
                .unwrap();
            assert_eq!(
                input(&case["value"]).unwrap(),
                original,
                "{}",
                case["value"]
            );
        }
    }
}
