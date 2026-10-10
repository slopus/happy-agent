use super::{Implementation as I, NativeTool, PreparedFile, ToolOutcome, ToolsModule, VendorTools};
use crate::product::config::ToolVendor as V;
use anyhow::{Context, Result, ensure};
use happy_providers::{Block, Message, ToolDefinition};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use tokio_util::sync::CancellationToken;
pub(super) mod shell;

pub(super) fn common(
    definitions: &BTreeMap<String, Vec<ToolDefinition>>,
) -> Result<Vec<NativeTool>> {
    let metadata: BTreeMap<String, Vec<Value>> =
        serde_json::from_str(include_str!("tool_guidance.json"))?;
    let schemas = crate::product::schemas::Schemas::new()?;
    let definitions = definitions
        .get("common")
        .context("The captured common tool definitions are missing.")?;
    let implementations = [I::ReadHistory];
    ensure!(
        definitions.len() == implementations.len(),
        "The captured common tools are incomplete."
    );
    definitions
        .iter()
        .zip(implementations)
        .map(|(definition, implementation)| {
            let flags = metadata
                .get("common")
                .and_then(|tools| tools.iter().find(|tool| tool["name"] == definition.name))
                .context("The captured common tool execution metadata is missing.")?;
            ensure!(
                schemas.valid("computeToolMetadata", flags)?,
                "The captured common tool execution metadata is invalid."
            );
            Ok(NativeTool {
                definition: definition.clone(),
                implementation,
                vendor: None,
                durable: flags["durable"].as_bool().unwrap(),
                reloadable: flags["reloadable"].as_bool().unwrap(),
                steerable: flags["steerable"].as_bool().unwrap(),
            })
        })
        .collect()
}

