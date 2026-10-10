use super::connection::stop_child;
use crate::product::{config::ConfigModule, filesystem::{private_directory, private_file, remove_missing_ok}, schemas::Schemas};
use anyhow::{Context as _, Result, bail};
use std::{path::{Path, PathBuf}, process::Stdio, sync::{Arc, Mutex}, time::Duration};
use tokio::{io::AsyncReadExt, net::{TcpListener, TcpStream}, process::{Child, Command}, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use serde_json::Value;

/// Incoming Tailcat wraps the already authenticated API transport. Its stable
/// identity and deterministic local port are private installation state.
pub struct TailcatExposure {
    pub address: String,
    pub port: u16,
    stop: CancellationToken,
    task: Mutex<Option<JoinHandle<Result<()>>>>,
    relay: Mutex<Option<JoinHandle<Result<()>>>>,
    home: PathBuf,
}
impl TailcatExposure {
    pub async fn open(config: &ConfigModule, target: Value) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        anyhow::ensure!(schemas.valid("ownerTailcatTarget", &target)?, "The Tailcat API transport target is invalid.");
        let home = config.tailcat_home(); private_directory(&home)?;
        let executable = config.tailcat_executable();
        ensure_key(&executable, &home).await?;
        let port = config.tailcat_port();
        let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|error| if error.kind() == std::io::ErrorKind::AddrInUse { anyhow::anyhow!("Tailcat port {port} is already in use.") } else { error.into() })?;
        let stop = CancellationToken::new();
        let relay = start_relay(listener, target, stop.clone());
        let run = match start_run(&executable, &home, port).await { Ok(run) => run, Err(error) => { stop.cancel(); let _ = relay.await; return Err(error); } };
        let mut run = run;
        let address = match wait_address(&mut run, &home.join("address"), &schemas, &stop).await { Ok(address) => address, Err(error) => { stop.cancel(); let _ = stop_child(&mut run.child).await; let _ = run.drain.await; let _ = relay.await; return Err(error); } };
        crate::product::filesystem::atomic_private(&home.join("port"), format!("{port}\n").as_bytes())?;
        let task_home = home.clone(); let task_stop = stop.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = task_stop.cancelled() => { stop_child(&mut run.child).await?; run.drain.await??; return Ok(()); }
                    exit = run.child.wait() => { exit?; run.drain.await??; }
                }
                tokio::select! { biased; _ = task_stop.cancelled() => return Ok(()), _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
                // Supervision belongs to inbound exposure. HTTP requests remain
                // owned by their exchange and are never resubmitted here.
                loop {
                    if task_stop.is_cancelled() { return Ok(()); }
                    match start_run(&executable, &task_home, port).await {
                        Ok(mut restarted) => match wait_address(&mut restarted, &task_home.join("address"), &schemas, &task_stop).await {
                            Ok(_) => { run = restarted; break; }
                            Err(_) => { stop_child(&mut restarted.child).await?; restarted.drain.await??; }
                        },
                        Err(_) => {},
                    }
                    tokio::select! { biased; _ = task_stop.cancelled() => return Ok(()), _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
                }
            }
        });
        Ok(Arc::new(Self { address, port, stop, task: Mutex::new(Some(task)), relay: Mutex::new(Some(relay)), home }))
    }
    pub async fn close(&self) -> Result<()> {
        self.stop.cancel();
        let task = self.task.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        let relay = self.relay.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        let stopped = match task { Some(task) => task.await.context("Tailcat supervision failed during cleanup.")?, None => Ok(()) };
        let relayed = match relay { Some(relay) => relay.await.context("Tailcat relay failed during cleanup.")?, None => Ok(()) };
        stopped?; relayed?;
        remove_missing_ok(&self.home.join("address"))?; remove_missing_ok(&self.home.join("port"))?;
        Ok(())
    }
}
struct Run { child: Child, drain: JoinHandle<Result<()>>, stderr: Arc<Mutex<Vec<u8>>> }
async fn spawn(executable: &str, arguments: &[String], address: Option<&Path>) -> Result<Run> {
    let mut command = Command::new(executable);
    command.args(arguments).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(address) = address { command.env("TAILCAT_ADDR_FILE", address); }
    #[cfg(windows)] command.creation_flags(0x08000000);
    let mut child = command.spawn().context("Tailcat could not start its native carrier.")?;
    let mut pipe = child.stderr.take().context("Tailcat process output is unavailable.")?;
    let stderr = Arc::new(Mutex::new(Vec::new())); let output = stderr.clone();
    let drain = tokio::spawn(async move {
        let mut bytes = [0; 4096];
        loop { let size = pipe.read(&mut bytes).await?; if size == 0 { break; } let mut tail = output.lock().unwrap_or_else(std::sync::PoisonError::into_inner); tail.extend_from_slice(&bytes[..size]); if tail.len() > 8192 { let excess = tail.len() - 8192; tail.drain(..excess); } }
        Ok(())
    });
    Ok(Run { child, drain, stderr })
}
async fn start_run(executable: &str, home: &Path, port: u16) -> Result<Run> {
    remove_missing_ok(&home.join("address"))?;
    spawn(executable, &[format!("--key={}", home.join("default.private.json").display()), "serve".into(), port.to_string()], Some(&home.join("address"))).await
}
async fn ensure_key(executable: &str, home: &Path) -> Result<()> {
    let key = home.join("default.private.json");
    if private_regular(&key)? { return Ok(()); }
    let temporary = home.join(format!("default.private.json.{}.{}.tmp", std::process::id(), uuid::Uuid::new_v4()));
    let result = async {
        let mut run = spawn(executable, &["genkey".into(), format!("--key={}", temporary.display()), "--fixed-region".into()], None).await?;
        let outcome = match tokio::time::timeout(Duration::from_secs(60), run.child.wait()).await { Ok(status) => status?, Err(_) => { stop_child(&mut run.child).await?; run.drain.await??; bail!("Tailcat key generation timed out."); } };
        run.drain.await??;
        anyhow::ensure!(outcome.success(), "Tailcat could not generate its identity key. {}", error_tail(&run.stderr));
        anyhow::ensure!(private_regular(&temporary)?, "Tailcat did not create a private identity key.");
        match std::fs::hard_link(&temporary, &key) { Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}, Err(error) => return Err(error.into()) }
        anyhow::ensure!(private_regular(&key)?, "The persisted Tailcat identity key is not a private regular file."); Ok(())
    }.await;
    remove_missing_ok(&temporary)?; result
}
fn private_regular(path: &Path) -> Result<bool> {
    let metadata = match std::fs::symlink_metadata(path) { Ok(metadata) => metadata, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false), Err(error) => return Err(error.into()) };
    if !metadata.is_file() || metadata.file_type().is_symlink() { return Ok(false); }
    #[cfg(unix)] { use std::os::unix::fs::MetadataExt; if metadata.uid() != unsafe { libc::getuid() } { return Ok(false); } }
    private_file(path)?; Ok(true)
}
async fn wait_address(run: &mut Run, path: &Path, schemas: &Schemas, stop: &CancellationToken) -> Result<String> {
    let wait = async {
        loop {
            match tokio::fs::File::open(path).await {
                Ok(file) => { let mut bytes = Vec::new(); file.take(8193).read_to_end(&mut bytes).await?; anyhow::ensure!(bytes.len() <= 8192, "The Tailcat address file is too large."); let address = std::str::from_utf8(&bytes)?.trim(); anyhow::ensure!(schemas.valid("ownerTailcatAddress", &serde_json::json!(address))?, "Tailcat wrote an invalid connection address."); private_file(path)?; return Ok(address.to_owned()); }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}, Err(error) => return Err(error.into()),
            }
            if run.child.try_wait()?.is_some() { bail!("Tailcat exited before opening its tunnel. {}", error_tail(&run.stderr)); }
            tokio::select! { biased; _ = stop.cancelled() => bail!("Tailcat startup was stopped."), _ = tokio::time::sleep(Duration::from_millis(25)) => {} }
        }
    };
    tokio::time::timeout(Duration::from_secs(60), wait).await.context("Tailcat timed out while opening its tunnel.")?
}
fn error_tail(stderr: &Arc<Mutex<Vec<u8>>>) -> String { String::from_utf8_lossy(&stderr.lock().unwrap_or_else(std::sync::PoisonError::into_inner)).trim().chars().take(8192).collect() }
fn start_relay(listener: TcpListener, target: Value, stop: CancellationToken) -> JoinHandle<Result<()>> {
    tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                biased;
                _ = stop.cancelled() => break,
                _ = connections.join_next(), if !connections.is_empty() => {},
                accepted = listener.accept(), if connections.len() < 64 => {
                    let (mut incoming, _) = accepted?; let target = target.clone(); let cancelled = stop.clone();
                    connections.spawn(async move {
                        let connected = async {
                            if let Some(path) = target["socketPath"].as_str() {
                                #[cfg(unix)] { let mut upstream = tokio::net::UnixStream::connect(path).await?; tokio::io::copy_bidirectional(&mut incoming, &mut upstream).await?; return Ok::<_, std::io::Error>(()); }
                                #[cfg(not(unix))] return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "The Tailcat local transport is unavailable."));
                            }
                            let host = match target["host"].as_str().unwrap_or("127.0.0.1") { "0.0.0.0" => "127.0.0.1", "::" | "0:0:0:0:0:0:0:0" => "::1", host => host };
                            let mut upstream = TcpStream::connect((host, target["port"].as_u64().unwrap_or(0) as u16)).await?;
                            tokio::io::copy_bidirectional(&mut incoming, &mut upstream).await?; Ok(())
                        };
                        tokio::select! { biased; _ = cancelled.cancelled() => {}, _ = connected => {} }
                    });
                }
            }
        }
        drop(listener); while connections.join_next().await.is_some() {} Ok(())
    })
}