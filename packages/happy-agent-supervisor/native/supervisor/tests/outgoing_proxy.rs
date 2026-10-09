//! End-to-end behaviour of the outgoing proxy, with nothing outside the supervisor taking part.
//!
//! The test starts an origin server and then runs the real supervisor, which forks its own egress
//! process outside the jail, binds its own front-ends inside it, and enforces the command's host
//! list itself. The workload only ever sees loopback proxy endpoints in its environment.
//!
//! `127.0.0.1` appears in the allowed hosts on purpose: it is the one case where an address inside
//! the machine may be reached, because the policy named that literal itself. The `localhost` cases
//! are the opposite, and are what proves a name the policy allows cannot be pointed inward.

use serde_json::json;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::os::fd::RawFd;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Output, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const SUPERVISOR: &str = env!("CARGO_BIN_EXE_happy-agent");
const DENIED_HOST: &str = "denied.invalid";
const RUN_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------------------------
// The origin the egress process connects to on the workload's behalf.
// ---------------------------------------------------------------------------------------------

struct Origin {
    address: SocketAddr,
    connections: Arc<AtomicU64>,
}

fn start_origin() -> Origin {
    let listener = TcpListener::bind("127.0.0.1:0")
        .unwrap_or_else(|error| panic!("bind origin listener: {error}"));
    let address = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("origin address: {error}"));
    let connections = Arc::new(AtomicU64::new(0));
    let counted = Arc::clone(&connections);
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(mut connection) = connection else {
                return;
            };
            counted.fetch_add(1, Ordering::SeqCst);
            std::thread::spawn(move || {
                // The origin answers one request and echoes anything else, which covers both the
                // forwarded plaintext path and the opaque tunnel paths.
                let mut first = [0_u8; 4];
                if connection.read_exact(&mut first).is_err() {
                    return;
                }
                if &first == b"GET " {
                    let mut discard = [0_u8; 4096];
                    let _ = connection.read(&mut discard);
                    let _ = connection.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\norigin-ok",
                    );
                    let _ = connection.shutdown(Shutdown::Write);
                    return;
                }
                let _ = connection.write_all(&first);
                let mut buffer = [0_u8; 32 * 1024];
                loop {
                    match connection.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            if connection.write_all(&buffer[..read]).is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = connection.shutdown(Shutdown::Write);
            });
        }
    });
    Origin {
        address,
        connections,
    }
}

// ---------------------------------------------------------------------------------------------
// Running the supervisor.
// ---------------------------------------------------------------------------------------------

struct ProxiedRun {
    output: Output,
    origin_connections: u64,
}

fn run_workload(operation: &str, allowed_hosts: &[&str], front_ends: &[&str]) -> ProxiedRun {
    let workspace =
        tempfile::tempdir().unwrap_or_else(|error| panic!("temporary workspace: {error}"));
    let origin = start_origin();
    let output = supervise(
        &workspace,
        allowed_hosts,
        front_ends,
        operation,
        &origin.address.to_string(),
    );
    ProxiedRun {
        output,
        origin_connections: origin.connections.load(Ordering::SeqCst),
    }
}

fn supervise(
    workspace: &TempDir,
    allowed_hosts: &[&str],
    front_ends: &[&str],
    operation: &str,
    origin: &str,
) -> Output {
    let policy_path = workspace.path().join("policy.json");
    std::fs::write(
        &policy_path,
        serde_json::to_vec(&json!({
            "mode": "workspace_write",
            "network": {
                "egress": true,
                "allowedHosts": allowed_hosts,
                "localBinding": false,
                "outgoingProxy": {"frontEnds": front_ends}
            }
        }))
        .unwrap_or_else(|error| panic!("serialize policy: {error}")),
    )
    .unwrap_or_else(|error| panic!("write policy: {error}"));

    let mut command = Command::new(SUPERVISOR);
    command.arg("supervisor");
    command
        .current_dir(workspace.path())
        .arg("--policy-file")
        .arg(&policy_path)
        .arg("--")
        .arg(std::env::current_exe().unwrap_or_else(|error| panic!("current test binary: {error}")))
        .args(["--exact", "proxy_workload_process", "--nocapture"])
        .env("SUPERVISOR_TEST_PROXY_WORKLOAD", operation)
        .env("SUPERVISOR_TEST_ORIGIN", origin)
        .stdin(Stdio::null());
    run_bounded(command)
}

