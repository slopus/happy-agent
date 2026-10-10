#![cfg(unix)]
use serde_json::json;
use std::fs;
use std::io::Write;
use std::process::{Command, Output};
use tempfile::TempDir;

const SUPERVISOR: &str = env!("CARGO_BIN_EXE_happy-agent");

struct TestBoundary {
    _root: TempDir,
    workspace: std::path::PathBuf,
    outside: std::path::PathBuf,
    policy: std::path::PathBuf,
}

impl TestBoundary {
    fn new(egress: bool, local_binding: bool) -> Self {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("temporary root: {error}"));
        let workspace = root.path().join("workspace");
        let outside = root.path().join("outside");
        fs::create_dir(&workspace).unwrap_or_else(|error| panic!("workspace: {error}"));
        fs::create_dir(&outside).unwrap_or_else(|error| panic!("outside: {error}"));
        let policy = root.path().join("policy.json");
        fs::write(
            &policy,
            serde_json::to_vec(&json!({
                "mode": "workspace_write",
                "network": {
                    "egress": egress,
                    "localBinding": local_binding
                }
            }))
            .unwrap_or_else(|error| panic!("serialize policy: {error}")),
        )
        .unwrap_or_else(|error| panic!("write policy: {error}"));
        Self {
            _root: root,
            workspace,
            outside,
            policy,
        }
    }

    fn run(&self, command: &[&str]) -> Output {
        self.run_with_env(command, &[])
    }

    fn run_with_env(&self, command: &[&str], environment: &[(&str, &str)]) -> Output {
        let mut supervisor = Command::new(SUPERVISOR);
        supervisor.arg("supervisor");
        supervisor
            .current_dir(&self.workspace)
            .args(["--policy-file"])
            .arg(&self.policy)
            .arg("--")
            .args(command);
        for (name, value) in environment {
            supervisor.env(name, value);
        }
        supervisor
            .output()
            .unwrap_or_else(|error| panic!("run supervisor: {error}"))
    }
}

#[test]
fn command_output_and_exit_status_pass_through() {
    let boundary = TestBoundary::new(false, false);
    let output = boundary.run(&["/bin/sh", "-c", "printf 'supervised-output'; exit 37"]);

    assert_eq!(String::from_utf8_lossy(&output.stdout), "supervised-output");
    assert_eq!(output.status.code(), Some(37));
    println!("stdout=supervised-output exit=37");
}

#[test]
fn policy_can_be_consumed_from_an_argument() {
    let boundary = TestBoundary::new(false, false);
    let policy = fs::read_to_string(&boundary.policy)
        .unwrap_or_else(|error| panic!("read argument policy: {error}"));

    let output = Command::new(SUPERVISOR)
        .arg("supervisor")
        .current_dir(&boundary.workspace)
        .arg("--policy")
        .arg(policy)
        .args(["--", "/bin/sh", "-c", "printf argument-policy"])
        .output()
        .unwrap_or_else(|error| panic!("run argument policy test: {error}"));

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), "argument-policy");
    println!("policy-argument=consumed stdout=argument-policy");
}