/// Both entry points are fixed arrays, in Source's own order. No feature
/// detection, provider-name dispatch in the loop, or name-based filtering.
pub(super) fn assemble(
    definitions: &BTreeMap<String, Vec<ToolDefinition>>,
) -> Result<Vec<VendorTools>> {
    let reviewers: BTreeMap<String, Vec<ToolDefinition>> =
        serde_json::from_str(include_str!("reviewer_definitions.json"))?;
    let metadata: BTreeMap<String, Vec<Value>> =
        serde_json::from_str(include_str!("tool_guidance.json"))?;
    let schemas = crate::product::schemas::Schemas::new()?;
    let arrays: [(V, &[I], &[I]); 5] = [
        (
            V::Codex,
            &[
                I::ExecCommand,
                I::WriteStdin,
                I::KillSession,
                I::ApplyPatch,
                I::ViewImage,
            ],
            &[I::ExecCommand, I::WriteStdin],
        ),
        (
            V::Claude,
            &[
                I::ClaudeOutput,
                I::ClaudeBash,
                I::ReadFile,
                I::EditFile,
                I::WriteFile,
                I::Glob,
                I::Grep,
                I::ClaudeStop,
                I::ClaudeInput,
            ],
            &[I::ClaudeBash, I::ReadFile, I::Glob, I::Grep, I::ClaudeInput],
        ),
        (
            V::Grok,
            &[
                I::GrokCommand,
                I::ReadFile,
                I::WriteFile,
                I::EditFile,
                I::ListDirectory,
                I::Grep,
                I::GrokOutput,
                I::GrokStop,
                I::GrokInput,
            ],
            &[
                I::GrokCommand,
                I::ReadFile,
                I::ListDirectory,
                I::Grep,
                I::GrokInput,
            ],
        ),
        (
            V::Kimi,
            &[
                I::KimiBash,
                I::ReadFile,
                I::WriteFile,
                I::EditFile,
                I::Glob,
                I::Grep,
                I::KimiMedia,
                I::KimiOutput,
                I::KimiInput,
                I::KimiStop,
            ],
            &[
                I::KimiBash,
                I::ReadFile,
                I::Glob,
                I::Grep,
                I::KimiMedia,
                I::KimiOutput,
                I::KimiInput,
            ],
        ),
        (
            V::Glm,
            &[
                I::ClaudeOutput,
                I::ClaudeBash,
                I::ReadFile,
                I::EditFile,
                I::WriteFile,
                I::Glob,
                I::Grep,
                I::ClaudeStop,
                I::ClaudeInput,
            ],
            &[I::ClaudeBash, I::ReadFile, I::Glob, I::Grep, I::ClaudeInput],
        ),
    ];
    arrays
        .into_iter()
        .map(|(vendor, ordinary, reviewer)| {
            let build = |definitions: &BTreeMap<String, Vec<ToolDefinition>>,
                         implementations: &[I]|
             -> Result<Vec<NativeTool>> {
                let tools = definitions
                    .get(vendor.as_str())
                    .context("The captured compute vendor definitions are missing.")?;
                ensure!(
                    tools.len() == implementations.len(),
                    "The captured compute vendor definitions are incomplete."
                );
                Ok(tools
                    .iter()
                    .zip(implementations)
                    .map(|(definition, implementation)| -> Result<NativeTool> {
                        let flags = metadata
                            .get(vendor.as_str())
                            .and_then(|tools| {
                                tools.iter().find(|tool| tool["name"] == definition.name)
                            })
                            .context("The captured tool execution metadata is missing.")?;
                        ensure!(
                            schemas.valid("computeToolMetadata", flags)?,
                            "The captured tool execution metadata is invalid."
                        );
                        Ok(NativeTool {
                            definition: definition.clone(),
                            implementation: *implementation,
                            vendor: Some(vendor),
                            durable: flags["durable"].as_bool().unwrap(),
                            reloadable: flags["reloadable"].as_bool().unwrap(),
                            steerable: flags["steerable"].as_bool().unwrap(),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?)
            };
            Ok(VendorTools {
                vendor,
                ordinary: build(definitions, ordinary)?,
                reviewer: build(&reviewers, reviewer)?,
            })
        })
        .collect()
}

impl ToolsModule {
    pub(super) fn reviewer_tools(&self, settings: &Value) -> Result<Vec<ToolDefinition>> {
        let vendor = self.config.compute_tool_vendor(settings)?;
        Ok(self
            .vendor
            .iter()
            .find(|set| set.vendor == vendor)
            .context("The reviewer compute surface is missing.")?
            .reviewer
            .iter()
            .map(|tool| tool.definition.clone())
            .collect())
    }
    pub(super) fn reviewer_definition(
        &self,
        settings: &Value,
        call: &Value,
    ) -> Result<Option<&NativeTool>> {
        let vendor = self.config.compute_tool_vendor(settings)?;
        Ok(self
            .vendor
            .iter()
            .find(|set| set.vendor == vendor)
            .context("The reviewer compute surface is missing.")?
            .reviewer
            .iter()
            .find(|tool| {
                call["call"]["name"] == tool.definition.name
                    && call["call"]["namespace"].as_str() == tool.definition.namespace.as_deref()
            }))
    }
    fn surface_arguments(&self, call: &Value, tool: &NativeTool) -> Result<Value> {
        let vendor = tool
            .vendor
            .context("The compute definition has no vendor.")?;
        self.arguments(
            call,
            &format!("computeTool_{}_{}", vendor.as_str(), tool.definition.name),
            "The tool arguments are invalid.",
        )
    }
    fn surface_result(&self, tool: &NativeTool, value: &Value) -> Result<()> {
        ensure!(
            self.schemas.valid(
                &format!(
                    "computeResult_{}_{}",
                    tool.vendor.unwrap().as_str(),
                    tool.definition.name
                ),
                value
            )?,
            "The native tool result does not match its captured Source contract."
        );
        Ok(())
    }
    pub(super) fn guidance(&self, tool: &NativeTool) -> Option<String> {
        static GUIDANCE: std::sync::OnceLock<BTreeMap<String, Vec<Value>>> =
            std::sync::OnceLock::new();
        GUIDANCE
            .get_or_init(|| {
                serde_json::from_str(include_str!("tool_guidance.json"))
                    .expect("captured tool guidance")
            })
            .get(tool.vendor?.as_str())?
            .iter()
            .find(|entry| entry["name"] == tool.definition.name)?["autoPermissionInstructions"]
            .as_str()
            .map(str::to_owned)
    }
    pub(super) fn surface_policy(
        &self,
        scope: &happy_agent_base::AgentScope<'_>,
        call: &Value,
        tool: &NativeTool,
    ) -> Result<happy_agent_base::ToolPermissionPolicy> {
        let args = self.surface_arguments(call, tool)?;
        let explicit = args["sandbox_permissions"] == "require_escalated"
            || args["dangerouslyDisableSandbox"] == true;
        let (review, full, action) = match tool.implementation {
            I::ClaudeBash | I::GrokCommand | I::KimiBash => {
                let selected = args["secrets"]
                    .as_array()
                    .is_some_and(|secrets| !secrets.is_empty());
                let environment = self.config.compute_file_environment(scope.configuration)?;
                let cwd = args["cwd"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| environment.root.to_string_lossy().into_owned());
                let mut action = format!(
                    "running {} in {} {}. Secret environment bundles: {}",
                    args["command"],
                    json!(cwd),
                    if explicit {
                        "outside the workspace sandbox, with unrestricted filesystem and network access"
                    } else {
                        "inside the current workspace sandbox"
                    },
                    args.get("secrets").cloned().unwrap_or(json!([]))
                );
                if let Some(reason) = args["justification"]
                    .as_str()
                    .or_else(|| args["description"].as_str())
                {
                    action.push_str(&format!(". Stated purpose: {reason}"));
                }
                (explicit || selected, explicit, action)
            }
            I::ClaudeInput | I::GrokInput | I::KimiInput => {
                let input = args["input"].as_str().unwrap();
                let id = args["bash_id"]
                    .as_str()
                    .or_else(|| args["task_id"].as_str())
                    .unwrap();
                let mut action = format!(
                    "sending {} to background shell {}. Access: the shell's existing execution boundary",
                    json!(input),
                    json!(id)
                );
                if self
                    .parse_vendor_session(tool.vendor.unwrap(), id)
                    .ok()
                    .is_some_and(|id| self.commands.uses_secrets(scope.id, id))
                {
                    action.push_str(
                        ". Selected secret environment variables are present in the process",
                    );
                }
                (!input.is_empty(), false, action)
            }
            I::ClaudeOutput | I::GrokOutput | I::KimiOutput => (
                false,
                false,
                "reading new output from an owned background shell".into(),
            ),
            I::ClaudeStop | I::GrokStop | I::KimiStop => (
                false,
                false,
                "stopping an owned background shell and its process tree".into(),
            ),
            I::ApplyPatch => {
                let patch = args["patch"].as_str().unwrap();
                let paths = self.files.patch_paths(scope.configuration, &args)?;
                let needs = explicit
                    || paths.is_empty()
                    || self.files.review(
                        scope.configuration,
                        args["workdir"].as_str().unwrap_or("."),
                        false,
                    )
                    || paths
                        .iter()
                        .any(|path| self.files.review(scope.configuration, path, true));
                let mut action = format!(
                    "applying a patch. Affected paths: {}. Access: {}",
                    if paths.is_empty() {
                        "not available from the patch".into()
                    } else {
                        paths
                            .iter()
                            .map(|path| json!(path).to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    },
                    if needs {
                        "reviewed filesystem access including protected and outside-workspace paths"
                    } else {
                        "the current workspace filesystem boundary"
                    }
                );
                if let Some(reason) = args["justification"].as_str() {
                    action.push_str(&format!(". Reason given: {reason}"));
                }
                let _ = patch;
                (needs, needs, action)
            }
            implementation => {
                let write = matches!(implementation, I::WriteFile | I::EditFile);
                let vendor = tool.vendor.unwrap();
                let path = if vendor == V::Kimi
                    || matches!(implementation, I::ViewImage | I::Glob | I::Grep)
                {
                    args["path"].as_str().unwrap_or(".")
                } else if matches!(implementation, I::ListDirectory) {
                    args["target_directory"].as_str().unwrap()
                } else if vendor == V::Grok && matches!(implementation, I::ReadFile) {
                    args["target_file"].as_str().unwrap()
                } else {
                    args["file_path"].as_str().unwrap()
                };
                let needs = explicit || self.files.review(scope.configuration, path, write);
                let verb = match implementation {
                    I::WriteFile => "writing",
                    I::EditFile => "editing",
                    I::Glob | I::Grep => "searching",
                    I::ListDirectory => "listing",
                    I::ViewImage | I::KimiMedia => "viewing",
                    _ => "reading",
                };
                (
                    needs,
                    needs,
                    self.files
                        .describe(scope.configuration, path, verb, write, explicit),
                )
            }
        };
        Ok(happy_agent_base::ToolPermissionPolicy {
            should_review_in_auto_mode: review,
            should_run_in_full_access_in_auto_mode: full,
            requires_auto_or_full_access: false,
            action,
            instructions: self.guidance(tool),
        })
    }
    pub(super) async fn execute_surface(
        &self,
        agent: &str,
        configuration: &Value,
        settings: &Value,
        call: &Value,
        tool: &NativeTool,
        cancel: CancellationToken,
    ) -> ToolOutcome {
        let result = self
            .execute_surface_inner(agent, configuration, settings, call, tool, &cancel)
            .await;
        let (blocks, is_error) = match result {
            Ok(result) => result,
            Err(error) => (vec![Block::text(format!("{error:#}"))], true),
        };
        ToolOutcome {
            message: Message::Tool {
                call_id: call["id"].as_str().unwrap_or("").into(),
                content: blocks,
                is_error,
                vendor: None,
            },
        }
    }
    async fn execute_surface_inner(
        &self,
        agent: &str,
        configuration: &Value,
        settings: &Value,
        call: &Value,
        tool: &NativeTool,
        cancel: &CancellationToken,
    ) -> Result<(Vec<Block>, bool)> {
        self.assert_local_compute(configuration)?;
        let args = self.surface_arguments(call, tool)?;
        let mode = self.mode(settings)?;
        let vendor = tool.vendor.unwrap();
        let mut lease = match tool.implementation {
            I::ReadFile
            | I::ViewImage
            | I::WriteFile
            | I::EditFile
            | I::Glob
            | I::Grep
            | I::ListDirectory
            | I::ApplyPatch
            | I::KimiMedia => Some(FileLease::reserve(self, agent, call)?),
            _ => None,
        };
        let mut result = match tool.implementation {
            I::ReadFile if vendor == V::Kimi => {
                self.files
                    .kimi_read(configuration, mode, &args, cancel)
                    .await?
            }
            I::ReadFile => {
                self.files
                    .read(configuration, mode, vendor.as_str(), &args, false, cancel)
                    .await?
            }
            I::ViewImage => {
                self.files
                    .read(configuration, mode, vendor.as_str(), &args, true, cancel)
                    .await?
            }
            I::WriteFile => {
                self.files
                    .write(agent, configuration, mode, vendor.as_str(), &args, cancel)
                    .await?
            }
            I::EditFile => {
                self.files
                    .edit(agent, configuration, mode, vendor.as_str(), &args, cancel)
                    .await?
            }
            I::Glob | I::Grep | I::ListDirectory => {
                self.files
                    .discover(
                        configuration,
                        mode,
                        vendor.as_str(),
                        tool.definition.name.as_str(),
                        &args,
                        cancel,
                    )
                    .await?
            }
            I::ApplyPatch => {
                self.files
                    .patch(agent, configuration, mode, &args, cancel)
                    .await?
            }
            I::KimiMedia => {
                self.files
                    .kimi_media(configuration, mode, &args, cancel)
                    .await?
            }
            _ => {
                return self
                    .vendor_shell(agent, configuration, mode, tool, &args, cancel)
                    .await;
            }
        };
        self.surface_result(tool, &result.value)?;
        if result.blocks.is_empty() {
            let path = result.value["path"].as_str().unwrap_or("");
            let text = match tool.implementation {
                I::WriteFile if vendor == V::Grok => format!(
                    "{} {path} ({} characters).",
                    if result.value["created"] == true {
                        "Created"
                    } else {
                        "Replaced"
                    },
                    result.value["characters"]
                ),
                I::WriteFile if vendor == V::Kimi => format!(
                    "File {} at {path}.",
                    if result.value["created"] == true {
                        "created"
                    } else {
                        "updated"
                    }
                ),
                I::WriteFile => format!(
                    "File {} successfully at: {path}",
                    if result.value["created"] == true {
                        "created"
                    } else {
                        "updated"
                    }
                ),
                I::EditFile if vendor == V::Kimi => format!(
                    "Updated {path}; replaced {} occurrence{}.",
                    result.value["replacements"],
                    if result.value["replacements"] == 1 {
                        ""
                    } else {
                        "s"
                    }
                ),
                I::EditFile if vendor == V::Grok => format!(
                    "Successfully replaced {} occurrence{} in {path}.",
                    result.value["replacements"],
                    if result.value["replacements"] == 1 {
                        ""
                    } else {
                        "s"
                    }
                ),
                I::EditFile => format!("The file {path} has been updated."),
                _ => result.value["summary"].as_str().unwrap_or("").to_owned(),
            };
            result.blocks.push(Block::text(text));
        }
        let presentation = result.value.get("presentation").cloned();
        if result.read.is_some() || presentation.is_some() {
            let reads = if let Some(read) = result.read {
                if self.schemas.valid("computeFileReadLog", &read)? {
                    read.as_array().unwrap().clone()
                } else {
                    ensure!(
                        self.schemas.valid("computeFileReadLog", &json!([read]))?,
                        "The prepared file read is invalid."
                    );
                    vec![read]
                }
            } else {
                Vec::new()
            };
            lease.as_mut().unwrap().stage(PreparedFile {
                reads,
                presentation,
            });
        }
        Ok((result.blocks, false))
    }
    fn parse_vendor_session(&self, vendor: V, id: &str) -> Result<u64> {
        let written = if vendor == V::Grok { id.trim() } else { id };
        let schema = if vendor == V::Kimi {
            "computeKimiTaskId"
        } else {
            "computeDecimalTaskId"
        };
        ensure!(
            self.schemas.valid(schema, &json!(written))?,
            "The background shell identifier is invalid."
        );
        let numeric = written
            .parse::<u64>()
            .context("The background shell identifier is invalid.")?;
        ensure!(
            self.schemas.valid("commandSessionId", &json!(numeric))?,
            "The background shell identifier is invalid."
        );
        Ok(numeric)
    }
}

/// Reserve bounded result metadata before an operation can change a file.
/// Cancellation may commit its final result before an owned write finishes;
/// that terminal transaction removes the reservation and staging never revives it.
struct FileLease<'a> {
    tools: &'a ToolsModule,
    key: (String, String),
    staged: bool,
}
impl<'a> FileLease<'a> {
    fn reserve(tools: &'a ToolsModule, agent: &str, call: &Value) -> Result<Self> {
        let key = (
            agent.to_owned(),
            call["id"]
                .as_str()
                .context("The tool identity is missing.")?
                .to_owned(),
        );
        let mut prepared = tools
            .prepared_reads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        ensure!(
            !prepared.contains_key(&key),
            "This file operation is already executing."
        );
        ensure!(
            prepared.len() < 64,
            "The bounded file-result staging catalog is full."
        );
        prepared.insert(
            key.clone(),
            PreparedFile {
                reads: Vec::new(),
                presentation: None,
            },
        );
        Ok(Self {
            tools,
            key,
            staged: false,
        })
    }
    fn stage(&mut self, result: PreparedFile) {
        let mut prepared = self
            .tools
            .prepared_reads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(slot) = prepared.get_mut(&self.key) {
            *slot = result;
            self.staged = true;
        }
    }
}
impl Drop for FileLease<'_> {
    fn drop(&mut self) {
        if !self.staged {
            self.tools
                .prepared_reads
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&self.key);
        }
    }
}