/// Runs the supervisor with a deadline.
///
/// A workload can fail to start at all — a refused nested sandbox, a rejected policy, a front-end
/// that never answers — and an unbounded wait would turn that into a hang instead of a failure.
fn run_bounded(mut command: Command) -> Output {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|error| panic!("run supervisor: {error}"));
    let stdout = child
        .stdout
        .take()
        .unwrap_or_else(|| panic!("supervisor stdout is missing"));
    let stderr = child
        .stderr
        .take()
        .unwrap_or_else(|| panic!("supervisor stderr is missing"));
    let stdout = std::thread::spawn(move || read_to_end(stdout));
    let stderr = std::thread::spawn(move || read_to_end(stderr));

    let deadline = Instant::now() + RUN_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => panic!("wait for supervisor: {error}"),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the supervised command did not finish within {RUN_TIMEOUT:?}");
        }
        std::thread::sleep(Duration::from_millis(10));
    };

    Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    }
}

fn read_to_end(mut source: impl Read) -> Vec<u8> {
    let mut buffer = Vec::new();
    let _ = source.read_to_end(&mut buffer);
    buffer
}

fn assert_succeeded(run: &ProxiedRun) -> String {
    let stdout = String::from_utf8_lossy(&run.output.stdout).into_owned();
    assert!(
        run.output.status.success(),
        "stdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&run.output.stderr)
    );
    stdout
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[test]
fn an_allowed_host_is_reachable_through_the_http_front_end() {
    let run = run_workload("http_forward", &["127.0.0.1"], &["http", "socks5"]);
    let stdout = assert_succeeded(&run);

    assert!(
        stdout.contains("http-forward=origin-ok"),
        "stdout:\n{stdout}"
    );
    assert_eq!(run.origin_connections, 1);
}

#[test]
fn an_allowed_host_is_reachable_through_connect_and_socks() {
    let run = run_workload("tunnels", &["127.0.0.1"], &["http", "socks5"]);
    let stdout = assert_succeeded(&run);

    assert!(
        stdout.contains("connect-tunnel=tunnelled"),
        "stdout:\n{stdout}"
    );
    assert!(
        stdout.contains("socks-tunnel=tunnelled"),
        "stdout:\n{stdout}"
    );
    assert_eq!(run.origin_connections, 2);
}

#[test]
fn a_denied_host_is_refused_in_each_front_end_vocabulary() {
    let run = run_workload("denied", &["127.0.0.1"], &["http", "socks5"]);
    let stdout = assert_succeeded(&run);

    assert!(stdout.contains("connect-denied=403"), "stdout:\n{stdout}");
    assert!(stdout.contains("forward-denied=403"), "stdout:\n{stdout}");
    assert!(stdout.contains("socks-denied=2"), "stdout:\n{stdout}");
    assert_eq!(run.origin_connections, 0);
}

#[test]
fn an_allowed_name_that_resolves_inward_is_refused() {
    let run = run_workload("private_address", &["localhost"], &["http", "socks5"]);
    let stdout = assert_succeeded(&run);

    assert!(stdout.contains("connect-private=403"), "stdout:\n{stdout}");
    assert!(stdout.contains("socks-private=2"), "stdout:\n{stdout}");
    assert_eq!(
        run.origin_connections, 0,
        "a name the policy allows must not reach an address it does not"
    );
}

#[test]
fn a_front_end_credential_that_is_missing_or_wrong_is_refused() {
    let run = run_workload("credentials", &["127.0.0.1"], &["http", "socks5"]);
    let stdout = assert_succeeded(&run);

    assert!(stdout.contains("no-credential=407"), "stdout:\n{stdout}");
    assert!(stdout.contains("wrong-credential=407"), "stdout:\n{stdout}");
    assert!(
        stdout.contains("socks-without-authentication=255"),
        "stdout:\n{stdout}"
    );
    assert!(
        stdout.contains("socks-wrong-credential=1"),
        "stdout:\n{stdout}"
    );
    assert_eq!(run.origin_connections, 0);
}

#[test]
fn the_workload_cannot_reach_the_destination_without_the_proxy() {
    // A descriptor in the workload is either one the supervisor leaked or one this process was
    // already holding when it spawned the supervisor, and only the two lists together say which.
    // The GitHub macOS runners hand the test process three `AF_SYSTEM` datagram sockets and two
    // pipes, none of which it opened; the workload sees exactly those, at exactly those numbers.
    // So the question this asks is what the supervisor added, and the answer must be nothing.
    // `--nocapture` shows what the environment supplied on a passing run too.
    let held_here = describe_inherited_descriptors();
    eprintln!(
        "descriptors held by the test process: {}",
        as_list(&held_here)
    );
    let run = run_workload("direct", &["127.0.0.1"], &["http", "socks5"]);
    let stdout = assert_succeeded(&run);

    assert!(
        stdout.contains("direct-connect=refused"),
        "stdout:\n{stdout}"
    );
    let added_by_the_supervisor: Vec<&str> = inherited_descriptors(&stdout)
        .into_iter()
        .filter(|description| !held_here.iter().any(|held| held == description))
        .collect();
    assert!(
        added_by_the_supervisor.is_empty(),
        "the supervisor gave the workload descriptors it has no use for: {}\n\nthe test process was already holding: {}\n\n\
         Nothing the supervisor creates should be among them: the link to the egress process is a\n\
         close-on-exec socketpair, the front-ends are std `TcpListener`s, and the status pipe is\n\
         `pipe2(O_CLOEXEC)`. Fix it where the descriptor is created, in the way Codex clears and\n\
         relocates the single descriptor it means to pass on.",
        as_list(&added_by_the_supervisor),
        as_list(&held_here)
    );
    assert_eq!(run.origin_connections, 0);
}

/// The proxy adds a process on each side of the workload, and neither may stand between the
/// workload's own status and the shell that ran the supervisor.
#[test]
fn the_workload_status_still_reaches_the_caller_beside_the_proxy() {
    let exited = run_workload("exit_37", &["127.0.0.1"], &["http", "socks5"]);
    assert_eq!(
        exited.output.status.code(),
        Some(37),
        "stderr:\n{}",
        String::from_utf8_lossy(&exited.output.stderr)
    );

    let signalled = run_workload("terminate", &["127.0.0.1"], &["http", "socks5"]);
    assert_eq!(
        signalled.output.status.code(),
        None,
        "stderr:\n{}",
        String::from_utf8_lossy(&signalled.output.stderr)
    );
    assert_eq!(
        signalled.output.status.signal(),
        Some(libc::SIGTERM),
        "stderr:\n{}",
        String::from_utf8_lossy(&signalled.output.stderr)
    );
}

#[test]
fn a_transfer_larger_than_one_window_completes_in_both_directions() {
    let run = run_workload("large_transfer", &["127.0.0.1"], &["socks5"]);
    let stdout = assert_succeeded(&run);

    assert!(
        stdout.contains("large-transfer=1048576"),
        "stdout:\n{stdout}"
    );
}

#[test]
fn only_the_requested_front_ends_are_offered() {
    let run = run_workload("front_ends", &["127.0.0.1"], &["socks5"]);
    let stdout = assert_succeeded(&run);

    assert!(stdout.contains("http-proxy=unset"), "stdout:\n{stdout}");
    assert!(stdout.contains("all-proxy=socks5h"), "stdout:\n{stdout}");
    assert!(
        stdout.contains("all-proxy-credentials=present"),
        "stdout:\n{stdout}"
    );
    assert!(stdout.contains("no-proxy=empty"), "stdout:\n{stdout}");
}

// ---------------------------------------------------------------------------------------------
// The workload, which only ever sees loopback proxy endpoints in its environment.
// ---------------------------------------------------------------------------------------------

#[test]
fn proxy_workload_process() {
    let Ok(operation) = std::env::var("SUPERVISOR_TEST_PROXY_WORKLOAD") else {
        return;
    };
    let origin = std::env::var("SUPERVISOR_TEST_ORIGIN")
        .unwrap_or_else(|error| panic!("origin address: {error}"));
    let origin_port = origin
        .rsplit(':')
        .next()
        .unwrap_or_default()
        .parse::<u16>()
        .unwrap_or_else(|error| panic!("origin port: {error}"));
    match operation.as_str() {
        "http_forward" => {
            let response = http_proxy_request(&format!("http://{origin}/probe"), &origin);
            println!(
                "http-forward={}",
                response.rsplit("\r\n\r\n").next().unwrap_or_default()
            );
        }
        "tunnels" => {
            let mut connect = open_tunnel("127.0.0.1", origin_port);
            println!("connect-tunnel={}", echo_through(&mut connect));

            let mut socks = socks_connect("127.0.0.1", origin_port);
            println!("socks-tunnel={}", echo_through(&mut socks));
        }
        "denied" => {
            println!("connect-denied={}", connect_status(DENIED_HOST, 443));

            let forwarded = http_proxy_request(&format!("http://{DENIED_HOST}/probe"), DENIED_HOST);
            println!(
                "forward-denied={}",
                status_code(forwarded.lines().next().unwrap_or_default())
            );

            println!("socks-denied={}", socks_reply(DENIED_HOST, 443));
        }
        "private_address" => {
            println!(
                "connect-private={}",
                connect_status("localhost", origin_port)
            );
            println!("socks-private={}", socks_reply("localhost", origin_port));
        }
        "credentials" => {
            let mut client = connect_to(proxy(HTTP_PROXY).address);
            write_all(
                &mut client,
                format!("CONNECT 127.0.0.1:{origin_port} HTTP/1.1\r\n\r\n").as_bytes(),
            );
            println!(
                "no-credential={}",
                status_code(&read_head_line(&mut client))
            );

            let wrong = proxy(HTTP_PROXY);
            let mut client = connect_to(wrong.address.clone());
            write_all(
                &mut client,
                format!(
                    "CONNECT 127.0.0.1:{origin_port} HTTP/1.1\r\nProxy-Authorization: Basic {}\r\n\r\n",
                    base64(format!("{}:not-the-secret", wrong.user).as_bytes())
                )
                .as_bytes(),
            );
            println!(
                "wrong-credential={}",
                status_code(&read_head_line(&mut client))
            );

            let mut socks = connect_to(proxy(ALL_PROXY).address);
            write_all(&mut socks, &[5, 1, 0]);
            let mut greeting = [0_u8; 2];
            read_exact(&mut socks, &mut greeting);
            println!("socks-without-authentication={}", greeting[1]);

            let credential = proxy(ALL_PROXY);
            let mut socks = connect_to(credential.address.clone());
            write_all(&mut socks, &[5, 1, 2]);
            let mut greeting = [0_u8; 2];
            read_exact(&mut socks, &mut greeting);
            assert_eq!(
                greeting,
                [5, 2],
                "the SOCKS front-end must demand a credential"
            );
            let mut authentication = vec![1, credential.user.len() as u8];
            authentication.extend_from_slice(credential.user.as_bytes());
            authentication.push(b"not-the-secret".len() as u8);
            authentication.extend_from_slice(b"not-the-secret");
            write_all(&mut socks, &authentication);
            let mut result = [0_u8; 2];
            read_exact(&mut socks, &mut result);
            println!("socks-wrong-credential={}", result[1]);
        }
        "direct" => {
            // Reported before anything here opens a descriptor of its own, so the list is exactly
            // what survived `execve`.
            for description in describe_inherited_descriptors() {
                println!("inherited-descriptor={description}");
            }
            println!(
                "direct-connect={}",
                match TcpStream::connect(&origin) {
                    Ok(_) => "reached",
                    Err(_) => "refused",
                }
            );
        }
        "large_transfer" => {
            let mut socks = socks_connect("127.0.0.1", origin_port);
            let payload = vec![b'x'; 1024 * 1024];
            let mut sender = socks
                .try_clone()
                .unwrap_or_else(|error| panic!("clone tunnel: {error}"));
            std::thread::spawn(move || {
                let _ = sender.write_all(&payload);
                let _ = sender.shutdown(Shutdown::Write);
            });
            let mut echoed = Vec::new();
            let mut buffer = [0_u8; 32 * 1024];
            while echoed.len() < 1024 * 1024 {
                match socks.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => echoed.extend_from_slice(&buffer[..read]),
                }
            }
            println!("large-transfer={}", echoed.len());
        }
        "exit_37" => {
            std::process::exit(37);
        }
        "terminate" => {
            unsafe { libc::raise(libc::SIGTERM) };
        }
        "front_ends" => {
            println!(
                "http-proxy={}",
                match std::env::var("HTTP_PROXY") {
                    Ok(value) => value,
                    Err(_) => "unset".to_string(),
                }
            );
            let all_proxy = std::env::var("ALL_PROXY").unwrap_or_default();
            println!(
                "all-proxy={}",
                all_proxy.split("://").next().unwrap_or_default()
            );
            println!(
                "all-proxy-credentials={}",
                if all_proxy.contains('@') {
                    "present"
                } else {
                    "absent"
                }
            );
            println!(
                "no-proxy={}",
                if std::env::var("NO_PROXY").unwrap_or_default().is_empty() {
                    "empty"
                } else {
                    "set"
                }
            );
        }
        other => panic!("unknown proxy workload operation: {other}"),
    }
}

