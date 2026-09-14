use crate::exec::exec_target;
use crate::platform::child::{
    STATUS_EXIT, WorkloadStatus, install_signal_forwarders, reproduce_status,
    reset_signal_handlers, set_forward_target, wait_for_pid, wait_status_to_workload_status,
};
use crate::policy::{PermissionMode, SupervisorPolicy};
use crate::proxy::{OutgoingProxy, egress};
use crate::{SupervisorResult, invalid_input};
use std::ffi::{CStr, CString, OsString};
use std::os::fd::{AsRawFd, RawFd};
use std::path::{Path, PathBuf};

#[link(name = "sandbox")]
unsafe extern "C" {
    fn sandbox_init(
        profile: *const libc::c_char,
        flags: u64,
        error_buffer: *mut *mut libc::c_char,
    ) -> libc::c_int;
    fn sandbox_free_error(error_buffer: *mut libc::c_char);
    fn sandbox_check(
        pid: libc::pid_t,
        operation: *const libc::c_char,
        filter: libc::c_int,
    ) -> libc::c_int;
}

pub(crate) fn run(policy: SupervisorPolicy, command: Vec<OsString>) -> SupervisorResult<()> {
    refuse_nested_sandbox()?;
    // After the nested-sandbox check, so an enclosing sandbox is reported as itself rather than as
    // whichever hardening step it happened to interfere with first.
    crate::hardening::apply()?;
    // There is no network namespace here, so the split between the two processes is the profile
    // itself. The egress process is forked first and never has the profile applied to it; this
    // process binds the front-ends, is sandboxed with the workload, and can reach nothing but its
    // own loopback ports. A fault in a front-end therefore reaches no more of the network than the
    // workload does.
    let mut egress_process = None;
    let proxy = match &policy.network.outgoing_proxy {
        Some(proxy_policy) => {
            let egress = egress::start(&policy.network.allowed_hosts)?;
            // The link outlives this borrow: the proxy holds it until the process ends, and closing
            // it is how the egress process is told the workload is finished.
            egress_process = Some((egress.pid, egress.link.as_raw_fd()));
            // The front-ends are bound before the profile is installed, so the profile can deny
            // binding outright while the proxy still holds its listeners.
            Some(crate::proxy::prepare(proxy_policy, egress.link)?)
        }
        None => None,
    };
    if policy.mode != PermissionMode::FullAccess {
        let cwd = std::env::current_dir()?;
        let front_end_ports = match &proxy {
            Some(proxy) => proxy.front_end_ports()?,
            None => Vec::new(),
        };
        let profile = create_profile(&policy, &cwd, &front_end_ports)?;
        apply_profile(&profile)?;
    }
    match proxy {
        None => exec_target(&command, &[]),
        Some(proxy) => run_beside_proxy(proxy, &command, egress_process),
    }
}

/// Runs the workload as a child so the front-ends survive it.
///
/// `execve` would replace this process image, and with it the front-ends the workload is about to
/// use, so the two have to be separate processes. The child's exit code or terminating signal is
/// reproduced here, which keeps the supervisor invisible to whoever ran it, and the egress process
/// is ended before that happens so nothing outlives the workload.
fn run_beside_proxy(
    proxy: OutgoingProxy,
    command: &[OsString],
    egress_process: Option<(libc::pid_t, RawFd)>,
) -> SupervisorResult<()> {
    let environment = proxy.environment().to_vec();
    install_signal_forwarders()?;
    // Forked before the proxy has any threads, so the child reaches `execve` without a chance of
    // waiting on a lock that only existed in a thread that did not survive the fork.
    let workload = unsafe { libc::fork() };
    if workload < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if workload == 0 {
        reset_signal_handlers();
        let _ = unsafe { libc::setpgid(0, 0) };
        if let Err(error) = exec_target(command, &environment) {
            eprintln!("happy-agent-supervisor: failed to exec target: {error}");
        }
        unsafe { libc::_exit(126) };
    }
    set_forward_target(workload);
    proxy.serve()?;
    let status = wait_for_pid(workload)?;
    set_forward_target(0);
    if let Some((pid, link)) = egress_process {
        egress::close(link, pid);
    }
    let status = wait_status_to_workload_status(status).unwrap_or(WorkloadStatus {
        kind: STATUS_EXIT,
        value: 125,
    });
    reproduce_status(status)
}

