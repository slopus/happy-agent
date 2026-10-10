//! The dedicated runner credential authenticates its own binary WebSocket route.
use super::*;
use crate::product::owners::RunnerTransport;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        Message,
        handshake::server::create_response,
        protocol::{Role, WebSocketConfig},
    },
};

const MAX_FRAME: usize = 64 * 1024 * 1024;

impl ApiModule {
    pub(in crate::product) async fn close_runner_connections(&self) {
        let mut connections = std::mem::take(
            &mut *self
                .runner_connections
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        if tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while connections.join_next().await.is_some() {}
        })
        .await
        .is_err()
        {
            connections.abort_all();
            while connections.join_next().await.is_some() {}
        }
    }
    pub(super) async fn runner_connect(
        self: &Arc<Self>,
        mut request: Request<Incoming>,
    ) -> Response<Body> {
        if request.headers().get_all("authorization").iter().count() != 1 {
            return error(401, "unauthorized", "Unauthorized");
        }
        let authorization = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let Some(id) = self.runners.authenticate(authorization) else {
            return error(401, "unauthorized", "Unauthorized");
        };
        if !self.lifecycle.is_ready() {
            return error(503, "not_initialized", "Happy Agent is still starting.");
        }
        if self.lifecycle.is_draining() {
            return error(
                503,
                "draining",
                "Happy Agent is draining and no longer accepts runner connections.",
            );
        }
        let Ok(slot) = self.runner_connection_slots.clone().try_acquire_owned() else {
            return error(
                503,
                "unavailable",
                "Happy Agent is handling its maximum number of runner connections.",
            );
        };
        let valid_key = request
            .headers()
            .get_all("sec-websocket-key")
            .iter()
            .count()
            == 1
            && request
                .headers()
                .get("sec-websocket-key")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| base64::engine::general_purpose::STANDARD.decode(value).ok())
                .is_some_and(|bytes| bytes.len() == 16);
        let mut handshake = Request::new(());
        *handshake.method_mut() = request.method().clone();
        *handshake.uri_mut() = request.uri().clone();
        *handshake.version_mut() = request.version();
        *handshake.headers_mut() = request.headers().clone();
        let response = match create_response(&handshake) {
            Ok(response) if valid_key => response,
            _ => {
                return error(
                    400,
                    "invalid_request",
                    "The runner WebSocket handshake is invalid.",
                );
            }
        };
        let upgraded = hyper::upgrade::on(&mut request);
        let runners = self.runners.clone();
        let shutdown = self.lifecycle.shutdown.child_token();
        let mut connections = self
            .runner_connections
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.lifecycle.shutdown.is_cancelled() {
            return error(
                503,
                "draining",
                "Happy Agent is shutting down and no longer accepts runner connections.",
            );
        }
        while connections.try_join_next().is_some() {}
        connections.spawn(async move {
            let _slot=slot;
            let upgraded=tokio::select!{result=upgraded=>match result {Ok(upgraded)=>upgraded,Err(_)=>return},_=shutdown.cancelled()=>return};
            let configuration=WebSocketConfig::default().read_buffer_size(4096).write_buffer_size(0).max_write_buffer_size(MAX_FRAME+65536).max_message_size(Some(MAX_FRAME)).max_frame_size(Some(MAX_FRAME));
            let socket=WebSocketStream::from_raw_socket(hyper_util::rt::TokioIo::new(upgraded),Role::Server,Some(configuration)).await;
            let (mut writer,mut reader)=socket.split();
            // Queue one complete frame in each direction; a slow peer pauses
            // its producer rather than accumulating file replies in memory.
            let (incoming,sources)=tokio::sync::mpsc::channel(1);
            let (destinations,mut outgoing)=tokio::sync::mpsc::channel::<Vec<u8>>(1);
            let (result,protocol_finished) = {
            let receive=async {
                while let Some(message)=reader.next().await {
                    match message? {
                        Message::Binary(bytes)=>incoming.send(bytes.to_vec()).await.map_err(|_|anyhow::anyhow!("The runner protocol connection ended."))?,
                        Message::Close(_)=>return Ok::<(),anyhow::Error>(()),
                        Message::Ping(_)|Message::Pong(_)=>{},
                        _=>anyhow::bail!("The runner protocol accepts only binary WebSocket messages."),
                    }
                }
                Ok(())
            };
            let send=async {
                while let Some(frame)=outgoing.recv().await {writer.send(Message::Binary(frame.into())).await?;}
                Ok::<(),anyhow::Error>(())
            };
            let protocol=runners.accept(id,RunnerTransport {incoming:sources,outgoing:destinations});
            tokio::pin!(receive,send,protocol);
            tokio::select!{result=&mut protocol=>(result,true),result=&mut receive=>(result,false),result=&mut send=>(result,false)}
            };
            // Cancellation of send may leave a frame buffered in the sink. Flush
            // that frame before draining the single queued protocol frame, so a
            // daemon shutdown delivers Goodbye exactly once before closing.
            let _=tokio::time::timeout(std::time::Duration::from_secs(2),async {
                writer.flush().await?;
                if protocol_finished {
                    while let Ok(frame)=outgoing.try_recv() {writer.send(Message::Binary(frame.into())).await?;}
                }
                writer.close().await
            }).await;
            if let Err(failure)=result {eprintln!("Runner connection ended: {failure:#}");}
        });
        Response::from_parts(
            response.into_parts().0,
            Full::new(Bytes::new())
                .map_err(|never| match never {})
                .boxed_unsync(),
        )
    }
}