const HTTP_PROXY: &str = "HTTP_PROXY";
const ALL_PROXY: &str = "ALL_PROXY";

/// One front-end address and the credential the supervisor delivered with it.
struct ProxyEndpoint {
    address: String,
    user: String,
    secret: String,
}

fn proxy(variable: &str) -> ProxyEndpoint {
    let url = std::env::var(variable).unwrap_or_else(|error| panic!("{variable}: {error}"));
    let rest = url
        .split("://")
        .nth(1)
        .unwrap_or_default()
        .trim_end_matches('/');
    let (user_information, address) = rest
        .rsplit_once('@')
        .unwrap_or_else(|| panic!("{variable} must carry the proxy credential: {url}"));
    let (user, secret) = user_information
        .split_once(':')
        .unwrap_or_else(|| panic!("{variable} must carry a user and a secret: {url}"));
    ProxyEndpoint {
        address: address.to_string(),
        user: user.to_string(),
        secret: secret.to_string(),
    }
}

fn connect_to(endpoint: String) -> TcpStream {
    TcpStream::connect(&endpoint)
        .unwrap_or_else(|error| panic!("connect to the front-end {endpoint}: {error}"))
}

fn authorization(endpoint: &ProxyEndpoint) -> String {
    base64(format!("{}:{}", endpoint.user, endpoint.secret).as_bytes())
}

