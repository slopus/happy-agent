//! Live extra skill folders use the configuration owner's atomic runtime file.
use super::{
    agent_runtime::AgentRuntimeModule,
    bots::BotsModule,
    config::ConfigModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope, ToolPermissionPolicy};
use happy_providers::{Block, Message, ToolDefinition};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
pub struct SkillFoldersModule {
    config: Arc<ConfigModule>,
    bots: Arc<BotsModule>,
    runtime: Arc<RuntimeModule>,
    schemas: Schemas,
}
fn definitions() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("skill_folders/tool_definitions.json"))
        .expect("The original skill folder tool array is valid.")
}
fn definition(call: &Value) -> Option<ToolDefinition> {
    definitions().into_iter().find(|tool| {
        call["call"]["name"] == tool.name
            && call["call"]["namespace"].as_str() == tool.namespace.as_deref()
    })
}
fn lifetime(call: &Value, field: &str) -> Option<bool> {
    let tool = definition(call)?;
    let lifetimes: Value = serde_json::from_str(include_str!("skill_folders/tool_lifetimes.json"))
        .expect("The original skill folder lifetimes are valid.");
    lifetimes
        .as_array()?
        .iter()
        .find(|value| value["name"] == tool.name)?[field]
        .as_bool()
}
fn format_folders(folders: &Value) -> String {
    let folders = folders.as_array().unwrap();
    if folders.is_empty() {
        return "No extra skill folders are configured. Skills are found only in the standard .agents/skills folders.".to_owned();
    }
    format!(
        "Extra skill folders:\n{}",
        folders
            .iter()
            .map(|folder| format!(
                "- {} ({})",
                folder["path"].as_str().unwrap(),
                if folder["source"] == "user" {
                    "from happy.toml, only the user can remove it"
                } else {
                    "added live"
                }
            ))
            .collect::<Vec<_>>()
            .join("\n")
    )
}
impl SkillFoldersModule {
    pub fn new(
        config: Arc<ConfigModule>,
        bots: Arc<BotsModule>,
        runtime: Arc<RuntimeModule>,
        agents: Arc<AgentRuntimeModule>,
    ) -> Result<Arc<Self>> {
        let module = Arc::new(Self {
            config,
            bots,
            runtime,
            schemas: Schemas::new()?,
        });
        agents.install(module.clone())?;
        Ok(module)
    }
    fn admin(&self, ctx: &Context<'_>, agent: &str) -> Result<bool> {
        self.runtime.assert_context(ctx)?;
        Ok(self
            .bots
            .for_agent(ctx, agent)?
            .is_some_and(|bot| bot["isAdmin"] == true && bot["status"] == "active"))
    }
    fn require_admin(&self, ctx: &Context<'_>, agent: &str) -> Result<()> {
        anyhow::ensure!(
            self.admin(ctx, agent)?,
            "Only an active admin bot can manage this installation's skill folders."
        );
        Ok(())
    }
    fn folders(&self) -> Result<Value> {
        let user = self.config.user_skill_directories();
        let mut folders = user
            .iter()
            .map(|path| json!({"path":path,"source":"user"}))
            .collect::<Vec<_>>();
        folders.extend(
            self.config
                .runtime_skill_directories()
                .into_iter()
                .filter(|path| !user.contains(path))
                .map(|path| json!({"path":path,"source":"runtime"})),
        );
        let result = json!({"folders":folders});
        anyhow::ensure!(
            self.schemas.valid("ownerSkillFolderList", &result)?,
            "The extra skill folder list is invalid."
        );
        Ok(result)
    }
    pub fn list(&self, ctx: &Context<'_>, agent: &str) -> Result<Value> {
        self.require_admin(ctx, agent)?;
        self.folders()
    }
    fn path(&self, path: &str) -> Result<String> {
        anyhow::ensure!(
            self.schemas.valid("ownerSkillFolderPath", &json!(path))?,
            "A skill folder must be an absolute path."
        );
        Ok(self
            .config
            .resolve_skill_directory(path)
            .to_string_lossy()
            .into_owned())
    }
    async fn authorize(&self, agent: &str) -> Result<()> {
        let bots = self.bots.clone();
        let agent = agent.to_owned();
        self.runtime
            .transact(move |ctx| {
                anyhow::ensure!(
                    bots.for_agent(ctx, &agent)?
                        .is_some_and(|bot| bot["isAdmin"] == true && bot["status"] == "active"),
                    "Only an active admin bot can manage this installation's skill folders."
                );
                Ok(())
            })
            .await
    }
    pub async fn add(&self, agent: &str, path: &str) -> Result<Value> {
        self.authorize(agent).await?;
        let path = self.path(path)?;
        let changed = if self
            .config
            .user_skill_directories()
            .contains(&std::path::PathBuf::from(&path))
        {
            false
        } else {
            let target = path.clone();
            let info = tokio::task::spawn_blocking(move || std::fs::metadata(target))
                .await?
                .with_context(|| format!("The folder {path} does not exist."))?;
            anyhow::ensure!(info.is_dir(), "{path} is not a folder.");
            self.config.add_runtime_skill_directory(&path).await?
        };
        let result = json!({"path":path,"changed":changed,"folders":self.folders()?["folders"]});
        anyhow::ensure!(
            self.schemas.valid("ownerSkillFolderChange", &result)?,
            "The extra skill folder change is invalid."
        );
        Ok(result)
    }
    pub async fn remove(&self, agent: &str, path: &str) -> Result<Value> {
        self.authorize(agent).await?;
        let path = self.path(path)?;
        let changed = self.config.remove_runtime_skill_directory(&path).await?;
        anyhow::ensure!(
            changed
                || !self
                    .config
                    .user_skill_directories()
                    .contains(&std::path::PathBuf::from(&path)),
            "The folder {path} is listed in {}. Only the user can remove it by editing that file.",
            self.config.paths.configuration.join("happy.toml").display()
        );
        let result = json!({"path":path,"changed":changed,"folders":self.folders()?["folders"]});
        anyhow::ensure!(
            self.schemas.valid("ownerSkillFolderChange", &result)?,
            "The extra skill folder change is invalid."
        );
        Ok(result)
    }
    fn arguments(&self, call: &Value, name: &str) -> Result<Value> {
        let input = serde_json::from_str(
            call["call"]["arguments"]
                .as_str()
                .context("The skill folder tool arguments are missing.")?,
        )?;
        anyhow::ensure!(
            self.schemas.valid(&format!("ownerTool_{name}"), &input)?,
            "The skill folder tool arguments are invalid."
        );
        Ok(input)
    }
}
#[async_trait]
impl AgentModule for SkillFoldersModule {
    fn name(&self) -> &'static str {
        "skill-folders"
    }
    async fn available_tools(&self, scope: &AgentScope<'_>) -> Result<Vec<ToolDefinition>> {
        let bots = self.bots.clone();
        let agent = scope.id.to_owned();
        let active = self
            .runtime
            .transact(move |ctx| {
                Ok(bots
                    .for_agent(ctx, &agent)?
                    .is_some_and(|bot| bot["isAdmin"] == true && bot["status"] == "active"))
            })
            .await?;
        Ok(if active { definitions() } else { Vec::new() })
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
        Some((|| {
            let input = self.arguments(call, &tool.name)?;
            let write = tool.name != "list_skill_folders";
            let action = match tool.name.as_str() {
                "add_skill_folder" => format!(
                    "adding {} as a skill folder for every agent on this Happy Agent installation. Access: installation-wide configuration write",
                    input["path"]
                ),
                "remove_skill_folder" => format!(
                    "removing {} from the skill folders of every agent on this Happy Agent installation. Access: installation-wide configuration write",
                    input["path"]
                ),
                _ => tool.description,
            };
            Ok(ToolPermissionPolicy {
                should_review_in_auto_mode: write,
                should_run_in_full_access_in_auto_mode: false,
                requires_auto_or_full_access: write,
                action,
                instructions: None,
            })
        })())
    }
    async fn execute_tool(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        let tool = definition(call)?;
        let result = async {
            anyhow::ensure!(
                !cancel.is_cancelled(),
                "The skill folder operation was interrupted."
            );
            let input = self.arguments(call, &tool.name)?;
            let text = match tool.name.as_str() {
                "list_skill_folders" => {
                    self.authorize(scope.id).await?;
                    format_folders(&self.folders()?["folders"])
                }
                "add_skill_folder" | "remove_skill_folder" => {
                    let add = tool.name == "add_skill_folder";
                    let result = if add {
                        self.add(scope.id, input["path"].as_str().unwrap()).await?
                    } else {
                        self.remove(scope.id, input["path"].as_str().unwrap())
                            .await?
                    };
                    let path = result["path"].as_str().unwrap();
                    let introduction = match (add, result["changed"] == true) {
                        (true, true) => format!("Added {path} as a skill folder."),
                        (true, false) => format!("{path} was already a skill folder."),
                        (false, true) => format!("Removed {path} from the skill folders."),
                        (false, false) => format!("{path} was not a skill folder."),
                    };
                    format!("{introduction}\n\n{}", format_folders(&result["folders"]))
                }
                _ => anyhow::bail!("The skill folder tool is unavailable."),
            };
            Ok::<String, anyhow::Error>(text)
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
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folder_display_matches_original_source() {
        let cases: Value =
            serde_json::from_str(include_str!("skill_folders/format_goldens.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(format_folders(&case["folders"]), case["text"]);
        }
    }
}
