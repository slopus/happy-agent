//! Fixed common bot tools, with authority checked in their owning transaction.
use super::*;
use happy_providers::{Block, Message, ToolDefinition};
use std::path::PathBuf;

fn definitions() -> Vec<ToolDefinition> {
    serde_json::from_str(include_str!("tool_definitions.json"))
        .expect("The captured original bot tool array is valid.")
}
pub fn definition(call: &Value) -> Option<ToolDefinition> {
    definitions().into_iter().find(|definition| {
        call["call"]["name"] == definition.name
            && call["call"]["namespace"].as_str() == definition.namespace.as_deref()
    })
}
fn result(call: &Value, text: String, is_error: bool) -> Message {
    Message::Tool {
        call_id: call["id"].as_str().unwrap_or_default().to_owned(),
        content: vec![Block::text(text)],
        is_error,
        vendor: None,
    }
}
impl BotsModule {
    fn arguments(&self, call: &Value) -> Result<Value> {
        let definition = definition(call).context("The bot tool is unavailable.")?;
        let value: Value = serde_json::from_str(
            call["call"]["arguments"]
                .as_str()
                .context("The bot tool arguments are missing.")?,
        )?;
        anyhow::ensure!(
            self.schemas
                .valid(&format!("ownerTool_{}", definition.name), &value)?,
            "The bot tool arguments are invalid."
        );
        Ok(value)
    }
    pub(super) async fn available_bot_tools(
        &self,
        scope: &AgentScope<'_>,
    ) -> Result<Vec<ToolDefinition>> {
        let owner = self
            .owner
            .upgrade()
            .context("The bots module was closed.")?;
        let agent = scope.id.to_owned();
        let (bot, parent) = self
            .runtime
            .transact(move |ctx| {
                Ok((
                    owner.for_agent(ctx, &agent)?.is_some(),
                    owner.agents.parent(ctx, &agent)?.is_some(),
                ))
            })
            .await?;
        if !bot && parent {
            return Ok(Vec::new());
        }
        Ok(definitions()
            .into_iter()
            .filter(|definition| bot || definition.name != "set_bot_avatar")
            .collect())
    }
    pub(super) fn execute_bot_transaction(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        let definition = definition(call)?;
        if definition.name == "set_bot_avatar" {
            return None;
        }
        Some((|| {
            let args = self.arguments(call)?;
            let output = match definition.name.as_str() {
                "list_bots" => {
                    let bots = self
                        .list(ctx)?
                        .into_iter()
                        .filter(|bot| {
                            args["hasAvatar"]
                                .as_bool()
                                .is_none_or(|wanted| bot.get("avatar").is_some() == wanted)
                        })
                        .collect::<Vec<_>>();
                    if bots.is_empty() {
                        "No bots found.".to_owned()
                    } else {
                        bots.iter()
                            .map(|bot| {
                                format!(
                                    "- {}{} — id {}, username {}, {}, folder {}",
                                    bot["name"].as_str().unwrap(),
                                    if bot["status"] == "archived" {
                                        " (archived)"
                                    } else {
                                        ""
                                    },
                                    bot["id"].as_str().unwrap(),
                                    bot["username"].as_str().unwrap(),
                                    if bot.get("avatar").is_some() {
                                        "has avatar"
                                    } else {
                                        "no avatar"
                                    },
                                    bot["path"].as_str().unwrap()
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    }
                }
                "create_bot" => {
                    if self
                        .for_agent(ctx, scope.id)?
                        .is_some_and(|bot| bot["isAdmin"] != true)
                    {
                        let admins = self
                            .list(ctx)?
                            .into_iter()
                            .filter(|bot| bot["isAdmin"] == true)
                            .collect::<Vec<_>>();
                        let explanation = if admins.is_empty() {
                            "Only an admin bot can create other bots. There are no admin bots on this installation.".to_owned()
                        } else {
                            format!(
                                "Only an admin bot can create other bots. Admin bots on this installation:\n{}",
                                admins
                                    .iter()
                                    .map(|bot| format!(
                                        "- {}{} — id {}",
                                        bot["name"].as_str().unwrap(),
                                        if bot["status"] == "archived" {
                                            " (archived)"
                                        } else {
                                            ""
                                        },
                                        bot["id"].as_str().unwrap()
                                    ))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            )
                        };
                        anyhow::bail!("{explanation}");
                    }
                    let key = format!(
                        "kv.{}.call.{}.botId",
                        scope.id,
                        call["id"]
                            .as_str()
                            .context("The bot creation call has no identity.")?
                    );
                    let id = ctx
                        .value(scope.id, &key)?
                        .unwrap_or_else(|| json!(cuid2::create_id()));
                    anyhow::ensure!(
                        self.schemas.valid("cuid2", &id)?,
                        "The stored bot creation identity is invalid."
                    );
                    ctx.put_value(scope.id, &key, &id)?;
                    let mut input = args;
                    input["id"] = id;
                    let bot = self.create(ctx, &input)?;
                    format!(
                        "Bot created: {} — id {}, username {}, folder {}. Send it a message with send_bot_message.",
                        bot["name"].as_str().unwrap(),
                        bot["id"].as_str().unwrap(),
                        bot["username"].as_str().unwrap(),
                        bot["path"].as_str().unwrap()
                    )
                }
                "send_bot_message" => {
                    self.send_message(
                        ctx,
                        scope.id,
                        args["botId"].as_str().unwrap(),
                        args["text"].as_str().unwrap(),
                        call["id"]
                            .as_str()
                            .context("The bot message call has no identity.")?,
                    )?;
                    "Message delivered to the bot. Any answer arrives as a message; carry on with other work in the meantime.".to_owned()
                }
                _ => anyhow::bail!("The bot tool is unavailable."),
            };
            Ok(result(call, output, false))
        })())
    }
    pub(super) async fn execute_bot_avatar(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
        cancel: CancellationToken,
    ) -> Option<Message> {
        if definition(call)?.name != "set_bot_avatar" {
            return None;
        }
        let outcome = async {
            let args = self.arguments(call)?;
            let owner = self
                .owner
                .upgrade()
                .context("The bots module was closed.")?;
            let agent = scope.id.to_owned();
            let target = args["botId"].as_str().map(str::to_owned);
            let reader = owner.clone();
            let actor = agent.clone();
            let selected = target.clone();
            let bot = self
                .runtime
                .transact(move |ctx| {
                    let bot = reader
                        .for_agent(ctx, &actor)?
                        .context("Only a bot can set its own avatar.")?;
                    anyhow::ensure!(
                        bot["status"] == "active",
                        "An archived bot cannot change avatars."
                    );
                    anyhow::ensure!(
                        selected.as_deref().is_none_or(|target| bot["id"] == target)
                            || bot["isAdmin"] == true,
                        "Only an admin bot can set another bot's avatar."
                    );
                    Ok(bot)
                })
                .await?;
            let runner = bot["runnerId"].as_str();
            let root = self
                .runners
                .canonical_path(runner, Path::new(bot["path"].as_str().unwrap()), &cancel)
                .await?;
            let requested = PathBuf::from(args["path"].as_str().unwrap());
            let candidate = if requested.is_absolute() {
                requested
            } else {
                root.join(requested)
            };
            let path = self
                .runners
                .canonical_path(runner, &candidate, &cancel)
                .await?;
            anyhow::ensure!(
                path == root || path.starts_with(&root),
                "The avatar image must live inside your own folder."
            );
            let bytes = self
                .runners
                .read_no_follow(runner, &path, 8 * 1024 * 1024, &cancel)
                .await?;
            let asset = self.projects.normalize_avatar(bytes, None).await?;
            let writer = owner.clone();
            self.runtime
                .transact(move |ctx| {
                    writer.set_avatar_for_agent(ctx, &agent, target.as_deref(), &asset)
                })
                .await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        Some(match outcome {
            Ok(()) => result(call, "The bot's avatar is set.".to_owned(), false),
            Err(error) => result(call, format!("{error:#}"), true),
        })
    }
}
