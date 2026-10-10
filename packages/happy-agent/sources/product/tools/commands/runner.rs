//! Source shell RPCs use the same native launch and process-group owner as tools.
use super::*;
pub enum NativeRunnerProcessEvent {
    Data {
        error: bool,
        bytes: Vec<u8>,
    },
    Exit {
        code: Option<i32>,
        signal: Option<String>,
    },
}
pub struct NativeRunnerProcess {
    session: Option<Arc<CommandSession>>,
    container: Option<Arc<crate::product::owners::RunnerProgram>>,
    container_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    output: Mutex<Option<tokio::sync::mpsc::Receiver<NativeRunnerProcessEvent>>>,
}
impl NativeRunnerProcess {
    pub fn take_output(&self) -> Result<tokio::sync::mpsc::Receiver<NativeRunnerProcessEvent>> {
        self.output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            .context("The process output already has an owner.")
    }
    pub async fn input(&self, bytes: &[u8]) -> Result<()> {
        if let Some(program) = &self.container {
            program.write(bytes, &CancellationToken::new()).await?;
            return Ok(());
        };
        let mut input = self.session.as_ref().unwrap().stdin.lock().await;
        if let Some(input) = input.as_mut() {
            input.write_all(bytes).await?;
        }
        Ok(())
    }
    pub async fn end_input(&self) -> Result<()> {
        if let Some(program) = &self.container {
            return program.end_input(&CancellationToken::new()).await;
        };
        let mut input = self.session.as_ref().unwrap().stdin.lock().await;
        if let Some(mut stream) = input.take() {
            if self.session.as_ref().unwrap().terminal.is_some() {
                stream.write_all(&[4]).await?;
            }
            stream.shutdown().await?;
        }
        Ok(())
    }
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if let Some(program) = &self.container {
            return program.resize(cols, rows, &CancellationToken::new()).await;
        };
        let session = self.session.as_ref().unwrap();
        if session.finished() {
            return Ok(());
        }
        if let Some(terminal) = &session.terminal {
            terminal.resize(cols, rows)?;
        }
        Ok(())
    }
    pub async fn signal(&self, signal: &str) -> Result<()> {
        if let Some(program) = &self.container {
            return program.signal(signal, &CancellationToken::new()).await;
        };
        let signal = match signal {
            "SIGHUP" => libc::SIGHUP,
            "SIGINT" => libc::SIGINT,
            "SIGKILL" => libc::SIGKILL,
            "SIGQUIT" => libc::SIGQUIT,
            "SIGTERM" => libc::SIGTERM,
            _ => anyhow::bail!("The process signal is invalid."),
        };
        self.session.as_ref().unwrap().group.signal(signal)?;
        Ok(())
    }
    pub fn stop(&self) {
        if let Some(program) = &self.container {
            program.stop_now();
        }
        if let Some(session) = &self.session {
            let _ = session.group.signal(libc::SIGKILL);
            session.stop.cancel();
        }
    }
    pub fn container(program: Arc<crate::product::owners::RunnerProgram>) -> Result<Arc<Self>> {
        let mut stdout = Some(program.take_stdout()?);
        let mut stderr = Some(program.take_stderr()?);
        let (sender, receiver) = tokio::sync::mpsc::channel(8);
        let owned = program.clone();
        let task = tokio::spawn(async move {
            while stdout.is_some() || stderr.is_some() {
                tokio::select! {
                    result=async {stdout.as_mut().unwrap().recv().await},if stdout.is_some()=>match result {Ok(Some(bytes))=>{if sender.send(NativeRunnerProcessEvent::Data {error:false,bytes}).await.is_err(){owned.stop_now();return;}},Ok(None)=>{stdout=None},Err(_)=>{owned.stop_now();return}},
                    result=async {stderr.as_mut().unwrap().recv().await},if stderr.is_some()=>match result {Ok(Some(bytes))=>{if sender.send(NativeRunnerProcessEvent::Data {error:true,bytes}).await.is_err(){owned.stop_now();return;}},Ok(None)=>{stderr=None},Err(_)=>{owned.stop_now();return}},
                }
            }
            if let Ok(exit) = owned.wait().await {
                let _ = sender
                    .send(NativeRunnerProcessEvent::Exit {
                        code: exit.exit_code.and_then(|code| i32::try_from(code).ok()),
                        signal: exit.signal,
                    })
                    .await;
            }
        });
        Ok(Arc::new(Self {
            session: None,
            container: Some(program),
            container_task: Mutex::new(Some(task)),
            output: Mutex::new(Some(receiver)),
        }))
    }
}
impl Drop for NativeRunnerProcess {
    fn drop(&mut self) {
        self.stop();
        if let Some(task) = self
            .container_task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
    }
}
pub(super) fn signal_name(signal: i32) -> Option<&'static str> {
    match signal {
        libc::SIGHUP => Some("SIGHUP"),
        libc::SIGINT => Some("SIGINT"),
        libc::SIGKILL => Some("SIGKILL"),
        libc::SIGQUIT => Some("SIGQUIT"),
        libc::SIGTERM => Some("SIGTERM"),
        _ => None,
    }
}

