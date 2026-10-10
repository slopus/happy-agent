//! Product stdio survives only runner-confirmed streams and the runner's byte windows.
use super::{RunnersModule, Session, StreamSender};
use anyhow::{Context as _, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, watch};
use tokio_util::sync::CancellationToken;

const WINDOW: u64 = 512 * 1024;
const CHUNK: usize = 64 * 1024;

#[cfg(all(test, unix))]
#[path = "runners_program_io_tests.rs"]
mod io_tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunnerProgramExit {
    pub exit_code: Option<i64>,
    pub signal: Option<String>,
}
#[derive(Clone)]
enum Phase {
    Starting,
    Running,
    Closing,
    Exited(RunnerProgramExit),
    Lost(String),
}
enum Connection {
    Detached,
    Replaying(Arc<Session>),
    Connected(Arc<Session>),
}
impl Connection {
    fn session(&self) -> Option<&Arc<Session>> {
        match self {
            Self::Detached => None,
            Self::Replaying(session) | Self::Connected(session) => Some(session),
        }
    }
    fn ready(&self) -> Option<Arc<Session>> {
        match self {
            Self::Connected(session) if !session.cancel.is_cancelled() => Some(session.clone()),
            _ => None,
        }
    }
    fn matches(&self, session: &Arc<Session>) -> bool {
        self.session()
            .is_some_and(|current| Arc::ptr_eq(current, session))
    }
}
struct Output {
    received: u64,
    consumed: u64,
    ended_at: Option<u64>,
    chunks: VecDeque<u8>,
    taken: bool,
    abandoned: bool,
}
impl Output {
    fn new() -> Self {
        Self {
            received: 0,
            consumed: 0,
            ended_at: None,
            chunks: VecDeque::new(),
            taken: false,
            abandoned: false,
        }
    }
}
struct State {
    phase: Phase,
    connection: Connection,
    sent: u64,
    acknowledged: u64,
    retained: VecDeque<(u64, Vec<u8>)>,
    input_ended: bool,
    output: [Output; 2],
}
pub struct RunnerProgram {
    owner: Weak<RunnersModule>,
    pub(super) runner: String,
    id: u64,
    stream: u64,
    state: Mutex<State>,
    writer: AsyncMutex<()>,
    writes: CancellationToken,
    startup: CancellationToken,
    progress: watch::Sender<u64>,
    sequence: AtomicU64,
}
pub struct RunnerProgramStdout {
    program: Arc<RunnerProgram>,
}
struct Starting(Option<Arc<RunnerProgram>>);
impl Drop for Starting {
    fn drop(&mut self) {
        if let Some(program) = self.0.take() {
            program.send_now(json!({"type":"close","stream":program.stream}));
            program.send_now(json!({"type":"release","stream":program.stream}));
            program.lost("Starting the runner program was interrupted; its outcome is unknown.");
        }
    }
}

