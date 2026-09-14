#![cfg(target_os = "linux")]
use serde_json::json;
use std::fs;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::TempDir;

const SUPERVISOR: &str = env!("CARGO_BIN_EXE_happy-agent-supervisor");

struct Boundary {
    directory: TempDir,
    cgroup: PathBuf,
    policy: serde_json::Value,
}

impl Boundary {
    fn new(parent: &Path) -> Self {
        let directory = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let root = directory
            .path()
            .canonicalize()
            .unwrap_or_else(|error| panic!("{error}"));
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .unwrap_or_else(|error| panic!("{error}"));
        fs::create_dir(root.join("root")).unwrap_or_else(|error| panic!("{error}"));
        fs::set_permissions(root.join("root"), fs::Permissions::from_mode(0o700))
            .unwrap_or_else(|error| panic!("{error}"));
        fs::write(root.join("input"), "selected-input").unwrap_or_else(|error| panic!("{error}"));
        fs::write(root.join("private"), "not-selected").unwrap_or_else(|error| panic!("{error}"));
        let identity = format!(
            "{:032x}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_else(|error| panic!("{error}"))
                .as_nanos()
        );
        let policy = json!({
            "mode": "read_only", "network": { "egress": false, "localBinding": true },
            "service": {
                "root": root.join("root"), "cwd": ".",
                "inputs": [{ "source": root.join("input"), "destination": "input" }], "scratch": ["output"],
                "cgroupParent": parent, "executionId": identity,
                "controllerPid": std::process::id(),
                "bridgeSocket": root.join("bridge"), "bridgeToken": "a".repeat(64),
                "port": 4187, "memoryMiB": 128, "processes": 8, "outbound": []
            }
        });
        Self {
            directory,
            cgroup: parent.join(format!("happy-service-{identity}")),
            policy,
        }
    }

    fn run(&self, command: &str) -> Output {
        Command::new(SUPERVISOR)
            .arg("--policy-file")
            .arg(self.policy_file())
            .args(["--", "/bin/sh", "-c", command])
            .env("AMBIENT_SERVICE_SECRET", "must-not-be-inherited")
            .output()
            .unwrap_or_else(|error| panic!("{error}"))
    }

    fn policy_file(&self) -> PathBuf {
        use std::io::Write;
        let path = self.directory.path().join("policy.json");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .unwrap_or_else(|error| panic!("{error}"));
        file.write_all(self.policy.to_string().as_bytes())
            .unwrap_or_else(|error| panic!("{error}"));
        path
    }
}

fn delegated_parent() -> PathBuf {
    std::env::var_os("HAPPY_SERVICE_TEST_CGROUP_PARENT").map(PathBuf::from)
        .unwrap_or_else(|| panic!("service isolation tests require an administrator-delegated cgroup; see scripts/test-services.sh"))
}

#[test]
fn a_fake_resource_controller_never_starts_the_command() {
    let fake = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
    let boundary = Boundary::new(fake.path());
    let output = boundary.run("printf SHOULD_NOT_EXECUTE");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("cgroup"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let identity: serde_json::Value = serde_json::from_slice(
        &fs::read(boundary.directory.path().join("process.json"))
            .unwrap_or_else(|error| panic!("{error}")),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(identity["executionReady"], false);
    assert_eq!(identity["children"], json!([]));
    assert_eq!(
        fs::read(boundary.directory.path().join("started"))
            .unwrap_or_else(|error| panic!("{error}")),
        b""
    );
}

#[test]
fn service_credentials_cannot_use_process_arguments_or_public_files() {
    let fake = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
    let boundary = Boundary::new(fake.path());
    let arguments = Command::new(SUPERVISOR)
        .args([
            "--policy",
            &boundary.policy.to_string(),
            "--",
            "/bin/sh",
            "-c",
            "printf SHOULD_NOT_EXECUTE",
        ])
        .output()
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(!arguments.status.success());
    assert!(arguments.stdout.is_empty());
    assert!(String::from_utf8_lossy(&arguments.stderr).contains("private --policy-file"));
    let path = boundary.policy_file();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644))
        .unwrap_or_else(|error| panic!("{error}"));
    let public = Command::new(SUPERVISOR)
        .arg("--policy-file")
        .arg(path)
        .args(["--", "/bin/sh", "-c", "printf SHOULD_NOT_EXECUTE"])
        .output()
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(!public.status.success());
    assert!(public.stdout.is_empty());
    assert!(String::from_utf8_lossy(&public.stderr).contains("must be private"));
}

