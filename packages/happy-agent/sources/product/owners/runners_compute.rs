//! Agent computes belong to Runners, including connection generations and safe
//! recovery. Product-machine Full access never substitutes for tool permissions.
use super::*;
use std::sync::Weak;
use tokio::sync::broadcast;

#[derive(Debug)]
struct RemoteError {
    message: String,
    code: Option<String>,
}
impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for RemoteError {}
pub(super) fn remote_error(error: &Value) -> anyhow::Error {
    RemoteError {
        message: error["message"].as_str().unwrap().to_owned(),
        code: error["code"].as_str().map(str::to_owned),
    }
    .into()
}
fn unknown_compute(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<RemoteError>()
        .is_some_and(|error| error.code.as_deref() == Some("ERUNNERCOMPUTEUNKNOWN"))
}

pub struct RunnerCompute {
    owner: Arc<RunnersModule>,
    runner: String,
    id: String,
    cwd: PathBuf,
    parameters: Value,
    creation: tokio::sync::Mutex<()>,
    state: Mutex<State>,
    updates: broadcast::Sender<Value>,
    disposed: AtomicBool,
}
struct State {
    ready: Option<Arc<Session>>,
    created: Option<Value>,
    generation: u64,
    next: u64,
    routes: BTreeMap<u64, (u64, u64)>,
    public: BTreeMap<u64, u64>,
    active: Vec<Value>,
}
#[derive(Clone)]
pub struct RunnerProcess {
    compute: Arc<RunnerCompute>,
    id: u64,
}

