//! Feature-owned strict native executions and positive teardown proofs.
use crate::product::{identity::now, schemas::Schemas};
use anyhow::{Context as _, Result, bail, ensure};
use rand::RngCore;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Command,
    sync::{Notify, Semaphore},
};
use tokio_util::sync::CancellationToken;

#[cfg(all(test, unix))]
#[path = "execution_tests.rs"]
mod tests;

pub(super) struct Execution {
    pub process_id: String,
    pub started_at: u64,
    pub directory: PathBuf,
    token: String,
    stdin: tokio::sync::Mutex<Option<Box<dyn AsyncWrite + Send + Unpin>>>,
    output: Mutex<Capture>,
    changed: Notify,
    stop: CancellationToken,
    accepting: AtomicBool,
    finished: AtomicBool,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    #[cfg(unix)]
    connections: Mutex<Vec<Weak<std::os::fd::OwnedFd>>>,
    capacity: Arc<Semaphore>,
}
trait ConnectionStream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> ConnectionStream for T {}

pub struct Connection {
    stream: Box<dyn ConnectionStream>,
    #[cfg(unix)]
    _descriptor: Arc<std::os::fd::OwnedFd>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl AsyncRead for Connection {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        ctx: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_read(ctx, buffer)
    }
}
impl AsyncWrite for Connection {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        ctx: &mut std::task::Context<'_>,
        buffer: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.stream).poll_write(ctx, buffer)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        ctx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_flush(ctx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        ctx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_shutdown(ctx)
    }
}
#[derive(Default)]
struct Capture {
    stdout: VecDeque<u8>,
    stderr: VecDeque<u8>,
    stdout_offset: u64,
    stderr_offset: u64,
    exit: Option<Exit>,
}
#[derive(Clone)]
pub(super) struct Exit {
    pub code: Option<i32>,
    pub killed: bool,
    pub admitted: bool,
}
pub(super) struct Delta {
    pub stdout: String,
    pub stderr: String,
    pub position: (u64, u64),
    pub truncated: bool,
}