fn http_proxy_request(url: &str, host: &str) -> String {
    let endpoint = proxy(HTTP_PROXY);
    let mut client = connect_to(endpoint.address.clone());
    write_all(
        &mut client,
        format!(
            "GET {url} HTTP/1.1\r\nHost: {host}\r\nProxy-Authorization: Basic {}\r\n\r\n",
            authorization(&endpoint)
        )
        .as_bytes(),
    );
    let mut response = String::new();
    let _ = client.read_to_string(&mut response);
    response
}

/// Opens a `CONNECT` tunnel and consumes the response head, so only tunnelled bytes remain.
fn open_tunnel(host: &str, port: u16) -> TcpStream {
    let endpoint = proxy(HTTP_PROXY);
    let mut client = connect_to(endpoint.address.clone());
    write_all(
        &mut client,
        format!(
            "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Authorization: Basic {}\r\n\r\n",
            authorization(&endpoint)
        )
        .as_bytes(),
    );
    let status = read_head_line(&mut client);
    assert!(status.starts_with("HTTP/1.1 200"), "CONNECT said: {status}");
    while !read_head_line(&mut client).is_empty() {}
    client
}

fn connect_status(host: &str, port: u16) -> String {
    let endpoint = proxy(HTTP_PROXY);
    let mut client = connect_to(endpoint.address.clone());
    write_all(
        &mut client,
        format!(
            "CONNECT {host}:{port} HTTP/1.1\r\nProxy-Authorization: Basic {}\r\n\r\n",
            authorization(&endpoint)
        )
        .as_bytes(),
    );
    status_code(&read_head_line(&mut client))
}