impl RunnersModule {
    pub async fn agent_compute(
        self: &Arc<Self>,
        runner: &str,
        agent: &str,
        configuration: &Value,
        cancel: &CancellationToken,
    ) -> Result<Arc<RunnerCompute>> {
        self.local(Some(runner))?;
        let environment = self.config.compute_file_environment(configuration)?;
        let mut agent_configuration = configuration["modules"]["compute"].clone();
        if agent_configuration.is_null() {
            agent_configuration = json!({"cwd":environment.root,"runnerId":runner});
        }
        anyhow::ensure!(
            self.schemas
                .valid("computeAgentConfiguration", &agent_configuration)?,
            "The agent's runner compute configuration is invalid."
        );
        let id = format!("agent-{agent}");
        let mut parameters = json!({"computeId":id,"cwd":environment.root,"policy":{"protectedProjectFiles":environment.protected_paths.iter().map(|path|path.strip_prefix(&environment.root).map(|path|path.to_string_lossy().into_owned())).collect::<std::result::Result<Vec<_>,_>>()?}});
        if let Some(docker) = agent_configuration.get("docker") {
            parameters["docker"] = docker.clone();
        }
        anyhow::ensure!(
            self.schemas
                .valid("ownerRunnerParams_compute_create", &parameters)?,
            "The agent's runner policy is invalid."
        );
        let compute = {
            let mut computes = self
                .computes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            computes.retain(|_, compute| compute.strong_count() > 0);
            if let Some(compute) = computes
                .get(&(runner.into(), id.clone()))
                .and_then(Weak::upgrade)
            {
                anyhow::ensure!(
                    compute.parameters == parameters,
                    "The agent's runner compute configuration changed while its machine is still owned."
                );
                compute
            } else {
                anyhow::ensure!(
                    computes.len() < 512,
                    "The bounded agent runner compute catalog is full."
                );
                let compute = Arc::new(RunnerCompute {
                    owner: self.clone(),
                    runner: runner.into(),
                    id: id.clone(),
                    cwd: environment.root,
                    parameters,
                    creation: tokio::sync::Mutex::new(()),
                    state: Mutex::new(State {
                        ready: None,
                        created: None,
                        generation: 0,
                        next: 1,
                        routes: BTreeMap::new(),
                        public: BTreeMap::new(),
                        active: Vec::new(),
                    }),
                    updates: broadcast::channel(128).0,
                    disposed: AtomicBool::new(false),
                });
                computes.insert((runner.into(), id), Arc::downgrade(&compute));
                compute
            }
        };
        let session = self.session(runner, cancel).await?;
        compute.ensure_created(&session, cancel).await?;
        Ok(compute)
    }
}
impl RunnerCompute {
    pub(super) fn id(&self) -> &str {
        &self.id
    }
    pub fn cwd(&self) -> &Path {
        &self.cwd
    }
    pub fn resolve(&self, written: &str) -> Result<PathBuf> {
        anyhow::ensure!(
            !written.is_empty() && !written.contains('\0'),
            "The file path is invalid."
        );
        let path = if written == "~" || written.starts_with("~/") {
            let home = self
                .home()
                .context("Home-relative paths are unavailable on this runner.")?;
            if written == "~" {
                home
            } else {
                home.join(&written[2..])
            }
        } else {
            let path = Path::new(written);
            if path.is_absolute() {
                path.to_owned()
            } else {
                self.cwd.join(path)
            }
        };
        let mut normalized = PathBuf::new();
        for part in path.components() {
            match part {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                part => normalized.push(part.as_os_str()),
            }
        }
        Ok(normalized)
    }
    pub fn home(&self) -> Option<PathBuf> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .created
            .as_ref()
            .and_then(|created| created["home"].as_str())
            .map(PathBuf::from)
    }
    pub fn on_event(&self) -> broadcast::Receiver<Value> {
        self.updates.subscribe()
    }
    pub fn active(&self) -> Vec<Value> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active
            .clone()
    }
    pub fn permissions(&self, mode: &str) -> Result<Value> {
        let full = mode == "full_access";
        let value = json!({"mode":mode,"network":{"egress":full,"localBinding":full}});
        anyhow::ensure!(
            self.owner
                .schemas
                .valid("computeRunnerPermissions", &value)?,
            "The runner action's permissions are invalid."
        );
        Ok(value)
    }
    pub(super) fn attached(&self, session: Arc<Session>, retained: bool) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if retained && state.ready.is_some() {
            state.ready = Some(session);
        } else {
            self.lose(&mut state);
        }
    }
    fn lose(&self, state: &mut State) {
        state.ready = None;
        state.generation = state.generation.saturating_add(1);
        state.public.clear();
        for active in state.active.drain(..) {
            let _=self.updates.send(json!({"type":"exit","exit":{"command":active["command"],"sessionId":active["sessionId"],"exitCode":null,"status":"killed"}}));
        }
        let _ = self.updates.send(json!({"type":"sessions","sessions":[]}));
    }
    pub(super) fn event(&self, event: &str, params: &Value) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if event == "shell.sessions" {
            let mut active = Vec::new();
            for session in params["sessions"].as_array().unwrap() {
                let mut session = session.clone();
                let Ok(id) = self.public_id(&mut state, session["sessionId"].as_u64().unwrap())
                else {
                    return;
                };
                session["sessionId"] = json!(id);
                active.push(session);
            }
            state.active = active;
            let _ = self
                .updates
                .send(json!({"type":"sessions","sessions":state.active}));
        } else if event == "shell.exit" {
            let mut exit = params["exit"].clone();
            let Ok(id) = self.public_id(&mut state, exit["sessionId"].as_u64().unwrap()) else {
                return;
            };
            exit["sessionId"] = json!(id);
            state.active.retain(|session| session["sessionId"] != id);
            let _ = self.updates.send(json!({"type":"exit","exit":exit}));
        }
    }
    fn public_id(&self, state: &mut State, remote: u64) -> Result<u64> {
        if let Some(id) = state.public.get(&remote) {
            return Ok(*id);
        }
        anyhow::ensure!(
            state.next <= 9_007_199_254_740_991,
            "The runner command handle space is exhausted."
        );
        // Only current routes plus a bounded history are retained. Lost handles
        // remain invalid even after an old route falls out of retention.
        while state.routes.len() >= 256 {
            let Some(old) = state
                .routes
                .keys()
                .find(|id| {
                    !state
                        .active
                        .iter()
                        .any(|active| active["sessionId"] == **id)
                })
                .copied()
            else {
                bail!("The runner command catalog is full.")
            };
            state.routes.remove(&old);
            state.public.retain(|_, id| *id != old);
        }
        let id = state.next;
        state.next += 1;
        state.public.insert(remote, id);
        state.routes.insert(id, (state.generation, remote));
        Ok(id)
    }
    fn route(&self, id: u64) -> Option<u64> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .routes
            .get(&id)
            .and_then(|(generation, remote)| (*generation == state.generation).then_some(*remote))
    }
    async fn ensure_created(
        &self,
        session: &Arc<Session>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        anyhow::ensure!(
            !self.disposed.load(Ordering::Acquire),
            "The agent's runner compute is disposed."
        );
        let _creation = tokio::select! {guard=self.creation.lock()=>guard,_=cancel.cancelled()=>bail!("The runner machine creation was cancelled.")};
        if self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .ready
            .as_ref()
            .is_some_and(|ready| Arc::ptr_eq(ready, session))
        {
            return Ok(());
        }
        let created = self
            .owner
            .request(session, "compute.create", self.parameters.clone(), cancel)
            .await?
            .0;
        anyhow::ensure!(
            created["cwd"].as_str() == self.cwd.to_str(),
            "The runner rebuilt this machine in a different working directory."
        );
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.created.is_some() && created["retained"] == false {
            self.lose(&mut state);
        }
        state.created = Some(created);
        state.ready = Some(session.clone());
        Ok(())
    }
    async fn call(
        &self,
        method: &str,
        mut parameters: Value,
        body: &[u8],
        cancel: &CancellationToken,
    ) -> Result<Frame> {
        anyhow::ensure!(
            !self.disposed.load(Ordering::Acquire),
            "The agent's runner compute is disposed."
        );
        let session = self.owner.session(&self.runner, cancel).await?;
        self.ensure_created(&session, cancel).await?;
        parameters["computeId"] = json!(self.id);
        match self
            .owner
            .request_body(&session, method, parameters.clone(), body, cancel)
            .await
        {
            Ok(answer) => Ok(answer),
            Err(error) if unknown_compute(&error) => {
                {
                    let mut state = self
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    self.lose(&mut state);
                }
                self.ensure_created(&session, cancel).await?;
                self.owner
                    .request_body(&session, method, parameters, body, cancel)
                    .await
            }
            Err(error) => Err(error),
        }
    }
    pub async fn exists(
        &self,
        permissions: &Value,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<bool> {
        Ok(self
            .call(
                "fs.exists",
                json!({"permissions":permissions,"path":path}),
                &[],
                cancel,
            )
            .await?
            .0["exists"]
            .as_bool()
            .unwrap())
    }
    pub async fn stat(
        &self,
        permissions: &Value,
        path: &Path,
        no_follow: bool,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        Ok(self
            .call(
                if no_follow { "fs.lstat" } else { "fs.stat" },
                json!({"permissions":permissions,"path":path}),
                &[],
                cancel,
            )
            .await?
            .0["stat"]
            .clone())
    }
    pub async fn canonical_path(
        &self,
        permissions: &Value,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        Ok(self
            .call(
                "fs.realpath",
                json!({"permissions":permissions,"path":path}),
                &[],
                cancel,
            )
            .await?
            .0["path"]
            .as_str()
            .unwrap()
            .into())
    }
    pub async fn read_file(
        &self,
        permissions: &Value,
        path: &Path,
        maximum: usize,
        no_follow: bool,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        let bytes=self.call("fs.readFileBuffer",json!({"permissions":permissions,"path":path,"maxBytes":maximum,"noFollow":no_follow}),&[],cancel).await?.1;
        anyhow::ensure!(
            bytes.len() <= maximum,
            "The runner returned a file beyond the requested byte limit."
        );
        Ok(bytes)
    }
    pub async fn write_file(
        &self,
        permissions: &Value,
        path: &Path,
        bytes: &[u8],
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.call(
            "fs.writeFile",
            json!({"permissions":permissions,"path":path,"encoding":"bytes"}),
            bytes,
            cancel,
        )
        .await?;
        Ok(())
    }
    pub async fn mkdir(
        &self,
        permissions: &Value,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.call(
            "fs.mkdir",
            json!({"permissions":permissions,"path":path,"recursive":true}),
            &[],
            cancel,
        )
        .await?;
        Ok(())
    }
    pub async fn chmod(
        &self,
        permissions: &Value,
        path: &Path,
        mode: u32,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.call(
            "fs.chmod",
            json!({"permissions":permissions,"path":path,"mode":mode}),
            &[],
            cancel,
        )
        .await?;
        Ok(())
    }
    pub async fn remove(
        &self,
        permissions: &Value,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.call(
            "fs.rm",
            json!({"permissions":permissions,"path":path,"force":false,"recursive":false}),
            &[],
            cancel,
        )
        .await?;
        Ok(())
    }
    pub async fn move_file(
        &self,
        permissions: &Value,
        source: &Path,
        destination: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.call(
            "fs.move",
            json!({"permissions":permissions,"source":source,"destination":destination}),
            &[],
            cancel,
        )
        .await?;
        Ok(())
    }
    pub async fn entries(
        &self,
        permissions: &Value,
        path: &Path,
        after: Option<&str>,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let mut parameters = json!({"permissions":permissions,"path":path,"limit":limit});
        if let Some(after) = after {
            parameters["after"] = json!(after);
        }
        Ok(self
            .call("fs.readdirPage", parameters, &[], cancel)
            .await?
            .0)
    }
    pub async fn start(
        self: &Arc<Self>,
        options: Value,
        cancel: &CancellationToken,
    ) -> Result<RunnerProcess> {
        let result = self
            .call(
                "shell.startSession",
                json!({"options":options}),
                &[],
                cancel,
            )
            .await?
            .0;
        let id = self.public_id(
            &mut self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            result["sessionId"].as_u64().unwrap(),
        )?;
        Ok(RunnerProcess {
            compute: self.clone(),
            id,
        })
    }
    pub async fn kill_all(&self, cancel: &CancellationToken) -> Result<usize> {
        Ok(self
            .call("shell.killAllSessions", json!({}), &[], cancel)
            .await?
            .0["killed"]
            .as_u64()
            .unwrap() as usize)
    }
    pub async fn dispose(&self, cancel: &CancellationToken) -> Result<()> {
        if self.disposed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let session = self.owner.session(&self.runner, cancel).await?;
        self.owner
            .request(
                &session,
                "compute.dispose",
                json!({"computeId":self.id}),
                cancel,
            )
            .await?;
        self.lose(
            &mut self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        Ok(())
    }
}
impl RunnerProcess {
    pub fn id(&self) -> u64 {
        self.id
    }
    pub async fn detach(&self, cancel: &CancellationToken) -> Result<()> {
        if let Some(remote) = self.compute.route(self.id) {
            self.compute
                .call(
                    "shell.detachSession",
                    json!({"sessionId":remote}),
                    &[],
                    cancel,
                )
                .await?;
        }
        Ok(())
    }
    pub async fn read(
        &self,
        wait: u64,
        peek: bool,
        cancel: &CancellationToken,
    ) -> Result<Option<Value>> {
        let Some(remote) = self.compute.route(self.id) else {
            return Ok(None);
        };
        let mut snapshot = self
            .compute
            .call(
                "shell.readSession",
                json!({"sessionId":remote,"waitMs":wait,"peek":peek}),
                &[],
                cancel,
            )
            .await?
            .0["snapshot"]
            .clone();
        if snapshot.is_null() {
            return Ok(None);
        }
        snapshot["sessionId"] = json!(self.id);
        Ok(Some(snapshot))
    }
    pub async fn write(
        &self,
        permissions: &Value,
        bytes: &[u8],
        cancel: &CancellationToken,
    ) -> Result<bool> {
        let Some(remote) = self.compute.route(self.id) else {
            return Ok(false);
        };
        Ok(self
            .compute
            .call(
                "shell.writeSession",
                json!({"permissions":permissions,"sessionId":remote,"encoding":"bytes"}),
                bytes,
                cancel,
            )
            .await?
            .0["written"]
            .as_bool()
            .unwrap())
    }
    pub async fn kill(&self, cancel: &CancellationToken) -> Result<Option<Value>> {
        let Some(remote) = self.compute.route(self.id) else {
            return Ok(None);
        };
        let mut snapshot = self
            .compute
            .call(
                "shell.killSession",
                json!({"sessionId":remote}),
                &[],
                cancel,
            )
            .await?
            .0["snapshot"]
            .clone();
        if snapshot.is_null() {
            return Ok(None);
        }
        snapshot["sessionId"] = json!(self.id);
        Ok(Some(snapshot))
    }
}
