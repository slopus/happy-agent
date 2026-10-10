use super::*;
use crate::product::owners::{RunnerCompute, RunnerProcess, RunnersModule};

pub(super) struct Commands {
    runners: Arc<RunnersModule>,
    lifecycle: Arc<LifecycleModule>,
    processes: Arc<processes::Processes>,
    next: Arc<AtomicU64>,
    sessions: Arc<Mutex<BTreeMap<u64, Arc<RemoteSession>>>>,
    computes: Mutex<BTreeMap<String, (Arc<RunnerCompute>, tokio::task::JoinHandle<()>)>>,
    capacity: Arc<tokio::sync::Semaphore>,
}
struct RemoteSession {
    owner: String,
    id: u64,
    command: String,
    started: u64,
    process: RunnerProcess,
    status: Mutex<(bool, Option<i32>)>,
    read: tokio::sync::Mutex<()>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl Commands {
    pub fn new(
        runners: Arc<RunnersModule>,
        lifecycle: Arc<LifecycleModule>,
        processes: Arc<processes::Processes>,
        next: Arc<AtomicU64>,
    ) -> Self {
        Self {
            runners,
            lifecycle,
            processes,
            next,
            sessions: Arc::new(Mutex::new(BTreeMap::new())),
            computes: Mutex::new(BTreeMap::new()),
            capacity: Arc::new(tokio::sync::Semaphore::new(128)),
        }
    }
    pub fn assert_local(&self) -> Result<()> {
        anyhow::ensure!(
            !self.runners.enabled(),
            "Local execution is disabled while runners are configured."
        );
        Ok(())
    }
    pub fn contains(&self, agent: &str, id: u64) -> bool {
        self.session(agent, id).is_ok()
    }
    fn session(&self, agent: &str, id: u64) -> Result<Arc<RemoteSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&id)
            .filter(|session| session.owner == agent)
            .cloned()
            .with_context(|| format!("There is no command {id} on this machine."))
    }
    pub async fn start(
        &self,
        agent: &str,
        configuration: &Value,
        mode: &str,
        args: &Value,
        wait: u64,
        capture: usize,
        cancel: CancellationToken,
    ) -> Result<Snapshot> {
        anyhow::ensure!(
            !args["secrets"]
                .as_array()
                .is_some_and(|selected| !selected.is_empty()),
            "Attached secrets are not available to commands on a runner yet."
        );
        let runner = configuration["modules"]["compute"]["runnerId"]
            .as_str()
            .context("The agent's runner is missing.")?;
        let compute = self
            .runners
            .agent_compute(runner, agent, configuration, &cancel)
            .await?;
        self.observe(agent, compute.clone())?;
        let mut options = json!({"command":args["cmd"],"permissions":compute.permissions(mode)?,"maxOutputBytes":capture});
        for (input, output) in [("workdir", "cwd"), ("shell", "shell"), ("tty", "tty")] {
            if let Some(value) = args.get(input) {
                options[output] = value.clone();
            }
        }
        let began = Instant::now();
        let permit = match self.capacity.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                let mut sessions = self
                    .sessions
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(old) = sessions
                    .iter()
                    .find(|(_, session)| {
                        session
                            .status
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .0
                    })
                    .map(|(id, _)| *id)
                {
                    sessions.remove(&old);
                }
                self.capacity
                    .clone()
                    .try_acquire_owned()
                    .context("The bounded runner command catalog is full.")?
            }
        };
        let process = compute.start(options, &cancel).await?;
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let session = Arc::new(RemoteSession {
            owner: agent.into(),
            id,
            command: args["cmd"].as_str().unwrap().into(),
            started: crate::product::identity::now(),
            process,
            status: Mutex::new((false, None)),
            read: tokio::sync::Mutex::new(()),
            _permit: permit,
        });
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id, session.clone());
        let result = self.snapshot(&session, wait, began, &cancel).await;
        if result.as_ref().is_ok_and(|snapshot| !snapshot.finished) {
            session
                .process
                .detach(&self.lifecycle.shutdown.child_token())
                .await?;
            let status = *session
                .status
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.processes
                .detach_remote(
                    id,
                    agent,
                    &session.command,
                    session.started,
                    status.0.then_some(status.1),
                )
                .await?;
        } else if result.is_err() && args["background"] != true {
            let _ = self
                .stop(agent, id, &self.lifecycle.shutdown.child_token())
                .await;
        }
        result
    }
    fn observe(&self, agent: &str, compute: Arc<RunnerCompute>) -> Result<()> {
        let mut computes = self
            .computes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if computes.contains_key(agent) {
            return Ok(());
        }
        anyhow::ensure!(
            computes.len() < 256,
            "The bounded runner command observer catalog is full."
        );
        let mut events = compute.on_event();
        let sessions = self.sessions.clone();
        let processes = self.processes.clone();
        let root = self.lifecycle.shutdown.child_token();
        let owner = agent.to_owned();
        let task = tokio::spawn(async move {
            loop {
                let event = tokio::select! {_=root.cancelled()=>break,event=events.recv()=>event};
                match event {
                    Ok(event) if event["type"] == "exit" => {
                        let id = event["exit"]["sessionId"].as_u64().unwrap();
                        let code = event["exit"]["exitCode"]
                            .as_i64()
                            .and_then(|code| i32::try_from(code).ok());
                        let session = sessions
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .values()
                            .find(|session| session.owner == owner && session.process.id() == id)
                            .cloned();
                        if let Some(session) = session {
                            *session
                                .status
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) = (true, code);
                            let _ = processes.exit(session.id, code).await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let owned = sessions
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .values()
                            .filter(|session| session.owner == owner)
                            .cloned()
                            .collect::<Vec<_>>();
                        for session in owned {
                            if let Ok(Some(snapshot)) = session.process.read(0, true, &root).await
                                && snapshot["status"] != "running"
                            {
                                let code = snapshot["exitCode"]
                                    .as_i64()
                                    .and_then(|code| i32::try_from(code).ok());
                                *session
                                    .status
                                    .lock()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner) =
                                    (true, code);
                                let _ = processes.exit(session.id, code).await;
                            }
                        }
                    }
                    _ => {}
                }
            }
        });
        computes.insert(agent.into(), (compute, task));
        Ok(())
    }
    async fn snapshot(
        &self,
        session: &Arc<RemoteSession>,
        wait: u64,
        began: Instant,
        cancel: &CancellationToken,
    ) -> Result<Snapshot> {
        let _read = tokio::select! {guard=session.read.lock()=>guard,_=cancel.cancelled()=>anyhow::bail!("The command read was interrupted.")};
        let value = session
            .process
            .read(wait, false, cancel)
            .await?
            .with_context(|| format!("There is no command {} on this machine.", session.id))?;
        let finished = value["status"] != "running";
        let exit = value["exitCode"]
            .as_i64()
            .and_then(|code| i32::try_from(code).ok());
        {
            let mut status = session
                .status
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !status.0 {
                *status = (finished, exit);
            }
        }
        if finished {
            self.processes.exit(session.id, exit).await?;
        }
        Ok(Snapshot {
            command: session.command.clone(),
            session: session.id,
            stdout: value["stdoutDelta"].as_str().unwrap().into(),
            stderr: value["stderrDelta"].as_str().unwrap().into(),
            dropped: value["stdoutDeltaOmittedBytes"].as_u64().unwrap_or(0) as usize
                + value["stderrDeltaOmittedBytes"].as_u64().unwrap_or(0) as usize,
            finished,
            exit,
            wall_time: began.elapsed().as_secs_f64(),
        })
    }
    pub async fn input(
        &self,
        agent: &str,
        id: u64,
        mode: &str,
        args: &Value,
        wait: u64,
        cancel: CancellationToken,
    ) -> Result<Snapshot> {
        let began = Instant::now();
        let session = self.session(agent, id)?;
        let chars = args["chars"].as_str().unwrap_or("");
        if !chars.is_empty() {
            let full = mode == "full_access";
            let permissions = json!({"mode":mode,"network":{"egress":full,"localBinding":full}});
            anyhow::ensure!(
                session
                    .process
                    .write(&permissions, chars.as_bytes(), &cancel)
                    .await?,
                "Command {id} is not running, so there is nothing to type into."
            );
        }
        self.snapshot(&session, wait, began, &cancel).await
    }
    pub async fn stop(
        &self,
        agent: &str,
        id: u64,
        cancel: &CancellationToken,
    ) -> Result<(String, bool)> {
        let session = self.session(agent, id)?;
        let stopped = !session
            .status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .0;
        if stopped {
            let value = session.process.kill(cancel).await?;
            let code = value
                .as_ref()
                .and_then(|snapshot| snapshot["exitCode"].as_i64())
                .and_then(|code| i32::try_from(code).ok());
            *session
                .status
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = (true, code);
            self.processes.exit(id, code).await?;
        }
        Ok((session.command.clone(), stopped))
    }
    pub fn running(&self, agent: &str) -> Vec<(u64, String)> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|session| {
                session.owner == agent
                    && !session
                        .status
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .0
            })
            .map(|session| (session.id, session.command.clone()))
            .collect()
    }
    pub async fn stop_agent(&self, agent: &str, cancel: &CancellationToken) -> Result<()> {
        for (id, _) in self.running(agent) {
            self.stop(agent, id, cancel).await?;
        }
        Ok(())
    }
    pub async fn archive(&self, agent: &str, cancel: &CancellationToken) -> Result<()> {
        self.stop_agent(agent, cancel).await?;
        let compute = self
            .computes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(agent);
        if let Some((compute, task)) = compute {
            task.abort();
            compute.dispose(cancel).await?;
        }
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, session| session.owner != agent);
        Ok(())
    }
    pub async fn close(&self) {
        let agents = self
            .computes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for agent in agents {
            if let Err(error) = self
                .archive(&agent, &self.lifecycle.shutdown.child_token())
                .await
            {
                eprintln!("Runner command shutdown remains unconfirmed: {error:#}");
            }
        }
    }
}
