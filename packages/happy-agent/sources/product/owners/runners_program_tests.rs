//! The public product stdio path crosses actual Source frames and native programs.
use super::server::tests::Graph;
use super::*;
use futures_util::FutureExt;

struct Pair {
    graph: Graph,
    client: Arc<RunnersModule>,
    client_task: tokio::task::JoinHandle<Result<()>>,
    server_task: tokio::task::JoinHandle<Result<String>>,
}
impl Pair {
    async fn new() -> Self {
        let graph = Graph::new().await;
        std::fs::create_dir_all(&graph.fixture.config.paths.configuration).unwrap();
        std::fs::write(graph.fixture.config.paths.configuration.join("happy.toml"), "[runners.fixture]\nname = \"Fixture runner\"\ntoken = \"0123456789012345678901234567890123456789012\"\n").unwrap();
        let configuration = Arc::new(
            ConfigModule::isolated(&graph.fixture.directory.path().join(".happy")).unwrap(),
        );
        let client = RunnersModule::new(
            configuration,
            graph.fixture.runtime.clone(),
            graph.fixture.lifecycle.clone(),
        )
        .unwrap();
        client.load().await.unwrap();
        let (to_client, client_in) = mpsc::channel(128);
        let (to_server, server_in) = mpsc::channel(128);
        let local = client.clone();
        let client_task = tokio::spawn(async move {
            local
                .accept(
                    "fixture".to_owned(),
                    RunnerTransport {
                        incoming: client_in,
                        outgoing: to_server,
                    },
                )
                .await
        });
        let server = graph.server.clone();
        let server_task = tokio::spawn(async move {
            server
                .serve(RunnerTransport {
                    incoming: server_in,
                    outgoing: to_client,
                })
                .await
        });
        tokio::time::timeout(Duration::from_secs(10), async {
            while !client.is_connected("fixture") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        Self {
            graph,
            client,
            client_task,
            server_task,
        }
    }
    async fn process(&self, script: &str) -> Arc<RunnerProgram> {
        self.client
            .product_process(
                "fixture",
                &json!({"command":"/bin/sh","args":["-c",script]}),
                &CancellationToken::new(),
            )
            .await
            .unwrap()
    }
    async fn reconnect(&mut self) {
        self.graph.release_runner_owner().await;
        self.resume().await;
    }
    async fn cut(&self) {
        self.server_task.abort();
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.client.is_connected("fixture") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    async fn resume(&mut self) {
        self.cut().await;
        let (to_client, client_in) = mpsc::channel(128);
        let (to_server, server_in) = mpsc::channel(128);
        let local = self.client.clone();
        let next_client = tokio::spawn(async move {
            local
                .accept(
                    "fixture".to_owned(),
                    RunnerTransport {
                        incoming: client_in,
                        outgoing: to_server,
                    },
                )
                .await
        });
        let server = self.graph.server.clone();
        let next_server = tokio::spawn(async move {
            server
                .serve(RunnerTransport {
                    incoming: server_in,
                    outgoing: to_client,
                })
                .await
        });
        let old_client = std::mem::replace(&mut self.client_task, next_client);
        let old_server = std::mem::replace(&mut self.server_task, next_server);
        assert!(old_client.await.unwrap().is_err());
        if let Err(error) = old_server.await {
            assert!(error.is_cancelled());
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while !self.client.is_connected("fixture") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    fn stream(&self) -> u64 {
        let link = self
            .client
            .links
            .lock()
            .unwrap()
            .get("fixture")
            .unwrap()
            .clone();
        let session = link.session.lock().unwrap().clone().unwrap();
        let ids = session
            .streams
            .lock()
            .unwrap()
            .keys()
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(ids.len(), 1);
        ids[0]
    }
    async fn close(self) {
        self.client.close().await;
        let _ = tokio::time::timeout(Duration::from_secs(5), self.client_task)
            .await
            .unwrap()
            .unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.server_task)
            .await
            .unwrap()
            .unwrap();
        self.graph.close().await;
    }
}

#[tokio::test]
async fn input_eof_while_away_is_replayed_for_a_confirmed_surviving_program() {
    let mut pair = Pair::new().await;
    let program = pair.process("printf ready; cat").await;
    let mut output = program.take_stdout().unwrap();
    assert_eq!(output.recv().await.unwrap().unwrap(), b"ready");
    pair.cut().await;
    program.end_input(&CancellationToken::new()).await.unwrap();
    pair.resume().await;
    assert!(output.recv().await.unwrap().is_none());
    assert_eq!(program.wait().await.unwrap().exit_code, Some(0));
    pair.close().await;
}

#[tokio::test]
async fn a_disconnected_program_finishes_after_its_runner_lease_expires() {
    let mut pair = Pair::new().await;
    let program = pair.process("printf ready; cat").await;
    let mut output = program.take_stdout().unwrap();
    assert_eq!(output.recv().await.unwrap().unwrap(), b"ready");
    pair.cut().await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(64)).await;
    tokio::task::yield_now().await;
    assert!(
        program.wait().now_or_never().is_none(),
        "Source retains the handle through its60second lease and5second margin."
    );
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert!(program.wait().await.is_err());
    assert!(
        !program
            .write(b"late input", &CancellationToken::new())
            .await
            .unwrap()
    );
    assert!(pair.client.programs.lock().unwrap().is_empty());
    tokio::time::resume();
    pair.resume().await;
    let next = pair.process("printf ready; cat").await;
    let mut next_output = next.take_stdout().unwrap();
    assert_eq!(next_output.recv().await.unwrap().unwrap(), b"ready");
    assert!(
        !program
            .write(b"stale input", &CancellationToken::new())
            .await
            .unwrap()
    );
    next.end_input(&CancellationToken::new()).await.unwrap();
    assert!(next_output.recv().await.unwrap().is_none());
    assert_eq!(next.wait().await.unwrap().exit_code, Some(0));
    pair.close().await;
}

#[tokio::test]
async fn surviving_stdio_resumes_unacknowledged_input_and_output_without_replaying_bytes() {
    let mut pair = Pair::new().await;
    let program = pair.process("head -c 600000 /dev/zero; cat").await;
    let mut output = program.take_stdout().unwrap();
    let mut received = output.recv().await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while program.testing_buffers().0 != 512 * 1024 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let input = vec![b'z'; 1024 * 1024];
    let bytes = input.clone();
    let writer = program.clone();
    let writing = tokio::spawn(async move {
        assert!(
            writer
                .write(&bytes, &CancellationToken::new())
                .await
                .unwrap()
        );
        writer.end_input(&CancellationToken::new()).await.unwrap();
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while program.testing_buffers().1 < 512 * 1024 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    pair.resume().await;
    let reader = tokio::spawn(async move {
        while let Some(chunk) = output.recv().await.unwrap() {
            received.extend(chunk);
        }
        received
    });
    let (writing, received, exit) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(writing, reader, program.wait())
    })
    .await
    .unwrap();
    writing.unwrap();
    let received = received.unwrap();
    assert_eq!(received.len(), 600000 + input.len());
    assert!(received[..600000].iter().all(|byte| *byte == 0));
    assert_eq!(&received[600000..], &input);
    assert_eq!(exit.unwrap().exit_code, Some(0));
    pair.close().await;
}

#[tokio::test]
async fn reconnect_keeps_stream_identities_and_stale_program_handles_from_the_replacement() {
    let mut pair = Pair::new().await;
    let old = pair.process("printf ready; cat").await;
    let mut old_output = old.take_stdout().unwrap();
    assert_eq!(old_output.recv().await.unwrap().unwrap(), b"ready");
    let old_stream = pair.stream();
    pair.reconnect().await;
    assert!(
        !old.write(b"stale input", &CancellationToken::new())
            .await
            .unwrap()
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(4), old.close())
            .await
            .unwrap()
            .is_err()
    );
    let next = pair.process("printf ready; cat").await;
    assert_ne!(
        pair.stream(),
        old_stream,
        "Source RunnerLink keeps its next stream identity across reconnects."
    );
    let mut output = next.take_stdout().unwrap();
    assert_eq!(output.recv().await.unwrap().unwrap(), b"ready");
    assert!(
        next.write(b"new input", &CancellationToken::new())
            .await
            .unwrap()
    );
    next.end_input(&CancellationToken::new()).await.unwrap();
    let mut bytes = Vec::new();
    while let Some(chunk) = output.recv().await.unwrap() {
        bytes.extend(chunk);
    }
    assert_eq!(bytes, b"new input");
    assert_eq!(next.wait().await.unwrap().exit_code, Some(0));
    pair.close().await;
}

#[tokio::test]
async fn closing_an_exited_program_without_a_stdout_reader_confirms_teardown() {
    let pair = Pair::new().await;
    let program = pair.process("printf complete").await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !pair.client.programs.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(4), program.close())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(program.wait().await.unwrap().exit_code, Some(0));
    pair.close().await;
}

#[tokio::test]
async fn remote_stdio_preserves_large_output_backpressure_stderr_and_input_across_native_frames() {
    let pair = Pair::new().await;
    let program = pair
        .process("head -c 1048576 /dev/zero >&2; head -c 1048576 /dev/zero; cat")
        .await;
    let mut output = program.take_stdout().unwrap();
    let reader = tokio::spawn(async move {
        let mut bytes = Vec::new();
        while let Some(chunk) = output.recv().await.unwrap() {
            bytes.extend(chunk);
        }
        bytes
    });
    let input = vec![b'z'; 1024 * 1024];
    assert!(
        program
            .write(&input, &CancellationToken::new())
            .await
            .unwrap()
    );
    program.end_input(&CancellationToken::new()).await.unwrap();
    let first = program.wait();
    let second = program.wait();
    let (first, second, bytes) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(first, second, reader)
    })
    .await
    .unwrap();
    assert_eq!(first.unwrap().exit_code, Some(0));
    assert_eq!(second.unwrap().exit_code, Some(0));
    let bytes = bytes.unwrap();
    assert_eq!(bytes.len(), 2 * 1024 * 1024);
    assert!(bytes[..1024 * 1024].iter().all(|byte| *byte == 0));
    assert_eq!(&bytes[1024 * 1024..], &input);
    assert!(
        !program
            .write(b"after exit", &CancellationToken::new())
            .await
            .unwrap()
    );
    assert!(pair.client.programs.lock().unwrap().is_empty());
    pair.close().await;
}

