use crate::product::{
    config::ConfigModule, events::EventsModule, lifecycle::LifecycleModule, runtime::RuntimeModule,
    secrets::SecretsModule,
};
use anyhow::{Context, Result};
#[cfg(windows)]
use happy_agent_supervisor::windows::{Child, Command};
use serde_json::{Value, json};
#[cfg(windows)]
use signals as libc;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
#[cfg(unix)]
use tokio::process::{Child, Command};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::Notify,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
#[path = "groups.rs"]
mod groups;
#[cfg(windows)]
#[path = "windows/groups.rs"]
mod groups;
#[path = "processes.rs"]
mod processes;
#[cfg(windows)]
#[path = "windows/shell.rs"]
mod shell_arguments;
#[cfg(windows)]
#[path = "windows/signals.rs"]
mod signals;
pub use processes::{ProcessEventListener, ProcessSubscription};
mod output;
#[cfg(unix)]
#[path = "pty.rs"]
mod pty;
#[cfg(windows)]
#[path = "windows/pty.rs"]
mod pty;
mod remote;
mod runner;
pub use runner::{NativeRunnerProcess, NativeRunnerProcessEvent};

const CAPTURE_BYTES: usize = 1024 * 1024;
const ACTIVE_PER_AGENT: usize = 64;
const RETAINED_SESSIONS: usize = 128;
type Catalog = Mutex<BTreeMap<u64, Arc<CommandSession>>>;