fn socks_greet(host: &str, port: u16) -> (TcpStream, [u8; 10]) {
    let endpoint = proxy(ALL_PROXY);
    let mut socks = connect_to(endpoint.address.clone());
    write_all(&mut socks, &[5, 1, 2]);
    let mut greeting = [0_u8; 2];
    read_exact(&mut socks, &mut greeting);
    assert_eq!(
        greeting,
        [5, 2],
        "the SOCKS front-end must demand a credential"
    );
    let mut authentication = vec![1, endpoint.user.len() as u8];
    authentication.extend_from_slice(endpoint.user.as_bytes());
    authentication.push(endpoint.secret.len() as u8);
    authentication.extend_from_slice(endpoint.secret.as_bytes());
    write_all(&mut socks, &authentication);
    let mut accepted = [0_u8; 2];
    read_exact(&mut socks, &mut accepted);
    assert_eq!(accepted, [1, 0], "the SOCKS credential was refused");

    let mut request = vec![5, 1, 0, 3, host.len() as u8];
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    write_all(&mut socks, &request);
    let mut reply = [0_u8; 10];
    read_exact(&mut socks, &mut reply);
    (socks, reply)
}

fn socks_connect(host: &str, port: u16) -> TcpStream {
    let (socks, reply) = socks_greet(host, port);
    assert_eq!(reply[1], 0, "SOCKS refused an allowed host: {}", reply[1]);
    socks
}

