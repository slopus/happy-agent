//! Regressions at the actual Source-framed runner transport boundary.
use super::*;
use tokio::sync::broadcast;

struct Fixture {
    _directory: tempfile::TempDir,
    runners: Arc<RunnersModule>,
    runtime: Arc<RuntimeModule>,
    lifecycle: Arc<LifecycleModule>,
}
impl Fixture {
    async fn new() -> Self {
        Self::with_runners("[runners.fixture]\nname = \"Fixture runner\"\ntoken = \"0123456789012345678901234567890123456789012\"\n").await
    }
    async fn with_runners(configuration: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let initial = ConfigModule::isolated(&directory.path().join(".happy")).unwrap();
        std::fs::create_dir_all(&initial.paths.configuration).unwrap();
        std::fs::write(
            initial.paths.configuration.join("happy.toml"),
            configuration,
        )
        .unwrap();
        let config = Arc::new(ConfigModule::isolated(&directory.path().join(".happy")).unwrap());
        let runtime = Arc::new(RuntimeModule::new(config.clone()));
        runtime.load().await.unwrap();
        let lifecycle = Arc::new(LifecycleModule::new(config.clone()).unwrap());
        let runners = RunnersModule::new(config, runtime.clone(), lifecycle.clone()).unwrap();
        runners.load().await.unwrap();
        Self {
            _directory: directory,
            runners,
            runtime,
            lifecycle,
        }
    }
    async fn close(self) {
        self.runners.close().await;
        self.lifecycle.shutdown.cancel();
        self.runtime.close().await.unwrap();
    }
    async fn compute(&self, peer: &mut Peer) -> Arc<RunnerCompute> {
        let owner = self.runners.clone();
        let call = tokio::spawn(async move {
            owner.agent_compute("fixture", "fixtureagent", &json!({"modules":{"compute":{"runnerId":"fixture","cwd":"/runner-only-workspace"}}}), &CancellationToken::new()).await
        });
        let request = peer.request().await;
        assert_eq!(request["method"], "compute.create");
        peer.answer(&request, created(false)).await;
        call.await.unwrap().unwrap()
    }
}
struct Peer {
    owner: Arc<RunnersModule>,
    incoming: mpsc::Sender<Vec<u8>>,
    outgoing: mpsc::Receiver<Vec<u8>>,
    accepted: tokio::task::JoinHandle<Result<()>>,
}

