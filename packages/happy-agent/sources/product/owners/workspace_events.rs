//! Transactional subscribers see the complete Source event and stored workspace.
use super::WorkspacesModule;
use crate::product::{identity::now, runtime::Context, schemas::Schemas};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::sync::{Arc, Weak, atomic::Ordering};

pub type WorkspaceTransactionalListener =
    Arc<dyn for<'a> Fn(&Context<'a>, &Value) -> Result<()> + Send + Sync>;
pub struct WorkspaceSubscription {
    owner: Weak<WorkspacesModule>,
    id: u64,
}
impl Drop for WorkspaceSubscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            owner
                .event_listeners
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&self.id);
        }
    }
}
impl WorkspacesModule {
    pub fn on_event_transactional(
        self: &Arc<Self>,
        listener: WorkspaceTransactionalListener,
    ) -> Result<WorkspaceSubscription> {
        let mut listeners = self
            .event_listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        ensure!(
            listeners.len() < 64,
            "The workspace subscriber limit was reached."
        );
        let id = self.next_event_listener.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(WorkspaceSubscription {
            owner: Arc::downgrade(self),
            id,
        })
    }
    pub(super) fn observe(&self, ctx: &Context<'_>, mut event: Value) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        event["eventId"] = json!(uuid::Uuid::new_v4().to_string());
        event["at"] = json!(now());
        ensure!(
            Schemas::new()?.valid("ownerWorkspaceEvent", &event)?,
            "The workspace change event is invalid."
        );
        let listeners = self
            .event_listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for listener in listeners {
            listener(ctx, &event)?;
        }
        Ok(())
    }
    pub(super) fn write_event(
        &self,
        ctx: &Context<'_>,
        before: &Value,
        after: &mut Value,
        mut event: Value,
    ) -> Result<()> {
        if !self.store_row(ctx, before, after)? {
            return Ok(());
        }
        event["workspace"] = after.clone();
        event["previousWorkspace"] = before.clone();
        self.observe(ctx, event)
    }
    pub(super) fn store_row(
        &self,
        ctx: &Context<'_>,
        before: &Value,
        after: &mut Value,
    ) -> Result<bool> {
        if before == after {
            return Ok(false);
        }
        let schemas = Schemas::new()?;
        after["version"] = json!(before["version"].as_u64().unwrap() + 1);
        after["updatedAt"] = json!(now().max(before["updatedAt"].as_u64().unwrap() + 1));
        *after = super::persistence::write(ctx, &schemas, before, after)?;
        if before["status"] != after["status"] {
            self.publish_transition(ctx, after)?;
        }
        Ok(true)
    }
    pub(super) fn write(
        &self,
        ctx: &Context<'_>,
        before: &Value,
        after: &mut Value,
        change: &str,
    ) -> Result<()> {
        self.write_event(
            ctx,
            before,
            after,
            json!({"type":"workspace_updated","change":change}),
        )
    }
}