impl Execution {
    pub async fn start(
        workspace: &Path,
        private_home: &Path,
        sensitive_paths: &[String],
        options: &Value,
        schemas: &Schemas,
        lifetime: CancellationToken,
    ) -> Result<Arc<Self>> {
        ensure!(
            schemas.valid("serviceStartOptions", options)?,
            "The service execution options are invalid."
        );
        ensure!(
            matches!(
                options["permissions"]["mode"].as_str(),
                Some("auto" | "full_access")
            ),
            "Starting a workspace service requires Auto or Full access."
        );
        ensure!(
            cfg!(target_os = "linux"),
            "Workspace services require Linux namespace and cgroup isolation on this compute provider."
        );
        let execution = &options["execution"];
        let directory = PathBuf::from(
            execution["directory"]
                .as_str()
                .context("The service control directory is missing.")?,
        );
        assert_execution(execution, schemas)?;
        let workspace = fs::canonicalize(workspace)?;
        let private = fs::canonicalize(private_home)?;
        ensure!(
            !directory.starts_with(&workspace) && directory.starts_with(&private),
            "Service controls must stay outside the workspace and inside private daemon storage."
        );
        let mut inputs = Vec::new();
        let selected = options["sandbox"]["inputs"]
            .as_array()
            .expect("validated service options");
        for destination in selected {
            let destination = destination.as_str().expect("validated service input");
            if selected.iter().any(|parent| {
                parent.as_str().is_some_and(|parent| {
                    parent != destination && destination.starts_with(&format!("{parent}/"))
                })
            }) {
                continue;
            }
            if inputs
                .iter()
                .any(|input: &Value| input["destination"] == destination)
            {
                continue;
            }
            let source = workspace.join(destination);
            ensure!(
                fs::canonicalize(&source)? == source && source.starts_with(&workspace),
                "Service inputs must remain in the workspace without following symlinks."
            );
            let metadata = fs::symlink_metadata(&source)?;
            ensure!(
                metadata.is_file() || metadata.is_dir(),
                "Service inputs must be regular files or directories."
            );
            ensure!(
                !source.starts_with(&private) && !private.starts_with(&source),
                "Service inputs include private daemon storage."
            );
            for protected in [".git", "AGENTS.md", "AGENTS_SECURITY.md", "happy.toml"] {
                let protected = workspace.join(protected);
                ensure!(
                    !source.starts_with(&protected) && !protected.starts_with(&source),
                    "Service inputs include protected workspace controls."
                );
            }
            for denied in options["permissions"]["deniedReadPaths"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .chain(sensitive_paths.iter().map(String::as_str))
            {
                let denied = PathBuf::from(denied);
                let denied = if denied.is_absolute() {
                    denied
                } else {
                    workspace.join(denied)
                };
                ensure!(
                    !source.starts_with(&denied) && !denied.starts_with(&source),
                    "Service inputs include a protected private path."
                );
            }
            inputs.push(json!({"source":source,"destination":destination}));
        }
        let outbound = outbound(options)?;
        let cgroup = cgroup_parent(None)?;
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let policy = json!({"mode":"read_only","network":{"egress":!outbound.is_empty(),"localBinding":true},"service":{"root":directory.join("root"),"cwd":options["cwd"],"inputs":inputs,"scratch":options["sandbox"]["scratch"],"cgroupParent":cgroup,"executionId":execution["id"],"controllerPid":std::process::id(),"bridgeSocket":directory.join("bridge"),"bridgeToken":token,"port":options["port"],"memoryMiB":options["sandbox"]["limits"]["memoryMiB"],"processes":options["sandbox"]["limits"]["processes"],"outbound":outbound}});
        ensure!(
            schemas.valid("supervisorPolicy", &policy)?,
            "The native service policy is invalid."
        );
        ensure!(
            !lifetime.is_cancelled(),
            "The service was stopped before startup."
        );
        private_create(&directory)?;
        let prepared = (|| {
            private_create(&directory.join("root"))?;
            write_control(&directory.join("policy.json"), &policy.to_string())
        })();
        if let Err(error) = prepared {
            fs::remove_dir_all(&directory)?;
            return Err(error);
        }
        #[cfg(not(target_os = "linux"))]
        {
            fs::remove_dir_all(&directory)?;
            bail!("Workspace services require Linux namespace and cgroup isolation.");
        }
        #[cfg(target_os = "linux")]
        {
            // No ambient credentials reach the supervisor or workload. Its own policy
            // constructs the complete service environment inside the mandatory sandbox.
            let mut command = Command::from(happy_agent_supervisor::command()?);
            #[cfg(test)]
            {
                let executable = std::env::current_exe()?;
                if executable
                    .parent()
                    .is_some_and(|parent| parent.file_name().is_some_and(|name| name == "deps"))
                {
                    let binary = executable
                        .parent()
                        .and_then(Path::parent)
                        .context("The test binary directory is missing.")?
                        .join("happy-agent");
                    command = Command::new(binary);
                    command.arg("supervisor");
                }
            }
            command
                .arg("--policy-file")
                .arg(directory.join("policy.json"))
                .args(["--", "/bin/sh", "-c"])
                .arg(options["command"].as_str().expect("validated command"))
                .env_clear()
                .current_dir(&workspace)
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
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let pty = if options["tty"] == true {
                Some(super::io::attach(&mut command)?)
            } else {
                None
            };
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    reconcile(execution, schemas, true, &CancellationToken::new()).await?;
                    return Err(error.into());
                }
            };
            let pid = child
                .id()
                .context("The service supervisor identity is missing.")?;
            let (stdin, stdout, stderr): (
                Box<dyn AsyncWrite + Send + Unpin>,
                Box<dyn AsyncRead + Send + Unpin>,
                Option<Box<dyn AsyncRead + Send + Unpin>>,
            ) = match pty {
                Some((reader, writer)) => (Box::new(writer), Box::new(reader), None),
                None => (
                    Box::new(
                        child
                            .stdin
                            .take()
                            .context("The service input descriptor is missing.")?,
                    ),
                    Box::new(
                        child
                            .stdout
                            .take()
                            .context("The service output descriptor is missing.")?,
                    ),
                    Some(Box::new(
                        child
                            .stderr
                            .take()
                            .context("The service error descriptor is missing.")?,
                    )),
                ),
            };
            let execution = Arc::new(Self {
                process_id: cuid2::create_id(),
                started_at: now(),
                directory,
                token,
                stdin: tokio::sync::Mutex::new(Some(stdin)),
                output: Mutex::new(Capture::default()),
                changed: Notify::new(),
                stop: CancellationToken::new(),
                accepting: AtomicBool::new(true),
                finished: AtomicBool::new(false),
                task: Mutex::new(None),
                connections: Mutex::new(Vec::new()),
                capacity: Arc::new(Semaphore::new(64)),
            });
            let running = execution.clone();
            let task = tokio::spawn(async move {
                let out = tokio::spawn(capture(running.clone(), stdout, false));
                let err = stderr.map(|stderr| tokio::spawn(capture(running.clone(), stderr, true)));
                let killed;
                let status = tokio::select! {
                    status=child.wait()=>{killed=false;status},
                    _=running.stop.cancelled()=>{killed=true;unsafe{libc::kill(-(pid as i32),libc::SIGTERM);};match tokio::time::timeout(Duration::from_secs(2),child.wait()).await {Ok(status)=>status,Err(_)=>{unsafe{libc::kill(-(pid as i32),libc::SIGKILL);};child.wait().await}}},
                    _=lifetime.cancelled()=>{killed=true;unsafe{libc::kill(-(pid as i32),libc::SIGKILL);};child.wait().await},
                };
                // Pipes held by unexpected descendants cannot leave an owner task
                // running forever. Native cleanup proof still gates terminal state.
                running.revoke();
                let mut out = out;
                if tokio::time::timeout(Duration::from_secs(2), &mut out)
                    .await
                    .is_err()
                {
                    out.abort();
                    let _ = out.await;
                }
                if let Some(mut err) = err {
                    if tokio::time::timeout(Duration::from_secs(2), &mut err)
                        .await
                        .is_err()
                    {
                        err.abort();
                        let _ = err.await;
                    }
                }
                let admitted = running.admitted().unwrap_or(false);
                running
                    .output
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .exit = Some(Exit {
                    code: status.ok().and_then(|status| status.code()),
                    killed,
                    admitted,
                });
                running.finished.store(true, Ordering::Release);
                running.changed.notify_waiters();
            });
            *execution
                .task
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(task);
            Ok(execution)
        }
    }
    pub fn revoke(&self) {
        self.accepting.store(false, Ordering::Release);
        self.capacity.close();
        #[cfg(unix)]
        {
            let mut connections = self
                .connections
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for connection in connections
                .drain(..)
                .filter_map(|connection| connection.upgrade())
            {
                use std::os::fd::AsRawFd;
                unsafe {
                    libc::shutdown(connection.as_raw_fd(), libc::SHUT_RDWR);
                }
            }
        }
        self.stop.cancel();
    }
    pub fn finished(&self) -> bool {
        self.finished.load(Ordering::Acquire)
    }
    pub fn admitted(&self) -> Result<bool> {
        Ok(read_control(&self.directory.join("started"), 1).is_ok_and(|bytes| bytes == b"1"))
    }
    pub async fn wait(&self, cancel: &CancellationToken) -> Result<Exit> {
        loop {
            let changed = self.changed.notified();
            if let Some(exit) = self
                .output
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .exit
                .clone()
            {
                return Ok(exit);
            }
            tokio::select! {_=changed=>{},_=cancel.cancelled()=>bail!("Service cleanup was stopped; its workspace files have been retained.")}
        }
    }
    pub async fn write(&self, chars: &str, cancel: &CancellationToken) -> Result<bool> {
        ensure!(chars.len() <= 65536, "Service input exceeds 64 KiB.");
        let mut input = tokio::select! {input=self.stdin.lock()=>input,_=cancel.cancelled()=>bail!("Service input was stopped.")};
        if !self.accepting.load(Ordering::Acquire) {
            return Ok(false);
        }
        let Some(input) = input.as_mut() else {
            return Ok(false);
        };
        tokio::select! {result=input.write_all(chars.as_bytes())=>{result?;Ok(true)},_=cancel.cancelled()=>bail!("Service input was stopped after dispatch and was not replayed.")}
    }
    pub async fn connect(&self, cancel: &CancellationToken) -> Result<Connection> {
        #[cfg(not(unix))]
        {
            let _ = cancel;
            bail!(
                "Workspace service connections require Linux namespace and cgroup isolation on this compute provider."
            );
        }
        #[cfg(unix)]
        {
            ensure!(
                self.accepting.load(Ordering::Acquire),
                "The service is not running."
            );
            let permit = self
                .capacity
                .clone()
                .try_acquire_owned()
                .context("This service already has 64 active endpoint connections.")?;
            let connect = async {
                let mut stream =
                    tokio::net::UnixStream::connect(self.directory.join("bridge")).await?;
                use std::os::fd::AsFd;
                let descriptor = Arc::new(stream.as_fd().try_clone_to_owned()?);
                {
                    let mut connections = self
                        .connections
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    ensure!(
                        self.accepting.load(Ordering::Acquire),
                        "The service is not running."
                    );
                    connections.retain(|connection| connection.strong_count() > 0);
                    connections.push(Arc::downgrade(&descriptor));
                }
                stream.write_all(self.token.as_bytes()).await?;
                let ack = stream.read_u8().await?;
                ensure!(
                    ack == 1 && self.accepting.load(Ordering::Acquire),
                    "The service endpoint is not accepting connections yet."
                );
                Ok(Connection {
                    stream: Box::new(stream),
                    _descriptor: descriptor,
                    _permit: permit,
                })
            };
            tokio::select! {result=tokio::time::timeout(Duration::from_secs(5),connect)=>result.context("The service endpoint connection timed out.")?,_=cancel.cancelled()=>bail!("The service endpoint connection was stopped."),_=self.stop.cancelled()=>bail!("The service endpoint connection was revoked.")}
        }
    }
    pub fn read(&self, position: (u64, u64)) -> Delta {
        let output = self
            .output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let delta = |bytes: &VecDeque<u8>, offset: u64, position: u64| {
            let start = offset.saturating_sub(bytes.len() as u64);
            let index = position.saturating_sub(start).min(bytes.len() as u64) as usize;
            let bytes: Vec<_> = bytes.iter().skip(index).copied().collect();
            (
                String::from_utf8_lossy(&bytes).into_owned(),
                position < start,
            )
        };
        let (stdout, a) = delta(&output.stdout, output.stdout_offset, position.0);
        let (stderr, b) = delta(&output.stderr, output.stderr_offset, position.1);
        Delta {
            stdout,
            stderr,
            position: (output.stdout_offset, output.stderr_offset),
            truncated: a || b,
        }
    }
}
async fn capture(execution: Arc<Execution>, mut stream: impl AsyncRead + Unpin, error: bool) {
    let mut buffer = [0u8; 8192];
    loop {
        let Ok(count) = stream.read(&mut buffer).await else {
            break;
        };
        if count == 0 {
            break;
        }
        {
            let mut output = execution
                .output
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let (bytes, offset) = if error {
                let Capture {
                    stderr,
                    stderr_offset,
                    ..
                } = &mut *output;
                (stderr, stderr_offset)
            } else {
                let Capture {
                    stdout,
                    stdout_offset,
                    ..
                } = &mut *output;
                (stdout, stdout_offset)
            };
            *offset += count as u64;
            bytes.extend(&buffer[..count]);
            let dropped = bytes.len().saturating_sub(1048576);
            bytes.drain(..dropped);
        }
        execution.changed.notify_waiters();
    }
}

