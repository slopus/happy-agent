use super::process::process_running;
use super::{
    config::ConfigModule,
    filesystem::{atomic_private, remove_missing_ok},
};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub struct LifecycleModule {
    config: Arc<ConfigModule>,
    instance: String,
    identity: String,
    started_at: u64,
    mutations: Mutex<usize>,
    drain_writer: Mutex<()>,
    agents: Mutex<std::collections::BTreeMap<String, String>>,
    database_open: AtomicBool,
    ready: AtomicBool,
    draining: AtomicBool,
    shutting_down: AtomicBool,
    pub shutdown: CancellationToken,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DrainState {
    version: u32,
    pid: u32,
    instance: String,
    process_identity: String,
    phase: String,
    waiting_for: Vec<Value>,
}

#[async_trait::async_trait]
impl happy_agent_base::AgentModule for LifecycleModule {
    fn name(&self) -> &'static str {
        "lifecycle"
    }
    fn shutdown(&self) -> Option<CancellationToken> {
        Some(self.shutdown.clone())
    }
    fn draining(&self) -> bool {
        self.is_draining()
    }
    fn stage(&self, id: &str, stage: Option<&str>) {
        self.set_agent_stage(id, stage);
    }
}

impl LifecycleModule {
    pub fn new(config: Arc<ConfigModule>) -> Result<Self> {
        Ok(Self {
            config,
            instance: cuid2::create_id(),
            identity: process_identity(std::process::id())?,
            started_at: super::identity::now(),
            mutations: Mutex::new(0),
            drain_writer: Mutex::new(()),
            agents: Mutex::new(std::collections::BTreeMap::new()),
            database_open: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            draining: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            shutdown: CancellationToken::new(),
        })
    }
    pub fn publish_pid(&self) -> Result<()> {
        atomic_private(
            &self.config.paths.pid,
            format!("{}\n", std::process::id()).as_bytes(),
        )
    }
    pub fn ready(&self) -> Result<()> {
        self.ready.store(true, Ordering::Release);
        self.write_drain_state()
    }
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }
    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::Acquire)
    }
    pub fn begin_drain(&self) -> Result<bool> {
        let mutations = self
            .mutations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let changed = !self.draining.swap(true, Ordering::AcqRel);
        drop(mutations);
        self.write_drain_state()?;
        Ok(changed)
    }
    pub fn admit_mutation(self: &Arc<Self>) -> Option<Mutation> {
        let mut count = self
            .mutations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.is_draining() {
            return None;
        }
        *count += 1;
        Some(Mutation(self.clone()))
    }
    pub fn daemon_id(&self) -> &str {
        &self.instance
    }
    pub fn started_at(&self) -> u64 {
        self.started_at
    }
    fn drain_progress(&self) -> Vec<Value> {
        let count = *self
            .mutations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.is_draining() {
            return vec![];
        }
        let mut rows = Vec::new();
        if count > 0 {
            rows.push(json!({"name":"api-mutations","count":count}));
        }
        let agents = self
            .agents
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !agents.is_empty() {
            let mut row = json!({"name":"agent-system","count":agents.len(),"agents":agents.iter().take(100).map(|(id,stage)|json!({"id":id,"stage":stage})).collect::<Vec<_>>()});
            if agents.len() > 100 {
                row["truncated"] = json!(true);
            }
            rows.push(row);
        }
        rows
    }
    pub fn set_agent_stage(&self, id: &str, stage: Option<&str>) {
        let mut agents = self
            .agents
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(stage) = stage {
            agents.insert(id.into(), stage.into());
        } else {
            agents.remove(id);
        }
        drop(agents);
        if self.is_draining()
            && let Err(error) = self.write_drain_state()
        {
            eprintln!("Could not update agent drain progress: {error:#}");
        }
    }
    pub fn set_database_open(&self, open: bool) {
        self.database_open.store(open, Ordering::Release);
    }
    fn shutdown_waiting(&self) -> Vec<&'static str> {
        if !self.shutting_down.load(Ordering::Acquire) {
            return vec![];
        }
        let mut waiting = Vec::new();
        if !self
            .agents
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty()
        {
            waiting.push("agent-system");
        }
        if self.database_open.load(Ordering::Acquire) {
            waiting.push("main-database");
        }
        waiting
    }
    pub fn begin_shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        self.shutdown.cancel();
    }
    pub fn health(&self) -> Value {
        json!({"healthy":true,"ready":self.is_ready(),"status":if self.is_ready(){"ready"}else{"starting"},
            "version":{"protocol":26,"daemon":version()},"draining":self.is_draining(),"drainWaitingFor":self.drain_progress(),
            "shuttingDown":self.shutting_down.load(Ordering::Acquire),"waitingFor":self.shutdown_waiting()})
    }
    fn write_drain_state(&self) -> Result<()> {
        let _writer = self
            .drain_writer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let waiting_for = self.drain_progress();
        atomic_private(
            &self.config.paths.drain,
            &serde_json::to_vec(&DrainState {
                version: 1,
                pid: std::process::id(),
                instance: self.instance.clone(),
                process_identity: self.identity.clone(),
                phase: if self.is_draining() && waiting_for.is_empty() {
                    "drained"
                } else if self.is_draining() {
                    "draining"
                } else {
                    "ready"
                }
                .into(),
                waiting_for,
            })?,
        )
    }
    pub fn cleanup(&self) -> Result<()> {
        remove_pid(&self.config.paths.pid, std::process::id())?;
        if read_drain_state(&self.config.paths.drain)
            .is_ok_and(|state| state.instance == self.instance)
        {
            remove_missing_ok(&self.config.paths.drain)?;
        }
        Ok(())
    }
}