impl RunnersModule {
    pub async fn product_process(
        self: &Arc<Self>,
        runner: &str,
        options: &Value,
        cancel: &CancellationToken,
    ) -> Result<Arc<RunnerProgram>> {
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "The runners are shutting down."
        );
        ensure!(
            self.schemas.valid("ownerRunnerProgramOptions", options)?,
            "The runner program options are invalid."
        );
        let session = self.machine(runner, cancel).await?;
        ensure!(
            !self.closed.load(Ordering::Acquire)
                && !session.cancel.is_cancelled()
                && !cancel.is_cancelled(),
            "Starting the runner program was cancelled."
        );
        let id = self.next_program.fetch_add(1, Ordering::Relaxed);
        let stream = session.next_stream.fetch_add(1, Ordering::Relaxed);
        let program = Arc::new(RunnerProgram {
            owner: Arc::downgrade(self),
            runner: runner.to_owned(),
            id,
            stream,
            state: Mutex::new(State {
                phase: Phase::Starting,
                connection: Connection::Connected(session.clone()),
                sent: 0,
                acknowledged: 0,
                retained: VecDeque::new(),
                input_ended: false,
                output: [Output::new(), Output::new()],
            }),
            writer: AsyncMutex::new(()),
            writes: CancellationToken::new(),
            startup: CancellationToken::new(),
            progress: watch::channel(0).0,
            sequence: AtomicU64::new(0),
        });
        {
            let mut programs = self
                .programs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            ensure!(
                !self.closed.load(Ordering::Acquire),
                "The runners are shutting down."
            );
            ensure!(
                programs.len() < 256,
                "Too many runner programs are running."
            );
            let mut streams = session
                .streams
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            ensure!(streams.len() < 256, "Too many runner streams are open.");
            streams.insert(stream, StreamSender::Program(Arc::downgrade(&program)));
            programs.insert(id, program.clone());
        }
        let mut starting = Starting(Some(program.clone()));
        let mut params = options.clone();
        params["computeId"] = json!("happy-product");
        params["stream"] = json!(stream);
        if params.get("args").is_none() {
            params["args"] = json!([]);
        }
        tokio::select! { biased;
            _ = cancel.cancelled() => bail!("Starting the runner program was cancelled."),
            _ = program.startup.cancelled() => bail!("The runner program stopped while it was starting."),
            result = self.request(&session, "process.start", params, cancel) => { result?; }
        }
        {
            let mut state = program
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if matches!(state.phase, Phase::Starting) {
                state.phase = Phase::Running;
            }
            ensure!(
                !matches!(state.phase, Phase::Closing | Phase::Lost(_)),
                "The runner program stopped while it was starting."
            );
        }
        program.changed();
        starting.0.take();
        Ok(program)
    }
}