/// Seatbelt profiles do not nest: `sandbox_init` inside an existing sandbox fails, and the
/// workload would then either die obscurely or, worse, run on with only the outer boundary. The
/// supervisor exists to be the boundary, so an enclosing sandbox is a setup error to report, not a
/// condition to work around.
fn refuse_nested_sandbox() -> SupervisorResult<()> {
    let already_sandboxed =
        unsafe { sandbox_check(std::process::id() as libc::pid_t, std::ptr::null(), 0) };
    if already_sandboxed != 0 {
        return Err(invalid_input(
            "this process is already inside a macOS Seatbelt sandbox, and Seatbelt profiles cannot be nested. Run the supervisor outside the enclosing sandbox rather than within it.",
        )
        .into());
    }
    Ok(())
}

fn apply_profile(profile: &str) -> SupervisorResult<()> {
    let profile = CString::new(profile)
        .map_err(|_| invalid_input("generated Seatbelt profile contains a NUL byte"))?;
    let mut error_buffer = std::ptr::null_mut();
    let result = unsafe { sandbox_init(profile.as_ptr(), 0, &mut error_buffer) };
    if result == 0 {
        return Ok(());
    }
    let message = if error_buffer.is_null() {
        "sandbox_init failed without an error message".to_string()
    } else {
        let message = unsafe { CStr::from_ptr(error_buffer) }
            .to_string_lossy()
            .into_owned();
        unsafe { sandbox_free_error(error_buffer) };
        message
    };
    Err(std::io::Error::other(message).into())
}

fn create_profile(
    policy: &SupervisorPolicy,
    cwd: &Path,
    front_end_ports: &[u16],
) -> SupervisorResult<String> {
    let denied_reads = normalized_paths(&policy.denied_read_paths)?;
    let denied_writes = normalized_paths(&policy.denied_write_paths)?;
    let writable_roots = normalized_paths(&policy.writable_roots(cwd))?;
    let file_read = access_rule("file-read*", &[PathBuf::from("/")], &denied_reads)?;
    let file_write = access_rule("file-write*", &writable_roots, &denied_writes)?;

    let mut sections = vec![
        "(version 1)".to_string(),
        "(deny default)".to_string(),
        "(allow process-exec process-fork)".to_string(),
        "(allow signal (target same-sandbox))".to_string(),
        "(allow process-info* (target same-sandbox))".to_string(),
        "(allow sysctl-read)".to_string(),
        "(allow file-write-data (literal \"/dev/null\"))".to_string(),
        file_read,
        file_write,
    ];
    if !front_end_ports.is_empty() {
        // Every destination is reached through the socketpair created before this profile existed,
        // so everything under it is given exactly one place to connect to and no name resolution at
        // all. Reads and writes on an established socket are not a Seatbelt operation, which is
        // what lets the link keep working under a profile that denies outbound connections.
        sections.push(
            "(allow system-socket (socket-domain AF_INET) (socket-domain AF_INET6))".to_string(),
        );
        for port in front_end_ports {
            sections.push(format!(
                "(allow network-outbound (remote ip \"localhost:{port}\"))"
            ));
            sections.push(format!(
                "(allow network-inbound (local ip \"localhost:{port}\"))"
            ));
        }
    } else if policy.network.egress {
        sections.extend([
            "(allow system-socket (socket-domain AF_INET) (socket-domain AF_INET6))".to_string(),
            "(allow network-outbound (remote ip \"*:*\"))".to_string(),
            "(allow network-outbound (remote unix-socket (literal \"/private/var/run/mDNSResponder\")))"
                .to_string(),
            "(allow network-outbound (remote unix-socket (literal \"/var/run/mDNSResponder\")))"
                .to_string(),
            "(allow mach-lookup\n  (global-name \"com.apple.dnssd.service\")\n  (global-name \"com.apple.SystemConfiguration.DNSConfiguration\")\n  (global-name \"com.apple.SystemConfiguration.configd\")\n  (global-name \"com.apple.nehelper\")\n  (global-name \"com.apple.nesessionmanager\")\n  (global-name \"com.apple.networkd\"))"
                .to_string(),
        ]);
    }
    if policy.network.local_binding {
        sections.extend([
            "(allow system-socket (socket-domain AF_INET) (socket-domain AF_INET6))".to_string(),
            "(allow network-bind (local ip \"*:*\") )".to_string(),
            "(allow network-inbound (local ip \"localhost:*\"))".to_string(),
        ]);
    }
    Ok(format!("{}\n", sections.join("\n")))
}

