use anyhow::{Context as _, Result, bail};
use std::{pin::Pin, process::Stdio, sync::{Arc, atomic::{AtomicBool, Ordering}}, task::{Context, Poll}, time::Duration};
use tokio::{io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf}, net::TcpStream, process::Command, sync::{Mutex, Semaphore, OwnedSemaphorePermit, watch}};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

/// One remote owns one lazily started native SOCKS process. An exchange assigned
/// to a failed generation fails; only a later request may start a replacement.
pub struct TailcatConnection {
    executable: String,
    address: String,
    state: Mutex<Option<Arc<Generation>>>,
    closed: AtomicBool,
    sockets: Arc<Semaphore>,
}
struct Generation {
    port: u16,
    stop: CancellationToken,
    exited: watch::Receiver<bool>,
}
pub struct CarrierSocket {
    stream: TcpStream,
    cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
    _permit: OwnedSemaphorePermit,
}

impl TailcatConnection {
    pub fn new(executable: String, address: String) -> Arc<Self> {
        Arc::new(Self { executable, address, state: Mutex::new(None), closed: AtomicBool::new(false), sockets: Arc::new(Semaphore::new(32)) })
    }
    pub async fn connect(self: &Arc<Self>, port: u16) -> Result<CarrierSocket> {
        anyhow::ensure!(port != 0 && !self.closed.load(Ordering::Acquire), "The remote Tailcat transport is unavailable.");
        let permit = self.sockets.clone().try_acquire_owned().context("The remote Tailcat transport is busy.")?;
        let generation = self.generation().await?;
        let handshake = async {
            let mut stream = TcpStream::connect(("127.0.0.1", generation.port)).await?;
            stream.write_all(&[5, 1, 0]).await?;
            let mut greeting = [0; 2]; stream.read_exact(&mut greeting).await?;
            anyhow::ensure!(greeting == [5, 0], "The remote Tailcat transport is unavailable.");
            let host = b"server.tailcat";
            let mut query = vec![5, 1, 0, 3, host.len() as u8]; query.extend_from_slice(host); query.extend_from_slice(&port.to_be_bytes());
            stream.write_all(&query).await?;
            let mut reply = [0; 4]; stream.read_exact(&mut reply).await?;
            anyhow::ensure!(reply[..3] == [5, 0, 0], "The remote Tailcat transport is unavailable.");
            let size = match reply[3] { 1 => 4, 4 => 16, 3 => stream.read_u8().await? as usize, _ => bail!("The remote Tailcat transport is unavailable.") };
            let mut remainder = vec![0; size + 2]; stream.read_exact(&mut remainder).await?;
            Ok::<_, anyhow::Error>(stream)
        };
        let result = tokio::select! {
            biased;
            _ = generation.stop.cancelled() => Err(anyhow::anyhow!("The remote Tailcat transport is unavailable.")),
            result = tokio::time::timeout(Duration::from_secs(30), handshake) => result.context("The remote Tailcat transport is unavailable.").and_then(|result| result),
        };
        match result {
            Ok(stream) if !generation.stop.is_cancelled() && !self.closed.load(Ordering::Acquire) => Ok(CarrierSocket { stream, cancelled: Box::pin(generation.stop.clone().cancelled_owned()), _permit: permit }),
            _ => { self.reset(&generation).await?; bail!("The remote Tailcat transport is unavailable.") }
        }
    }
    async fn generation(&self) -> Result<Arc<Generation>> {
        let mut state = self.state.lock().await;
        anyhow::ensure!(!self.closed.load(Ordering::Acquire), "The remote Tailcat transport is unavailable.");
        if let Some(generation) = state.as_ref() {
            if !*generation.exited.borrow() && !generation.stop.is_cancelled() { return Ok(generation.clone()); }
            reap(generation).await?; *state = None;
        }
        let mut command = Command::new(&self.executable);
        command.args(["--key=new", "socks", "--listen=127.0.0.1:0", &self.address]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)] command.creation_flags(0x08000000);
        let mut child = command.spawn().context("The remote Tailcat transport is unavailable.")?;
        let stdout = child.stdout.take().context("The remote Tailcat transport is unavailable.")?;
        let stderr = child.stderr.take().context("The remote Tailcat transport is unavailable.")?;
        let stop = CancellationToken::new();
        let task_stop = stop.clone();
        let (ready, mut ready_rx) = watch::channel(None);
        let (exited, exited_rx) = watch::channel(false);
        tokio::spawn(async move {
            let mut output = Vec::new();
            let mut stdout = stdout; let mut stderr = stderr;
            let mut first = [0u8; 4096]; let mut second = [0u8; 4096];
            let mut stdout_open = true; let mut stderr_open = true;
            loop {
                tokio::select! {
                    biased;
                    _ = task_stop.cancelled() => { if stop_child(&mut child).await.is_err() { return; } break; }
                    _ = child.wait() => break,
                    bytes = stdout.read(&mut first), if stdout_open => match bytes { Ok(0) | Err(_) => stdout_open = false, Ok(size) => append_startup(&mut output, &first[..size], &ready) },
                    bytes = stderr.read(&mut second), if stderr_open => match bytes { Ok(0) | Err(_) => stderr_open = false, Ok(size) => append_startup(&mut output, &second[..size], &ready) },
                }
            }
            task_stop.cancel();
            exited.send_replace(true);
        });
        let starting = async {
            loop {
                if let Some(port) = *ready_rx.borrow_and_update() { return Ok(port); }
                tokio::select! { _ = stop.cancelled() => bail!("The remote Tailcat transport is unavailable."), result = ready_rx.changed() => { result.context("The remote Tailcat transport is unavailable.")?; } }
            }
        };
        let result = tokio::time::timeout(Duration::from_secs(30), starting).await;
        let port = match result { Ok(Ok(port)) if !stop.is_cancelled() => port, _ => { let failed = Generation { port: 0, stop, exited: exited_rx }; reap(&failed).await?; bail!("The remote Tailcat transport is unavailable.") } };
        let generation = Arc::new(Generation { port, stop, exited: exited_rx });
        *state = Some(generation.clone()); Ok(generation)
    }
    async fn reset(&self, generation: &Arc<Generation>) -> Result<()> {
        let mut state = self.state.lock().await;
        if state.as_ref().is_some_and(|current| Arc::ptr_eq(current, generation)) { reap(generation).await?; *state = None; }
        Ok(())
    }
    pub async fn close(&self) -> Result<()> {
        self.closed.store(true, Ordering::Release); self.sockets.close();
        let mut state = self.state.lock().await;
        if let Some(generation) = state.as_ref() { reap(generation).await?; }
        *state = None; Ok(())
    }
}

