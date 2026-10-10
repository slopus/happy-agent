//! Detached reload is the same executable in its own session. Linux's daemon is a subreaper,
//! so a worker may remain its descendant after its caller exits. A private handoff verified
//! while the caller is alive authorizes only the captured daemon instance, never a loose PID.
use super::*;
use std::{ffi::OsStr, path::PathBuf, process::Stdio};

const WORKER_ARGUMENT: &str = "--detached-after=";
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(5);
const CALLER_EXIT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_HANDOFF: usize = 64 * 1024;

pub async fn reload_argument(argument: &OsStr) -> Result<bool> {
    if argument == "--detach" {
        #[cfg(windows)]
        bail!(
            "Detached reload is not available on Windows. Run happy-agent reload from an independent terminal."
        );
        #[cfg(unix)]
        {
            let log = schedule().await?;
            println!("Happy Agent will reload once this command exits.");
            println!("Reload log: {}", log.display());
        }
        return Ok(true);
    }
    #[cfg(unix)]
    if let Some(pid) = argument
        .to_str()
        .and_then(|argument| argument.strip_prefix(WORKER_ARGUMENT))
        .and_then(|pid| pid.parse::<u32>().ok())
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u32)
    {
        worker(pid).await?;
        return Ok(true);
    }
    Ok(false)
}

pub(super) struct VerifiedReload {
    target: Value,
}
impl VerifiedReload {
    pub(super) fn assert_target(&self, pid: u32) -> Result<()> {
        let identity = self.target["identity"].as_str().context(
            "A daemon appeared after detached reload was scheduled; it was left running.",
        )?;
        anyhow::ensure!(
            self.target["pid"] == pid && process_identity(pid)? == identity,
            "The daemon changed before detached reload; it was left running."
        );
        #[cfg(unix)]
        anyhow::ensure!(
            unsafe { libc::getsid(0) } == std::process::id() as i32,
            "The detached reload worker is not independent; the daemon was left running."
        );
        Ok(())
    }

    pub(super) fn assert_current(&self, config: &ConfigModule) -> Result<()> {
        #[cfg(unix)]
        anyhow::ensure!(
            target(config)? == self.target,
            "The daemon changed before detached reload; it was left running."
        );
        self.assert_target(
            read_pid(&config.paths.pid)?
                .context("The daemon PID is unavailable; detached reload was stopped.")?,
        )
    }

    pub(super) fn assert_shutdown_pid(&self, pid: u32) -> Result<()> {
        anyhow::ensure!(
            self.target["pid"] == pid,
            "Another daemon answered the shutdown request; detached reload was stopped."
        );
        Ok(())
    }
}

#[cfg(unix)]
fn target(config: &ConfigModule) -> Result<Value> {
    Ok(
        match read_pid(&config.paths.pid)?.filter(|pid| process_running(*pid)) {
            Some(pid) => {
                let identity = process_identity(pid)?;
                let state = read_drain_state(&config.paths.drain).context(
                    "The daemon has no verifiable local identity; detached reload was stopped.",
                )?;
                anyhow::ensure!(
                    state.pid == pid && state.process_identity == identity,
                    "The daemon PID and local identity disagree; detached reload was stopped."
                );
                json!({"pid":pid,"identity":identity,"instance":state.instance})
            }
            None => Value::Null,
        },
    )
}

#[cfg(unix)]
fn open_log(config: &ConfigModule) -> Result<(PathBuf, std::fs::File)> {
    use std::os::unix::fs::OpenOptionsExt;
    super::super::filesystem::private_directory(&config.paths.directory)?;
    let path = config.paths.directory.join("reload.log");
    if std::fs::symlink_metadata(&path).is_ok() {
        super::super::filesystem::private_file(&path)?;
        if std::fs::metadata(&path)?.len() >= 10 * 1024 * 1024 {
            std::fs::rename(&path, config.paths.directory.join("reload.log.1"))?;
        }
    }
    let log = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)?;
    super::super::filesystem::private_file(&path)?;
    Ok((path, log))
}

