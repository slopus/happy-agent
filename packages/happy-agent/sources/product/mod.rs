mod agents;
mod api;
#[cfg(test)]
mod auto;
mod config;
#[cfg(test)]
mod durable;
mod events;
mod filesystem;
mod history;
mod identity;
mod journal;
mod lifecycle;
mod process;
mod projects;
mod runtime;
mod schemas;
mod tools;
mod transport;
mod usage;
mod workspaces;

pub use config::ConfigModule;
pub use lifecycle::{LifecycleModule, command};

use anyhow::Result;
use std::sync::Arc;

pub async fn sandbox(arguments: Vec<std::ffi::OsString>) -> Result<()> {
    let valid = matches!(arguments.as_slice(),[command] if command=="setup" || command=="status")
        || matches!(arguments.as_slice(),[command,option] if command=="setup" && option=="--retry");
    anyhow::ensure!(
        valid,
        "The Windows sandbox command is not valid.\nRun happy-agent sandbox status, happy-agent sandbox setup, or happy-agent sandbox setup --retry."
    );
    #[cfg(unix)]
    anyhow::bail!("The sandbox setup command is only needed on Windows.");
    #[cfg(windows)]
    anyhow::bail!("The native Windows sandbox setup migration is not yet complete.");
}

pub async fn run() -> Result<()> {
    let config = Arc::new(ConfigModule::load()?);
    let lifecycle = Arc::new(LifecycleModule::new(config.clone())?);
    let runtime = Arc::new(runtime::RuntimeModule::new(config.clone()));
    let events = Arc::new(events::EventsModule::new(runtime.clone())?);
    let usage = Arc::new(usage::UsageModule::new(
        runtime.clone(),
        events.clone(),
        config.clone(),
    )?);
    let history = Arc::new(history::HistoryModule::new(
        config.clone(),
        runtime.clone(),
        events.clone(),
        usage.clone(),
    )?);
    let tools = Arc::new(tools::ToolsModule::new(
        config.clone(),
        history.clone(),
        lifecycle.clone(),
    )?);
    let projects = Arc::new(projects::ProjectsModule::new(runtime.clone())?);
    let workspaces = Arc::new(workspaces::WorkspacesModule::new(runtime.clone()));
    let agents = Arc::new(agents::AgentSystemModule::new(
        config.clone(),
        runtime.clone(),
        events.clone(),
        history.clone(),
        tools,
        usage.clone(),
        lifecycle.clone(),
        projects,
        workspaces,
    )?);
    let api = Arc::new(api::ApiModule::new(
        config.clone(),
        lifecycle.clone(),
        events.clone(),
        agents.clone(),
    )?);
    // Health is available before storage restoration, on the same authenticated listener.
    let transport = transport::TransportModule::bind(config.clone(), api.clone()).await?;
    let server = tokio::spawn(transport.serve());
    let initialized = async {
        runtime.load().await?;
        lifecycle.set_database_open(true);
        events.load().await?;
        usage.load().await?;
        history.load().await?;
        agents.load().await?;
        lifecycle.publish_pid()?;
        lifecycle.ready()?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if initialized.is_err() {
        lifecycle.begin_shutdown();
    }
    let served = server
        .await
        .map_err(anyhow::Error::from)
        .and_then(|result| result);
    lifecycle.begin_shutdown();
    agents.close().await;
    let closed = runtime.close().await;
    if closed.is_ok() {
        lifecycle.set_database_open(false);
    }
    let cleaned = lifecycle.cleanup();
    initialized.and(served).and(closed).and(cleaned)
}