impl CommandSessions {
    pub async fn native_runner_process(
        &self,
        owner: &str,
        request: &Value,
        params: &Value,
        cancel: &CancellationToken,
    ) -> Result<Arc<NativeRunnerProcess>> {
        let configuration = json!({"modules":{"compute":{"cwd":request["cwd"]}}});
        let mut arguments = json!({"cmd":params["command"],"_runnerProgram":params["command"],"_runnerArgs":params["args"],"_runnerEnvironment":params["environment"],"_runnerTerminal":params["terminal"],"tty":params["terminal"].is_object(),"permissions":{"mode":"full_access","network":{"egress":true,"localBinding":true}}});
        if let Some(cwd) = params.get("cwd") {
            arguments["workdir"] = cwd.clone();
        }
        let (sender, output) = tokio::sync::mpsc::channel(8);
        let snapshot = self
            .start_local_snapshot(
                owner,
                &configuration,
                "full_access",
                &arguments,
                0,
                512_000,
                cancel.clone(),
                Some(request),
                Some(sender),
            )
            .await?;
        Ok(Arc::new(NativeRunnerProcess {
            session: Some(
                snapshot
                    .process_session
                    .context("The native product process lost its startup owner.")?,
            ),
            container: None,
            container_task: Mutex::new(None),
            output: Mutex::new(Some(output)),
        }))
    }
    pub async fn native_runner_start(
        &self,
        owner: &str,
        request: &Value,
        options: &Value,
        cancel: &CancellationToken,
    ) -> Result<u64> {
        let mode = options["permissions"]["mode"]
            .as_str()
            .context("The shell permission mode is missing.")?;
        anyhow::ensure!(
            mode == "full_access" || !options["shell"].is_string(),
            "A custom shell requires Full access."
        );
        let configuration = json!({"modules":{"compute":{"cwd":request["cwd"]}}});
        let mut arguments = json!({"cmd":options["command"],"tty":options["tty"]==true,"permissions":options["permissions"],"timeoutMs":options["timeoutMs"].as_u64().unwrap_or(120_000)});
        if options["_runnerQuiet"] == true {
            arguments["_runnerQuiet"] = json!(true);
        }
        for field in ["_runnerSecretEnvironment", "_runnerHiddenEnvironment"] {
            if let Some(value) = options.get(field) {
                arguments[field] = value.clone();
            }
        }
        for (from, to) in [("cwd", "workdir"), ("shell", "shell")] {
            if let Some(value) = options.get(from) {
                arguments[to] = value.clone();
            }
        }
        let capture = options["maxOutputBytes"]
            .as_u64()
            .unwrap_or(512_000)
            .min(16 * 1024 * 1024) as usize;
        Ok(self
            .start_local_snapshot(
                owner,
                &configuration,
                mode,
                &arguments,
                0,
                capture,
                cancel.clone(),
                Some(request),
                None,
            )
            .await?
            .session)
    }
    pub async fn native_runner_read(
        &self,
        owner: &str,
        id: u64,
        wait: u64,
        peek: bool,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let Ok(session) = self.session(owner, id) else {
            return Ok(Value::Null);
        };
        let _read = tokio::select! {read=session.read.lock()=>read,_=cancel.cancelled()=>anyhow::bail!("The command read was interrupted.")};
        if !session.finished() && wait > 0 {
            struct Consuming<'a>(Option<&'a AtomicU64>);
            impl Drop for Consuming<'_> {
                fn drop(&mut self) {
                    if let Some(waiters) = self.0 {
                        waiters.fetch_sub(1, Ordering::AcqRel);
                    }
                }
            }
            let _consuming = if peek {
                Consuming(None)
            } else {
                session.consuming_waiters.fetch_add(1, Ordering::AcqRel);
                Consuming(Some(&session.consuming_waiters))
            };
            tokio::select! {_=session.wait_finished()=>{},_=tokio::time::sleep(Duration::from_millis(wait))=>{},_=cancel.cancelled()=>anyhow::bail!("The command read was interrupted.")}
        }
        anyhow::ensure!(!cancel.is_cancelled(), "The command read was interrupted.");
        let mut state = session
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (stdout, stderr) = state
            .retained
            .as_ref()
            .context("This is not a runner shell session.")?;
        let (stdout, stdout_bytes, stdout_omitted) = stdout.peek();
        let (stderr, stderr_bytes, stderr_omitted) = stderr.peek();
        let (stdout_delta, stdout_delta_bytes, stdout_delta_omitted) = state.stdout.peek();
        let (stderr_delta, stderr_delta_bytes, stderr_delta_omitted) = state.stderr.peek();
        if !peek {
            state.stdout.drain();
            state.stderr.drain();
            if state.finished {
                session.exit_observed.store(true, Ordering::Release);
            }
        }
        Ok(
            json!({"command":session.command,"cwd":session.cwd,"sessionId":id,"status":if !state.finished{"running"}else if state.killed{"killed"}else{"completed"},"exitCode":state.exit,"timedOut":state.timed_out,"stdout":stdout,"stderr":stderr,"stdoutDelta":stdout_delta,"stderrDelta":stderr_delta,"stdoutBytes":stdout_bytes,"stderrBytes":stderr_bytes,"stdoutOmittedBytes":stdout_omitted,"stderrOmittedBytes":stderr_omitted,"stdoutDeltaBytes":stdout_delta_bytes,"stderrDeltaBytes":stderr_delta_bytes,"stdoutDeltaOmittedBytes":stdout_delta_omitted,"stderrDeltaOmittedBytes":stderr_delta_omitted}),
        )
    }
    pub async fn native_runner_write(
        &self,
        owner: &str,
        id: u64,
        body: &[u8],
        cancel: &CancellationToken,
    ) -> Result<bool> {
        let Ok(session) = self.session(owner, id) else {
            return Ok(false);
        };
        if session.finished() {
            return Ok(false);
        }
        let mut input = tokio::select! {input=session.stdin.lock()=>input,_=cancel.cancelled()=>anyhow::bail!("The command input was interrupted.")};
        let Some(input) = input.as_mut() else {
            return Ok(false);
        };
        tokio::select! {result=input.write_all(body)=>{result?;Ok(true)},_=cancel.cancelled()=>anyhow::bail!("The command input was interrupted.")}
    }
    pub async fn native_runner_request(
        &self,
        owner: &str,
        request: &Value,
        method: &str,
        params: &Value,
        body: &[u8],
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let id = params["sessionId"].as_u64().unwrap_or(0);
        match method {
            "shell.startSession" => Ok(
                json!({"sessionId":self.native_runner_start(owner,request,&params["options"],cancel).await?}),
            ),
            "shell.readSession" => Ok(
                json!({"snapshot":self.native_runner_read(owner,id,params["waitMs"].as_u64().unwrap_or(0),params["peek"]==true,cancel).await?}),
            ),
            "shell.killSession" => {
                if self.session(owner, id).is_ok() {
                    self.session(owner, id)?
                        .exit_observed
                        .store(true, Ordering::Release);
                    self.stop(owner, id).await?;
                }
                Ok(json!({"snapshot":self.native_runner_read(owner,id,0,true,cancel).await?}))
            }
            "shell.writeSession" => {
                let text = String::from_utf8_lossy(body);
                let bytes = if params["encoding"] == "text" {
                    text.strip_prefix('\u{feff}').unwrap_or(&text).as_bytes()
                } else {
                    body
                };
                Ok(json!({"written":self.native_runner_write(owner,id,bytes,cancel).await?}))
            }
            "shell.interruptSession" => {
                let interrupted = match self.session(owner, id) {
                    Ok(session) => {
                        #[cfg(unix)]
                        {
                            if !session.finished() {
                                session.group.signal(libc::SIGINT)?;
                            }
                            json!(!session.finished())
                        }
                        #[cfg(windows)]
                        {
                            let _ = session;
                            // Source has no shell interrupt operation on Windows.
                            json!(false)
                        }
                    }
                    Err(_) => Value::Null,
                };
                Ok(json!({"interrupted":interrupted}))
            }
            "shell.detachSession" => {
                if let Ok(session) = self.session(owner, id) {
                    self.processes.detach(&session).await?;
                }
                Ok(json!({}))
            }
            "shell.killAllSessions" => {
                let sessions = self
                    .sessions
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .values()
                    .filter(|session| session.owner == owner && !session.finished())
                    .cloned()
                    .collect::<Vec<_>>();
                for session in &sessions {
                    session.exit_observed.store(true, Ordering::Release);
                    session.stop.cancel();
                }
                for session in &sessions {
                    tokio::select! {_=session.wait_finished()=>{},_=cancel.cancelled()=>anyhow::bail!("Command cleanup was interrupted.")}
                }
                Ok(json!({"killed":sessions.len()}))
            }
            "shell.run" => {
                let mut options = params["options"].clone();
                options["_runnerQuiet"] = json!(true);
                let id = self
                    .native_runner_start(owner, request, &options, cancel)
                    .await?;
                let timeout = params["options"]["timeoutMs"].as_u64().unwrap_or(120_000);
                let read = self
                    .native_runner_read(owner, id, timeout, false, cancel)
                    .await;
                if read.is_err() {
                    self.stop(owner, id).await?;
                    return Err(read.unwrap_err());
                }
                let mut snapshot = read?;
                if snapshot["status"] == "running" {
                    self.stop(owner, id).await?;
                    snapshot = self
                        .native_runner_read(owner, id, 0, false, &CancellationToken::new())
                        .await?;
                    snapshot["timedOut"] = json!(true);
                }
                Ok(
                    json!({"result":{"stdout":snapshot["stdout"],"stderr":snapshot["stderr"],"stdoutBytes":snapshot["stdoutBytes"],"stderrBytes":snapshot["stderrBytes"],"stdoutOmittedBytes":snapshot["stdoutOmittedBytes"],"stderrOmittedBytes":snapshot["stderrOmittedBytes"],"exitCode":snapshot["exitCode"],"timedOut":snapshot["timedOut"]}}),
                )
            }
            _ => anyhow::bail!("This is not a runner shell operation."),
        }
    }
    pub fn native_runner_events(&self) -> tokio::sync::broadcast::Receiver<(String, Value)> {
        self.runner_events.subscribe()
    }
    pub fn native_runner_activity(&self, owner: &str) -> Vec<Value> {
        self.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner).values().filter(|session|session.owner==owner&&session.runner_events.is_some()&&!session.finished()).map(|session|json!({"command":session.command,"cwd":session.cwd,"sessionId":session.id,"status":"running"})).collect()
    }
}
