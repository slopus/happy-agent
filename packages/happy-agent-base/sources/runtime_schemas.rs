use anyhow::{Context, Result};
use jsonschema::{Keyword, ValidationError, Validator};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};

/// Evaluates the serialized TypeBox contract, including JavaScript's UTF-16
/// string bounds. The owning package supplies its authoritative schemas.
#[derive(Clone)]
pub struct RuntimeSchemas(Arc<BTreeMap<String, Validator>>);
impl RuntimeSchemas {
    pub fn compile(source: &str) -> Result<Self> {
        let source: BTreeMap<String, Value> = serde_json::from_str(source)?;
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
        Ok(Self(Arc::new(compiled)))
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
