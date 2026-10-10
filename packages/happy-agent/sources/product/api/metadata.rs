//! The source API projects private metadata records into its public versioned delta.
use super::*;
use anyhow::Result;
#[async_trait::async_trait]
impl happy_agent_base::AgentModule for ApiModule {
    fn name(&self)->&'static str {"api"}
    async fn close(&self) {self.close_process_events().await;}
    fn metadata_changed(&self,ctx:&happy_agent_base::DatabaseContext<'_>,scope:&happy_agent_base::AgentScope<'_>,change:&Value)->Result<()> {
        let Some((version,occurred_at,previous))=self.events.latest_transition(ctx,scope.id)? else{return Ok(());};
        let Some(previous)=previous else{return Ok(());};
        let update=&change["update"];let mut changes=json!({"updatedAt":occurred_at});
        for key in ["archivedAt","orderKey","pendingQuestionId","processes","subagents","subtaskOrderKey","title","unread"] {if let Some(value)=update.get(key){changes[key]=value.clone();}}
        if let Some(title)=update.get("title"){changes["titleStatus"]=json!(if title.is_string(){"ready"}else{"idle"});}
        if let Some(archived)=update.get("archivedAt").filter(|value|value.is_null()||value.is_number()) {
            let parent=self.agents.parent_of(ctx,scope.id)?;
            changes["canSendMessages"]=json!((parent.is_none()||scope.configuration["metadata"]["subtask"]==true)&&archived.is_null());
        }
        let mut payload=json!({"agentId":scope.id,"previousVersion":previous,"version":version,"changes":changes});mutation::apply(&mut payload);self.events.publish(ctx,"agent.updated",payload,occurred_at)
    }
}