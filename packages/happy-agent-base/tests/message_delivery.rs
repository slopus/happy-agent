use anyhow::Result;
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentSystem, DatabaseLocation, SqliteDatabase};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

struct Owner { shutdown: CancellationToken }
#[async_trait]
impl AgentModule for Owner {
    fn name(&self) -> &'static str { "message-delivery-fixture" }
    fn shutdown(&self) -> Option<CancellationToken> { Some(self.shutdown.clone()) }
    fn draining(&self) -> bool { true }
}

#[tokio::test]
async fn stable_message_identity_admits_once_across_queue_kinds_and_database_reopen() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let location = || DatabaseLocation { directory: directory.path().into(), database: directory.path().join("agent.sqlite"), ownership: directory.path().join("agent.sqlite.lock"), store_lock: directory.path().join("agent.lock") };
    let database = Arc::new(SqliteDatabase::new()); database.load(location()).await?;
    let owner = Arc::new(Owner { shutdown: CancellationToken::new() });
    let system = Arc::new(AgentSystem::new(database.clone(), vec![owner])?);
    let target = system.clone();
    database.transact(move |ctx| {
        target.create(ctx, "deliveryfixture", &json!({"metadata":{}}))?;
        let original = json!({"id":"stableopening","message":{"role":"user","content":[{"type":"text","text":"Original opening."}]},"options":{"provider":"fixture","model":"fixture","effort":"low","permissionMode":"auto"}});
        target.enqueue(ctx, "deliveryfixture", &original, false)?;
        let mut duplicate = original.clone(); duplicate["message"]["content"][0]["text"] = json!("A duplicate must not replace the original.");
        target.enqueue(ctx, "deliveryfixture", &duplicate, true)?;
        assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_values WHERE owner_id='deliveryfixture' AND (key GLOB 'send.*' OR key GLOB 'steering.*')", [], |row| row.get(0))?, 1);
        assert_eq!(ctx.database().query_row::<String,_,_>("SELECT json_extract(value_json,'$.message.content[0].text') FROM happy_agent_values WHERE owner_id='deliveryfixture' AND key GLOB 'send.*'", [], |row| row.get(0))?, "Original opening.");
        Ok(())
    }).await?;
    system.close().await; database.close().await?;
    let database = Arc::new(SqliteDatabase::new()); database.load(location()).await?;
    let system = Arc::new(AgentSystem::new(database.clone(), vec![Arc::new(Owner { shutdown: CancellationToken::new() })])?);
    let target = system.clone();
    database.transact(move |ctx| {
        target.enqueue(ctx, "deliveryfixture", &json!({"id":"stableopening","message":{"role":"user","content":[{"type":"text","text":"Retry after recovery."}]},"options":{"provider":"fixture","model":"fixture","effort":"low","permissionMode":"auto"}}), false)?;
        assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_values WHERE owner_id='deliveryfixture' AND (key GLOB 'send.*' OR key GLOB 'steering.*')", [], |row| row.get(0))?, 1);
        Ok(())
    }).await?;
    system.close().await; database.close().await?; Ok(())
}