//! The same shipped executable supplies the in-container runtime role. It uses
//! the native runner's checked filesystem and process owner, never a shell RPC.
use super::*;
pub(in crate::product) async fn run() -> Result<()> {
    crate::product::process::prepare_child_reaping()?;
    let config = Arc::new(ConfigModule::container_worker()?);
    let lifecycle = Arc::new(LifecycleModule::new(config.clone())?);
    let runtime = Arc::new(RuntimeModule::new(config.clone()));
    runtime.load().await?;
    let events = Arc::new(crate::product::events::EventsModule::new(runtime.clone())?);
    let usage = Arc::new(crate::product::usage::UsageModule::new(
        runtime.clone(),
        events.clone(),
        config.clone(),
    )?);
    let history = Arc::new(crate::product::history::HistoryModule::new(
        config.clone(),
        runtime.clone(),
        events.clone(),
        usage,
    )?);
    let durable = Arc::new(DurableFunctionsModule::new(
        runtime.clone(),
        lifecycle.clone(),
    )?);
    let secrets = crate::product::secrets::SecretsModule::new(
        config.clone(),
        runtime.clone(),
        durable.clone(),
        events.clone(),
    )?;
    let services = crate::product::services::ServicesModule::new(
        config.clone(),
        runtime.clone(),
        durable.clone(),
        lifecycle.clone(),
        events.clone(),
    )?;
    let runners = RunnersModule::new(config.clone(), runtime.clone(), lifecycle.clone())?;
    runners.load().await?;
    let docker = DockerModule::new(
        config.clone(),
        runtime.clone(),
        durable,
        lifecycle.clone(),
        runners.clone(),
    )?;
    let tools = Arc::new(crate::product::tools::ToolsModule::new(
        config.clone(),
        history,
        lifecycle.clone(),
        runtime.clone(),
        secrets,
        services,
        events,
        runners.clone(),
        docker,
    )?);
    let server = runners.native_server(tools.clone());
    let (incoming, incoming_rx) = tokio::sync::mpsc::channel(4);
    let (outgoing, outgoing_rx) = tokio::sync::mpsc::channel(4);
    let reader = tokio::spawn(framing::read(tokio::io::stdin(), incoming));
    let writer = tokio::spawn(framing::write(tokio::io::stdout(), outgoing_rx));
    let served = server
        .serve(RunnerTransport {
            incoming: incoming_rx,
            outgoing,
        })
        .await;
    lifecycle.begin_shutdown();
    let released = server.close().await;
    tools.close().await;
    runners.close().await;
    runtime.close().await?;
    reader.abort();
    let _ = reader.await;
    let written = writer.await?;
    let removed = tokio::fs::remove_dir_all(&config.paths.home).await;
    if let Err(error) = removed {
        ensure!(
            error.kind() == std::io::ErrorKind::NotFound,
            "The container worker's private state could not be removed."
        );
    }
    served.map(|_| ()).and(released).and(written)
}
