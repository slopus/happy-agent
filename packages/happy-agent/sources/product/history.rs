use super::{
    events::EventsModule,
    identity::now,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
    usage::UsageModule,
};
use anyhow::{Context as _, Result};
use happy_providers::Block;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::sync::Arc;
mod read_tool;

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001-history-records",
        "CREATE TABLE IF NOT EXISTS happy_agent_module_history(agent_id TEXT NOT NULL,position BIGINT NOT NULL,record_id TEXT NOT NULL,role TEXT NOT NULL,message_json TEXT NOT NULL,search_text TEXT NOT NULL,assistant_messages BIGINT NOT NULL,user_messages BIGINT NOT NULL,text_characters BIGINT NOT NULL,thinking_blocks BIGINT NOT NULL,tool_calls BIGINT NOT NULL,tool_results BIGINT NOT NULL,PRIMARY KEY(agent_id,position),UNIQUE(agent_id,record_id));",
    ),
    (
        "002-history-runs-and-pending",
        "ALTER TABLE happy_agent_module_history ADD COLUMN run_id TEXT;CREATE INDEX IF NOT EXISTS happy_agent_module_history_run_position ON happy_agent_module_history(agent_id,run_id,position);CREATE TABLE IF NOT EXISTS happy_agent_module_history_runs(agent_id TEXT NOT NULL,sequence BIGINT NOT NULL,run_id TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,started_at BIGINT NOT NULL,ended_at BIGINT,PRIMARY KEY(agent_id,sequence),UNIQUE(agent_id,run_id));CREATE TABLE IF NOT EXISTS happy_agent_module_history_pending(agent_id TEXT NOT NULL,position BIGINT NOT NULL,message_id TEXT NOT NULL,message_json TEXT NOT NULL,PRIMARY KEY(agent_id,position),UNIQUE(agent_id,message_id));",
    ),
    (
        "003-history-tool-call-index",
        "CREATE TABLE IF NOT EXISTS happy_agent_module_history_tool_calls(agent_id TEXT NOT NULL,call_id TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(agent_id,call_id));INSERT INTO happy_agent_module_history_tool_calls(agent_id,call_id,record_id) SELECT history.agent_id,json_extract(block.value,'$.callId'),history.record_id FROM happy_agent_module_history AS history,json_each(history.message_json,'$.blocks') AS block WHERE json_extract(block.value,'$.type')='tool_call';",
    ),
];

