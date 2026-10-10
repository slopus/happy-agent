//! Transactional, leaf-first cancellation of an authoritative agent subtree.
use crate::product::{
    agent_runtime::AgentRuntimeModule,
    runtime::{Context, RuntimeModule},
    services::ServicesModule,
    tools::ToolsModule,
};
use anyhow::Result;
use std::{collections::BTreeSet, sync::Arc};
use tokio_util::sync::CancellationToken;

pub struct AbortModule {
    runtime: Arc<RuntimeModule>,
    agents: Arc<AgentRuntimeModule>,
    tools: Arc<ToolsModule>,
    services: Arc<ServicesModule>,
}
impl AbortModule {
    pub fn new(
        runtime: Arc<RuntimeModule>,
        agents: Arc<AgentRuntimeModule>,
        tools: Arc<ToolsModule>,
        services: Arc<ServicesModule>,
    ) -> Arc<Self> {
        Arc::new(Self {
            runtime,
            agents,
            tools,
            services,
        })
    }
    /// Resolve the whole tree before accepting any cancellation. Both ancestry
    /// reads and durable abort decisions use the caller's transaction snapshot.
    pub fn abort(self: &Arc<Self>, ctx: &Context<'_>, root: &str) -> Result<()> {
        self.runtime.assert_context(ctx)?;
        let mut pending = vec![root.to_owned()];
        let mut visited = BTreeSet::new();
        let mut index = 0;
        while index < pending.len() {
            let id = pending[index].clone();
            anyhow::ensure!(
                visited.len() < 10000 && visited.insert(id.clone()),
                "The agent descendant chain is cyclic, duplicated or exceeds 10,000 agents."
            );
            pending.extend(self.agents.children(ctx, &id)?);
            index += 1;
        }
        let mut leaf_first = Vec::new();
        for id in pending.into_iter().rev() {
            if ctx.claim_once("abort-agent", &id)? {
                leaf_first.push(id);
            }
        }
        for id in &leaf_first {
            self.services.stop_owner(ctx, id)?;
            self.tools.record_abort_notice(ctx, id)?;
            self.agents.abort(ctx, id)?;
        }
        let tools = self.tools.clone();
        ctx.after_commit(move || {
            // Every agent signal was registered before this observer. Native
            // teardown is independently owned and does not hold the DB FIFO.
            tokio::spawn(async move {
                let results = futures_util::future::join_all(leaf_first.into_iter().map(|id| {
                    let tools = tools.clone();
                    async move {
                        if let Err(error) = tools.hard_kill_agent_processes(&id).await {
                            eprintln!(
                                "Background process cleanup remains unconfirmed for {id}: {error:#}"
                            );
                        }
                    }
                }))
                .await;
                drop(results);
            });
        })?;
        Ok(())
    }
    pub async fn abort_current(self: &Arc<Self>, root: String) -> Result<()> {
        let module = self.clone();
        self.runtime
            .transact(move |ctx| module.abort(ctx, &root))
            .await
    }
    /// A process signal is not a settlement proof. Callers awaiting destructive
    /// cleanup first require both the core loop and native groups to settle.
    /// Services supplies its own separate sandbox removal barrier.
    pub async fn confirm_agent_stopped(&self, id: &str, cancel: &CancellationToken) -> Result<()> {
        self.agents.wait_for_idle(id, cancel).await?;
        self.tools.hard_kill_agent_processes(id).await
    }
}