#[cfg(unix)]
async fn schedule() -> Result<PathBuf> {
    use std::os::unix::process::CommandExt;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    let config = ConfigModule::load()?;
    let target = target(&config)?;
    let (path, log) = open_log(&config)?;
    let caller = std::process::id();
    let identity = process_identity(caller)?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let mut process = std::process::Command::new(std::env::current_exe()?);
    process
        .args(["reload", &format!("{WORKER_ARGUMENT}{caller}")])
        .current_dir(config.daemon_working_directory())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(log);
    // No resources are initialized by the child until its own executable starts.
    unsafe {
        process.pre_exec(|| {
            if libc::setsid() < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = tokio::process::Command::from(process).spawn()?;
    let handoff = json!({"nonce":nonce,"caller":{"pid":caller,"identity":identity},"workerPid":child.id().context("The reload worker has no PID.")?,"target":target});
    let result = tokio::time::timeout(HANDOFF_TIMEOUT, async {
        let mut input = child
            .stdin
            .take()
            .context("The reload worker has no private input.")?;
        input.write_all(&serde_json::to_vec(&handoff)?).await?;
        drop(input);
        let mut output = tokio::io::BufReader::new(
            child
                .stdout
                .take()
                .context("The reload worker has no private output.")?
                .take(128),
        );
        let mut acknowledgement = String::new();
        output.read_line(&mut acknowledgement).await?;
        anyhow::ensure!(
            acknowledgement == format!("{nonce}\n"),
            "The detached reload worker did not verify its caller; the daemon was left running."
        );
        Ok::<_, anyhow::Error>(())
    })
    .await;
    if let Err(error) = result
        .context("The detached reload handoff timed out; the daemon was left running.")
        .and_then(|result| result)
    {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        return Err(error);
    }
    Ok(path)
}

#[cfg(unix)]
fn read_handoff() -> Result<Value> {
    use std::io::Read;
    for descriptor in [libc::STDIN_FILENO, libc::STDOUT_FILENO] {
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        anyhow::ensure!(
            unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } == 0,
            "The detached reload handoff is unavailable."
        );
        let metadata = unsafe { metadata.assume_init() };
        anyhow::ensure!(
            metadata.st_mode & libc::S_IFMT == libc::S_IFIFO,
            "Detached reload requires its caller's private pipes."
        );
    }
    let deadline = Instant::now() + HANDOFF_TIMEOUT;
    let mut bytes = Vec::new();
    loop {
        let mut descriptor = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        anyhow::ensure!(
            !remaining.is_zero(),
            "The detached reload handoff timed out."
        );
        let ready = unsafe {
            libc::poll(
                &mut descriptor,
                1,
                remaining.as_millis().min(i32::MAX as u128) as i32,
            )
        };
        if ready < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        anyhow::ensure!(ready > 0, "The detached reload handoff could not be read.");
        let mut buffer = [0; 4096];
        let count = std::io::stdin().read(&mut buffer)?;
        if count == 0 {
            break;
        }
        anyhow::ensure!(
            bytes.len() + count <= MAX_HANDOFF,
            "The detached reload handoff is too large."
        );
        bytes.extend_from_slice(&buffer[..count]);
    }
    let handoff: Value = serde_json::from_slice(&bytes)?;
    let schemas = happy_agent_base::RuntimeSchemas::compile(include_str!("schemas.json"))?;
    anyhow::ensure!(
        schemas.valid("handoff", &handoff)?,
        "The detached reload handoff is invalid."
    );
    Ok(handoff)
}

#[cfg(unix)]
async fn same_executable(caller: u32) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    #[cfg(target_os = "linux")]
    let executable = PathBuf::from(format!("/proc/{caller}/exe"));
    #[cfg(target_os = "macos")]
    let executable = {
        let mut process = tokio::process::Command::new("/bin/ps");
        process
            .args(["-p", &caller.to_string(), "-o", "comm="])
            .kill_on_drop(true);
        let output = tokio::time::timeout(HANDOFF_TIMEOUT, process.output()).await??;
        anyhow::ensure!(
            output.status.success() && output.stdout.len() <= 4096,
            "The reload caller's executable is unavailable."
        );
        PathBuf::from(String::from_utf8(output.stdout)?.trim())
    };
    let parent = std::fs::metadata(executable)?;
    let own = std::fs::metadata(std::env::current_exe()?)?;
    anyhow::ensure!(
        parent.dev() == own.dev() && parent.ino() == own.ino(),
        "The detached reload caller is not this executable."
    );
    Ok(())
}

#[cfg(unix)]
async fn worker(caller: u32) -> Result<()> {
    use std::{io::Write, os::fd::AsRawFd};
    let handoff = read_handoff()?;
    let identity = handoff["caller"]["identity"]
        .as_str()
        .context("The caller identity is unavailable.")?;
    anyhow::ensure!(
        handoff["caller"]["pid"] == caller
            && handoff["workerPid"] == std::process::id()
            && unsafe { libc::getppid() } == caller as i32
            && process_running(caller)
            && process_identity(caller)? == identity
            && unsafe { libc::getsid(0) } == std::process::id() as i32,
        "The detached reload caller or worker identity could not be verified; the daemon was left running."
    );
    same_executable(caller).await?;
    let config = Arc::new(ConfigModule::load()?);
    anyhow::ensure!(
        target(&config)? == handoff["target"],
        "The daemon changed during detached reload; it was left running."
    );
    anyhow::ensure!(
        unsafe { libc::getppid() } == caller as i32
            && process_running(caller)
            && process_identity(caller)? == identity,
        "The detached reload caller exited before verification; the daemon was left running."
    );
    let (_, log) = open_log(&config)?;
    let input = std::fs::File::open("/dev/null")?;
    println!(
        "{}",
        handoff["nonce"]
            .as_str()
            .context("The handoff nonce is unavailable.")?
    );
    std::io::stdout().flush()?;
    for (source, destination) in [
        (input.as_raw_fd(), 0),
        (log.as_raw_fd(), 1),
        (log.as_raw_fd(), 2),
    ] {
        anyhow::ensure!(
            unsafe { libc::dup2(source, destination) } >= 0,
            "Could not detach the reload worker's streams."
        );
    }
    println!("Reloading Happy Agent once process {caller} exits.");
    let deadline = Instant::now() + CALLER_EXIT_TIMEOUT;
    while process_running(caller) {
        let current = match process_identity(caller) {
            Ok(identity) => identity,
            Err(_) if !process_running(caller) => break,
            Err(error) => {
                return Err(error).context(
                    "The caller identity became unavailable; the daemon was left running.",
                );
            }
        };
        if current != identity {
            break;
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "Process {caller} did not exit; the daemon was left running."
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let target = handoff["target"].clone();
    super::command_with_config("reload", config, Some(VerifiedReload { target })).await
}
