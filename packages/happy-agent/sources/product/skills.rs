//! Live, bounded discovery of instruction resources on each agent's compute.
use super::{
    agent_runtime::AgentRuntimeModule,
    config::ConfigModule,
    owners::GlobalSkillsModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
    tools::{ComputeFilesystem, ToolsModule},
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use futures_util::future::{BoxFuture, FutureExt, Shared};
use happy_agent_base::{AcceptedInput, AgentModule, AgentScope, ToolPermissionPolicy};
use happy_providers::{Block, Message, ToolDefinition};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;
mod discovery;
mod format;
const DOCUMENT_BYTES: usize = 256 * 1024;
const MAX_SKILLS: usize = 256;
const INVOCATIONS: &str = "slash-command-invocations";
const READ_REQUESTS: &str = "skill-read-requests";
type Scan = Shared<BoxFuture<'static, std::result::Result<Arc<Vec<Value>>, Arc<String>>>>;
type Scans = Arc<Mutex<BTreeMap<String, Scan>>>;
pub struct SkillsModule {
    config: Arc<ConfigModule>,
    compute: Arc<ToolsModule>,
    global: Arc<GlobalSkillsModule>,
    runtime: Arc<RuntimeModule>,
    agents: Arc<AgentRuntimeModule>,
    schemas: Schemas,
    scans: Scans,
    owner: std::sync::Weak<SkillsModule>,
}
struct ScanGuard {
    scans: Scans,
    key: String,
}
impl Drop for ScanGuard {
    fn drop(&mut self) {
        self.scans
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.key);
    }
}
fn definitions() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("skills/tool_definitions.json"))
        .expect("The original skill tools are valid.")
}
fn definition(call: &Value) -> Option<ToolDefinition> {
    definitions().into_iter().find(|tool| {
        call["call"]["name"] == tool.name
            && call["call"]["namespace"].as_str() == tool.namespace.as_deref()
    })
}
fn lifetime(call: &Value, field: &str) -> Option<bool> {
    let tool = definition(call)?;
    let data: Value = serde_json::from_str(include_str!("skills/tool_lifetimes.json"))
        .expect("The original skill lifetimes are valid.");
    data.as_array()?
        .iter()
        .find(|entry| entry["name"] == tool.name)?[field]
        .as_bool()
}
fn run_key(agent: &str, key: &str) -> String {
    format!("kv.{agent}.run.module.skills.{key}")
}
fn model_entries(entries: &[Value]) -> Vec<Value> {
    entries
        .iter()
        .filter(|entry| entry["disableModelInvocation"] != true)
        .cloned()
        .collect()
}
fn invokes(invocation: &Value, entry: &Value) -> bool {
    invocation["name"] == entry["name"]
        && invocation
            .get("location")
            .is_none_or(|location| location == &entry["location"])
}
fn decode(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
}
fn trim(text: &str) -> &str {
    text.trim_matches(|value: char| {
        value == '\u{feff}'
            || matches!(
                value,
                '\t' | '\n'
                    | '\u{000b}'
                    | '\u{000c}'
                    | '\r'
                    | ' '
                    | '\u{00a0}'
                    | '\u{1680}'
                    | '\u{2000}'
                    ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
            )
    })
}
impl SkillsModule {
    pub fn new(
        config: Arc<ConfigModule>,
        compute: Arc<ToolsModule>,
        global: Arc<GlobalSkillsModule>,
        runtime: Arc<RuntimeModule>,
        agents: Arc<AgentRuntimeModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        let module = Arc::new_cyclic(|owner| Self {
            config,
            compute,
            global,
            runtime,
            agents: agents.clone(),
            schemas,
            scans: Arc::new(Mutex::new(BTreeMap::new())),
            owner: owner.clone(),
        });
        agents.install(module.clone())?;
        Ok(module)
    }
    fn state(&self, ctx: &Context<'_>, agent: &str, key: &str, schema: &str) -> Result<Vec<Value>> {
        self.runtime.assert_context(ctx)?;
        let value = ctx.value(agent, &run_key(agent, key))?.unwrap_or(json!([]));
        anyhow::ensure!(
            self.schemas.valid(schema, &value)?,
            "The skills module found invalid {} state.",
            if key == INVOCATIONS {
                "invoked-skill"
            } else {
                "requested-skill"
            }
        );
        Ok(value.as_array().unwrap().clone())
    }
    async fn invocation_state(&self, agent: &str) -> Result<(Vec<Value>, Vec<Value>)> {
        let owner = self
            .owner
            .upgrade()
            .context("The skills module was closed.")?;
        let agent = agent.to_owned();
        self.runtime
            .transact(move |ctx| {
                Ok((
                    owner.state(ctx, &agent, INVOCATIONS, "ownerDiscoveredSkillInvocations")?,
                    owner.state(
                        ctx,
                        &agent,
                        READ_REQUESTS,
                        "ownerDiscoveredSkillReadRequests",
                    )?,
                ))
            })
            .await
    }
    async fn unavailable(&self, compute: &ComputeFilesystem) -> Result<BTreeSet<PathBuf>> {
        if !compute.is_native() || !self.global.manages_home(compute.home().as_deref()) {
            return Ok(BTreeSet::new());
        }
        let global = self.global.clone();
        self.runtime
            .transact(move |ctx| global.unavailable_locations(ctx))
            .await
    }
    async fn entries(
        &self,
        compute: ComputeFilesystem,
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>> {
        let unavailable = self.unavailable(&compute).await?;
        let directories = if compute.is_native() {
            self.config.global_skill_directories()
        } else {
            Vec::new()
        };
        let key = serde_json::to_string(&json!([
            compute.identity(),
            compute.cwd(),
            compute.home(),
            compute.permissions(),
            unavailable,
            directories
        ]))?;
        let owner = self
            .owner
            .upgrade()
            .context("The skills module was closed.")?;
        let (scan, guard) = {
            let mut scans = self
                .scans
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(scan) = scans.get(&key) {
                (scan.clone(), None)
            } else {
                let compute = compute.clone();
                let cancel = cancel.clone();
                let scan = async move {
                    owner
                        .discover(&compute, &unavailable, &directories, &cancel)
                        .await
                        .map(Arc::new)
                        .map_err(|error| Arc::new(error.to_string()))
                }
                .boxed()
                .shared();
                if scans.len() < 128 {
                    scans.insert(key.clone(), scan.clone());
                    (
                        scan,
                        Some(ScanGuard {
                            scans: self.scans.clone(),
                            key,
                        }),
                    )
                } else {
                    (scan, None)
                }
            }
        };
        let entries = scan.await.map_err(|error| anyhow::anyhow!("{error}"))?;
        drop(guard);
        let unavailable = self.unavailable(&compute).await?;
        Ok(entries
            .iter()
            .filter(|entry| {
                entry["source"] != "user"
                    || !unavailable.contains(Path::new(entry["location"].as_str().unwrap()))
            })
            .cloned()
            .collect())
    }
    async fn catalog(
        &self,
        scope: &AgentScope<'_>,
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>> {
        match self.compute.skill_compute(scope, cancel).await? {
            Some(compute) => self.entries(compute, cancel).await,
            None => Ok(Vec::new()),
        }
    }
    pub async fn list(
        &self,
        scope: &AgentScope<'_>,
        input: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        anyhow::ensure!(
            self.schemas.valid("ownerDiscoveredSkillListInput", input)?,
            "Skill list input is invalid."
        );
        let entries = model_entries(&self.catalog(scope, cancel).await?);
        let query = input["query"]
            .as_str()
            .map(|query| trim(query).to_lowercase())
            .unwrap_or_default();
        let filtered = entries
            .into_iter()
            .filter(|entry| {
                query.is_empty()
                    || entry["name"]
                        .as_str()
                        .unwrap()
                        .to_lowercase()
                        .contains(&query)
                    || entry["description"]
                        .as_str()
                        .unwrap()
                        .to_lowercase()
                        .contains(&query)
            })
            .collect::<Vec<_>>();
        let offset = input["cursor"]
            .as_str()
            .map(str::parse::<usize>)
            .transpose()
            .context("Skill list cursor is invalid.")?
            .unwrap_or(0);
        let result = format::page(
            &filtered,
            offset,
            input["limit"].as_u64().unwrap_or(MAX_SKILLS as u64) as usize,
        );
        anyhow::ensure!(
            self.schemas.valid("ownerDiscoveredSkillList", &result)?,
            "Skill list result is invalid."
        );
        Ok(result)
    }
    pub async fn read(
        &self,
        scope: &AgentScope<'_>,
        input: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.read_document(scope, input, false, false, cancel).await
    }
    async fn read_document(
        &self,
        scope: &AgentScope<'_>,
        input: &Value,
        for_run: bool,
        user: bool,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        anyhow::ensure!(
            self.schemas.valid("ownerDiscoveredSkillReadInput", input)?,
            "Skill read input is invalid."
        );
        let compute = self
            .compute
            .skill_compute(scope, cancel)
            .await?
            .context("This agent has no compute.")?;
        let entries = self.entries(compute.clone(), cancel).await?;
        let name = input["name"].as_str().unwrap();
        let entry = entries
            .iter()
            .find(|entry| entry["name"] == name)
            .with_context(|| format!("Unknown skill \"{name}\"."))?;
        if !user && entry["disableModelInvocation"] == true {
            let (invocations, requests) = if for_run {
                self.invocation_state(scope.id).await?
            } else {
                (Vec::new(), Vec::new())
            };
            anyhow::ensure!(
                requests.iter().any(|request| request == name)
                    || invocations
                        .iter()
                        .any(|invocation| invokes(invocation, entry)),
                "The \"{name}\" skill can only be invoked by the user with /{name}, not by the model."
            );
        }
        let bytes = compute
            .read_file(
                Path::new(entry["location"].as_str().unwrap()),
                DOCUMENT_BYTES,
                true,
                cancel,
            )
            .await?;
        let document = json!({"content":decode(&bytes),"location":entry["location"],"name":name});
        anyhow::ensure!(
            self.schemas
                .valid("ownerDiscoveredSkillDocument", &document)?,
            "Skill document is invalid."
        );
        Ok(document)
    }
    pub async fn slash_commands(
        &self,
        scope: &AgentScope<'_>,
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>> {
        self.catalog(scope,cancel).await?.iter().map(|entry|{let command=json!({"description":entry["description"],"hasArguments":true,"kind":"skill","name":entry["name"]});anyhow::ensure!(self.schemas.valid("ownerDiscoveredSkillSlashCommand",&command)?,"The skills module produced an invalid public slash command.");Ok(command)}).collect()
    }
    /// Read on the current compute before the caller enters its durable mutation.
    pub async fn prepare_slash_invocation(
        &self,
        scope: &AgentScope<'_>,
        name: &str,
        input: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        anyhow::ensure!(
            self.schemas
                .valid("ownerDiscoveredSkillSlashRequest", input)?,
            "The slash command invocation is invalid."
        );
        let document = self
            .read_document(scope, &json!({"name":name}), false, true, cancel)
            .await?;
        let prepared = json!({"agentId":scope.id,"request":input,"document":document,"messageId":cuid2::create_id()});
        anyhow::ensure!(
            self.schemas
                .valid("ownerDiscoveredSkillSlashPreparation", &prepared)?,
            "The prepared skill invocation is invalid."
        );
        Ok(prepared)
    }
    /// Queue and mode metadata participate in the caller's existing transaction.
    pub fn invoke_slash_command(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        prepared: &Value,
    ) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas
                .valid("ownerDiscoveredSkillSlashPreparation", prepared)?
                && prepared["agentId"] == agent,
            "The prepared skill invocation is invalid."
        );
        let (queued, metadata) = slash_input(prepared);
        self.agents.enqueue(ctx, agent, &queued, false)?;
        self.agents.update_metadata(ctx, agent, &metadata)
    }
    fn arguments(&self, call: &Value) -> Result<Value> {
        let input: Value = serde_json::from_str(
            call["call"]["arguments"]
                .as_str()
                .context("The skill tool arguments are missing.")?,
        )?;
        anyhow::ensure!(
            self.schemas.valid(
                &format!("ownerTool_{}", call["call"]["name"].as_str().unwrap()),
                &input
            )?,
            "The skill tool arguments are invalid."
        );
        Ok(input)
    }
}
#[async_trait]
impl AgentModule for SkillsModule {
    fn name(&self) -> &'static str {
        "skills"
    }
    fn accepted(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        inputs: &[AcceptedInput],
        _: bool,
    ) -> Result<()> {
        for accepted in inputs {
            let input = &accepted.input;
            if input["metadata"]["messageOrigin"] == "user" {
                if let Some(request) = input["message"]["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|request| {
                        self.schemas
                            .valid("ownerDiscoveredSkillReadRequest", request)
                            .unwrap_or(false)
                    })
                {
                    let mut current = self.state(
                        ctx,
                        scope.id,
                        READ_REQUESTS,
                        "ownerDiscoveredSkillReadRequests",
                    )?;
                    let name = request["arguments"]["name"].clone();
                    if !current.contains(&name) {
                        anyhow::ensure!(
                            current.len() < 16,
                            "Too many skills were invoked in one agent run."
                        );
                        current.push(name);
                        ctx.put_value(
                            scope.id,
                            &run_key(scope.id, READ_REQUESTS),
                            &json!(current),
                        )?;
                    }
                }
            }
            let invocation = &input["metadata"]["skillInvocation"];
            if !self
                .schemas
                .valid("ownerDiscoveredSkillInvocation", invocation)?
            {
                continue;
            }
            let mut current = self.state(
                ctx,
                scope.id,
                INVOCATIONS,
                "ownerDiscoveredSkillInvocations",
            )?;
            if current
                .iter()
                .any(|entry| entry["messageId"] == invocation["messageId"])
            {
                continue;
            }
            anyhow::ensure!(
                current.len() < 16,
                "Too many skills were invoked in one agent run."
            );
            current.push(invocation.clone());
            ctx.put_value(scope.id, &run_key(scope.id, INVOCATIONS), &json!(current))?;
        }
        Ok(())
    }
    async fn instructions(&self, scope: &AgentScope<'_>) -> Result<String> {
        let entries = self.catalog(scope, &CancellationToken::new()).await?;
        let (invocations, _) = self.invocation_state(scope.id).await?;
        let catalog = model_entries(&entries);
        let mut sections = Vec::new();
        if !catalog.is_empty() {
            sections.push(format::instructions(&catalog));
        }
        sections.extend(
            invocations
                .iter()
                .filter(|invocation| entries.iter().any(|entry| invokes(invocation, entry)))
                .map(format::invoked),
        );
        Ok(sections.join("\n\n"))
    }
    async fn available_tools(&self, scope: &AgentScope<'_>) -> Result<Vec<ToolDefinition>> {
        Ok(
            if self
                .compute
                .skill_compute(scope, &CancellationToken::new())
                .await?
                .is_some()
            {
                definitions()
            } else {
                Vec::new()
            },
        )
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        lifetime(call, "durable")
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        lifetime(call, "reloadable")
    }
    fn permission_policy(
        &self,
        _: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<ToolPermissionPolicy>> {
        let tool = definition(call)?;
        Some(Ok(ToolPermissionPolicy {
            should_review_in_auto_mode: false,
            should_run_in_full_access_in_auto_mode: false,
            requires_auto_or_full_access: false,
            action: tool.description,
            instructions: None,
        }))
    }
    async fn execute_tool(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        let tool = definition(call)?;
        let result: Result<String> = async {
            let input = self.arguments(call)?;
            if tool.name == "list_skills" {
                Ok(format::render_list(
                    &self.list(scope, &input, &cancel).await?,
                ))
            } else {
                Ok(self
                    .read_document(scope, &input, true, false, &cancel)
                    .await?["content"]
                    .as_str()
                    .unwrap()
                    .to_owned())
            }
        }
        .await;
        Some(Message::Tool {
            call_id: call["id"].as_str().unwrap_or("").to_owned(),
            content: vec![Block::text(match &result {
                Ok(text) => text.clone(),
                Err(error) => error.to_string(),
            })],
            is_error: result.is_err(),
            vendor: None,
        })
    }
}
fn slash_input(prepared: &Value) -> (Value, Value) {
    let request = &prepared["request"];
    let document = &prepared["document"];
    let name = document["name"].as_str().unwrap();
    let message_id = &prepared["messageId"];
    let text = match request["arguments"].as_str() {
        Some(arguments) => format!("Use the /{name} skill.\n\n{arguments}"),
        None => format!("Use the /{name} skill."),
    };
    let mut metadata = json!({"messageOrigin":"user","mode":request["mode"],"skillInvocation":{"content":document["content"],"messageId":message_id,"name":name,"location":document["location"]}});
    if let Some(mutation) = request.get("mutationId") {
        metadata["mutationId"] = mutation.clone();
    }
    let mode = &request["mode"];
    let mut options = json!({"provider":mode["providerId"],"model":mode["modelId"],"effort":mode["effort"],"permissionMode":mode["permissionMode"]});
    if let Some(tier) = mode.get("serviceTier") {
        options["serviceTier"] = tier.clone();
    }
    (
        json!({"id":message_id,"message":{"role":"user","content":[{"type":"text","text":text}]},"options":options,"metadata":metadata}),
        json!({"lastMode":mode}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_pages_and_instruction_contributions_match_the_original_source() {
        let golden: Value =
            serde_json::from_str(include_str!("skills/source_goldens.json")).unwrap();
        let entries = golden["entries"].as_array().unwrap();
        assert_eq!(format::instructions(entries), golden["instructions"]);
        assert_eq!(
            format::render_list(&json!({"skills":[]})),
            golden["emptyList"]
        );
        for page in golden["pages"].as_array().unwrap() {
            assert_eq!(
                format::page(
                    entries,
                    page["offset"].as_u64().unwrap() as usize,
                    page["limit"].as_u64().unwrap() as usize
                ),
                page["result"]
            );
        }
        assert_eq!(
            format::render_list(&golden["pages"][0]["result"]),
            golden["list"]
        );
        assert_eq!(
            format::invoked(&golden["invocation"]),
            golden["invokedInstructions"]
        );
    }
    #[test]
    fn skill_slash_invocation_preserves_original_message_mode_arguments_and_provenance() {
        let golden: Value =
            serde_json::from_str(include_str!("skills/source_goldens.json")).unwrap();
        for (index, case) in golden["invocationGoldens"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let document = &case["options"]["metadata"]["skillInvocation"];
            let mut request =
                json!({"mode":case["updatedMetadata"]["lastMode"],"mutationId":"source-mutation"});
            if index > 0 {
                request["arguments"] = json!(if index == 1 {
                    ""
                } else {
                    "inspect authentication"
                });
            }
            let (queued, updated) = slash_input(
                &json!({"agentId":"source-agent","request":request,"document":{"name":document["name"],"location":document["location"],"content":document["content"]},"messageId":"source-generated"}),
            );
            let mut options = case["options"].clone();
            let metadata = options.as_object_mut().unwrap().remove("metadata").unwrap();
            let id = options.as_object_mut().unwrap().remove("id").unwrap();
            assert_eq!(queued["id"], id);
            assert_eq!(queued["message"], case["message"]);
            assert_eq!(queued["options"], options);
            assert_eq!(queued["metadata"], metadata);
            assert_eq!(updated, case["updatedMetadata"]);
        }
    }
    #[tokio::test]
    async fn discovery_uses_the_global_owners_original_yaml_metadata_parser() {
        let fixture = super::super::owners::Fixture::new().await;
        let golden: Value =
            serde_json::from_str(include_str!("skills/source_goldens.json")).unwrap();
        for case in golden["parserCases"].as_array().unwrap() {
            let metadata = fixture.skills.parse_metadata(
                case["content"].as_str().unwrap(),
                case["directory"].as_str().unwrap(),
            );
            if case.get("error").is_some() {
                assert!(metadata.is_err(), "{case}");
            } else {
                assert_eq!(metadata.unwrap(), case["metadata"], "{case}");
            }
        }
        fixture.close().await;
    }
}