#[test]
fn an_orphaned_start_creates_no_runtime_resources() {
    let fake = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
    let mut boundary = Boundary::new(fake.path());
    boundary.policy["service"]["controllerPid"] = json!(2147483647);
    let output = boundary.run("printf SHOULD_NOT_EXECUTE");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!boundary.directory.path().join("process.json").exists());
    assert!(!boundary.directory.path().join("bridge").exists());
    assert!(!boundary.cgroup.exists());
}

#[test]
#[ignore = "requires delegated cgroups; mandatory in the native release gate"]
fn service_filesystem_and_environment_are_private() {
    let boundary = Boundary::new(&delegated_parent());
    let output = boundary.run(
        r#"
        set -eu
        test "$HOME" = /home/service
        test -z "${AMBIENT_SERVICE_SECRET-}"
        test ! -e /etc/passwd
        test ! -e /workspace/private
        if cat /proc/1/environ > /tmp/parent-environment; then exit 92; fi
        if /usr/bin/unshare -Ur /bin/true; then exit 93; fi
        test "$(cat /workspace/input)" = selected-input
        if printf poison > /workspace/input; then exit 91; fi
        printf scratch > /workspace/output/result
        printf private > /tmp/result
        printf sandbox-ready
    "#,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"sandbox-ready");
    assert_eq!(
        fs::read(boundary.directory.path().join("started"))
            .unwrap_or_else(|error| panic!("{error}")),
        b"1"
    );
    assert_eq!(
        fs::read(boundary.directory.path().join("input")).unwrap_or_else(|error| panic!("{error}")),
        b"selected-input"
    );
    assert!(!boundary.directory.path().join("output").exists());
    assert!(
        !boundary.cgroup.exists(),
        "cleanup must confirm and remove the empty cgroup"
    );
}

#[test]
#[ignore = "requires delegated cgroups; mandatory in the native release gate"]
fn detached_descendants_are_gone_before_the_supervisor_exits() {
    let boundary = Boundary::new(&delegated_parent());
    let output = boundary.run("/usr/bin/setsid /bin/sleep 30 & printf sandbox-ready");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"sandbox-ready");
    assert!(!boundary.cgroup.exists());
}

