use crate::product::schemas::Schemas;
use anyhow::Result;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

pub(super) fn catalogs() -> &'static Value {
    static CATALOGS: OnceLock<Value> = OnceLock::new();
    CATALOGS.get_or_init(|| {
        let value = serde_json::from_str(include_str!("model_catalogs.json"))
            .expect("source-generated private model catalogs");
        assert!(
            Schemas::new()
                .unwrap()
                .valid("autoReviewCatalogs", &value)
                .unwrap()
        );
        value
    })
}

/// Same-account precedence from the original private catalog. A route absent
/// from that catalog is unavailable, never an arbitrary cross-account fallback.
pub(super) fn select(models: &[Value], active: &Value) -> Result<Vec<Value>> {
    let schemas = Schemas::new()?;
    anyhow::ensure!(
        schemas.valid("autoReviewCatalog", &json!(models))?
            && schemas.valid("autoReviewerRoute", active)?,
        "The automatic permission reviewer model route is invalid."
    );
    let provider = active["providerId"].as_str().unwrap();
    let id = active["modelId"].as_str().unwrap();
    let find = |id: &str| {
        models
            .iter()
            .find(|model| model["providerId"] == provider && model["id"] == id)
    };
    let route = |model: &Value| json!({"providerId":provider,"modelId":model["id"],"effort":model["defaultEffort"]});
    let mut routes = Vec::new();
    if (id.starts_with("anthropic/opus-") || id.starts_with("anthropic/fable-"))
        && let Some(sonnet) = find("anthropic/sonnet-5")
    {
        routes.push(route(sonnet));
    }
    for id in ["openai/codex-auto-review", "openai/gpt-5.4"] {
        if let Some(hidden) = find(id) {
            routes.push(route(hidden));
        }
    }
    if find(id).is_some() && !routes.iter().any(|route| route["modelId"] == id) {
        routes.push(active.clone());
    }
    anyhow::ensure!(
        !routes.is_empty(),
        "No reviewer model route could be resolved for {id} on provider {provider}."
    );
    Ok(routes)
}

pub(super) fn reviewer_id(main: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(main.as_bytes()));
    format!("r{}", &digest[..31])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_same_account_route_precedence_and_stable_private_identity_match_source() {
        let goldens = super::super::runtime_goldens();
        for case in goldens["routeCases"].as_array().unwrap() {
            let models = catalogs()[case["kind"].as_str().unwrap()]
                .as_array()
                .unwrap();
            assert_eq!(
                json!(select(models, &case["active"]).unwrap()),
                case["expected"]
            );
        }
        for case in goldens["identityCases"].as_array().unwrap() {
            assert_eq!(
                reviewer_id(case["id"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
        assert!(
            select(
                &[],
                &json!({"providerId":"missing","modelId":"missing","effort":"high"})
            )
            .is_err()
        );
    }
}