#[tokio::test]
async fn product_machine_default_placement_is_metadata_and_local_execution_retains_its_typed_guard()
{
    let fixture = Fixture::with_runners("[runners.fixture]\nname = \"Fixture runner\"\ntoken = \"0123456789012345678901234567890123456789012\"\n[runners.second]\nname = \"Another runner\"\ntoken = \"2222222222222222222222222222222222222222222\"\n").await;
    assert_eq!(fixture.runners.default_runner_id(), None);
    assert_eq!(fixture.runners.place(None).unwrap(), None);
    let error = fixture
        .runners
        .prepare_machine(None, &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(
        error
            .downcast_ref::<LocalExecutionDisabledError>()
            .is_some()
    );
    assert_eq!(
        fixture.runners.error_code(&error),
        Some("local_execution_disabled")
    );
    fixture.close().await;
}

#[tokio::test]
async fn product_machine_preflight_uses_full_stat_page_requests_and_preserves_remote_error_codes() {
    let fixture = Fixture::new().await;
    let mut peer = Peer::connect(fixture.runners.clone(), "epoch-a", &[]).await;
    let owner = fixture.runners.clone();
    let call = tokio::spawn(async move {
        owner
            .stat(
                Some("fixture"),
                Path::new("/peer-only/directory"),
                &CancellationToken::new(),
            )
            .await
    });
    let create = peer.request().await;
    assert_eq!(create["method"], "compute.create");
    assert_eq!(create["params"]["computeId"], "happy-product");
    peer.answer(&create,json!({"cwd":"/runner-home","home":"/runner-home","kind":"host","supportsSessionInput":true,"retained":false})).await;
    let request = peer.request().await;
    assert_eq!(request["method"], "fs.stat");
    assert_eq!(request["params"]["permissions"]["mode"], "full_access");
    let stat =
        json!({"isFile":false,"isDirectory":true,"isSymbolicLink":false,"size":0,"mtimeMs":1});
    peer.answer(&request, json!({"stat":stat})).await;
    assert_eq!(call.await.unwrap().unwrap(), stat);
    let owner = fixture.runners.clone();
    let call = tokio::spawn(async move {
        owner
            .directory_page(
                Some("fixture"),
                Path::new("/peer-only/directory"),
                1,
                &CancellationToken::new(),
            )
            .await
    });
    let request = peer.request().await;
    assert_eq!(request["method"], "fs.readdirPage");
    assert_eq!(request["params"]["limit"], 1);
    assert_eq!(request["params"]["permissions"]["mode"], "full_access");
    peer.answer(&request, json!({"entries":["present"],"hasMore":false}))
        .await;
    assert_eq!(
        call.await.unwrap().unwrap(),
        json!({"entries":["present"],"hasMore":false})
    );
    let owner = fixture.runners.clone();
    let call = tokio::spawn(async move {
        owner
            .stat(
                Some("fixture"),
                Path::new("/peer-only/missing"),
                &CancellationToken::new(),
            )
            .await
    });
    let request = peer.request().await;
    peer.reject(&request, "ENOTDIR").await;
    let error = call.await.unwrap().unwrap_err();
    assert_eq!(fixture.runners.error_code(&error), Some("ENOTDIR"));
    peer.disconnect().await;
    fixture.close().await;
}

#[tokio::test(start_paused = true)]
async fn product_machine_unavailability_keeps_the_configured_runner_identity() {
    let fixture = Fixture::new().await;
    let error = fixture
        .runners
        .prepare_machine(Some("fixture"), &CancellationToken::new())
        .await
        .unwrap_err();
    let unavailable = error
        .downcast_ref::<RunnerUnavailableError>()
        .expect("unavailability must remain a typed public owner error");
    assert_eq!(unavailable.runner, "fixture");
    assert_eq!(unavailable.name, "Fixture runner");
    assert!(error.to_string().contains("Fixture runner"));
    assert_eq!(
        fixture.runners.error_code(&error),
        Some("ERUNNERUNAVAILABLE")
    );
    fixture.close().await;
}

#[tokio::test]
async fn dropping_a_runner_connection_releases_its_connected_slot() {
    let fixture = Fixture::new().await;
    let mut peer = Peer::connect(fixture.runners.clone(), "epoch-a", &[]).await;
    let _compute = fixture.compute(&mut peer).await;
    assert!(fixture.runners.is_connected("fixture"));
    peer.accepted.abort();
    assert!(peer.accepted.await.unwrap_err().is_cancelled());
    assert!(
        !fixture.runners.is_connected("fixture"),
        "a dropped transport must not remain connected"
    );
    fixture.close().await;
}
impl Peer {
    async fn connect(owner: Arc<RunnersModule>, epoch: &str, retained: &[&str]) -> Self {
        let (incoming, receiver) = mpsc::channel(16);
        let (sender, outgoing) = mpsc::channel(16);
        let accepted_owner = owner.clone();
        let accepted = tokio::spawn(async move {
            accepted_owner
                .accept(
                    "fixture".into(),
                    RunnerTransport {
                        incoming: receiver,
                        outgoing: sender,
                    },
                )
                .await
        });
        let mut peer = Self {
            owner,
            incoming,
            outgoing,
            accepted,
        };
        peer.send(json!({"type":"hello","protocol":{"min":1,"max":1},"runner":{"version":"1","platform":"linux","arch":"x64","hostname":"fixture","home":"/runner-home"}})).await;
        assert_eq!(peer.next().await["type"], "welcome");
        peer.send(json!({"type":"ready","epoch":epoch,"computes":retained,"streams":[]}))
            .await;
        peer
    }
    async fn send(&self, header: Value) {
        self.owner.send(&self.incoming, header, &[]).await.unwrap();
    }
    async fn next(&mut self) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let (header, _) = self.owner.receive(&mut self.outgoing).await.unwrap();
                if header["type"] == "ping" {
                    self.send(json!({"type":"pong","nonce":header["nonce"]}))
                        .await;
                } else {
                    return header;
                }
            }
        })
        .await
        .expect("the runner must answer at the observable transport boundary")
    }
    async fn request(&mut self) -> Value {
        loop {
            let header = self.next().await;
            if header["type"] == "cancel" {
                continue;
            }
            assert_eq!(header["type"], "request", "{header}");
            return header;
        }
    }
    async fn answer(&self, request: &Value, result: Value) {
        self.send(json!({"type":"response","id":request["id"],"result":result}))
            .await;
    }
    async fn reject(&self, request: &Value, code: &str) {
        self.send(json!({"type":"response","id":request["id"],"error":{"name":"Error","message":"The runner could not apply this operation.","code":code}})).await;
    }
    async fn disconnect(self) {
        self.send(json!({"type":"goodbye","reason":"The fixture connection ended."}))
            .await;
        assert!(self.accepted.await.unwrap().is_err());
    }
}
fn created(retained: bool) -> Value {
    json!({"cwd":"/runner-only-workspace","home":"/runner-home","kind":"host","supportsSessionInput":true,"retained":retained})
}
fn sessions(command: &str) -> Value {
    json!({"computeId":"agent-fixtureagent","sessions":[{"command":command,"cwd":"/runner-only-workspace","sessionId":0,"status":"running"}]})
}
async fn start(compute: &Arc<RunnerCompute>, peer: &mut Peer) -> RunnerProcess {
    let owner = compute.clone();
    let call = tokio::spawn(async move {
        owner.start(json!({"command":"old command","permissions":{"mode":"full_access","network":{"egress":true,"localBinding":true}}}), &CancellationToken::new()).await
    });
    let request = peer.request().await;
    assert_eq!(request["method"], "shell.startSession");
    peer.answer(&request, json!({"sessionId":0})).await;
    call.await.unwrap().unwrap()
}

