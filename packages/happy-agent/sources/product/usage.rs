use super::{
    config::ConfigModule,
    events::EventsModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-usage-records",
        "CREATE TABLE IF NOT EXISTS happy_agent_usage_records(record_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,finished_at INTEGER NOT NULL,kind TEXT NOT NULL,record_json TEXT NOT NULL);CREATE INDEX IF NOT EXISTS happy_agent_usage_records_agent_time ON happy_agent_usage_records(agent_id,finished_at,record_id);CREATE TABLE IF NOT EXISTS happy_agent_usage_reset_receipts(operation_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,receipt_json TEXT NOT NULL);",
    ),
    (
        "002-drop-usage-reset-receipts",
        "DROP TABLE IF EXISTS happy_agent_usage_reset_receipts;",
    ),
    (
        "003-usage-run-attribution",
        "ALTER TABLE happy_agent_usage_records ADD COLUMN run_id TEXT;CREATE INDEX happy_agent_usage_records_agent_run_time ON happy_agent_usage_records(agent_id,run_id,finished_at,record_id);",
    ),
    (
        "004-usage-current-context",
        "CREATE TABLE IF NOT EXISTS happy_agent_usage_contexts(agent_id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,context_json TEXT);",
    ),
    (
        "005-usage-model-totals",
        "CREATE TABLE IF NOT EXISTS happy_agent_usage_model_totals(agent_id TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,cache_write_tokens INTEGER NOT NULL,PRIMARY KEY(agent_id,provider,model));INSERT INTO happy_agent_usage_model_totals(agent_id,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) SELECT agent_id,json_extract(record_json,'$.provider'),json_extract(record_json,'$.model'),SUM(json_extract(record_json,'$.tokens.input')),SUM(json_extract(record_json,'$.tokens.output')),SUM(COALESCE(json_extract(record_json,'$.tokens.cacheRead'),0)),SUM(COALESCE(json_extract(record_json,'$.tokens.cacheWrite'),0)) FROM happy_agent_usage_records WHERE kind='inference' AND json_type(record_json,'$.model')='text' GROUP BY agent_id,json_extract(record_json,'$.provider'),json_extract(record_json,'$.model') ON CONFLICT(agent_id,provider,model) DO NOTHING;",
    ),
];

