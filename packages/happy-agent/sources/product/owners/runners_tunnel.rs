//! Bounded loopback transport for daemon-owned Git credentials.
use super::{RunnersModule, Session};
use anyhow::{Context as _, Result};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{Semaphore, mpsc},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

pub(super) struct Tunnel {
    port: u16,
    proxy_port: u16,
    cancel: CancellationToken,
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

pub(super) struct PendingRequest {
    pub session: Arc<Session>,
    pub id: u64,
}
impl Drop for PendingRequest {
    fn drop(&mut self) {
        if self
            .session
            .requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.id)
            .is_some()
        {
            send_now(&self.session, json!({"type":"cancel","id":self.id}));
        }
    }
}
pub(super) struct StreamRoute {
    session: Arc<Session>,
    pub id: u64,
}
impl Drop for StreamRoute {
    fn drop(&mut self) {
        self.session
            .streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.id);
        send_now(&self.session, json!({"type":"close","stream":self.id}));
        send_now(&self.session, json!({"type":"release","stream":self.id}));
    }
}
fn send_now(session: &Session, header: Value) {
    if session.cancel.is_cancelled() {
        return;
    }
    if let Ok(header) = serde_json::to_vec(&header) {
        let mut frame = Vec::with_capacity(header.len() + 4);
        frame.extend_from_slice(&(header.len() as u32).to_be_bytes());
        frame.extend_from_slice(&header);
        if session.sender.try_send(frame).is_err() {
            session.cancel.cancel();
        }
    }
}
pub(super) fn route(session: &Arc<Session>) -> Result<(StreamRoute, super::StreamReceiver)> {
    let id = session
        .next_stream
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (sender, receiver) = mpsc::channel(8);
    let mut streams = session
        .streams
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    anyhow::ensure!(streams.len() < 256, "Too many runner streams are open.");
    streams.insert(id, sender);
    Ok((
        StreamRoute {
            session: session.clone(),
            id,
        },
        receiver,
    ))
}

