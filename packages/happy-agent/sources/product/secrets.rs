//! Installation-wide secret catalog and explicit command grants.
mod dotenv;
mod persistence;
#[cfg(test)]
mod tests;
mod tools;
use super::{
    config::ConfigModule,
    durable::DurableFunctionsModule,
    events::EventsModule,
    identity::{Versions, now},
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result, ensure};
use happy_providers::ToolDefinition;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
const GLOBAL: &str = "global";

#[derive(Debug)]
pub struct SecretInputError(pub String);
impl std::fmt::Display for SecretInputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for SecretInputError {}
#[derive(Debug)]
pub struct SecretConflictError {
    pub message: String,
    pub current: Option<Value>,
}
impl std::fmt::Display for SecretConflictError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for SecretConflictError {}
#[derive(Clone)]
pub struct SecretsModule {
    _config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    _durable: Arc<DurableFunctionsModule>,
    events: Arc<EventsModule>,
    schemas: Arc<Schemas>,
    definitions: Arc<Vec<ToolDefinition>>,
}
impl SecretsModule {
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        events: Arc<EventsModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Arc::new(Schemas::new()?);
        let definitions = serde_json::from_str(include_str!("secrets/tool_definitions.json"))?;
        Ok(Arc::new(Self {
            _config: config,
            runtime,
            _durable: durable,
            events,
            schemas,
            definitions: Arc::new(definitions),
        }))
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        persistence::migrate(&self.runtime).await
    }
    fn validate(&self, name: &str, value: &Value) -> Result<()> {
        if !self.schemas.valid(name, value)? {
            return Err(SecretInputError("The secret request is invalid.".into()).into());
        }
        Ok(())
    }
    fn context(&self, ctx: &Context<'_>) -> Result<()> {
        self.runtime.assert_context(ctx)
    }
    pub fn get(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        self.context(ctx)?;
        self.validate("secretId", &json!(id))?;
        persistence::get(ctx, id, &self.schemas)
    }
    pub fn list(&self, ctx: &Context<'_>, query: &Value) -> Result<Value> {
        self.context(ctx)?;
        let mut query = query.clone();
        if query.get("limit").is_none() {
            query["limit"] = json!(50);
        }
        self.validate("secretList", &query)?;
        let result = persistence::list(ctx, &query, &self.schemas)?;
        self.validate("secretPage", &result)?;
        Ok(result)
    }
    pub fn create(
        &self,
        ctx: &Context<'_>,
        input: &Value,
        mutation: Option<&Value>,
    ) -> Result<Value> {
        self.context(ctx)?;
        self.validate("secretCreate", input)?;
        let mut input = input.clone();
        input["description"] = json!(trim_text(
            input["description"].as_str().expect("description")
        ));
        if input.get("id").is_none() {
            input["id"] = json!(cuid2::create_id());
        }
        if input.get("availableToAgents").is_none() {
            input["availableToAgents"] = json!(true);
        }
        self.validate("secretCreate", &input)?;
        validate_environment(&self.schemas, &input["environment"], true)?;
        let record = persistence::create(ctx, &input, &self.schemas)?;
        self.publish(ctx, "secret.created", json!({"secret":record}), mutation)?;
        Ok(record)
    }
    pub fn update(
        &self,
        ctx: &Context<'_>,
        id: &str,
        input: &Value,
        expected: &str,
        mutation: Option<&Value>,
    ) -> Result<Option<Value>> {
        self.context(ctx)?;
        self.validate("secretId", &json!(id))?;
        self.validate("secretUpdate", input)?;
        let mut input = input.clone();
        if let Some(description) = input.get("description").and_then(Value::as_str) {
            input["description"] = json!(trim_text(description));
        }
        self.validate("secretUpdate", &input)?;
        if let Some(environment) = input.get("environment") {
            validate_environment_names(&self.schemas, environment)?;
        }
        let Some((previous, record, changed)) =
            persistence::update(ctx, id, &input, expected, &self.schemas)?
        else {
            return Ok(None);
        };
        if changed {
            let mut changes = serde_json::Map::new();
            for key in [
                "description",
                "environmentVariables",
                "managed",
                "availableToAgents",
                "createdAt",
                "updatedAt",
            ] {
                if previous[key] != record[key] {
                    changes.insert(key.into(), record[key].clone());
                }
            }
            self.publish(ctx,"secret.updated",json!({"secretId":id,"previousVersion":previous["version"],"version":record["version"],"changes":changes}),mutation)?;
        }
        Ok(Some(record))
    }
    pub fn attachment_page(
        &self,
        ctx: &Context<'_>,
        id: &str,
        query: &Value,
    ) -> Result<Option<Value>> {
        self.context(ctx)?;
        self.validate("secretId", &json!(id))?;
        let mut query = query.clone();
        if query.get("limit").is_none() {
            query["limit"] = json!(50);
        }
        self.validate("secretAttachmentList", &query)?;
        if self.get(ctx, id)?.is_none() {
            return Ok(None);
        }
        let result = persistence::attachment_page(ctx, id, &query, &self.schemas)?;
        self.validate("secretAttachmentPage", &result)?;
        Ok(Some(result))
    }
    pub fn attach(
        &self,
        ctx: &Context<'_>,
        id: &str,
        target: &Value,
        mutation: Option<&Value>,
    ) -> Result<(Value, bool)> {
        self.context(ctx)?;
        self.validate("secretId", &json!(id))?;
        self.validate("secretTarget", target)?;
        let (result, created) = persistence::attach(ctx, id, target, &self.schemas)?;
        if created {
            self.publish(
                ctx,
                "secret.attached",
                json!({"attachment":result}),
                mutation,
            )?;
        }
        Ok((result, created))
    }
    pub fn detach(
        &self,
        ctx: &Context<'_>,
        id: &str,
        target: &Value,
        mutation: Option<&Value>,
    ) -> Result<Option<Value>> {
        self.context(ctx)?;
        self.validate("secretId", &json!(id))?;
        self.validate("secretTarget", target)?;
        let result = persistence::detach(ctx, id, target, &self.schemas)?;
        if let Some(result) = &result {
            self.publish(
                ctx,
                "secret.detached",
                json!({"attachment":result}),
                mutation,
            )?;
        }
        Ok(result)
    }
    pub fn retire_managed_catalog_secret(
        &self,
        ctx: &Context<'_>,
        kind: &str,
        id: &str,
    ) -> Result<bool> {
        self.context(ctx)?;
        self.validate("secretManagedKind", &json!(kind))?;
        self.validate("secretId", &json!(id))?;
        let Some(previous) = persistence::retire(ctx, id, kind, &self.schemas)? else {
            return Ok(false);
        };
        self.publish(
            ctx,
            "secret.removed",
            json!({"secretId":id,"previousVersion":previous["version"]}),
            None,
        )?;
        Ok(true)
    }
    pub fn resolve_for_command_targets(
        &self,
        ctx: &Context<'_>,
        targets: &Value,
        selected: &Value,
    ) -> Result<Value> {
        self.context(ctx)?;
        self.validate("secretCommandTargets", targets)?;
        self.validate("secretSelectedIds", selected)?;
        persistence::resolve(ctx, GLOBAL, targets, Some(selected), true, &self.schemas)
    }
    pub fn resolve_for_host(
        &self,
        ctx: &Context<'_>,
        owner: &str,
        scope: &str,
        selected: Option<&Value>,
    ) -> Result<Value> {
        self.context(ctx)?;
        self.validate("secretActorId", &json!(owner))?;
        self.validate("secretScope", &json!(scope))?;
        if let Some(selected) = selected {
            self.validate("secretSelectedIds", selected)?;
        }
        let result = persistence::resolve(
            ctx,
            owner,
            &json!([{"type":"agent","id":scope}]),
            selected,
            false,
            &self.schemas,
        )?;
        Ok(result["environment"].clone())
    }
    fn publish(
        &self,
        ctx: &Context<'_>,
        name: &str,
        mut payload: Value,
        mutation: Option<&Value>,
    ) -> Result<()> {
        if let Some(mutation) = mutation {
            payload["mutationId"] = mutation.clone();
        }
        self.events.record(ctx, None, name, payload)?;
        Ok(())
    }
}
fn unique_names(environment: &Value) -> Result<()> {
    let mut seen = BTreeSet::new();
    for name in environment
        .as_object()
        .context("The secret environment is invalid.")?
        .keys()
    {
        if !seen.insert(name.to_ascii_uppercase()) {
            return Err(SecretInputError(
                "Secret environment variable names must be unique without regard to case.".into(),
            )
            .into());
        }
    }
    Ok(())
}
fn trim_text(value: &str) -> &str {
    value.trim_matches(|c:char|matches!(c as u32,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028..=0x2029|0x202f|0x205f|0x3000|0xfeff))
}
fn validate_environment(schemas: &Schemas, environment: &Value, nonempty: bool) -> Result<()> {
    if !schemas.valid("secretHostEnvironment", environment)?
        || nonempty && environment.as_object().is_none_or(|value| value.is_empty())
    {
        return Err(SecretInputError("The secret environment is invalid.".into()).into());
    }
    validate_environment_names(schemas, environment)
}
fn validate_environment_names(schemas: &Schemas, environment: &Value) -> Result<()> {
    for name in environment
        .as_object()
        .context("The secret environment is invalid.")?
        .keys()
    {
        if !schemas.valid("secretEnvironmentName", &json!(name))? {
            return Err(SecretInputError(
                "The secret environment variable name is invalid.".into(),
            )
            .into());
        }
    }
    unique_names(environment)
}
fn sort_names(names: &mut [String]) {
    fn key(name: &str) -> Vec<u8> {
        name.bytes()
            .map(|byte| {
                if byte == b'_' {
                    0
                } else {
                    byte.to_ascii_lowercase()
                }
            })
            .collect()
    }
    names.sort_by_key(|name| key(name));
}
fn names(environment: &Value) -> Vec<String> {
    let mut names = environment
        .as_object()
        .expect("validated environment")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    sort_names(&mut names);
    names
}