pub(super) async fn reconcile(
    execution: &Value,
    schemas: &Schemas,
    known_exit: bool,
    cancel: &CancellationToken,
) -> Result<()> {
    ensure!(
        schemas.valid("serviceExecution", execution)?,
        "The private service execution is invalid."
    );
    let directory = PathBuf::from(
        execution["directory"]
            .as_str()
            .context("The service execution directory is missing.")?,
    );
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    assert_execution(execution, schemas)?;
    assert_private(&directory)?;
    let policy: Value =
        serde_json::from_slice(&read_control(&directory.join("policy.json"), 1048576)?)?;
    ensure!(
        schemas.valid("supervisorPolicy", &policy)? && !policy["service"].is_null(),
        "Service startup records are missing or incomplete. Workspace files have been retained."
    );
    let service = &policy["service"];
    ensure!(
        service["executionId"] == execution["id"]
            && service["root"] == json!(directory.join("root"))
            && service["bridgeSocket"] == json!(directory.join("bridge")),
        "Service controls do not establish this exact execution."
    );
    let lifetime = match read_control(&directory.join("process.json"), 16384) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes)?;
            ensure!(
                schemas.valid("serviceLifetime", &value)?,
                "The native service lifetime is invalid."
            );
            Some(value)
        }
        Err(error)
            if known_exit
                && error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            None
        }
        Err(error) => return Err(error),
    };
    ensure!(
        known_exit
            || lifetime
                .as_ref()
                .is_some_and(|value| value["executionReady"] == true),
        "Service startup records do not establish a complete execution. Its files have been retained."
    );
    if let Some(value) = &lifetime {
        ensure!(
            value["executionReady"] != true
                || !value["children"]
                    .as_array()
                    .expect("validated lifetime")
                    .is_empty(),
            "Service startup records do not establish native ownership."
        );
    }
    let parent = cgroup_parent(service["cgroupParent"].as_str())?;
    let cgroup = parent.join(format!(
        "happy-service-{}",
        execution["id"].as_str().expect("validated identity")
    ));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let mut gone = true;
        if let Some(value) = &lifetime {
            gone = owner_gone(value, schemas)?;
            for child in value["children"].as_array().expect("validated lifetime") {
                gone &= owner_gone(child, schemas)?;
            }
        }
        if gone && cgroup_empty(&cgroup)? && bridge_closed(&directory.join("bridge")).await? {
            break;
        }
        ensure!(
            tokio::time::Instant::now() < deadline,
            "Service teardown is not confirmed. Its workspace files must be retained."
        );
        tokio::select! {_=tokio::time::sleep(Duration::from_millis(50))=>{},_=cancel.cancelled()=>bail!("Service teardown was stopped. Its workspace files must be retained.")}
    }
    match fs::remove_dir(&cgroup) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    assert_private(&directory)?;
    fs::remove_dir_all(directory)?;
    Ok(())
}
fn assert_execution(execution: &Value, schemas: &Schemas) -> Result<()> {
    ensure!(
        schemas.valid("serviceExecution", execution)?,
        "The private service execution is invalid."
    );
    let path = Path::new(
        execution["directory"]
            .as_str()
            .expect("validated execution"),
    );
    ensure!(
        path.file_name().and_then(|value| value.to_str()) == execution["id"].as_str()
            && path.parent().is_some_and(|parent| parent != Path::new("/")),
        "The private service execution directory is invalid."
    );
    ensure!(
        path.components().all(|component| !matches!(
            component,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )),
        "The service execution directory must be canonical."
    );
    assert_private(path.parent().expect("validated parent"))
}
fn assert_private(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink() && fs::canonicalize(path)? == path,
        "Service controls must be ordinary canonical private directories."
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0,
            "Service controls must be private and owned by the daemon user."
        );
    }
    Ok(())
}
fn private_create(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(path)?;
    }
    #[cfg(not(unix))]
    fs::create_dir(path)?;
    Ok(())
}
fn write_control(path: &Path, text: &str) -> Result<()> {
    use std::io::Write;
    ensure!(
        text.len() <= 1048576,
        "The service policy exceeds its bound."
    );
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    Ok(())
}
fn read_control(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= limit as u64,
        "Service control files must be bounded private regular files."
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0,
            "Service control files must be private and owned by the daemon user."
        );
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= limit,
        "The service control file exceeds its bound."
    );
    Ok(bytes)
}
fn cgroup_parent(configured: Option<&str>) -> Result<PathBuf> {
    #[cfg(not(target_os = "linux"))]
    bail!("Workspace services require Linux namespace and cgroup isolation.");
    #[cfg(target_os = "linux")]
    {
        let candidate = if let Some(path) = configured {
            PathBuf::from(path)
        } else {
            let membership = fs::read_to_string("/proc/self/cgroup")?;
            let path = membership
                .lines()
                .find_map(|line| line.strip_prefix("0::/"))
                .context("Workspace services require a cgroup v2 delegation.")?;
            ensure!(
                !path.split('/').any(|part| part == ".."),
                "The service cgroup membership is invalid."
            );
            Path::new("/sys/fs/cgroup")
                .join(path)
                .parent()
                .context("The service cgroup parent is missing.")?
                .to_owned()
        };
        ensure!(
            candidate.starts_with("/sys/fs/cgroup")
                && candidate != Path::new("/sys/fs/cgroup")
                && fs::canonicalize(&candidate)? == candidate,
            "Workspace services require an administrator-delegated cgroup, not the system root."
        );
        use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
        let metadata = fs::symlink_metadata(&candidate)?;
        ensure!(
            metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() },
            "The service cgroup must be owned by the daemon user."
        );
        let path = std::ffi::CString::new(candidate.as_os_str().as_bytes())?;
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        ensure!(
            unsafe { libc::statfs(path.as_ptr(), &mut stat) } == 0
                && stat.f_type as u64 == 0x63677270,
            "Service resource controls must use the native cgroup filesystem."
        );
        let controllers = fs::read_to_string(candidate.join("cgroup.subtree_control"))?;
        ensure!(
            ["memory", "pids"].iter().all(|controller| controllers
                .split_whitespace()
                .any(|value| value == *controller)),
            "Workspace services need administrator-delegated memory and process controls. No host security settings were changed."
        );
        Ok(candidate)
    }
}
fn kernel_file(path: &Path) -> Result<String> {
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(16385).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 16384,
        "The native service proof exceeds its bound."
    );
    Ok(String::from_utf8(bytes)?)
}
fn owner_gone(identity: &Value, schemas: &Schemas) -> Result<bool> {
    let path = PathBuf::from(format!(
        "/proc/{}/stat",
        identity["pid"]
            .as_u64()
            .context("The native owner is invalid.")?
    ));
    let stat = match kernel_file(&path) {
        Ok(stat) => stat,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(true);
        }
        Err(error) => return Err(error),
    };
    let fields: Vec<_> = stat[stat
        .rfind(')')
        .context("The native process identity is invalid.")?
        + 1..]
        .split_whitespace()
        .collect();
    let current = json!({"state":fields.first(),"startTime":fields.get(19)});
    ensure!(
        schemas.valid("serviceKernelIdentity", &current)?,
        "The native process identity is invalid."
    );
    Ok(current["startTime"] != identity["startTime"]
        || matches!(current["state"].as_str(), Some("Z" | "X")))
}
fn cgroup_empty(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error.into()),
        Ok(metadata) => ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "The native service cgroup identity is invalid."
        ),
    };
    Ok(kernel_file(&path.join("cgroup.events"))?
        .lines()
        .any(|line| line.trim() == "populated 0"))
}
async fn bridge_closed(path: &Path) -> Result<bool> {
    #[cfg(unix)]
    {
        match tokio::time::timeout(
            Duration::from_millis(250),
            tokio::net::UnixStream::connect(path),
        )
        .await
        {
            Ok(Ok(_)) => Ok(false),
            Ok(Err(error)) => Ok(matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            )),
            Err(_) => Ok(false),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(false)
    }
}
fn outbound(options: &Value) -> Result<Vec<Value>> {
    let requested = options["sandbox"]["outbound"]
        .as_array()
        .context("The service network selection is invalid.")?;
    if requested.is_empty() {
        return Ok(Vec::new());
    }
    ensure!(
        options["permissions"]["network"]["egress"] == true,
        "This action does not permit outbound service traffic."
    );
    let matches_host = |pattern: &str, host: &str| {
        let pattern = pattern.to_ascii_lowercase();
        let pattern = pattern.trim_end_matches('.');
        if pattern == "*" {
            false
        } else if let Some(suffix) = pattern.strip_prefix("*.") {
            host.ends_with(&format!(".{suffix}")) && host.len() > suffix.len() + 1
        } else {
            pattern == host
        }
    };
    let mut destinations = Vec::new();
    for request in requested {
        let host = request["hostname"]
            .as_str()
            .expect("validated destination")
            .to_ascii_lowercase();
        let host = host.trim_end_matches('.');
        let port = &request["port"];
        let matches_rule = |rule: &Value| {
            matches_host(rule["domain"].as_str().unwrap_or(""), host)
                && (rule.get("ports").is_none()
                    || rule["ports"]
                        .as_array()
                        .is_some_and(|ports| ports.contains(port)))
        };
        ensure!(
            options["networkPolicy"]["allowedDomains"]
                .as_array()
                .is_some_and(|rules| rules.iter().any(matches_rule))
                && !options["networkPolicy"]["deniedDomains"]
                    .as_array()
                    .is_some_and(|rules| rules.iter().any(matches_rule)),
            "The user's network policy does not permit this service destination."
        );
        if let Some(hosts) = options["permissions"]["network"]["allowedHosts"].as_array() {
            ensure!(
                hosts.is_empty()
                    || hosts
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|pattern| matches_host(pattern, host)),
                "This action does not permit this service destination."
            );
        }
        let destination = json!({"hostname":host,"port":port});
        if !destinations.contains(&destination) {
            destinations.push(destination);
        }
    }
    Ok(destinations)
}
