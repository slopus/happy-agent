//! Private transports reuse the complete runner contract without inventing a
//! configured runner, token, product machine, or host execution fallback.
use super::*;
pub struct EmbeddedRunner {
    owner: Arc<RunnersModule>,
    id: String,
    task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<Result<()>>>>,
}
impl RunnersModule {
    pub async fn embedded_transport(
        self: &Arc<Self>,
        transport: RunnerTransport,
    ) -> Result<Arc<EmbeddedRunner>> {
        anyhow::ensure!(
            !self.closed.load(Ordering::Acquire),
            "The runner protocol owner is closed."
        );
        let id = format!("docker-{}", uuid::Uuid::new_v4());
        {
            let mut embedded = self
                .embedded
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            anyhow::ensure!(
                embedded.len() < 512,
                "The bounded Docker connection catalog is full."
            );
            embedded.insert(id.clone());
        }
        let module = self.clone();
        let name = id.clone();
        let task = tokio::spawn(async move { module.accept(name, transport).await });
        let connection = Arc::new(EmbeddedRunner {
            owner: self.clone(),
            id,
            task: tokio::sync::Mutex::new(Some(task)),
        });
        if let Err(error) = self.session(&connection.id, &self.lifecycle.shutdown).await {
            let _ = connection.close().await;
            return Err(error.context("The container worker could not start. The selected image must execute this Linux binary and its required system libraries."));
        }
        Ok(connection)
    }
}
impl EmbeddedRunner {
    pub async fn compute(
        &self,
        parameters: Value,
        cancel: &CancellationToken,
    ) -> Result<Arc<RunnerCompute>> {
        self.owner.open_compute(&self.id, parameters, cancel).await
    }
    pub async fn close(&self) -> Result<()> {
        if let Some(link) = self
            .owner
            .links
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&self.id)
            && let Some(session) = link
                .session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
        {
            session.cancel.cancel();
        }
        if let Some(task) = self.task.lock().await.take() {
            // EOF releases every in-container compute through RunnerServer.close;
            // the Docker owner subsequently checks the Engine's worker identity.
            task.await
                .context("The container protocol task ended unexpectedly.")??;
        }
        self.owner
            .embedded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.id);
        if let Some(link) = self
            .owner
            .links
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.id)
            && let Some(lease) = link
                .lease
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
        {
            lease.cancel();
        }
        self.owner
            .computes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|(runner, _), _| runner != &self.id);
        Ok(())
    }
}
