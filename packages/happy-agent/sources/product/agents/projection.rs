//! Agent views use feature-owned facts and the caller's atomic database snapshot.
use super::*;

impl AgentSystemModule {
    fn metadata_number(&self, value: &Value) -> Result<Option<u64>> {
        if !self.schemas.valid("ownerAgentNumericMetadata", value)? {
            return Ok(None);
        }
        Ok(value
            .as_u64()
            .or_else(|| value.as_f64().map(|value| value as u64)))
    }

    fn running(&self, ctx: &Context<'_>, id: &str) -> Result<bool> {
        Ok(self.events.run_id(ctx, id)?.is_some() || self.history.running_run(ctx, id)?.is_some())
    }

    fn association(&self, ctx: &Context<'_>, id: &str) -> Result<Option<(String, String)>> {
        if self.config.values["features"]["workspaces"]
            .as_bool()
            .unwrap_or(true)
        {
            if let Some(association) = self.workspaces.agent_association(ctx, id)? {
                return Ok(Some(association));
            }
        }
        self.projects.agent_association(ctx, id)
    }

    fn workspace(&self, ctx: &Context<'_>, id: &str) -> Result<Option<String>> {
        let mut current = id.to_owned();
        for _ in 0..64 {
            if let Some(bot) = self.bots.for_agent(ctx, &current)? {
                return Ok(bot["workspaceId"].as_str().map(str::to_owned));
            }
            if let Some(association) = self.association(ctx, &current)? {
                return Ok(Some(association.0));
            }
            let Some(parent) = self.system.parent(ctx, &current)? else {
                return Ok(None);
            };
            current = parent;
        }
        anyhow::bail!("The agent ancestry exceeds the supported depth.")
    }

    pub(super) fn project_resource(
        &self,
        ctx: &Context<'_>,
        id: &str,
        depth: usize,
    ) -> Result<Option<Value>> {
        let latest = self.events.latest(ctx, id)?;
        let Some(configuration) = self.configuration(ctx, id)? else {
            return Ok(None);
        };
        self.resource_snapshot(ctx, id, &configuration, latest, depth)
    }

    fn resource_snapshot(
        &self,
        ctx: &Context<'_>,
        id: &str,
        configuration: &Value,
        latest: Option<(String, i64)>,
        depth: usize,
    ) -> Result<Option<Value>> {
        let Some(workspace) = self.workspace(ctx, id)? else {
            return Ok(None);
        };
        let bot = self.bots.for_agent(ctx, id)?.is_some();
        let order = if bot {
            None
        } else {
            self.association(ctx, id)?.map(|association| association.1)
        };
        let parent = self.system.parent(ctx, id)?;
        let children = self.system.children(ctx, id)?;
        let subtask = self.subtasks.is_subtask(configuration)?;
        let mut running = 0usize;
        let mut visible = Vec::new();
        let mut child_versions = std::collections::BTreeMap::new();
        for child in &children {
            if self.running(ctx, child)? {
                running += 1;
            }
            if depth < 2 {
                let child_latest = self.events.latest(ctx, child)?;
                if let Some(child_config) = self.configuration(ctx, child)?
                    && self.subtasks.is_subtask(&child_config)?
                    && self
                        .metadata_number(&child_config["metadata"]["archivedAt"])?
                        .is_none()
                {
                    child_versions.insert(child.clone(), child_latest);
                    visible.push((child.clone(), child_config));
                }
            }
        }
        let mut subtasks = Vec::new();
        for (child, child_config) in self.subtasks.sort_siblings(visible)? {
            let latest = child_versions.remove(&child).unwrap();
            subtasks.push(
                self.resource_snapshot(ctx, &child, &child_config, latest, depth + 1)?
                    .context("The subtask workspace was not found.")?,
            );
        }
        let metadata = &configuration["metadata"];
        let created = self
            .metadata_number(&configuration["provenance"]["createdAt"])?
            .unwrap_or(0);
        let updated = self
            .metadata_number(&metadata["updatedAt"])?
            .unwrap_or(created)
            .max(latest.as_ref().map_or(0, |event| event.1 as u64));
        let revision = self.metadata_number(&metadata["version"])?.unwrap_or(1);
        let version = latest.as_ref().map_or_else(
            || resource_version(updated, revision, id),
            |event| event.0.clone(),
        );
        let archived = self
            .metadata_number(&metadata["archivedAt"])?
            .map_or(Value::Null, |at| json!(at));
        let pending = self.user_input.list_page(
            ctx,
            id,
            &json!({"askingAgentId":id,"status":"pending","limit":1}),
        )?["requests"][0]
            .get("id")
            .cloned()
            .unwrap_or(Value::Null);
        let value = json!({
            "id":id, "workspaceId":workspace, "parentAgentId":parent,
            "subtask":subtask, "subtasks":subtasks, "subtaskOrderKey":self.subtasks.sibling_order_key(configuration)?,
            "userVisible":subtask || bot || order.is_some(), "managedByAnotherAgent":parent.is_some(),
            "canSendMessages":(parent.is_none() || subtask) && archived.is_null(),
            "title":metadata["title"].as_str(), "titleStatus":if metadata["title"].is_string(){"ready"}else{"idle"},
            "status":if self.running(ctx,id)?{"working"}else{"idle"},
            "subagents":{"total":children.len(),"running":running},
            "processes":{"running":self.tools.running_processes(id)}, "pendingQuestionId":pending,
            "unread":metadata.get("unread").cloned().unwrap_or(Value::Null), "orderKey":order,
            "lastCursor":self.events.agent_cursor(id), "version":version,
            "createdAt":created, "updatedAt":updated, "archivedAt":archived,
        });
        anyhow::ensure!(
            self.schemas.valid("ownerPublicAgent", &value)?,
            "The public agent resource is invalid."
        );
        Ok(Some(value))
    }
}
