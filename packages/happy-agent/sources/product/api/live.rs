//! HTTP and WebSocket adapters for the source Live owner; calls retain their independent lifetime.
use super::*;
use anyhow::Context as _;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use super::super::live::LiveControlFrame;
use tokio_tungstenite::{WebSocketStream, tungstenite::{Message, handshake::server::create_response, protocol::{CloseFrame, Role, WebSocketConfig}}};

impl ApiModule {
    pub(super) async fn live_route(&self, mut request:Request<Incoming>)->Response<Body> {
        let method=request.method().as_str().to_owned();let path=request.uri().path().to_owned();
        if method=="POST"&&path=="/v0/live/sessions" {
            let body=match read_json_limited(request,384*1024,false).await {Ok(value)=>value,Err(response)=>return response};
            if !self.schemas.valid("ownerLiveCreateRequest",&body).unwrap_or(false){return error(400,"invalid_request","The voice request is invalid.");}
            let result=async {
                let reserved=self.live.reserve_direct("standalone",&body).await?;
                let id=reserved.session["id"].as_str().context("The reserved voice identity is missing.")?.to_owned();
                let sdp=reserved.allocated().await?;
                let live=self.live.clone();let session=self.runtime.transact(move|ctx|live.get(ctx,"standalone",&id)).await?;
                anyhow::ensure!(session["status"]=="starting"||session["status"]=="active",super::super::live::LiveError {status:503,code:"live_unavailable",message:"Voice ended before startup completed.".to_owned(),session:Some(session.clone())});
                Ok::<_,anyhow::Error>(response(201,json!({"session":session,"transport":{"type":"webrtc","sdp":sdp}})))
            }.await;
            return result.unwrap_or_else(internal);
        }
        static PATH:OnceLock<regex_lite::Regex>=OnceLock::new();
        let Some(captures)=PATH.get_or_init(||regex_lite::Regex::new(r"^/v0/live/sessions/([a-z][a-z0-9]{1,31})(/(?:close|control))?$").unwrap()).captures(&path) else {return error(404,"not_found","The requested voice endpoint does not exist.");};
        let id=captures[1].to_owned();let suffix=captures.get(2).map(|capture|capture.as_str());
        match (method.as_str(),suffix) {
            ("GET",None)=>{let live=self.live.clone();match self.runtime.transact(move|ctx|live.get(ctx,"standalone",&id)).await {Ok(session)=>response(200,json!({"session":session})),Err(failure)=>internal(failure)}},
            ("POST",Some("/close"))=>{
                let body=match read_json_limited(request,4096,false).await {Ok(value)=>value,Err(response)=>return response};
                if !self.schemas.valid("ownerLiveCloseRequest",&body).unwrap_or(false){return error(400,"invalid_request","The voice close request is invalid.");}
                let mutation=body["mutationId"].as_str().map(str::to_owned);let live=self.live.clone();
                match self.runtime.transact(move|ctx|live.close(ctx,"standalone",&id,mutation.as_deref())).await {Ok(session)=>response(200,json!({"session":session})),Err(failure)=>internal(failure)}
            },
            ("GET",Some("/control"))=>{
                if self.lifecycle.is_draining(){return error(503,"draining","Happy Agent is draining and no longer accepts attachments.");}
                let url=match reqwest::Url::parse(&format!("http://localhost{}",request.uri())) {Ok(url)=>url,Err(_)=>return error(400,"invalid_request","The voice window identity is invalid.")};
                let query=url.query_pairs().collect::<Vec<_>>();
                if query.len()!=1||query[0].0!="windowId"||!self.schemas.valid("ownerLiveDesktopId",&json!(query[0].1)).unwrap_or(false){return error(400,"invalid_request","The voice window identity is invalid.");}
                let prepared=match self.live.prepare_control("standalone",&id,&query[0].1).await {Ok(prepared)=>prepared,Err(failure)=>return internal(failure)};
                let mut handshake=Request::new(());*handshake.method_mut()=request.method().clone();*handshake.uri_mut()=request.uri().clone();*handshake.version_mut()=request.version();*handshake.headers_mut()=request.headers().clone();
                let valid_key=request.headers().get_all("sec-websocket-key").iter().count()==1&&request.headers().get("sec-websocket-key").and_then(|value|value.to_str().ok()).and_then(|value|base64::engine::general_purpose::STANDARD.decode(value).ok()).is_some_and(|bytes|bytes.len()==16);
                let response=match create_response(&handshake) {Ok(response) if valid_key=>response,_=>{prepared.failed();return error(400,"invalid_request","The voice WebSocket handshake is invalid.");}};
                let upgraded=hyper::upgrade::on(&mut request);let shutdown=self.lifecycle.shutdown.clone();
                tokio::spawn(async move {
                    let upgraded=tokio::select!{result=upgraded=>match result{Ok(upgraded)=>upgraded,Err(_)=>{prepared.failed();return;}},_=shutdown.cancelled()=>{prepared.failed();return;}};
                    let config=WebSocketConfig::default().read_buffer_size(4096).write_buffer_size(0).max_write_buffer_size(256*1024+1024).max_message_size(Some(256*1024)).max_frame_size(Some(256*1024));
                    let mut socket=WebSocketStream::from_raw_socket(hyper_util::rt::TokioIo::new(upgraded),Role::Server,Some(config)).await;
                    let mut control=match prepared.attach(){Ok(control)=>control,Err(_)=>{let _=socket.close(None).await;return;}};
                    let cancelled=control.cancellation();
                    loop {
                        tokio::select! {
                            _=shutdown.cancelled()=>break,
                            _=cancelled.cancelled()=>break,
                            outgoing=control.recv()=>{
                                let Some(outgoing)=outgoing else {break;};
                                let (message,close)=match outgoing {LiveControlFrame::Message(text)=>(Message::Text(text.into()),false),LiveControlFrame::Close {code,reason}=>(Message::Close(Some(CloseFrame {code:code.into(),reason:reason.into()})),true)};
                                let written=tokio::select!{result=socket.send(message)=>result.is_ok(),_=shutdown.cancelled()=>false,_=cancelled.cancelled()=>false};
                                if !written||close{break;}
                            },
                            incoming=socket.next()=>match incoming {
                                Some(Ok(Message::Text(text)))=>{if control.message(&text).is_err(){break;}},
                                Some(Ok(Message::Binary(_)))=>{let _=control.message("");break;},
                                Some(Ok(Message::Close(_)))|None=>break,
                                Some(Err(_))=>{let _=control.message("");break;},
                                Some(Ok(Message::Ping(_)|Message::Pong(_)|Message::Frame(_)))=>{},
                            }
                        }
                    }
                    control.closed();
                    let _=tokio::time::timeout(Duration::from_secs(1),socket.close(Some(CloseFrame {code:1000.into(),reason:"Voice has ended.".into()}))).await;
                });
                let (parts,())=response.into_parts();Response::from_parts(parts,Full::new(Bytes::new()).map_err(|never|match never{}).boxed_unsync())
            },
            _=>error(404,"not_found","The requested voice endpoint does not exist."),
        }
    }
}