#[tokio::test]
async fn runner_reconnect_deduplicates_reports_within_its_epoch() {
    let fixture = Fixture::new().await;
    let mut peer = Peer::connect(fixture.runners.clone(), "epoch-a", &[]).await;
    let compute = fixture.compute(&mut peer).await;
    let mut reports = compute.on_event();
    peer.send(
        json!({"type":"event","seq":1,"event":"shell.sessions","params":sessions("original")}),
    )
    .await;
    assert_eq!(peer.next().await, json!({"type":"ack","seq":1}));
    assert_eq!(
        reports.recv().await.unwrap()["sessions"][0]["command"],
        "original"
    );
    peer.disconnect().await;
    let mut peer = Peer::connect(fixture.runners.clone(), "epoch-a", &["agent-fixtureagent"]).await;
    peer.send(
        json!({"type":"event","seq":1,"event":"shell.sessions","params":sessions("duplicate")}),
    )
    .await;
    assert_eq!(peer.next().await, json!({"type":"ack","seq":1}));
    assert!(
        matches!(
            reports.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ),
        "the same report must not be applied twice after reconnect"
    );
    peer.send(json!({"type":"event","seq":2,"event":"shell.sessions","params":sessions("later")}))
        .await;
    assert_eq!(peer.next().await, json!({"type":"ack","seq":2}));
    assert_eq!(
        reports.recv().await.unwrap()["sessions"][0]["command"],
        "later"
    );
    peer.disconnect().await;
    let mut peer = Peer::connect(fixture.runners.clone(), "epoch-b", &[]).await;
    peer.send(
        json!({"type":"event","seq":1,"event":"shell.sessions","params":sessions("new epoch")}),
    )
    .await;
    assert_eq!(peer.next().await, json!({"type":"ack","seq":1}));
    assert_eq!(compute.active()[0]["command"], "new epoch");
    peer.disconnect().await;
    fixture.close().await;
}

#[tokio::test]
async fn a_runner_filesystem_remains_owned_after_its_reader_returns() {
    let fixture = Fixture::new().await;
    let mut peer = Peer::connect(fixture.runners.clone(), "epoch-a", &[]).await;
    let compute = fixture.compute(&mut peer).await;
    drop(compute);
    let owner = fixture.runners.clone();
    let mut call = tokio::spawn(async move {
        owner.agent_compute("fixture","fixtureagent",&json!({"modules":{"compute":{"runnerId":"fixture","cwd":"/runner-only-workspace"}}}),&CancellationToken::new()).await
    });
    let recreated = tokio::select! {
        result=&mut call=>{result.unwrap().unwrap();false},
        request=peer.request()=>{assert_eq!(request["method"],"compute.create");peer.answer(&request,created(true)).await;call.await.unwrap().unwrap();true}
    };
    assert!(
        !recreated,
        "a completed filesystem reader must not abandon its live compute"
    );
    peer.disconnect().await;
    fixture.close().await;
}

#[tokio::test]
async fn lost_runner_compute_never_replays_an_old_session_handle() {
    let fixture = Fixture::new().await;
    let mut peer = Peer::connect(fixture.runners.clone(), "epoch-a", &[]).await;
    let compute = fixture.compute(&mut peer).await;
    let process = start(&compute, &mut peer).await;
    peer.disconnect().await;
    let mut peer = Peer::connect(fixture.runners.clone(), "epoch-a", &["agent-fixtureagent"]).await;
    let mut call =
        tokio::spawn(async move { process.read(0, false, &CancellationToken::new()).await });
    let request = peer.request().await;
    assert_eq!(request["method"], "shell.readSession");
    peer.reject(&request, "ERUNNERCOMPUTEUNKNOWN").await;
    let result = tokio::select! {
        answer = &mut call => answer.unwrap(),
        request = peer.request() => {
            assert_eq!(request["method"], "compute.create");
            peer.answer(&request, created(false)).await;
            tokio::select! {
                answer = &mut call => answer.unwrap(),
                request = peer.request() => {
                    assert_eq!(request["method"], "shell.readSession");
                    peer.answer(&request, json!({"snapshot":{"command":"a different command","cwd":"/runner-only-workspace","exitCode":null,"sessionId":0,"status":"running","stderr":"","stderrDelta":"","stdout":"new command output","stdoutDelta":"new command output","timedOut":false}})).await;
                    call.await.unwrap()
                }
            }
        }
    };
    assert!(
        result.unwrap().is_none(),
        "a lost session must never read a reused runner ID"
    );
    peer.disconnect().await;
    fixture.close().await;
}

