use super::HistoryModule;
use crate::product::{
    identity::{now, resource_version},
    runtime::Context,
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use happy_agent_base::{AcceptedInput, AgentModule, AgentScope, Inference};
use happy_providers::{Block, Event, Message, Outcome};
use rusqlite::params;
use serde_json::{Value, json};

#[async_trait]
impl AgentModule for HistoryModule {
    fn name(&self) -> &'static str {
        "history"
    }
    fn model_changed(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        previous: &Value,
    ) -> Result<Option<Message>> {
        self.model_notice(ctx, scope, previous)
    }
    fn accepted(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        inputs: &[AcceptedInput],
        steering: bool,
    ) -> Result<()> {
        let agent = scope.id;
        let mut run = inputs[0].input["id"]
            .as_str()
            .context("The accepted message identifier is missing.")?
            .to_owned();
        let mut finished = None;
        let mut prior_ids = Vec::new();
        let mut new_run = true;
        if let Some(previous) = self.events.active_run(ctx, agent)? {
            if previous["hasProviderEvent"] != true {
                run = previous["runId"]
                    .as_str()
                    .context("The unstarted run identity is missing.")?
                    .to_owned();
                prior_ids = previous["acceptedMessageIds"]
                    .as_array()
                    .context("The accepted message identities are invalid.")?
                    .iter()
                    .map(|id| {
                        id.as_str()
                            .map(str::to_owned)
                            .context("The accepted message identity is invalid.")
                    })
                    .collect::<Result<Vec<_>>>()?;
                new_run = false;
            } else {
                finished = Some(
                    self.finish_run(
                        ctx,
                        agent,
                        previous["runId"]
                            .as_str()
                            .context("The previous run identity is missing.")?,
                        if steering { "aborted" } else { "completed" },
                        if steering { "steering" } else { "completed" },
                    )?,
                );
            }
        }
        let mut accepted_ids = Vec::new();
        for accepted in inputs {
            let entry = &accepted.input;
            let id = entry["id"]
                .as_str()
                .context("The accepted message identifier is missing.")?;
            let pending = self.pending(ctx, agent, id)?;
            let created = pending
                .as_ref()
                .and_then(|pending| pending["createdAt"].as_u64())
                .unwrap_or_else(now);
            if accepted_ids.is_empty() && new_run {
                self.begin_run(ctx, agent, &run, created)?;
            }
            accepted_ids.push(id.to_owned());
            let metadata = entry.get("metadata").cloned().unwrap_or(json!({}));
            let content = entry["message"]["content"]
                .as_array()
                .context("The queued input content is invalid.")?;
            let mut message = if let Some(pending) = pending {
                let mut message = pending;
                message["recordId"] = json!(id);
                message["role"] = json!("user");
                message["at"] = json!(created);
                message["runId"] = json!(run);
                for field in ["id", "agentId", "status", "createdAt"] {
                    message
                        .as_object_mut()
                        .context("The pending message is invalid.")?
                        .remove(field);
                }
                message
            } else {
                let blocks = content
                    .iter()
                    .map(|block| {
                        let mut block = block.clone();
                        if block["type"] == "image" {
                            block["mediaType"] = block["mimeType"].clone();
                            block
                                .as_object_mut()
                                .expect("validated image")
                                .remove("mimeType");
                        }
                        block
                    })
                    .collect::<Vec<_>>();
                json!({"recordId":id,"role":if metadata["messageOrigin"]=="user"{"user"}else{"agent"},"at":created,"runId":run,"blocks":blocks,"delivery":if steering{"steer"}else{"queue"},"profile":null})
            };
            if message["role"] == "user"
                && message.get("mode").is_none()
                && let Some(mode) = metadata.get("mode")
            {
                message["mode"] = mode.clone();
            }
            self.accept(ctx, agent, &message)?;
            if let Some(call) = &accepted.requested_call {
                let mut message = json!({"recordId":call["id"],"role":"assistant","at":now(),"runId":run,"blocks":[{"type":"tool_call","callId":call["id"],"name":call["name"],"arguments":call["arguments"],"requested":true}]});
                attribution(&mut message, scope.settings);
                self.append(ctx, agent, &message)?;
            }
        }
        let all_ids = prior_ids
            .into_iter()
            .chain(accepted_ids.iter().cloned())
            .collect::<Vec<_>>();
        self.events.store_active(ctx, agent, &json!({"acceptedMessageIds":all_ids,"activeIndex":null,"activeKind":null,"argumentBuffers":{},"blocks":[],"callIndexes":{},"hasProviderEvent":false,"runId":run,"stopReason":"stop","text":""}))?;
        let started = self.run(ctx, agent, &run)?;
        if steering && let Some(finished) = finished {
            self.events.record(ctx, Some(agent), "run.boundary", json!({"agentId":agent,"finishedRun":finished,"startedRun":started,"acceptedMessageIds":accepted_ids}))?;
        } else {
            if let Some(finished) = finished {
                self.events.record(
                    ctx,
                    Some(agent),
                    "run.finished",
                    json!({"agentId":agent,"run":finished}),
                )?;
            }
            self.events.record(
                ctx,
                Some(agent),
                "run.started",
                json!({"agentId":agent,"run":started,"acceptedMessageIds":accepted_ids}),
            )?;
        }
        Ok(())
    }
    fn before_tools(&self, ctx: &Context<'_>, scope: &AgentScope<'_>) -> Result<()> {
        self.flush_pending(ctx, scope)
    }
    fn before_inference(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        inference: &str,
    ) -> Result<()> {
        self.flush_pending(ctx, scope)?;
        let mut active = self
            .events
            .active_run(ctx, scope.id)?
            .context("Inference has no active public run.")?;
        active["inferenceId"] = json!(inference);
        active["blocks"] = json!([]);
        active["argumentBuffers"] = json!({});
        active["callIndexes"] = json!({});
        active["text"] = json!("");
        active["activeIndex"] = Value::Null;
        active["activeKind"] = Value::Null;
        active["hasProviderEvent"] = json!(false);
        self.events.store_active(ctx, scope.id, &active)?;
        ctx.put_value(
            scope.id,
            &format!("kv.{}.run.module.history.pending_inference_id", scope.id),
            &json!(inference),
        )
    }
    fn block(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        inference: &str,
        block: &Block,
        base_id: Option<&str>,
    ) -> Result<()> {
        let prefix = format!("kv.{}.run.module.history.", scope.id);
        let mut blocks = ctx
            .value(scope.id, &format!("{prefix}pending_blocks"))?
            .unwrap_or(json!([]));
        if let Some(block) = self.provider_block(block, base_id)? {
            blocks
                .as_array_mut()
                .context("Pending inference blocks are invalid.")?
                .push(block);
        }
        ctx.put_value(scope.id, &format!("{prefix}pending_blocks"), &blocks)?;
        ctx.put_value(
            scope.id,
            &format!("{prefix}pending_inference_id"),
            &json!(inference),
        )
    }
    fn after_inference(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        inference: &Inference<'_>,
    ) -> Result<()> {
        if let Some(mut active) = self.events.active_run(ctx, scope.id)? {
            active["hasProviderEvent"] = json!(true);
            active["stopReason"] = json!(match inference.outcome {
                Outcome::Error { .. } => "error",
                Outcome::Cancelled => "aborted",
                Outcome::Length { .. } => "length",
                _ => "stop",
            });
            if let Outcome::Error { error } = inference.outcome {
                active["errorMessage"] = json!(
                    error
                        .to_string()
                        .chars()
                        .scan(0, |units, character| {
                            *units += character.len_utf16();
                            (*units <= 8192).then_some(character)
                        })
                        .collect::<String>()
                );
            } else {
                active
                    .as_object_mut()
                    .context("The active run is invalid.")?
                    .remove("errorMessage");
            }
            self.events.store_active(ctx, scope.id, &active)?;
        }
        self.flush_pending(ctx, scope)?;
        Ok(())
    }
    fn inference_event(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        inference: &Inference<'_>,
        event: &Event,
    ) -> Result<()> {
        if let Event::Done {
            outcome: Outcome::Error { error },
        } = event
        {
            self.append(ctx, scope.id, &json!({"role":"error","at":inference.finished_at,"blocks":[{"type":"text","text":error.to_string()}],"recordId":format!("{}-error",inference.id),"runId":self.events.run_id(ctx,scope.id)?}))?;
        }
        Ok(())
    }
    fn tool_result(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
        result: &Message,
    ) -> Result<()> {
        let output = result
            .content()
            .iter()
            .filter_map(|block| {
                if let Block::Text { text } = block {
                    Some(text.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        self.complete_tool(
            ctx,
            scope.id,
            call["id"]
                .as_str()
                .context("The tool identity is missing.")?,
            call["call"]["name"].as_str().unwrap_or(""),
            &output,
            matches!(result, Message::Tool { is_error: true, .. }),
        )
    }
    fn settlement_status(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
    ) -> Result<Option<(String, String)>> {
        Ok(self.events.active_run(ctx, scope.id)?.map(|active| {
            match active["stopReason"].as_str() {
                Some("error") => ("failed".into(), "error".into()),
                Some("aborted") => ("aborted".into(), "abort".into()),
                _ => ("completed".into(), "completed".into()),
            }
        }))
    }
    fn settled(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        status: &str,
        reason: &str,
    ) -> Result<()> {
        let agent = scope.id;
        let mut configuration = scope.configuration.clone();
        let metadata = &configuration["metadata"];
        let created = configuration["provenance"]["createdAt"]
            .as_u64()
            .unwrap_or(0);
        let updated = metadata["updatedAt"].as_u64().unwrap_or(created);
        let previous = self.events.latest(ctx, agent)?.map_or_else(
            || resource_version(updated, metadata["version"].as_u64().unwrap_or(1), agent),
            |event| event.0,
        );
        let run = self.events.settle(ctx, agent)?;
        let summary = self.finish_run(ctx, agent, &run, status, reason)?;
        if !configuration["metadata"].is_object() {
            configuration["metadata"] = json!({});
        }
        configuration["metadata"]["unread"] = json!({"reason":"turn_finished","since":now()});
        configuration["metadata"]["updatedAt"] = json!(now());
        ctx.put_value(agent, "agentConfig", &configuration)?;
        self.events.record(
            ctx,
            Some(agent),
            "run.finished",
            json!({"agentId":agent,"run":summary}),
        )?;
        self.events.record_versioned(
            ctx,
            agent,
            &previous,
            json!({"status":"idle","unread":configuration["metadata"]["unread"]}),
        )?;
        Ok(())
    }
}
impl HistoryModule {
    fn flush_pending(&self, ctx: &Context<'_>, scope: &AgentScope<'_>) -> Result<()> {
        let id = scope.id;
        let prefix = format!("kv.{id}.run.module.history.");
        let blocks = ctx
            .value(id, &format!("{prefix}pending_blocks"))?
            .unwrap_or(json!([]));
        if blocks.as_array().is_none_or(Vec::is_empty) {
            return Ok(());
        }
        let inference = ctx
            .value(id, &format!("{prefix}pending_inference_id"))?
            .context("Pending history has no owning inference identity.")?;
        let inference = inference
            .as_str()
            .context("Pending history inference identity is invalid.")?;
        if self.existing(ctx, id, inference)?.is_none() {
            let mut message = json!({"role":"assistant","at":now(),"blocks":blocks,"recordId":inference,"runId":self.events.run_id(ctx,id)?});
            attribution(&mut message, scope.settings);
            self.append(ctx, id, &message)?;
        }
        for key in ["pending_blocks", "pending_inference_id"] {
            ctx.database().execute(
                "DELETE FROM happy_agent_values WHERE owner_id=?1 AND key=?2",
                params![id, format!("{prefix}{key}")],
            )?;
        }
        Ok(())
    }
}
fn attribution(message: &mut Value, settings: &Value) {
    for field in ["provider", "model"] {
        if let Some(value) = settings.get(field) {
            message[field] = value.clone();
        }
    }
}
