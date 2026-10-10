//! ECMAScript matching in an owned, bounded native child. No JavaScript engine
//! or application credentials are present in the worker.
use super::*;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
const REQUEST_BYTES: usize = 8 * 1024 * 1024;
const RESPONSE_BYTES: usize = 256 * 1024;

#[cfg(test)]
#[test]
fn dropping_a_rejected_regex_worker_releases_its_blocked_output_reader() {
    let child = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let (sender, output) = mpsc::sync_channel(1);
    sender.send(Ok(b"invalid response\n".to_vec())).unwrap();
    let reader = std::thread::spawn(move || {
        let _ = sender.send(Ok(b"extra response\n".to_vec()));
    });
    let worker = Worker {
        child,
        input: None,
        output,
        reader: Some(reader),
        began: Instant::now(),
        cancel: CancellationToken::new(),
        schemas: Schemas::new().unwrap(),
    };
    let (done, completed) = mpsc::channel();
    std::thread::spawn(move || {
        drop(worker);
        done.send(()).unwrap();
    });
    completed
        .recv_timeout(Duration::from_secs(2))
        .expect("a rejected worker must release its bounded output reader before joining it");
}

pub(super) struct Worker {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<Result<Vec<u8>>>,
    reader: Option<std::thread::JoinHandle<()>>,
    began: Instant,
    cancel: CancellationToken,
    schemas: Schemas,
}
impl Worker {
    pub fn new(
        pattern: &str,
        ignore_case: bool,
        multiline: bool,
        count_occurrences: bool,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        let schemas = Schemas::new()?;
        let mut executable = std::env::current_exe()?;
        #[cfg(test)]
        if let Some(path) = std::env::var_os("HAPPY_AGENT_TEST_COMPUTE_BINARY") {
            executable = path.into();
        }
        let mut command = std::process::Command::new(executable);
        command
            .arg("compute-regex")
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                command.pre_exec(|| {
                    for (resource, amount) in [
                        (libc::RLIMIT_AS, 512 * 1024 * 1024),
                        (libc::RLIMIT_CPU, 10),
                        (libc::RLIMIT_NOFILE, 32),
                    ] {
                        let limit = libc::rlimit {
                            rlim_cur: amount,
                            rlim_max: amount,
                        };
                        if libc::setrlimit(resource, &limit) != 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                    }
                    Ok(())
                });
            }
        }
        let child = command
            .spawn()
            .context("The native regular expression worker could not start.")?;
        let (sender, output) = mpsc::sync_channel(1);
        let mut worker = Self {
            child,
            input: None,
            output,
            reader: None,
            began: Instant::now(),
            cancel: cancel.clone(),
            schemas,
        };
        worker.input = worker.child.stdin.take();
        let stdout = worker
            .child
            .stdout
            .take()
            .context("The regular expression worker has no output pipe.")?;
        let reader = std::thread::Builder::new()
            .name("compute-regex-output".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    let mut bytes = Vec::new();
                    let result = reader
                        .by_ref()
                        .take(RESPONSE_BYTES as u64 + 1)
                        .read_until(b'\n', &mut bytes);
                    match result {
                        Ok(0) => break,
                        Ok(_) if bytes.len() <= RESPONSE_BYTES && bytes.last() == Some(&b'\n') => {
                            if sender.send(Ok(bytes)).is_err() {
                                break;
                            }
                        }
                        Ok(_) => {
                            let _ = sender.send(Err(anyhow::anyhow!(
                                "The regular expression worker exceeded its output bound."
                            )));
                            break;
                        }
                        Err(error) => {
                            let _ = sender.send(Err(error.into()));
                            break;
                        }
                    }
                }
            })?;
        worker.reader = Some(reader);
        let ready=worker.request(json!({"kind":"init","pattern":pattern,"ignoreCase":ignore_case,"multiline":multiline,"countOccurrences":count_occurrences}))?;
        ensure!(
            ready["ready"] == true,
            "The regular expression worker did not initialize."
        );
        Ok(worker)
    }
    pub fn scan(&mut self, content: &str, budget: usize) -> Result<Value> {
        self.request(json!({"kind":"file","content":content,"budget":budget}))
    }
    fn request(&mut self, request: Value) -> Result<Value> {
        ensure!(
            self.schemas.valid("computeRegexRequest", &request)?,
            "The regular expression request exceeds its input bounds."
        );
        let mut bytes = serde_json::to_vec(&request)?;
        bytes.push(b'\n');
        ensure!(
            bytes.len() <= REQUEST_BYTES,
            "The regular expression request exceeds its byte limit."
        );
        self.input
            .as_mut()
            .context("The regular expression worker is closed.")?
            .write_all(&bytes)?;
        loop {
            ensure!(
                !self.cancel.is_cancelled(),
                "The file search was interrupted."
            );
            ensure!(
                self.began.elapsed() < Duration::from_secs(15),
                "The regular expression exhausted its bounded execution time. Narrow the pattern or directory."
            );
            match self.output.recv_timeout(Duration::from_millis(20)) {
                Ok(answer) => {
                    let value: Value = serde_json::from_slice(&answer?)?;
                    ensure!(
                        self.schemas.valid("computeRegexResponse", &value)?,
                        "The regular expression worker returned an invalid result."
                    );
                    if let Some(error) = value["error"].as_str() {
                        anyhow::bail!("{error}");
                    }
                    return Ok(value);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => anyhow::bail!(
                    "The regular expression worker ended before proving a search result, possibly after exhausting its execution or memory limit."
                ),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        // A malformed worker can fill the response slot before the caller
        // rejects it. Release that slot before joining its blocked producer.
        let (_, closed) = mpsc::sync_channel(0);
        drop(std::mem::replace(&mut self.output, closed));
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

pub(in crate::product::tools) fn run() -> std::process::ExitCode {
    match serve() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(_) => std::process::ExitCode::FAILURE,
    }
}
fn serve() -> Result<()> {
    let schemas = Schemas::new()?;
    let input = std::io::stdin();
    let mut input = BufReader::new(input.lock());
    let output = std::io::stdout();
    let mut output = output.lock();
    let mut expression: Option<regress::Regex> = None;
    let mut multiline = false;
    let mut count_occurrences = false;
    loop {
        let mut bytes = Vec::new();
        let count = input
            .by_ref()
            .take(REQUEST_BYTES as u64 + 1)
            .read_until(b'\n', &mut bytes)?;
        if count == 0 {
            return Ok(());
        }
        ensure!(
            bytes.len() <= REQUEST_BYTES && bytes.last() == Some(&b'\n'),
            "The worker request exceeded its framing bound."
        );
        let request: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            schemas.valid("computeRegexRequest", &request)?,
            "The worker request is invalid."
        );
        let response = if request["kind"] == "init" {
            ensure!(expression.is_none(), "The worker is already initialized.");
            multiline = request["multiline"].as_bool().unwrap();
            count_occurrences = request["countOccurrences"].as_bool().unwrap();
            match regress::Regex::with_flags(
                request["pattern"].as_str().unwrap(),
                regress::Flags {
                    icase: request["ignoreCase"].as_bool().unwrap(),
                    dot_all: multiline,
                    ..Default::default()
                },
            ) {
                Ok(regex) => {
                    expression = Some(regex);
                    json!({"ready":true})
                }
                Err(error) => {
                    json!({"error":format!("This is not a valid regular expression: {error}").chars().take(8192).collect::<String>()})
                }
            }
        } else {
            scan(
                expression
                    .as_ref()
                    .context("The worker has not initialized.")?,
                request["content"].as_str().unwrap(),
                request["budget"].as_u64().unwrap() as usize,
                multiline,
                count_occurrences,
            )
        };
        ensure!(
            schemas.valid("computeRegexResponse", &response)?,
            "The worker result is invalid."
        );
        let mut bytes = serde_json::to_vec(&response)?;
        bytes.push(b'\n');
        ensure!(
            bytes.len() <= RESPONSE_BYTES,
            "The worker result exceeded its byte limit."
        );
        output.write_all(&bytes)?;
        output.flush()?;
    }
}
fn scan(
    expression: &regress::Regex,
    content: &str,
    mut budget: usize,
    multiline: bool,
    count_occurrences: bool,
) -> Value {
    let mut matching = Vec::new();
    let mut total = 0usize;
    let mut incomplete = false;
    let mut exhausted = budget == 0;
    if multiline && !exhausted {
        let units = content.encode_utf16().collect::<Vec<_>>();
        budget = budget.saturating_sub(units.len().max(1));
        exhausted = budget == 0;
        let mut scanned = 0;
        let mut line = 0;
        for found in expression.find_from_ucs2(&units, 0) {
            while scanned < found.start() {
                if units[scanned] == 10 {
                    line += 1;
                }
                scanned += 1;
            }
            total += 1;
            if matching.last() != Some(&line) && matching.len() < 10_000 {
                matching.push(line);
            }
        }
    } else if !multiline {
        let mut lines = content.split('\n').collect::<Vec<_>>();
        if lines.last() == Some(&"") {
            lines.pop();
        }
        for (index, line) in lines.iter().enumerate() {
            if budget == 0 {
                exhausted = true;
                break;
            }
            let line = line.strip_suffix('\r').unwrap_or(line);
            let units = line.encode_utf16().collect::<Vec<_>>();
            let candidate = &units[..units.len().min(4096)];
            incomplete |= candidate.len() < units.len();
            budget = budget.saturating_sub(candidate.len().max(1));
            let mut matches = expression.find_from_ucs2(candidate, 0);
            if matches.next().is_some() {
                total += 1;
                if count_occurrences {
                    budget = budget.saturating_sub(1);
                    if budget > 0 {
                        for _ in matches {
                            total += 1;
                            budget = budget.saturating_sub(1);
                            if budget == 0 {
                                break;
                            }
                        }
                    }
                }
                if matching.len() < 10_000 {
                    matching.push(index);
                }
            }
            exhausted |= budget == 0;
        }
    }
    json!({"matchingLineNumbers":matching,"totalMatches":total,"remainingBudget":budget,"incomplete":incomplete,"exhausted":exhausted})
}