#[tokio::test]
async fn runner_disposal_keeps_ownership_until_the_peer_confirms_it() {
    let fixture = Fixture::new().await;
    let mut peer = Peer::connect(fixture.runners.clone(), "epoch-a", &[]).await;
    let compute = fixture.compute(&mut peer).await;
    let owner = compute.clone();
    let call = tokio::spawn(async move { owner.dispose(&CancellationToken::new()).await });
    let request = peer.request().await;
    assert_eq!(request["method"], "compute.dispose");
    peer.reject(&request, "EBUSY").await;
    assert!(call.await.unwrap().is_err());
    let owner = compute.clone();
    let mut call = tokio::spawn(async move { owner.dispose(&CancellationToken::new()).await });
    tokio::select! {
        answer = &mut call => panic!("unconfirmed disposal must remain owned and be retried: {answer:?}"),
        request = peer.request() => {
            assert_eq!(request["method"], "compute.dispose");
            peer.answer(&request, json!({})).await;
        }
    }
    call.await.unwrap().unwrap();
    compute.dispose(&CancellationToken::new()).await.unwrap();
    peer.disconnect().await;
    fixture.close().await;
}

#[tokio::test]
async fn expired_runner_lease_finishes_owned_sessions_without_reconnection() {
    let fixture = Fixture::new().await;
    let mut peer = Peer::connect(fixture.runners.clone(), "epoch-a", &[]).await;
    let compute = fixture.compute(&mut peer).await;
    let process = start(&compute, &mut peer).await;
    let mut reports = compute.on_event();
    peer.send(
        json!({"type":"event","seq":1,"event":"shell.sessions","params":sessions("old command")}),
    )
    .await;
    assert_eq!(peer.next().await, json!({"type":"ack","seq":1}));
    assert_eq!(reports.recv().await.unwrap()["type"], "sessions");
    peer.disconnect().await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(62)).await;
    tokio::task::yield_now().await;
    assert!(
        compute.active().is_empty(),
        "lease expiry must stop reporting runner work as live"
    );
    assert_eq!(
        reports.try_recv().unwrap()["exit"]["sessionId"],
        process.id()
    );
    assert!(
        process
            .read(0, false, &CancellationToken::new())
            .await
            .unwrap()
            .is_none()
    );
    tokio::time::resume();
    fixture.close().await;
}

#[tokio::test]
async fn queued_session_input_is_not_sent_after_its_compute_is_lost() {
    let fixture = Fixture::new().await;
    let mut peer = Peer::connect(fixture.runners.clone(), "epoch-a", &[]).await;
    let compute = fixture.compute(&mut peer).await;
    let process = start(&compute, &mut peer).await;
    let session = fixture
        .runners
        .session("fixture", &CancellationToken::new())
        .await
        .unwrap();
    for nonce in 100..116 {
        match session.sender.try_send(
            fixture
                .runners
                .frame(json!({"type":"ping","nonce":nonce}), &[])
                .unwrap(),
        ) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => break,
            Err(error) => panic!("the established runner transport closed: {error}"),
        }
    }
    let permissions = compute.permissions("workspace_write").unwrap();
    let call = tokio::spawn(async move {
        process
            .write(
                &permissions,
                b"must not reach a later command",
                &CancellationToken::new(),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if session.requests.lock().unwrap().len() == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // This is the same owning transition exercised through a real lease in the
    // preceding test; now hold the transport at its bounded enqueue boundary.
    compute.lost();
    for _ in 0..session.sender.max_capacity() {
        let (header, body) = fixture.runners.receive(&mut peer.outgoing).await.unwrap();
        assert!(body.is_empty());
        assert_eq!(
            header["type"], "ping",
            "queued input must not leave a lost compute"
        );
        peer.send(json!({"type":"pong","nonce":header["nonce"]}))
            .await;
    }
    assert!(!call.await.unwrap().unwrap());
    assert!(session.requests.lock().unwrap().is_empty());
    let remaining = peer.next().await;
    assert_eq!(
        remaining["type"], "cancel",
        "no queued input may cross the lost compute generation"
    );
    peer.disconnect().await;
    fixture.close().await;
}