pub struct HistoryModule {
    runtime: Arc<RuntimeModule>,
    events: Arc<EventsModule>,
    schemas: Schemas,
    usage: Arc<UsageModule>,
}
impl HistoryModule {
    pub fn new(
        runtime: Arc<RuntimeModule>,
        events: Arc<EventsModule>,
        usage: Arc<UsageModule>,
    ) -> Result<Self> {
        Ok(Self {
            runtime,
            events,
            usage,
            schemas: Schemas::new()?,
        })
    }
    pub async fn load(&self) -> Result<()> {
        self.runtime.migrate("history", MIGRATIONS).await
    }
    pub fn append(&self, ctx: &Context<'_>, agent: &str, message: &Value) -> Result<()> {
        self.append_inner(ctx, agent, message, true)
    }
    pub fn accept(&self, ctx: &Context<'_>, agent: &str, message: &Value) -> Result<()> {
        self.append_inner(ctx, agent, message, false)?;
        ctx.database().execute(
            "DELETE FROM happy_agent_module_history_pending WHERE agent_id=?1 AND message_id=?2",
            params![agent, message["recordId"].as_str()],
        )?;
        Ok(())
    }
    fn append_inner(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        message: &Value,
        publish: bool,
    ) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid("historyMessage", message)?,
            "A durable history message is invalid."
        );
        let encoded = message.to_string();
        anyhow::ensure!(
            encoded.len() <= 64 * 1024 * 1024,
            "The history message exceeds its allowed byte size."
        );
        let blocks = message["blocks"]
            .as_array()
            .context("The history message has no blocks.")?;
        let role = message["role"]
            .as_str()
            .context("The history message has no role.")?;
        let position: i64 = ctx.database().query_row(
            "SELECT coalesce(max(position),-1)+1 FROM happy_agent_module_history WHERE agent_id=?1",
            [agent],
            |row| row.get(0),
        )?;
        let stats = stats(role, blocks);
        ctx.database().execute("INSERT INTO happy_agent_module_history(agent_id,position,record_id,run_id,role,message_json,search_text,assistant_messages,user_messages,text_characters,thinking_blocks,tool_calls,tool_results) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![agent,position,message["recordId"].as_str(),message["runId"].as_str(),role,encoded,search(blocks),stats.0,stats.1,stats.2,stats.3,stats.4,stats.5])?;
        for block in blocks.iter().filter(|block| block["type"] == "tool_call") {
            ctx.database().execute("INSERT INTO happy_agent_module_history_tool_calls(agent_id,call_id,record_id) VALUES(?1,?2,?3)",params![agent,block["callId"].as_str(),message["recordId"].as_str()])?;
        }
        if publish {
            self.events.record_history_message(
                ctx,
                agent,
                "message.created",
                message["runId"].clone(),
                self.message_resource(message, false),
            )?;
        }
        Ok(())
    }
    pub fn begin_run(&self, ctx: &Context<'_>, agent: &str, id: &str, at: u64) -> Result<()> {
        ctx.database().execute("INSERT INTO happy_agent_module_history_runs(agent_id,sequence,run_id,status,reason,started_at,ended_at) SELECT ?1,coalesce(max(sequence),-1)+1,?2,'running',NULL,?3,NULL FROM happy_agent_module_history_runs WHERE agent_id=?1",params![agent,id,i64::try_from(at)?])?;
        Ok(())
    }
    pub fn pending(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<Option<Value>> {
        let value:Option<String>=ctx.database().query_row("SELECT message_json FROM happy_agent_module_history_pending WHERE agent_id=?1 AND message_id=?2",params![agent,id],|row|row.get(0)).optional()?;
        value
            .map(|value| {
                let value: Value = serde_json::from_str(&value)?;
                anyhow::ensure!(
                    self.schemas.valid("historyPending", &value)?,
                    "A durable pending message is invalid."
                );
                Ok(value)
            })
            .transpose()
    }
    pub fn queue(&self, ctx: &Context<'_>, agent: &str, pending: &Value) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid("historyPending", pending)?,
            "The pending history message is invalid."
        );
        let count: i64 = ctx.database().query_row(
            "SELECT count(*) FROM happy_agent_module_history_pending WHERE agent_id=?1",
            [agent],
            |row| row.get(0),
        )?;
        anyhow::ensure!(count < 512, "The pending history queue is full.");
        anyhow::ensure!(
            pending.to_string().len() <= 64 * 1024 * 1024,
            "The pending message exceeds its durable byte limit."
        );
        ctx.database().execute("INSERT INTO happy_agent_module_history_pending(agent_id,position,message_id,message_json) SELECT ?1,coalesce(max(position),-1)+1,?2,?3 FROM happy_agent_module_history_pending WHERE agent_id=?1",params![agent,pending["id"].as_str(),pending.to_string()])?;
        Ok(())
    }
    pub fn pending_resource(&self, pending: &Value) -> Value {
        let mut message = pending.clone();
        message["recordId"] = pending["id"].clone();
        message["at"] = pending["createdAt"].clone();
        let mut resource = self.message_resource(&message, false);
        resource["status"] = json!("pending");
        resource
    }
    pub fn provider_block(&self, block: &Block, id: Option<&str>) -> Result<Option<Value>> {
        Ok(match block {
            Block::Text { text } => Some(json!({"type":"text","text":text})),
            Block::Reasoning {
                text: Some(text), ..
            } => Some(json!({"type":"thinking","thinking":text})),
            Block::Image { data, mime_type } => {
                Some(json!({"type":"image","data":data,"mediaType":mime_type}))
            }
            Block::ToolCall {
                name, arguments, ..
            } => {
                let Some(id) = id else {
                    return Ok(None);
                };
                let parsed = serde_json::from_str::<Value>(arguments).ok();
                let arguments = match parsed {
                    Some(parsed)
                        if parsed.to_string().len() <= 1_000_000
                            && self.schemas.valid("historyToolArguments", &parsed)? =>
                    {
                        parsed
                    }
                    _ => json!(arguments),
                };
                Some(json!({"type":"tool_call","callId":id,"name":name,"arguments":arguments}))
            }
            _ => None,
        })
    }
    pub async fn validate_requested_arguments(
        self: &Arc<Self>,
        agent: &str,
        call: &str,
        raw: &str,
    ) -> Result<()> {
        let history = self.clone();
        let agent = agent.to_owned();
        let call = call.to_owned();
        let requested = self.runtime.transact(move |ctx| {
            let encoded: Option<String> = ctx.database().query_row("SELECT message_json FROM happy_agent_module_history WHERE agent_id=?1 AND record_id=(SELECT record_id FROM happy_agent_module_history_tool_calls WHERE agent_id=?1 AND call_id=?2)",params![agent,call],|row|row.get(0)).optional()?;
            let Some(encoded) = encoded else { return Ok(false); };
            let message: Value = serde_json::from_str(&encoded)?;
            anyhow::ensure!(history.schemas.valid("historyMessage", &message)?, "The tool's owning history message is invalid.");
            Ok(message["blocks"].as_array().into_iter().flatten().any(|block|block["type"]=="tool_call" && block["callId"]==call && block["requested"]==true))
        }).await?;
        if requested {
            let arguments: Value = serde_json::from_str(raw)?;
            anyhow::ensure!(
                arguments.to_string().len() <= 1_000_000
                    && self.schemas.valid("historyToolArguments", &arguments)?,
                "Tool arguments exceed the supported size or complexity limits."
            );
        }
        Ok(())
    }
    pub fn complete_tool(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        call: &str,
        name: &str,
        output: &str,
        is_error: bool,
    ) -> Result<()> {
        let encoded:String=ctx.database().query_row("SELECT message_json FROM happy_agent_module_history WHERE agent_id=?1 AND record_id=(SELECT record_id FROM happy_agent_module_history_tool_calls WHERE agent_id=?1 AND call_id=?2)",params![agent,call],|row|row.get(0)).context("The tool call has no owning history message.")?;
        let mut message: Value = serde_json::from_str(&encoded)?;
        anyhow::ensure!(
            self.schemas.valid("historyMessage", &message)?,
            "The owning history message is invalid."
        );
        let blocks = message["blocks"]
            .as_array_mut()
            .context("The history message has no blocks.")?;
        if blocks
            .iter()
            .any(|block| block["type"] == "tool_result" && block["callId"] == call)
        {
            return Ok(());
        }
        let output = bounded(output, 16000);
        let mut result = json!({"type":"tool_result","callId":call,"toolName":name,"output":output,"display":if is_error{"Command failed."}else{"Command completed."}});
        if is_error {
            result["isError"] = json!(true);
        }
        blocks.push(result);
        let counters = stats("assistant", blocks);
        anyhow::ensure!(
            self.schemas.valid("historyMessage", &message)?,
            "The completed tool history is invalid."
        );
        ctx.database().execute("UPDATE happy_agent_module_history SET message_json=?3,search_text=?4,text_characters=?5,thinking_blocks=?6,tool_calls=?7,tool_results=?8 WHERE agent_id=?1 AND record_id=?2",params![agent,message["recordId"].as_str(),message.to_string(),search(message["blocks"].as_array().context("The history blocks are missing.")?),counters.2,counters.3,counters.4,counters.5])?;
        self.events.record_history_message(
            ctx,
            agent,
            "message.updated",
            message["runId"].clone(),
            self.message_resource(&message, false),
        )?;
        Ok(())
    }
    pub fn finish_run(
        &self,
        ctx: &Context<'_>,
        agent: &str,
        run: &str,
        status: &str,
        reason: &str,
    ) -> Result<Value> {
        ctx.database().execute("UPDATE happy_agent_module_history_runs SET status=?3,reason=?4,ended_at=?5 WHERE agent_id=?1 AND run_id=?2 AND status='running'",params![agent,run,status,reason,i64::try_from(now())?])?;
        self.run(ctx, agent, run)
    }
    pub fn run(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<Value> {
        let mut run=ctx.database().query_row("SELECT run_id,status,reason,started_at,ended_at FROM happy_agent_module_history_runs WHERE agent_id=?1 AND run_id=?2",params![agent,id],|row|Ok(json!({"id":row.get::<_,String>(0)?,"status":row.get::<_,String>(1)?,"reason":row.get::<_,Option<String>>(2)?,"startedAt":row.get::<_,i64>(3)?,"endedAt":row.get::<_,Option<i64>>(4)?,"usage":{},"costUsd":null})))?;
        run["usage"] = self
            .usage
            .runs(ctx, agent, &[id.to_owned()])?
            .remove(id)
            .unwrap_or(json!({}));
        Ok(run)
    }
    pub async fn messages(
        self: &Arc<Self>,
        agent: String,
        before: Option<String>,
        after: Option<String>,
        limit: usize,
        omit: bool,
    ) -> Result<Value> {
        let history = self.clone();
        let cursor = self.events.cursor();
        self.runtime.transact(move|ctx|{
            let before_sequence=before.as_ref().map(|id|ctx.database().query_row("SELECT sequence FROM happy_agent_module_history_runs WHERE agent_id=?1 AND run_id=?2",params![agent,id],|row|row.get::<_,i64>(0))).transpose()?;
            let after_position=after.as_ref().map(|id|ctx.database().query_row("SELECT position FROM happy_agent_module_history WHERE agent_id=?1 AND record_id=?2",params![agent,id],|row|row.get::<_,i64>(0))).transpose()?;
            let mut statement=ctx.database().prepare("SELECT run.run_id,run.status,run.reason,run.started_at,run.ended_at,count(history.record_id) FROM happy_agent_module_history_runs AS run JOIN happy_agent_module_history AS history ON history.agent_id=run.agent_id AND history.run_id=run.run_id AND coalesce(json_extract(history.message_json,'$.hideFromUser'),0)=0 WHERE run.agent_id=?1 AND (?2 IS NULL OR run.sequence<?2) AND (?3 IS NULL OR history.position>?3) GROUP BY run.sequence ORDER BY run.sequence DESC LIMIT 501")?;
            let candidates=statement.query_map(params![agent,before_sequence,after_position],|row|Ok((json!({"id":row.get::<_,String>(0)?,"status":row.get::<_,String>(1)?,"reason":row.get::<_,Option<String>>(2)?,"startedAt":row.get::<_,i64>(3)?,"endedAt":row.get::<_,Option<i64>>(4)?,"usage":{},"costUsd":null}),row.get::<_,i64>(5)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut selected=Vec::new();let mut count=0;
            let mut has_more=false;
            for (run,messages) in candidates {
                let messages=usize::try_from(messages)?;
                if count>=limit || selected.len()>=500 {has_more=true;break;}
                anyhow::ensure!(messages<=5000,"A history run exceeds its message limit.");
                count+=messages;selected.push(run);
            }
            selected.reverse();
            let ids=selected.iter().map(|run|run["id"].clone()).collect::<Vec<_>>();
            let ids=ids.iter().map(|id|id.as_str().unwrap_or("").to_owned()).collect::<Vec<_>>();
            let mut usage=history.usage.runs(ctx,&agent,&ids)?;
            let ids=json!(ids).to_string();
            let mut rows=ctx.database().prepare("SELECT run_id,message_json FROM happy_agent_module_history WHERE agent_id=?1 AND run_id IN(SELECT value FROM json_each(?2)) AND (?3 IS NULL OR position>?3) AND coalesce(json_extract(message_json,'$.hideFromUser'),0)=0 ORDER BY position")?;
            let messages=rows.query_map(params![agent,ids,after_position],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut groups=std::collections::BTreeMap::<String,Vec<Value>>::new();
            for (run,encoded) in messages {
                let message:Value=serde_json::from_str(&encoded)?;
                anyhow::ensure!(history.schemas.valid("historyMessage",&message)?,"A durable history message is invalid.");
                groups.entry(run).or_default().push(history.message_resource(&message,omit));
            }
            for run in &mut selected {let id=run["id"].as_str().unwrap_or("").to_owned();run["messages"]=json!(groups.remove(&id).unwrap_or_default());run["usage"]=usage.remove(&id).unwrap_or(json!({}));}
            Ok(json!({"runs":selected,"hasMore":has_more,"cursor":cursor}))
        }).await
    }
    pub fn message_resource(&self, message: &Value, omit: bool) -> Value {
        let role = message["role"].as_str().unwrap_or("system");
        let mut content = Vec::new();
        let blocks = message["blocks"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        for block in blocks {
            match block["type"].as_str() {
                Some("tool_result")=>{},
                Some("thinking")=>content.push(json!({"type":"reasoning","text":block["thinking"]})),
                Some("image")=>content.push(json!({"type":"image","mimeType":block["mediaType"],"data":block.get("data").cloned().unwrap_or(json!(""))})),
                Some("tool_call")=>{
                    let result=blocks.iter().find(|result|result["type"]=="tool_result" && result["callId"]==block["callId"]);
                    let mut call=json!({"type":"tool_call","id":block["callId"],"name":block["name"],"arguments":block.get("arguments").cloned().unwrap_or(json!({})),"status":if result.is_some_and(|result|result["isError"]==true){"failed"}else if result.is_some(){"completed"}else{"running"}});
                    if let Some(result)=result {call["result"]=json!({"output":result.get("output").cloned().unwrap_or(json!(""))});}
                    if block["name"]=="exec_command" && let Some(result)=result {
                        call["presentation"]=json!({"type":"exec_command","command":block["arguments"]["cmd"],"output":result.get("output").cloned().unwrap_or(json!(""))});
                        if omit {call.as_object_mut().expect("tool resource").remove("arguments");call.as_object_mut().expect("tool resource").remove("result");}
                    }
                    for field in ["elevated","review","spawnPresentation"] {if let Some(value)=block.get(field){call[field]=value.clone();}}
                    content.push(call);
                },
                _=>content.push(block.clone()),
            }
        }
        let mut metadata = json!({});
        for (source, target) in [
            ("provider", "providerId"),
            ("model", "modelId"),
            ("senderAgentId", "senderAgentId"),
        ] {
            if let Some(value) = message.get(source) {
                metadata[target] = value.clone();
            }
        }
        if role == "user"
            && let Some(value) = message.get("userId")
        {
            metadata["userId"] = value.clone();
        }
        let mut result = json!({"id":message["recordId"],"role":if role=="assistant"||role=="agent"{"agent"}else if role=="error"{"service"}else{role},"createdAt":message.get("at").cloned().unwrap_or(json!(0)),"content":content,"metadata":metadata});
        if role == "user" {
            result["status"] = json!("accepted");
            result["delivery"] = message.get("delivery").cloned().unwrap_or(json!("queue"));
            result["mode"] = message.get("mode").cloned().unwrap_or(Value::Null);
            result["profile"] = Value::Null;
            result["runId"] = message.get("runId").cloned().unwrap_or(Value::Null);
            if let Some(value) = message.get("clientMetadata") {
                result["clientMetadata"] = value.clone();
            }
        }
        result
    }
    pub fn existing(&self, ctx: &Context<'_>, agent: &str, id: &str) -> Result<Option<Value>> {
        let value:Option<String>=ctx.database().query_row("SELECT message_json FROM happy_agent_module_history WHERE agent_id=?1 AND record_id=?2",params![agent,id],|row|row.get(0)).optional()?;
        value
            .map(|value| {
                let value: Value = serde_json::from_str(&value)?;
                anyhow::ensure!(
                    self.schemas.valid("historyMessage", &value)?,
                    "The durable message is invalid."
                );
                Ok(value)
            })
            .transpose()
    }
}

fn bounded(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
fn search(blocks: &[Value]) -> String {
    let mut parts = Vec::new();
    for block in blocks {
        match block["type"].as_str() {
            Some("text") => parts.push(block["text"].as_str().unwrap_or("").to_owned()),
            Some("thinking") => parts.push(block["thinking"].as_str().unwrap_or("").to_owned()),
            Some("image") => parts.push(block["mediaType"].as_str().unwrap_or("").to_owned()),
            Some("tool_call" | "tool_call_request") => {
                parts.push(block["name"].as_str().unwrap_or("").to_owned());
                parts.push(block.get("arguments").unwrap_or(&Value::Null).to_string());
            }
            Some("tool_result") => {
                for field in ["toolName", "display", "output"] {
                    parts.push(block[field].as_str().unwrap_or("").to_owned());
                }
            }
            _ => {
                parts.push("compaction".into());
                for field in ["trigger", "status", "failureReason"] {
                    parts.push(block[field].as_str().unwrap_or("").to_owned());
                }
            }
        }
    }
    parts.join("\n").replace('\0', "").to_lowercase()
}
fn stats(role: &str, blocks: &[Value]) -> (i64, i64, i64, i64, i64, i64) {
    (
        i64::from(role == "assistant"),
        i64::from(role == "user"),
        blocks
            .iter()
            .filter_map(|block| {
                block["text"]
                    .as_str()
                    .or_else(|| block["thinking"].as_str())
            })
            .map(|text| text.encode_utf16().count() as i64)
            .sum(),
        blocks
            .iter()
            .filter(|block| block["type"] == "thinking")
            .count() as i64,
        blocks
            .iter()
            .filter(|block| block["type"] == "tool_call")
            .count() as i64,
        blocks
            .iter()
            .filter(|block| block["type"] == "tool_result")
            .count() as i64,
    )
}
