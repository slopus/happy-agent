use super::*;
use std::collections::{BTreeMap, BTreeSet};
pub(in crate::product::secrets) fn resolve(
    ctx: &Context<'_>,
    owner: &str,
    targets: &Value,
    selected: Option<&Value>,
    model_only: bool,
    schemas: &Schemas,
) -> Result<Value> {
    let mut ids = BTreeSet::new();
    for target in targets.as_array().expect("validated targets") {
        let kind = target["type"].as_str().expect("type");
        let id = target["id"].as_str().expect("id");
        let mut statement=ctx.database().prepare("SELECT secret_id FROM happy_agent_secret_api_attachments WHERE owner_agent_id=?1 AND target_type=?2 AND target_id=?3 UNION SELECT secret_id FROM happy_agent_secret_attachments WHERE owner_agent_id=?1 AND scope_ref=?3 AND ?2='agent'").map_err(|_|storage_error())?;
        let rows = statement
            .query_map(rusqlite::params![owner, kind, id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|_| storage_error())?;
        for id in rows {
            ids.insert(id.map_err(|_| storage_error())?);
            ensure!(
                ids.len() <= 256,
                "Too many secrets are attached to this command scope."
            );
        }
    }
    let selected = selected.map(|v| {
        v.as_array()
            .expect("validated selection")
            .iter()
            .map(|v| v.as_str().expect("id").to_owned())
            .collect::<BTreeSet<_>>()
    });
    if let Some(selected) = &selected {
        for id in selected {
            ensure!(
                ids.contains(id),
                "The selected secret reference is not attached to this scope."
            );
        }
    }
    let mut hidden = BTreeMap::<String, String>::new();
    let mut environment = serde_json::Map::new();
    let mut supplied = BTreeSet::new();
    for id in ids {
        let Some(row) = row(ctx, owner, &id, schemas)? else {
            ensure!(
                !selected
                    .as_ref()
                    .is_some_and(|selected| selected.contains(&id)),
                "Secret command selection refers to a missing secret."
            );
            continue;
        };
        let values = environment_values(&row, schemas)?;
        for name in values.as_object().expect("validated environment").keys() {
            hidden
                .entry(name.to_ascii_uppercase())
                .or_insert_with(|| name.clone());
            ensure!(
                hidden.len() <= 256,
                "Too many secret environment variables are attached to this scope."
            );
        }
        let available = row["available_to_model"] != 0 && row["available_to_model"] != "0";
        let explicit = selected
            .as_ref()
            .is_some_and(|selected| selected.contains(&id));
        let use_values = selected.as_ref().map_or(true, |_| explicit);
        if !use_values {
            continue;
        }
        if model_only {
            ensure!(available, "The selected secret is not available to agents.");
        }
        for (name, value) in values.as_object().expect("environment") {
            ensure!(
                supplied.insert(name.to_ascii_uppercase()),
                "The selected secrets contain conflicting environment variable names."
            );
            environment.insert(name.clone(), value.clone());
        }
    }
    let mut hidden = hidden.into_values().collect::<Vec<_>>();
    sort_names(&mut hidden);
    let result = json!({"environment":environment,"hiddenEnvironmentVariables":hidden});
    ensure!(
        schemas.valid("secretCommandEnvironment", &result)?,
        "The resolved secret command environment is invalid."
    );
    Ok(result)
}
fn environment_values(row: &Value, schemas: &Schemas) -> Result<Value> {
    environment(row, schemas, false)
}