/// An internal part of Tools, with no restart replay for external process effects.
/// The process task belongs to the module lifetime; caller cancellation owns only
/// the initial wait. Later interactions borrow their own caller's cancellation.
pub(super) struct CommandSessions {
    config: Arc<ConfigModule>,
    lifecycle: Arc<LifecycleModule>,
    sessions: Arc<Catalog>,
    next: Arc<AtomicU64>,
    runtime: Arc<RuntimeModule>,
    secrets: Arc<SecretsModule>,
    processes: Arc<processes::Processes>,
    groups: Arc<groups::Groups>,
    abort_epochs: Mutex<BTreeMap<String, Weak<AtomicU64>>>,
    remote: remote::Commands,
    runner_events: tokio::sync::broadcast::Sender<(String, Value)>,
}
struct CommandSession {
    kind: SessionKind,
    owner: String,
    id: u64,
    command: String,
    started_at: u64,
    cwd: String,
    terminal: Option<pty::Control>,
    stream: Option<tokio::sync::mpsc::Sender<NativeRunnerProcessEvent>>,
    runner_events: Option<tokio::sync::broadcast::Sender<(String, Value)>>,
    consuming_waiters: AtomicU64,
    exit_observed: std::sync::atomic::AtomicBool,
    uses_secrets: bool,
    group: Arc<groups::Group>,
    _abort_epoch: Arc<AtomicU64>,
    stdin: tokio::sync::Mutex<Option<Box<dyn AsyncWrite + Unpin + Send>>>,
    state: Mutex<Output>,
    read: tokio::sync::Mutex<()>,
    complete: Notify,
    stop: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionKind {
    Tool,
    RunnerShell,
    RunnerProgram,
}
struct Output {
    stdout: output::BoundedOutput,
    stderr: output::BoundedOutput,
    finished: bool,
    exit: Option<i32>,
    cleanup_error: Option<String>,
    retained: Option<(output::BoundedOutput, output::BoundedOutput)>,
    timed_out: bool,
    killed: bool,
}
impl Output {
    fn new(maximum: usize) -> Self {
        Self {
            stdout: output::BoundedOutput::new(maximum),
            stderr: output::BoundedOutput::new(maximum),
            finished: false,
            exit: None,
            cleanup_error: None,
            retained: None,
            timed_out: false,
            killed: false,
        }
    }
}
pub(super) struct Snapshot {
    process_session: Option<Arc<CommandSession>>,
    pub command: String,
    pub session: u64,
    pub stdout: String,
    pub stderr: String,
    pub dropped: usize,
    pub finished: bool,
    pub exit: Option<i32>,
    pub wall_time: f64,
}
impl Snapshot {
    pub fn status(&self) -> &'static str {
        if !self.finished {
            "running"
        } else if self.exit.is_none() {
            "killed"
        } else {
            "completed"
        }
    }
    pub fn produced(&self) -> String {
        [self.stdout.as_str(), self.stderr.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
    pub fn codex(&self, arguments: &Value) -> Value {
        let produced = self.produced();
        let tokens = (produced.len() + self.dropped).div_ceil(4);
        let budget = (arguments["max_output_tokens"]
            .as_f64()
            .unwrap_or(10_000.0)
            .min(10_000.0)
            * 4.0)
            .floor()
            .max(4000.0) as usize;
        let truncated = produced.encode_utf16().count() > budget;
        let shown = if truncated {
            truncate(&produced, budget, tokens)
        } else {
            produced
        };
        let mut result = json!({"command":self.command,"wall_time_seconds":self.wall_time,"output":if self.dropped>0{format!("[The machine dropped {} bytes of this session's output as it ran.]\n{shown}",self.dropped)}else{shown}});
        if self.finished {
            if let Some(code) = self.exit {
                result["exit_code"] = json!(code);
            }
        } else {
            result["session_id"] = json!(self.session);
        }
        if truncated || self.dropped > 0 {
            result["original_token_count"] = json!(tokens);
        }
        result
    }
}
impl CommandSessions {
    pub fn new(
        config: Arc<ConfigModule>,
        lifecycle: Arc<LifecycleModule>,
        runtime: Arc<RuntimeModule>,
        secrets: Arc<SecretsModule>,
        events: Arc<EventsModule>,
        runners: Arc<crate::product::owners::RunnersModule>,
        docker: Arc<crate::product::docker::DockerModule>,
    ) -> Result<Self> {
        let processes = Arc::new(processes::Processes::new()?);
        let next = Arc::new(AtomicU64::new(1));
        let _ = events;
        Ok(Self {
            remote: remote::Commands::new(
                runners,
                docker,
                lifecycle.clone(),
                processes.clone(),
                next.clone(),
            ),
            config,
            lifecycle,
            sessions: Arc::new(Mutex::new(BTreeMap::new())),
            next,
            runtime,
            secrets,
            processes,
            groups: Arc::new(groups::Groups::default()),
            abort_epochs: Mutex::new(BTreeMap::new()),
            runner_events: tokio::sync::broadcast::channel(1024).0,
        })
    }
    pub async fn start(
        &self,
        agent: &str,
        configuration: &Value,
        mode: &str,
        arguments: &Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let wait = arguments["yield_time_ms"]
            .as_f64()
            .unwrap_or(10_000.0)
            .clamp(250.0, 30_000.0) as u64;
        Ok(self
            .start_snapshot(
                agent,
                configuration,
                mode,
                arguments,
                wait,
                CAPTURE_BYTES,
                cancel,
            )
            .await?
            .codex(arguments))
    }
    pub async fn start_snapshot(
        &self,
        agent: &str,
        configuration: &Value,
        mode: &str,
        arguments: &Value,
        wait: u64,
        capture_limit: usize,
        cancel: CancellationToken,
    ) -> Result<Snapshot> {
        anyhow::ensure!(!cancel.is_cancelled(), "The command was interrupted.");
        if configuration["modules"]["compute"]["runnerId"].is_string()
            || configuration["modules"]["compute"].get("docker").is_some()
        {
            let mut arguments = arguments.clone();
            if configuration["modules"]["compute"].get("docker").is_some()
                && !configuration["modules"]["compute"]["runnerId"].is_string()
            {
                let mut targets = vec![json!({"type":"agent","id":agent})];
                for (field, kind) in [("projectId", "project"), ("workspaceId", "workspace")] {
                    if let Some(id) =
                        configuration["modules"]["compute"]["secretScope"][field].as_str()
                    {
                        targets.push(json!({"type":kind,"id":id}));
                    }
                }
                let selected = arguments.get("secrets").cloned().unwrap_or(json!([]));
                let secrets = self.secrets.clone();
                let targets = json!(targets);
                arguments["_computeSecretEnvironment"] = self
                    .runtime
                    .transact(move |ctx| {
                        secrets.resolve_for_command_targets(ctx, &targets, &selected)
                    })
                    .await?;
            }
            return self
                .remote
                .start(
                    agent,
                    configuration,
                    mode,
                    &arguments,
                    wait,
                    capture_limit,
                    cancel,
                )
                .await;
        }
        self.remote.assert_local()?;
        self.start_local_snapshot(
            agent,
            configuration,
            mode,
            arguments,
            wait,
            capture_limit,
            cancel,
            None,
            None,
        )
        .await
    }
    async fn start_local_snapshot(
        &self,
        agent: &str,
        configuration: &Value,
        mode: &str,
        arguments: &Value,
        wait: u64,
        capture_limit: usize,
        cancel: CancellationToken,
        runner: Option<&Value>,
        stream: Option<tokio::sync::mpsc::Sender<NativeRunnerProcessEvent>>,
    ) -> Result<Snapshot> {
        anyhow::ensure!(!cancel.is_cancelled(), "The command was interrupted.");
        let epoch = {
            let mut epochs = self
                .abort_epochs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            epochs.retain(|_, epoch| epoch.strong_count() > 0);
            if let Some(epoch) = epochs.get(agent).and_then(Weak::upgrade) {
                epoch
            } else {
                let epoch = Arc::new(AtomicU64::new(0));
                epochs.insert(agent.into(), Arc::downgrade(&epoch));
                epoch
            }
        };
        let generation = epoch.load(Ordering::Acquire);
        let environment = self
            .config
            .execution_environment(configuration, arguments)?;
        let (root, cwd, shell) = (environment.root, environment.cwd, environment.shell);
        anyhow::ensure!(
            mode == "full_access" || cwd.starts_with(&root),
            "The command's working directory is outside its workspace."
        );
        let cmd = arguments["cmd"]
            .as_str()
            .context("The shell command is missing.")?;
        let mut targets = vec![json!({"type":"agent","id":agent})];
        for (field, kind) in [("projectId", "project"), ("workspaceId", "workspace")] {
            if let Some(id) = configuration["modules"]["compute"]["secretScope"][field].as_str() {
                targets.push(json!({"type":kind,"id":id}));
            }
        }
        let targets = json!(targets);
        let selected = arguments
            .get("secrets")
            .cloned()
            .unwrap_or_else(|| json!([]));
        let uses_secrets = arguments["_runnerSecretEnvironment"]
            .as_object()
            .is_some_and(|values| !values.is_empty())
            || selected
                .as_array()
                .is_some_and(|selected| !selected.is_empty());
        let secrets = self.secrets.clone();
        let provisioned = if runner.is_some() {
            let mut hidden = arguments["_runnerHiddenEnvironment"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            hidden.extend([
                json!("HAPPY_RUNNER_TOKEN"),
                json!("HAPPY_RUNNER_ENDPOINT"),
                json!("HAPPY_CONTAINER_WORKER"),
            ]);
            json!({"hiddenEnvironmentVariables":hidden,"environment":arguments.get("_runnerSecretEnvironment").cloned().unwrap_or(json!({}))})
        } else {
            self.runtime
                .transact(move |ctx| secrets.resolve_for_command_targets(ctx, &targets, &selected))
                .await?
        };
        let hidden = provisioned["hiddenEnvironmentVariables"]
            .as_array()
            .context("The secret environment exclusions are missing.")?
            .iter()
            .map(|name| {
                name.as_str()
                    .context("A secret environment exclusion is invalid.")
                    .map(str::to_ascii_lowercase)
            })
            .collect::<Result<std::collections::BTreeSet<_>>>()?;
        let additions = provisioned["environment"]
            .as_object()
            .context("The selected secret environment is missing.")?;
        let policy = if let Some(request) = runner {
            self.config
                .runner_shell_policy(request, &arguments["permissions"])?
        } else {
            json!({"mode":mode,"allowedReadPaths":[],"allowedWritePaths":if mode=="workspace_write"||mode=="auto"{vec![root.clone()]}else{vec![]},"deniedReadPaths":[],"deniedWritePaths":if mode=="full_access"{vec![]}else{vec![root.join(".git"),root.join("AGENTS.md"),root.join("AGENTS_SECURITY.md"),root.join("happy.toml") ]},"network":{"egress":mode=="full_access","allowedHosts":[],"localBinding":mode=="full_access"}})
        };
        {
            // Source's unrestricted path has no supervisor or namespace setup.
            // The mode is supplied by the shared permission execution scope.
            let program = arguments["_runnerProgram"].as_str();
            #[cfg(unix)]
            let mut command = if mode == "full_access" {
                Command::new(program.unwrap_or(&shell))
            } else {
                let mut supervisor = Command::from(happy_agent_supervisor::command()?);
                supervisor
                    .arg("--policy")
                    .arg(policy.to_string())
                    .arg("--")
                    .arg(&shell);
                supervisor
            };
            #[cfg(windows)]
            let mut command = {
                happy_agent_supervisor::windows::require_full_access(mode)?;
                Command::new(program.unwrap_or(&shell))
            };
            #[cfg(windows)]
            let _ = policy;
            for (name, _) in std::env::vars_os() {
                if hidden.contains(&name.to_string_lossy().to_ascii_lowercase()) {
                    command.env_remove(name);
                }
            }
            for (name, value) in additions {
                command.env(
                    name,
                    value
                        .as_str()
                        .context("A selected secret environment value is invalid.")?,
                );
            }
            if let Some(program) = program {
                anyhow::ensure!(
                    runner.is_some() && mode == "full_access",
                    "Native product programs require their owned Full access compute."
                );
                let _ = program;
                for argument in arguments["_runnerArgs"].as_array().into_iter().flatten() {
                    command.arg(
                        argument
                            .as_str()
                            .context("The native process argument is invalid.")?,
                    );
                }
                for (name, value) in arguments["_runnerEnvironment"]
                    .as_object()
                    .into_iter()
                    .flatten()
                {
                    if let Some(value) = value.as_str() {
                        command.env(name, value);
                    } else {
                        command.env_remove(name);
                    }
                }
                // Runner credentials never become a product program's environment.
                command
                    .env_remove("HAPPY_RUNNER_TOKEN")
                    .env_remove("HAPPY_RUNNER_ENDPOINT");
            } else {
                let command_text = if runner.is_some() && mode != "full_access" && cwd != root {
                    format!(
                        "cd '{}' && {cmd}",
                        cwd.to_string_lossy().replace('\'', "'\\''")
                    )
                } else {
                    cmd.to_owned()
                };
                #[cfg(unix)]
                command.arg("-lc").arg(command_text);
                #[cfg(windows)]
                shell_arguments::arguments(&mut command, &shell, &command_text);
            }
            command.current_dir(if runner.is_some() && mode != "full_access" {
                &root
            } else {
                &cwd
            });
            #[cfg(unix)]
            {
                command
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true);
                use std::os::unix::process::CommandExt;
                unsafe {
                    command.as_std_mut().pre_exec(|| {
                        if libc::setsid() < 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        #[cfg(target_os = "linux")]
                        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
            }
            let terminal = if arguments["tty"] == true {
                Some(if program.is_some() {
                    pty::attach_product(
                        &mut command,
                        arguments["_runnerTerminal"]["cols"].as_u64().unwrap_or(80) as u16,
                        arguments["_runnerTerminal"]["rows"].as_u64().unwrap_or(24) as u16,
                        arguments["_runnerTerminal"]["name"]
                            .as_str()
                            .unwrap_or("xterm-256color"),
                    )?
                } else {
                    pty::attach(&mut command)?
                })
            } else {
                None
            };
            let began = Instant::now();
            let kind = if stream.is_some() {
                SessionKind::RunnerProgram
            } else if runner.is_some() {
                SessionKind::RunnerShell
            } else {
                SessionKind::Tool
            };
            let session = {
                let mut sessions = self
                    .sessions
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                trim(&mut sessions);
                let active: Vec<_> = sessions
                    .values()
                    .filter(|session| {
                        session.owner == agent
                            && session.kind == kind
                            && !session.finished()
                            && !session.stop.is_cancelled()
                    })
                    .cloned()
                    .collect();
                if kind != SessionKind::RunnerProgram && active.len() >= ACTIVE_PER_AGENT {
                    active[0].stop.cancel();
                }
                anyhow::ensure!(
                    kind != SessionKind::Tool
                        || sessions
                            .values()
                            .filter(|session| session.kind == SessionKind::Tool)
                            .count()
                            < RETAINED_SESSIONS,
                    "No more background commands can run at once."
                );
                anyhow::ensure!(
                    kind != SessionKind::RunnerProgram
                        || sessions
                            .values()
                            .filter(|session| session.kind == SessionKind::RunnerProgram)
                            .count()
                            < 256,
                    "No more product programs can run at once."
                );
                self.groups.reserve()?;
                anyhow::ensure!(
                    !cancel.is_cancelled(),
                    "The command was interrupted before it started."
                );
                anyhow::ensure!(
                    epoch.load(Ordering::Acquire) == generation,
                    "The command was interrupted before it started."
                );
                let mut child = command.spawn()?;
                // The parent's copy of the slave must not keep terminal EOF
                // from arriving when the process closes its descriptors.
                drop(command);
                let (stdin, stdout, stderr, terminal): (
                    Box<dyn AsyncWrite + Unpin + Send>,
                    Box<dyn AsyncRead + Unpin + Send>,
                    Option<Box<dyn AsyncRead + Unpin + Send>>,
                    Option<pty::Control>,
                ) = match terminal {
                    Some((reader, writer, control)) => {
                        (Box::new(writer), Box::new(reader), None, Some(control))
                    }
                    None => (
                        Box::new(
                            child
                                .stdin
                                .take()
                                .context("The command input pipe is unavailable.")?,
                        ),
                        Box::new(
                            child
                                .stdout
                                .take()
                                .context("The command output pipe is unavailable.")?,
                        ),
                        Some(Box::new(
                            child
                                .stderr
                                .take()
                                .context("The command error pipe is unavailable.")?,
                        )),
                        None,
                    ),
                };
                let id = self.next.fetch_add(1, Ordering::Relaxed);
                let pid = child
                    .id()
                    .context("The command process identity is unavailable.")?;
                #[cfg(unix)]
                let group = self.groups.retain(pid, agent);
                #[cfg(windows)]
                let group = self
                    .groups
                    .retain(pid, agent, child.job(), terminal.clone());
                let session = Arc::new(CommandSession {
                    kind,
                    owner: agent.into(),
                    id,
                    command: cmd.into(),
                    started_at: crate::product::identity::now(),
                    cwd: cwd.to_string_lossy().into_owned(),
                    terminal,
                    stream: stream.clone(),
                    runner_events: runner
                        .filter(|_| stream.is_none() && arguments["_runnerQuiet"] != true)
                        .map(|_| self.runner_events.clone()),
                    consuming_waiters: AtomicU64::new(0),
                    exit_observed: std::sync::atomic::AtomicBool::new(false),
                    uses_secrets,
                    group,
                    _abort_epoch: epoch.clone(),
                    stdin: tokio::sync::Mutex::new(Some(stdin)),
                    state: Mutex::new({
                        let mut output = Output::new(if kind == SessionKind::RunnerProgram {
                            0
                        } else {
                            capture_limit
                        });
                        if kind == SessionKind::RunnerShell {
                            output.retained = Some((
                                output::BoundedOutput::new(capture_limit),
                                output::BoundedOutput::new(capture_limit),
                            ));
                        }
                        output
                    }),
                    read: tokio::sync::Mutex::new(()),
                    complete: Notify::new(),
                    stop: CancellationToken::new(),
                    task: Mutex::new(None),
                });
                let owned = session.clone();
                let catalog = Arc::downgrade(&self.sessions);
                let root = self.lifecycle.shutdown.child_token();
                let processes = self.processes.clone();
                let timeout = runner.filter(|_| stream.is_none()).map(|_| {
                    Duration::from_millis(arguments["timeoutMs"].as_u64().unwrap_or(120_000))
                });
                let task = tokio::spawn(async move {
                    let out_session = owned.clone();
                    let err_session = owned.clone();
                    let stdout =
                        tokio::spawn(async move { capture(stdout, out_session, false).await });
                    let stderr = tokio::spawn(async move {
                        if let Some(stderr) = stderr {
                            capture(stderr, err_session, true).await
                        } else {
                            Ok(())
                        }
                    });
                    supervise(
                        child, owned, catalog, root, stdout, stderr, processes, timeout,
                    )
                    .await;
                });
                *session
                    .task
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(task);
                sessions.insert(id, session.clone());
                if kind != SessionKind::Tool {
                    trim(&mut sessions);
                }
                session
            };
            if runner.is_some() {
                if session.runner_events.is_some() {
                    let _ = self
                        .runner_events
                        .send((agent.to_owned(), json!({"event":"shell.sessions"})));
                }
                return Ok(Snapshot {
                    process_session: if kind == SessionKind::RunnerProgram {
                        Some(session.clone())
                    } else {
                        None
                    },
                    command: session.command.clone(),
                    session: session.id,
                    stdout: String::new(),
                    stderr: String::new(),
                    dropped: 0,
                    finished: session.finished(),
                    exit: None,
                    wall_time: began.elapsed().as_secs_f64(),
                });
            }
            let result = session.collect_snapshot(wait, began, &cancel).await;
            if result.is_err() {
                session.stop.cancel();
                session.wait_finished().await;
            } else if result.as_ref().is_ok_and(|result| !result.finished) {
                self.processes.detach(&session).await?;
            }
            result
        }
    }
    fn session(&self, agent: &str, id: u64) -> Result<Arc<CommandSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&id)
            .filter(|session| session.owner == agent)
            .cloned()
            .with_context(|| format!("There is no command {id} on this machine."))
    }
    pub fn uses_secrets(&self, agent: &str, id: u64) -> bool {
        self.session(agent, id)
            .is_ok_and(|session| session.uses_secrets)
            || self.remote.uses_secrets(agent, id)
    }
    pub fn contains(&self, agent: &str, id: u64) -> bool {
        self.session(agent, id).is_ok() || self.remote.contains(agent, id)
    }
    #[cfg(test)]
    pub async fn input(
        &self,
        agent: &str,
        id: u64,
        arguments: &Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.input_with_mode(agent, id, "full_access", arguments, cancel)
            .await
    }
    pub async fn input_with_mode(
        &self,
        agent: &str,
        id: u64,
        mode: &str,
        arguments: &Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let typing = arguments["chars"]
            .as_str()
            .is_some_and(|chars| !chars.is_empty());
        let wait = arguments["yield_time_ms"]
            .as_f64()
            .unwrap_or(if typing { 250.0 } else { 5000.0 })
            .clamp(0.0, if typing { 30_000.0 } else { 300_000.0 }) as u64;
        Ok(self
            .input_snapshot(agent, id, mode, arguments, wait, cancel)
            .await?
            .codex(arguments))
    }
    pub async fn input_snapshot(
        &self,
        agent: &str,
        id: u64,
        mode: &str,
        arguments: &Value,
        wait: u64,
        cancel: CancellationToken,
    ) -> Result<Snapshot> {
        if self.remote.contains(agent, id) {
            return self
                .remote
                .input(agent, id, mode, arguments, wait, cancel)
                .await;
        }
        let began = Instant::now();
        let session = self.session(agent, id)?;
        let chars = arguments["chars"].as_str().unwrap_or("");
        let typing = !chars.is_empty();
        if typing {
            anyhow::ensure!(
                !session.finished(),
                "Command {id} is not running, so there is nothing to type into."
            );
            let mut stdin = tokio::select! { biased; _ = cancel.cancelled() => anyhow::bail!("The command input was interrupted."), input = session.stdin.lock() => input };
            let stdin = stdin.as_mut().with_context(|| {
                format!("Command {id} is not running, so there is nothing to type into.")
            })?;
            tokio::select! {result=stdin.write_all(chars.as_bytes())=>result?,_=cancel.cancelled()=>anyhow::bail!("The command input was interrupted.")};
        }
        session.collect_snapshot(wait, began, &cancel).await
    }
    pub async fn stop(&self, agent: &str, id: u64) -> Result<(String, bool)> {
        if self.remote.contains(agent, id) {
            return self.remote.stop(agent, id, &CancellationToken::new()).await;
        }
        let session = self.session(agent, id)?;
        let stopped = !session.finished();
        if stopped {
            session.stop.cancel();
            session.wait_finished().await;
        }
        let state = session
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            state.cleanup_error.is_none(),
            "The command process group cleanup remains unconfirmed: {}",
            state.cleanup_error.as_deref().unwrap_or("unknown reason")
        );
        Ok((session.command.clone(), stopped))
    }
    pub fn list_processes(&self, agent: &str) -> Vec<Value> {
        self.processes.list(agent)
    }
    pub fn on_process_event(&self, listener: ProcessEventListener) -> Result<ProcessSubscription> {
        self.processes.on_event(listener)
    }
    pub fn process_agents(&self) -> Vec<String> {
        self.processes.agents()
    }
    pub fn running_processes(&self, agent: &str) -> usize {
        self.processes.running(agent)
    }
    pub async fn stop_process(&self, agent: &str, id: &str) -> Result<Option<Value>> {
        let Some((session, record)) = self.processes.find(agent, id) else {
            return Ok(None);
        };
        if record["status"] == "running" {
            self.stop(agent, session).await?;
            if self.remote.contains(agent, session) {
                return Ok(self.processes.find(agent, id).map(|(_, record)| record));
            }
            let owned = self.session(agent, session)?;
            let exit = owned
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .exit;
            self.processes.exit(session, exit).await?;
        }
        Ok(self.processes.find(agent, id).map(|(_, record)| record))
    }
    pub async fn close(&self) {
        self.remote.close().await;
        let sessions = std::mem::take(
            &mut *self
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        for session in sessions.values() {
            session.stop.cancel();
        }
        for session in sessions.values() {
            let task = session
                .task
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            if let Some(task) = task {
                let _ = task.await;
            }
        }
        if let Err(error) = self.groups.cleanup(None).await {
            eprintln!("Native command process cleanup remains unconfirmed: {error:#}");
        }
    }
    pub async fn stop_agent(&self, agent: &str) {
        if let Err(error) = self
            .remote
            .stop_agent(agent, &CancellationToken::new())
            .await
        {
            eprintln!("Runner command cleanup remains unconfirmed: {error:#}");
        }
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|session| session.owner == agent && !session.finished())
            .cloned()
            .collect();
        for session in &sessions {
            session.stop.cancel();
        }
        for session in sessions {
            session.wait_finished().await;
        }
        if let Err(error) = self.groups.cleanup(Some(agent)).await {
            eprintln!("Agent command process cleanup remains unconfirmed: {error:#}");
        }
    }
    pub async fn archive_agent(&self, agent: &str, cancel: &CancellationToken) -> Result<()> {
        self.remote.archive(agent, cancel).await?;
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|session| session.owner == agent)
            .cloned()
            .collect::<Vec<_>>();
        for session in &sessions {
            session.stop.cancel();
        }
        for session in &sessions {
            tokio::select! { biased; _ = cancel.cancelled() => anyhow::bail!("Archived agent process cleanup was interrupted and remains unconfirmed."), _ = session.wait_finished() => {} }
            let state = session
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            anyhow::ensure!(
                state.cleanup_error.is_none(),
                "Archived agent process cleanup remains unconfirmed: {}",
                state.cleanup_error.as_deref().unwrap_or("unknown reason")
            );
        }
        for session in &sessions {
            let task = session
                .task
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            if let Some(task) = task {
                task.await
                    .context("Archived command completion could not be confirmed.")?;
            }
        }
        tokio::select! { biased; _ = cancel.cancelled() => anyhow::bail!("Archived agent process cleanup was interrupted and remains unconfirmed."), result = self.groups.cleanup(Some(agent)) => result? }
        let mut catalog = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for session in sessions {
            if catalog
                .get(&session.id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                catalog.remove(&session.id);
            }
        }
        Ok(())
    }
    pub fn abort_snapshot(&self, agent: &str) -> Vec<(u64, String)> {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|session| session.owner == agent && !session.finished())
            .map(|session| (session.id, session.command.clone()))
            .collect::<Vec<_>>();
        sessions.extend(self.remote.running(agent));
        sessions
    }
    pub fn abort_process_trees(&self, agent: &str) -> usize {
        self.groups.count(agent) + self.remote.running(agent).len()
    }
    pub async fn hard_kill_agent(&self, agent: &str) -> Result<()> {
        if let Some(epoch) = self
            .abort_epochs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(agent)
            .and_then(Weak::upgrade)
        {
            epoch.fetch_add(1, Ordering::AcqRel);
        }
        self.processes.exit_all(agent).await?;
        self.remote
            .stop_agent(agent, &CancellationToken::new())
            .await?;
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|session| session.owner == agent)
            .cloned()
            .collect();
        self.groups.signal_owner(agent, libc::SIGKILL);
        for session in &sessions {
            if !session.finished() {
                session.stop.cancel();
            }
        }
        for session in &sessions {
            session.wait_finished().await;
            let state = session
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            anyhow::ensure!(
                state.cleanup_error.is_none(),
                "The command process group cleanup remains unconfirmed: {}",
                state.cleanup_error.as_deref().unwrap_or("unknown reason")
            );
        }
        self.groups.cleanup(Some(agent)).await?;
        Ok(())
    }
}
impl CommandSession {
    fn finished(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .finished
    }
    async fn wait_finished(&self) {
        loop {
            let notified = self.complete.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.finished() {
                return;
            }
            notified.await;
        }
    }
    async fn collect_snapshot(
        &self,
        wait: u64,
        began: Instant,
        cancel: &CancellationToken,
    ) -> Result<Snapshot> {
        let _read = tokio::select! {read=self.read.lock()=>read,_=cancel.cancelled()=>anyhow::bail!("The command read was interrupted.")};
        if !self.finished() && wait > 0 {
            tokio::select! {_=self.wait_finished()=>{},_=tokio::time::sleep(Duration::from_millis(wait))=>{},_=cancel.cancelled()=>anyhow::bail!("The command read was interrupted.")};
        }
        anyhow::ensure!(!cancel.is_cancelled(), "The command read was interrupted.");
        let mut output = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (stdout, stdout_dropped) = output.stdout.drain();
        let (stderr, stderr_dropped) = output.stderr.drain();
        let dropped = stdout_dropped + stderr_dropped;
        Ok(Snapshot {
            process_session: None,
            command: self.command.clone(),
            session: self.id,
            stdout,
            stderr,
            dropped,
            finished: output.finished,
            exit: output.exit,
            wall_time: began.elapsed().as_secs_f64(),
        })
    }
}
async fn capture(
    mut reader: impl AsyncRead + Unpin,
    session: Arc<CommandSession>,
    error: bool,
) -> Result<()> {
    let mut buffer = [0; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            return Ok(());
        }
        {
            let mut output = session
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let output = &mut *output;
            let stream = if error {
                &mut output.stderr
            } else {
                &mut output.stdout
            };
            stream.append(&buffer[..count]);
            if let Some((stdout, stderr)) = &mut output.retained {
                if error {
                    stderr.append(&buffer[..count]);
                } else {
                    stdout.append(&buffer[..count]);
                }
            }
        }
        if let Some(stream) = &session.stream {
            let event = NativeRunnerProcessEvent::Data {
                error,
                bytes: buffer[..count].to_vec(),
            };
            tokio::select! {result=stream.send(event)=>{if result.is_err(){return Ok(());}},_=session.stop.cancelled()=>return Ok(())}
        }
    }
}
async fn supervise(
    mut child: Child,
    session: Arc<CommandSession>,
    catalog: Weak<Catalog>,
    root: CancellationToken,
    stdout: JoinHandle<Result<()>>,
    stderr: JoinHandle<Result<()>>,
    processes: Arc<processes::Processes>,
    timeout: Option<Duration>,
) {
    let deadline = async {
        if let Some(timeout) = timeout {
            tokio::time::sleep(timeout).await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    let (status, stopped) = tokio::select! {
        status=child.wait()=>(status,false),
        _=session.stop.cancelled()=>(terminate(&mut child,&session.group).await,true),
        _=root.cancelled()=>(terminate(&mut child,&session.group).await,true),
        _=deadline=>{
            session.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).timed_out=true;
            tokio::select! {status=child.wait()=>(status,false),_=session.stop.cancelled()=>(terminate(&mut child,&session.group).await,true),_=root.cancelled()=>(terminate(&mut child,&session.group).await,true)}
        }
    };
    if status.is_ok() {
        session.group.leader_reaped();
    } else {
        session.group.leader_unconfirmed();
    }
    // A descendant may retain a pipe after its parent exits. Drain ordinary EOF,
    // then close our streams without killing work a completed shell left running.
    let cancel_stdout = stdout.abort_handle();
    let cancel_stderr = stderr.abort_handle();
    let mut drain = tokio::spawn(async move { tokio::join!(stdout, stderr) });
    let drained = if session.stream.is_some() && !stopped {
        tokio::select! {_=&mut drain=>true,_=session.stop.cancelled()=>false,_=root.cancelled()=>false}
    } else {
        tokio::time::timeout(Duration::from_millis(250), &mut drain)
            .await
            .is_ok()
    };
    if !drained {
        cancel_stdout.abort();
        cancel_stderr.abort();
        let _ = drain.await;
    }
    let cleanup_error = if stopped {
        session
            .group
            .cleanup(true)
            .await
            .err()
            .map(|error| format!("{error:#}"))
    } else {
        None
    };
    *session.stdin.lock().await = None;
    {
        let mut output = session
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        output.exit = status.as_ref().ok().and_then(|status| status.code());
        output.cleanup_error = cleanup_error;
        if let Err(ref error) = status {
            output
                .stderr
                .append(format!("The command could not be completed: {error}").as_bytes());
            output.exit = Some(1);
        }
        output.finished = true;
        output.killed = stopped;
    }
    if let Err(error) = processes
        .exit(
            session.id,
            status.as_ref().ok().and_then(|status| status.code()),
        )
        .await
    {
        eprintln!("Could not publish native process completion: {error:#}");
    }
    let awaited = session.consuming_waiters.load(Ordering::Acquire) > 0;
    session.complete.notify_waiters();
    if let Some(events) = &session.runner_events {
        let state = session
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _ = events.send((session.owner.clone(), json!({"event":"shell.sessions"})));
        if !awaited && !session.exit_observed.load(Ordering::Acquire) {
            let _=events.send((session.owner.clone(),json!({"event":"shell.exit","exit":{"command":session.command,"sessionId":session.id,"exitCode":state.exit,"status":if state.killed{"killed"}else{"completed"}}})));
        }
    }
    if let Some(stream) = &session.stream {
        #[cfg(unix)]
        let signal = {
            use std::os::unix::process::ExitStatusExt;
            status
                .as_ref()
                .ok()
                .and_then(|status| status.signal())
                .and_then(runner::signal_name)
                .map(str::to_owned)
        };
        #[cfg(not(unix))]
        let signal = None;
        let event = NativeRunnerProcessEvent::Exit {
            code: status.as_ref().ok().and_then(|status| status.code()),
            signal,
        };
        let _ = tokio::select! {result=stream.send(event)=>result,_=root.cancelled()=>Err(tokio::sync::mpsc::error::SendError(NativeRunnerProcessEvent::Exit{code:None,signal:None}))};
    }
    if let Some(catalog) = catalog.upgrade() {
        trim(
            &mut catalog
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
    }
}
async fn terminate(
    child: &mut Child,
    group: &groups::Group,
) -> std::io::Result<std::process::ExitStatus> {
    group.signal(libc::SIGTERM)?;
    match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(status) => status,
        Err(_) => {
            group.signal(libc::SIGKILL)?;
            tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .map_err(|_| {
                    std::io::Error::other(
                        "The command leader did not exit after forceful termination.",
                    )
                })?
        }
    }
}
fn trim(sessions: &mut BTreeMap<u64, Arc<CommandSession>>) {
    while sessions
        .values()
        .filter(|session| session.kind == SessionKind::Tool)
        .count()
        >= RETAINED_SESSIONS
    {
        let finished = sessions
            .iter()
            .find(|(_, session)| session.kind == SessionKind::Tool && session.finished())
            .map(|(id, _)| *id);
        if let Some(id) = finished {
            sessions.remove(&id);
        } else {
            break;
        }
    }
    let mut shells = BTreeMap::<String, Vec<u64>>::new();
    for (id, session) in sessions.iter() {
        if session.kind == SessionKind::RunnerShell {
            shells.entry(session.owner.clone()).or_default().push(*id);
        }
    }
    for ids in shells.values() {
        let mut excess = ids.len().saturating_sub(64);
        for id in ids {
            if excess == 0 {
                break;
            }
            if sessions.get(id).is_some_and(|session| session.finished()) {
                sessions.remove(id);
                excess -= 1;
            }
        }
    }
    sessions.retain(|_, session| session.kind != SessionKind::RunnerProgram || !session.finished());
}
fn truncate(value: &str, max: usize, tokens: usize) -> String {
    let prefix = format!(
        "Warning: truncated output (original token count: {tokens})\nTotal output lines: {}\n\n",
        value.split('\n').count()
    );
    let marker = "\n… output truncated …\n";
    let remaining =
        max.saturating_sub(prefix.encode_utf16().count() + marker.encode_utf16().count());
    let head = utf16_prefix(value, remaining.div_ceil(2));
    let tail = utf16_suffix(value, remaining / 2);
    format!("{prefix}{head}{marker}{tail}")
}
fn utf16_prefix(value: &str, limit: usize) -> String {
    value
        .chars()
        .scan(0, |units, character| {
            *units += character.len_utf16();
            (*units <= limit).then_some(character)
        })
        .collect()
}
fn utf16_suffix(value: &str, limit: usize) -> String {
    value
        .chars()
        .rev()
        .scan(0, |units, character| {
            *units += character.len_utf16();
            (*units <= limit).then_some(character)
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

#[cfg(test)]
mod tests;
