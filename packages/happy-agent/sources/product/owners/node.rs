use super::persistence::{NODE_MIGRATIONS, query_node_state, save_node_state};
use crate::product::{
    config::ConfigModule,
    durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration},
    events::EventsModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::sync::{Arc, Weak};
use tokio_util::sync::CancellationToken;

const SAVE_RUNTIME_NAME: &str = "node-save-runtime-name";

/// Installation identity is available even when no conversation agents exist.
/// The singleton owns the name and avatar together; the durable call carries
/// no stale name and writes only the currently committed identity.
pub struct NodeModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    events: Arc<EventsModule>,
    schemas: Schemas,
}

impl NodeModule {
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        events: Arc<EventsModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in ["nodeState", "nodeName"] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        let module = Arc::new(Self {
            config,
            runtime,
            durable: durable.clone(),
            events,
            schemas,
        });
        durable.register(Registration {
            name: SAVE_RUNTIME_NAME.into(),
            arguments_schema: "ownerExactEmpty",
            result_schema: "ownerNull",
            function: Arc::new(SaveRuntimeName(Arc::downgrade(&module))),
        })?;
        Ok(module)
    }

    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime.migrate("node", NODE_MIGRATIONS).await?;
        let name = self.config.initial_node_name().await?;
        let module = self.clone();
        self.runtime
            .transact(move |ctx| {
                if query_node_state(ctx, &module.schemas)?.is_none() {
                    save_node_state(ctx, &module.schemas, &json!({"name":name,"avatar":null}))?;
                }
                module.schedule_runtime_write(ctx)
            })
            .await
    }

    pub fn get(&self, ctx: &Context<'_>) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        Ok(project(&self.query_state(ctx)?))
    }

    pub fn avatar(&self, ctx: &Context<'_>) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        Ok(self.query_state(ctx)?["avatar"].clone())
    }

    /// HTTP owns caller authorization. This operation participates in its
    /// caller's transaction, including the runtime-write intent and event.
    pub fn set_name(self: &Arc<Self>, ctx: &Context<'_>, name: &str) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        anyhow::ensure!(
            self.schemas.valid("nodeName", &json!(name))?,
            "The node name must contain 1–128 printable characters."
        );
        let mut state = self.query_state(ctx)?;
        if state["name"] == name {
            return Ok(project(&state));
        }
        state["name"] = json!(name);
        save_node_state(ctx, &self.schemas, &state)?;
        self.schedule_runtime_write(ctx)?;
        let events = self.events.clone();
        ctx.after_commit(move || {
            events.with_journal(|journal| {
                journal.append("config.updated", json!({}), None);
            });
        })?;
        Ok(project(&state))
    }

    fn query_state(&self, ctx: &Context<'_>) -> Result<Value> {
        query_node_state(ctx, &self.schemas)?.context("The node configuration has not started.")
    }

    fn schedule_runtime_write(&self, ctx: &Context<'_>) -> Result<()> {
        self.durable.invoke(
            ctx,
            &json!({"function":SAVE_RUNTIME_NAME,"arguments":{},"lockKeys":[SAVE_RUNTIME_NAME]}),
        )?;
        Ok(())
    }

    async fn write_runtime_name(self: Arc<Self>) -> Result<()> {
        let module = self.clone();
        let name = self
            .runtime
            .transact(move |ctx| {
                Ok(module.query_state(ctx)?["name"]
                    .as_str()
                    .context("The stored node name is invalid.")?
                    .to_owned())
            })
            .await?;
        self.config.write_runtime_node_name(&name).await
    }
}

fn project(state: &Value) -> Value {
    json!({"name":state["name"],"avatar":if state["avatar"].is_null(){Value::Null}else{json!({"thumbhash":state["avatar"]["thumbhash"]})}})
}

