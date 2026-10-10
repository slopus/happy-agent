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
    docker: Option<Arc<crate::product::owners::RunnerCompute>>,
    docker_owner: Arc<crate::product::docker::DockerModule>,
    docker_events: Option<tokio::sync::broadcast::Sender<(String, Value)>>,
    docker_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
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
    pub async fn native_runner_compute(&self, request: &Value) -> Result<Arc<NativeRunnerCompute>> {
        ensure!(
            self.schemas
                .valid("ownerRunnerParams_compute_create", request)?
                || (self.config.is_container_worker()
                    && self
                        .schemas
                        .valid("ownerRunnerParams_compute_createContainer", request)?),
            "The runner compute request is invalid."
        );
        let lifetime = CancellationToken::new();
        let owner = format!("runner-{}", uuid::Uuid::new_v4());
        let docker = if request.get("docker").is_some() {
            Some(self.docker.compute(request, &lifetime).await?)
        } else {
            None
        };
        let (docker_events, docker_task) = if let Some(compute) = &docker {
            let (events, _) = tokio::sync::broadcast::channel(1024);
            let output = events.clone();
            let mut updates = compute.on_event();
            let own = owner.clone();
            let stop = lifetime.clone();
            let task = tokio::spawn(async move {
                loop {
                    tokio::select! {_=stop.cancelled()=>break,event=updates.recv()=>match event {Ok(event)=>{let _=output.send((own.clone(),event));},Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>{},Err(_)=>break}}
                }
            });
            (Some(events), Some(task))
        } else {
            (None, None)
        };
        Ok(Arc::new(NativeRunnerCompute {
            filesystem: if let Some(compute) = &docker {
                ComputeFilesystem::runner(compute.clone(), "full_access")?
            } else {
                self.native_runner_filesystem(request)?
            },
            request: request.clone(),
            owner,
            process_owner: format!("runner-programs-{}", uuid::Uuid::new_v4()),
            commands: self.commands.clone(),
            closed: std::sync::atomic::AtomicBool::new(false),
            schemas: Schemas::new()?,
            lifetime,
            docker,
            docker_owner: self.docker.clone(),
            docker_events,
            docker_task: std::sync::Mutex::new(docker_task),
        }))
    }
}
impl NativeRunnerCompute {
    pub fn configuration(&self) -> Value {
        json!({"modules":{"compute":{"cwd":self.request["cwd"]}},"_dockerRequest":self.request})
    }
    pub async fn secret_shell(&self, params: &Value, cancel: &CancellationToken) -> Result<Value> {
        ensure!(
            self.docker.is_none(),
            "Secret shell provisioning belongs to the private container worker."
        );
        ensure!(
            !self.closed.load(std::sync::atomic::Ordering::Acquire),
            "The container compute has been disposed."
        );
        let mut options = params["options"].clone();
        options["_runnerSecretEnvironment"] = params["environment"].clone();
        options["_runnerHiddenEnvironment"] = params["hiddenEnvironmentVariables"].clone();
        Ok(
            json!({"sessionId":self.commands.native_runner_start(&self.owner,&self.request,&options,cancel).await?}),
        )
    }
    pub fn activity(&self) -> Vec<Value> {
        if let Some(compute) = &self.docker {
            return compute.active();
        };
        self.commands.native_runner_activity(&self.owner)
    }
    pub fn on_shell_event(&self) -> tokio::sync::broadcast::Receiver<(String, Value)> {
        if let Some(events) = &self.docker_events {
            return events.subscribe();
        };
        self.commands.native_runner_events()
    }
    pub fn owns_shell_event(&self, owner: &str) -> bool {
        self.owner == owner
    }
    pub fn lifetime(&self) -> CancellationToken {
        self.lifetime.clone()
    }
    pub fn kind(&self) -> &'static str {
        if self.docker.is_some() {
            "docker"
        } else {
            "host"
        }
    }
    pub fn matches(&self, request: &Value) -> bool {
        self.request["cwd"] == request["cwd"] && self.request.get("docker") == request.get("docker")
    }
    pub async fn connect(&self, host: &str, port: u16) -> Result<tokio::net::TcpStream> {
        ensure!(
            self.docker.is_none(),
            "Docker compute does not expose a host TCP connection; container network streams have not been migrated."
        );
        ensure!(
            !self.closed.load(std::sync::atomic::Ordering::Acquire),
            "The runner compute has been disposed."
        );
        Ok(tokio::time::timeout(
            std::time::Duration::from_secs(30),
            tokio::net::TcpStream::connect((host, port)),
        )
        .await
        .map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("Connecting to {host}:{port} timed out."),
            )
        })??)
    }
    pub async fn listen(&self) -> Result<tokio::net::TcpListener> {
        ensure!(
            self.docker.is_none(),
            "Docker compute does not expose a host listener; container network streams have not been migrated."
        );
        ensure!(
            !self.closed.load(std::sync::atomic::Ordering::Acquire),
            "The runner compute has been disposed."
        );
        Ok(tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?)
    }
    pub fn watch(&self, path: &str, ignore: &Value) -> Result<NativeRunnerWatch> {
        ensure!(
            self.docker.is_none(),
            "Native host file watching cannot watch this Docker container."
        );
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
        if let Some(compute) = &self.docker {
            let mut options = params.clone();
            options.as_object_mut().unwrap().remove("computeId");
            options.as_object_mut().unwrap().remove("stream");
            return NativeRunnerProcess::container(
                compute.program(&options, &self.lifetime).await?,
            );
        }
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
        let answer = if let Some(compute) = &self.docker {
            compute
                .forward(
                    method,
                    params,
                    body,
                    if method == "shell.startSession" {
                        &self.lifetime
                    } else {
                        cancel
                    },
                )
                .await?
        } else if method.starts_with("fs.") {
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
        if let Some(task) = self
            .docker_task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
        let container = if self.docker.is_some() {
            self.docker_owner
                .dispose(self.request["computeId"].as_str().unwrap())
                .await
        } else {
            Ok(())
        };
        programs.and(shells).and(container)
    }
}
