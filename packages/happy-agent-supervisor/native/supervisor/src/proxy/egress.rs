//! The process outside the jail that owns policy, name resolution, and `connect`.
//!
//! It is forked before any sandbox exists — before the network namespace on Linux, before the
//! Seatbelt profile on macOS — and afterwards it holds exactly one descriptor: its end of the
//! socketpair the front-ends speak the frame protocol on. Nothing else crosses. The workload never
//! holds the link, so the only way out of the jail is a destination this process agreed to.
//!
//! It must not outlive the workload. The front-end process owns the other end of the link, so its
//! exit closes the link and ends the frame loop here; the supervisor also kills and reaps this
//! process once the workload is finished, which makes the normal path deterministic rather than
//! dependent on a descriptor closing at the right moment.

use crate::SupervisorResult;
use crate::proxy::hosts::HostPolicy;
use crate::proxy::locks::{guard, wait};
use crate::proxy::protocol::{
    FRAME_DATA, FRAME_END, FRAME_HEADER_BYTES, FRAME_OPEN, FRAME_OPENED, FRAME_REFUSED,
    FRAME_RESET, FRAME_WINDOW, HANDSHAKE_ACCEPTED, INITIAL_WINDOW_BYTES, MAGIC, MAX_CHUNK_BYTES,
    MAX_CONCURRENT_STREAMS, MAX_HOST_BYTES, MAX_MESSAGE_BYTES, MAX_PAYLOAD_BYTES, REFUSED_BLOCKED,
    REFUSED_UNREACHABLE, REFUSED_UNRESOLVABLE, decode_window, encode_frame,
};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::os::fd::FromRawFd;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// A destination that never answers must become a refusal rather than a stream the workload waits
/// on forever.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RELAY_BUFFER_BYTES: usize = 32 * 1024;

/// The egress process, and the end of its link the front-ends keep.
pub(crate) struct Egress {
    pub(crate) pid: libc::pid_t,
    pub(crate) link: File,
}

/// Forks the egress process while the caller is still outside every sandbox.
///
/// The fork happens while this process is single-threaded, so the child reaches its own serving
/// loop without a chance of waiting on a lock whose owner did not survive the fork.
pub(crate) fn start(allowed_hosts: &[String]) -> SupervisorResult<Egress> {
    start_with_policy(HostPolicy::new(allowed_hosts))
}

#[cfg(target_os = "linux")]
pub(crate) fn start_service(
    destinations: &[crate::service_policy::ServiceDestination],
) -> SupervisorResult<Egress> {
    start_with_policy(HostPolicy::for_service(destinations))
}

fn start_with_policy(hosts: HostPolicy) -> SupervisorResult<Egress> {
    let (egress_end, front_end) = link_pair()?;
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if child == 0 {
        drop(front_end);
        // This process holds the only route out of the jail, so it is the one worth reading. Linux
        // inherited the supervisor's non-dumpable flag through the fork; macOS gives a child fresh
        // process flags, so the deny has to be asked for again here. A failure leaves no proxy at
        // all rather than an unprotected one.
        if crate::hardening::deny_debugger_attach().is_err() {
            unsafe { libc::_exit(125) };
        }
        // A supervisor that dies without reaping must not leave a process holding an open route out
        // of the jail. macOS has no equivalent, where the link closing is what ends the loop.
        #[cfg(target_os = "linux")]
        unsafe {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0);
        }
        serve(egress_end, hosts);
        unsafe { libc::_exit(0) };
    }
    drop(egress_end);
    Ok(Egress {
        pid: child,
        link: front_end,
    })
}

/// Ends the egress process and reaps it, so it cannot outlive the workload.
///
/// Only the Linux supervisor calls this, because only there does the process that owns the workload
/// stay outside the boundary it established.
#[cfg(target_os = "linux")]
pub(crate) fn stop(pid: libc::pid_t) {
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
    loop {
        let mut status = 0;
        let result = unsafe { libc::waitpid(pid, &mut status, 0) };
        if result >= 0 {
            return;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return;
        }
    }
}

