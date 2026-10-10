//! Exercise every Source method through actual binary frames and native effects.
use super::*;
use crate::product::{
    history::HistoryModule, secrets::SecretsModule, services::ServicesModule, usage::UsageModule,
};
pub(in crate::product::owners::runners) struct Graph {
    pub(in crate::product::owners::runners) fixture: crate::product::owners::Fixture,
    pub(in crate::product::owners::runners) server: Arc<RunnerServer>,
    pub(in crate::product::owners::runners) tools: Arc<ToolsModule>,
    pub(in crate::product::owners::runners) runners: Arc<RunnersModule>,
}
impl Drop for Graph {
    fn drop(&mut self) {
        self.fixture.lifecycle.begin_shutdown();
    }
}
impl Graph {
    pub(in crate::product::owners::runners) async fn new() -> Self {
        crate::product::process::prepare_child_reaping().unwrap();
        let fixture = crate::product::owners::Fixture::new().await;
        let usage = Arc::new(
            UsageModule::new(
                fixture.runtime.clone(),
                fixture.events.clone(),
                fixture.config.clone(),
            )
            .unwrap(),
        );
        let history = Arc::new(
            HistoryModule::new(
                fixture.config.clone(),
                fixture.runtime.clone(),
                fixture.events.clone(),
                usage,
            )
            .unwrap(),
        );
        let secrets = SecretsModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            fixture.events.clone(),
        )
        .unwrap();
        let services = ServicesModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            fixture.lifecycle.clone(),
            fixture.events.clone(),
        )
        .unwrap();
        let runners = RunnersModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        let tools = Arc::new(
            ToolsModule::new(
                fixture.config.clone(),
                history,
                fixture.lifecycle.clone(),
                fixture.runtime.clone(),
                secrets,
                services,
                fixture.events.clone(),
                runners.clone(),
                crate::product::docker::DockerModule::new(
                    fixture.config.clone(),
                    fixture.runtime.clone(),
                    fixture.durable.clone(),
                    fixture.lifecycle.clone(),
                    runners.clone(),
                )
                .unwrap(),
            )
            .unwrap(),
        );
        let server = runners.native_server(tools.clone());
        Self {
            fixture,
            server,
            tools,
            runners,
        }
    }
    pub(in crate::product::owners::runners) async fn release_runner_owner(&self) {
        if let Some(owner) = self.server.owner.lock().await.take() {
            self.server.release(&owner).await.unwrap();
        }
    }
    pub(in crate::product::owners::runners) async fn close(self) {
        self.server.close().await.unwrap();
        self.tools.close().await;
        self.fixture.close().await;
    }
}
struct Peer {
    server: Arc<RunnerServer>,
    input: Option<mpsc::Sender<Vec<u8>>>,
    output: mpsc::Receiver<Vec<u8>>,
    work: tokio::task::JoinHandle<Result<String>>,
    queue: VecDeque<Frame>,
    next: u64,
    ready: Value,
    methods: std::collections::BTreeSet<String>,
}