impl RunnerProgram {
    #[cfg(test)]
    pub(super) fn testing_buffers(&self) -> (usize, u64) {
        let state = self.state.lock().unwrap();
        (
            state.output[0].chunks.len(),
            state.sent - state.acknowledged,
        )
    }
    fn changed(&self) {
        self.progress
            .send_replace(self.sequence.fetch_add(1, Ordering::AcqRel) + 1);
    }
    fn send_now(&self, header: Value) {
        let session = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .connection
            .ready();
        if let Some(session) = session {
            super::tunnel::send_now(&session, header);
        }
    }
    pub(super) fn detached(&self, session: &Arc<Session>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.connection.matches(session) {
            state.connection = Connection::Detached;
            drop(state);
            self.changed();
        }
    }
    pub(super) fn attached(self: &Arc<Self>, session: &Arc<Session>) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !matches!(state.phase, Phase::Running | Phase::Closing) {
            return false;
        }
        state.connection = Connection::Replaying(session.clone());
        session
            .streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(self.stream, StreamSender::Program(Arc::downgrade(self)));
        drop(state);
        self.changed();
        true
    }
    pub(super) fn stream_id(&self) -> u64 {
        self.stream
    }
    pub(super) async fn replay(&self, session: &Arc<Session>) -> Result<()> {
        let retained = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !state.connection.matches(session)
                || matches!(state.phase, Phase::Exited(_) | Phase::Lost(_))
            {
                return Ok(());
            }
            state.retained.iter().cloned().collect::<Vec<_>>()
        };
        let cancel = CancellationToken::new();
        for (offset, bytes) in retained {
            self.send_to(
                session,
                json!({"type":"data","stream":self.stream,"channel":"in","offset":offset}),
                &bytes,
                &cancel,
            )
            .await?;
        }
        let (eof, consumed, closing) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !state.connection.matches(session)
                || matches!(state.phase, Phase::Exited(_) | Phase::Lost(_))
            {
                return Ok(());
            }
            state.connection = Connection::Connected(session.clone());
            (
                state.input_ended.then_some(state.sent),
                [state.output[0].consumed, state.output[1].consumed],
                matches!(state.phase, Phase::Closing),
            )
        };
        if let Some(offset) = eof {
            self.send_to(
                session,
                json!({"type":"eof","stream":self.stream,"channel":"in","offset":offset}),
                &[],
                &cancel,
            )
            .await?;
        }
        for (channel, consumed) in ["out", "err"].into_iter().zip(consumed) {
            self.send_to(
                session,
                json!({"type":"flow","stream":self.stream,"channel":channel,"consumed":consumed}),
                &[],
                &cancel,
            )
            .await?;
        }
        if closing {
            self.send_to(
                session,
                json!({"type":"close","stream":self.stream}),
                &[],
                &cancel,
            )
            .await?;
        }
        self.changed();
        Ok(())
    }
    fn forget(&self) {
        let session = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .connection
            .session()
            .cloned();
        self.forget_from(session);
    }
    fn forget_from(&self, session: Option<Arc<Session>>) {
        if let Some(session) = session {
            session
                .streams
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&self.stream);
        }
        if let Some(owner) = self.owner.upgrade() {
            owner
                .programs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&self.id);
        }
    }
    pub(super) fn lost(&self, reason: &str) {
        let session = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let session = state.connection.session().cloned();
            if !matches!(state.phase, Phase::Exited(_) | Phase::Lost(_)) {
                state.phase = Phase::Lost(reason.to_owned());
                state.connection = Connection::Detached;
                state.retained.clear();
            }
            session
        };
        self.startup.cancel();
        self.writes.cancel();
        self.changed();
        self.forget_from(session);
    }
    pub(super) fn receive_frame(
        &self,
        session: &Arc<Session>,
        header: Value,
        body: Vec<u8>,
    ) -> Result<Option<Value>> {
        let mut release = false;
        let reply = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !state.connection.matches(session) {
                return Ok(None);
            }
            match header["type"].as_str().unwrap() {
                "data" => {
                    let channel = match header["channel"].as_str().unwrap() {
                        "out" => 0,
                        "err" => 1,
                        _ => bail!("The runner sent program data on the input channel."),
                    };
                    let output = &mut state.output[channel];
                    let offset = header["offset"].as_u64().unwrap();
                    ensure!(
                        offset <= output.received,
                        "The other side skipped bytes in a stream."
                    );
                    let end = offset
                        .checked_add(body.len() as u64)
                        .context("The runner program byte count overflowed.")?;
                    if end <= output.received {
                        return Ok(None);
                    }
                    ensure!(
                        output.ended_at.is_none(),
                        "The other side sent bytes after a stream ended."
                    );
                    ensure!(
                        end - output.consumed <= WINDOW,
                        "The other side sent more than a stream's window."
                    );
                    let duplicate = usize::try_from(output.received - offset)?;
                    output.received = end;
                    if channel == 1 || output.abandoned {
                        output.consumed = end;
                        Some(
                            json!({"type":"flow","stream":self.stream,"channel":header["channel"],"consumed":end}),
                        )
                    } else {
                        output.chunks.extend(&body[duplicate..]);
                        None
                    }
                }
                "eof" => {
                    let channel = match header["channel"].as_str().unwrap() {
                        "out" => 0,
                        "err" => 1,
                        _ => bail!("The runner ended the program's input channel."),
                    };
                    let output = &mut state.output[channel];
                    ensure!(
                        header["offset"].as_u64() == Some(output.received),
                        "The other side ended a stream at the wrong position."
                    );
                    output.ended_at = Some(output.received);
                    None
                }
                "flow" => {
                    ensure!(
                        header["channel"] == "in",
                        "The runner acknowledged an invalid program channel."
                    );
                    let consumed = header["consumed"].as_u64().unwrap();
                    ensure!(
                        consumed <= state.sent,
                        "The other side acknowledged bytes that were never sent."
                    );
                    state.acknowledged = state.acknowledged.max(consumed);
                    while let Some((offset, bytes)) = state.retained.front_mut() {
                        let end = *offset + bytes.len() as u64;
                        if end <= consumed {
                            state.retained.pop_front();
                            continue;
                        }
                        if *offset < consumed {
                            bytes.drain(..usize::try_from(consumed - *offset)?);
                            *offset = consumed;
                        }
                        break;
                    }
                    None
                }
                "exit" => {
                    ensure!(
                        state.output.iter().all(|output| output.ended_at.is_some()),
                        "The runner program exit preceded output completion."
                    );
                    state.phase = Phase::Exited(RunnerProgramExit {
                        exit_code: if header["exitCode"].is_null() {
                            None
                        } else {
                            Some(
                                header["exitCode"]
                                    .as_i64()
                                    .context("The program exit code cannot be represented.")?,
                            )
                        },
                        signal: header["signal"].as_str().map(str::to_owned),
                    });
                    state.retained.clear();
                    release = true;
                    Some(json!({"type":"release","stream":self.stream}))
                }
                _ => bail!("The runner program received an invalid stream frame."),
            }
        };
        self.changed();
        if release {
            self.writes.cancel();
            self.forget();
        }
        Ok(reply)
    }
    pub fn take_stdout(self: &Arc<Self>) -> Result<RunnerProgramStdout> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        ensure!(
            !state.output[0].taken,
            "The runner program output already has a reader."
        );
        state.output[0].taken = true;
        Ok(RunnerProgramStdout {
            program: self.clone(),
        })
    }
    async fn send_to(
        &self,
        session: &Arc<Session>,
        header: Value,
        bytes: &[u8],
        cancel: &CancellationToken,
    ) -> Result<()> {
        let owner = self
            .owner
            .upgrade()
            .context("The runners are no longer available.")?;
        let frame = owner.frame(header, bytes)?;
        let permit = tokio::select! { biased;
            _ = cancel.cancelled() => bail!("The runner program operation was cancelled."),
            _ = session.cancel.cancelled() => bail!("The runner connection ended before the program operation was sent."),
            result = tokio::time::timeout(Duration::from_secs(10), session.sender.reserve()) => result??,
        };
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        ensure!(
            !cancel.is_cancelled()
                && !session.cancel.is_cancelled()
                && state.connection.matches(session),
            "The runner program stopped before the operation was sent."
        );
        permit.send(frame);
        Ok(())
    }
    pub async fn write(&self, bytes: &[u8], cancel: &CancellationToken) -> Result<bool> {
        let _writer = tokio::select! { biased; _ = cancel.cancelled() => bail!("Writing to the runner program was cancelled."), _ = self.writes.cancelled() => return Ok(false), guard = self.writer.lock() => guard };
        let mut progress = self.progress.subscribe();
        let mut position = 0;
        while position < bytes.len() {
            let ready = {
                let state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if state.input_ended || !matches!(state.phase, Phase::Running) {
                    return Ok(false);
                }
                state.connection.ready().map(|session| {
                    (
                        session,
                        state.sent,
                        WINDOW - (state.sent - state.acknowledged),
                    )
                })
            };
            let Some((session, offset, room)) = ready.filter(|(_, _, room)| *room > 0) else {
                tokio::select! { biased; _ = cancel.cancelled() => bail!("Writing to the runner program was cancelled."), _ = self.writes.cancelled() => return Ok(false), result = progress.changed() => { result?; } }
                continue;
            };
            let size = (bytes.len() - position).min(CHUNK).min(room as usize);
            if let Err(error) = self
                .send_input(&session, offset, &bytes[position..position + size], cancel)
                .await
            {
                if self.writes.is_cancelled() {
                    return Ok(false);
                }
                if session.cancel.is_cancelled() {
                    continue;
                }
                return Err(error);
            }
            position += size;
        }
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(matches!(state.phase, Phase::Running) && !state.input_ended)
    }
    async fn send_input(
        &self,
        session: &Arc<Session>,
        offset: u64,
        bytes: &[u8],
        cancel: &CancellationToken,
    ) -> Result<()> {
        let owner = self
            .owner
            .upgrade()
            .context("The runners are no longer available.")?;
        let frame = owner.frame(
            json!({"type":"data","stream":self.stream,"channel":"in","offset":offset}),
            bytes,
        )?;
        let permit = tokio::select! { biased;
            _ = cancel.cancelled() => bail!("Writing to the runner program was cancelled."),
            _ = session.cancel.cancelled() => bail!("The runner connection ended before input was sent."),
            _ = self.writes.cancelled() => bail!("The runner program stopped accepting input."),
            result = tokio::time::timeout(Duration::from_secs(10), session.sender.reserve()) => result??,
        };
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        ensure!(
            !cancel.is_cancelled()
                && !session.cancel.is_cancelled()
                && state
                    .connection
                    .ready()
                    .is_some_and(|current| Arc::ptr_eq(&current, session))
                && !self.writes.is_cancelled()
                && matches!(state.phase, Phase::Running),
            "The runner program stopped before input was sent."
        );
        ensure!(
            state.sent == offset && !state.input_ended,
            "The runner input changed while a write was waiting."
        );
        state.sent = offset
            .checked_add(bytes.len() as u64)
            .context("The runner input byte count overflowed.")?;
        state.retained.push_back((offset, bytes.to_vec()));
        permit.send(frame);
        Ok(())
    }
    pub async fn end_input(&self, cancel: &CancellationToken) -> Result<()> {
        let _writer = tokio::select! { biased; _ = cancel.cancelled() => bail!("Ending the runner program input was cancelled."), guard = self.writer.lock() => guard };
        ensure!(
            !cancel.is_cancelled(),
            "Ending the runner program input was cancelled before it was accepted."
        );
        let ready = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if matches!(state.phase, Phase::Exited(_) | Phase::Lost(_)) {
                return Ok(());
            }
            state.input_ended = true;
            state
                .connection
                .ready()
                .map(|session| (session, state.sent))
        };
        if let Some((session, offset)) = ready {
            if let Err(error) = self
                .send_to(
                    &session,
                    json!({"type":"eof","stream":self.stream,"channel":"in","offset":offset}),
                    &[],
                    cancel,
                )
                .await
            {
                if !session.cancel.is_cancelled() {
                    return Err(error);
                }
            }
        }
        Ok(())
    }
    pub async fn signal(&self, signal: &str, cancel: &CancellationToken) -> Result<()> {
        let mut progress = self.progress.subscribe();
        let waiting = async {
            loop {
                {
                    let state = self
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if matches!(state.phase, Phase::Exited(_) | Phase::Lost(_)) {
                        return Ok(None);
                    }
                    if let Some(session) = state.connection.ready() {
                        return Ok(Some(session));
                    }
                }
                tokio::select! { biased; _ = cancel.cancelled() => bail!("Signalling the runner program was cancelled."), result = progress.changed() => { result?; } }
            }
        };
        let Some(session) = tokio::time::timeout(Duration::from_secs(10), waiting)
            .await
            .context("The runner stayed away while signalling the program.")??
        else {
            return Ok(());
        };
        let owner = self
            .owner
            .upgrade()
            .context("The runners are no longer available.")?;
        owner
            .request(
                &session,
                "process.signal",
                json!({"stream":self.stream,"signal":signal}),
                cancel,
            )
            .await?;
        Ok(())
    }
    pub async fn wait(&self) -> Result<RunnerProgramExit> {
        let mut progress = self.progress.subscribe();
        loop {
            {
                let state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                match &state.phase {
                    Phase::Exited(exit) if state.output[0].chunks.is_empty() => {
                        return Ok(exit.clone());
                    }
                    Phase::Lost(reason) => bail!("{reason}"),
                    _ => {}
                }
            }
            progress
                .changed()
                .await
                .context("The runner program lifetime ended without an exit.")?;
        }
    }
    pub async fn close(&self) -> Result<()> {
        let (first, abandoned) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let abandoned = if !state.output[0].taken {
                state.output[0].abandoned = true;
                state.output[0].chunks.clear();
                state.output[0].consumed = state.output[0].received;
                Some(state.output[0].consumed)
            } else {
                None
            };
            let first = match state.phase {
                Phase::Exited(_) | Phase::Lost(_) | Phase::Closing => false,
                _ => {
                    state.phase = Phase::Closing;
                    true
                }
            };
            (first, abandoned)
        };
        if let Some(consumed) = abandoned {
            self.send_now(
                json!({"type":"flow","stream":self.stream,"channel":"out","consumed":consumed}),
            );
        }
        self.startup.cancel();
        self.writes.cancel();
        self.changed();
        let cancel = CancellationToken::new();
        let work = async {
            if !first {
                self.wait().await?;
                return Ok(());
            }
            let graceful = async {
                self.end_input(&cancel).await?;
                self.signal("SIGTERM", &cancel).await
            };
            tokio::pin!(graceful);
            let wait = self.wait();
            tokio::pin!(wait);
            let grace = tokio::time::sleep(Duration::from_secs(2));
            tokio::pin!(grace);
            let mut signalled = false;
            loop {
                tokio::select! {
                    result = &mut wait => { result?; return Ok(()); },
                    _ = &mut grace => break,
                    result = &mut graceful, if !signalled => { signalled = true; result?; },
                }
            }
            let force = self.signal("SIGKILL", &cancel);
            tokio::pin!(force);
            let mut killed = false;
            loop {
                tokio::select! { result = &mut wait => { result?; return Ok(()); }, result = &mut force, if !killed => { killed = true; result?; } }
            }
        };
        let result = tokio::time::timeout(Duration::from_secs(3), work).await;
        cancel.cancel();
        match result {
            Ok(result) => result,
            Err(_) => {
                self.send_now(json!({"type":"close","stream":self.stream}));
                bail!("The runner did not confirm program teardown in time.")
            }
        }
    }
}