fn access_rule(
    operation: &str,
    roots: &[PathBuf],
    exclusions: &[PathBuf],
) -> SupervisorResult<String> {
    let mut matchers = Vec::new();
    for root in roots {
        let root = seatbelt_string(root)?;
        let mut requirements = vec![format!("(subpath {root})")];
        for exclusion in exclusions {
            let exclusion_regex = seatbelt_path_regex(exclusion)?;
            let exclusion = seatbelt_string(exclusion)?;
            requirements.push(format!("(require-not (literal {exclusion}))"));
            requirements.push(format!("(require-not (subpath {exclusion}))"));
            requirements.push(format!(r##"(require-not (regex #"{exclusion_regex}"))"##));
        }
        matchers.push(format!("  (require-all {})", requirements.join(" ")));
    }
    if matchers.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!("(allow {operation}\n{}\n)", matchers.join("\n")))
    }
}

fn normalized_paths(paths: &[PathBuf]) -> SupervisorResult<Vec<PathBuf>> {
    let mut normalized = Vec::new();
    for path in paths {
        let path = match path.canonicalize() {
            Ok(canonical) => canonical,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => path.clone(),
            Err(error) => return Err(error.into()),
        };
        if !normalized.iter().any(|existing| existing == &path) {
            normalized.push(path);
        }
    }
    Ok(normalized)
}

fn seatbelt_string(path: &Path) -> SupervisorResult<String> {
    let path = seatbelt_path(path)?;
    Ok(format!(
        "\"{}\"",
        path.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

fn seatbelt_path_regex(path: &Path) -> SupervisorResult<String> {
    let path = seatbelt_path(path)?;
    let path = path.trim_end_matches('/');
    let escaped = regex_lite::escape(if path.is_empty() { "/" } else { path }).replace('"', "\\\"");
    if path.is_empty() || path == "/" {
        Ok(format!(r"^{escaped}.*$"))
    } else {
        Ok(format!(r"^{escaped}(/.*)?$"))
    }
}

fn seatbelt_path(path: &Path) -> SupervisorResult<&str> {
    let path = path.to_str().ok_or_else(|| {
        invalid_input(format!(
            "Seatbelt path is not valid UTF-8: {}",
            path.display()
        ))
    })?;
    if path.chars().any(char::is_control) {
        return Err(invalid_input(format!(
            "Seatbelt path contains a control character: {}",
            Path::new(path).display()
        ))
        .into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::create_profile;
    use crate::policy::SupervisorPolicy;
    use std::path::Path;

    #[test]
    fn seatbelt_profile_never_embeds_a_shell_command() {
        let policy: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "workspace_write",
                "deniedWritePaths": ["/workspace/\"quoted\""],
                "network": {"egress": true, "localBinding": false}
            }"#,
        )
        .unwrap_or_else(|error| panic!("policy should parse: {error}"));
        let profile = create_profile(&policy, Path::new("/workspace"), &[])
            .unwrap_or_else(|error| panic!("profile should build: {error}"));

        assert!(profile.contains("(allow network-outbound (remote ip \"*:*\")"));
        assert!(!profile.contains("sh -"));
        assert!(profile.contains("\\\"quoted\\\""));
        assert!(profile.contains(r##"(regex #"^/workspace/"##));
    }

    #[test]
    fn a_proxied_profile_denies_every_destination_except_the_front_ends() {
        let policy: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "workspace_write",
                "network": {
                    "egress": true,
                    "allowedHosts": ["example.com"],
                    "localBinding": false,
                    "outgoingProxy": {"frontEnds": ["http", "socks5"]}
                }
            }"#,
        )
        .unwrap_or_else(|error| panic!("policy should parse: {error}"));
        let ports = [45_001_u16, 45_002];
        let profile = create_profile(&policy, Path::new("/workspace"), &ports)
            .unwrap_or_else(|error| panic!("profile should build: {error}"));

        assert!(!profile.contains("(remote ip \"*:*\")"));
        assert!(!profile.contains("mDNSResponder"));
        for port in ports {
            assert!(profile.contains(&format!(
                "(allow network-outbound (remote ip \"localhost:{port}\"))"
            )));
            assert!(profile.contains(&format!(
                "(allow network-inbound (local ip \"localhost:{port}\"))"
            )));
        }
    }
}