#[tokio::test]
async fn native_runner_background_start_belongs_to_compute_instead_of_cancelled_request() {
    let graph = Graph::new().await;
    let root = graph
        .fixture
        .directory
        .path()
        .join("runner-background-lifetime");
    std::fs::create_dir_all(&root).unwrap();
    let compute = graph
        .tools
        .native_runner_compute(&json!({"computeId":"background","cwd":root}))
        .await
        .unwrap();
    let cancelled_request = CancellationToken::new();
    cancelled_request.cancel();
    let (started, _) = compute.request("shell.startSession", &json!({"computeId":"background","options":{"command":"printf owned-shell","permissions":{"mode":"full_access","network":{"egress":true,"localBinding":true}}}}), &[], &cancelled_request).await.unwrap();
    let (read, _) = compute
        .request(
            "shell.readSession",
            &json!({"computeId":"background","sessionId":started["sessionId"],"waitMs":5000}),
            &[],
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(read["snapshot"]["stdout"], "owned-shell");
    let process = compute.process(&json!({"computeId":"background","stream":1,"command":"/bin/sh","args":["-c","printf owned-process"]}), &cancelled_request).await.unwrap();
    let mut output = process.take_output().unwrap();
    let mut bytes = Vec::new();
    while let Some(event) = output.recv().await {
        match event {
            NativeRunnerProcessEvent::Data { bytes: chunk, .. } => bytes.extend(chunk),
            NativeRunnerProcessEvent::Exit { code, .. } => {
                assert_eq!(code, Some(0));
                break;
            }
        }
    }
    assert_eq!(bytes, b"owned-process");
    compute.dispose().await.unwrap();
    drop(process);
    assert!(
        compute
            .process(
                &json!({"computeId":"background","stream":2,"command":"/bin/sh","args":[]}),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    graph.close().await;
}

#[tokio::test]
async fn native_runner_terminal_has_requested_dimensions_and_environment_before_program_starts() {
    let graph = Graph::new().await;
    let mut peer = Peer::connect(graph.server.clone(), "native-terminal-start", 1000).await;
    let root = graph.fixture.directory.path().join("runner-terminal-start");
    std::fs::create_dir_all(&root).unwrap();
    peer.rpc(
        "compute.create",
        json!({"computeId":"terminal","cwd":root}),
        &[],
    )
    .await;
    peer.rpc("process.start", json!({"computeId":"terminal","stream":1,"command":"/bin/sh","args":["-c","stty size; printf '%s|%s' \"$TERM\" \"$PAGER\""],"environment":{"PAGER":"owned-pager"},"terminal":{"cols":103,"rows":37}}), &[]).await;
    let mut output = Vec::new();
    loop {
        let (header, body) = peer
            .matching(|header| {
                header["stream"] == 1 && (header["type"] == "data" || header["type"] == "exit")
            })
            .await;
        if header["type"] == "exit" {
            assert_eq!(header["exitCode"], 0);
            break;
        }
        if header["channel"] == "out" {
            output.extend(body);
        }
    }
    assert_eq!(
        String::from_utf8(output).unwrap().replace('\r', ""),
        "37 103\nxterm-256color|owned-pager"
    );
    peer.send(json!({"type":"release","stream":1}), &[]).await;
    peer.goodbye().await;
    graph.close().await;
}
impl Peer {
    async fn connect(server: Arc<RunnerServer>, instance: &str, grace: u64) -> Self {
        let (input, incoming) = mpsc::channel(32);
        let (outgoing, output) = mpsc::channel(32);
        let actor = server.clone();
        let work =
            tokio::spawn(async move { actor.serve(RunnerTransport { incoming, outgoing }).await });
        let mut peer = Self {
            server,
            input: Some(input),
            output,
            work,
            queue: VecDeque::new(),
            next: 1,
            ready: Value::Null,
            methods: std::collections::BTreeSet::new(),
        };
        assert_eq!(peer.raw().await.0["type"], "hello");
        peer.send(
            json!({"type":"welcome","protocol":1,"instanceId":instance,"leaseGraceMs":grace}),
            &[],
        )
        .await;
        peer.ready = peer.raw().await.0;
        assert_eq!(peer.ready["type"], "ready");
        peer
    }
    async fn send(&self, header: Value, body: &[u8]) {
        self.input
            .as_ref()
            .unwrap()
            .send(self.server.runners.frame(header, body).unwrap())
            .await
            .unwrap();
    }
    async fn raw(&mut self) -> Frame {
        tokio::time::timeout(
            Duration::from_secs(10),
            self.server.runners.receive(&mut self.output),
        )
        .await
        .unwrap()
        .unwrap()
    }
    async fn matching(&mut self, predicate: impl Fn(&Value) -> bool) -> Frame {
        if let Some(index) = self.queue.iter().position(|frame| predicate(&frame.0)) {
            return self.queue.remove(index).unwrap();
        }
        loop {
            let frame = self.raw().await;
            if predicate(&frame.0) {
                return frame;
            }
            if frame.0["type"] == "ping" {
                self.send(json!({"type":"pong","nonce":frame.0["nonce"]}), &[])
                    .await;
            } else {
                assert!(self.queue.len() < 4096);
                self.queue.push_back(frame);
            }
        }
    }
    async fn rpc(&mut self, method: &str, params: Value, body: &[u8]) -> Frame {
        self.methods.insert(method.to_owned());
        let id = self.next;
        self.next += 1;
        self.send(
            json!({"type":"request","id":id,"method":method,"params":params}),
            body,
        )
        .await;
        let answer = self
            .matching(|header| header["type"] == "response" && header["id"] == id)
            .await;
        assert!(answer.0.get("error").is_none(), "{method}: {}", answer.0);
        (answer.0["result"].clone(), answer.1)
    }
    async fn data(&mut self, id: u64) -> Vec<u8> {
        let (header, bytes) = self
            .matching(|header| {
                header["type"] == "data" && header["stream"] == id && header["channel"] == "out"
            })
            .await;
        self.send(json!({"type":"flow","stream":id,"channel":"out","consumed":header["offset"].as_u64().unwrap()+bytes.len() as u64}),&[]).await;
        bytes
    }
    async fn release(&mut self, id: u64) {
        self.send(json!({"type":"close","stream":id}), &[]).await;
        let _ = self
            .matching(|header| header["type"] == "exit" && header["stream"] == id)
            .await;
        self.send(json!({"type":"release","stream":id}), &[]).await;
    }
    async fn disconnect(mut self) {
        self.input.take();
        drop(self.output);
        let _ = self.work.await.unwrap();
    }
    async fn goodbye(mut self) {
        self.send(
            json!({"type":"goodbye","reason":"The test daemon is stopping."}),
            &[],
        )
        .await;
        self.input.take();
        drop(self.output);
        self.work.await.unwrap().unwrap();
    }
}
fn full() -> Value {
    json!({"mode":"full_access","network":{"egress":true,"localBinding":true}})
}
fn path(path: &str) -> Value {
    json!({"computeId":"machine","path":path,"permissions":full()})
}

#[tokio::test]
async fn native_runner_keeps_all_256_programs_alive_and_preserves_source_capacity_errors() {
    async fn response(peer: &mut Peer, stream: u64) -> Value {
        let id = peer.next;
        peer.next += 1;
        peer.send(json!({"type":"request","id":id,"method":"process.start","params":{"computeId":"program-capacity","stream":stream,"command":"/bin/cat","args":[]}}), &[]).await;
        peer.matching(|header| header["type"] == "response" && header["id"] == id)
            .await
            .0
    }

    let graph = Graph::new().await;
    let mut peer = Peer::connect(graph.server.clone(), "native-program-capacity", 1000).await;
    peer.rpc(
        "compute.create",
        json!({"computeId":"program-capacity","cwd":graph.fixture.directory.path()}),
        &[],
    )
    .await;
    let mut failure = None;
    for stream in 1..=256 {
        let answer = response(&mut peer, stream).await;
        if answer.get("error").is_some() {
            failure = Some((stream, answer));
            break;
        }
    }
    let mut overflow = Value::Null;
    let mut duplicate = Value::Null;
    let mut echoes = Vec::new();
    if failure.is_none() {
        overflow = response(&mut peer, 257).await;
        duplicate = response(&mut peer, 1).await;
        for stream in 1..=256 {
            peer.send(
                json!({"type":"data","stream":stream,"channel":"in","offset":0}),
                b"still-owned",
            )
            .await;
            echoes.push(peer.data(stream).await);
        }
    }
    peer.goodbye().await;
    graph.close().await;
    assert!(
        failure.is_none(),
        "Source must keep 256 real runner programs: {failure:?}"
    );
    assert_eq!(echoes.len(), 256);
    assert!(echoes.iter().all(|bytes| bytes == b"still-owned"));
    assert_eq!(overflow["error"]["name"], "RunnerBusyError", "{overflow}");
    assert_eq!(overflow["error"]["code"], "ERUNNERBUSY", "{overflow}");
    assert_eq!(
        duplicate["error"]["name"], "RunnerProtocolError",
        "{duplicate}"
    );
    assert_eq!(duplicate["error"]["code"], "ERUNNERPROTOCOL", "{duplicate}");
}

#[tokio::test]
async fn native_runner_late_welcome_cannot_reopen_a_closed_server() {
    let graph = Graph::new().await;
    let (input, incoming) = mpsc::channel(32);
    let (outgoing, mut output) = mpsc::channel(32);
    let server = graph.server.clone();
    let work =
        tokio::spawn(async move { server.serve(RunnerTransport { incoming, outgoing }).await });
    let hello = graph.runners.receive(&mut output).await.unwrap();
    assert_eq!(hello.0["type"], "hello");
    graph.server.close().await.unwrap();
    input.send(graph.runners.frame(json!({"type":"welcome","protocol":1,"instanceId":"late-daemon","leaseGraceMs":1000}), &[]).unwrap()).await.unwrap();
    let greeting =
        tokio::time::timeout(Duration::from_secs(10), graph.runners.receive(&mut output))
            .await
            .unwrap();
    let reopened = graph.server.owner.lock().await.is_some();
    if greeting.is_ok() {
        input
            .send(
                graph
                    .runners
                    .frame(
                        json!({"type":"goodbye","reason":"The test daemon is stopping."}),
                        &[],
                    )
                    .unwrap(),
            )
            .await
            .unwrap();
    }
    drop(input);
    drop(output);
    let result = work.await.unwrap();
    graph.close().await;
    assert!(
        greeting.is_err(),
        "A closed runner must not announce readiness: {greeting:?}"
    );
    assert!(
        !reopened,
        "The late handshake installed an owner after close."
    );
    assert!(
        result.is_err(),
        "A closed runner accepted a delayed welcome: {result:?}"
    );
}

#[tokio::test]
async fn native_runner_binary_peer_executes_all_32_source_methods() {
    let graph = Graph::new().await;
    let root = graph.fixture.directory.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let mut peer = Peer::connect(graph.server.clone(), "daemon-a", 60_000).await;
    assert_eq!(
        peer.rpc(
            "compute.create",
            json!({"computeId":"machine","cwd":root}),
            &[]
        )
        .await
        .0["retained"],
        false
    );
    assert_eq!(
        peer.rpc(
            "compute.create",
            json!({"computeId":"machine","cwd":root}),
            &[]
        )
        .await
        .0["retained"],
        true
    );
    let mut params = path("nested");
    params["recursive"] = json!(false);
    peer.rpc("fs.mkdir", params, &[]).await;
    let mut params = path("nested/data");
    params["encoding"] = json!("bytes");
    peer.rpc("fs.writeFile", params, &[0, 255, 7]).await;
    assert_eq!(
        peer.rpc("fs.readFileBuffer", path("nested/data"), &[])
            .await
            .1,
        [0, 255, 7]
    );
    assert_eq!(
        peer.rpc("fs.exists", path("nested/data"), &[]).await.0,
        json!({"exists":true})
    );
    for method in ["fs.stat", "fs.lstat"] {
        assert_eq!(
            peer.rpc(method, path("nested/data"), &[]).await.0["stat"]["size"],
            3
        );
    }
    assert_eq!(
        peer.rpc(
            "fs.lstatMany",
            json!({"computeId":"machine","permissions":full(),"paths":["nested/data","missing"]}),
            &[]
        )
        .await
        .0["stats"][1],
        Value::Null
    );
    let mut params = path("nested/data");
    params["mode"] = json!(0o640);
    peer.rpc("fs.chmod", params, &[]).await;
    let mut params = path("nested/data");
    params["mtimeMs"] = json!(1000);
    peer.rpc("fs.setModificationTime", params, &[]).await;
    assert_eq!(
        peer.rpc("fs.realpath", path("nested/data"), &[]).await.0["path"],
        json!(root.join("nested/data"))
    );
    assert_eq!(
        peer.rpc("fs.readdir", path("nested"), &[]).await.0,
        json!({"entries":["data"]})
    );
    let mut params = path("nested");
    params["limit"] = json!(1);
    assert_eq!(
        peer.rpc("fs.readdirPage", params, &[]).await.0,
        json!({"entries":["data"],"hasMore":false})
    );
    peer.rpc("fs.move",json!({"computeId":"machine","permissions":full(),"source":"nested/data","destination":"nested/moved"}),&[]).await;
    let mut params = path("nested/moved");
    params["encoding"] = json!("text");
    peer.rpc("fs.writeFile", params, "text €".as_bytes()).await;
    assert_eq!(
        peer.rpc("fs.readFile", path("nested/moved"), &[]).await.0,
        json!({"text":"text €"})
    );
    peer.rpc("fs.rm", path("nested/moved"), &[]).await;
    let result=peer.rpc("shell.run",json!({"computeId":"machine","options":{"command":"printf stdout; printf stderr >&2","permissions":full()}}),&[]).await.0["result"].clone();
    assert_eq!(result["stdout"], "stdout");
    assert_eq!(result["stderr"], "stderr");
    assert_eq!(result["exitCode"], 0);
    let id=peer.rpc("shell.startSession",json!({"computeId":"machine","options":{"command":"printf ready; read value; printf '%s' \"$value\"","permissions":full(),"tty":false}}),&[]).await.0["sessionId"].clone();
    peer.rpc(
        "shell.detachSession",
        json!({"computeId":"machine","sessionId":id}),
        &[],
    )
    .await;
    peer.rpc(
        "shell.writeSession",
        json!({"computeId":"machine","sessionId":id,"permissions":full(),"encoding":"text"}),
        b"input\n",
    )
    .await;
    assert_eq!(
        peer.rpc(
            "shell.readSession",
            json!({"computeId":"machine","sessionId":id,"waitMs":1000}),
            &[]
        )
        .await
        .0["snapshot"]["stdout"],
        "readyinput"
    );
    assert_eq!(
        peer.rpc(
            "shell.interruptSession",
            json!({"computeId":"machine","sessionId":id}),
            &[]
        )
        .await
        .0,
        json!({"interrupted":false})
    );
    let id = peer
        .rpc(
            "shell.startSession",
            json!({"computeId":"machine","options":{"command":"read value","permissions":full()}}),
            &[],
        )
        .await
        .0["sessionId"]
        .clone();
    assert_eq!(
        peer.rpc(
            "shell.killSession",
            json!({"computeId":"machine","sessionId":id}),
            &[]
        )
        .await
        .0["snapshot"]["status"],
        "killed"
    );
    peer.rpc(
        "shell.startSession",
        json!({"computeId":"machine","options":{"command":"read value","permissions":full()}}),
        &[],
    )
    .await;
    assert_eq!(
        peer.rpc("shell.killAllSessions", json!({"computeId":"machine"}), &[])
            .await
            .0,
        json!({"killed":1})
    );
    peer.rpc("process.start",json!({"computeId":"machine","stream":10,"command":"/bin/sh","args":["-c","printf '\\000\\377'; read value; printf '%s' \"$value\""]}),&[]).await;
    assert_eq!(peer.data(10).await, [0, 255]);
    peer.rpc(
        "process.resize",
        json!({"stream":10,"cols":90,"rows":30}),
        &[],
    )
    .await;
    peer.send(
        json!({"type":"data","stream":10,"channel":"in","offset":0}),
        b"finished\n",
    )
    .await;
    assert_eq!(peer.data(10).await, b"finished");
    peer.matching(|header| header["type"] == "exit" && header["stream"] == 10)
        .await;
    // Source controls remain harmless after a program's owned group has exited.
    peer.rpc(
        "process.signal",
        json!({"stream":10,"signal":"SIGTERM"}),
        &[],
    )
    .await;
    peer.rpc(
        "process.resize",
        json!({"stream":10,"cols":90,"rows":30}),
        &[],
    )
    .await;
    peer.send(json!({"type":"release","stream":10}), &[]).await;
    peer.rpc("process.start",json!({"computeId":"machine","stream":11,"command":"/bin/sh","args":["-c","printf signal-ready; read value"]}),&[]).await;
    assert_eq!(peer.data(11).await, b"signal-ready");
    peer.rpc(
        "process.signal",
        json!({"stream":11,"signal":"SIGTERM"}),
        &[],
    )
    .await;
    assert_eq!(
        peer.matching(|header| header["type"] == "exit" && header["stream"] == 11)
            .await
            .0["signal"],
        "SIGTERM"
    );
    peer.send(json!({"type":"release","stream":11}), &[]).await;
    peer.rpc(
        "watch.start",
        json!({"computeId":"machine","stream":20,"path":"nested","ignore":["ignored"]}),
        &[],
    )
    .await;
    std::fs::write(root.join("nested/changed"), "event").unwrap();
    let batch: Value = serde_json::from_slice(&peer.data(20).await).unwrap();
    assert!(
        batch["paths"]
            .as_array()
            .unwrap()
            .contains(&json!("changed"))
    );
    peer.release(20).await;
    let port = peer
        .rpc(
            "net.listen",
            json!({"computeId":"machine","stream":30}),
            &[],
        )
        .await
        .0["port"]
        .as_u64()
        .unwrap() as u16;
    let mut client = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    let notification: Value = serde_json::from_slice(&peer.data(30).await).unwrap();
    peer.rpc("net.accept",json!({"computeId":"machine","stream":31,"listener":30,"connection":notification["connection"]}),&[]).await;
    client.write_all(&[0, 255]).await.unwrap();
    assert_eq!(peer.data(31).await, [0, 255]);
    peer.send(
        json!({"type":"data","stream":31,"channel":"in","offset":0}),
        &[7, 255],
    )
    .await;
    let mut reply = [0; 2];
    client.read_exact(&mut reply).await.unwrap();
    assert_eq!(reply, [7, 255]);
    peer.release(31).await;
    peer.release(30).await;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    peer.rpc("net.connect",json!({"computeId":"machine","stream":32,"host":"127.0.0.1","port":listener.local_addr().unwrap().port()}),&[]).await;
    let (mut client, _) = listener.accept().await.unwrap();
    client.write_all(b"connected").await.unwrap();
    assert_eq!(peer.data(32).await, b"connected");
    peer.release(32).await;
    let file_request = json!({
        "computeId":"machine", "agent":"private-worker-probe", "vendor":"claude",
        "mode":"full_access", "reads":[],
        "call":{"id":"private-file-probe","call":{"name":"Write","arguments":
            json!({"file_path":root.join("private-file-effect"),"content":"private"}).to_string()}}
    });
    let private_methods: [(&str, Value, &str); 4] = [
        (
            "compute.createContainer",
            json!({"computeId":"private-compute","cwd":root}),
            "Container compute policy is reserved for the private Docker worker.",
        ),
        (
            "compute.secretShell",
            json!({"computeId":"machine","options":{"command":"printf private > private-shell-effect","permissions":full()},"environment":{"OWNED_PRIVATE_PROBE":"private"},"hiddenEnvironmentVariables":[]}),
            "Secret shell provisioning is reserved for the private Docker worker.",
        ),
        (
            "compute.fileTool",
            file_request.clone(),
            "Native file tool execution is reserved for the private Docker worker.",
        ),
        (
            "compute.filePolicy",
            file_request,
            "Native file policy inspection is reserved for the private Docker worker.",
        ),
    ];
    for (method, params, message) in &private_methods {
        let (_, schema, _) = METHODS.iter().find(|(name, _, _)| name == method).unwrap();
        assert!(
            graph.runners.schemas.valid(schema, params).unwrap(),
            "{method}"
        );
        let id = peer.next;
        peer.next += 1;
        peer.send(
            json!({"type":"request","id":id,"method":method,"params":params}),
            &[],
        )
        .await;
        let response = peer
            .matching(|header| header["type"] == "response" && header["id"] == id)
            .await;
        assert_eq!(
            response.0,
            json!({"type":"response","id":id,"error":{"name":"Error","code":"ERUNNER","message":message}}),
            "{method} must reach the private-worker guard with valid parameters"
        );
        assert!(response.1.is_empty(), "{method}");
        assert!(!root.join("private-shell-effect").exists(), "{method}");
        assert!(!root.join("private-file-effect").exists(), "{method}");
    }
    // A refused private creation must not install ownership, and ordinary
    // public requests remain usable after all four private-method refusals.
    assert_eq!(
        peer.rpc(
            "compute.create",
            json!({"computeId":"private-compute","cwd":root}),
            &[]
        )
        .await
        .0["retained"],
        false
    );
    peer.rpc(
        "compute.dispose",
        json!({"computeId":"private-compute"}),
        &[],
    )
    .await;
    peer.rpc("compute.dispose", json!({"computeId":"machine"}), &[])
        .await;
    // Source's runnerProtocol.ts exposes these 32 public methods. Private
    // same-executable Docker methods require the negative coverage above.
    let source_methods: [&str; 32] = [
        "compute.create",
        "compute.dispose",
        "fs.chmod",
        "fs.exists",
        "fs.lstat",
        "fs.lstatMany",
        "fs.mkdir",
        "fs.move",
        "fs.readFile",
        "fs.readFileBuffer",
        "fs.readdir",
        "fs.readdirPage",
        "fs.realpath",
        "fs.rm",
        "fs.setModificationTime",
        "fs.stat",
        "fs.writeFile",
        "net.accept",
        "net.connect",
        "net.listen",
        "process.resize",
        "process.signal",
        "process.start",
        "shell.detachSession",
        "shell.interruptSession",
        "shell.killAllSessions",
        "shell.killSession",
        "shell.readSession",
        "shell.run",
        "shell.startSession",
        "shell.writeSession",
        "watch.start",
    ];
    assert_eq!(
        peer.methods,
        source_methods.iter().map(|name| name.to_string()).collect()
    );
    assert_eq!(
        METHODS
            .iter()
            .map(|(name, _, _)| name.to_string())
            .collect::<std::collections::BTreeSet<_>>(),
        source_methods
            .iter()
            .copied()
            .chain(private_methods.iter().map(|(name, _, _)| *name))
            .map(str::to_owned)
            .collect()
    );
    peer.goodbye().await;
    graph.close().await;
}

#[tokio::test]
async fn native_runner_reconnect_replays_unacknowledged_binary_output_and_new_daemon_releases_the_owner()
 {
    let graph = Graph::new().await;
    let root = graph.fixture.directory.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let mut peer = Peer::connect(graph.server.clone(), "daemon-a", 60_000).await;
    peer.rpc(
        "compute.create",
        json!({"computeId":"machine","cwd":root}),
        &[],
    )
    .await;
    peer.rpc("process.start",json!({"computeId":"machine","stream":10,"command":"/bin/sh","args":["-c","printf retained; read value"]}),&[]).await;
    let (original, bytes) = peer
        .matching(|header| header["type"] == "data" && header["stream"] == 10)
        .await;
    let epoch = peer.ready["epoch"].clone();
    peer.disconnect().await;
    let mut resumed = Peer::connect(graph.server.clone(), "daemon-a", 60_000).await;
    assert_eq!(resumed.ready["epoch"], epoch);
    assert_eq!(resumed.ready["computes"], json!(["machine"]));
    assert_eq!(
        resumed
            .matching(|header| header["type"] == "data" && header["stream"] == 10)
            .await,
        (original, bytes)
    );
    resumed.disconnect().await;
    let replacement = Peer::connect(graph.server.clone(), "daemon-b", 0).await;
    assert_ne!(replacement.ready["epoch"], epoch);
    assert_eq!(replacement.ready["computes"], json!([]));
    assert_eq!(replacement.ready["streams"], json!([]));
    replacement.goodbye().await;
    graph.close().await;
}

#[tokio::test]
async fn native_runner_missing_stat_keeps_the_source_enoent_code() {
    let graph = Graph::new().await;
    let mut peer = Peer::connect(graph.server.clone(), "daemon-a", 0).await;
    peer.rpc(
        "compute.create",
        json!({"computeId":"machine","cwd":graph.fixture.directory.path()}),
        &[],
    )
    .await;
    let id = peer.next;
    peer.send(
        json!({"type":"request","id":id,"method":"fs.stat","params":path("missing")}),
        &[],
    )
    .await;
    let answer = peer
        .matching(|header| header["type"] == "response" && header["id"] == id)
        .await;
    peer.goodbye().await;
    graph.close().await;
    assert_eq!(answer.0["error"]["code"], "ENOENT", "{}", answer.0);
}

#[tokio::test]
async fn native_runner_oversized_json_reply_returns_source_error_and_keeps_connection_usable() {
    let graph = Graph::new().await;
    let mut peer = Peer::connect(graph.server.clone(), "oversized-reply", 0).await;
    // JSON expands each NUL to six bytes: the file fits the read bound, its reply does not.
    std::fs::write(
        graph.fixture.directory.path().join("expanded-json"),
        vec![0u8; 12 * 1024 * 1024],
    )
    .unwrap();
    peer.rpc(
        "compute.create",
        json!({"computeId":"machine","cwd":graph.fixture.directory.path()}),
        &[],
    )
    .await;
    let id = peer.next;
    peer.next += 1;
    peer.send(
        json!({"type":"request","id":id,"method":"fs.readFile","params":path("expanded-json")}),
        &[],
    )
    .await;
    let response = peer
        .matching(|header| header["type"] == "response" && header["id"] == id)
        .await;
    assert_eq!(
        response.0["error"]["name"], "RunnerFrameTooLargeError",
        "{}",
        response.0
    );
    assert_eq!(
        response.0["error"]["code"], "ERUNNERFRAMETOOLARGE",
        "{}",
        response.0
    );
    assert_eq!(
        peer.rpc("fs.exists", path("expanded-json"), &[]).await.0["exists"],
        true
    );
    peer.goodbye().await;
    graph.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn native_runner_refused_connection_keeps_source_error_code_and_releases_stream_slot() {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    let graph = Graph::new().await;
    let mut peer = Peer::connect(graph.server.clone(), "refused-connection", 0).await;
    // Hold the port without listening so another process cannot race to reuse it.
    let descriptor = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
    assert!(descriptor >= 0);
    let socket = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let mut address: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    address.sin_family = libc::AF_INET as _;
    address.sin_addr.s_addr = u32::from_ne_bytes([127, 0, 0, 1]);
    let mut length = std::mem::size_of_val(&address) as libc::socklen_t;
    assert_eq!(
        unsafe {
            libc::bind(
                socket.as_raw_fd(),
                (&address as *const libc::sockaddr_in).cast(),
                length,
            )
        },
        0
    );
    assert_eq!(
        unsafe {
            libc::getsockname(
                socket.as_raw_fd(),
                (&mut address as *mut libc::sockaddr_in).cast(),
                &mut length,
            )
        },
        0
    );
    peer.rpc(
        "compute.create",
        json!({"computeId":"machine","cwd":graph.fixture.directory.path()}),
        &[],
    )
    .await;
    let id = peer.next;
    peer.next += 1;
    peer.send(json!({"type":"request","id":id,"method":"net.connect","params":{"computeId":"machine","stream":33,"host":"127.0.0.1","port":u16::from_be(address.sin_port)}}), &[]).await;
    let answer = peer
        .matching(|header| header["type"] == "response" && header["id"] == id)
        .await;
    // A failed connection must return the reservation before another stream uses its identity.
    peer.rpc("process.start", json!({"computeId":"machine","stream":33,"command":"/bin/sh","args":["-c","printf released-slot"]}), &[]).await;
    assert_eq!(peer.data(33).await, b"released-slot");
    peer.release(33).await;
    peer.goodbye().await;
    graph.close().await;
    assert_eq!(answer.0["error"]["code"], "ECONNREFUSED", "{}", answer.0);
}