fn socks_reply(host: &str, port: u16) -> u8 {
    socks_greet(host, port).1[1]
}

fn echo_through(stream: &mut TcpStream) -> String {
    write_all(stream, b"tunnelled");
    let mut echoed = [0_u8; 9];
    read_exact(stream, &mut echoed);
    String::from_utf8_lossy(&echoed).into_owned()
}

// ---------------------------------------------------------------------------------------------
// Describing descriptors, which both sides of the supervisor do.
// ---------------------------------------------------------------------------------------------

/// Describes every descriptor above standard error: its number, its kind, whether it would survive
/// `execve`, and for a socket its domain, its type and both of its addresses.
///
/// This counted rather than described once, and the count was useless the first time it mattered.
/// CI reported one inherited socket where both development machines reported none, and a `1` cannot
/// tell the supervisor's own link to its egress process — an unnamed `AF_UNIX` stream socketpair,
/// and a way around the front-end credential if it ever escaped — from a socket the environment
/// left open in whatever ran the test. Those two call for opposite fixes: the first is a descriptor
/// to correct where it is created, the second means this assertion is over-broad. The report names
/// which, so the next person does not have to find this out twice.
fn describe_inherited_descriptors() -> Vec<String> {
    let mut described = Vec::new();
    for descriptor in 3..=highest_possible_descriptor() {
        let mut status = unsafe { std::mem::zeroed::<libc::stat>() };
        if unsafe { libc::fstat(descriptor, &mut status) } != 0 {
            continue;
        }
        let kind = match status.st_mode & libc::S_IFMT {
            libc::S_IFSOCK => "socket",
            libc::S_IFIFO => "pipe",
            libc::S_IFREG => "file",
            libc::S_IFDIR => "directory",
            libc::S_IFCHR => "character device",
            libc::S_IFBLK => "block device",
            libc::S_IFLNK => "symbolic link",
            _ => "descriptor of an unrecognised kind",
        };
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        let across_exec = if flags >= 0 && (flags & libc::FD_CLOEXEC) != 0 {
            "closed on exec"
        } else {
            "kept across exec"
        };
        let mut description = format!("fd {descriptor}: {kind}, {across_exec}");
        if (status.st_mode & libc::S_IFMT) == libc::S_IFSOCK {
            description.push_str(&format!(
                ", {} {}, local {}, peer {}",
                socket_domain(descriptor),
                socket_type(descriptor),
                socket_address(descriptor, End::Local),
                socket_address(descriptor, End::Peer)
            ));
        }
        described.push(description);
    }
    described
}