#[tokio::test]
async fn remote_stdio_close_kills_the_native_tree_with_a_bounded_confirmation() {
    let pair = Pair::new().await;
    let program = pair
        .process("trap '' TERM; printf ready; while :; do sleep 1; done")
        .await;
    let mut output = program.take_stdout().unwrap();
    assert_eq!(output.recv().await.unwrap().unwrap(), b"ready");
    let reader = tokio::spawn(async move { while output.recv().await.unwrap().is_some() {} });
    tokio::time::timeout(Duration::from_secs(4), program.close())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        program.wait().await.unwrap().signal.as_deref(),
        Some("SIGKILL")
    );
    reader.await.unwrap();
    assert!(pair.client.programs.lock().unwrap().is_empty());
    pair.close().await;
}

#[tokio::test]
async fn closing_the_program_owner_finishes_its_handle_without_waiting_for_a_runner_lease() {
    let pair = Pair::new().await;
    let program = pair.process("printf ready; cat").await;
    let mut output = program.take_stdout().unwrap();
    assert_eq!(output.recv().await.unwrap().unwrap(), b"ready");
    tokio::time::timeout(Duration::from_secs(4), pair.client.close())
        .await
        .unwrap();
    assert!(program.wait().now_or_never().is_some());
    assert!(
        !program
            .write(b"after owner close", &CancellationToken::new())
            .await
            .unwrap()
    );
    assert!(pair.client.programs.lock().unwrap().is_empty());
    pair.close().await;
}