struct SaveRuntimeName(Weak<NodeModule>);
impl DurableFunction for SaveRuntimeName {
    fn execute(
        self: Arc<Self>,
        _call: Value,
        _kv: CallKv,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            anyhow::ensure!(
                !cancel.is_cancelled(),
                "The node runtime write was stopped."
            );
            self.0
                .upgrade()
                .context("The node owner has stopped.")?
                .write_runtime_name()
                .await?;
            Ok(Value::Null)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::owners::tests::Fixture;

    #[tokio::test]
    async fn name_state_intent_and_notification_roll_back_together_and_preserve_avatar() {
        let fixture = Fixture::new().await;
        let node = fixture.node.clone();
        fixture.runtime.transact(move|ctx| {
            let mut state = node.query_state(ctx)?;
            state["avatar"] = json!({"data":"eA==","thumbhash":"retained-image","etag":format!("\"{}\"","0".repeat(64))});
            save_node_state(ctx,&node.schemas,&state)
        }).await.expect("original full avatar asset");
        let before = fixture.pending().await.expect("startup intents");
        let cursor = fixture.events.cursor();
        let node = fixture.node.clone();
        let result: Result<()> = fixture
            .runtime
            .transact(move |ctx| {
                node.set_name(ctx, "Rolled back")?;
                anyhow::bail!("Deliberate owner transaction rollback.");
            })
            .await;
        assert!(result.is_err());
        assert_eq!(
            fixture.pending().await.expect("unchanged durable intents"),
            before
        );
        assert_eq!(fixture.events.cursor(), cursor);
        let node = fixture.node.clone();
        let projected = fixture
            .runtime
            .transact(move |ctx| node.set_name(ctx, "Current installation"))
            .await
            .expect("atomic rename");
        assert_eq!(
            projected,
            json!({"name":"Current installation","avatar":{"thumbhash":"retained-image"}})
        );
        let node = fixture.node.clone();
        assert_eq!(
            fixture
                .runtime
                .transact(move |ctx| node.avatar(ctx))
                .await
                .expect("avatar retained")["data"],
            "eA=="
        );
        let calls = fixture.pending().await.expect("name write intent");
        assert_eq!(calls.len(), before.len() + 1);
        let call = calls.last().expect("rename procedure");
        assert_eq!(call["function"], SAVE_RUNTIME_NAME);
        assert_eq!(call["arguments"], json!({}));
        assert_eq!(call["operationId"], Value::Null);
        assert_eq!(call["lockKeys"], json!([SAVE_RUNTIME_NAME]));
        assert_ne!(fixture.events.cursor(), cursor);
        fixture.close().await;
    }

    #[tokio::test]
    async fn pending_original_name_writes_recover_the_latest_stored_name_after_restart() {
        let mut fixture = Fixture::new().await;
        for name in ["Superseded name", "Latest name"] {
            let node = fixture.node.clone();
            fixture
                .runtime
                .transact(move |ctx| node.set_name(ctx, name))
                .await
                .expect("committed rename");
        }
        fixture.restart().await;
        fixture
            .durable
            .start()
            .await
            .expect("real registry recovery");
        fixture
            .wait_runtime(
                "node",
                &toml::Value::try_from(json!({"name":"Latest name"})).expect("node TOML"),
            )
            .await;
        let node = fixture.node.clone();
        assert_eq!(
            fixture
                .runtime
                .transact(move |ctx| node.get(ctx))
                .await
                .expect("stored identity")["name"],
            "Latest name"
        );
        fixture.wait_pending_count(SAVE_RUNTIME_NAME, 0).await;
        fixture.close().await;
    }

    #[tokio::test]
    async fn node_procedure_rejects_extra_arguments_and_idempotent_rename_adds_no_intent() {
        let fixture = Fixture::new().await;
        let node = fixture.node.clone();
        let current = fixture
            .runtime
            .transact(move |ctx| node.get(ctx))
            .await
            .expect("node")["name"]
            .as_str()
            .expect("name")
            .to_owned();
        let before = fixture.pending().await.expect("startup intent");
        let node = fixture.node.clone();
        fixture
            .runtime
            .transact(move |ctx| node.set_name(ctx, &current))
            .await
            .expect("idempotent rename");
        assert_eq!(fixture.pending().await.expect("no new intent"), before);
        let durable = fixture.durable.clone();
        assert!(
            fixture
                .runtime
                .transact(move |ctx| durable.invoke(
                    ctx,
                    &json!({"function":SAVE_RUNTIME_NAME,"arguments":{"name":"Injected"}})
                ))
                .await
                .is_err()
        );
        fixture.close().await;
    }
}