impl RunnerProgramStdout {
    pub async fn recv(&mut self) -> Result<Option<Vec<u8>>> {
        let mut progress = self.program.progress.subscribe();
        loop {
            let next = {
                let mut state = self
                    .program
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Phase::Lost(reason) = &state.phase {
                    bail!("{reason}");
                }
                let output = &mut state.output[0];
                if !output.chunks.is_empty() {
                    let size = output.chunks.len().min(CHUNK);
                    let bytes = output.chunks.drain(..size).collect::<Vec<_>>();
                    output.consumed += bytes.len() as u64;
                    Some((bytes, output.consumed))
                } else if output.ended_at.is_some() || output.abandoned {
                    return Ok(None);
                } else {
                    None
                }
            };
            if let Some((bytes, consumed)) = next {
                let session = {
                    let state = self
                        .program
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if matches!(state.phase, Phase::Exited(_)) {
                        None
                    } else {
                        state.connection.ready()
                    }
                };
                if let Some(session) = session {
                    if let Err(error) = self.program.send_to(&session, json!({"type":"flow","stream":self.program.stream,"channel":"out","consumed":consumed}), &[], &CancellationToken::new()).await {
                        if !session.cancel.is_cancelled() { return Err(error); }
                    }
                }
                self.program.changed();
                return Ok(Some(bytes));
            }
            progress
                .changed()
                .await
                .context("The runner program output ended without EOF.")?;
        }
    }
}
impl Drop for RunnerProgramStdout {
    fn drop(&mut self) {
        let consumed = {
            let mut state = self
                .program
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.output[0].abandoned = true;
            state.output[0].chunks.clear();
            state.output[0].consumed = state.output[0].received;
            state.output[0].consumed
        };
        self.program.send_now(
            json!({"type":"flow","stream":self.program.stream,"channel":"out","consumed":consumed}),
        );
        self.program.changed();
    }
}
