//! Native runner-side ownership. Computes and streams belong to a daemon epoch,
//! survive its connection lease, and are joined before that owner is released.
use super::*;
use crate::product::tools::{
    NativeRunnerCompute, NativeRunnerProcess, NativeRunnerProcessEvent, ToolsModule,
};
use std::collections::VecDeque;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(test)]
#[path = "runners_server_tests.rs"]
mod tests;

pub struct RunnerServer {
    runners: Arc<RunnersModule>,
    tools: Arc<ToolsModule>,
    owner: tokio::sync::Mutex<Option<Arc<Owner>>>,
    stopped: AtomicBool,
    leases: Mutex<tokio::task::JoinSet<()>>,
}
struct Connection {
    id: String,
    sender: mpsc::Sender<Vec<u8>>,
    stop: CancellationToken,
}
struct Owner {
    instance: String,
    epoch: String,
    computes: tokio::sync::Mutex<BTreeMap<String, Arc<NativeRunnerCompute>>>,
    streams: tokio::sync::Mutex<BTreeMap<u64, Arc<Stream>>>,
    connection: Mutex<Option<Connection>>,
    stop: CancellationToken,
    grace: AtomicU64,
    lease: Mutex<Option<CancellationToken>>,
    tasks: tokio::sync::Mutex<tokio::task::JoinSet<()>>,
    events: Mutex<VecDeque<Value>>,
    sequence: AtomicU64,
}
struct ConnectionGuard {
    server: std::sync::Weak<RunnerServer>,
    owner: Arc<Owner>,
    id: String,
    armed: bool,
}
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let own = {
            let mut connection = self
                .owner
                .connection
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if connection
                .as_ref()
                .is_some_and(|connection| connection.id == self.id)
            {
                if let Some(connection) = connection.take() {
                    connection.stop.cancel();
                }
                true
            } else {
                false
            }
        };
        if own {
            if let Some(server) = self.server.upgrade() {
                server.lease(self.owner.clone());
            }
        }
    }
}
struct Channel {
    sent: u64,
    acknowledged: u64,
    retained: VecDeque<(u64, Vec<u8>)>,
    ended: bool,
}
impl Channel {
    fn new() -> Self {
        Self {
            sent: 0,
            acknowledged: 0,
            retained: VecDeque::new(),
            ended: false,
        }
    }
}
struct Input {
    received: u64,
    consumed: u64,
    pending: VecDeque<u8>,
    ended: bool,
    end_delivered: bool,
}
enum Control {
    Process(Arc<NativeRunnerProcess>),
    Socket(tokio::sync::Mutex<tokio::net::tcp::OwnedWriteHalf>),
    Passive,
    Listener(Arc<tokio::sync::Mutex<BTreeMap<u64, (tokio::net::TcpStream, tokio::time::Instant)>>>),
}
struct Stream {
    id: u64,
    compute: String,
    control: tokio::sync::OnceCell<Control>,
    ready: Notify,
    output: [tokio::sync::Mutex<Channel>; 2],
    input: Mutex<Input>,
    input_changed: Notify,
    space: Notify,
    exit: Mutex<Option<Value>>,
    stop: CancellationToken,
    tasks: tokio::sync::Mutex<tokio::task::JoinSet<()>>,
}
impl RunnersModule {
    pub fn native_server(self: &Arc<Self>, tools: Arc<ToolsModule>) -> Arc<RunnerServer> {
        Arc::new(RunnerServer {
            runners: self.clone(),
            tools,
            owner: tokio::sync::Mutex::new(None),
            stopped: AtomicBool::new(false),
            leases: Mutex::new(tokio::task::JoinSet::new()),
        })
    }
}
impl RunnerServer {
    pub async fn serve(self: &Arc<Self>, mut transport: RunnerTransport) -> Result<String> {
        anyhow::ensure!(
            !self.stopped.load(Ordering::Acquire),
            "The runner is shutting down."
        );
        self.runners.send(&transport.outgoing,json!({"type":"hello","protocol":{"min":1,"max":1},"runner":self.runners.config.runner_identity()?}),&[]).await?;
        let welcome = tokio::select! {result=tokio::time::timeout(Duration::from_secs(10),self.runners.receive(&mut transport.incoming))=>result.context("The daemon did not finish the runner handshake in time.")??,_=self.runners.lifecycle.shutdown.cancelled()=>return Ok("The runner is shutting down.".into())};
        anyhow::ensure!(
            welcome.0["type"] == "welcome" && welcome.0["protocol"] == 1 && welcome.1.is_empty(),
            "The daemon did not choose this runner's protocol."
        );
        let instance = welcome.0["instanceId"].as_str().unwrap().to_owned();
        let grace = welcome.0["leaseGraceMs"].as_u64().unwrap();
        let connection = Connection {
            id: uuid::Uuid::new_v4().to_string(),
            sender: transport.outgoing,
            stop: self.runners.lifecycle.shutdown.child_token(),
        };
        let connection_id = connection.id.clone();
        let connection_stop = connection.stop.clone();
        let sender = connection.sender.clone();
        let owner = {
            let mut current = self.owner.lock().await;
            if current
                .as_ref()
                .is_some_and(|owner| owner.instance != instance)
            {
                if let Some(previous) = current.take() {
                    self.release(&previous).await?;
                }
            }
            let owner = current
                .get_or_insert_with(|| {
                    Arc::new(Owner {
                        instance,
                        epoch: uuid::Uuid::new_v4().to_string(),
                        computes: tokio::sync::Mutex::new(BTreeMap::new()),
                        streams: tokio::sync::Mutex::new(BTreeMap::new()),
                        connection: Mutex::new(None),
                        stop: CancellationToken::new(),
                        grace: AtomicU64::new(grace),
                        lease: Mutex::new(None),
                        tasks: tokio::sync::Mutex::new(tokio::task::JoinSet::new()),
                        events: Mutex::new(VecDeque::new()),
                        sequence: AtomicU64::new(1),
                    })
                })
                .clone();
            if let Some(lease) = owner
                .lease
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
            {
                lease.cancel();
            }
            owner.grace.store(grace, Ordering::Release);
            if let Some(previous) = owner
                .connection
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .replace(connection)
            {
                previous.stop.cancel();
            }
            owner
        };
        let mut guard = ConnectionGuard {
            server: Arc::downgrade(self),
            owner: owner.clone(),
            id: connection_id.clone(),
            armed: true,
        };
        let computes = owner
            .computes
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let streams = owner
            .streams
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        self.runners.send(&sender,json!({"type":"ready","epoch":owner.epoch,"computes":computes,"streams":streams.iter().map(|stream|stream.id).collect::<Vec<_>>()}),&[]).await?;
        for compute in &computes {
            self.sessions(&owner, compute).await?;
        }
        let events = owner
            .events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        for event in events {
            self.send(&owner, event, &[]).await?;
        }
        for stream in streams {
            self.resend(&owner, &stream).await?;
        }
        let mut requests = tokio::task::JoinSet::new();
        let mut pending = BTreeMap::<u64, CancellationToken>::new();
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        heartbeat.tick().await;
        let mut last = tokio::time::Instant::now();
        let mut nonce = 1;
        let mut goodbye = false;
        let outcome=async {
            loop {
                tokio::select! {
                    _=connection_stop.cancelled()=>{if self.runners.lifecycle.shutdown.is_cancelled(){let _=self.runners.send(&sender,json!({"type":"goodbye","reason":"The runner is shutting down."}),&[]).await;goodbye=true;}return Ok("The runner connection ended.".to_owned());},
                    done=requests.join_next(),if !requests.is_empty()=>{if let Some(Ok(id))=done{pending.remove(&id);}},
                    _=heartbeat.tick()=>{anyhow::ensure!(last.elapsed()<Duration::from_secs(45),"The daemon stopped responding.");self.runners.send(&sender,json!({"type":"ping","nonce":nonce}),&[]).await?;nonce+=1;},
                    frame=self.runners.receive(&mut transport.incoming)=>{
                        let (header,body)=frame?;last=tokio::time::Instant::now();
                        match header["type"].as_str().unwrap() {
                            "ping"=>self.runners.send(&sender,json!({"type":"pong","nonce":header["nonce"]}),&[]).await?,
                            "pong"=>{},
                            "ack"=>{let sequence=header["seq"].as_u64().unwrap();owner.events.lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|event|event["seq"].as_u64().unwrap()>sequence);},
                            "goodbye"=>{goodbye=true;return Ok(header["reason"].as_str().unwrap().to_owned());},
                            "cancel"=>{if let Some(cancel)=pending.get(&header["id"].as_u64().unwrap()){cancel.cancel();}},
                            "request"=>{
                                let id=header["id"].as_u64().unwrap();
                                if pending.contains_key(&id)||pending.len()>=128 {self.error(&sender,id,"ERUNNERBUSY","The runner is already handling as many requests as it accepts.").await?;continue;}
                                let method=header["method"].as_str().unwrap().to_owned();
                                let Some((_,params_schema,_))=METHODS.iter().find(|(name,_,_)|*name==method) else {self.error(&sender,id,"ERUNNERPROTOCOL","The runner does not know this request.").await?;continue;};
                                if !self.runners.schemas.valid(params_schema,&header["params"])? {self.error(&sender,id,"ERUNNERPROTOCOL","The daemon sent invalid request parameters.").await?;continue;}
                                let cancel=connection_stop.child_token();pending.insert(id,cancel.clone());
                                let server=self.clone();let owner=owner.clone();let sender=sender.clone();let params=header["params"].clone();
                                requests.spawn(async move {let answer=server.answer(&owner,&method,&params,&body,&cancel).await;match answer {Ok((result,body))=>{let _=server.runners.send(&sender,json!({"type":"response","id":id,"result":result}),&body).await;},Err(error)=>{let code=server.runners.error_code(&error).unwrap_or("ERUNNER");let _=server.error(&sender,id,code,&error.to_string()).await;}}id});
                            },
                            "data"|"eof"|"flow"|"close"|"release"=>self.stream_frame(&owner,&header,&body).await?,
                            _=>bail!("The daemon sent a frame that only a runner may send."),
                        }
                    }
                }
            }
        }.await;
        for cancel in pending.values() {
            cancel.cancel();
        }
        while requests.join_next().await.is_some() {}
        let own = {
            let mut connection = owner
                .connection
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if connection
                .as_ref()
                .is_some_and(|connection| connection.id == connection_id)
            {
                connection.take();
                true
            } else {
                false
            }
        };
        guard.armed = false;
        if own {
            if goodbye {
                let mut current = self.owner.lock().await;
                if current
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &owner))
                {
                    current.take();
                }
                self.release(&owner).await?;
            } else {
                self.lease(owner);
            }
        }
        outcome
    }
    async fn error(
        &self,
        sender: &mpsc::Sender<Vec<u8>>,
        id: u64,
        code: &str,
        message: &str,
    ) -> Result<()> {
        let message = message.chars().take(8000).collect::<String>();
        self.runners.send(sender,json!({"type":"response","id":id,"error":{"name":match code{"ERUNNERCOMPUTEUNKNOWN"=>"RunnerComputeUnknownError","ERUNNERBUSY"=>"RunnerBusyError","ERUNNERPROTOCOL"=>"RunnerProtocolError",_=>"Error"},"message":message,"code":code}}),&[]).await
    }
    async fn send(&self, owner: &Owner, header: Value, body: &[u8]) -> Result<()> {
        let connection = owner
            .connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|connection| (connection.sender.clone(), connection.stop.clone()));
        if let Some((sender, stop)) = connection {
            if self.runners.send(&sender, header, body).await.is_err() {
                stop.cancel();
            }
        }
        Ok(())
    }
    async fn answer(
        self: &Arc<Self>,
        owner: &Arc<Owner>,
        method: &str,
        params: &Value,
        body: &[u8],
        cancel: &CancellationToken,
    ) -> Result<Frame> {
        anyhow::ensure!(
            !owner.stop.is_cancelled(),
            "The daemon's runner lease has ended."
        );
        if method == "process.resize" || method == "process.signal" {
            let stream = self
                .stream(owner, params["stream"].as_u64().unwrap())
                .await?;
            let control = stream
                .control
                .get()
                .ok_or_else(|| std::io::Error::from_raw_os_error(libc::ESRCH))?;
            if let Control::Process(process) = control {
                if method == "process.resize" {
                    process.resize(
                        params["cols"].as_u64().unwrap() as u16,
                        params["rows"].as_u64().unwrap() as u16,
                    )?;
                } else {
                    process.signal(params["signal"].as_str().unwrap())?;
                }
            }
            return Ok((json!({}), Vec::new()));
        }
        let id = params["computeId"].as_str().unwrap();
        let answer = match method {
            "compute.create" => {
                let mut computes = owner.computes.lock().await;
                let retained = computes.contains_key(id);
                let compute = if let Some(compute) = computes.get(id) {
                    if !compute.matches(params) {
                        return Err(super::compute::remote_error(
                            &json!({"name":"Error","message":"The runner already holds this machine in a different folder.","code":"EEXIST"}),
                        ));
                    }
                    compute.clone()
                } else {
                    if computes.len() >= 512 {
                        return Err(super::compute::remote_error(
                            &json!({"name":"RunnerBusyError","message":"The runner already holds as many machines as it allows.","code":"ERUNNERBUSY"}),
                        ));
                    }
                    let compute = self.tools.native_runner_compute(params)?;
                    self.observe(owner, id, compute.clone()).await;
                    computes.insert(id.to_owned(), compute.clone());
                    compute
                };
                (
                    json!({"cwd":compute.filesystem.cwd(),"home":compute.filesystem.home(),"kind":"host","supportsSessionInput":true,"retained":retained}),
                    Vec::new(),
                )
            }
            "compute.dispose" => {
                let streams = owner
                    .streams
                    .lock()
                    .await
                    .values()
                    .filter(|stream| stream.compute == id)
                    .cloned()
                    .collect::<Vec<_>>();
                for stream in streams {
                    stream.stop.cancel();
                    self.close_stream(&stream).await;
                }
                if let Some(compute) = owner.computes.lock().await.remove(id) {
                    compute.dispose().await?;
                }
                (json!({}), Vec::new())
            }
            _ => {
                let compute=owner.computes.lock().await.get(id).cloned().ok_or_else(||super::compute::remote_error(&json!({"name":"RunnerComputeUnknownError","message":"The runner no longer holds that machine.","code":"ERUNNERCOMPUTEUNKNOWN"})))?;
                match method {
                    "process.start" => {
                        let stream = self
                            .open(owner, id, params["stream"].as_u64().unwrap(), None)
                            .await?;
                        let process = match compute.process(params, cancel).await {
                            Ok(process) => process,
                            Err(error) => {
                                owner.streams.lock().await.remove(&stream.id);
                                self.close_stream(&stream).await;
                                return Err(error);
                            }
                        };
                        let mut output = process.take_output()?;
                        anyhow::ensure!(
                            stream.control.set(Control::Process(process)).is_ok(),
                            "The process stream was already started."
                        );
                        stream.ready.notify_waiters();
                        let server = self.clone();
                        let held_owner = owner.clone();
                        let held_stream = stream.clone();
                        stream.tasks.lock().await.spawn(async move {loop{let event=tokio::select! {event=output.recv()=>event,_=held_stream.stop.cancelled()=>break};match event {Some(NativeRunnerProcessEvent::Data{error,bytes})=>{if server.push(&held_owner,&held_stream,error as usize,&bytes).await.is_err(){break;}},Some(NativeRunnerProcessEvent::Exit{code,signal})=>{let _=server.finish(&held_owner,&held_stream,code,signal,None).await;break;},None=>break}}});
                        (json!({}), Vec::new())
                    }
                    "watch.start" => {
                        let watch =
                            compute.watch(params["path"].as_str().unwrap(), &params["ignore"])?;
                        let stream = self
                            .open(
                                owner,
                                id,
                                params["stream"].as_u64().unwrap(),
                                Some(Control::Passive),
                            )
                            .await?;
                        let server = self.clone();
                        let held_owner = owner.clone();
                        let held_stream = stream.clone();
                        stream.tasks.lock().await.spawn(async move {loop{let batch=tokio::select! {batch=watch.next()=>batch,_=held_stream.stop.cancelled()=>break};let mut bytes=serde_json::to_vec(&batch).unwrap();bytes.push(b'\n');if server.push(&held_owner,&held_stream,0,&bytes).await.is_err(){break;}}drop(watch);let _=server.finish(&held_owner,&held_stream,None,None,None).await;});
                        (json!({}), Vec::new())
                    }
                    "net.connect" => {
                        let socket = compute
                            .connect(
                                params["host"].as_str().unwrap(),
                                params["port"].as_u64().unwrap() as u16,
                            )
                            .await?;
                        self.socket(owner, id, params["stream"].as_u64().unwrap(), socket)
                            .await?;
                        (json!({}), Vec::new())
                    }
                    "net.listen" => {
                        let listener = compute.listen().await?;
                        let port = listener.local_addr()?.port();
                        let pending = Arc::new(tokio::sync::Mutex::new(BTreeMap::new()));
                        let stream = self
                            .open(
                                owner,
                                id,
                                params["stream"].as_u64().unwrap(),
                                Some(Control::Listener(pending.clone())),
                            )
                            .await?;
                        let server = self.clone();
                        let held_owner = owner.clone();
                        let held_stream = stream.clone();
                        stream.tasks.lock().await.spawn(async move {let mut next=1;let mut expiry=tokio::time::interval(Duration::from_secs(1));loop {tokio::select! {_=held_stream.stop.cancelled()=>break,_=expiry.tick()=>{pending.lock().await.retain(|_,(_,created)|created.elapsed()<Duration::from_secs(30));},accepted=listener.accept()=>{match accepted {Ok((socket,_))=>{let mut held=pending.lock().await;if held.len()>=64 {continue;}let connection=next;next+=1;held.insert(connection,(socket,tokio::time::Instant::now()));drop(held);let bytes=format!("{{\"connection\":{connection}}}\n");if server.push(&held_owner,&held_stream,0,bytes.as_bytes()).await.is_err(){break;}},Err(error)=>{let _=server.finish(&held_owner,&held_stream,None,None,Some(error.to_string())).await;return;}}}}}pending.lock().await.clear();let _=server.finish(&held_owner,&held_stream,None,None,None).await;});
                        (json!({"port":port}), Vec::new())
                    }
                    "net.accept" => {
                        let listener = self
                            .stream(owner, params["listener"].as_u64().unwrap())
                            .await?;
                        let Some(Control::Listener(pending)) = listener.control.get() else {
                            bail!("The runner no longer holds that listener.")
                        };
                        let socket = pending
                            .lock()
                            .await
                            .remove(&params["connection"].as_u64().unwrap())
                            .map(|(socket, _)| socket)
                            .context("The runner no longer holds that connection.")?;
                        self.socket(owner, id, params["stream"].as_u64().unwrap(), socket)
                            .await?;
                        (json!({}), Vec::new())
                    }
                    _ => compute.request(method, params, body, cancel).await?,
                }
            }
        };
        let (_, _, schema) = METHODS.iter().find(|(name, _, _)| *name == method).unwrap();
        anyhow::ensure!(
            self.runners.schemas.valid(schema, &answer.0)?,
            "The runner produced an invalid method result."
        );
        Ok(answer)
    }
    async fn open(
        self: &Arc<Self>,
        owner: &Arc<Owner>,
        compute: &str,
        id: u64,
        control: Option<Control>,
    ) -> Result<Arc<Stream>> {
        let stream = Arc::new(Stream {
            id,
            compute: compute.to_owned(),
            control: tokio::sync::OnceCell::new_with(control),
            ready: Notify::new(),
            output: [
                tokio::sync::Mutex::new(Channel::new()),
                tokio::sync::Mutex::new(Channel::new()),
            ],
            input: Mutex::new(Input {
                received: 0,
                consumed: 0,
                pending: VecDeque::new(),
                ended: false,
                end_delivered: false,
            }),
            input_changed: Notify::new(),
            space: Notify::new(),
            exit: Mutex::new(None),
            stop: owner.stop.child_token(),
            tasks: tokio::sync::Mutex::new(tokio::task::JoinSet::new()),
        });
        let mut streams = owner.streams.lock().await;
        anyhow::ensure!(
            streams.len() < 256,
            "The runner already holds as many streams as it allows."
        );
        anyhow::ensure!(
            !streams.contains_key(&id),
            "The daemon reused a stream that is still open."
        );
        streams.insert(id, stream.clone());
        drop(streams);
        let server = self.clone();
        let held_owner = owner.clone();
        let held_stream = stream.clone();
        stream.tasks.lock().await.spawn(async move {loop {
            loop {let ready=held_stream.ready.notified();tokio::pin!(ready);ready.as_mut().enable();if held_stream.control.get().is_some(){break;}tokio::select! {_=ready=>{},_=held_stream.stop.cancelled()=>return}}
            let changed=held_stream.input_changed.notified();tokio::pin!(changed);changed.as_mut().enable();
            let (bytes,end)={let mut input=held_stream.input.lock().unwrap_or_else(std::sync::PoisonError::into_inner);let count=input.pending.len().min(65536);let bytes=input.pending.drain(..count).collect::<Vec<_>>();let end=bytes.is_empty()&&input.ended&&!input.end_delivered;if end{input.end_delivered=true;}(bytes,end)};
            if bytes.is_empty()&&!end {tokio::select! {_=changed=>continue,_=held_stream.stop.cancelled()=>break}}
            let delivered=async {match held_stream.control.get().unwrap() {Control::Process(process)=>{if end{process.end_input().await?;}else{process.input(&bytes).await?;}},Control::Socket(socket)=>{let mut socket=socket.lock().await;if end{socket.shutdown().await?;}else{socket.write_all(&bytes).await?;}},_=>{}}Ok::<_,anyhow::Error>(())};
            let result=tokio::select! {result=delivered=>result,_=held_stream.stop.cancelled()=>break};
            if result.is_err(){held_stream.stop.cancel();break;}
            if !bytes.is_empty(){let consumed={let mut input=held_stream.input.lock().unwrap_or_else(std::sync::PoisonError::into_inner);input.consumed+=bytes.len() as u64;input.consumed};let _=server.send(&held_owner,json!({"type":"flow","stream":held_stream.id,"channel":"in","consumed":consumed}),&[]).await;}
        }});
        Ok(stream)
    }
    async fn socket(
        self: &Arc<Self>,
        owner: &Arc<Owner>,
        compute: &str,
        id: u64,
        socket: tokio::net::TcpStream,
    ) -> Result<()> {
        let (mut reader, writer) = socket.into_split();
        let stream = self
            .open(
                owner,
                compute,
                id,
                Some(Control::Socket(tokio::sync::Mutex::new(writer))),
            )
            .await?;
        let server = self.clone();
        let held_owner = owner.clone();
        let held_stream = stream.clone();
        stream.tasks.lock().await.spawn(async move {let mut bytes=[0;8192];let mut error=None;loop {let read=tokio::select! {read=reader.read(&mut bytes)=>read,_=held_stream.stop.cancelled()=>break};match read {Ok(0)=>break,Ok(count)=>{if server.push(&held_owner,&held_stream,0,&bytes[..count]).await.is_err(){break;}},Err(failure)=>{error=Some(failure.to_string());break;}}}let _=server.finish(&held_owner,&held_stream,None,None,error).await;});
        Ok(())
    }
    async fn stream(&self, owner: &Owner, id: u64) -> Result<Arc<Stream>> {
        owner
            .streams
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| std::io::Error::from_raw_os_error(libc::ESRCH).into())
    }
    async fn push(&self, owner: &Owner, stream: &Stream, index: usize, bytes: &[u8]) -> Result<()> {
        let mut remaining = bytes;
        while !remaining.is_empty() {
            let changed = stream.space.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let mut channel = stream.output[index].lock().await;
            anyhow::ensure!(!channel.ended, "The output channel has ended.");
            let available =
                (512 * 1024u64).saturating_sub(channel.sent - channel.acknowledged) as usize;
            if available == 0 {
                drop(channel);
                tokio::select! {_=changed=>continue,_=stream.stop.cancelled()=>bail!("The stream ended.")}
            }
            let count = remaining.len().min(available).min(65536);
            let piece = &remaining[..count];
            let offset = channel.sent;
            channel.sent += count as u64;
            channel.retained.push_back((offset, piece.to_vec()));
            self.send(owner,json!({"type":"data","stream":stream.id,"channel":if index==0{"out"}else{"err"},"offset":offset}),piece).await?;
            remaining = &remaining[count..];
        }
        Ok(())
    }
    async fn finish(
        &self,
        owner: &Owner,
        stream: &Stream,
        code: Option<i32>,
        signal: Option<String>,
        error: Option<String>,
    ) -> Result<()> {
        for index in 0..2 {
            let mut channel = stream.output[index].lock().await;
            if !channel.ended {
                channel.ended = true;
                self.send(owner,json!({"type":"eof","stream":stream.id,"channel":if index==0{"out"}else{"err"},"offset":channel.sent}),&[]).await?;
            }
        }
        let mut exit = json!({"type":"exit","stream":stream.id,"exitCode":code,"signal":signal});
        if let Some(error) = error {
            exit["error"] = json!({"name":"Error","message":error});
        }
        stream
            .exit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .replace(exit.clone());
        self.send(owner, exit, &[]).await
    }
    async fn resend(&self, owner: &Owner, stream: &Stream) -> Result<()> {
        for index in 0..2 {
            let channel = stream.output[index].lock().await;
            for (offset, bytes) in &channel.retained {
                self.send(owner,json!({"type":"data","stream":stream.id,"channel":if index==0{"out"}else{"err"},"offset":offset}),bytes).await?;
            }
            if channel.ended {
                self.send(owner,json!({"type":"eof","stream":stream.id,"channel":if index==0{"out"}else{"err"},"offset":channel.sent}),&[]).await?;
            }
        }
        let exit = stream
            .exit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(exit) = exit {
            self.send(owner, exit, &[]).await?;
        }
        let consumed = stream
            .input
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .consumed;
        self.send(
            owner,
            json!({"type":"flow","stream":stream.id,"channel":"in","consumed":consumed}),
            &[],
        )
        .await
    }
    async fn stream_frame(&self, owner: &Owner, header: &Value, body: &[u8]) -> Result<()> {
        let id = header["stream"].as_u64().unwrap();
        let Ok(stream) = self.stream(owner, id).await else {
            return Ok(());
        };
        match header["type"].as_str().unwrap() {
            "data" => {
                anyhow::ensure!(
                    header["channel"] == "in" && body.len() <= 65536,
                    "The daemon sent stream data on the wrong channel or exceeded its chunk bound."
                );
                let mut input = stream
                    .input
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let offset = header["offset"].as_u64().unwrap();
                let end = offset
                    .checked_add(body.len() as u64)
                    .context("The stream offset overflowed.")?;
                anyhow::ensure!(offset <= input.received, "The daemon skipped input bytes.");
                if end <= input.received {
                    return Ok(());
                }
                anyhow::ensure!(
                    !input.ended && end - input.consumed <= 512 * 1024,
                    "The daemon exceeded the input window or sent after EOF."
                );
                let skip = (input.received - offset) as usize;
                input.pending.extend(&body[skip..]);
                input.received = end;
                drop(input);
                stream.input_changed.notify_one();
            }
            "eof" => {
                anyhow::ensure!(
                    header["channel"] == "in",
                    "The daemon ended the wrong channel."
                );
                let mut input = stream
                    .input
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                anyhow::ensure!(
                    header["offset"].as_u64() == Some(input.received),
                    "The daemon ended input at the wrong offset."
                );
                input.ended = true;
                drop(input);
                stream.input_changed.notify_one();
            }
            "flow" => {
                let index = match header["channel"].as_str() {
                    Some("out") => 0,
                    Some("err") => 1,
                    _ => bail!("The daemon acknowledged the wrong channel."),
                };
                let mut channel = stream.output[index].lock().await;
                let consumed = header["consumed"].as_u64().unwrap();
                anyhow::ensure!(
                    consumed <= channel.sent,
                    "The daemon acknowledged bytes that were never sent."
                );
                if consumed <= channel.acknowledged {
                    return Ok(());
                }
                channel.acknowledged = consumed;
                while let Some((offset, bytes)) = channel.retained.front_mut() {
                    let end = *offset + bytes.len() as u64;
                    if end <= consumed {
                        channel.retained.pop_front();
                    } else {
                        if *offset < consumed {
                            bytes.drain(..(consumed - *offset) as usize);
                            *offset = consumed;
                        }
                        break;
                    }
                }
                drop(channel);
                stream.space.notify_waiters();
            }
            "close" => {
                if let Some(Control::Process(process)) = stream.control.get() {
                    process.stop();
                } else {
                    stream.stop.cancel();
                }
            }
            "release" => {
                owner.streams.lock().await.remove(&id);
                self.close_stream(&stream).await;
            }
            _ => unreachable!(),
        }
        Ok(())
    }
    async fn close_stream(&self, stream: &Stream) {
        stream.stop.cancel();
        if let Some(Control::Process(process)) = stream.control.get() {
            process.stop();
        }
        let mut tasks = stream.tasks.lock().await;
        while tasks.join_next().await.is_some() {}
    }
    async fn release(&self, owner: &Owner) -> Result<()> {
        owner.stop.cancel();
        if let Some(lease) = owner
            .lease
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            lease.cancel();
        }
        if let Some(connection) = owner
            .connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            connection.stop.cancel();
        }
        let streams = std::mem::take(&mut *owner.streams.lock().await);
        for stream in streams.values() {
            stream.stop.cancel();
        }
        for stream in streams.values() {
            self.close_stream(stream).await;
        }
        let computes = std::mem::take(&mut *owner.computes.lock().await);
        for compute in computes.values() {
            compute.dispose().await?;
        }
        let mut tasks = owner.tasks.lock().await;
        while tasks.join_next().await.is_some() {}
        Ok(())
    }
    fn lease(self: &Arc<Self>, owner: Arc<Owner>) {
        let cancel = self.runners.lifecycle.shutdown.child_token();
        owner
            .lease
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .replace(cancel.clone());
        let weak = Arc::downgrade(self);
        let grace = owner.grace.load(Ordering::Acquire);
        let mut leases = self
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while leases.try_join_next().is_some() {}
        leases.spawn(async move {tokio::select! {_=cancel.cancelled()=>return,_=tokio::time::sleep(Duration::from_millis(grace))=>{}}
            if let Some(server)=weak.upgrade(){let mut current=server.owner.lock().await;if !cancel.is_cancelled()&&current.as_ref().is_some_and(|current|Arc::ptr_eq(current,&owner))&&owner.connection.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_none(){current.take();if let Err(error)=server.release(&owner).await{eprintln!("Runner lease cleanup could not be confirmed: {error:#}");}}}
        });
    }
    pub async fn close(&self) -> Result<()> {
        self.stopped.store(true, Ordering::Release);
        if let Some(owner) = self.owner.lock().await.take() {
            self.release(&owner).await?;
        }
        let mut leases = std::mem::take(
            &mut *self
                .leases
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        while leases.join_next().await.is_some() {}
        Ok(())
    }
    async fn sessions(&self, owner: &Owner, id: &str) -> Result<()> {
        let Some(compute) = owner.computes.lock().await.get(id).cloned() else {
            return Ok(());
        };
        self.send(owner,json!({"type":"event","event":"shell.sessions","params":{"computeId":id,"sessions":compute.activity()}}),&[]).await
    }
    async fn observe(
        self: &Arc<Self>,
        owner: &Arc<Owner>,
        id: &str,
        compute: Arc<NativeRunnerCompute>,
    ) {
        let mut events = compute.on_shell_event();
        let lifetime = compute.lifetime();
        let server = self.clone();
        let owner = owner.clone();
        let id = id.to_owned();
        let task_owner = owner.clone();
        owner.tasks.lock().await.spawn(async move {loop {
            let event=tokio::select! {event=events.recv()=>event,_=task_owner.stop.cancelled()=>break,_=lifetime.cancelled()=>break};
            match event {
                Ok((identity,event)) if compute.owns_shell_event(&identity)=>{
                    if event["event"]=="shell.sessions" {let _=server.sessions(&task_owner,&id).await;}
                    else if event["event"]=="shell.exit" {
                        let event=json!({"type":"event","seq":task_owner.sequence.fetch_add(1,Ordering::AcqRel),"event":"shell.exit","params":{"computeId":id,"exit":event["exit"]}});
                        if !task_owner.stop.is_cancelled() {{let mut retained=task_owner.events.lock().unwrap_or_else(std::sync::PoisonError::into_inner);if retained.len()==1024{retained.pop_front();}retained.push_back(event.clone());}let _=server.send(&task_owner,event,&[]).await;}
                    }
                },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>{let _=server.sessions(&task_owner,&id).await;},
                Err(tokio::sync::broadcast::error::RecvError::Closed)=>break,
                _=>{},
            }
        }});
    }
}
