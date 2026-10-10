pub use super::journal::{Entry, Journal};
use super::{
    identity::{Versions, now},
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-durable-events",
        "CREATE TABLE IF NOT EXISTS happy_agent_events(event_id TEXT PRIMARY KEY,agent_id TEXT,occurred_at INTEGER NOT NULL,type TEXT NOT NULL,payload_json TEXT NOT NULL);CREATE INDEX IF NOT EXISTS happy_agent_events_agent_id_event_id ON happy_agent_events(agent_id,event_id);CREATE TABLE IF NOT EXISTS happy_agent_event_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS happy_agent_active_runs(agent_id TEXT PRIMARY KEY,state_json TEXT NOT NULL);",
    ),
    (
        "002-latest-agent-events",
        "CREATE TABLE IF NOT EXISTS happy_agent_latest_events(agent_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,occurred_at INTEGER NOT NULL,previous_event_id TEXT);",
    ),
    (
        "003-event-payload-bytes",
        "ALTER TABLE happy_agent_events ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0;UPDATE happy_agent_events SET payload_bytes=length(CAST(payload_json AS BLOB));CREATE INDEX happy_agent_events_retention ON happy_agent_events(event_id DESC,payload_bytes);",
    ),
];

pub struct EventsModule {
    runtime: Arc<RuntimeModule>,
    versions: Mutex<Versions>,
    journal: Arc<Mutex<Journal>>,
    schemas: Schemas,
}
struct Publication {
    durable: Value,
    public: Option<Value>,
}
impl From<Value> for Publication {
    fn from(public: Value) -> Self {
        Self {
            durable: public.clone(),
            public: Some(public),
        }
    }
}
impl EventsModule {
    pub fn new(runtime: Arc<RuntimeModule>) -> Result<Self> {
        Ok(Self {
            runtime,
            versions: Mutex::new(Versions::new()),
            journal: Arc::new(Mutex::new(Journal::new())),
            schemas: Schemas::new()?,
        })
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime.migrate("events", MIGRATIONS).await?;
        let events = self.clone();
        self.runtime
            .transact(move |ctx| {
                let cursor: Option<String> = ctx.database().query_row(
                    "SELECT max(event_id) FROM happy_agent_events",
                    [],
                    |row| row.get(0),
                )?;
                if let Some(cursor) = cursor {
                    anyhow::ensure!(
                        events.schemas.valid("cursor", &json!(cursor))?,
                        "The durable event cursor is invalid."
                    );
                    events
                        .versions
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .observe(uuid::Uuid::parse_str(&cursor)?);
                }
                Ok(())
            })
            .await
    }
    pub fn with_journal<T>(&self, work: impl FnOnce(&mut Journal) -> T) -> T {
        work(
            &mut self
                .journal
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
    pub fn cursor(&self) -> String {
        self.with_journal(|journal| journal.cursor().to_owned())
    }
    pub fn agent_cursor(&self, id: &str) -> String {
        self.with_journal(|journal| journal.agent_cursor(id).to_owned())
    }
    pub fn record(
        &self,
        ctx: &Context<'_>,
        agent: Option<&str>,
        kind: &str,
        payload: Value,
    ) -> Result<String> {
        let id = self
            .versions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .next();
        self.record_at(ctx, agent, kind, payload.into(), id, now())
    }
    pub fn record_history_message(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        kind: &str,
        run: Value,
        message: Value,
    ) -> Result<String> {
        let durable = json!({"agentId":agent,"runId":run,"messageId":message["id"]});
        anyhow::ensure!(
            self.schemas.valid("historyEventReference", &durable)?,
            "The history event reference is invalid."
        );
        let public = json!({"agentId":agent,"runId":run,"message":message});
        let id = self
            .versions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .next();
        self.record_at(
            ctx,
            Some(agent),
            kind,
            Publication {
                durable,
                public: Some(public),
            },
            id,
            now(),
        )
    }
    pub fn record_versioned(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        previous: &str,
        changes: Value,
    ) -> Result<String> {
        let id = self
            .versions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .next();
        self.record_at(
            ctx,
            Some(agent),
            "agent.updated",
            json!({"agentId":agent,"previousVersion":previous,"version":id,"changes":changes})
                .into(),
            id,
            now(),
        )
    }
    pub fn record_agent_created(
        &self,
        ctx: &Context<'_>,
        id: &str,
        mut agent: Value,
        mutation: Option<&Value>,
    ) -> Result<String> {
        let version = self
            .versions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .next();
        let occurred = now();
        agent["version"] = json!(version);
        agent["updatedAt"] = json!(occurred);
        let mut payload = json!({"agent":agent});
        if let Some(mutation) = mutation {
            payload["mutationId"] = mutation.clone();
        }
        self.record_at(
            ctx,
            Some(id),
            "agent.created",
            payload.into(),
            version,
            occurred,
        )
    }
    fn record_at(
        &self,
        ctx: &Context<'_>,
        agent: Option<&str>,
        kind: &str,
        payload: Publication,
        id: String,
        occurred_at: u64,
    ) -> Result<String> {
        let mut input = json!({"type":kind,"payload":payload.durable});
        if let Some(agent) = agent {
            input["agentId"] = json!(agent);
        }
        anyhow::ensure!(
            self.schemas.valid("appendEvent", &input)?,
            "The event input is invalid."
        );
        let occurred_at = i64::try_from(occurred_at)?;
        let encoded = payload.durable.to_string();
        anyhow::ensure!(
            encoded.len() <= 5 * 1024 * 1024,
            "The event payload exceeds its allowed size."
        );
        let db = ctx.database();
        db.execute("INSERT INTO happy_agent_events(event_id,agent_id,occurred_at,type,payload_json,payload_bytes) VALUES(?1,?2,?3,?4,?5,?6)",params![id,agent,occurred_at,kind,encoded,encoded.len() as i64])?;
        if let Some(agent) = agent {
            db.execute("INSERT INTO happy_agent_latest_events(agent_id,event_id,occurred_at,previous_event_id) VALUES(?1,?2,?3,NULL) ON CONFLICT(agent_id) DO UPDATE SET previous_event_id=event_id,event_id=excluded.event_id,occurred_at=excluded.occurred_at",params![agent,id,occurred_at])?;
        }
        // Filter retention in SQL before reading any unrelated payload. Both
        // count and bytes are bounded independently of public SSE subscribers.
        let boundary:Option<String>=db.query_row("SELECT event_id FROM (SELECT event_id,row_number() OVER(ORDER BY event_id DESC) AS position,sum(payload_bytes) OVER(ORDER BY event_id DESC) AS bytes FROM happy_agent_events) WHERE position>10000 OR bytes>33554432 ORDER BY event_id DESC LIMIT 1",[],|row|row.get(0)).optional()?;
        if let Some(boundary) = boundary {
            db.execute(
                "DELETE FROM happy_agent_events WHERE event_id<=?1",
                [&boundary],
            )?;
            db.execute("INSERT INTO happy_agent_event_state(key,value) VALUES('origin_cursor',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[boundary])?;
        }
        let Some(payload) = payload.public else {
            return Ok(id);
        };
        let journal = self.journal.clone();
        let kind = kind.to_owned();
        ctx.after_commit(move || {
            journal
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .append_with_cursor(
                    &kind,
                    |cursor| {
                        let mut payload = payload;
                        if kind == "agent.created" {
                            payload["agent"]["lastCursor"] = json!(cursor);
                        }
                        payload
                    },
                    None,
                );
        })?;
        Ok(id)
    }
    pub fn latest_transition(
        &self,
        ctx: &Context<'_>,
        agent: &str,
    ) -> Result<Option<(String, u64, Option<String>)>> {
        Ok(ctx.database().query_row("SELECT event_id,occurred_at,previous_event_id FROM happy_agent_latest_events WHERE agent_id=?1",[agent],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?)
    }
    pub fn publish(
        &self,
        ctx: &Context<'_>,
        kind: &str,
        payload: Value,
        occurred_at: u64,
    ) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas
                .valid("appendEvent", &json!({"type":kind,"payload":payload}))?,
            "The public event payload is invalid."
        );
        let journal = self.journal.clone();
        let kind = kind.to_owned();
        ctx.after_commit(move || {
            journal
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .append_at(&kind, payload, None, occurred_at);
        })
    }
    pub fn publish_subtask_update(
        &self,
        ctx: &Context<'_>,
        payload: Value,
        subtasks: Vec<Value>,
        occurred_at: u64,
    ) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid(
                "appendEvent",
                &json!({"type":"agent.updated","payload":payload})
            )?,
            "The public agent update is invalid."
        );
        for subtask in &subtasks {
            anyhow::ensure!(
                self.schemas.valid("ownerPublicAgent", subtask)?,
                "The public subtask resource is invalid."
            );
        }
        let journal = self.journal.clone();
        ctx.after_commit(move || {
            journal
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .append_subtask_update(payload, subtasks, occurred_at);
        })
    }
    pub fn publish_ephemeral_process(&self, kind: &str, payload: Value) -> Result<()> {
        anyhow::ensure!(
            self.schemas
                .valid("appendEvent", &json!({"type":kind,"payload":payload}))?,
            "The public process event is invalid."
        );
        self.with_journal(|journal| journal.append(kind, payload, None));
        Ok(())
    }
    pub fn latest(&self, ctx: &Context<'_>, agent: &str) -> Result<Option<(String, i64)>> {
        Ok(ctx
            .database()
            .query_row(
                "SELECT event_id,occurred_at FROM happy_agent_latest_events WHERE agent_id=?1",
                [agent],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }
    pub fn active_run(&self, ctx: &Context<'_>, agent: &str) -> Result<Option<Value>> {
        let encoded: Option<String> = ctx
            .database()
            .query_row(
                "SELECT state_json FROM happy_agent_active_runs WHERE agent_id=?1",
                [agent],
                |row| row.get(0),
            )
            .optional()?;
        encoded
            .map(|encoded| {
                let value: Value = serde_json::from_str(&encoded)?;
                anyhow::ensure!(
                    self.schemas.valid("activeRun", &value)?,
                    "A durable active run is invalid."
                );
                Ok(value)
            })
            .transpose()
    }
    pub fn run_id(&self, ctx: &Context<'_>, agent: &str) -> Result<Option<String>> {
        Ok(self
            .active_run(ctx, agent)?
            .map(|value| value["runId"].as_str().unwrap_or("").to_owned()))
    }
    pub fn store_active(&self, ctx: &Context<'_>, agent: &str, value: &Value) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid("activeRun", value)?,
            "The active run state is invalid."
        );
        ctx.database().execute("INSERT INTO happy_agent_active_runs(agent_id,state_json) VALUES(?1,?2) ON CONFLICT(agent_id) DO UPDATE SET state_json=excluded.state_json",params![agent,value.to_string()])?;
        Ok(())
    }
    pub fn settle(&self, ctx: &Context<'_>, agent: &str) -> Result<String> {
        let id = self
            .run_id(ctx, agent)?
            .context("The agent has no active public run.")?;
        ctx.database().execute(
            "DELETE FROM happy_agent_active_runs WHERE agent_id=?1",
            [agent],
        )?;
        Ok(id)
    }
}

#[async_trait::async_trait]
impl happy_agent_base::AgentModule for EventsModule {
    fn name(&self) -> &'static str {
        "events"
    }
    fn metadata_changed(
        &self,
        ctx: &Context<'_>,
        scope: &happy_agent_base::AgentScope<'_>,
        change: &Value,
    ) -> Result<()> {
        let id = self
            .versions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .next();
        self.record_at(
            ctx,
            Some(scope.id),
            "agent.metadata-changed",
            Publication {
                durable: change.clone(),
                public: None,
            },
            id,
            now(),
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
