//! Focused reads compose the current feature catalogs with one durable agent snapshot.
use super::*;
use happy_agent_base::AgentScope;
use tokio_util::sync::CancellationToken;

impl AgentSystemModule {
    pub async fn focused(self: &Arc<Self>, id: String) -> Result<Option<Value>> {
        let agents = self.clone();
        let agent_id = id.clone();
        let snapshot = self
            .runtime
            .transact(move |ctx| {
                let Some(agent) = agents.resource(ctx, &agent_id)? else {
                    return Ok(None);
                };
                let configuration = agents
                    .configuration(ctx, &agent_id)?
                    .context("The agent configuration disappeared.")?;
                Ok(Some((agent, configuration)))
            })
            .await?;
        let Some((agent, configuration)) = snapshot else {
            return Ok(None);
        };
        let source: Value = serde_json::from_str(include_str!("source_goldens.json"))?;
        let profiles = source["profiles"].clone();
        let mut commands = source["compactionCommands"]
            .as_array()
            .context("The original compaction catalog is missing.")?
            .clone();
        let settings = json!({});
        let scope = AgentScope {
            id: &id,
            configuration: &configuration,
            settings: &settings,
        };
        commands.extend(
            self.skills
                .slash_commands(&scope, &CancellationToken::new())
                .await?,
        );
        let mut names = std::collections::BTreeSet::new();
        for command in &commands {
            let name = command["name"]
                .as_str()
                .context("The slash command name is missing.")?;
            anyhow::ensure!(
                names.insert(name),
                "More than one module returned the /{name} command."
            );
        }
        let commands = json!(commands);
        anyhow::ensure!(
            self.schemas.valid("ownerPublicAgentProfiles", &profiles)?,
            "The agent profile catalog is invalid."
        );
        anyhow::ensure!(
            self.schemas
                .valid("ownerPublicAgentSlashCommands", &commands)?,
            "The agent slash command catalog is invalid."
        );
        anyhow::ensure!(
            serde_json::to_vec(&commands)?.len() <= 256 * 1024,
            "The slash command catalog exceeds its encoded size limit."
        );
        Ok(Some(
            json!({"agent":agent,"profiles":profiles,"slashCommands":commands}),
        ))
    }
}