pub struct UsageModule {
    runtime: Arc<RuntimeModule>,
    events: Arc<EventsModule>,
    config: Arc<ConfigModule>,
    schemas: Schemas,
}
#[async_trait::async_trait]
impl happy_agent_base::AgentModule for UsageModule {
    fn name(&self) -> &'static str {
        "usage"
    }
    fn history_erased(
        &self,
        ctx: &Context<'_>,
        scope: &happy_agent_base::AgentScope<'_>,
    ) -> Result<()> {
        self.clear_context(ctx, scope.id)
    }
    fn after_inference(
        &self,
        ctx: &Context<'_>,
        scope: &happy_agent_base::AgentScope<'_>,
        inference: &happy_agent_base::Inference<'_>,
    ) -> Result<()> {
        use happy_providers::Outcome;
        let (state, usage) = match inference.outcome {
            Outcome::Normal { usage } => ("normal", Some(usage)),
            Outcome::ToolCall { usage } => ("tool_call", Some(usage)),
            Outcome::Length { usage } => ("length", Some(usage)),
            Outcome::Cancelled => ("cancelled", None),
            Outcome::Error { .. } => ("error", None),
        };
        if let Some(usage) = usage {
            let run = self
                .events
                .run_id(ctx, scope.id)?
                .context("Inference has no public run identity.")?;
            let provider=scope.settings["provider"].as_str().map(str::to_owned).map(Ok).unwrap_or_else(||self.config.default_provider())?;
            let mut record = json!({"id":inference.id,"kind":"inference","agentId":scope.id,"runId":run,"provider":provider,"state":state,"tokens":{"input":usage.input,"output":usage.output,"cacheRead":usage.cache_read,"cacheWrite":usage.cache_write},"startedAt":inference.started_at,"finishedAt":inference.finished_at,"durationMs":inference.finished_at-inference.started_at});
            for field in ["model", "effort"] {
                if let Some(value) = scope.settings.get(field) {
                    record[field] = value.clone();
                }
            }
            if let Some(tier) = scope.settings["serviceTier"].as_str() {
                record["tier"] = json!(tier);
            }
            self.record(ctx, &record)?;
        }
        Ok(())
    }
}
impl UsageModule {
    pub fn new(
        runtime: Arc<RuntimeModule>,
        events: Arc<EventsModule>,
        config: Arc<ConfigModule>,
    ) -> Result<Self> {
        Ok(Self {
            runtime,
            events,
            config,
            schemas: Schemas::new()?,
        })
    }
    pub async fn load(&self) -> Result<()> {
        self.runtime.migrate("usage", MIGRATIONS).await
    }
    pub fn clear_context(&self, ctx: &Context<'_>, agent: &str) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        let previous: Option<Option<String>> = ctx
            .database()
            .query_row(
                "SELECT context_json FROM happy_agent_usage_contexts WHERE agent_id=?1",
                [agent],
                |row| row.get(0),
            )
            .optional()?;
        ctx.database().execute("INSERT INTO happy_agent_usage_contexts(agent_id,updated_at,context_json) VALUES(?1,?2,NULL) ON CONFLICT(agent_id) DO UPDATE SET updated_at=excluded.updated_at,context_json=NULL",params![agent,i64::try_from(super::identity::now())?])?;
        if previous.flatten().is_some() {
            self.events.record(
                ctx,
                Some(agent),
                "agent.context.updated",
                json!({"agentId":agent,"context":null}),
            )?;
        }
        Ok(())
    }
    pub fn record(&self, ctx: &Context<'_>, record: &Value) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("usageRecord", record)?,
            "The usage record is invalid."
        );
        let started = record["startedAt"]
            .as_u64()
            .context("Usage start time is missing.")?;
        let finished = record["finishedAt"]
            .as_u64()
            .context("Usage finish time is missing.")?;
        anyhow::ensure!(
            finished >= started && record["durationMs"].as_u64() == Some(finished - started),
            "Usage duration contradicts its measured span."
        );
        let id = record["id"]
            .as_str()
            .context("Usage identity is missing.")?;
        let existing: Option<String> = ctx
            .database()
            .query_row(
                "SELECT record_json FROM happy_agent_usage_records WHERE record_id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            anyhow::ensure!(
                serde_json::from_str::<Value>(&existing)? == *record,
                "The usage identity already belongs to another measurement."
            );
            return Ok(());
        }
        let agent = record["agentId"]
            .as_str()
            .context("Usage agent identity is missing.")?;
        let provider = record["provider"]
            .as_str()
            .context("Usage provider is missing.")?;
        ctx.database().execute("INSERT INTO happy_agent_usage_records(record_id,agent_id,run_id,finished_at,kind,record_json) VALUES(?1,?2,?3,?4,?5,?6)",params![id,agent,record["runId"].as_str(),i64::try_from(finished)?,record["kind"].as_str(),record.to_string()])?;
        let mut context = Value::Null;
        if record["kind"] == "inference" {
            if let Some(model) = record["model"].as_str() {
                ctx.database().execute("INSERT INTO happy_agent_usage_model_totals(agent_id,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(agent_id,provider,model) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens",params![agent,provider,model,record["tokens"]["input"].as_i64().unwrap_or(0),record["tokens"]["output"].as_i64().unwrap_or(0),record["tokens"]["cacheRead"].as_i64().unwrap_or(0),record["tokens"]["cacheWrite"].as_i64().unwrap_or(0)])?;
            }
            context = json!({"approximate":false,"contextTokens":record["tokens"]["input"].as_u64().unwrap_or(0)+record["tokens"]["output"].as_u64().unwrap_or(0),"provider":provider});
        } else if let Some(tokens) = record.get("contextTokens") {
            context = json!({"approximate":false,"contextTokens":tokens,"provider":provider});
        }
        if !context.is_null() {
            for name in ["model", "effort", "tier"] {
                if let Some(value) = record.get(name) {
                    context[name] = value.clone();
                }
            }
            anyhow::ensure!(
                self.schemas.valid("usageContext", &context)?,
                "The usage context is invalid."
            );
        }
        ctx.database().execute("INSERT INTO happy_agent_usage_contexts(agent_id,updated_at,context_json) VALUES(?1,?2,?3) ON CONFLICT(agent_id) DO UPDATE SET updated_at=excluded.updated_at,context_json=excluded.context_json",params![agent,i64::try_from(finished)?,if context.is_null(){None}else{Some(context.to_string())}])?;
        self.events.record(
            ctx,
            Some(agent),
            "agent.context.updated",
            json!({"agentId":agent,"context":self.context_resource(&context)}),
        )?;
        Ok(())
    }
    pub fn runs(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        ids: &[String],
    ) -> Result<BTreeMap<String, Value>> {
        anyhow::ensure!(ids.len() <= 500, "Too many history runs were requested.");
        let mut groups = BTreeMap::<String, Value>::new();
        let mut statement=ctx.database().prepare("SELECT run_id,json_extract(record_json,'$.provider'),json_extract(record_json,'$.model'),sum(json_extract(record_json,'$.tokens.input')),sum(json_extract(record_json,'$.tokens.output')),sum(coalesce(json_extract(record_json,'$.tokens.cacheRead'),0)),sum(coalesce(json_extract(record_json,'$.tokens.cacheWrite'),0)),count(*) FILTER(WHERE json_extract(record_json,'$.durationMs') IS NULL OR json_extract(record_json,'$.startedAt') IS NULL OR json_extract(record_json,'$.finishedAt') IS NULL OR json_extract(record_json,'$.durationMs')!=json_extract(record_json,'$.finishedAt')-json_extract(record_json,'$.startedAt')) FROM happy_agent_usage_records WHERE agent_id=?1 AND run_id IN(SELECT value FROM json_each(?2)) AND kind='inference' AND json_extract(record_json,'$.model') IS NOT NULL GROUP BY run_id,json_extract(record_json,'$.provider'),json_extract(record_json,'$.model') ORDER BY run_id,2,3")?;
        let rows = statement.query_map(params![agent, json!(ids).to_string()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                [row.get::<_, i64>(3)?, row.get(4)?, row.get(5)?, row.get(6)?],
                row.get::<_, i64>(7)?,
            ))
        })?;
        for row in rows {
            let (run, provider, model, tokens, inconsistent) = row?;
            anyhow::ensure!(
                inconsistent == 0,
                "Stored usage duration contradicts its measured span."
            );
            if tokens == [0; 4] {
                continue;
            }
            let group = groups.entry(run).or_insert(json!({}));
            if group.get(&provider).is_none() {
                group[&provider] = json!({});
            }
            group[&provider][&model] = tokens_value(tokens);
        }
        for group in groups.values() {
            anyhow::ensure!(
                self.schemas.valid("usageBreakdown", group)?,
                "Stored usage totals are invalid."
            );
        }
        Ok(ids
            .iter()
            .map(|id| (id.clone(), groups.remove(id).unwrap_or(json!({}))))
            .collect())
    }
    pub fn model_totals(&self, ctx: &Context<'_>, agent: &str) -> Result<Value> {
        let mut statement=ctx.database().prepare("SELECT provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM happy_agent_usage_model_totals WHERE agent_id=?1 ORDER BY provider,model")?;
        let rows = statement.query_map([agent], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                [row.get::<_, i64>(2)?, row.get(3)?, row.get(4)?, row.get(5)?],
            ))
        })?;
        let mut groups = json!({});
        for row in rows {
            let (provider, model, tokens) = row?;
            if tokens == [0; 4] {
                continue;
            }
            if groups.get(&provider).is_none() {
                groups[&provider] = json!({});
            }
            groups[&provider][&model] = tokens_value(tokens);
        }
        anyhow::ensure!(
            self.schemas.valid("usageBreakdown", &groups)?,
            "Stored usage totals are invalid."
        );
        Ok(groups)
    }
    pub fn current_context(&self, ctx: &Context<'_>, agent: &str) -> Result<Value> {
        let encoded: Option<Option<String>> = ctx
            .database()
            .query_row(
                "SELECT context_json FROM happy_agent_usage_contexts WHERE agent_id=?1",
                [agent],
                |row| row.get(0),
            )
            .optional()?;
        let Some(encoded) = encoded.flatten() else {
            return Ok(Value::Null);
        };
        let context: Value = serde_json::from_str(&encoded)?;
        anyhow::ensure!(
            self.schemas.valid("usageContext", &context)?,
            "Stored usage context is invalid."
        );
        Ok(self.context_resource(&context))
    }
    fn context_resource(&self, context: &Value) -> Value {
        if context.is_null() {
            return Value::Null;
        }
        json!({"approximate":context["approximate"],"contextTokens":context["contextTokens"],"providerId":context["provider"],"modelId":context.get("model").cloned().unwrap_or(Value::Null),"contextWindow":context["model"].as_str().and_then(|model|self.config.context_window(model))})
    }
}
fn tokens_value(tokens: [i64; 4]) -> Value {
    json!({"input":tokens[0],"output":tokens[1],"cacheRead":tokens[2],"cacheWrite":tokens[3]})
}
