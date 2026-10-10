use super::RemoteConnectionError;
use crate::product::tailcat::TailcatConnection;
use anyhow::{Result, Context as _};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::{Request, Response, HeaderMap, body::{Body, Frame, Incoming, SizeHint}, client::conn::http1::SendRequest};
use std::{collections::BTreeSet, pin::Pin, sync::{Arc, Mutex, Weak, atomic::{AtomicBool, Ordering}}, task::{Context, Poll}, time::{Duration, Instant}};
use tokio::sync::{Semaphore, OwnedSemaphorePermit, watch};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

pub type ProxyBody = UnsyncBoxBody<Bytes, anyhow::Error>;
pub struct RemoteProxyConnection {
    transport: Arc<TailcatConnection>, port: u16, closed: AtomicBool,
    stop: CancellationToken, slots: Arc<Semaphore>, free: Mutex<Vec<Idle>>, tasks: Mutex<tokio::task::JoinSet<()>>,
    closing: Mutex<Option<watch::Receiver<Option<Result<(), String>>>>>,
}
struct Idle { sender: SendRequest<ProxyBody>, stop: CancellationToken, timer: watch::Sender<Option<Instant>> }
struct Lease { owner: Weak<RemoteProxyConnection>, idle: Option<Idle>, _slot: OwnedSemaphorePermit, complete: bool }
struct StreamingBody { body: Incoming, lease: Option<Lease>, cancelled: Pin<Box<WaitForCancellationFutureOwned>>, caller_cancelled: Pin<Box<WaitForCancellationFutureOwned>> }
impl RemoteProxyConnection {
    pub fn new(transport: Arc<TailcatConnection>, port: u16) -> Arc<Self> { Arc::new(Self { transport, port, closed: AtomicBool::new(false), stop: CancellationToken::new(), slots: Arc::new(Semaphore::new(32)), free: Mutex::new(Vec::new()), tasks: Mutex::new(tokio::task::JoinSet::new()), closing: Mutex::new(None) }) }
    pub async fn health(self: &Arc<Self>, authorize: impl std::future::Future<Output = Result<String>>, cancel: CancellationToken) -> Result<serde_json::Value> {
        let check = async {
        let request = Request::builder().method("GET").uri("/v0/health").body(empty())?;
        let response = self.request(request, "/v0/health", authorize, cancel).await?;
        if response.status() != 200 { return Ok(serde_json::json!({"reachable":true,"authenticated":false,"ready":false,"error":if response.status()==401{"The remote rejected authentication."}else{"The remote health endpoint returned an unsuccessful response."}})); }
        let body = http_body_util::Limited::new(response.into_body(), 64 * 1024).collect().await.map_err(|_| unavailable())?.to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&body).map_err(|_| unavailable())?;
        anyhow::ensure!(crate::product::schemas::Schemas::new()?.valid("ownerHealthResponse", &value)?, "The remote Happy Agent is unavailable.");
        Ok(serde_json::json!({"reachable":true,"authenticated":true,"ready":value["ready"],"protocol":value["version"]["protocol"]}))
        };
        tokio::time::timeout(Duration::from_secs(30), check).await.map_err(|_| RemoteConnectionError::new(504, "remote_timeout", "The remote health check timed out."))?
    }
    pub async fn request(self: &Arc<Self>, mut request: Request<ProxyBody>, path: &str, authorize: impl std::future::Future<Output = Result<String>>, cancel: CancellationToken) -> Result<Response<ProxyBody>> {
        anyhow::ensure!(!self.closed.load(Ordering::Acquire), "The remote Happy Agent is unavailable.");
        let slot = self.slots.clone().try_acquire_owned().map_err(|_| RemoteConnectionError::new(503, "remote_busy", "The remote connection is busy."))?;
        let upgraded = request.method() == hyper::Method::CONNECT || request.headers().contains_key("upgrade");
        let upgrade_value = request.headers().get("upgrade").cloned();
        let local_upgrade = upgraded.then(|| hyper::upgrade::on(&mut request));
        let method = request.method().clone();
        let exchange = async {
            let token = authorize.await?;
            let mut lease = Lease { owner: Arc::downgrade(self), idle: Some(self.checkout().await?), _slot: slot, complete: false };
            *request.uri_mut() = path.parse().map_err(|_| RemoteConnectionError::new(400, "invalid_request", "The remote request path is invalid."))?;
            strip_hop_headers(request.headers_mut());
            request.headers_mut().insert("authorization", format!("Bearer {token}").parse().context("The remote authentication credential is invalid.")?);
            request.headers_mut().insert("host", hyper::header::HeaderValue::from_static("happy-agent.invalid"));
            if upgraded && method != hyper::Method::CONNECT { request.headers_mut().insert("connection", hyper::header::HeaderValue::from_static("upgrade")); request.headers_mut().insert("upgrade", upgrade_value.unwrap_or_else(|| hyper::header::HeaderValue::from_static("websocket"))); }
            let idle = lease.idle.as_mut().expect("the checked-out connection");
            idle.sender.ready().await.map_err(|_| unavailable())?;
            let mut response = idle.sender.send_request(request).await.map_err(|_| unavailable())?;
            let status = response.status();
            let tunnel = upgraded && (status == hyper::StatusCode::SWITCHING_PROTOCOLS || method == hyper::Method::CONNECT && status.is_success());
            let response_upgrade = response.headers().get("upgrade").cloned();
            strip_hop_headers(response.headers_mut());
            if tunnel {
                if status == hyper::StatusCode::SWITCHING_PROTOCOLS { response.headers_mut().insert("connection", hyper::header::HeaderValue::from_static("Upgrade")); response.headers_mut().insert("upgrade", response_upgrade.unwrap_or_else(|| hyper::header::HeaderValue::from_static("websocket"))); }
                let remote_upgrade = hyper::upgrade::on(&mut response); let local_upgrade = local_upgrade.expect("an upgraded local request"); let stop = self.stop.clone();
                let pipe_cancel = cancel.clone();
                self.spawn(async move {
                    let _lease = lease;
                    let pipes = async { let mut remote = hyper_util::rt::TokioIo::new(remote_upgrade.await?); let mut local = hyper_util::rt::TokioIo::new(local_upgrade.await?); tokio::io::copy_bidirectional(&mut local, &mut remote).await?; Ok::<_, anyhow::Error>(()) };
                    tokio::select! { biased; _ = stop.cancelled() => {}, _ = pipe_cancel.cancelled() => {}, _ = pipes => {} }
                })?;
                let (parts, _) = response.into_parts();
                return Ok(Response::from_parts(parts, empty()));
            }
            let (parts, body) = response.into_parts();
            let body = StreamingBody { body, lease: Some(lease), cancelled: Box::pin(self.stop.clone().cancelled_owned()), caller_cancelled: Box::pin(cancel.clone().cancelled_owned()) }.boxed_unsync();
            Ok(Response::from_parts(parts, body))
        };
        tokio::select! { biased; _ = self.stop.cancelled() => Err(unavailable().into()), _ = cancel.cancelled() => Err(unavailable().into()), result = tokio::time::timeout(Duration::from_secs(30), exchange) => result.map_err(|_| RemoteConnectionError::new(504,"remote_timeout","The remote connection timed out."))? }
    }
    async fn checkout(&self) -> Result<Idle> {
        loop {
            let idle = self.free.lock().unwrap_or_else(std::sync::PoisonError::into_inner).pop();
            let Some(idle) = idle else { break; };
            if idle.stop.is_cancelled() || idle.sender.is_closed() { idle.stop.cancel(); continue; }
            idle.timer.send_replace(None); return Ok(idle);
        }
        anyhow::ensure!(!self.closed.load(Ordering::Acquire), "The remote Happy Agent is unavailable.");
        let stream = self.transport.connect(self.port).await.map_err(|_| unavailable())?;
        let (sender, connection) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream)).await.map_err(|_| unavailable())?;
        let stop = CancellationToken::new(); let cancelled = stop.clone(); let root = self.stop.clone(); let (timer, receiver) = watch::channel(None);
        self.spawn(async move {
            tokio::select! { biased; _ = root.cancelled() => {}, _ = cancelled.cancelled() => {}, _ = idle_expiry(receiver) => {}, _ = connection.with_upgrades() => {} }
            cancelled.cancel();
        })?;
        Ok(Idle { sender, stop, timer })
    }
    fn spawn(&self, work: impl std::future::Future<Output = ()> + Send + 'static) -> Result<()> {
        let mut tasks = self.tasks.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.closed.load(Ordering::Acquire) { return Err(unavailable().into()); }
        while tasks.try_join_next().is_some() {} tasks.spawn(work); Ok(())
    }
    pub async fn close(self: &Arc<Self>) -> Result<()> {
        let mut completed = {
            let mut closing = self.closing.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            closing.get_or_insert_with(|| {
                self.closed.store(true, Ordering::Release); self.slots.close(); self.stop.cancel();
                for idle in self.free.lock().unwrap_or_else(std::sync::PoisonError::into_inner).drain(..) { idle.stop.cancel(); }
                let (completion, receiver) = watch::channel(None);
                let owner = self.clone();
                // Cleanup owns its lifetime. Dropping one caller cannot abandon
                // it or let another caller report completion prematurely.
                tokio::spawn(async move {
                    let result = owner.transport.close().await.map_err(|error| format!("{error:#}"));
                    let mut tasks = std::mem::take(&mut *owner.tasks.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
                    while tasks.join_next().await.is_some() {}
                    completion.send_replace(Some(result));
                });
                receiver
            }).clone()
        };
        loop {
            if let Some(result) = completed.borrow_and_update().clone() { return result.map_err(anyhow::Error::msg); }
            completed.changed().await.context("Remote connection cleanup could not be confirmed.")?;
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let Some(idle) = self.idle.take() else { return; };
        if self.complete && !idle.sender.is_closed() && !idle.stop.is_cancelled() {
            if let Some(owner) = self.owner.upgrade() {
                let mut free = owner.free.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if !owner.closed.load(Ordering::Acquire) && free.len() < 4 { idle.timer.send_replace(Some(Instant::now())); free.push(idle); return; }
            }
        }
        idle.stop.cancel();
    }
}
impl Body for StreamingBody {
    type Data = Bytes; type Error = anyhow::Error;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>>>> {
        if std::future::Future::poll(self.cancelled.as_mut(), cx).is_ready() || std::future::Future::poll(self.caller_cancelled.as_mut(), cx).is_ready() { self.lease.take(); return Poll::Ready(Some(Err(unavailable().into()))); }
        match Pin::new(&mut self.body).poll_frame(cx) {
            Poll::Ready(None) => { if let Some(lease) = self.lease.as_mut() { lease.complete = true; } self.lease.take(); Poll::Ready(None) }
            Poll::Ready(Some(Ok(frame))) => Poll::Ready(Some(Ok(frame))),
            Poll::Ready(Some(Err(_))) => { self.lease.take(); Poll::Ready(Some(Err(unavailable().into()))) }
            Poll::Pending => Poll::Pending,
        }
    }
    fn is_end_stream(&self) -> bool { self.body.is_end_stream() }
    fn size_hint(&self) -> SizeHint { self.body.size_hint() }
}
impl Drop for StreamingBody { fn drop(&mut self) { if self.body.is_end_stream() { if let Some(lease) = self.lease.as_mut() { lease.complete = true; } } } }
async fn idle_expiry(mut timer: watch::Receiver<Option<Instant>>) {
    loop { let at = *timer.borrow_and_update(); if let Some(at) = at { tokio::select! { _ = tokio::time::sleep_until((at + Duration::from_secs(30)).into()) => return, changed = timer.changed() => if changed.is_err() { return; } } } else if timer.changed().await.is_err() { return; } }
}
pub fn strip_hop_headers(headers: &mut HeaderMap) {
    let mut blocked: BTreeSet<String> = ["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade"].into_iter().map(str::to_owned).collect();
    for connection in headers.get_all("connection").iter().filter_map(|value| value.to_str().ok()) { blocked.extend(connection.split(',').map(|name| name.trim().to_ascii_lowercase())); }
    for name in blocked { headers.remove(name); }
}
pub fn empty() -> ProxyBody { Full::new(Bytes::new()).map_err(|never| match never {}).boxed_unsync() }
fn unavailable() -> RemoteConnectionError { RemoteConnectionError::new(503, "remote_unavailable", "The remote Happy Agent is unavailable.") }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_connection_header_contributes_its_private_hop_names() {
        let mut headers = HeaderMap::new();
        headers.append("connection", "keep-alive, X-First".parse().unwrap());
        headers.append("connection", "X-Second".parse().unwrap());
        headers.insert("x-first", "private first hop".parse().unwrap());
        headers.insert("x-second", "private second hop".parse().unwrap());
        headers.insert("cache-control", "private, max-age=60".parse().unwrap());
        headers.insert("x-happy-service-authorization", "opaque service credential".parse().unwrap());
        strip_hop_headers(&mut headers);
        assert!(!headers.contains_key("connection"));
        assert!(!headers.contains_key("x-first"));
        assert!(!headers.contains_key("x-second"));
        assert_eq!(headers["cache-control"], "private, max-age=60");
        assert_eq!(headers["x-happy-service-authorization"], "opaque service credential");
    }
}
#[cfg(all(test, unix))]
#[path = "proxy_tests.rs"]
mod lifecycle_tests;