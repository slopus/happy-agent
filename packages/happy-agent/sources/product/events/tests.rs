use super::*;
use crate::product::config::ConfigModule;
use happy_agent_base::{AgentModule,AgentScope};

#[tokio::test]
async fn private_metadata_records_do_not_escape_as_public_event_names() {
    let directory=tempfile::tempdir().unwrap();let config=Arc::new(ConfigModule::isolated(directory.path()).unwrap());let runtime=Arc::new(RuntimeModule::new(config));runtime.load().await.unwrap();let events=Arc::new(EventsModule::new(runtime.clone()).unwrap());events.load().await.unwrap();
    let origin=events.cursor();let id=cuid2::create_id();let agent=id.clone();let owner=events.clone();
    runtime.transact(move|ctx| {
        let configuration=json!({"metadata":{"title":"Named"}});let settings=json!({});let scope=AgentScope {id:&agent,configuration:&configuration,settings:&settings};
        owner.metadata_changed(ctx,&scope,&json!({"agentId":agent,"previousMetadata":{},"update":{"title":"Named"},"metadata":{"title":"Named"}}))?;
        let (version,_,_)=owner.latest_transition(ctx,&agent)?.unwrap();
        let (kind,payload):(String,String)=ctx.database().query_row("SELECT type,payload_json FROM happy_agent_events WHERE event_id=?1",[version],|row|Ok((row.get(0)?,row.get(1)?)))?;
        assert_eq!(kind,"agent.metadata-changed");assert_eq!(serde_json::from_str::<Value>(&payload)?["update"]["title"],"Named");Ok(())
    }).await.unwrap();
    assert_eq!(events.cursor(),origin);
    assert_eq!(events.with_journal(|journal|journal.replay(Some(&origin),None,100,None)).unwrap()["events"],json!([]));
    runtime.close().await.unwrap();
}