//! Exercise every Source method through actual binary frames and native effects.
use super::*;
use crate::product::{
    history::HistoryModule, secrets::SecretsModule, services::ServicesModule, usage::UsageModule,
};
struct Graph {
    fixture: crate::product::owners::Fixture,
    server: Arc<RunnerServer>,
    tools: Arc<ToolsModule>,
}
impl Drop for Graph {fn drop(&mut self){self.fixture.lifecycle.begin_shutdown();}}
impl Graph {
    async fn new() -> Self {
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
            )
            .unwrap(),
        );
        let server = runners.native_server(tools.clone());
        Self {
            fixture,
            server,
            tools,
        }
    }
    async fn close(self) {
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
    peer.rpc("compute.dispose", json!({"computeId":"machine"}), &[])
        .await;
    assert_eq!(
        peer.methods,
        METHODS
            .iter()
            .map(|(name, _, _)| name.to_string())
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
    let graph=Graph::new().await;
    let mut peer=Peer::connect(graph.server.clone(),"daemon-a",0).await;
    peer.rpc("compute.create",json!({"computeId":"machine","cwd":graph.fixture.directory.path()}),&[]).await;
    let id=peer.next;peer.send(json!({"type":"request","id":id,"method":"fs.stat","params":path("missing")}),&[]).await;
    let answer=peer.matching(|header|header["type"]=="response"&&header["id"]==id).await;
    peer.goodbye().await;graph.close().await;
    assert_eq!(answer.0["error"]["code"],"ENOENT","{}",answer.0);
}