impl RunnersModule {
    pub async fn credential_proxy_port(
        self: &Arc<Self>,
        runner: &str,
        proxy_port: u16,
        cancel: &CancellationToken,
    ) -> Result<u16> {
        let session = self.machine(runner, cancel).await?;
        let mut installed = tokio::select! {_=cancel.cancelled()=>anyhow::bail!("The credential tunnel was cancelled."),guard=session.tunnel.lock()=>guard};
        if let Some(tunnel) = installed.as_ref()
            && !tunnel.cancel.is_cancelled()
        {
            anyhow::ensure!(
                tunnel.proxy_port == proxy_port,
                "The runner credential tunnel names a different proxy."
            );
            return Ok(tunnel.port);
        }
        let (stream, receiver) = route(&session)?;
        let (response, _) = self
            .request(
                &session,
                "net.listen",
                json!({"computeId":"happy-product","stream":stream.id}),
                cancel,
            )
            .await?;
        let port = u16::try_from(
            response["port"]
                .as_u64()
                .context("The runner listener port is missing.")?,
        )?;
        let lifetime = session.cancel.child_token();
        let module = self.clone();
        let connection = session.clone();
        let lifetime_for_task = lifetime.clone();
        tokio::spawn(async move {
            let result = module
                .serve_credentials(connection, stream, receiver, proxy_port, &lifetime_for_task)
                .await;
            lifetime_for_task.cancel();
            if let Err(error) = result {
                eprintln!("The runner Git credential tunnel stopped: {error:#}");
            }
        });
        *installed = Some(Tunnel {
            port,
            proxy_port,
            cancel: lifetime,
        });
        Ok(port)
    }
    async fn serve_credentials(
        self: &Arc<Self>,
        session: Arc<Session>,
        listener: StreamRoute,
        mut receiver: mpsc::Receiver<(Value, Vec<u8>)>,
        proxy_port: u16,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let slots = Arc::new(Semaphore::new(32));
        let mut sockets = JoinSet::new();
        let mut pending = Vec::new();
        let mut consumed = 0u64;
        let result=async {
            loop {
                tokio::select! {
                    _=cancel.cancelled()=>return Ok(()),
                    answer=sockets.join_next(),if !sockets.is_empty()=>{if let Some(Err(error))=answer {return Err(error.into());}},
                    frame=receiver.recv()=>{
                        let(header,body)=frame.context("The runner credential listener ended.")?;
                        match header["type"].as_str().unwrap_or_default() {
                            "data"=>{
                                anyhow::ensure!(header["channel"]=="out","The credential listener sent an invalid channel.");
                                let offset=header["offset"].as_u64().context("The credential listener offset is missing.")?;
                                anyhow::ensure!(offset<=consumed,"The credential listener skipped data.");
                                let duplicated=usize::try_from(consumed-offset)?.min(body.len());let bytes=&body[duplicated..];consumed+=bytes.len() as u64;pending.extend_from_slice(bytes);
                                anyhow::ensure!(pending.len()<=65536,"The credential listener line exceeds its bound.");
                                while let Some(newline)=pending.iter().position(|byte|*byte==b'\n') {
                                    let line=pending.drain(..=newline).collect::<Vec<_>>();let event:Value=serde_json::from_slice(&line)?;
                                    anyhow::ensure!(self.schemas.valid("ownerRunnerAcceptedConnection",&event)?,"The credential listener connection is invalid.");
                                    let permit=slots.clone().try_acquire_owned().context("The credential tunnel has too many open connections.")?;
                                    let(stream,receiver)=route(&session)?;let module=self.clone();let session=session.clone();let lifetime=cancel.clone();let listener_id=listener.id;
                                    sockets.spawn(async move {
                                        let _permit=permit;
                                        let result=module.forward_credential_socket(&session,listener_id,event["connection"].as_u64().unwrap(),stream,receiver,proxy_port,&lifetime).await;
                                        if let Err(error)=result {eprintln!("A runner Git credential connection closed: {error:#}");}
                                    });
                                }
                                self.send(&session.sender,json!({"type":"flow","stream":listener.id,"channel":"out","consumed":consumed}),&[]).await?;
                            },
                            "eof"|"exit"=>return Ok(()),
                            _=>anyhow::bail!("The credential listener sent an invalid frame."),
                        }
                    }
                }
            }
        }.await;
        sockets.abort_all();
        while sockets.join_next().await.is_some() {}
        result
    }
    #[expect(clippy::too_many_arguments)]
    async fn forward_credential_socket(
        &self,
        session: &Arc<Session>,
        listener: u64,
        connection: u64,
        stream: StreamRoute,
        mut receiver: mpsc::Receiver<(Value, Vec<u8>)>,
        proxy_port: u16,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.request(session,"net.accept",json!({"computeId":"happy-product","stream":stream.id,"listener":listener,"connection":connection}),cancel).await?;
        let upstream = tokio::select! {_=cancel.cancelled()=>return Ok(()),answer=tokio::time::timeout(Duration::from_secs(10),TcpStream::connect(("127.0.0.1",proxy_port)))=>answer??};
        let (mut read, mut write) = upstream.into_split();
        let mut bytes = [0u8; 8192];
        let (mut sent, mut acknowledged, mut received) = (0u64, 0u64, 0u64);
        let (mut input_ended, mut output_ended) = (false, false);
        let deadline = tokio::time::sleep(Duration::from_secs(1800));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _=cancel.cancelled()=>return Ok(()),
                _=&mut deadline=>anyhow::bail!("The credential connection reached its time bound."),
                count=read.read(&mut bytes),if !input_ended && sent-acknowledged<512*1024=>{
                    let count=count?;
                    if count==0 {input_ended=true;self.send(&session.sender,json!({"type":"eof","stream":stream.id,"channel":"in","offset":sent}),&[]).await?;}
                    else {self.send(&session.sender,json!({"type":"data","stream":stream.id,"channel":"in","offset":sent}),&bytes[..count]).await?;sent+=count as u64;}
                },
                frame=receiver.recv()=>{
                    let(header,body)=frame.context("The credential socket ended without a final frame.")?;
                    match header["type"].as_str().unwrap_or_default() {
                        "flow"=>{let consumed=header["consumed"].as_u64().context("The credential socket acknowledgment is missing.")?;anyhow::ensure!(header["channel"]=="in" && consumed>=acknowledged && consumed<=sent,"The credential socket acknowledgment is invalid.");acknowledged=consumed;},
                        "data"=>{let offset=header["offset"].as_u64().context("The credential socket offset is missing.")?;anyhow::ensure!(header["channel"]=="out" && offset<=received && !output_ended,"The credential socket output is reordered.");let duplicate=usize::try_from(received-offset)?.min(body.len());let bytes=&body[duplicate..];tokio::select! {_=cancel.cancelled()=>return Ok(()),answer=tokio::time::timeout(Duration::from_secs(30),write.write_all(bytes))=>answer??};received+=bytes.len() as u64;self.send(&session.sender,json!({"type":"flow","stream":stream.id,"channel":"out","consumed":received}),&[]).await?;},
                        "eof"=>{anyhow::ensure!(header["channel"]=="out" && header["offset"].as_u64()==Some(received),"The credential socket ended at an invalid offset.");output_ended=true;write.shutdown().await?;},
                        "exit"=>{anyhow::ensure!(output_ended,"The credential socket exit preceded output completion.");return Ok(());},
                        _=>anyhow::bail!("The credential socket sent an invalid frame."),
                    }
                }
            }
        }
    }
}