#[cfg(target_os = "linux")]
#[test]
fn absent_protected_names_stay_absent_while_plain_workspaces_remain_usable() {
    for mode in ["read_only", "workspace_write", "auto"] {
        let boundary = TestBoundary::new(false, false);
        let names = [".git", "AGENTS.md", "AGENTS_SECURITY.md", "happy.toml"];
        let protected: Vec<_> = names
            .iter()
            .map(|name| boundary.workspace.join(name))
            .collect();
        let policy = json!({
            "mode": mode,
            "deniedWritePaths": protected,
            "network": { "egress": false, "localBinding": false }
        })
        .to_string();
        let script = if mode == "read_only" {
            "printf plain-workspace; test ! -e happy.toml; test ! -e .git"
        } else {
            "mkdir source; printf ordinary > source/input; mv source/input source/result; cat source/result"
        };
        let output = Command::new(SUPERVISOR)
            .arg("supervisor")
            .current_dir(&boundary.workspace)
            .args(["--policy", &policy, "--", "/bin/sh", "-ec", script])
            .output()
            .unwrap_or_else(|error| panic!("run plain workspace: {error}"));
        assert!(
            output.status.success(),
            "mode={mode} status={:?} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            if mode == "read_only" {
                "plain-workspace"
            } else {
                "ordinary"
            }
        );
        for path in &protected {
            assert!(
                fs::symlink_metadata(path).is_err(),
                "synthetic protected path: {}",
                path.display()
            );
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn absent_protected_names_reject_creation_rename_links_and_path_aliases() {
    for mode in ["workspace_write", "auto"] {
        let boundary = TestBoundary::new(false, true);
        let protected = boundary.workspace.join("happy.toml");
        let policy = json!({
            "mode": mode,
            "deniedWritePaths": [protected, boundary.workspace.join(".git")],
            "network": { "egress": false, "localBinding": true }
        })
        .to_string();
        let output = Command::new(SUPERVISOR).arg("supervisor")
            .current_dir(&boundary.workspace)
            .args(["--policy", &policy, "--", "/usr/bin/python3", "-c"])
            .arg(r#"
import os, socket
os.mkdir('ordinary')
with open('ordinary/source', 'w') as f: f.write('ordinary')
os.symlink('.', 'alias')
parent = os.open('.', os.O_RDONLY | os.O_DIRECTORY)
def denied(label, operation):
    try: operation()
    except OSError: pass
    else: raise AssertionError('protected operation succeeded: ' + label)
    assert not os.path.lexists('happy.toml'), label
for path in ['happy.toml', './happy.toml', 'alias/happy.toml', 'ordinary/../happy.toml']:
    denied('create ' + path, lambda: os.open(path, os.O_WRONLY | os.O_CREAT, 0o600))
    denied('mkdir ' + path, lambda: os.mkdir(path))
    denied('fifo ' + path, lambda: os.mkfifo(path))
    denied('symlink ' + path, lambda: os.symlink('ordinary/source', path))
    denied('link ' + path, lambda: os.link('ordinary/source', path))
    denied('rename ' + path, lambda: os.rename('ordinary/source', path))
    s = socket.socket(socket.AF_UNIX)
    try: denied('socket ' + path, lambda: s.bind(path))
    finally: s.close()
denied('dirfd create', lambda: os.open('happy.toml', os.O_CREAT | os.O_WRONLY, 0o600, dir_fd=parent))
denied('dirfd rename', lambda: os.rename('ordinary/source', 'happy.toml', dst_dir_fd=parent))
denied('directory rename', lambda: os.rename('ordinary', '.git'))
denied('directory symlink', lambda: os.symlink('ordinary', '.git'))
os.link('ordinary/source', 'ordinary/link')
os.rename('ordinary/link', 'ordinary/result')
with open('ordinary/result') as f: assert f.read() == 'ordinary'
assert not os.path.lexists('.git')
print('atomic-denials-and-ordinary-edits')
"#)
            .output().unwrap_or_else(|error| panic!("run absent-name operations: {error}"));
        assert!(
            output.status.success(),
            "mode={mode} status={:?} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "atomic-denials-and-ordinary-edits\n"
        );
        assert!(fs::symlink_metadata(&protected).is_err());
        assert!(fs::symlink_metadata(boundary.workspace.join(".git")).is_err());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn protected_names_preserve_nested_parents_existing_git_and_backing_inode_aliases() {
    let boundary = TestBoundary::new(false, true);
    let git = boundary.workspace.join(".git");
    let nested = boundary.workspace.join("nested");
    fs::create_dir(&git).unwrap_or_else(|error| panic!("git fixture: {error}"));
    fs::create_dir(&nested).unwrap_or_else(|error| panic!("nested fixture: {error}"));
    fs::write(git.join("config"), "protected")
        .unwrap_or_else(|error| panic!("config fixture: {error}"));
    fs::hard_link(git.join("config"), boundary.workspace.join("config-alias"))
        .unwrap_or_else(|error| panic!("hard-link fixture: {error}"));
    let file_grant_alias = boundary.outside.join("config-file-grant");
    fs::hard_link(git.join("config"), &file_grant_alias)
        .unwrap_or_else(|error| panic!("file grant alias: {error}"));
    let policy = json!({
        "mode": "workspace_write",
        "allowedWritePaths": [file_grant_alias],
        "deniedWritePaths": [git, nested.join("happy.toml"), boundary.workspace.join("AGENTS.md")],
        "network": { "egress": false, "localBinding": true }
    })
    .to_string();
    let output = Command::new(SUPERVISOR)
        .arg("supervisor")
        .current_dir(&boundary.workspace)
        .env("FILE_GRANT_ALIAS", &file_grant_alias)
        .args(["--policy", &policy, "--", "/usr/bin/python3", "-c"])
        .arg(
            r#"
import mmap, os, socket
def denied(operation):
    try: operation()
    except OSError: return
    raise AssertionError('protected operation succeeded')
with open('.git/config') as f: assert f.read() == 'protected'
with open('config-alias') as f: assert f.read() == 'protected'
for path in ['.git/config', 'config-alias', os.environ['FILE_GRANT_ALIAS']]:
    denied(lambda: os.open(path, os.O_WRONLY | os.O_TRUNC))
    denied(lambda: os.chmod(path, 0o777))
    denied(lambda: os.setxattr(path, 'user.poison', b'poison'))
    denied(lambda: os.link(path, 'git-copy'))
    denied(lambda: os.rename(path, 'git-copy'))
    denied(lambda: os.unlink(path))
os.mkdir('replacement')
denied(lambda: os.rename('nested', 'moved'))
denied(lambda: os.rename('replacement', 'nested'))
denied(lambda: os.rmdir('nested'))
fd = os.open('nested', os.O_DIRECTORY)
denied(lambda: os.open('happy.toml', os.O_WRONLY | os.O_CREAT, 0o600, dir_fd=fd))
os.symlink('nested', 'nested-alias')
denied(lambda: os.open('nested-alias/happy.toml', os.O_WRONLY | os.O_CREAT, 0o600))
with open('normal', 'w+b') as f:
    f.write(b'ordinary'); f.flush()
    with mmap.mmap(f.fileno(), 8) as m: m[0:4] = b'edit'; m.flush()
os.chmod('normal', 0o640)
os.utime('normal', (1000, 2000))
os.setxattr('normal', 'user.ordinary', b'yes')
assert os.getxattr('normal', 'user.ordinary') == b'yes'
assert 'user.ordinary' in os.listxattr('normal')
os.removexattr('normal', 'user.ordinary')
assert os.stat('normal').st_mtime == 2000
assert os.stat('normal').st_mode & 0o777 == 0o640
os.symlink('normal', 'normal-alias')
assert os.readlink('normal-alias') == 'normal'
with open('normal-alias', 'r+b') as f: assert f.read() == b'editnary'
server = socket.socket(socket.AF_UNIX)
client = socket.socket(socket.AF_UNIX)
server.bind('normal.socket'); server.listen()
client.connect('normal.socket'); accepted, _ = server.accept()
client.sendall(b'ordinary'); assert accepted.recv(8) == b'ordinary'
accepted.close(); client.close(); server.close(); os.unlink('normal.socket')
print('nested-git-aliases-and-normal-metadata')
"#,
        )
        .output()
        .unwrap_or_else(|error| panic!("run pinned-inode test: {error}"));
    assert!(
        output.status.success(),
        "status={:?} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "nested-git-aliases-and-normal-metadata\n"
    );
    assert_eq!(
        fs::read_to_string(git.join("config"))
            .unwrap_or_else(|error| panic!("retained config: {error}")),
        "protected"
    );
    assert!(!nested.join("happy.toml").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn protected_name_server_failure_terminates_the_complete_command_tree() {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::time::{Duration, Instant};
    let boundary = TestBoundary::new(false, false);
    let policy = json!({
        "mode": "workspace_write", "deniedWritePaths": [boundary.workspace.join("happy.toml")],
        "network": { "egress": false, "localBinding": false }
    })
    .to_string();
    let mut child = Command::new(SUPERVISOR).arg("supervisor")
        .current_dir(&boundary.workspace)
        .stdout(std::process::Stdio::piped())
        .args(["--policy", &policy, "--", "/usr/bin/python3", "-c"])
        .arg(r#"
import os, signal
servers = [int(p) for p in os.listdir('/proc') if p.isdigit() and open('/proc/' + p + '/comm').read().strip() == 'happy-name-fs']
assert servers
if os.fork() == 0:
    os.setsid()
    while True: signal.pause()
os.kill(servers[0], signal.SIGKILL)
while True: signal.pause()
"#).spawn().unwrap_or_else(|error| panic!("run server failure: {error}"));
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .unwrap_or_else(|error| panic!("wait server failure: {error}"))
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("filesystem server failure did not terminate the supervisor");
        }
        std::thread::yield_now();
    };
    assert_eq!(status.code(), Some(125));
    // A detached descendant inherits this pipe. EOF proves it was killed too,
    // rather than merely seeing its process-group leader exit.
    let mut pipe = child
        .stdout
        .take()
        .unwrap_or_else(|| panic!("missing lifetime pipe"));
    assert_eq!(
        unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) },
        0
    );
    loop {
        match pipe.read(&mut [0; 32]) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => panic!("read command lifetime pipe: {error}"),
        }
        assert!(
            Instant::now() < deadline,
            "a detached descendant survived filesystem failure"
        );
        std::thread::yield_now();
    }
    assert!(!boundary.workspace.join("happy.toml").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn concurrent_denied_creations_never_publish_a_protected_backing_name() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let boundary = TestBoundary::new(false, false);
    let watcher = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
    assert!(
        watcher >= 0,
        "create event observation: {}",
        std::io::Error::last_os_error()
    );
    let root = CString::new(boundary.workspace.as_os_str().as_bytes())
        .unwrap_or_else(|error| panic!("observation path: {error}"));
    assert!(
        unsafe {
            libc::inotify_add_watch(watcher, root.as_ptr(), libc::IN_CREATE | libc::IN_MOVED_TO)
        } >= 0
    );
    let policy = json!({
        "mode": "workspace_write", "deniedWritePaths": [boundary.workspace.join("happy.toml")],
        "network": { "egress": false, "localBinding": false }
    })
    .to_string();
    let output = Command::new(SUPERVISOR)
        .arg("supervisor")
        .current_dir(&boundary.workspace)
        .args(["--policy", &policy, "--", "/usr/bin/python3", "-c"])
        .arg(
            r#"
import concurrent.futures, os
os.symlink('.', 'alias')
def attack(index):
    source = 'source-' + str(index)
    with open(source, 'w') as f: f.write('ordinary')
    for _ in range(100):
        for target in ['happy.toml', 'alias/happy.toml']:
            for operation in [lambda: os.open(target, os.O_CREAT | os.O_WRONLY, 0o600),
                              lambda: os.rename(source, target),
                              lambda: os.link(source, target),
                              lambda: os.symlink(source, target)]:
                try: operation()
                except OSError: pass
                else: raise AssertionError('protected name admitted')
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    list(pool.map(attack, range(8)))
print('concurrent-denials')
"#,
        )
        .output()
        .unwrap_or_else(|error| panic!("run concurrent denial fixture: {error}"));
    let mut bytes = [0_u8; 16_384];
    let mut observed_ordinary = false;
    loop {
        let length = unsafe { libc::read(watcher, bytes.as_mut_ptr().cast(), bytes.len()) };
        if length < 0 {
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EAGAIN)
            );
            break;
        }
        if length == 0 {
            break;
        }
        let mut offset = 0;
        while offset < length as usize {
            let event = unsafe {
                bytes
                    .as_ptr()
                    .add(offset)
                    .cast::<libc::inotify_event>()
                    .read_unaligned()
            };
            assert_eq!(
                event.mask & libc::IN_Q_OVERFLOW,
                0,
                "event evidence overflowed"
            );
            let start = offset + std::mem::size_of::<libc::inotify_event>();
            let name = &bytes[start..start + event.len as usize];
            let name = name.split(|byte| *byte == 0).next().unwrap_or(&[]);
            assert_ne!(
                name, b"happy.toml",
                "a protected backing name existed during execution"
            );
            observed_ordinary |= name == b"source-0";
            offset = start + event.len as usize;
        }
    }
    unsafe {
        libc::close(watcher);
    }
    assert!(
        output.status.success(),
        "status={:?} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        observed_ordinary,
        "the observer did not capture an ordinary backing creation"
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "concurrent-denials\n"
    );
    assert!(!boundary.workspace.join("happy.toml").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn writable_mount_aliases_and_inherited_directory_handles_cannot_bypass_protected_names() {
    let boundary = TestBoundary::new(false, false);
    let alias = boundary.outside.join("alias");
    fs::create_dir(&alias).unwrap_or_else(|error| panic!("mount alias: {error}"));
    let policy = json!({
        "mode": "workspace_write", "allowedWritePaths": [alias],
        "deniedWritePaths": [boundary.workspace.join("happy.toml")],
        "network": { "egress": false, "localBinding": false }
    })
    .to_string();
    let output = Command::new("/usr/bin/python3").current_dir(&boundary.workspace)
        .env("FIXTURE_SUPERVISOR", SUPERVISOR).env("FIXTURE_POLICY", policy)
        .env("FIXTURE_WORKSPACE", &boundary.workspace).env("FIXTURE_ALIAS", &alias)
        .args(["-c", r#"
import ctypes, os
c = ctypes.CDLL(None, use_errno=True)
uid, gid = os.geteuid(), os.getegid()
assert c.unshare(0x10000000) == 0, ctypes.get_errno()
with open('/proc/self/setgroups', 'w') as f: f.write('deny\n')
with open('/proc/self/uid_map', 'w') as f: f.write('0 %d 1\n' % uid)
with open('/proc/self/gid_map', 'w') as f: f.write('0 %d 1\n' % gid)
os.setresgid(0, 0, 0); os.setresuid(0, 0, 0)
assert c.unshare(0x20000) == 0, ctypes.get_errno()
assert c.mount(None, b'/', None, (1 << 14) | (1 << 18), None) == 0, ctypes.get_errno()
assert c.mount(os.fsencode(os.environ['FIXTURE_WORKSPACE']), os.fsencode(os.environ['FIXTURE_ALIAS']), None, 4096, None) == 0, ctypes.get_errno()
inherited = os.open(os.environ['FIXTURE_ALIAS'], os.O_DIRECTORY)
os.set_inheritable(inherited, True)
os.environ['FIXTURE_INHERITED'] = str(inherited)
workload = '''
import os
alias = os.environ['FIXTURE_ALIAS']
with open(alias + '/ordinary', 'w') as f: f.write('ordinary')
with open('ordinary') as f: assert f.read() == 'ordinary'
for root in ['.', alias]:
    parent = os.open(root, os.O_DIRECTORY)
    try: os.open('happy.toml', os.O_CREAT | os.O_WRONLY, 0o600, dir_fd=parent)
    except OSError: pass
    else: raise AssertionError('writable directory alias bypass')
    os.close(parent)
inherited = int(os.environ['FIXTURE_INHERITED'])
try: os.open('happy.toml', os.O_CREAT | os.O_WRONLY, 0o600, dir_fd=inherited)
except OSError: pass
else: raise AssertionError('inherited directory bypass')
assert not os.path.lexists('happy.toml')
print('mount-alias-and-inherited-handle-denials')
'''
os.execv(os.environ['FIXTURE_SUPERVISOR'], [os.environ['FIXTURE_SUPERVISOR'], 'supervisor', '--policy', os.environ['FIXTURE_POLICY'], '--', '/usr/bin/python3', '-c', workload])
"#]).output().unwrap_or_else(|error| panic!("run writable alias fixture: {error}"));
    assert!(
        output.status.success(),
        "status={:?} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "mount-alias-and-inherited-handle-denials\n"
    );
    assert!(!boundary.workspace.join("happy.toml").exists());
    assert!(
        fs::read_dir(&alias)
            .unwrap_or_else(|error| panic!("retained alias: {error}"))
            .next()
            .is_none(),
        "private test mounts escaped to the host"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn restricted_commands_refuse_directory_handles_in_standard_streams() {
    let boundary = TestBoundary::new(false, false);
    let directory = fs::File::open(&boundary.workspace)
        .unwrap_or_else(|error| panic!("standard directory fixture: {error}"));
    let output = Command::new(SUPERVISOR)
        .arg("supervisor")
        .current_dir(&boundary.workspace)
        .stdin(directory)
        .arg("--policy-file")
        .arg(&boundary.policy)
        .args(["--", "/bin/sh", "-c", "printf admitted"])
        .output()
        .unwrap_or_else(|error| panic!("run standard directory fixture: {error}"));
    assert_eq!(output.status.code(), Some(125));
    assert!(output.stdout.is_empty(), "workload was admitted");
    assert!(String::from_utf8_lossy(&output.stderr).contains("standard streams"));
}

#[cfg(target_os = "linux")]
#[test]
fn unpinnable_protected_names_fail_before_starting_or_creating_paths() {
    let boundary = TestBoundary::new(false, false);
    for dangling in [false, true] {
        let protected = if dangling {
            let path = boundary.workspace.join("dangling");
            std::os::unix::fs::symlink("missing-target", &path)
                .unwrap_or_else(|error| panic!("dangling fixture: {error}"));
            path
        } else {
            boundary.workspace.join("missing-parent/happy.toml")
        };
        let policy = json!({
            "mode": "workspace_write", "deniedWritePaths": [protected],
            "network": { "egress": false, "localBinding": false }
        })
        .to_string();
        let output = Command::new(SUPERVISOR)
            .arg("supervisor")
            .current_dir(&boundary.workspace)
            .args([
                "--policy",
                &policy,
                "--",
                "/bin/sh",
                "-c",
                "printf admitted; touch ordinary",
            ])
            .output()
            .unwrap_or_else(|error| panic!("run unpinnable fixture: {error}"));
        assert_eq!(output.status.code(), Some(125));
        assert!(output.stdout.is_empty());
        assert!(!boundary.workspace.join("ordinary").exists());
        assert!(!boundary.workspace.join("missing-parent").exists());
        assert!(!boundary.workspace.join("missing-target").exists());
        assert!(String::from_utf8_lossy(&output.stderr).contains("no command was started"));
    }
}

#[cfg(target_os = "linux")]
#[test]
fn unavailable_fuse_stops_startup_without_a_protected_placeholder() {
    let boundary = TestBoundary::new(false, false);
    let policy = json!({
        "mode": "workspace_write", "deniedWritePaths": [boundary.workspace.join("happy.toml")],
        "network": { "egress": false, "localBinding": false }
    })
    .to_string();
    let output = Command::new("/usr/bin/python3").current_dir(&boundary.workspace)
        .env("FIXTURE_SUPERVISOR", SUPERVISOR).env("FIXTURE_POLICY", policy)
        .args(["-c", r#"
import ctypes, os
c = ctypes.CDLL(None, use_errno=True)
uid, gid = os.geteuid(), os.getegid()
assert c.unshare(0x10000000) == 0, ctypes.get_errno()
with open('/proc/self/setgroups', 'w') as f: f.write('deny\n')
with open('/proc/self/uid_map', 'w') as f: f.write('0 %d 1\n' % uid)
with open('/proc/self/gid_map', 'w') as f: f.write('0 %d 1\n' % gid)
os.setresgid(0, 0, 0); os.setresuid(0, 0, 0)
assert c.unshare(0x20000) == 0, ctypes.get_errno()
assert c.mount(None, b'/', None, (1 << 14) | (1 << 18), None) == 0, ctypes.get_errno()
assert c.mount(b'tmpfs', b'/dev', b'tmpfs', 6, b'size=4096') == 0, ctypes.get_errno()
os.execv(os.environ['FIXTURE_SUPERVISOR'], [os.environ['FIXTURE_SUPERVISOR'], 'supervisor', '--policy', os.environ['FIXTURE_POLICY'], '--', '/bin/sh', '-c', 'printf admitted; touch happy.toml'])
"#]).output().unwrap_or_else(|error| panic!("run unavailable FUSE fixture: {error}"));
    assert_eq!(
        output.status.code(),
        Some(125),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty(), "workload was admitted");
    assert!(String::from_utf8_lossy(&output.stderr).contains("/dev/fuse"));
    assert!(!boundary.workspace.join("happy.toml").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn trusted_host_edits_are_visible_through_an_already_open_workspace_file() {
    use std::io::{BufRead, BufReader};
    let boundary = TestBoundary::new(false, false);
    let file = boundary.workspace.join("ordinary");
    fs::write(&file, "before!").unwrap_or_else(|error| panic!("host edit fixture: {error}"));
    let policy = json!({
        "mode": "workspace_write", "deniedWritePaths": [boundary.workspace.join("happy.toml")],
        "network": { "egress": false, "localBinding": false }
    })
    .to_string();
    let mut child = Command::new(SUPERVISOR)
        .arg("supervisor")
        .current_dir(&boundary.workspace)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .args(["--policy", &policy, "--", "/usr/bin/python3", "-c"])
        .arg(
            r#"
import os, sys
fd = os.open('ordinary', os.O_RDONLY)
assert os.read(fd, 7) == b'before!'
print('ready-for-host-edit', flush=True)
assert sys.stdin.readline().strip() == 'edited'
os.lseek(fd, 0, os.SEEK_SET)
assert os.read(fd, 7) == b'changed', 'cached data hid a trusted host edit'
print('host-edit-visible', flush=True)
"#,
        )
        .spawn()
        .unwrap_or_else(|error| panic!("run host edit fixture: {error}"));
    let mut output = BufReader::new(
        child
            .stdout
            .take()
            .unwrap_or_else(|| panic!("host edit stdout")),
    );
    let mut line = String::new();
    output
        .read_line(&mut line)
        .unwrap_or_else(|error| panic!("wait host edit readiness: {error}"));
    assert_eq!(line, "ready-for-host-edit\n");
    fs::write(&file, "changed").unwrap_or_else(|error| panic!("trusted host edit: {error}"));
    child
        .stdin
        .take()
        .unwrap_or_else(|| panic!("host edit stdin"))
        .write_all(b"edited\n")
        .unwrap_or_else(|error| panic!("release host edit reader: {error}"));
    line.clear();
    output
        .read_line(&mut line)
        .unwrap_or_else(|error| panic!("read host edit result: {error}"));
    assert_eq!(line, "host-edit-visible\n");
    assert!(
        child
            .wait()
            .unwrap_or_else(|error| panic!("wait host edit fixture: {error}"))
            .success()
    );
}

#[cfg(target_os = "linux")]
#[test]
fn unproven_backing_filename_semantics_fail_before_workload_admission() {
    let boundary = TestBoundary::new(false, false);
    // A real procfs parent proves the unsupported-filesystem path without
    // creating a filesystem image or changing any host filesystem features.
    let policy = json!({
        "mode": "workspace_write", "deniedWritePaths": ["/proc/self/happy-test-protected-name"],
        "network": { "egress": false, "localBinding": false }
    })
    .to_string();
    let output = Command::new(SUPERVISOR)
        .arg("supervisor")
        .current_dir(&boundary.workspace)
        .args([
            "--policy",
            &policy,
            "--",
            "/bin/sh",
            "-c",
            "printf admitted; touch ordinary",
        ])
        .output()
        .unwrap_or_else(|error| panic!("run unsupported naming fixture: {error}"));
    assert_eq!(output.status.code(), Some(125));
    assert!(output.stdout.is_empty());
    assert!(!boundary.workspace.join("ordinary").exists());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("filesystem is unsupported"),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(target_os = "macos")]
#[test]
fn seatbelt_blocks_first_time_creation_of_a_denied_path() {
    let boundary = TestBoundary::new(false, false);
    let canonical_workspace = boundary
        .workspace
        .canonicalize()
        .unwrap_or_else(|error| panic!("canonical workspace: {error}"));
    let protected = canonical_workspace.join("agent-policy.toml");
    let policy = json!({
        "mode": "workspace_write",
        "deniedWritePaths": [protected.to_string_lossy()],
        "network": {
            "egress": false,
            "localBinding": false
        }
    })
    .to_string();

    let output = Command::new(SUPERVISOR)
        .arg("supervisor")
        .current_dir(&boundary.workspace)
        .args(["--policy", &policy, "--", "/bin/sh", "-c"])
        .arg("printf poisoned > agent-policy.toml")
        .output()
        .unwrap_or_else(|error| panic!("run first-time denied-path test: {error}"));

    assert!(
        !output.status.success(),
        "status={:?} protected-exists={} stderr={}",
        output.status,
        protected.exists(),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!protected.exists());
    println!("first-time-denied-path=blocked");
}

#[test]
fn writes_are_limited_to_the_workspace() {
    let boundary = TestBoundary::new(false, false);
    let inside = boundary.workspace.join("inside.txt");
    let outside = boundary.outside.join("outside.txt");
    let output = Command::new(SUPERVISOR)
        .arg("supervisor")
        .current_dir(&boundary.workspace)
        .args(["--policy-file"])
        .arg(&boundary.policy)
        .args(["--", "/bin/sh", "-c"])
        // The inside write is deliberately relative. Binding a mount over the working directory
        // leaves an already-standing process pointing at the shadowed directory underneath, so an
        // absolute path can succeed while `./file` is refused, and relative is how commands write.
        .arg("printf inside > inside.txt; if printf outside > \"$OUTSIDE\"; then exit 91; fi")
        .env("OUTSIDE", &outside)
        .output()
        .unwrap_or_else(|error| panic!("run filesystem test: {error}"));

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(inside).unwrap_or_else(|error| panic!("read inside: {error}")),
        "inside"
    );
    assert!(!outside.exists());
    println!("inside-write=inside outside-write=refused");
}

#[cfg(target_os = "linux")]
#[test]
fn overlapping_read_denials_preserve_the_boundary_in_either_order() {
    for mode in ["read_only", "workspace_write", "auto"] {
        for parent_first in [true, false] {
            let boundary = TestBoundary::new(false, false);
            let private = boundary.outside.join("private");
            fs::create_dir(&private).unwrap_or_else(|error| panic!("private directory: {error}"));
            let secret = private.join("secret.txt");
            fs::write(&secret, "private fixture")
                .unwrap_or_else(|error| panic!("private fixture: {error}"));
            let public = boundary.outside.join("private-sibling.txt");
            fs::write(&public, "public fixture")
                .unwrap_or_else(|error| panic!("public fixture: {error}"));
            let denied = if parent_first {
                vec![&private, &secret]
            } else {
                vec![&secret, &private]
            };
            let policy = json!({
                "mode": mode,
                "deniedReadPaths": denied,
                "network": { "egress": false, "localBinding": false }
            })
            .to_string();
            let output = Command::new(SUPERVISOR).arg("supervisor")
                .current_dir(&boundary.workspace)
                .args(["--policy", &policy, "--", "/bin/sh", "-c"])
                .arg("if cat \"$PRIVATE_FILE\" >/dev/null 2>&1; then exit 91; fi; cat \"$PUBLIC_FILE\"")
                .env("PRIVATE_FILE", &secret)
                .env("PUBLIC_FILE", &public)
                .output()
                .unwrap_or_else(|error| panic!("run overlapping-denial test: {error}"));

            assert!(
                output.status.success(),
                "mode={mode} parent-first={parent_first} status={:?} stderr={}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(String::from_utf8_lossy(&output.stdout), "public fixture");
            assert_eq!(
                fs::read_to_string(&secret)
                    .unwrap_or_else(|error| panic!("read retained private fixture: {error}")),
                "private fixture"
            );
        }
    }
}

#[test]
fn local_binding_is_denied_while_egress_remains_available() {
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0")
        .unwrap_or_else(|error| panic!("bind host listener: {error}"));
    let endpoint = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("listener address: {error}"));
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener
            .accept()
            .unwrap_or_else(|error| panic!("accept egress probe: {error}"));
        stream
            .write_all(b"egress-ok")
            .unwrap_or_else(|error| panic!("write egress probe: {error}"));
    });
    let boundary = TestBoundary::new(true, false);
    let output = workload(
        &boundary,
        "network",
        &[("SUPERVISOR_TEST_ENDPOINT", endpoint.to_string())],
    );
    server
        .join()
        .unwrap_or_else(|_| panic!("egress probe server panicked"));

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("bind=EPERM egress=egress-ok"));
    println!("bind=EPERM egress=egress-ok");
}

#[cfg(target_os = "linux")]
#[test]
fn proc_ps_and_zero_capabilities_are_visible_to_the_workload() {
    let boundary = TestBoundary::new(false, false);
    let output = workload(&boundary, "proc", &[]);
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("proc=present"));
    assert!(stdout.contains("CapEff:\t0000000000000000"));
    assert!(stdout.contains("CapPrm:\t0000000000000000"));
    assert!(stdout.contains("CapBnd:\t0000000000000000"));
    assert!(stdout.contains("NoNewPrivs:\t1"));
    assert!(stdout.contains("proc-fd=working"));
    assert!(stdout.contains("workload-pid=2"));
    assert!(stdout.contains("ps=working"));
    println!("{stdout}");
}

#[cfg(target_os = "linux")]
#[test]
fn target_signals_pass_through_as_signals() {
    use std::os::unix::process::ExitStatusExt;

    let boundary = TestBoundary::new(false, false);
    let output = workload(&boundary, "signal", &[]);

    assert_eq!(output.status.signal(), Some(libc::SIGTERM));
    println!("signal=SIGTERM");
}

fn workload(boundary: &TestBoundary, operation: &str, environment: &[(&str, String)]) -> Output {
    let mut command = Command::new(SUPERVISOR);
    command.arg("supervisor");
    command
        .current_dir(&boundary.workspace)
        .args(["--policy-file"])
        .arg(&boundary.policy)
        .arg("--")
        .arg(std::env::current_exe().unwrap_or_else(|error| panic!("current test binary: {error}")))
        .args(["--exact", "workload_process", "--nocapture"])
        .env("SUPERVISOR_TEST_WORKLOAD", operation);
    for (key, value) in environment {
        command.env(key, value);
    }
    command
        .output()
        .unwrap_or_else(|error| panic!("run workload helper: {error}"))
}

#[test]
fn workload_process() {
    use std::io::Read;
    use std::net::{TcpListener, TcpStream};

    let Ok(operation) = std::env::var("SUPERVISOR_TEST_WORKLOAD") else {
        return;
    };
    match operation.as_str() {
        "network" => {
            let bind_error = TcpListener::bind("127.0.0.1:0")
                .err()
                .unwrap_or_else(|| panic!("local binding unexpectedly succeeded"));
            assert_eq!(bind_error.raw_os_error(), Some(libc::EPERM));
            let endpoint = std::env::var("SUPERVISOR_TEST_ENDPOINT")
                .unwrap_or_else(|error| panic!("egress endpoint: {error}"));
            let mut stream = TcpStream::connect(endpoint)
                .unwrap_or_else(|error| panic!("egress connect failed: {error}"));
            let mut response = String::new();
            stream
                .read_to_string(&mut response)
                .unwrap_or_else(|error| panic!("read egress response: {error}"));
            println!("bind=EPERM egress={response}");
        }
        #[cfg(target_os = "linux")]
        "proc" => {
            let status = fs::read_to_string("/proc/self/status")
                .unwrap_or_else(|error| panic!("read /proc/self/status: {error}"));
            let security_status = status
                .lines()
                .filter(|line| {
                    line.starts_with("CapEff:")
                        || line.starts_with("CapPrm:")
                        || line.starts_with("CapBnd:")
                        || line.starts_with("NoNewPrivs:")
                })
                .collect::<Vec<_>>();
            assert_eq!(
                security_status,
                [
                    "CapPrm:\t0000000000000000",
                    "CapEff:\t0000000000000000",
                    "CapBnd:\t0000000000000000",
                    "NoNewPrivs:\t1",
                ]
            );
            fs::read_dir("/proc/self/fd")
                .unwrap_or_else(|error| panic!("read /proc/self/fd: {error}"));
            assert_eq!(std::process::id(), 2);
            let ps = Command::new("ps")
                .args(["-o", "pid,comm"])
                .output()
                .unwrap_or_else(|error| panic!("run ps: {error}"));
            assert!(
                ps.status.success(),
                "ps stderr: {}",
                String::from_utf8_lossy(&ps.stderr)
            );
            println!(
                "proc=present\n{}\nproc-fd=working\nworkload-pid=2\nps=working",
                security_status.join("\n")
            );
        }
        #[cfg(target_os = "linux")]
        "supervisor-memory" => {
            // PID 1 in this namespace is the supervisor's namespace init, running as the same
            // mapped user, so nothing but the non-dumpable flag stands between them.
            let error = fs::File::open("/proc/1/mem")
                .err()
                .unwrap_or_else(|| panic!("the workload could read the supervisor's memory"));
            assert_eq!(error.raw_os_error(), Some(libc::EACCES));
            println!("supervisor-memory=refused");
        }
        #[cfg(target_os = "linux")]
        "signal" => unsafe {
            libc::raise(libc::SIGTERM);
        },
        other => panic!("unknown workload operation: {other}"),
    }
}

/// Process hardening removes the loader variables from the supervisor, and the easiest way to get
/// that wrong is to remove them from the workload too. `LD_LIBRARY_PATH` is ordinary configuration
/// for a build, and a sandbox that silently drops it breaks work it was never asked to police.
#[test]
fn the_workload_is_given_the_environment_the_caller_wrote() {
    let boundary = TestBoundary::new(false, false);
    let output = boundary.run_with_env(
        &[
            "/bin/sh",
            "-c",
            "printf 'library-path=%s' \"$LD_LIBRARY_PATH\"",
        ],
        &[("LD_LIBRARY_PATH", "/opt/vendor/lib")],
    );

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "library-path=/opt/vendor/lib"
    );
    println!("library-path=/opt/vendor/lib");
}

/// The supervisor holds the workload's only route out of the jail and runs as the same user, so a
/// workload that could read its memory would not need the route to be opened for it. The PID
/// namespace already hides the egress process; this is about the one process the workload can see.
#[cfg(target_os = "linux")]
#[test]
fn the_workload_cannot_read_the_supervisor_it_runs_under() {
    let boundary = TestBoundary::new(false, false);
    // The open is attempted in the workload helper rather than in a shell. `dash` treats a failed
    // redirection on a special builtin as fatal to the whole script, so the shell form reported the
    // very refusal it was looking for as the script's own failure.
    let output = workload(&boundary, "supervisor-memory", &[]);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("supervisor-memory=refused"),
        "stdout:\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
    println!("supervisor-memory=refused");
}

/// The pre-5.12 remount fallback would otherwise never execute on any kernel this is tested on, so
/// it is forced here and held to exactly the boundary the modern path enforces.
#[cfg(target_os = "linux")]
#[test]
fn the_legacy_remount_fallback_enforces_the_same_boundary() {
    let boundary = TestBoundary::new(false, false);
    let outside = boundary.outside.join("outside.txt");
    let output = boundary.run_with_env(
        &[
            "/bin/sh",
            "-c",
            "printf inside > inside.txt || exit 91; if printf outside > \"$OUTSIDE\"; then exit 92; fi",
        ],
        &[
            ("HAPPY_AGENT_SUPERVISOR_FORCE_LEGACY_REMOUNT", "1"),
            (
                "OUTSIDE",
                outside
                    .to_str()
                    .unwrap_or_else(|| panic!("outside path is not UTF-8")),
            ),
        ],
    );

    assert!(
        output.status.success(),
        "the forced fallback did not enforce the boundary (exit {:?})\nstdout:\n{}\nstderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(boundary.workspace.join("inside.txt"))
            .unwrap_or_else(|error| panic!("read fallback workspace output: {error}")),
        "inside"
    );
    assert!(
        !outside.exists(),
        "the fallback permitted a write outside the workspace"
    );
}
