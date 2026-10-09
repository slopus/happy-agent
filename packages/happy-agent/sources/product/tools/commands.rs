use crate::product::{config::ConfigModule, lifecycle::LifecycleModule};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::Notify,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

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
    next: AtomicU64,
}
struct CommandSession {
    owner: String,
    id: u64,
    command: String,
    pid: u32,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    state: Mutex<Output>,
    read: tokio::sync::Mutex<()>,
    complete: Notify,
    stop: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}
#[derive(Default)]
struct Output {
    stdout: VecDeque<u8>,
    stderr: VecDeque<u8>,
    stdout_dropped: usize,
    stderr_dropped: usize,
    finished: bool,
    exit: Option<i32>,
}
impl CommandSessions {
    pub fn new(config: Arc<ConfigModule>, lifecycle: Arc<LifecycleModule>) -> Self {
        Self {
            config,
            lifecycle,
            sessions: Arc::new(Mutex::new(BTreeMap::new())),
            next: AtomicU64::new(1),
        }
    }
    pub async fn start(
        &self,
        agent: &str,
        configuration: &Value,
        mode: &str,
        arguments: &Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        anyhow::ensure!(!cancel.is_cancelled(), "The command was interrupted.");
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
        let policy = json!({"mode":mode,"allowedReadPaths":[],"allowedWritePaths":if mode=="workspace_write"||mode=="auto"{vec![root.clone()]}else{vec![]},"deniedReadPaths":[],"deniedWritePaths":if mode=="full_access"{vec![]}else{vec![root.join(".git"),root.join("AGENTS.md"),root.join("AGENTS_SECURITY.md"),root.join("happy.toml") ]},"network":{"egress":mode=="full_access","allowedHosts":[],"localBinding":mode=="full_access"}});
        #[cfg(windows)]
        anyhow::bail!("Native Windows command execution has not been migrated yet.");
        #[cfg(unix)]
        {
            let mut command = Command::from(happy_agent_supervisor::command()?);
            command
                .arg("--policy")
                .arg(policy.to_string())
                .arg("--")
                .arg(shell)
                .arg("-lc")
                .arg(cmd)
                .current_dir(&cwd)
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
            let began = Instant::now();
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
                            && !session.finished()
                            && !session.stop.is_cancelled()
                    })
                    .cloned()
                    .collect();
                if active.len() >= ACTIVE_PER_AGENT {
                    active[0].stop.cancel();
                }
                anyhow::ensure!(
                    sessions.len() < RETAINED_SESSIONS,
                    "No more background commands can run at once."
                );
                let mut child = command.spawn()?;
                let id = self.next.fetch_add(1, Ordering::Relaxed);
                let session = Arc::new(CommandSession {
                    owner: agent.into(),
                    id,
                    command: cmd.into(),
                    pid: child
                        .id()
                        .context("The command process identity is unavailable.")?,
                    stdin: tokio::sync::Mutex::new(child.stdin.take()),
                    state: Mutex::new(Output::default()),
                    read: tokio::sync::Mutex::new(()),
                    complete: Notify::new(),
                    stop: CancellationToken::new(),
                    task: Mutex::new(None),
                });
                let stdout = child
                    .stdout
                    .take()
                    .context("The command output pipe is unavailable.")?;
                let stderr = child
                    .stderr
                    .take()
                    .context("The command error pipe is unavailable.")?;
                let owned = session.clone();
                let catalog = Arc::downgrade(&self.sessions);
                let root = self.lifecycle.shutdown.child_token();
                let task = tokio::spawn(async move {
                    let out_session = owned.clone();
                    let err_session = owned.clone();
                    let stdout =
                        tokio::spawn(async move { capture(stdout, out_session, false).await });
                    let stderr =
                        tokio::spawn(async move { capture(stderr, err_session, true).await });
                    supervise(child, owned, catalog, root, stdout, stderr).await;
                });
                *session
                    .task
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(task);
                sessions.insert(id, session.clone());
                session
            };
            let wait = arguments["yield_time_ms"]
                .as_f64()
                .unwrap_or(10_000.0)
                .clamp(250.0, 30_000.0) as u64;
            let result = session.collect(wait, arguments, began, &cancel).await;
            if result.is_err() {
                session.stop.cancel();
                session.wait_finished().await;
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
    pub async fn input(
        &self,
        agent: &str,
        id: u64,
        arguments: &Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let began = Instant::now();
        let session = self.session(agent, id)?;
        let chars = arguments["chars"].as_str().unwrap_or("");
        let typing = !chars.is_empty();
        if typing {
            anyhow::ensure!(
                !session.finished(),
                "Command {id} is not running, so there is nothing to type into."
            );
            let mut stdin = session.stdin.lock().await;
            let stdin = stdin.as_mut().with_context(|| {
                format!("Command {id} is not running, so there is nothing to type into.")
            })?;
            tokio::select! {result=stdin.write_all(chars.as_bytes())=>result?,_=cancel.cancelled()=>anyhow::bail!("The command input was interrupted.")};
        }
        let wait = arguments["yield_time_ms"]
            .as_f64()
            .unwrap_or(if typing { 250.0 } else { 5000.0 })
            .clamp(0.0, if typing { 30_000.0 } else { 300_000.0 }) as u64;
        session.collect(wait, arguments, began, &cancel).await
    }
    pub async fn stop(&self, agent: &str, id: u64) -> Result<(String, bool)> {
        let session = self.session(agent, id)?;
        let stopped = !session.finished();
        if stopped {
            session.stop.cancel();
            session.wait_finished().await;
        }
        Ok((session.command.clone(), stopped))
    }
    pub async fn close(&self) {
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
    }
    pub async fn stop_agent(&self, agent: &str) {
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
    async fn collect(
        &self,
        wait: u64,
        arguments: &Value,
        began: Instant,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let _read = tokio::select! {read=self.read.lock()=>read,_=cancel.cancelled()=>anyhow::bail!("The command read was interrupted.")};
        if !self.finished() && wait > 0 {
            tokio::select! {_=self.wait_finished()=>{},_=tokio::time::sleep(Duration::from_millis(wait))=>{},_=cancel.cancelled()=>anyhow::bail!("The command read was interrupted.")};
        }
        anyhow::ensure!(!cancel.is_cancelled(), "The command read was interrupted.");
        let mut output = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let stdout =
            String::from_utf8_lossy(&output.stdout.drain(..).collect::<Vec<_>>()).into_owned();
        let stderr =
            String::from_utf8_lossy(&output.stderr.drain(..).collect::<Vec<_>>()).into_owned();
        let produced = [stdout, stderr]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let dropped =
            std::mem::take(&mut output.stdout_dropped) + std::mem::take(&mut output.stderr_dropped);
        let tokens = (produced.len() + dropped).div_ceil(4);
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
        let mut result = json!({"command":self.command,"wall_time_seconds":began.elapsed().as_secs_f64(),"output":if dropped>0{format!("[The machine dropped {dropped} bytes of this session's output as it ran.]\n{shown}")}else{shown}});
        if output.finished {
            if let Some(code) = output.exit {
                result["exit_code"] = json!(code);
            }
        } else {
            result["session_id"] = json!(self.id);
        }
        if truncated || dropped > 0 {
            result["original_token_count"] = json!(tokens);
        }
        Ok(result)
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
        let mut output = session
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let output = &mut *output;
        let (bytes, dropped) = if error {
            (&mut output.stderr, &mut output.stderr_dropped)
        } else {
            (&mut output.stdout, &mut output.stdout_dropped)
        };
        bytes.extend(&buffer[..count]);
        let excess = bytes.len().saturating_sub(CAPTURE_BYTES);
        bytes.drain(..excess);
        *dropped += excess;
    }
}
async fn supervise(
    mut child: Child,
    session: Arc<CommandSession>,
    catalog: Weak<Catalog>,
    root: CancellationToken,
    stdout: JoinHandle<Result<()>>,
    stderr: JoinHandle<Result<()>>,
) {
    let status = tokio::select! {status=child.wait()=>status,_=session.stop.cancelled()=>terminate(&mut child,session.pid).await,_=root.cancelled()=>terminate(&mut child,session.pid).await};
    // A descendant may retain a pipe after its parent exits. Drain ordinary EOF,
    // then tear down the whole group rather than waiting indefinitely on that pipe.
    let cancel_stdout = stdout.abort_handle();
    let cancel_stderr = stderr.abort_handle();
    let mut drain = tokio::spawn(async move { tokio::join!(stdout, stderr) });
    let drained = tokio::time::timeout(Duration::from_millis(250), &mut drain).await;
    kill_group(session.pid, libc::SIGKILL);
    if drained.is_err() {
        cancel_stdout.abort();
        cancel_stderr.abort();
        let _ = drain.await;
    }
    let mut output = session
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    output.exit = status.as_ref().ok().and_then(|status| status.code());
    if let Err(error) = status {
        output
            .stderr
            .extend(format!("The command could not be completed: {error}").as_bytes());
        output.exit = Some(1);
    }
    output.finished = true;
    drop(output);
    session.complete.notify_waiters();
    if let Some(catalog) = catalog.upgrade() {
        trim(
            &mut catalog
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
    }
}
async fn terminate(child: &mut Child, pid: u32) -> std::io::Result<std::process::ExitStatus> {
    kill_group(pid, libc::SIGTERM);
    match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(status) => status,
        Err(_) => {
            kill_group(pid, libc::SIGKILL);
            child.wait().await
        }
    }
}
fn kill_group(pid: u32, signal: i32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}
fn trim(sessions: &mut BTreeMap<u64, Arc<CommandSession>>) {
    while sessions.len() >= RETAINED_SESSIONS {
        let finished = sessions
            .iter()
            .find(|(_, session)| session.finished())
            .map(|(id, _)| *id);
        if let Some(id) = finished {
            sessions.remove(&id);
        } else {
            break;
        }
    }
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
