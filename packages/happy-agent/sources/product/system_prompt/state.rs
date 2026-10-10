use super::{SystemPromptModule, format};
use crate::product::runtime::Context;
use anyhow::{Context as _, Result, ensure};
use happy_agent_base::{AcceptedInput, AgentScope};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const FINGERPRINT: &str = "last-delivered-fingerprint";
const PENDING: &str = "pending-notice";
const SNAPSHOT: &str = "turn-instructions-snapshot";
pub(super) fn key(agent: &str, name: &str) -> String {
    format!(
        "kv.{agent}.{}module.system-prompt.{name}",
        if name == SNAPSHOT { "run." } else { "" }
    )
}
impl SystemPromptModule {
    pub(super) async fn instructions_snapshot(&self, scope: &AgentScope<'_>) -> Result<String> {
        let owner = self
            .owner
            .upgrade()
            .context("The system prompt module was closed.")?;
        let agent = scope.id.to_owned();
        let stored = self
            .runtime
            .transact(move |ctx| {
                let snapshot = ctx.value(&agent, &key(&agent, SNAPSHOT))?;
                if let Some(snapshot) = &snapshot {
                    ensure!(
                        owner.sound_snapshot(snapshot)?,
                        "Stored AGENTS.md turn snapshot is invalid."
                    );
                }
                Ok(snapshot)
            })
            .await?;
        let snapshot = match stored {
            Some(snapshot) => (!snapshot.is_null()).then_some(snapshot),
            None => {
                self.read_agents_md(scope, &CancellationToken::new())
                    .await?
            }
        };
        let fingerprint = format::fingerprint(&format::body(snapshot.as_ref()));
        let owner = self
            .owner
            .upgrade()
            .context("The system prompt module was closed.")?;
        let agent = scope.id.to_owned();
        self.runtime
            .transact(move |ctx| {
                match ctx.value(&agent, &key(&agent, FINGERPRINT))? {
                    None => ctx.put_value(&agent, &key(&agent, FINGERPRINT), &fingerprint)?,
                    Some(value) => ensure!(
                        owner.schemas.valid("ownerAgentsMdFingerprint", &value)?,
                        "Stored AGENTS.md fingerprint is invalid."
                    ),
                }
                Ok(())
            })
            .await?;
        Ok(format::instructions(snapshot.as_ref()))
    }
    /// Base owns steering acceptance and restart; this hook persists its notice intent in that boundary.
    pub async fn prepare_turn(
        &self,
        scope: &AgentScope<'_>,
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>> {
        let owner = self
            .owner
            .upgrade()
            .context("The system prompt module was closed.")?;
        let agent = scope.id.to_owned();
        let previous = self
            .runtime
            .transact(move |ctx| {
                let value = ctx.value(&agent, &key(&agent, FINGERPRINT))?;
                if let Some(value) = &value {
                    ensure!(
                        owner.schemas.valid("ownerAgentsMdFingerprint", value)?,
                        "Stored AGENTS.md fingerprint is invalid."
                    );
                }
                Ok(value)
            })
            .await?;
        let snapshot = self.read_agents_md(scope, cancel).await?;
        let body = format::body(snapshot.as_ref());
        let fingerprint = format::fingerprint(&body);
        let owner = self
            .owner
            .upgrade()
            .context("The system prompt module was closed.")?;
        let agent = scope.id.to_owned();
        self.runtime.transact(move |ctx| {
            ctx.put_value(&agent, &key(&agent, SNAPSHOT), &snapshot.unwrap_or(Value::Null))?;
            let Some(previous) = previous.filter(|previous| previous != &fingerprint) else { return Ok(Vec::new()); };
            let current = ctx.value(&agent, &key(&agent, PENDING))?;
            if let Some(current) = &current { ensure!(owner.schemas.valid("ownerAgentsMdPending", current)?, "Stored AGENTS.md pending notice is invalid."); }
            let pending = match current {
                Some(current) if current["from"] == previous && current["to"] == fingerprint => current,
                _ => json!({"from":previous,"id":cuid2::create_id(),"to":fingerprint}),
            };
            ctx.put_value(&agent, &key(&agent, PENDING), &pending)?;
            let text = if body.is_empty() { format::REMOVAL.to_owned() } else { format!("{}\n\n{body}", format::REPLACEMENT) };
            Ok(vec![json!({"id":pending["id"],"message":{"role":"system","content":[{"type":"text","text":text}]},"options":{},"metadata":{"hideFromUser":true,"agentsMd":{"fingerprint":fingerprint,"kind":"agents-md","noticeId":pending["id"]}}})])
        }).await
    }
    pub(super) fn accept_notices(
        &self,
        ctx: &Context<'_>,
        scope: &AgentScope<'_>,
        inputs: &[AcceptedInput],
        steering: bool,
    ) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        for accepted in inputs {
            let input = &accepted.input;
            let metadata = &input["metadata"]["agentsMd"];
            if !self.schemas.valid("ownerAgentsMdNotice", metadata)?
                || !steering
                || input["id"] != metadata["noticeId"]
                || input["metadata"]["hideFromUser"] != true
                || input["message"]["role"] != "system"
            {
                continue;
            }
            let Some(content) = input["message"]["content"]
                .as_array()
                .filter(|content| content.len() == 1)
            else {
                continue;
            };
            if content[0]["type"] != "text" {
                continue;
            }
            let Some(text) = content[0]["text"].as_str() else {
                continue;
            };
            let fingerprint = &metadata["fingerprint"];
            if fingerprint.is_null() {
                if text != format::REMOVAL {
                    continue;
                }
            } else {
                let Some(body) = text.strip_prefix(&format!("{}\n\n", format::REPLACEMENT)) else {
                    continue;
                };
                if format::fingerprint(body) != *fingerprint {
                    continue;
                }
            }
            let Some(pending) = ctx.value(scope.id, &key(scope.id, PENDING))? else {
                continue;
            };
            if !self.schemas.valid("ownerAgentsMdPending", &pending)?
                || pending["id"] != metadata["noticeId"]
                || pending["to"] != *fingerprint
            {
                continue;
            }
            let Some(delivered) = ctx.value(scope.id, &key(scope.id, FINGERPRINT))? else {
                continue;
            };
            if !self.schemas.valid("ownerAgentsMdFingerprint", &delivered)?
                || delivered != pending["from"]
            {
                continue;
            }
            ctx.put_value(scope.id, &key(scope.id, FINGERPRINT), fingerprint)?;
            ctx.delete_value(scope.id, &key(scope.id, PENDING))?;
        }
        Ok(())
    }
}