/// Ends the egress process from a caller that is not allowed to signal it.
///
/// On macOS the front-end process is inside the Seatbelt profile and the egress process, by design,
/// is not; a sandboxed process may not signal one outside its sandbox, and trying to would block on
/// a reap that never happens. Closing the link is what ends the frame loop there, and it is also the
/// thing that matters: with no link there is no route out of the jail, whatever the process does
/// next. The reap that follows is best effort, because a process whose parent is exiting anyway is
/// collected by the system.
#[cfg(target_os = "macos")]
pub(crate) fn close(link: std::os::fd::RawFd, pid: libc::pid_t) {
    unsafe {
        libc::shutdown(link, libc::SHUT_RDWR);
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let mut status = 0;
        if unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } != 0 {
            return;
        }
        if std::time::Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn link_pair() -> SupervisorResult<(File, File)> {
    // The link is inherited across `exec` unless it is closed on exec, and the workload must not be
    // able to speak the frame protocol itself or desynchronise it. Linux can say so in the call that
    // creates the pair; macOS has no such flag and needs the second step below. The two-step form is
    // only a window if another thread execs between them, which nothing here does today — but the
    // one-step form is the one that stays correct if that ever changes.
    #[cfg(target_os = "linux")]
    let socket_type = libc::SOCK_STREAM | libc::SOCK_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    let socket_type = libc::SOCK_STREAM;

    let mut descriptors = [-1, -1];
    if unsafe { libc::socketpair(libc::AF_UNIX, socket_type, 0, descriptors.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    #[cfg(not(target_os = "linux"))]
    for descriptor in descriptors {
        if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            let error = std::io::Error::last_os_error();
            for descriptor in descriptors {
                unsafe { libc::close(descriptor) };
            }
            return Err(std::io::Error::other(format!(
                "close the sandbox proxy link on exec: {error}"
            ))
            .into());
        }
    }
    Ok((unsafe { File::from_raw_fd(descriptors[0]) }, unsafe {
        File::from_raw_fd(descriptors[1])
    }))
}

fn serve(link: File, hosts: HostPolicy) {
    let session = Arc::new(Session {
        link: Link {
            file: link,
            write_lock: Mutex::new(()),
        },
        hosts,
        streams: Mutex::new(HashMap::new()),
    });
    if session.accept_handshake().is_err() {
        return;
    }
    let mut header = [0_u8; FRAME_HEADER_BYTES];
    let mut payload = vec![0_u8; MAX_PAYLOAD_BYTES];
    loop {
        if session.link.read_exact(&mut header).is_err() {
            break;
        }
        let kind = header[0];
        let id = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);
        let length = u32::from_be_bytes([header[5], header[6], header[7], header[8]]) as usize;
        if length > MAX_PAYLOAD_BYTES {
            break;
        }
        if session.link.read_exact(&mut payload[..length]).is_err() {
            break;
        }
        if !Session::apply_frame(&session, kind, id, &payload[..length]) {
            break;
        }
    }
    session.close_all();
}

struct Session {
    link: Link,
    hosts: HostPolicy,
    streams: Mutex<HashMap<u32, StreamEntry>>,
}

/// A stream is registered from the moment it is requested, because resolving and connecting happen
/// on their own thread. Serialising them onto the frame loop would let one slow name hold up every
/// other stream sharing the link.
enum StreamEntry {
    Pending,
    Open(Stream),
}

impl Session {
    fn accept_handshake(&self) -> std::io::Result<()> {
        let mut hello = [0_u8; MAGIC.len()];
        self.link.read_exact(&mut hello)?;
        if hello != MAGIC {
            return Err(std::io::Error::other(
                "the sandbox proxy link opened with an unknown protocol",
            ));
        }
        let mut reply = Vec::with_capacity(MAGIC.len() + 1);
        reply.extend_from_slice(&MAGIC);
        reply.push(HANDSHAKE_ACCEPTED);
        self.link.write_bytes(&reply)
    }

    /// Applies one frame, returning whether the link is still trustworthy.
    fn apply_frame(session: &Arc<Self>, kind: u8, id: u32, payload: &[u8]) -> bool {
        match kind {
            FRAME_OPEN => Self::open(session, id, payload),
            FRAME_DATA => {
                let streams = guard(&session.streams);
                if let Some(StreamEntry::Open(stream)) = streams.get(&id) {
                    let _ = stream.outbound.send(Outbound::Data(payload.to_vec()));
                }
                true
            }
            FRAME_END => {
                let streams = guard(&session.streams);
                if let Some(StreamEntry::Open(stream)) = streams.get(&id) {
                    let _ = stream.outbound.send(Outbound::End);
                }
                true
            }
            FRAME_RESET => {
                let entry = guard(&session.streams).remove(&id);
                if let Some(StreamEntry::Open(stream)) = entry {
                    stream.close();
                }
                true
            }
            FRAME_WINDOW => {
                let streams = guard(&session.streams);
                if let Some(StreamEntry::Open(stream)) = streams.get(&id) {
                    stream.credit.grant(decode_window(payload));
                }
                true
            }
            _ => false,
        }
    }

    fn open(session: &Arc<Self>, id: u32, payload: &[u8]) -> bool {
        let Some((host, port)) = decode_open(payload) else {
            return false;
        };
        {
            let mut streams = guard(&session.streams);
            if streams.contains_key(&id) {
                return false;
            }
            if streams.len() >= MAX_CONCURRENT_STREAMS {
                return session.refuse(
                    id,
                    REFUSED_UNREACHABLE,
                    "too many concurrent sandbox connections",
                );
            }
            streams.insert(id, StreamEntry::Pending);
        }
        if !session.hosts.permits_destination(&host, port) {
            guard(&session.streams).remove(&id);
            return session.refuse(
                id,
                REFUSED_BLOCKED,
                &format!("{host}:{port} is not in this command's allowed hosts"),
            );
        }
        let connecting = Arc::clone(session);
        let spawned = std::thread::Builder::new()
            .name("supervisor-egress-connect".to_string())
            .spawn(move || connecting.finish_open(id, &host, port));
        if spawned.is_err() {
            guard(&session.streams).remove(&id);
            return session.refuse(
                id,
                REFUSED_UNREACHABLE,
                "the sandbox proxy could not start this connection",
            );
        }
        true
    }

    fn finish_open(self: Arc<Self>, id: u32, host: &str, port: u16) {
        let socket = match connect(host, port, &self.hosts) {
            Ok(socket) => socket,
            Err((code, message)) => {
                let still_wanted = guard(&self.streams).remove(&id).is_some();
                if still_wanted {
                    self.refuse(id, code, &message);
                }
                return;
            }
        };
        let mut streams = guard(&self.streams);
        // The front-end gave up while the destination was being reached, so the connection it asked
        // for is closed rather than handed to a stream nobody is waiting on.
        if !matches!(streams.get(&id), Some(StreamEntry::Pending)) {
            let _ = socket.shutdown(Shutdown::Both);
            return;
        }
        if self.link.write_frame(FRAME_OPENED, id, &[]).is_err() {
            streams.remove(&id);
            let _ = socket.shutdown(Shutdown::Both);
            return;
        }
        match Stream::start(&self, id, socket) {
            Ok(stream) => {
                streams.insert(id, StreamEntry::Open(stream));
            }
            Err(_) => {
                streams.remove(&id);
                let _ = self.link.write_frame(FRAME_RESET, id, &[]);
            }
        }
    }

    fn refuse(&self, id: u32, code: u8, message: &str) -> bool {
        let mut payload = vec![code];
        let message = message.as_bytes();
        payload.extend_from_slice(&message[..message.len().min(MAX_MESSAGE_BYTES)]);
        self.link.write_frame(FRAME_REFUSED, id, &payload).is_ok()
    }

    fn close_all(&self) {
        let streams = std::mem::take(&mut *guard(&self.streams));
        for entry in streams.into_values() {
            if let StreamEntry::Open(stream) = entry {
                stream.close();
            }
        }
    }
}

struct Link {
    file: File,
    write_lock: Mutex<()>,
}

impl Link {
    fn read_exact(&self, buffer: &mut [u8]) -> std::io::Result<()> {
        (&self.file).read_exact(buffer)
    }

    fn write_bytes(&self, bytes: &[u8]) -> std::io::Result<()> {
        let _serialized = guard(&self.write_lock);
        (&self.file).write_all(bytes)
    }

    fn write_frame(&self, kind: u8, id: u32, payload: &[u8]) -> std::io::Result<()> {
        self.write_bytes(&encode_frame(kind, id, payload))
    }
}

enum Outbound {
    Data(Vec<u8>),
    End,
}

/// One destination connection, pumped by a thread in each direction.
struct Stream {
    outbound: Sender<Outbound>,
    socket: TcpStream,
    credit: Arc<Credit>,
}

impl Stream {
    fn start(session: &Arc<Session>, id: u32, socket: TcpStream) -> std::io::Result<Self> {
        let credit = Arc::new(Credit {
            state: Mutex::new(CreditState {
                available: INITIAL_WINDOW_BYTES,
                aborted: false,
            }),
            signal: Condvar::new(),
        });
        let to_destination = socket.try_clone()?;
        let from_destination = socket.try_clone()?;
        let (outbound, inbound) = channel();
        let uploading = Arc::clone(session);
        std::thread::Builder::new()
            .name("supervisor-egress-upload".to_string())
            .spawn(move || forward_to_destination(to_destination, &inbound, &uploading.link, id))?;
        let downloading = Arc::clone(session);
        let downloading_credit = Arc::clone(&credit);
        std::thread::Builder::new()
            .name("supervisor-egress-download".to_string())
            .spawn(move || {
                forward_to_link(from_destination, &downloading.link, id, &downloading_credit);
            })?;
        Ok(Self {
            outbound,
            socket,
            credit,
        })
    }

    fn close(&self) {
        self.credit.abort();
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

struct Credit {
    state: Mutex<CreditState>,
    signal: Condvar,
}

struct CreditState {
    available: u32,
    aborted: bool,
}

impl Credit {
    /// Waits for room to send, returning nothing once the stream is finished with.
    fn take(&self, wanted: usize) -> Option<usize> {
        let mut state = guard(&self.state);
        while state.available == 0 && !state.aborted {
            state = wait(&self.signal, state);
        }
        if state.aborted {
            return None;
        }
        let allowed = wanted.min(MAX_CHUNK_BYTES).min(state.available as usize);
        state.available -= allowed as u32;
        Some(allowed)
    }

    fn grant(&self, bytes: u32) {
        let mut state = guard(&self.state);
        state.available = state.available.saturating_add(bytes);
        self.signal.notify_all();
    }

    fn abort(&self) {
        let mut state = guard(&self.state);
        state.aborted = true;
        self.signal.notify_all();
    }
}

fn forward_to_destination(
    mut socket: TcpStream,
    inbound: &Receiver<Outbound>,
    link: &Link,
    id: u32,
) {
    while let Ok(message) = inbound.recv() {
        match message {
            Outbound::Data(bytes) => {
                if socket.write_all(&bytes).is_err() {
                    let _ = link.write_frame(FRAME_RESET, id, &[]);
                    let _ = socket.shutdown(Shutdown::Both);
                    return;
                }
                // Credit is returned only once the bytes have actually left for the destination,
                // which is what bounds this queue by the window the front-end was granted.
                if link
                    .write_frame(FRAME_WINDOW, id, &(bytes.len() as u32).to_be_bytes())
                    .is_err()
                {
                    return;
                }
            }
            Outbound::End => {
                let _ = socket.shutdown(Shutdown::Write);
            }
        }
    }
}

fn forward_to_link(mut socket: TcpStream, link: &Link, id: u32, credit: &Credit) {
    let mut buffer = [0_u8; RELAY_BUFFER_BYTES];
    loop {
        let read = match socket.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => {
                let _ = link.write_frame(FRAME_RESET, id, &[]);
                return;
            }
        };
        let mut sent = 0;
        while sent < read {
            let Some(allowed) = credit.take(read - sent) else {
                return;
            };
            if link
                .write_frame(FRAME_DATA, id, &buffer[sent..sent + allowed])
                .is_err()
            {
                return;
            }
            sent += allowed;
        }
    }
    let _ = link.write_frame(FRAME_END, id, &[]);
}

fn decode_open(payload: &[u8]) -> Option<(String, u16)> {
    if payload.len() < 4 {
        return None;
    }
    let port = u16::from_be_bytes([payload[0], payload[1]]);
    let length = usize::from(u16::from_be_bytes([payload[2], payload[3]]));
    if port == 0 || length == 0 || length > MAX_HOST_BYTES || payload.len() < 4 + length {
        return None;
    }
    let host = std::str::from_utf8(&payload[4..4 + length]).ok()?;
    Some((host.to_string(), port))
}

/// Resolves the destination once and connects to an address from that same answer.
///
/// Checking one resolution and connecting on the strength of another would leave exactly the gap
/// this check exists to close, so the addresses that are filtered here are the addresses that are
/// used.
fn connect(host: &str, port: u16, hosts: &HostPolicy) -> Result<TcpStream, (u8, String)> {
    let resolved = (host, port).to_socket_addrs().map_err(|_| {
        (
            REFUSED_UNRESOLVABLE,
            format!("{host} could not be resolved"),
        )
    })?;
    let mut permitted: Vec<SocketAddr> = Vec::new();
    let mut refused_an_address = false;
    for address in resolved {
        if hosts.permits_address(address.ip()) {
            permitted.push(address);
        } else {
            refused_an_address = true;
        }
    }
    if permitted.is_empty() {
        return Err(if refused_an_address {
            (
                REFUSED_BLOCKED,
                format!("{host} resolves to an address this command may not reach"),
            )
        } else {
            (
                REFUSED_UNRESOLVABLE,
                format!("{host} could not be resolved"),
            )
        });
    }
    for address in permitted {
        if let Ok(socket) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            let _ = socket.set_nodelay(true);
            return Ok(socket);
        }
    }
    Err((
        REFUSED_UNREACHABLE,
        format!("{host}:{port} could not be reached"),
    ))
}

#[cfg(test)]
mod tests {
    use super::decode_open;

    #[test]
    fn open_requests_that_do_not_name_a_destination_are_rejected() {
        let mut valid = vec![0x01, 0xbb, 0x00, 0x0b];
        valid.extend_from_slice(b"example.com");
        let (host, port) =
            decode_open(&valid).unwrap_or_else(|| panic!("a well-formed open should decode"));
        assert_eq!(host, "example.com");
        assert_eq!(port, 443);

        assert!(decode_open(&[]).is_none());
        assert!(
            decode_open(&[0x00, 0x00, 0x00, 0x01, b'a']).is_none(),
            "port zero"
        );
        assert!(
            decode_open(&[0x01, 0xbb, 0x00, 0x00]).is_none(),
            "empty host"
        );
        assert!(
            decode_open(&[0x01, 0xbb, 0x00, 0x05, b'a']).is_none(),
            "truncated host"
        );
        assert!(
            decode_open(&[0x01, 0xbb, 0x00, 0x01, 0xff]).is_none(),
            "invalid UTF-8"
        );
    }
}