#[tokio::test]
async fn runners_close_owns_the_cached_native_server_and_rejects_stale_program_input() {
    let pair = Pair::new().await;
    let cached = pair.graph.runners.native_server(pair.graph.tools.clone());
    assert!(Arc::ptr_eq(&cached, &pair.graph.server));
    let program = pair.process("printf 'ready %s\\n' $$; cat").await;
    let mut output = program.take_stdout().unwrap();
    let mut ready = Vec::new();
    while !ready.ends_with(b"\n") {
        ready.extend(output.recv().await.unwrap().unwrap());
    }
    let ready = String::from_utf8(ready).unwrap();
    let pid: i32 = ready
        .strip_prefix("ready ")
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    pair.graph.runners.close().await;
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "The cached server must stop its actual native child."
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    assert!(
        program.wait().now_or_never().is_none(),
        "The separate live client Link retains the unknown remote outcome."
    );
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(66)).await;
    tokio::task::yield_now().await;
    tokio::time::resume();
    let result = tokio::time::timeout(Duration::from_secs(5), program.wait())
        .await
        .unwrap();
    assert!(result.is_err() || result.unwrap().signal.is_some());
    assert!(
        !program
            .write(b"old generation", &CancellationToken::new())
            .await
            .unwrap()
    );
    let (_, incoming) = mpsc::channel(1);
    let (outgoing, _) = mpsc::channel(1);
    assert!(
        pair.graph
            .server
            .serve(RunnerTransport { incoming, outgoing })
            .await
            .is_err()
    );
    pair.close().await;
}
