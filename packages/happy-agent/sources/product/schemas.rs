use anyhow::{Context, Result};
use jsonschema::{Keyword, ValidationError, Validator};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, OnceLock},
};

/// Serialized TypeBox schemas from ApiSchemas.ts and events/types.ts. TypeBox
/// measures string bounds in UTF-16 units; preserve that behavior in the native
/// evaluator instead of silently changing it to Unicode scalar counts.
pub struct Schemas(Arc<BTreeMap<String, Validator>>);
static COMPILED: OnceLock<std::result::Result<Arc<BTreeMap<String, Validator>>, String>> =
    OnceLock::new();
impl Schemas {
    pub fn new() -> Result<Self> {
        COMPILED
            .get_or_init(|| {
                Self::compile()
                    .map(Arc::new)
                    .map_err(|error| format!("{error:#}"))
            })
            .as_ref()
            .map(|schemas| Self(schemas.clone()))
            .map_err(|error| anyhow::anyhow!("{error}"))
    }
    fn compile() -> Result<BTreeMap<String, Validator>> {
        let source: BTreeMap<String, Value> =
            serde_json::from_str(include_str!("request_schemas.json"))?;
        let mut compiled = BTreeMap::new();
        for (name, schema) in source {
            let validator = jsonschema::options()
                .with_keyword("minLength", |_, value, _| {
                    Ok(Box::new(StringLength {
                        minimum: true,
                        limit: value.as_u64().unwrap_or(0) as usize,
                    }))
                })
                .with_keyword("maxLength", |_, value, _| {
                    Ok(Box::new(StringLength {
                        minimum: false,
                        limit: value.as_u64().unwrap_or(0) as usize,
                    }))
                })
                .build(&schema)
                .map_err(|error| {
                    anyhow::anyhow!("The native TypeBox schema {name} is invalid: {error}")
                })?;
            compiled.insert(name, validator);
        }
        Ok(compiled)
    }
    pub fn valid(&self, name: &str, value: &Value) -> Result<bool> {
        Ok(self
            .0
            .get(name)
            .context("The requested runtime schema is unavailable.")?
            .is_valid(value))
    }
}

struct StringLength {
    minimum: bool,
    limit: usize,
}
impl Keyword for StringLength {
    fn validate<'i>(&self, instance: &'i Value) -> std::result::Result<(), ValidationError<'i>> {
        if self.is_valid(instance) {
            Ok(())
        } else {
            Err(ValidationError::custom(
                "The string is outside its allowed length.",
            ))
        }
    }
    fn is_valid(&self, instance: &Value) -> bool {
        instance.as_str().is_none_or(|text| {
            let length = text.encode_utf16().count();
            if self.minimum {
                length >= self.limit
            } else {
                length <= self.limit
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn typebox_string_limits_count_utf16_units_and_reject_unknown_request_fields() {
        let schemas = Schemas::new().expect("compile serialized TypeBox schemas");
        assert!(
            schemas
                .valid("security", &json!({"policy":"😀".repeat(16384)}))
                .expect("schema")
        );
        assert!(
            !schemas
                .valid("security", &json!({"policy":"😀".repeat(16385)}))
                .expect("schema")
        );
        assert!(
            !schemas
                .valid("security", &json!({"policy":"ok","unknown":true}))
                .expect("schema")
        );
        assert!(
            !schemas
                .valid("security", &json!({"policy":"ok","mutationId":""}))
                .expect("schema")
        );
    }
}
