//! The catalog publishes exact stored snapshots in the mutation transaction.
use super::ProjectsModule;
use crate::product::{identity::now, runtime::Context};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::sync::{Arc, Weak, atomic::Ordering};

pub type ProjectTransactionalListener =
    Arc<dyn for<'a> Fn(&Context<'a>, &Value) -> Result<()> + Send + Sync>;

pub struct ProjectSubscription {
    owner: Weak<ProjectsModule>,
    id: u64,
}
impl Drop for ProjectSubscription {
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

impl ProjectsModule {
    pub fn on_event_transactional(
        self: &Arc<Self>,
        listener: ProjectTransactionalListener,
    ) -> Result<ProjectSubscription> {
        let mut listeners = self
            .event_listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        ensure!(
            listeners.len() < 64,
            "The project subscriber limit was reached."
        );
        let id = self.next_event_listener.fetch_add(1, Ordering::Relaxed);
        listeners.insert(id, listener);
        Ok(ProjectSubscription {
            owner: Arc::downgrade(self),
            id,
        })
    }

    pub(super) fn observe(&self, ctx: &Context<'_>, mut event: Value) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        event["eventId"] = json!(uuid::Uuid::new_v4().to_string());
        event["at"] = json!(now());
        ensure!(
            self.schemas.valid("ownerProjectEvent", &event)?,
            "The project change event is invalid."
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
}