fn append_startup(output: &mut Vec<u8>, bytes: &[u8], ready: &watch::Sender<Option<u16>>) {
    output.extend_from_slice(bytes);
    if output.len() > 8192 { output.drain(..output.len() - 8192); }
    if ready.borrow().is_some() { return; }
    let text = String::from_utf8_lossy(output);
    let marker = "SOCKS running at socks5h://127.0.0.1:";
    if let Some(after) = text.find(marker).map(|start| &text[start + marker.len()..]) {
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if let Ok(port) = digits.parse::<u16>() { if port != 0 { ready.send_replace(Some(port)); } }
    }
}
async fn reap(generation: &Generation) -> Result<()> {
    generation.stop.cancel();
    let mut exited = generation.exited.clone();
    tokio::time::timeout(Duration::from_secs(5), async { while !*exited.borrow_and_update() { exited.changed().await.context("Tailcat process cleanup could not be confirmed.")?; } Ok::<_, anyhow::Error>(()) }).await.context("Tailcat process cleanup could not be confirmed.")??;
    Ok(())
}
pub(super) async fn stop_child(child: &mut tokio::process::Child) -> Result<()> {
    if child.try_wait()?.is_some() { return Ok(()); }
    #[cfg(unix)] if let Some(pid) = child.id() { unsafe { libc::kill(pid as i32, libc::SIGTERM); } }
    #[cfg(windows)] child.start_kill()?;
    if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() { child.start_kill()?; tokio::time::timeout(Duration::from_secs(3), child.wait()).await.context("Tailcat process cleanup could not be confirmed.")??; }
    Ok(())
}
fn cancelled(cx: &mut Context<'_>, cancellation: &mut Pin<Box<WaitForCancellationFutureOwned>>) -> bool { std::future::Future::poll(cancellation.as_mut(), cx).is_ready() }
fn unavailable() -> std::io::Error { std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "The remote Tailcat transport is unavailable.") }
impl AsyncRead for CarrierSocket {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buffer: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> { if cancelled(cx, &mut self.cancelled) { return Poll::Ready(Err(unavailable())); } Pin::new(&mut self.stream).poll_read(cx, buffer) }
}
impl AsyncWrite for CarrierSocket {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buffer: &[u8]) -> Poll<std::io::Result<usize>> { if cancelled(cx, &mut self.cancelled) { return Poll::Ready(Err(unavailable())); } Pin::new(&mut self.stream).poll_write(cx, buffer) }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> { if cancelled(cx, &mut self.cancelled) { return Poll::Ready(Err(unavailable())); } Pin::new(&mut self.stream).poll_flush(cx) }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> { Pin::new(&mut self.stream).poll_shutdown(cx) }
}