pub struct Mutation(Arc<LifecycleModule>);
impl Drop for Mutation {
    fn drop(&mut self) {
        let mut count = self
            .0
            .mutations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *count -= 1;
        drop(count);
        if self.0.is_draining()
            && let Err(error) = self.0.write_drain_state()
        {
            eprintln!("Could not update local drain progress: {error:#}");
        }
    }
}

pub fn version() -> &'static str {
    option_env!("HAPPY_AGENT_RELEASE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

pub async fn command(name: &str) -> Result<()> {
    let config = Arc::new(ConfigModule::load()?);
    let paths = &config.paths;
    if name == "kill" {
        if let Some(pid) = read_pid(&paths.pid)? {
            if pid == std::process::id() {
                bail!("Refusing to kill the process running this daemon command.");
            }
            if process_running(pid) {
                kill_process(pid)?;
                wait_process_exit(pid, Duration::from_secs(5)).await?;
                remove_pid(&paths.pid, pid)?;
                println!("Daemon process {pid} was killed.");
                return Ok(());
            }
            remove_pid(&paths.pid, pid)?;
        }
        println!("Daemon is not running.");
        return Ok(());
    }
    #[cfg(unix)]
    if name == "drain" {
        return drain_signal(config).await;
    }
    let observed = observe(&config).await;
    if name == "status" {
        let pid = read_pid(&paths.pid)?;
        if let Some(health) = observed {
            println!(
                "Daemon is {} at {}",
                if health["ready"] != true {
                    "starting"
                } else if health["draining"] == true {
                    "draining"
                } else {
                    "running"
                },
                paths.socket.display()
            );
            if health["ready"] == true {
                println!(
                    "Daemon PID: {}",
                    pid.map_or_else(|| "unknown".into(), |pid| pid.to_string())
                );
            }
            if health["draining"] == true {
                println!("Daemon drain complete.");
            }
        } else if let Some(pid) = pid.filter(|pid| process_running(*pid)) {
            println!("Daemon process {pid} is running but not responding.");
        } else {
            println!("Daemon is not running.");
        }
        print_logs(&config);
        return Ok(());
    }
    if name == "stop" || name == "reload" {
        if observed.is_some() {
            if name == "reload" {
                assert_external_reload(
                    read_pid(&paths.pid)?.context("The daemon PID is unavailable.")?,
                )
                .await?;
            }
            println!("Daemon is stopping.");
            stop(&config).await?;
            println!("Daemon stopped.");
        } else {
            assert_no_unresponsive(&config)?;
            if name == "stop" {
                println!("Daemon is not running.");
            }
        }
        if name == "stop" {
            return Ok(());
        }
    }
    #[cfg(windows)]
    if name == "drain" {
        drain_http(&config).await?;
        println!("The daemon is drained and still running.");
        return Ok(());
    }
    start(
        config.clone(),
        if name == "reload" { None } else { observed },
    )
    .await?;
    println!("Daemon is running at {}", paths.socket.display());
    println!(
        "Daemon PID: {}",
        read_pid(&paths.pid)?.map_or_else(|| "unknown".into(), |pid| pid.to_string())
    );
    print_logs(&config);
    Ok(())
}

fn print_logs(config: &ConfigModule) {
    println!("Daemon log: {}", config.paths.log.display());
    println!("Shutdown log: {}", config.paths.observation.display());
}

async fn observe(config: &ConfigModule) -> Option<Value> {
    let token = std::fs::read_to_string(&config.paths.token).ok()?;
    let response = super::transport::request(config, token.trim(), "GET", "/v0/health")
        .await
        .ok()?;
    if response.0 != 200 {
        return None;
    }
    Some(response.1)
}

async fn start(config: Arc<ConfigModule>, observed: Option<Value>) -> Result<()> {
    if config.team_enabled() {
        bail!(
            "Local daemon connections are disabled in team mode. Run 'happy-agent run' under the team deployment's process supervisor."
        );
    }
    if let Some(health) = observed {
        if health["version"]["daemon"].as_str() == Some(version())
            && health["version"]["protocol"]
                .as_u64()
                .is_some_and(|protocol| protocol >= 22)
            && health["draining"] != true
        {
            let deadline = Instant::now() + Duration::from_secs(60);
            while observe(&config)
                .await
                .is_none_or(|health| health["ready"] != true)
            {
                if Instant::now() >= deadline {
                    bail!("The local daemon did not become ready within 60 seconds.");
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            return Ok(());
        }
        assert_external_reload(
            read_pid(&config.paths.pid)?.context("The daemon PID is unavailable.")?,
        )
        .await?;
        stop(&config).await?;
    } else {
        assert_no_unresponsive(&config)?;
    }
    config.prepare()?;
    let token = config.prepare_token()?;
    if std::fs::metadata(&config.paths.log).is_ok_and(|metadata| metadata.len() >= 10 * 1024 * 1024)
    {
        let _ = std::fs::rename(
            &config.paths.log,
            config.paths.directory.join("daemon.log.1"),
        );
    }
    let mut log_options = std::fs::OpenOptions::new();
    log_options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        log_options.mode(0o600);
    }
    let log = log_options.open(&config.paths.log)?;
    super::filesystem::private_file(&config.paths.log)?;
    let mut process = std::process::Command::new(std::env::current_exe()?);
    process
        .arg("run")
        .current_dir(&config.paths.directory)
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // The only pre-exec operation is async-signal-safe; daemon resources start afterwards.
        unsafe {
            process.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000 | 0x00000008);
    }
    let mut child = process.spawn()?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(status) = child.try_wait()? {
            if let Some(health) = observe(&config).await
                && health["ready"] == true
                && health["version"]["daemon"].as_str() == Some(version())
            {
                return Ok(());
            }
            bail!(
                "The Happy Agent daemon exited during startup ({status}). Inspect {}.",
                config.paths.log.display()
            );
        }
        if let Ok((200, health)) =
            super::transport::request(&config, &token, "GET", "/v0/health").await
            && health["ready"] == true
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            terminate_child(&mut child).await;
            bail!(
                "The local daemon did not become ready within 60 seconds. Inspect {}.",
                config.paths.log.display()
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn terminate_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if child.try_wait().is_ok_and(|status| status.is_some()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _ = child.kill();
    let _ = child.wait();
}

async fn drain_http(config: &ConfigModule) -> Result<()> {
    let token = std::fs::read_to_string(&config.paths.token)?;
    let (status, _) = super::transport::request(config, token.trim(), "POST", "/v0/drain").await?;
    if status != 202 {
        bail!("The daemon refused draining ({status}).");
    }
    let mut mutation_only_since = None;
    loop {
        let (_, health) =
            super::transport::request(config, token.trim(), "GET", "/v0/health").await?;
        if health["drainWaitingFor"]
            .as_array()
            .is_some_and(|rows| rows.is_empty())
        {
            return Ok(());
        }
        let mutation_only = health["drainWaitingFor"]
            .as_array()
            .is_some_and(|rows| rows.iter().all(|row| row["name"] == "api-mutations"));
        if mutation_only {
            let since = mutation_only_since.get_or_insert_with(Instant::now);
            if since.elapsed() > Duration::from_secs(30) {
                bail!("Daemon API mutations did not finish draining within 30 seconds.");
            }
        } else {
            mutation_only_since = None;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn stop(config: &ConfigModule) -> Result<()> {
    drain_http(config).await?;
    let token = std::fs::read_to_string(&config.paths.token)?;
    let (status, response) =
        super::transport::request(config, token.trim(), "POST", "/v0/shutdown").await?;
    if status != 202 {
        bail!("The daemon refused shutdown ({status}).");
    }
    let pid = response["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .context("The daemon did not return its process identity.")?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if !process_running(pid) && observe(config).await.is_none() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!(
                "Daemon process {pid} or its API did not stop within 30 seconds. Run 'happy-agent kill' to force it to stop."
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn assert_no_unresponsive(config: &ConfigModule) -> Result<()> {
    if let Some(pid) = read_pid(&config.paths.pid)?.filter(|pid| process_running(*pid)) {
        bail!(
            "Daemon process {pid} is running but not responding. Run 'happy-agent kill' to force it to stop."
        );
    }
    Ok(())
}

pub fn read_pid(path: &Path) -> Result<Option<u32>> {
    match std::fs::read_to_string(path) {
        Ok(value) => {
            let normalized = value.trim();
            if !normalized
                .starts_with(|character: char| character.is_ascii_digit() && character != '0')
                || !normalized
                    .chars()
                    .all(|character| character.is_ascii_digit())
            {
                bail!("The daemon PID file is invalid: {}", path.display());
            }
            Ok(Some(normalized.parse().with_context(|| {
                format!("The daemon PID file is invalid: {}", path.display())
            })?))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn remove_pid(path: &Path, expected: u32) -> Result<()> {
    if read_pid(path)? == Some(expected) {
        remove_missing_ok(path)?;
    }
    Ok(())
}

fn kill_process(pid: u32) -> Result<()> {
    #[cfg(unix)]
    {
        if unsafe { libc::kill(pid as i32, libc::SIGKILL) } < 0
            && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(windows)]
    {
        if !std::process::Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/F"])
            .status()?
            .success()
        {
            bail!("Could not terminate daemon process {pid}.");
        }
    }
    Ok(())
}

async fn wait_process_exit(pid: u32, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    while process_running(pid) {
        if Instant::now() >= deadline {
            bail!("Daemon process {pid} did not exit after termination.");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

fn process_identity(pid: u32) -> Result<String> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
        let (_, tail) = stat
            .rsplit_once(')')
            .context("Could not identify the daemon process.")?;
        let start = tail
            .split_whitespace()
            .nth(19)
            .context("Could not identify the daemon process.")?;
        Ok(format!(
            "{}:{start}",
            std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim()
        ))
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "lstart=,comm="])
            .env("LC_ALL", "C")
            .env("TZ", "UTC")
            .output()?;
        let identity = String::from_utf8(output.stdout)?.trim().to_owned();
        if !output.status.success() || identity.is_empty() {
            bail!("Could not identify the daemon process.");
        }
        Ok(identity)
    }
    #[cfg(windows)]
    {
        Ok(pid.to_string())
    }
}

#[cfg(unix)]
fn read_drain_state(path: &Path) -> Result<DrainState> {
    use std::{
        io::Read,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.size() > 512 * 1024 || metadata.mode() & 0o077 != 0 {
        bail!("The local drain status file is not a private, bounded regular file.");
    }
    let mut bytes = Vec::new();
    file.take(512 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 512 * 1024 {
        bail!("The local drain status file is too large.");
    }
    let state: DrainState = serde_json::from_slice(&bytes)?;
    if state.version != 1
        || state.pid == 0
        || state.pid > i32::MAX as u32
        || state.instance.is_empty()
        || state.instance.len() > 128
        || state.process_identity.is_empty()
        || state.process_identity.len() > 16_384
        || !["ready", "draining", "drained", "failed"].contains(&state.phase.as_str())
        || state.waiting_for.len() > 128
    {
        bail!("The local drain status is invalid.");
    }
    Ok(state)
}

#[cfg(windows)]
fn read_drain_state(path: &Path) -> Result<DrainState> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

#[cfg(unix)]
async fn drain_signal(config: Arc<ConfigModule>) -> Result<()> {
    let pid = read_pid(&config.paths.pid)?
        .filter(|pid| process_running(*pid))
        .context("The daemon is not running; no drain was performed.")?;
    if pid == std::process::id() {
        bail!("Run drain from a separate local process.");
    }
    let initial = read_drain_state(&config.paths.drain)
        .context("This daemon has no usable local signal-drain status. No signal was sent.")?;
    if initial.pid != pid || initial.process_identity != process_identity(pid)? {
        bail!("The daemon's local drain status belongs to another process. No signal was sent.");
    }
    if initial.phase == "failed" {
        bail!("Daemon draining previously failed; inspect its log.");
    }
    if initial.phase == "ready" && unsafe { libc::kill(pid as i32, libc::SIGUSR2) } < 0 {
        bail!("Could not signal the daemon; draining was not confirmed.");
    }
    println!(
        "Waiting for the daemon to drain. No new work will be admitted; the daemon will stay running."
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let state = read_drain_state(&config.paths.drain)
            .context("Local drain status became unavailable; completion was not confirmed.")?;
        if state.instance != initial.instance
            || read_pid(&config.paths.pid)? != Some(pid)
            || !process_running(pid)
        {
            bail!("The daemon exited or was replaced before draining was confirmed.");
        }
        if state.phase == "failed" {
            bail!("Daemon draining failed; inspect its log.");
        }
        if state.phase == "drained" {
            println!(
                "The daemon is drained and still running. Stop its service before backing up or replacing it."
            );
            return Ok(());
        }
        if state.phase == "ready" && Instant::now() >= deadline {
            bail!("The daemon did not acknowledge the drain signal. It was not stopped.");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn assert_external_reload(daemon: u32) -> Result<()> {
    if daemon == std::process::id() {
        bail!(
            "Cannot reload Happy Agent from a process owned by that daemon. Run happy-agent reload from an independent terminal or supervisor."
        );
    }
    #[cfg(unix)]
    let output = tokio::process::Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,ppid="])
        .output();
    #[cfg(windows)]
    let output=tokio::process::Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-Command","$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"]).output();
    let output = tokio::time::timeout(Duration::from_secs(5), output)
        .await
        .context(
            "Cannot verify that reloading Happy Agent is safe. The daemon was left running.",
        )??;
    if !output.status.success() || output.stdout.len() > 2 * 1024 * 1024 {
        bail!("Cannot verify that reloading Happy Agent is safe. The daemon was left running.");
    }
    let mut parents = std::collections::HashMap::new();
    for line in String::from_utf8(output.stdout)?.lines() {
        let row = line
            .split_whitespace()
            .map(str::parse::<u32>)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if row.len() != 2 {
            bail!("Cannot verify that reloading Happy Agent is safe. Invalid process ancestry.");
        }
        parents.insert(row[0], row[1]);
    }
    let mut visited = std::collections::HashSet::new();
    let mut pid = std::process::id();
    while pid > 1 {
        if pid == daemon {
            bail!(
                "Cannot reload Happy Agent from a process owned by that daemon. Run happy-agent reload from an independent terminal or supervisor."
            );
        }
        if !visited.insert(pid) {
            bail!("Cannot verify that reloading Happy Agent is safe. Cyclic process ancestry.");
        }
        pid = *parents.get(&pid).context("Cannot verify that reloading Happy Agent is safe. Incomplete process ancestry; the daemon was left running.")?;
    }
    Ok(())
}
