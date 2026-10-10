//! A tool's declared output schema, checked the way the SDK's Ajv validator reported it.
//!
//! The SDK compiled each listed tool's `outputSchema` and refused structured content that did not
//! match, naming the first failure in Ajv's words (`data/path must be string`). A schema that does
//! not compile constrains nothing, as the SDK skipped a validator it could not build.

use jsonschema::error::{TypeKind, ValidationErrorKind};
use serde_json::Value;

use super::super::text::js_display;

/// The first way `value` fails `schema`, in Ajv's `errorsText` form, or nothing when it matches.
pub fn first_error(schema: &Value, value: &Value) -> Option<String> {
    let validator = jsonschema::validator_for(schema).ok()?;
    let error = validator.iter_errors(value).next()?;
    let path = error.instance_path().as_str();
    let message = match error.kind() {
        ValidationErrorKind::Type { kind: TypeKind::Single(kind) } => format!("must be {}", kind.as_str()),
        ValidationErrorKind::Type { kind: TypeKind::Multiple(kinds) } => {
            format!("must be {}", kinds.iter().map(|kind| kind.as_str()).collect::<Vec<_>>().join(","))
        }
        ValidationErrorKind::Required { property } => format!("must have required property '{}'", js_display(property)),
        ValidationErrorKind::AdditionalProperties { .. } => "must NOT have additional properties".into(),
        ValidationErrorKind::Enum { .. } => "must be equal to one of the allowed values".into(),
        ValidationErrorKind::Constant { .. } => "must be equal to constant".into(),
        ValidationErrorKind::MinLength { limit } => format!("must NOT have fewer than {limit} characters"),
        ValidationErrorKind::MaxLength { limit } => format!("must NOT have more than {limit} characters"),
        ValidationErrorKind::MinItems { limit } => format!("must NOT have fewer than {limit} items"),
        ValidationErrorKind::MaxItems { limit } => format!("must NOT have more than {limit} items"),
        ValidationErrorKind::MinProperties { limit } => format!("must NOT have fewer than {limit} properties"),
        ValidationErrorKind::MaxProperties { limit } => format!("must NOT have more than {limit} properties"),
        ValidationErrorKind::Minimum { limit } => format!("must be >= {}", js_display(limit)),
        ValidationErrorKind::Maximum { limit } => format!("must be <= {}", js_display(limit)),
        ValidationErrorKind::ExclusiveMinimum { limit } => format!("must be > {}", js_display(limit)),
        ValidationErrorKind::ExclusiveMaximum { limit } => format!("must be < {}", js_display(limit)),
        ValidationErrorKind::Pattern { pattern } => format!("must match pattern \"{pattern}\""),
        ValidationErrorKind::Format { format } => format!("must match format \"{format}\""),
        ValidationErrorKind::UniqueItems => "must NOT have duplicate items".into(),
        ValidationErrorKind::AnyOf { .. } => "must match a schema in anyOf".into(),
        ValidationErrorKind::OneOfNotValid { .. } | ValidationErrorKind::OneOfMultipleValid { .. } => "must match exactly one schema in oneOf".into(),
        ValidationErrorKind::Not { .. } => "must NOT be valid".into(),
        ValidationErrorKind::FalseSchema => "boolean schema is false".into(),
        _ => error.to_string(),
    };
    Some(format!("data{path} {message}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failures_read_the_way_ajv_wrote_them() {
        let schema = json!({"type": "object", "properties": {"count": {"type": "integer"}, "name": {"type": "string", "minLength": 2}}, "required": ["count"]});
        assert_eq!(first_error(&schema, &json!({"count": 1})), None);
        assert_eq!(first_error(&schema, &json!({})).as_deref(), Some("data must have required property 'count'"));
        assert_eq!(first_error(&schema, &json!({"count": "1"})).as_deref(), Some("data/count must be integer"));
        assert_eq!(first_error(&schema, &json!({"count": 1, "name": "x"})).as_deref(), Some("data/name must NOT have fewer than 2 characters"));
        assert_eq!(first_error(&json!({"type": "string", "pattern": "("}), &json!(1)), None);
    }
}
