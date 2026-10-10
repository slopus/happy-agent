mod agents;
mod agent_runtime;
mod api;
mod auto;
mod bots;
mod cloud;
mod collaboration;
mod connections;
mod config;
mod durable;
mod events;
mod filesystem;
mod goal;
mod history;
mod identity;
mod journal;
mod lifecycle;
mod live;
mod owners;
mod permissions;
mod presence;
mod profile;
mod process;
mod projects;
mod provider_scan;
mod runtime;
mod scheduling;
mod services;
mod secrets;
mod skill_folders;
mod skills;
mod subtasks;
mod schemas;
mod tools;
mod tailcat;
mod tasks;
mod titles;
mod transport;
mod usage;
mod user_input;
mod workspaces;
pub(crate) mod workflows;

pub use config::ConfigModule;
pub use lifecycle::{LifecycleModule, command};

pub(crate) fn compute_regex_worker()->std::process::ExitCode { tools::compute_regex_worker() }

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
    process::prepare_child_reaping()?;
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
    let durable = Arc::new(durable::DurableFunctionsModule::new(runtime.clone(), lifecycle.clone())?);
    let provider_scan=provider_scan::ProviderScanModule::new(config.clone(),durable.clone(),lifecycle.clone())?;
    let secrets = secrets::SecretsModule::new(config.clone(), runtime.clone(), durable.clone(), events.clone())?;
    let services = services::ServicesModule::new(config.clone(), runtime.clone(), durable.clone(), lifecycle.clone(), events.clone())?;
    let runners = owners::RunnersModule::new(config.clone(), runtime.clone(), lifecycle.clone())?;
    let tools = Arc::new(tools::ToolsModule::new(
        config.clone(),
        history.clone(),
        lifecycle.clone(),
        runtime.clone(),
        secrets.clone(),
        services.clone(),
        events.clone(),
        runners.clone(),
    )?);
    let node = owners::NodeModule::new(config.clone(), runtime.clone(), durable.clone(), events.clone())?;
    let skills = owners::GlobalSkillsModule::new(config.clone(), runtime.clone(), durable.clone(), events.clone())?;
    let auto = auto::AutoModule::new(config.clone(), runtime.clone(), durable.clone(), tools.clone(), lifecycle.clone())?;
    let permissions = Arc::new(permissions::PermissionsModule::new(auto.clone(), runtime.clone(), history.clone())?);
    let agent_runtime = Arc::new(agent_runtime::AgentRuntimeModule::new(config.clone(), runtime.clone(), history.clone(), tools.clone(), usage.clone(), lifecycle.clone(), auto.clone(), permissions, events.clone()));
    let _agent_skills=skills::SkillsModule::new(config.clone(),tools.clone(),skills.clone(),runtime.clone(),agent_runtime.clone())?;
    let cloud = cloud::CloudModule::new(config.clone(), runtime.clone(), durable.clone(), lifecycle.clone(), events.clone())?;
    let git = owners::GitModule::new(config.clone(), runners.clone())?;
    let abort = owners::AbortModule::new(runtime.clone(), agent_runtime.clone(), tools.clone(), services.clone());
    let projects = projects::ProjectsModule::install(config.clone(), runtime.clone(), git.clone(), abort.clone(), durable.clone(), runners.clone(), services.clone(), events.clone())?;
    let workspaces = workspaces::WorkspacesModule::install(config.clone(), runtime.clone(), projects.clone(), git.clone(), abort.clone(), durable.clone(), runners.clone(), services.clone(), events.clone())?;
    let titles = titles::TitlesModule::new(config.clone(), durable.clone(), lifecycle.clone(), runtime.clone(), agent_runtime.clone(), history.clone(), workspaces.clone())?;
    let bots = bots::BotsModule::new(config.clone(), runtime.clone(), agent_runtime.clone(), abort.clone(), titles.clone(), projects.clone(), workspaces.clone(), runners.clone(), durable.clone(), events.clone(), lifecycle.clone())?;
    let _skill_folders=skill_folders::SkillFoldersModule::new(config.clone(),bots.clone(),runtime.clone(),agent_runtime.clone())?;
    let profile=profile::ProfileModule::new(config.clone(),bots.clone(),runtime.clone(),durable.clone(),agent_runtime.clone())?;
    let collaboration = collaboration::CollaborationModule::new(config.clone(), runtime.clone(), agent_runtime.clone(), abort.clone(), history.clone(), durable.clone(), lifecycle.clone())?;
    let _subtasks = subtasks::SubtasksModule::new(config.clone(), runtime.clone(), agent_runtime.clone(), bots.clone(), collaboration.clone(), workspaces.clone(), durable.clone(), abort, tools.clone(), lifecycle.clone())?;
    let live = live::LiveModule::new(config.clone(), runtime.clone(), durable.clone(), agent_runtime.clone(), lifecycle.clone())?;
    agent_runtime.install(secrets.clone())?;
    let tailcat = tailcat::TailcatModule::new(config.clone(), bots.clone(), runtime.clone(), durable.clone(), agent_runtime.clone())?;
    let connections = connections::ConnectionsModule::new(config.clone(), bots.clone(), cloud.clone(), tailcat.clone(), durable.clone(), runtime.clone(), events.clone(), agent_runtime.clone())?;
    let presence = presence::PresenceModule::new(config.clone(), runtime.clone(), durable.clone(), lifecycle.clone(), agent_runtime.clone())?;
    let user_input = user_input::UserInputModule::new(presence.clone(), runtime.clone(), durable.clone(), agent_runtime.clone(), lifecycle.clone())?;
    let agents = Arc::new(agents::AgentSystemModule::new(
        config.clone(),
        runtime.clone(),
        events.clone(),
        history.clone(),
        usage.clone(),
        projects.clone(),
        workspaces.clone(),
        agent_runtime.clone(),
        tools.clone(),
        user_input.clone(),
    )?);
    let scheduling = scheduling::SchedulingModule::new(runtime.clone(),durable.clone(),agent_runtime.clone(),lifecycle.clone())?;
    let tasks=tasks::TasksModule::new(runtime.clone(),durable.clone(),agent_runtime.clone())?;
    let goal=goal::GoalModule::new(runtime.clone(),durable.clone(),agent_runtime.clone())?;
    let workflows=workflows::WorkflowsModule::new(config.clone(),collaboration.clone(),tools.clone(),runtime.clone(),durable.clone(),agent_runtime.clone(),lifecycle.clone())?;
    let api = api::ApiModule::new(
        config.clone(),
        lifecycle.clone(),
        events.clone(),
        agents.clone(),
        runtime.clone(),
        cloud.clone(),
        connections.clone(),
        secrets.clone(),
        projects.clone(),
        workspaces.clone(),
        bots.clone(),
        live.clone(),
        tools.clone(),
        user_input.clone(),
        auto.clone(),
        provider_scan.clone(),
        node.clone(),
        profile.clone(),
    )?;
    agent_runtime.prepare()?;
    // Health is available before storage restoration, on the same authenticated listener.
    let transport = transport::TransportModule::bind(config.clone(), api.clone()).await?;
    let server = tokio::spawn(transport.serve());
    let initialized = async {
        runtime.load().await?;
        lifecycle.set_database_open(true);
        events.load().await?;
        usage.load().await?;
        history.load().await?;
        durable.load().await?;
        provider_scan.open().await?;
        config.default_provider()?;
        secrets.load().await?;
        collaboration.load().await?;
        live.load().await?;
        runners.load().await?;
        projects.load().await?;
        workspaces.load().await?;
        bots.load().await?;
        services.load().await?;
        cloud.load().await?;
        node.load().await?;
        profile.load().await?;
        skills.load().await?;
        auto.load().await?;
        connections.load().await?;
        presence.load().await?;
        user_input.load().await?;
        scheduling.load().await?;
        tasks.load().await?;
        goal.load().await?;
        workflows.load().await?;
        #[cfg(unix)]
        tailcat.attach_transport(serde_json::json!({"socketPath":config.paths.socket})).await?;
        skills.start().await?;
        durable.start().await?;
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
    skills.close().await;
    durable.stop().await;
    agents.close().await;
    let service_closed = services.close().await;
    let live_closed = live.stop().await;
    let cloud_closed = cloud.close().await;
    let connections_closed = connections.close().await;
    let tailcat_closed = tailcat.close().await;
    titles.close().await;
    git.close().await;
    runners.close().await;
    let closed = runtime.close().await;
    if closed.is_ok() {
        lifecycle.set_database_open(false);
    }
    let cleaned = lifecycle.cleanup();
    initialized.and(served).and(service_closed).and(live_closed).and(cloud_closed).and(connections_closed).and(tailcat_closed).and(closed).and(cleaned)
}
