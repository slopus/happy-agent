use anyhow::Result;
use happy_agent_base::RuntimeSchemas;
use serde_json::Value;
use std::sync::OnceLock;

/// Serialized TypeBox schemas from ApiSchemas.ts and events/types.ts. TypeBox
/// measures string bounds in UTF-16 units; preserve that behavior in the native
/// evaluator instead of silently changing it to Unicode scalar counts.
pub struct Schemas(RuntimeSchemas);
static COMPILED: OnceLock<std::result::Result<RuntimeSchemas, String>> = OnceLock::new();
impl Schemas {
    pub fn new() -> Result<Self> {
        COMPILED
            .get_or_init(|| {
                RuntimeSchemas::compile(include_str!("request_schemas.json"))
                    .map_err(|error| format!("{error:#}"))
            })
            .as_ref()
            .map(|schemas| Self(schemas.clone()))
            .map_err(|error| anyhow::anyhow!("{error}"))
    }
    pub fn valid(&self, name: &str, value: &Value) -> Result<bool> {
        self.0.valid(name, value)
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