enum End {
    Local,
    Peer,
}

/// Names the socket's address family.
///
/// This is what separates the two explanations for an unexpected socket. The supervisor's own link
/// to its egress process is `AF_UNIX`; anything the environment hands down through cargo and
/// libtest is almost certainly `AF_INET` or `AF_INET6`. The family is read from the socket's own
/// address rather than `SO_DOMAIN`, which Linux has and macOS does not.
fn socket_domain(descriptor: RawFd) -> String {
    let mut storage = unsafe { std::mem::zeroed::<libc::sockaddr_storage>() };
    let mut length = address_length();
    let named = unsafe {
        libc::getsockname(
            descriptor,
            (&raw mut storage).cast::<libc::sockaddr>(),
            &mut length,
        )
    };
    if named != 0 {
        return "a socket of an unreadable family".to_string();
    }
    match libc::c_int::from(storage.ss_family) {
        libc::AF_UNIX => "AF_UNIX".to_string(),
        libc::AF_INET => "AF_INET".to_string(),
        libc::AF_INET6 => "AF_INET6".to_string(),
        family => format!("address family {family}"),
    }
}

fn socket_type(descriptor: RawFd) -> String {
    let mut kind: libc::c_int = 0;
    let mut length = match libc::socklen_t::try_from(std::mem::size_of::<libc::c_int>()) {
        Ok(length) => length,
        Err(_) => return "a socket of an unreadable type".to_string(),
    };
    let asked = unsafe {
        libc::getsockopt(
            descriptor,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&raw mut kind).cast::<libc::c_void>(),
            &mut length,
        )
    };
    if asked != 0 {
        return "a socket of an unreadable type".to_string();
    }
    match kind {
        libc::SOCK_STREAM => "stream".to_string(),
        libc::SOCK_DGRAM => "datagram".to_string(),
        libc::SOCK_SEQPACKET => "sequenced packet".to_string(),
        other => format!("socket type {other}"),
    }
}

fn address_length() -> libc::socklen_t {
    libc::socklen_t::try_from(std::mem::size_of::<libc::sockaddr_storage>())
        .unwrap_or(libc::socklen_t::MAX)
}

