//! A compute value owns the standalone runner's filesystem and command lifetime.
use super::*;
pub struct NativeRunnerCompute {
    pub filesystem: ComputeFilesystem,
    request: Value,
    owner: String,
    process_owner: String,
    commands: Arc<CommandSessions>,
    closed: std::sync::atomic::AtomicBool,
    schemas: Schemas,
    lifetime: CancellationToken,
}
pub struct NativeRunnerWatch {
    watcher: std::sync::Mutex<notify::RecommendedWatcher>,
    directories: std::sync::Mutex<std::collections::BTreeSet<std::path::PathBuf>>,
    ignored: std::collections::BTreeSet<String>,
    pending: Arc<std::sync::Mutex<(std::collections::BTreeSet<String>, bool)>>,
    changed: Arc<tokio::sync::Notify>,
    root: std::path::PathBuf,
}
impl NativeRunnerWatch {
    pub async fn next(&self) -> Value {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if {
                let pending = self
                    .pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                pending.1 || !pending.0.is_empty()
            } {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let (paths, mut overflow) = std::mem::take(
                    &mut *self
                        .pending
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner),
                );
                for path in &paths {
                    if self.extend(&self.root.join(path)).is_err() {
                        overflow = true;
                    }
                }
                if overflow {
                    return json!({"paths":[],"overflow":true});
                }
                return json!({"paths":paths,"overflow":false});
            }
            changed.await;
        }
    }
    pub fn root(&self) -> &std::path::Path {
        &self.root
    }
    fn extend(&self, path: &std::path::Path) -> Result<()> {
        use notify::Watcher;
        let mut watcher = self
            .watcher
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut directories = self
            .directories
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Deleted subtrees release their native descriptors and their bounded catalog slots.
        let gone = directories
            .iter()
            .filter(|directory| !directory.is_dir())
            .cloned()
            .collect::<Vec<_>>();
        for directory in gone {
            let _ = watcher.unwatch(&directory);
            directories.remove(&directory);
        }
        let mut queue = std::collections::VecDeque::from([path.to_owned()]);
        while let Some(directory) = queue.pop_front() {
            if directories.contains(&directory)
                || !std::fs::symlink_metadata(&directory).is_ok_and(|metadata| metadata.is_dir())
            {
                continue;
            }
            if directories.len() >= 20_000 {
                anyhow::bail!("This file watch reached its directory bound.");
            }
            watcher.watch(&directory, notify::RecursiveMode::NonRecursive)?;
            directories.insert(directory.clone());
            for entry in std::fs::read_dir(directory)? {
                let entry = entry?;
                if self
                    .ignored
                    .contains(&entry.file_name().to_string_lossy().into_owned())
                {
                    continue;
                }
                if entry.file_type()?.is_dir() {
                    if queue.len() + directories.len() >= 20_000 {
                        anyhow::bail!("This file watch reached its directory bound.");
                    }
                    queue.push_back(entry.path());
                }
            }
        }
        Ok(())
    }
}
impl ToolsModule {
    pub fn native_runner_compute(&self, request: &Value) -> Result<Arc<NativeRunnerCompute>> {
        ensure!(
            self.schemas
                .valid("ownerRunnerParams_compute_create", request)?,
            "The runner compute request is invalid."
        );
        Ok(Arc::new(NativeRunnerCompute {
            filesystem: self.native_runner_filesystem(request)?,
            request: request.clone(),
            owner: format!("runner-{}", uuid::Uuid::new_v4()),
            process_owner: format!("runner-programs-{}", uuid::Uuid::new_v4()),
            commands: self.commands.clone(),
            closed: std::sync::atomic::AtomicBool::new(false),
            schemas: Schemas::new()?,
            lifetime: CancellationToken::new(),
        }))
    }
}
impl NativeRunnerCompute {
    pub fn activity(&self) -> Vec<Value> {
        self.commands.native_runner_activity(&self.owner)
    }
    pub fn on_shell_event(&self) -> tokio::sync::broadcast::Receiver<(String, Value)> {
        self.commands.native_runner_events()
    }
    pub fn owns_shell_event(&self, owner: &str) -> bool {
        self.owner == owner
    }
    pub fn lifetime(&self) -> CancellationToken {
        self.lifetime.clone()
    }
    pub fn matches(&self, request: &Value) -> bool {
        self.request["cwd"] == request["cwd"] && self.request.get("docker") == request.get("docker")
    }
    pub async fn connect(&self, host: &str, port: u16) -> Result<tokio::net::TcpStream> {
        ensure!(
            !self.closed.load(std::sync::atomic::Ordering::Acquire),
            "The runner compute has been disposed."
        );
        Ok(tokio::time::timeout(
            std::time::Duration::from_secs(30),
            tokio::net::TcpStream::connect((host, port)),
        )
        .await
        .context("The network connection timed out.")??)
    }
    pub async fn listen(&self) -> Result<tokio::net::TcpListener> {
        ensure!(
            !self.closed.load(std::sync::atomic::Ordering::Acquire),
            "The runner compute has been disposed."
        );
        Ok(tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?)
    }
    pub fn watch(&self, path: &str, ignore: &Value) -> Result<NativeRunnerWatch> {
        ensure!(
            !self.closed.load(std::sync::atomic::Ordering::Acquire),
            "The runner compute has been disposed."
        );
        let root = self.filesystem.resolve(path)?;
        if !std::fs::symlink_metadata(&root)?.is_dir() {
            return Err(std::io::Error::from_raw_os_error(libc::ENOTDIR).into());
        }
        let ignored = ignore
            .as_array()
            .into_iter()
            .flatten()
            .map(|name| name.as_str().unwrap().to_owned())
            .collect::<std::collections::BTreeSet<_>>();
        let pending = Arc::new(std::sync::Mutex::new((
            std::collections::BTreeSet::new(),
            false,
        )));
        let changed = Arc::new(tokio::sync::Notify::new());
        let owned_pending = pending.clone();
        let owned_changed = changed.clone();
        let owned_root = root.clone();
        let owned_ignored = ignored.clone();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if event
                .as_ref()
                .is_ok_and(|event| matches!(event.kind, notify::EventKind::Access(_)))
            {
                return;
            }
            let mut pending = owned_pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match event {
                Ok(event) => {
                    if event.need_rescan() {
                        pending.1 = true;
                    }
                    for path in event.paths {
                        if let Ok(path) = path.strip_prefix(&owned_root) {
                            if path.components().any(|part| {
                                owned_ignored
                                    .contains(&part.as_os_str().to_string_lossy().into_owned())
                            }) {
                                continue;
                            }
                            pending.0.insert(path.to_string_lossy().replace('\\', "/"));
                        }
                    }
                    if pending.0.len() > 4096 {
                        pending.1 = true;
                    }
                }
                Err(_) => pending.1 = true,
            }
            if pending.1 {
                pending.0.clear();
            }
            owned_changed.notify_one();
        })?;
        let watch = NativeRunnerWatch {
            watcher: std::sync::Mutex::new(watcher),
            directories: std::sync::Mutex::new(std::collections::BTreeSet::new()),
            ignored,
            pending,
            changed,
            root,
        };
        if watch.extend(&watch.root).is_err() {
            watch
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .1 = true;
            watch.changed.notify_one();
        }
        Ok(watch)
    }
    pub async fn process(
        &self,
        params: &Value,
        _cancel: &CancellationToken,
    ) -> Result<Arc<NativeRunnerProcess>> {
        ensure!(
            !self.closed.load(std::sync::atomic::Ordering::Acquire),
            "The runner compute has been disposed."
        );
        ensure!(
            self.schemas
                .valid("ownerRunnerParams_process_start", params)?,
            "The runner process request is invalid."
        );
        self.commands
            .native_runner_process(&self.process_owner, &self.request, params, &self.lifetime)
            .await
    }
    pub async fn request(
        &self,
        method: &str,
        params: &Value,
        body: &[u8],
        cancel: &CancellationToken,
    ) -> Result<(Value, Vec<u8>)> {
        ensure!(
            !self.closed.load(std::sync::atomic::Ordering::Acquire),
            "The runner compute has been disposed."
        );
        ensure!(
            self.schemas.valid(
                &format!("ownerRunnerParams_{}", method.replace('.', "_")),
                params
            )?,
            "The runner compute request is invalid."
        );
        let answer = if method.starts_with("fs.") {
            self.filesystem
                .native_runner_request(method, params, body, cancel)
                .await?
        } else {
            (
                self.commands
                    .native_runner_request(
                        &self.owner,
                        &self.request,
                        method,
                        params,
                        body,
                        if method == "shell.startSession" {
                            &self.lifetime
                        } else {
                            cancel
                        },
                    )
                    .await?,
                Vec::new(),
            )
        };
        ensure!(
            self.schemas.valid(
                &format!("ownerRunnerResult_{}", method.replace('.', "_")),
                &answer.0
            )?,
            "The runner compute response is invalid."
        );
        Ok(answer)
    }
    pub async fn dispose(&self) -> Result<()> {
        self.lifetime.cancel();
        self.closed
            .store(true, std::sync::atomic::Ordering::Release);
        let cancel = CancellationToken::new();
        let (programs, shells) = tokio::join!(
            self.commands.archive_agent(&self.process_owner, &cancel),
            self.commands.archive_agent(&self.owner, &cancel)
        );
        programs.and(shells)
    }
}
