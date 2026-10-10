//! Real ancestry, curated delegation and transactional reports through Agent Base.
use super::{
    agent_runtime::AgentRuntimeModule,
    config::ConfigModule,
    durable::DurableFunctionsModule,
    history::HistoryModule,
    lifecycle::LifecycleModule,
    owners::AbortModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope};
use happy_providers::{Block, Message, ToolDefinition};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{Arc, Weak},
};
mod persistence;
mod tools;

pub struct CollaborationModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    agents: Arc<AgentRuntimeModule>,
    abort: Arc<AbortModule>,
    history: Arc<HistoryModule>,
    _durable: Arc<DurableFunctionsModule>,
    owner: Weak<Self>,
    schemas: Schemas,
}
impl CollaborationModule {
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        agents: Arc<AgentRuntimeModule>,
        abort: Arc<AbortModule>,
        history: Arc<HistoryModule>,
        durable: Arc<DurableFunctionsModule>,
        _lifecycle: Arc<LifecycleModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in [
            "ownerCollaborationId",
            "ownerCollaborationCreateInput",
            "ownerCollaborationOptions",
            "ownerCollaborationSelection",
            "ownerCollaborationSendInput",
            "ownerCollaborationArchivedMetadata",
            "ownerCollaborationNoReport",
            "ownerCollaborationWorkflowMetadata",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        let module = Arc::new_cyclic(|owner| Self {
            config,
            runtime,
            agents: agents.clone(),
            abort,
            history,
            _durable: durable,
            owner: owner.clone(),
            schemas,
        });
        agents.install(module.clone())?;
        Ok(module)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime
            .migrate("collaboration", persistence::MIGRATIONS)
            .await
    }
    pub fn available_models(&self) -> Result<Vec<Value>> {
        self.config.available_subagent_models()
    }
    pub fn select_model(&self, input: &Value, current_provider: Option<&str>) -> Result<Value> {
        anyhow::ensure!(
            self.schemas.valid("ownerCollaborationCreateInput", input)?,
            "Invalid collaboration create agent."
        );
        let models = self.available_models()?;
        let provider = input["provider"].as_str().or_else(|| {
            current_provider.filter(|provider| {
                models
                    .iter()
                    .any(|model| model["id"] == input["model"] && model["providerId"] == *provider)
            })
        });
        if provider.is_none() {
            let providers = models
                .iter()
                .filter(|model| model["id"] == input["model"])
                .filter_map(|model| model["providerId"].as_str())
                .collect::<BTreeSet<_>>();
            anyhow::ensure!(
                providers.len() <= 1,
                "Provider is required because model {} is available from more than one provider.",
                input["model"]
            );
        }
        let candidates = models
            .iter()
            .filter(|model| {
                model["id"] == input["model"]
                    && provider.is_none_or(|provider| model["providerId"] == provider)
            })
            .collect::<Vec<_>>();
        anyhow::ensure!(
            !candidates.is_empty(),
            "The selected collaborator model is unavailable."
        );
        let by_effort = candidates
            .into_iter()
            .filter(|model| {
                model["effortLevels"]
                    .as_array()
                    .is_some_and(|efforts| efforts.contains(&input["effort"]))
            })
            .collect::<Vec<_>>();
        anyhow::ensure!(
            !by_effort.is_empty(),
            "The selected effort is unavailable for the collaborator model."
        );
        let selected = by_effort
            .into_iter()
            .find(|model| {
                input.get("serviceTier").is_none_or(|tier| {
                    model["serviceTiers"]
                        .as_array()
                        .is_some_and(|tiers| tiers.contains(tier))
                })
            })
            .context("The selected service tier is unavailable for the collaborator model.")?;
        let mut selection = json!({"provider":selected["providerId"],"model":input["model"],"effort":input["effort"]});
        if let Some(tier) = input.get("serviceTier") {
            selection["serviceTier"] = tier.clone();
        }
        anyhow::ensure!(
            self.schemas
                .valid("ownerCollaborationSelection", &selection)?,
            "The resolved collaborator selection is invalid."
        );
        Ok(selection)
    }
    pub fn create_agent(
        &self,
        ctx: &Context<'_>,
        parent: &str,
        input: &Value,
        id: &str,
        options: &Value,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        self.assert_id(parent)?;
        self.assert_id(id)?;
        anyhow::ensure!(
            self.schemas.valid("ownerCollaborationOptions", options)?,
            "Invalid collaboration create agent options."
        );
        let selection = self.select_model(input, None)?;
        self.create_selected(ctx, parent, input, id, options, &selection)
    }
    fn create_selected(
        &self,
        ctx: &Context<'_>,
        parent: &str,
        input: &Value,
        id: &str,
        options: &Value,
        selection: &Value,
    ) -> Result<Value> {
        if self.agents.configuration(ctx, id)?.is_none() {
            let parent_config = self
                .agents
                .configuration(ctx, parent)?
                .context("The creating agent was not found.")?;
            let mut config =
                json!({"metadata":options.get("metadata").cloned().unwrap_or_else(||json!({}))});
            for field in ["environment", "modules"] {
                if let Some(value) = parent_config.get(field) {
                    config[field] = value.clone();
                }
            }
            config["metadata"]["title"] = input["title"].clone();
            if options["reportToCreator"] == false {
                config["metadata"]["collaboration"] = json!({"reportToCreator":false});
            }
            self.agents.create_from(ctx, id, &config, Some(parent))?;
            self.agents.set_parent(ctx, id, parent)?;
        } else {
            anyhow::ensure!(
                self.agents.parent(ctx, id)?.as_deref() == Some(parent),
                "That agent identity already belongs to another creator."
            );
        }
        self.deliver(
            ctx,
            parent,
            id,
            input["text"]
                .as_str()
                .context("The opening collaborator task is missing.")?,
            id,
            false,
            Some(selection),
        )?;
        Ok(json!({"agentId":id}))
    }
    pub fn create_tool_agent(
        &self,
        ctx: &Context<'_>,
        parent: &str,
        input: &Value,
        id: &str,
        current_provider: Option<&str>,
    ) -> Result<Value> {
        let retained = self.history.tool_spawn_presentation(ctx, parent, id)?;
        if let Some(model) = retained.as_ref().and_then(|retained| retained.get("model")) {
            anyhow::ensure!(
                model["modelId"] == input["model"],
                "The spawning tool call already selected another model."
            );
        }
        let mut resolved = input.clone();
        if let Some(provider) = retained
            .as_ref()
            .and_then(|retained| retained["model"]["providerId"].as_str())
        {
            resolved["provider"] = json!(provider);
        }
        let selection = self.select_model(&resolved, current_provider)?;
        let models = self.available_models()?;
        let model = models
            .iter()
            .find(|model| {
                model["id"] == selection["model"] && model["providerId"] == selection["provider"]
            })
            .context("The resolved collaborator model is unavailable.")?;
        let mut presentation = json!({"type":"agent_spawn","model":retained.as_ref().and_then(|retained|retained.get("model")).cloned().unwrap_or_else(||json!({"modelId":model["id"],"providerId":model["providerId"],"name":model["name"]}))});
        self.history
            .record_tool_spawn_presentation(ctx, parent, id, &presentation)?;
        if self.agents.configuration(ctx, id)?.is_none() {
            self.assert_tool_capacity(ctx, parent)?;
        }
        let result = self.create_selected(ctx, parent, input, id, &json!({}), &selection)?;
        presentation["agentId"] = json!(id);
        self.history
            .record_tool_spawn_presentation(ctx, parent, id, &presentation)?;
        Ok(result)
    }
    pub fn send_message(
        &self,
        ctx: &Context<'_>,
        sender: &str,
        input: &Value,
        message: &str,
    ) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        self.assert_id(sender)?;
        anyhow::ensure!(
            self.schemas.valid("ownerCollaborationSendInput", input)?,
            "Invalid collaboration send message."
        );
        let target = input["toAgentId"].as_str().unwrap();
        let direct = self.direct_relationship(ctx, sender, target)?;
        if !direct {
            anyhow::ensure!(
                self.config.collaboration_limits().cross_workspace && sender != target,
                "The acting agent is not authorized to send to that agent."
            );
            anyhow::ensure!(
                self.agents.configuration(ctx, target)?.is_some(),
                "The receiving agent does not exist."
            );
        }
        self.deliver(
            ctx,
            sender,
            target,
            input["text"].as_str().unwrap(),
            message,
            true,
            None,
        )
    }
    pub fn interrupt_agent(&self, ctx: &Context<'_>, sender: &str, target: &str) -> Result<()> {
        self.assert_id(sender)?;
        self.assert_id(target)?;
        anyhow::ensure!(
            self.direct_relationship(ctx, sender, target)?,
            "The acting agent is not authorized to interrupt that agent."
        );
        self.abort.abort(ctx, target)
    }
    fn direct_relationship(&self, ctx: &Context<'_>, sender: &str, target: &str) -> Result<bool> {
        Ok(self.agents.parent(ctx, target)?.as_deref() == Some(sender)
            || self.agents.parent(ctx, sender)?.as_deref() == Some(target))
    }
    fn assert_id(&self, id: &str) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid("ownerCollaborationId", &json!(id))?,
            "Invalid collaboration agent ID."
        );
        Ok(())
    }
    fn deliver(
        &self,
        ctx: &Context<'_>,
        sender: &str,
        target: &str,
        text: &str,
        id: &str,
        steering: bool,
        selection: Option<&Value>,
    ) -> Result<()> {
        let configuration = self
            .agents
            .configuration(ctx, target)?
            .context("The receiving agent does not exist.")?;
        anyhow::ensure!(
            !self.schemas.valid(
                "ownerCollaborationArchivedMetadata",
                &configuration["metadata"]
            )?,
            "The agent is archived and cannot receive messages."
        );
        let mut metadata = json!({"collaboration":{"fromAgentId":sender,"toAgentId":target},"senderAgentId":sender});
        let mut options = json!({});
        if let Some(selection) = selection {
            options = selection.clone();
            options["permissionMode"] = json!("auto");
            metadata["mode"] = json!({"effort":selection["effort"],"modelId":selection["model"],"permissionMode":"auto","providerId":selection["provider"],"serviceTier":selection.get("serviceTier").cloned().unwrap_or(Value::Null)});
        }
        self.agents.enqueue(ctx,target,&json!({"id":id,"message":{"role":"agent","author":{"id":sender,"description":format!("Agent {sender}")},"content":[{"type":"text","text":format!("Message from agent {sender}:\n\n{text}")}]},"metadata":metadata,"options":options}),steering)?;
        if selection.is_some() {
            self.agents
                .update_metadata(ctx, target, &json!({"lastMode":metadata["mode"]}))?;
        }
        Ok(())
    }
    fn assert_tool_capacity(&self, ctx: &Context<'_>, sender: &str) -> Result<()> {
        let limits = self.config.collaboration_limits();
        let max_depth = limits.max_collaboration_depth;
        let maximum = limits.max_collaborators;
        let mut root = sender.to_owned();
        let mut visited = BTreeSet::new();
        let mut depth = 1;
        loop {
            anyhow::ensure!(
                visited.insert(root.clone()),
                "The collaboration ancestry contains a cycle."
            );
            let config = self
                .agents
                .configuration(ctx, &root)?
                .context("The collaboration ancestor does not exist.")?;
            if self
                .schemas
                .valid("ownerCollaborationWorkflowMetadata", &config["metadata"])?
            {
                break;
            }
            let Some(parent) = self.agents.parent(ctx, &root)? else {
                break;
            };
            anyhow::ensure!(
                depth < max_depth,
                "The maximum collaborator depth was reached."
            );
            root = parent;
            depth += 1;
        }
        anyhow::ensure!(
            depth < max_depth,
            "The maximum collaborator depth was reached."
        );
        let mut pending = vec![root.clone()];
        let mut visited = BTreeSet::new();
        let mut count = 0;
        let mut index = 0;
        while index < pending.len() {
            let current = pending[index].clone();
            index += 1;
            anyhow::ensure!(
                visited.insert(current.clone()),
                "The collaboration tree contains a cycle or duplicate identity."
            );
            if current != root {
                let config = self
                    .agents
                    .configuration(ctx, &current)?
                    .context("The collaborator no longer exists.")?;
                if self
                    .schemas
                    .valid("ownerCollaborationWorkflowMetadata", &config["metadata"])?
                {
                    continue;
                }
                count += 1;
                anyhow::ensure!(
                    count < maximum,
                    "Each root agent tree has reached its collaborator limit. Reuse an existing collaborator with send_agent_message."
                );
            }
            pending.extend(self.agents.children(ctx, &current)?);
            anyhow::ensure!(
                pending.len() <= 10000,
                "The collaboration tree traversal bound was reached."
            );
        }
        Ok(())
    }
}
#[async_trait]
impl AgentModule for CollaborationModule {
    fn name(&self) -> &'static str {
        "collaboration"
    }
    fn tools(&self, scope: &AgentScope<'_>) -> Vec<ToolDefinition> {
        self.collaboration_tools(scope)
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|_| false)
    }
    fn durable(&self, call: &Value) -> Option<bool> {
        tools::definition(call).map(|definition| definition.name != "interrupt_agent")
    }
    fn permission_policy(
        &self,
        _scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<happy_agent_base::ToolPermissionPolicy>> {
        tools::definition(call).map(|definition|Ok(happy_agent_base::ToolPermissionPolicy{should_review_in_auto_mode:definition.name=="interrupt_agent",should_run_in_full_access_in_auto_mode:false,requires_auto_or_full_access:false,action:if definition.name=="interrupt_agent"{format!("immediately aborting a collaborator and every running descendant without waiting for settlement; the agents remain available for follow-up work. Arguments: {}",call["call"]["arguments"])}else{definition.description},instructions:None}))
    }
    fn execute_transactional_tool(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        self.execute_collaboration_tool(ctx, scope, call)
    }
    fn block(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        _inference: &str,
        block: &Block,
        _base_id: Option<&str>,
    ) -> Result<()> {
        if let Block::Text { text } = block {
            let text = text.trim();
            if !text.is_empty() {
                ctx.put_value(
                    scope.id,
                    &format!("kv.{}.run.module.collaboration.lastText", scope.id),
                    &json!(text),
                )?;
            }
        }
        Ok(())
    }
    fn settled_detail(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        status: &str,
        _reason: &str,
        error: Option<&str>,
    ) -> Result<()> {
        if status == "aborted"
            || self.schemas.valid(
                "ownerCollaborationNoReport",
                &scope.configuration["metadata"],
            )?
        {
            return Ok(());
        }
        let Some(parent) = self.agents.parent(ctx, scope.id)? else {
            return Ok(());
        };
        let parent_config = self
            .agents
            .configuration(ctx, &parent)?
            .context("The collaborator's parent disappeared.")?;
        if self.schemas.valid(
            "ownerCollaborationArchivedMetadata",
            &parent_config["metadata"],
        )? {
            return Ok(());
        }
        let answer = ctx
            .value(
                scope.id,
                &format!("kv.{}.run.module.collaboration.lastText", scope.id),
            )?
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        let text = if !answer.trim().is_empty() {
            format!(
                "Collaborator {} finished working. Its answer follows, verbatim.\n\n{}",
                scope.id,
                answer.trim()
            )
        } else if let Some(error) = error {
            format!(
                "Collaborator {} stopped without answering. It failed with, verbatim.\n\n{}",
                scope.id,
                if error.trim().is_empty() {
                    "The model did not answer."
                } else {
                    error.trim()
                }
            )
        } else {
            format!("Collaborator {} stopped without answering.", scope.id)
        };
        let owed = self
            .agents
            .owed(ctx, scope.id)?
            .context("The collaborator settlement has no identity.")?;
        let settlement = owed["settlementId"]
            .as_str()
            .context("The collaborator settlement ID is missing.")?;
        self.agents.enqueue(ctx,&parent,&json!({"id":settlement,"message":{"role":"agent","author":{"id":scope.id,"description":format!("Collaborator {}",scope.id)},"content":[{"type":"text","text":text}]},"metadata":{"collaboration":{"kind":"subagent_report","fromAgentId":scope.id,"toAgentId":parent},"senderAgentId":scope.id}}),true)
    }
    async fn instructions(&self, scope: &AgentScope<'_>) -> Result<String> {
        let owner = self
            .owner
            .upgrade()
            .context("The collaboration module was closed.")?;
        let id = scope.id.to_owned();
        let (parent, children) = self
            .runtime
            .transact(move |ctx| {
                Ok((
                    owner.agents.parent(ctx, &id)?,
                    owner.agents.children(ctx, &id)?,
                ))
            })
            .await?;
        let mut lines = vec![format!("Your Agent ID is {}.", scope.id)];
        if let Some(parent) = parent {
            lines.push(format!("You were created by agent {parent}. When you stop working, whatever you said last is reported to it automatically, so finish by stating your answer. Use send_agent_message only to tell it something before then."));
        }
        if !children.is_empty() {
            lines.push(format!("Collaborators you created: {}. Each reports back on its own when it finishes; nothing waits for them.",children.join(", ")));
        }
        if self.config.collaboration_limits().cross_workspace {
            lines.push("Cross-workspace agent messaging is enabled. You can use send_agent_message to text any existing agent when you know its Agent ID. Agent IDs are unguessable, so the user or another agent must share the recipient ID with you.".to_owned());
        }
        Ok(lines.join("\n"))
    }
}
