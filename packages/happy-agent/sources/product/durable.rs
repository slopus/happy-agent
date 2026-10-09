use super::{
    identity::now,
    lifecycle::LifecycleModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use futures_util::future::BoxFuture;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const MIGRATIONS: &[(&str, &str)] = &[(
    "001-durable-functions",
    "CREATE TABLE IF NOT EXISTS durable_function_calls(id TEXT PRIMARY KEY,operation_id TEXT UNIQUE,\"function\" TEXT NOT NULL,arguments_json TEXT NOT NULL,lock_keys_json TEXT NOT NULL,created_at BIGINT NOT NULL);CREATE INDEX IF NOT EXISTS durable_function_calls_created ON durable_function_calls(created_at,id);CREATE TABLE IF NOT EXISTS durable_function_kv(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);",
)];
const MAX_PENDING: usize = 10_000;
const MAX_BYTES: usize = 64 * 1024 * 1024;

/// Native function bodies belong to the module that registers them. This seam
/// carries only this module's public call/KV types, never application host handles.
pub trait DurableFunction: Send + Sync {
    fn execute(
        self: Arc<Self>,
        call: Value,
        kv: CallKv,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value>>;
    fn success(&self, _ctx: &Context<'_>, _call: &Value, _result: &Value) -> Result<()> {
        Ok(())
    }
}
pub struct Registration {
    pub name: String,
    pub arguments_schema: &'static str,
    pub result_schema: &'static str,
    pub function: Arc<dyn DurableFunction>,
}
pub struct DurableFunctionsModule {
    runtime: Arc<RuntimeModule>,
    schemas: Schemas,
    definitions: Mutex<BTreeMap<String, Arc<Registration>>>,
    state: Mutex<Dispatch>,
    closed: AtomicBool,
    lifecycle: Arc<LifecycleModule>,
}
#[derive(Default)]
struct Dispatch {
    waiting: BTreeMap<String, Value>,
    running: BTreeMap<String, Running>,
    held: BTreeSet<String>,
    started: bool,
    stopped: bool,
}
struct Running {
    call: Value,
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}
#[derive(Clone)]
pub struct CallKv {
    module: Arc<DurableFunctionsModule>,
    prefix: String,
    cancel: CancellationToken,
}

impl DurableFunctionsModule {
    pub fn new(runtime: Arc<RuntimeModule>, lifecycle: Arc<LifecycleModule>) -> Result<Self> {
        Ok(Self {
            runtime,
            lifecycle,
            schemas: Schemas::new()?,
            definitions: Mutex::new(BTreeMap::new()),
            state: Mutex::new(Dispatch::default()),
            closed: AtomicBool::new(false),
        })
    }
    pub fn register(&self, registration: Registration) -> Result<()> {
        let mut definitions = self
            .definitions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            !self.closed.load(Ordering::Acquire),
            "Durable function registration is closed after system startup."
        );
        anyhow::ensure!(
            self.schemas
                .valid("durableName", &json!(registration.name))?,
            "The durable function name is invalid."
        );
        anyhow::ensure!(
            !definitions.contains_key(&registration.name),
            "The durable function is already registered."
        );
        let _ = self
            .schemas
            .valid(registration.arguments_schema, &Value::Null)?;
        let _ = self
            .schemas
            .valid(registration.result_schema, &Value::Null)?;
        definitions.insert(registration.name.clone(), Arc::new(registration));
        Ok(())
    }
    fn definition(&self, name: &str) -> Option<Arc<Registration>> {
        self.definitions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(name)
            .cloned()
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime.migrate("durableFunctions", MIGRATIONS).await
    }
    /// Called at the system's after-start barrier, after every owner registered.
    pub async fn start(self: &Arc<Self>) -> Result<()> {
        {
            let _definitions = self
                .definitions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.closed.store(true, Ordering::Release);
        }
        let mut cursor = None;
        loop {
            let module = self.clone();
            let after = cursor.clone();
            let calls=self.runtime.transact(move|ctx|{
                let mut statement=ctx.database().prepare("SELECT id,operation_id,\"function\",arguments_json,lock_keys_json,created_at FROM durable_function_calls WHERE ?1 IS NULL OR created_at>?1 OR (created_at=?1 AND id>?2) ORDER BY created_at,id LIMIT 1000")?;
                let(after_at,after_id)=after.unwrap_or((0,String::new()));
                let rows=statement.query_map(params![cursor_timestamp(after_at,&after_id),after_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,u64>(5)?)))?;
                let mut calls=Vec::new();let mut bytes=0;
                for row in rows {let(id,operation,function,arguments,locks,created)=row?;bytes+=arguments.len()+locks.len();anyhow::ensure!(bytes<=MAX_BYTES,"Durable function recovery exceeds its bounded batch.");let mut call=json!({"id":id,"function":function,"arguments":serde_json::from_str::<Value>(&arguments)?,"lockKeys":serde_json::from_str::<Value>(&locks)?,"createdAt":created});if let Some(operation)=operation{call["operationId"]=json!(operation);}module.validate_call(&call)?;calls.push(call);}
                Ok(calls)
            }).await?;
            let last = calls.last().map(|call| {
                (
                    call["createdAt"].as_u64().unwrap_or(0),
                    call["id"].as_str().unwrap_or("").to_owned(),
                )
            });
            let count = calls.len();
            for call in calls {
                if self
                    .definition(call["function"].as_str().unwrap_or(""))
                    .is_some_and(|definition| {
                        self.schemas
                            .valid(definition.arguments_schema, &call["arguments"])
                            .unwrap_or(false)
                    })
                {
                    self.enqueue(call)?;
                } else {
                    let module = self.clone();
                    let id = call["id"].as_str().unwrap_or("").to_owned();
                    self.runtime
                        .transact(move |ctx| {
                            module.delete(ctx, &id)?;
                            Ok(())
                        })
                        .await?;
                }
            }
            if count < 1000 {
                break;
            }
            cursor = last;
        }
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.started = true;
        }
        self.dispatch();
        Ok(())
    }
    pub fn invoke(self: &Arc<Self>, ctx: &Context<'_>, input: &Value) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("durableInvoke", input)?,
            "The durable function invocation is invalid."
        );
        let definition = self
            .definition(input["function"].as_str().unwrap_or(""))
            .context("The durable function is not registered.")?;
        anyhow::ensure!(
            self.schemas
                .valid(definition.arguments_schema, &input["arguments"])?,
            "The durable function arguments are invalid."
        );
        anyhow::ensure!(
            input.to_string().len() <= MAX_BYTES,
            "The durable function invocation exceeds its storage bound."
        );
        let keys = input["lockKeys"].as_array().into_iter().flatten().fold(
            Vec::<Value>::new(),
            |mut keys, key| {
                if !keys.contains(key) {
                    keys.push(key.clone());
                }
                keys
            },
        );
        let mut call = json!({"id":cuid2::create_id(),"function":input["function"],"arguments":input["arguments"],"lockKeys":keys,"createdAt":now()});
        if let Some(operation) = input.get("operationId") {
            call["operationId"] = operation.clone();
        }
        self.validate_call(&call)?;
        if let Some(operation) = call["operationId"].as_str()
            && let Some(existing) = self.read_operation(ctx, operation)?
        {
            return Ok(json!({"callId":existing["id"],"status":"duplicate"}));
        }
        let(count,bytes):(usize,usize)=ctx.database().query_row("SELECT count(*),coalesce(sum(length(CAST(CASE WHEN operation_id IS NULL THEN json_object('id',id,'function',\"function\",'arguments',json(arguments_json),'lockKeys',json(lock_keys_json),'createdAt',created_at) ELSE json_object('id',id,'operationId',operation_id,'function',\"function\",'arguments',json(arguments_json),'lockKeys',json(lock_keys_json),'createdAt',created_at) END AS BLOB))),0) FROM durable_function_calls",[],|row|Ok((row.get(0)?,row.get(1)?)))?;
        anyhow::ensure!(
            count < MAX_PENDING && bytes + call.to_string().len() <= MAX_BYTES,
            "Durable function calls exceed their storage bound."
        );
        let inserted=ctx.database().execute("INSERT INTO durable_function_calls(id,operation_id,\"function\",arguments_json,lock_keys_json,created_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(operation_id) DO NOTHING",params![call["id"].as_str(),call["operationId"].as_str(),call["function"].as_str(),call["arguments"].to_string(),call["lockKeys"].to_string(),call["createdAt"].as_u64()])?;
        let result = if inserted == 1 {
            let module = self.clone();
            let pending = call.clone();
            ctx.after_commit(move || {
                if let Err(error) = module.enqueue(pending) {
                    eprintln!("Durable function dispatch remains owed: {error:#}");
                }
            })?;
            json!({"callId":call["id"],"status":"created"})
        } else {
            let existing = self
                .read_operation(
                    ctx,
                    call["operationId"]
                        .as_str()
                        .context("The durable operation identity is missing.")?,
                )?
                .context("The duplicate durable operation has no pending call.")?;
            json!({"callId":existing["id"],"status":"duplicate"})
        };
        anyhow::ensure!(
            self.schemas.valid("durableInvokeResult", &result)?,
            "The durable invoke result is invalid."
        );
        Ok(result)
    }
    pub fn cancel(self: &Arc<Self>, ctx: &Context<'_>, operation: &str) -> Result<bool> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas
                .valid("durableOperationId", &json!(operation))?,
            "The durable function operation ID is invalid."
        );
        let Some(call) = self.read_operation(ctx, operation)? else {
            return Ok(false);
        };
        let id = call["id"]
            .as_str()
            .context("The durable call identity is missing.")?
            .to_owned();
        if !self.delete(ctx, &id)? {
            return Ok(false);
        }
        let module = self.clone();
        ctx.after_commit(move || {
            let mut state = module
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.waiting.remove(&id);
            if let Some(running) = state.running.get(&id) {
                running.cancel.cancel();
            }
            drop(state);
            module.dispatch();
        })?;
        Ok(true)
    }
    fn read_operation(&self, ctx: &Context<'_>, operation: &str) -> Result<Option<Value>> {
        let id: Option<String> = ctx
            .database()
            .query_row(
                "SELECT id FROM durable_function_calls WHERE operation_id=?1",
                [operation],
                |row| row.get(0),
            )
            .optional()?;
        id.map(|id| self.read(ctx, &id))
            .transpose()
            .map(Option::flatten)
    }
    fn read(&self, ctx: &Context<'_>, id: &str) -> Result<Option<Value>> {
        let row:Option<(Option<String>,String,String,String,u64)>=ctx.database().query_row("SELECT operation_id,\"function\",arguments_json,lock_keys_json,created_at FROM durable_function_calls WHERE id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional()?;
        row.map(|(operation,function,arguments,locks,created)|{anyhow::ensure!(arguments.len()+locks.len()<=MAX_BYTES,"The durable pending call exceeds its bound.");let mut call=json!({"id":id,"function":function,"arguments":serde_json::from_str::<Value>(&arguments)?,"lockKeys":serde_json::from_str::<Value>(&locks)?,"createdAt":created});if let Some(operation)=operation{call["operationId"]=json!(operation);}self.validate_call(&call)?;Ok(call)}).transpose()
    }
    fn validate_call(&self, call: &Value) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid("durableCall", call)?,
            "A durable pending call is invalid."
        );
        Ok(())
    }
    fn delete(&self, ctx: &Context<'_>, id: &str) -> Result<bool> {
        self.runtime.assert_context(ctx)?;
        if self.read(ctx, id)?.is_none() {
            return Ok(false);
        }
        let prefix = format!("call.{id}.");
        ctx.database().execute(
            "DELETE FROM durable_function_kv WHERE substr(key,1,length(?1))=?1",
            [prefix],
        )?;
        ctx.database()
            .execute("DELETE FROM durable_function_calls WHERE id=?1", [id])?;
        Ok(true)
    }
    fn enqueue(self: &Arc<Self>, call: Value) -> Result<()> {
        self.validate_call(&call)?;
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let id = call["id"]
                .as_str()
                .context("The durable call identity is missing.")?;
            if state.stopped || state.running.contains_key(id) || state.waiting.contains_key(id) {
                return Ok(());
            }
            let bytes: usize = state
                .waiting
                .values()
                .chain(state.running.values().map(|running| &running.call))
                .map(|call| call.to_string().len())
                .sum();
            anyhow::ensure!(
                state.waiting.len() + state.running.len() < MAX_PENDING
                    && bytes + call.to_string().len() <= MAX_BYTES,
                "Durable dispatch exceeds its retention bound."
            );
            state.waiting.insert(id.to_owned(), call);
        }
        self.dispatch();
        Ok(())
    }
    fn dispatch(self: &Arc<Self>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !state.started || state.stopped {
            return;
        }
        let mut waiting: Vec<_> = state.waiting.values().cloned().collect();
        waiting.sort_by(|left, right| {
            left["createdAt"]
                .as_u64()
                .cmp(&right["createdAt"].as_u64())
                .then_with(|| left["id"].as_str().cmp(&right["id"].as_str()))
        });
        let mut blocked = BTreeSet::new();
        for call in waiting {
            let keys = lock_keys(&call);
            if keys
                .iter()
                .any(|key| state.held.contains(key) || blocked.contains(key))
            {
                blocked.extend(keys);
                continue;
            }
            let id = call["id"].as_str().unwrap_or("").to_owned();
            state.waiting.remove(&id);
            state.held.extend(keys);
            let cancel = self.lifecycle.shutdown.child_token();
            state.running.insert(
                id.clone(),
                Running {
                    call: call.clone(),
                    cancel: cancel.clone(),
                    task: None,
                },
            );
            let module = self.clone();
            let task = tokio::spawn(async move {
                module.run(call, cancel).await;
            });
            state
                .running
                .get_mut(&id)
                .expect("the just-selected durable call")
                .task = Some(task);
        }
    }
    async fn run(self: Arc<Self>, call: Value, cancel: CancellationToken) {
        let id = call["id"].as_str().unwrap_or("").to_owned();
        if !cancel.is_cancelled()
            && let Some(definition) = self.definition(call["function"].as_str().unwrap_or(""))
        {
            let kv = CallKv {
                module: self.clone(),
                prefix: format!("call.{id}."),
                cancel: cancel.clone(),
            };
            let result = definition
                .function
                .clone()
                .execute(call.clone(), kv, cancel.clone())
                .await;
            if !cancel.is_cancelled() {
                let result = result.and_then(|result| {
                    anyhow::ensure!(
                        self.schemas.valid(definition.result_schema, &result)?,
                        "The durable function result is invalid."
                    );
                    Ok(result)
                });
                let module = self.clone();
                let owned = call.clone();
                let settled=self.runtime.transact(move|ctx|{
                    let Some(pending)=module.read(ctx,owned["id"].as_str().unwrap_or(""))? else{return Ok(());};
                    anyhow::ensure!(pending["function"]==owned["function"],"A pending durable call changed function while it was running.");
                    if !module.delete(ctx,owned["id"].as_str().unwrap_or(""))? {return Ok(());}
                    match result {
                        Ok(result)=>definition.function.success(ctx,&owned,&result),
                        Err(error)=>{eprintln!("A durable function failed and was removed without retry: {error:#}");Ok(())}
                    }
                }).await;
                if let Err(error) = settled {
                    eprintln!("Durable completion remains owed: {error:#}");
                }
            }
        }
        cancel.cancel();
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(running) = state.running.remove(&id) {
                for key in lock_keys(&running.call) {
                    state.held.remove(&key);
                }
            }
        }
        self.dispatch();
    }
    pub async fn stop(&self) {
        let tasks = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.stopped = true;
            state.waiting.clear();
            state
                .running
                .values_mut()
                .filter_map(|running| {
                    running.cancel.cancel();
                    running.task.take()
                })
                .collect::<Vec<_>>()
        };
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        for mut task in tasks {
            if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
                task.abort();
                let _ = task.await;
            }
        }
    }
}
impl CallKv {
    fn check(&self, ctx: &Context<'_>) -> Result<()> {
        self.module.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            !self.cancel.is_cancelled(),
            "The durable function was stopped."
        );
        Ok(())
    }
    pub fn read(&self, ctx: &Context<'_>, key: &str) -> Result<Option<Value>> {
        self.check(ctx)?;
        let value: Option<String> = ctx
            .database()
            .query_row(
                "SELECT value_json FROM durable_function_kv WHERE key=?1",
                [format!("{}{key}", self.prefix)],
                |row| row.get(0),
            )
            .optional()?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }
    pub fn write(&self, ctx: &Context<'_>, key: &str, value: &Value) -> Result<()> {
        self.check(ctx)?;
        let value = value.to_string();
        anyhow::ensure!(
            value.len() <= MAX_BYTES,
            "Durable function state exceeds its storage bound."
        );
        let full_key = format!("{}{key}", self.prefix);
        let(count,total,previous):(usize,usize,usize)=ctx.database().query_row("SELECT count(*),coalesce(sum(length(CAST(key AS BLOB))+length(CAST(value_json AS BLOB))),0),coalesce(sum(CASE WHEN key=?1 THEN length(CAST(key AS BLOB))+length(CAST(value_json AS BLOB)) ELSE 0 END),0) FROM durable_function_kv",[&full_key],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
        anyhow::ensure!(
            (previous > 0 || count < MAX_PENDING)
                && total.saturating_sub(previous) + full_key.len() + value.len() <= MAX_BYTES,
            "Durable function state exceeds its retention bound."
        );
        ctx.database().execute("INSERT INTO durable_function_kv(key,value_json) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",params![full_key,value])?;
        Ok(())
    }
    pub async fn transact<T: Send + 'static>(
        &self,
        work: impl for<'a> FnOnce(&Context<'a>, &CallKv) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let kv = self.clone();
        self.module
            .runtime
            .transact(move |ctx| work(ctx, &kv))
            .await
    }
}
fn cursor_timestamp(timestamp: u64, id: &str) -> Option<u64> {
    (!id.is_empty()).then_some(timestamp)
}
fn lock_keys(call: &Value) -> BTreeSet<String> {
    call["lockKeys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::{config::ConfigModule, lifecycle::LifecycleModule};
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::{Notify, mpsc};

    struct Fixture {
        _directory: tempfile::TempDir,
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        lifecycle: Arc<LifecycleModule>,
        module: Arc<DurableFunctionsModule>,
    }
    impl Fixture {
        async fn new() -> Self {
            let directory = tempfile::tempdir().expect("isolated durable installation");
            let config = Arc::new(
                ConfigModule::isolated(&directory.path().join(".happy")).expect("configuration"),
            );
            let (runtime, lifecycle, module) = Self::open(config.clone()).await;
            Self {
                _directory: directory,
                config,
                runtime,
                lifecycle,
                module,
            }
        }
        async fn open(
            config: Arc<ConfigModule>,
        ) -> (
            Arc<RuntimeModule>,
            Arc<LifecycleModule>,
            Arc<DurableFunctionsModule>,
        ) {
            let lifecycle = Arc::new(LifecycleModule::new(config.clone()).expect("root lifetime"));
            let runtime = Arc::new(RuntimeModule::new(config));
            runtime.load().await.expect("database ownership");
            let module = Arc::new(
                DurableFunctionsModule::new(runtime.clone(), lifecycle.clone())
                    .expect("durable module"),
            );
            module.load().await.expect("immutable migration");
            (runtime, lifecycle, module)
        }
        async fn close(&self) {
            self.lifecycle.begin_shutdown();
            self.module.stop().await;
            self.runtime.close().await.expect("close owned database");
        }
        async fn restart(&mut self) {
            self.close().await;
            let (runtime, lifecycle, module) = Self::open(self.config.clone()).await;
            self.runtime = runtime;
            self.lifecycle = lifecycle;
            self.module = module;
        }
    }
    struct Procedure {
        executions: AtomicUsize,
        handlers: AtomicUsize,
        fail_handler: AtomicBool,
        fail_executor: AtomicBool,
        started: mpsc::Sender<u64>,
        releases: BTreeMap<u64, Arc<Notify>>,
    }
    impl DurableFunction for Procedure {
        fn execute(
            self: Arc<Self>,
            call: Value,
            kv: CallKv,
            cancel: CancellationToken,
        ) -> BoxFuture<'static, Result<Value>> {
            Box::pin(async move {
                let argument = call["arguments"].as_u64().expect("validated argument");
                let procedure = self.clone();
                kv.transact(move |ctx, kv| {
                    if kv.read(ctx, "checkpoint")?.is_none() {
                        kv.write(ctx, "checkpoint", &json!(argument))?;
                        procedure.executions.fetch_add(1, Ordering::SeqCst);
                    }
                    Ok(())
                })
                .await?;
                self.started
                    .send(argument)
                    .await
                    .expect("observable execution");
                if let Some(release) = self.releases.get(&argument) {
                    tokio::select! {_=release.notified()=>{},_=cancel.cancelled()=>anyhow::bail!("The fixture execution was stopped.")};
                }
                anyhow::ensure!(
                    !self.fail_executor.load(Ordering::SeqCst),
                    "The fixture executor failed."
                );
                Ok(json!(argument))
            })
        }
        fn success(&self, ctx: &Context<'_>, call: &Value, result: &Value) -> Result<()> {
            self.handlers.fetch_add(1, Ordering::SeqCst);
            ctx.database().execute(
                "INSERT INTO durable_fixture_completion(id,result) VALUES(?1,?2)",
                params![call["id"].as_str(), result.to_string()],
            )?;
            anyhow::ensure!(
                !self.fail_handler.swap(false, Ordering::SeqCst),
                "The fixture completion rolled back."
            );
            Ok(())
        }
    }
    async fn register(
        fixture: &Fixture,
        releases: BTreeMap<u64, Arc<Notify>>,
        fail_handler: bool,
        fail_executor: bool,
    ) -> (Arc<Procedure>, mpsc::Receiver<u64>) {
        let (sender, receiver) = mpsc::channel(10);
        let procedure = Arc::new(Procedure {
            executions: AtomicUsize::new(0),
            handlers: AtomicUsize::new(0),
            fail_handler: AtomicBool::new(fail_handler),
            fail_executor: AtomicBool::new(fail_executor),
            started: sender,
            releases,
        });
        fixture
            .module
            .register(Registration {
                name: "fixture.procedure".into(),
                arguments_schema: "historyExcerptBudget",
                result_schema: "historyExcerptBudget",
                function: procedure.clone(),
            })
            .expect("registered function");
        fixture.runtime.transact(|ctx|{ctx.database().execute_batch("CREATE TABLE IF NOT EXISTS durable_fixture_completion(id TEXT PRIMARY KEY,result TEXT NOT NULL)")?;Ok(())}).await.expect("fixture completion table");
        (procedure, receiver)
    }
    async fn observed(receiver: &mut mpsc::Receiver<u64>) -> u64 {
        tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
            .await
            .expect("execution began")
            .expect("execution event")
    }
    async fn wait_rows(fixture: &Fixture, expected: usize) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let count = fixture
                    .runtime
                    .transact(|ctx| {
                        Ok(ctx.database().query_row(
                            "SELECT count(*) FROM durable_function_calls",
                            [],
                            |row| row.get::<_, usize>(0),
                        )?)
                    })
                    .await
                    .expect("pending count");
                if count == expected {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("observable durable settlement");
    }

    #[tokio::test]
    async fn committing_transaction_starts_once_and_rollback_and_cancellation_have_no_handler() {
        let fixture = Fixture::new().await;
        let release = Arc::new(Notify::new());
        let (procedure, mut started) = register(
            &fixture,
            BTreeMap::from([(1, release.clone())]),
            false,
            false,
        )
        .await;
        fixture.module.start().await.expect("after-start barrier");
        let module = fixture.module.clone();
        let result:Result<()>=fixture.runtime.transact(move|ctx|{module.invoke(ctx,&json!({"function":"fixture.procedure","arguments":1,"operationId":"rolled-back"}))?;anyhow::bail!("Deliberate caller rollback.")}).await;
        assert!(result.is_err());
        wait_rows(&fixture, 0).await;
        assert_eq!(procedure.executions.load(Ordering::SeqCst), 0);
        let module = fixture.module.clone();
        let observed_procedure = procedure.clone();
        let result=fixture.runtime.transact(move|ctx|{let input=json!({"function":"fixture.procedure","arguments":1,"operationId":"one-operation","lockKeys":["same","same"]});let result=module.invoke(ctx,&input)?;let duplicate=module.invoke(ctx,&input)?;assert_eq!(result["callId"],duplicate["callId"]);assert_eq!(duplicate["status"],"duplicate");assert_eq!(observed_procedure.executions.load(Ordering::SeqCst),0,"execution begins after the outer commit");Ok(result)}).await.expect("one committed call");
        assert_eq!(result["status"], "created");
        assert_eq!(observed(&mut started).await, 1);
        let module = fixture.module.clone();
        let rolled_back: Result<()> = fixture
            .runtime
            .transact(move |ctx| {
                assert!(module.cancel(ctx, "one-operation")?);
                anyhow::bail!("Deliberate cancellation rollback.")
            })
            .await;
        assert!(rolled_back.is_err());
        wait_rows(&fixture, 1).await;
        let module = fixture.module.clone();
        assert!(
            fixture
                .runtime
                .transact(move |ctx| module.cancel(ctx, "one-operation"))
                .await
                .expect("committed cancellation")
        );
        wait_rows(&fixture, 0).await;
        release.notify_one();
        fixture.close().await;
        assert_eq!(procedure.executions.load(Ordering::SeqCst), 1);
        assert_eq!(procedure.handlers.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn failed_completion_rolls_back_its_deletion_and_restart_reuses_call_state() {
        let mut fixture = Fixture::new().await;
        let (procedure, mut started) = register(&fixture, BTreeMap::new(), true, false).await;
        fixture.module.start().await.expect("after-start");
        let module = fixture.module.clone();
        let result=fixture.runtime.transact(move|ctx|module.invoke(ctx,&json!({"function":"fixture.procedure","arguments":1,"operationId":"restart-checkpoint"}))).await.expect("invoke");
        assert_eq!(observed(&mut started).await, 1);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if fixture.module.state.lock().unwrap().running.is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("failed completion finished without retry");
        fixture
            .runtime
            .transact(|ctx| {
                assert_eq!(
                    ctx.database().query_row(
                        "SELECT count(*) FROM durable_function_calls",
                        [],
                        |row| row.get::<_, usize>(0)
                    )?,
                    1
                );
                assert_eq!(
                    ctx.database().query_row(
                        "SELECT count(*) FROM durable_function_kv",
                        [],
                        |row| row.get::<_, usize>(0)
                    )?,
                    1
                );
                assert_eq!(
                    ctx.database().query_row(
                        "SELECT count(*) FROM durable_fixture_completion",
                        [],
                        |row| row.get::<_, usize>(0)
                    )?,
                    0
                );
                Ok(())
            })
            .await
            .expect("deletion, KV and handler rollback");
        fixture.restart().await;
        fixture
            .module
            .register(Registration {
                name: "fixture.procedure".into(),
                arguments_schema: "historyExcerptBudget",
                result_schema: "historyExcerptBudget",
                function: procedure.clone(),
            })
            .expect("same owner re-registers");
        fixture.module.start().await.expect("restart recovery");
        assert_eq!(observed(&mut started).await, 1);
        wait_rows(&fixture, 0).await;
        let id = result["callId"]
            .as_str()
            .expect("same recovered identity")
            .to_owned();
        fixture
            .runtime
            .transact(move |ctx| {
                assert_eq!(
                    ctx.database().query_row(
                        "SELECT result FROM durable_fixture_completion WHERE id=?1",
                        [id],
                        |row| row.get::<_, String>(0)
                    )?,
                    "1"
                );
                assert_eq!(
                    ctx.database().query_row(
                        "SELECT count(*) FROM durable_function_kv",
                        [],
                        |row| row.get::<_, usize>(0)
                    )?,
                    0
                );
                Ok(())
            })
            .await
            .expect("atomic successful completion");
        assert_eq!(procedure.executions.load(Ordering::SeqCst), 1);
        assert_eq!(procedure.handlers.load(Ordering::SeqCst), 2);
        fixture.close().await;
    }

    #[tokio::test]
    async fn recovery_reserves_all_keys_of_an_older_blocked_call_without_blocking_disjoint_work() {
        let fixture = Fixture::new().await;
        let releases: BTreeMap<_, _> = (1..=4)
            .map(|number| (number, Arc::new(Notify::new())))
            .collect();
        let (procedure, mut started) = register(&fixture, releases.clone(), false, false).await;
        fixture.runtime.transact(|ctx|{for(number,keys)in [(1,json!(["red"])),(2,json!(["red","blue"])),(3,json!(["blue"])),(4,json!(["green"]))]{ctx.database().execute("INSERT INTO durable_function_calls VALUES(?1,NULL,'fixture.procedure',?2,?3,?4)",params![format!("callfixture{number}"),number.to_string(),keys.to_string(),number])?;}Ok(())}).await.expect("original pending rows with deterministic chronology");
        fixture.module.start().await.expect("after-start recovery");
        let first = observed(&mut started).await;
        let second = observed(&mut started).await;
        assert_eq!(BTreeSet::from([first, second]), BTreeSet::from([1, 4]));
        assert_eq!(fixture.module.state.lock().unwrap().waiting.len(), 2);
        releases[&1].notify_one();
        assert_eq!(observed(&mut started).await, 2);
        assert_eq!(fixture.module.state.lock().unwrap().waiting.len(), 1);
        releases[&2].notify_one();
        assert_eq!(observed(&mut started).await, 3);
        releases[&3].notify_one();
        releases[&4].notify_one();
        wait_rows(&fixture, 0).await;
        assert_eq!(procedure.executions.load(Ordering::SeqCst), 4);
        fixture.close().await;
    }

    #[tokio::test]
    async fn invalid_recovery_and_terminal_executor_failure_delete_only_their_own_state() {
        let fixture = Fixture::new().await;
        let (procedure, mut started) = register(&fixture, BTreeMap::new(), false, true).await;
        fixture
            .runtime
            .transact(|ctx| {
                for (id, function, args) in [
                    ("callinvalidarguments", "fixture.procedure", "0"),
                    ("callunregisteredowner", "gone.procedure", "1"),
                ] {
                    ctx.database().execute(
                        "INSERT INTO durable_function_calls VALUES(?1,NULL,?2,?3,'[]',1)",
                        params![id, function, args],
                    )?;
                    ctx.database().execute(
                        "INSERT INTO durable_function_kv VALUES(?1,'true')",
                        [format!("call.{id}.checkpoint")],
                    )?;
                }
                ctx.database().execute(
                    "INSERT INTO durable_function_kv VALUES('unrelated.fixture','true')",
                    [],
                )?;
                Ok(())
            })
            .await
            .expect("old owned and unrelated state");
        fixture
            .module
            .start()
            .await
            .expect("schema-checked restart recovery");
        wait_rows(&fixture, 0).await;
        assert_eq!(procedure.executions.load(Ordering::SeqCst), 0);
        let module = fixture.module.clone();
        fixture
            .runtime
            .transact(move |ctx| {
                module.invoke(ctx, &json!({"function":"fixture.procedure","arguments":1}))?;
                Ok(())
            })
            .await
            .expect("terminal failure call");
        assert_eq!(observed(&mut started).await, 1);
        wait_rows(&fixture, 0).await;
        assert_eq!(procedure.handlers.load(Ordering::SeqCst), 0);
        fixture
            .runtime
            .transact(|ctx| {
                let keys = ctx
                    .database()
                    .prepare("SELECT key FROM durable_function_kv ORDER BY key")?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert_eq!(keys, vec!["unrelated.fixture"]);
                Ok(())
            })
            .await
            .expect("selective state deletion");
        fixture.close().await;
    }

    #[tokio::test]
    async fn cancelling_an_older_waiter_releases_its_reservation_while_other_work_keeps_running() {
        let fixture = Fixture::new().await;
        let releases: BTreeMap<_, _> = (1..=3)
            .map(|number| (number, Arc::new(Notify::new())))
            .collect();
        let (_, mut started) = register(&fixture, releases.clone(), false, false).await;
        fixture.runtime.transact(|ctx|{for(number,operation,keys)in [(1,None,json!(["red"])),(2,Some("cancel-reservation"),json!(["red","blue"])),(3,None,json!(["blue"]))]{ctx.database().execute("INSERT INTO durable_function_calls VALUES(?1,?2,'fixture.procedure',?3,?4,?5)",params![format!("callreservation{number}"),operation,number.to_string(),keys.to_string(),number])?;}Ok(())}).await.expect("durable waiting order");
        fixture.module.start().await.expect("recovery");
        assert_eq!(observed(&mut started).await, 1);
        let module = fixture.module.clone();
        assert!(
            fixture
                .runtime
                .transact(move |ctx| module.cancel(ctx, "cancel-reservation"))
                .await
                .expect("cancel older waiter")
        );
        assert_eq!(
            observed(&mut started).await,
            3,
            "blue work begins while the older red execution still holds its key"
        );
        releases[&1].notify_one();
        releases[&3].notify_one();
        wait_rows(&fixture, 0).await;
        fixture.close().await;
    }
}