fn socket_address(descriptor: RawFd, end: End) -> String {
    let mut storage = unsafe { std::mem::zeroed::<libc::sockaddr_storage>() };
    let mut length = address_length();
    let address = (&raw mut storage).cast::<libc::sockaddr>();
    let named = unsafe {
        match end {
            End::Local => libc::getsockname(descriptor, address, &mut length),
            End::Peer => libc::getpeername(descriptor, address, &mut length),
        }
    };
    if named != 0 {
        return format!("none ({})", std::io::Error::last_os_error());
    }
    match libc::c_int::from(storage.ss_family) {
        libc::AF_INET => {
            let inet = unsafe { *(&raw const storage).cast::<libc::sockaddr_in>() };
            format!(
                "{}:{}",
                std::net::Ipv4Addr::from(u32::from_be(inet.sin_addr.s_addr)),
                u16::from_be(inet.sin_port)
            )
        }
        libc::AF_INET6 => {
            let inet = unsafe { *(&raw const storage).cast::<libc::sockaddr_in6>() };
            format!(
                "[{}]:{}",
                std::net::Ipv6Addr::from(inet.sin6_addr.s6_addr),
                u16::from_be(inet.sin6_port)
            )
        }
        libc::AF_UNIX => {
            let unix = unsafe { *(&raw const storage).cast::<libc::sockaddr_un>() };
            // `c_char` is signed on one of the tested architectures and unsigned on another, so the
            // path is read as bytes rather than compared element by element.
            let path = unsafe {
                std::slice::from_raw_parts(unix.sun_path.as_ptr().cast::<u8>(), unix.sun_path.len())
            };
            let path = path.split(|byte| *byte == 0).next().unwrap_or_default();
            if path.is_empty() {
                // Which is what a socketpair looks like, the supervisor's own link included.
                "unnamed".to_string()
            } else {
                String::from_utf8_lossy(path).into_owned()
            }
        }
        family => format!("an address in family {family}"),
    }
}

/// The highest descriptor this process could be holding.
///
/// A descriptor cannot be opened at or above `RLIMIT_NOFILE`, so the soft limit is the real bound.
/// The ceiling only keeps an enormous or unlimited one from turning the scan into millions of
/// futile calls.
fn highest_possible_descriptor() -> RawFd {
    let mut limit = unsafe { std::mem::zeroed::<libc::rlimit>() };
    let soft = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == 0 {
        limit.rlim_cur
    } else {
        0
    };
    RawFd::try_from(soft.saturating_sub(1))
        .unwrap_or(RawFd::MAX)
        .clamp(3, 65_535)
}

fn inherited_descriptors(stdout: &str) -> Vec<&str> {
    stdout
        .lines()
        .filter_map(|line| line.strip_prefix("inherited-descriptor="))
        .collect()
}

fn as_list(descriptions: &[impl AsRef<str>]) -> String {
    if descriptions.is_empty() {
        return "nothing".to_string();
    }
    descriptions
        .iter()
        .map(|description| format!("\n  {}", description.as_ref()))
        .collect()
}

fn read_head_line(stream: &mut TcpStream) -> String {
    let mut line = Vec::new();
    let mut byte = [0_u8; 1];
    while line.len() < 128 {
        match stream.read(&mut byte) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if byte[0] == b'\r' {
                    continue;
                }
                if byte[0] == b'\n' {
                    break;
                }
                line.push(byte[0]);
            }
        }
    }
    String::from_utf8_lossy(&line).into_owned()
}

fn status_code(status_line: &str) -> String {
    status_line
        .split(' ')
        .nth(1)
        .unwrap_or_default()
        .to_string()
}

fn write_all(stream: &mut TcpStream, bytes: &[u8]) {
    stream
        .write_all(bytes)
        .unwrap_or_else(|error| panic!("write to the front-end: {error}"));
}

fn read_exact(stream: &mut TcpStream, buffer: &mut [u8]) {
    stream
        .read_exact(buffer)
        .unwrap_or_else(|error| panic!("read from the front-end: {error}"));
}

/// The workload has to speak the client half of the credential itself, which is the whole point of
/// delivering it in the proxy address.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut text = String::new();
    for chunk in bytes.chunks(3) {
        let packed = (u32::from(chunk[0]) << 16)
            | (chunk.get(1).copied().map_or(0, u32::from) << 8)
            | chunk.get(2).copied().map_or(0, u32::from);
        text.push(char::from(ALPHABET[(packed >> 18) as usize & 0x3f]));
        text.push(char::from(ALPHABET[(packed >> 12) as usize & 0x3f]));
        text.push(if chunk.len() > 1 {
            char::from(ALPHABET[(packed >> 6) as usize & 0x3f])
        } else {
            '='
        });
        text.push(if chunk.len() > 2 {
            char::from(ALPHABET[packed as usize & 0x3f])
        } else {
            '='
        });
    }
    text
}
