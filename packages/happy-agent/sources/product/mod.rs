mod api;
mod config;
mod filesystem;
mod identity;
mod journal;
mod lifecycle;
mod process;
mod runtime;
mod schemas;
mod transport;

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
    let api = Arc::new(api::ApiModule::new(config.clone(), lifecycle.clone())?);
    // Health is available before storage restoration, on the same authenticated listener.
    let transport = transport::TransportModule::bind(config.clone(), api.clone()).await?;
    let result = async {
        let runtime = runtime::RuntimeModule::open(config.clone()).await?;
        lifecycle.publish_pid()?;
        api.start(runtime);
        lifecycle.ready()?;
        transport.serve().await
    }
    .await;
    lifecycle.cleanup()?;
    result
}