#[test]
#[ignore = "requires delegated cgroups; mandatory in the native release gate"]
fn workload_memory_is_limited_by_the_kernel() {
    let boundary = Boundary::new(&delegated_parent());
    let output = boundary.run("printf sandbox-ready; /usr/bin/python3 -c 'x = bytearray(256 * 1024 * 1024); print(\"limit-escaped\")'");
    assert!(
        String::from_utf8_lossy(&output.stdout).starts_with("sandbox-ready"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("limit-escaped"));
    assert!(!boundary.cgroup.exists());
}

#[test]
#[ignore = "requires delegated cgroups; mandatory in the native release gate"]
fn workload_process_count_is_limited_by_the_kernel() {
    let boundary = Boundary::new(&delegated_parent());
    let output = boundary.run(
        r#"/usr/bin/python3 -c '
import subprocess, errno
children = []
try:
    for index in range(16):
        try:
            children.append(subprocess.Popen(["/bin/sleep", "30"]))
        except OSError as error:
            assert error.errno == errno.EAGAIN
            print("pids-enforced")
            break
    else:
        raise RuntimeError("process limit escaped")
finally:
    for child in children: child.kill()
    for child in children: child.wait()
'"#,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"pids-enforced\n");
    assert!(!boundary.cgroup.exists());
}

#[test]
#[ignore = "requires delegated cgroups; mandatory in the native release gate"]
fn input_pathname_sockets_cannot_reach_host_processes() {
    use std::os::unix::net::UnixListener;
    let mut boundary = Boundary::new(&delegated_parent());
    let socket_path = boundary.directory.path().join("host-socket");
    let listener = UnixListener::bind(&socket_path).unwrap_or_else(|error| panic!("{error}"));
    listener
        .set_nonblocking(true)
        .unwrap_or_else(|error| panic!("{error}"));
    boundary.policy["service"]["inputs"]
        .as_array_mut()
        .unwrap_or_else(|| panic!("inputs"))
        .push(json!({ "source": socket_path, "destination": "host-socket" }));
    let output = boundary.run(
        r#"/usr/bin/python3 -c '
import socket, errno
for create in [lambda: socket.socket(socket.AF_UNIX), lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)[0]]:
    try:
        client = create()
        client.connect("/workspace/host-socket")
    except OSError as error:
        assert error.errno == errno.EPERM
        print("host-socket-blocked")
    else:
        raise RuntimeError("host socket escaped")
'"#,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"host-socket-blocked\nhost-socket-blocked\n");
    assert!(listener.accept().is_err());
    assert!(!boundary.cgroup.exists());
}

#[test]
#[ignore = "requires delegated cgroups; mandatory in the native release gate"]
fn symlinked_input_sources_are_refused_before_execution() {
    use std::os::unix::fs::symlink;
    let mut boundary = Boundary::new(&delegated_parent());
    let link = boundary.directory.path().join("input-link");
    symlink(boundary.directory.path().join("private"), &link)
        .unwrap_or_else(|error| panic!("{error}"));
    boundary.policy["service"]["inputs"][0]["source"] = json!(link);
    let output = boundary.run("printf SHOULD_NOT_EXECUTE");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("pinned service mount"));
    assert!(!boundary.cgroup.exists());
}

#[test]
#[ignore = "requires delegated cgroups; mandatory in the native release gate"]
fn only_authenticated_bridges_reach_the_private_endpoint() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::UnixStream;
    use std::process::Stdio;
    use std::time::Duration;
    let boundary = Boundary::new(&delegated_parent());
    let child = Command::new(SUPERVISOR)
        .arg("--policy-file")
        .arg(boundary.policy_file())
        .args([
            "--",
            "/usr/bin/python3",
            "-u",
            "-c",
            r#"
import socket
server = socket.socket()
server.bind(("127.0.0.1", 4187))
server.listen()
print("endpoint-ready")
while True:
    client, address = server.accept()
    client.recv(4096)
    client.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
    client.close()
"#,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|error| panic!("{error}"));
    let mut running = ServiceChild(child);
    let mut output = BufReader::new(running.0.stdout.take().unwrap_or_else(|| panic!("stdout")));
    let mut ready = String::new();
    output
        .read_line(&mut ready)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(ready, "endpoint-ready\n");
    let identity: serde_json::Value = serde_json::from_slice(
        &fs::read(boundary.directory.path().join("process.json"))
            .unwrap_or_else(|error| panic!("{error}")),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(identity["executionReady"], true);
    let children = identity["children"]
        .as_array()
        .unwrap_or_else(|| panic!("missing native child identities"));
    assert_eq!(children.len(), 1, "the namespace init must be recorded");
    let pid = children[0]["pid"].as_u64().unwrap_or_else(|| panic!("pid"));
    let stat =
        fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_else(|error| panic!("{error}"));
    let start_time = stat
        .rsplit_once(')')
        .and_then(|(_, fields)| fields.split_whitespace().nth(19))
        .unwrap_or_else(|| panic!("kernel process start time"));
    assert_eq!(children[0]["startTime"], start_time);
    let socket = boundary.directory.path().join("bridge");
    let mut wrong = UnixStream::connect(&socket).unwrap_or_else(|error| panic!("{error}"));
    wrong
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap_or_else(|error| panic!("{error}"));
    wrong
        .write_all(&[b'b'; 64])
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(!matches!(wrong.read(&mut [0]), Ok(1)));
    let mut connection = UnixStream::connect(&socket).unwrap_or_else(|error| panic!("{error}"));
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap_or_else(|error| panic!("{error}"));
    connection
        .write_all(&[b'a'; 64])
        .unwrap_or_else(|error| panic!("{error}"));
    let mut acknowledgement = [0];
    connection
        .read_exact(&mut acknowledgement)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(acknowledgement, [1]);
    connection
        .write_all(b"GET / HTTP/1.1\r\nHost: service\r\n\r\n")
        .unwrap_or_else(|error| panic!("{error}"));
    let mut response = String::new();
    connection
        .read_to_string(&mut response)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(response.ends_with("\r\n\r\nok"));
    // A normal service stop waits for the supervisor to confirm the whole cgroup is empty.
    unsafe {
        libc::kill(running.0.id() as libc::pid_t, libc::SIGTERM);
    }
    running.0.wait().unwrap_or_else(|error| panic!("{error}"));
    assert!(!boundary.cgroup.exists());
}

#[test]
#[ignore = "requires delegated cgroups; mandatory in the native release gate"]
fn abrupt_supervisor_death_releases_recorded_native_owners() {
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixStream;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let mut boundary = Boundary::new(&delegated_parent());
    boundary.policy["network"] = json!({
        "egress": true, "localBinding": true, "outgoingProxy": { "frontEnds": ["http"] }
    });
    boundary.policy["service"]["outbound"] = json!([{ "hostname": "example.com", "port": 443 }]);
    let child = Command::new(SUPERVISOR)
        .arg("--policy-file")
        .arg(boundary.policy_file())
        .args([
            "--",
            "/bin/sh",
            "-c",
            "printf 'child-ready\\n'; exec /bin/sleep 30",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|error| panic!("{error}"));
    let mut running = ServiceChild(child);
    let mut output = BufReader::new(running.0.stdout.take().unwrap_or_else(|| panic!("stdout")));
    let mut ready = String::new();
    output
        .read_line(&mut ready)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(ready, "child-ready\n");
    let identity: serde_json::Value = serde_json::from_slice(
        &fs::read(boundary.directory.path().join("process.json"))
            .unwrap_or_else(|error| panic!("{error}")),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(identity["executionReady"], true);
    let children = identity["children"]
        .as_array()
        .unwrap_or_else(|| panic!("children"));
    assert_eq!(
        children.len(),
        2,
        "namespace init and egress must both be recorded"
    );
    running.0.kill().unwrap_or_else(|error| panic!("{error}"));
    running.0.wait().unwrap_or_else(|error| panic!("{error}"));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let native_owners_gone = children.iter().all(|child| {
            let pid = child["pid"].as_u64().unwrap_or_else(|| panic!("pid"));
            match fs::read_to_string(format!("/proc/{pid}/stat")) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Ok(stat) => {
                    let fields: Vec<_> = stat
                        .rsplit_once(')')
                        .unwrap_or_else(|| panic!("stat"))
                        .1
                        .split_whitespace()
                        .collect();
                    child["startTime"] != fields[19] || matches!(fields[0], "Z" | "X")
                }
                Err(error) => panic!("{error}"),
            }
        });
        let events = fs::read_to_string(boundary.cgroup.join("cgroup.events"))
            .unwrap_or_else(|error| panic!("{error}"));
        if native_owners_gone && events.lines().any(|line| line == "populated 0") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "native process tree did not terminate"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(UnixStream::connect(boundary.directory.path().join("bridge")).is_err());
    fs::remove_dir(&boundary.cgroup).unwrap_or_else(|error| panic!("{error}"));
}

#[test]
#[ignore = "requires delegated cgroups; mandatory in the native release gate"]
fn application_exit_125_is_not_a_native_startup_failure() {
    let boundary = Boundary::new(&delegated_parent());
    let output = boundary.run("exit 125");
    assert_eq!(output.status.code(), Some(125));
    assert_eq!(
        fs::read(boundary.directory.path().join("started"))
            .unwrap_or_else(|error| panic!("{error}")),
        b"1"
    );
    assert!(!boundary.cgroup.exists());
    let failed = Boundary::new(&delegated_parent());
    let output = Command::new(SUPERVISOR)
        .arg("--policy-file")
        .arg(failed.policy_file())
        .args(["--", "/missing-service-executable"])
        .output()
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(output.status.code(), Some(126));
    assert_eq!(
        fs::read(failed.directory.path().join("started")).unwrap_or_else(|error| panic!("{error}")),
        b"E"
    );
    assert!(!failed.cgroup.exists());
}

#[test]
#[ignore = "requires delegated cgroups; mandatory in the native release gate"]
fn selected_inputs_cannot_expose_host_device_nodes() {
    let mut boundary = Boundary::new(&delegated_parent());
    boundary.policy["service"]["inputs"][0]["source"] = json!("/dev/null");
    let output = boundary.run("if printf x > /workspace/input; then exit 91; fi; printf x > /dev/null; printf device-blocked");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"device-blocked");
    assert!(!boundary.cgroup.exists());
}

struct ServiceChild(std::process::Child);
impl Drop for ServiceChild {
    fn drop(&mut self) {
        // Assertion failures may not leave a test service running.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
