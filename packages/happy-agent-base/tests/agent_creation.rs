use anyhow::Result;
use async_trait::async_trait;
use happy_agent_base::{AgentModule, AgentScope, AgentSystem, DatabaseContext, DatabaseLocation, SqliteDatabase};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

struct Owner { shutdown:CancellationToken }
#[async_trait]
impl AgentModule for Owner {
    fn name(&self)->&'static str {"creation-provenance-fixture"}
    fn shutdown(&self)->Option<CancellationToken>{Some(self.shutdown.clone())}
    fn created(&self,ctx:&DatabaseContext<'_>,scope:&AgentScope<'_>)->Result<()> {
        ctx.put_value(scope.id,"fixture.creation",&scope.configuration["provenance"])?;
        anyhow::ensure!(scope.configuration["metadata"]["reject"]!=true,"The creation owner rejected this agent.");Ok(())
    }
}
#[tokio::test]
async fn creation_owns_provenance_rejects_identity_reuse_and_rolls_back_its_hooks() -> Result<()> {
    let directory=tempfile::tempdir()?;let database=Arc::new(SqliteDatabase::new());database.load(DatabaseLocation{directory:directory.path().into(),database:directory.path().join("agent.sqlite"),ownership:directory.path().join("agent.sqlite.lock"),store_lock:directory.path().join("agent.lock")}).await?;
    let owner=Arc::new(Owner{shutdown:CancellationToken::new()});let system=Arc::new(AgentSystem::new(database.clone(),vec![owner])?);let target=system.clone();
    database.transact(move|ctx|{
        let input=json!({"provenance":{"createdAt":1,"createdBy":"forgedcreator"},"metadata":{"title":"Original"}});
        target.create_from(ctx,"createdfixture",&input,Some("actualcreator"))?;
        let configuration=target.configuration(ctx,"createdfixture")?.unwrap();assert!(configuration["provenance"]["createdAt"].as_u64().unwrap()>1);assert_eq!(configuration["provenance"]["createdBy"],"actualcreator");assert_eq!(ctx.value("createdfixture","fixture.creation")?,Some(configuration["provenance"].clone()));assert_eq!(input["provenance"]["createdAt"],1);
        assert!(target.create(ctx,"createdfixture",&json!({"metadata":{"title":"Replacement"}})).is_err());assert_eq!(target.configuration(ctx,"createdfixture")?.unwrap(),configuration);
        target.create(ctx,"personfixture",&input)?;assert!(target.configuration(ctx,"personfixture")?.unwrap()["provenance"].get("createdBy").is_none());Ok(())
    }).await?;
    let target=system.clone();assert!(database.transact(move|ctx|target.create_from(ctx,"rejectedfixture",&json!({"metadata":{"reject":true}}),Some("actualcreator"))).await.is_err());
    let target=system.clone();database.transact(move|ctx|{assert!(target.configuration(ctx,"rejectedfixture")?.is_none());assert!(ctx.value("rejectedfixture","fixture.creation")?.is_none());Ok(())}).await?;
    system.close().await;database.close().await?;Ok(())
}