use super::*;
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope, ToolPermissionPolicy};
use happy_providers::{Block, Message};
use tokio_util::sync::CancellationToken;

fn tool(call: &Value) -> Option<&str> {
    let native = &call["call"];
    if native.get("namespace").is_some_and(|v| !v.is_null()) {
        return None;
    }
    native["name"].as_str().filter(|name| {
        matches!(
            *name,
            "list_secrets"
                | "reference_secret"
                | "create_secret"
                | "update_secret"
                | "attach_secret"
                | "detach_secret"
        )
    })
}
fn visible(value: &str) -> String {
    let mut output = String::from("\"");
    for c in value.chars() {
        let code = c as u32;
        if c == '"' || c == '\\' {
            output.push('\\');
            output.push(c);
        } else if c == '\n' {
            output.push_str("\\n");
        } else if c == '\r' {
            output.push_str("\\r");
        } else if c == '\t' {
            output.push_str("\\t");
        } else if code < 0x20
            || code == 0x7f
            || (0x202a..=0x202e).contains(&code)
            || (0x2066..=0x2069).contains(&code)
        {
            output.push_str(&format!("\\u{{{code:04x}}}"));
        } else {
            output.push(c);
        }
    }
    output.push('"');
    output
}
fn message(call: &Value, text: String, error: bool) -> Message {
    Message::Tool {
        call_id: call["id"].as_str().unwrap_or("").into(),
        content: vec![Block::text(text)],
        is_error: error,
        vendor: None,
    }
}
fn arguments(call: &Value) -> Result<Value> {
    serde_json::from_str(
        call["call"]["arguments"]
            .as_str()
            .context("The secret tool arguments are missing.")?,
    )
    .map_err(|_| SecretInputError("The secret tool arguments are invalid.".into()).into())
}
fn format_page(page: &Value) -> Result<String> {
    let rows = page["secrets"].as_array().expect("validated catalog page");
    let cursor = if page["nextCursor"].is_null() {
        String::new()
    } else {
        format!("\nnext={}", page["nextCursor"])
    };
    let detailed = if rows.is_empty() {
        "No secrets are registered.".into()
    } else {
        rows.iter()
            .map(|record| {
                let mut text = format!(
                    "{}: {}\n  Environment variables: {}",
                    record["id"],
                    record["description"].as_str().expect("description"),
                    record["environmentVariables"]
                        .as_array()
                        .expect("names")
                        .iter()
                        .map(|v| v.as_str().expect("name"))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                if record["availableToAgents"] == false {
                    text.push_str("\n  Availability: not available to agents");
                }
                if record["managed"] == true {
                    text.push_str("\n  Ownership: daemon managed");
                }
                text
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let detailed = format!("{detailed}{cursor}");
    let output = if detailed.encode_utf16().count() <= 12000 {
        detailed
    } else {
        format!(
            "{}{cursor}",
            rows.iter()
                .map(|v| v["id"].as_str().expect("id"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    ensure!(
        output.encode_utf16().count() <= 12000,
        "Secret catalog output cannot fit complete identities and cursor."
    );
    Ok(output)
}
impl SecretsModule {
    fn tool_result(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
        name: &str,
    ) -> Result<Message> {
        let input = arguments(call)?;
        self.validate(&format!("secretTool_{name}"), &input)?;
        let (result, text) = match name {
            "list_secrets" => {
                let page = self.list(ctx, &input)?;
                let text = format_page(&page)?;
                (page, text)
            }
            "reference_secret" => {
                let secret = self.get(ctx, input["id"].as_str().expect("id"))?;
                let text = secret
                    .as_ref()
                    .map(|secret| format_page(&json!({"secrets":[secret],"nextCursor":null})))
                    .transpose()?
                    .unwrap_or_else(|| "That secret reference is not registered.".into());
                (json!({"secret":secret}), text)
            }
            "attach_secret" => {
                let id = input["secretId"].as_str().expect("id");
                let secret = self
                    .get(ctx, id)?
                    .context("That global secret is not registered.")?;
                let (attachment, _) =
                    self.attach(ctx, id, &json!({"type":"agent","id":scope.id}), None)?;
                let text = format!(
                    "Attached {} to exact agent {}.\n{}",
                    json!(id),
                    json!(scope.id),
                    format_page(&json!({"secrets":[secret],"nextCursor":null}))?
                );
                (json!({"attachment":attachment,"secret":secret}), text)
            }
            "detach_secret" => {
                let id = input["secretId"].as_str().expect("id");
                let attachment =
                    self.detach(ctx, id, &json!({"type":"agent","id":scope.id}), None)?;
                let text = if attachment.is_some() {
                    format!(
                        "Detached {} from exact agent {}.",
                        json!(id),
                        json!(scope.id)
                    )
                } else {
                    format!(
                        "That secret was not directly attached to exact agent {}.",
                        json!(scope.id)
                    )
                };
                (
                    json!({"detached":attachment.is_some(),"attachment":attachment}),
                    text,
                )
            }
            _ => unreachable!("transactional secret tool"),
        };
        self.validate(&format!("secretResult_{name}"), &result)?;
        Ok(message(call, text, false))
    }
    async fn write_tool(&self, call: &Value, name: &str) -> Result<Message> {
        let input = arguments(call)?;
        self.validate(&format!("secretTool_{name}"), &input)?;
        let environment = match (
            input.get("environment"),
            input.get("dotenvFile").and_then(Value::as_str),
        ) {
            (Some(environment), None) => environment.clone(),
            (None, Some(path)) => {
                let path = path.to_owned();
                let schemas = self.schemas.clone();
                tokio::task::spawn_blocking(move || dotenv::read(&path, &schemas)).await??
            }
            _ => {
                anyhow::bail!("Supply exactly one secret value source: environment or dotenvFile.")
            }
        };
        validate_environment(&self.schemas, &environment, true)?;
        let module = self.clone();
        let is_create = name == "create_secret";
        let secret = self
            .runtime
            .transact(move |ctx| {
                if is_create {
                    let mut request =
                        json!({"description":input["description"],"environment":environment});
                    for key in ["id", "availableToAgents"] {
                        if let Some(value) = input.get(key) {
                            request[key] = value.clone();
                        }
                    }
                    return module.create(ctx, &request, None).map(Some);
                }
                let id = input["secretId"].as_str().expect("id");
                let Some(current) = module.get(ctx, id)? else {
                    return Ok(None);
                };
                let mut patch = serde_json::Map::new();
                let mut replacement = environment.as_object().expect("environment").clone();
                for previous in current["environmentVariables"].as_array().expect("names") {
                    let previous = previous.as_str().expect("name");
                    let next = replacement
                        .keys()
                        .find(|name| name.eq_ignore_ascii_case(previous))
                        .cloned();
                    let value = next
                        .and_then(|name| replacement.remove(&name))
                        .unwrap_or(Value::Null);
                    patch.insert(previous.to_owned(), value);
                }
                patch.extend(replacement);
                let mut request = json!({"environment":patch});
                for key in ["description", "availableToAgents"] {
                    if let Some(value) = input.get(key) {
                        request[key] = value.clone();
                    }
                }
                module.update(
                    ctx,
                    id,
                    &request,
                    current["version"].as_str().expect("version"),
                    None,
                )
            })
            .await?;
        let result = json!({"secret":secret});
        self.validate(&format!("secretResult_{name}"), &result)?;
        let text = if let Some(secret) = secret {
            format!(
                "{} global secret.\n{}",
                if is_create { "Created" } else { "Updated" },
                format_page(&json!({"secrets":[secret],"nextCursor":null}))?
            )
        } else {
            "That global secret reference is not registered.".into()
        };
        Ok(message(call, text, false))
    }
}
#[async_trait]
impl AgentModule for SecretsModule {
    fn name(&self) -> &'static str {
        "secrets"
    }
    fn tools(&self, _scope: &AgentScope<'_>) -> Vec<ToolDefinition> {
        self.definitions.as_ref().clone()
    }
    async fn instructions(&self, scope: &AgentScope<'_>) -> Result<String> {
        Ok(format!(
            "Secret tools expose the shared installation catalog's references and environment-variable names. Create or update may receive raw values in the reviewed tool arguments, where they remain in the transcript, or read them from an absolute host .env path. Values are never returned in tool results or model output. Creating or updating a secret does not attach the reference to an agent. A reviewed inline mutation stays sandboxed; a reviewed .env file source separately requests host filesystem access. The attach_secret and detach_secret tools change only this exact agent ({}). Project and workspace attachments may also make secrets available here. Put only the secret IDs one shell command needs in its secrets argument. Omit secrets or use an empty array for none. Secret selection is reviewed but stays inside the current sandbox; requesting elevated permissions is a separate choice, and the two may be used independently or together.",
            json!(scope.id)
        ))
    }
    fn reloadable(&self, call: &Value) -> Option<bool> {
        tool(call).map(|name| matches!(name, "list_secrets" | "reference_secret"))
    }
    fn permission_policy(
        &self,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<ToolPermissionPolicy>> {
        let name = tool(call)?;
        let args = match arguments(call) {
            Ok(args) => args,
            Err(error) => return Some(Err(error)),
        };
        let file = args.get("dotenvFile").and_then(Value::as_str);
        let is_write = matches!(name, "create_secret" | "update_secret");
        let action = match name {
            "create_secret" | "update_secret" => {
                let id = args
                    .get(if name == "create_secret" {
                        "id"
                    } else {
                        "secretId"
                    })
                    .and_then(Value::as_str)
                    .map(visible)
                    .unwrap_or_else(|| "with a new ID".into());
                let source = file
                    .map(|file| format!("dotenv file {}", visible(file)))
                    .unwrap_or_else(|| "inline environment arguments".into());
                format!(
                    "{} global secret {id} from {source}. Access: global secret catalog write{}",
                    if name == "create_secret" {
                        "creating"
                    } else {
                        "updating"
                    },
                    if file.is_some() {
                        " and unrestricted host filesystem read"
                    } else {
                        ""
                    }
                )
            }
            "attach_secret" => format!(
                "attaching secret reference {} to scope {}. This grants that exact agent access to the secret for later host operations",
                visible(args["secretId"].as_str().unwrap_or("")),
                visible(scope.id)
            ),
            "detach_secret" => format!(
                "detaching secret reference {} from scope {}. This revokes that exact agent's direct access to the secret for later host operations",
                visible(args["secretId"].as_str().unwrap_or("")),
                visible(scope.id)
            ),
            _ => "reading safe secret catalog metadata".into(),
        };
        Some(Ok(ToolPermissionPolicy{should_review_in_auto_mode:!matches!(name,"list_secrets"|"reference_secret"),should_run_in_full_access_in_auto_mode:is_write&&file.is_some(),requires_auto_or_full_access:is_write,action,instructions:is_write.then(||format!("{} a secret mutates the global secret catalog. Inline values stay in the tool transcript. A dotenv source also reads one absolute host file.",if name=="create_secret"{"Creating"}else{"Updating"}))}))
    }
    fn execute_transactional_tool(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        call: &Value,
    ) -> Option<Result<Message>> {
        let name = tool(call)?;
        if matches!(name, "create_secret" | "update_secret") {
            return None;
        }
        Some(self.tool_result(ctx, scope, call, name))
    }
    async fn execute_tool(
        &self,
        _scope: &AgentScope<'_>,
        call: &Value,
        _cancel: CancellationToken,
    ) -> Option<Message> {
        let name = tool(call)?;
        if !matches!(name, "create_secret" | "update_secret") {
            return None;
        }
        Some(match self.write_tool(call, name).await {
            Ok(message) => message,
            Err(error) => message(call, error.to_string(), true),
        })
    }
}
