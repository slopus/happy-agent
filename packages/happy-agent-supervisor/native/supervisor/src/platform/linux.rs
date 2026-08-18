use crate::exec::exec_target;
use crate::platform::child::{
    STATUS_EXIT, WorkloadStatus, install_signal_forwarders, reproduce_status,
    reset_signal_handlers, set_forward_target, wait_for_pid, wait_status_to_workload_status,
};
use crate::policy::{PermissionMode, SupervisorPolicy};
use crate::proxy::{OutgoingProxy, egress};
use crate::{SupervisorResult, invalid_input};
use std::ffi::{CString, OsString};
use std::fs;
use std::fs::File;
use std::io::{Read, Write};
use std::mem::size_of;
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

const STATUS_MESSAGE_BYTES: usize = 5;
const MOUNT_ATTR_RDONLY: u64 = 0x0000_0001;
const AT_RECURSIVE: libc::c_int = 0x8000;
const SECCOMP_MODE_FILTER: libc::c_ulong = 2;
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JMP_JEQ_K: u16 = 0x15;
const BPF_RET_K: u16 = 0x06;
const SECBIT_NOROOT: libc::c_ulong = 1 << 0;
const SECBIT_NOROOT_LOCKED: libc::c_ulong = 1 << 1;
const SECBIT_NO_SETUID_FIXUP: libc::c_ulong = 1 << 2;
const SECBIT_NO_SETUID_FIXUP_LOCKED: libc::c_ulong = 1 << 3;
const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
const FORCE_LEGACY_REMOUNT: &str = "HAPPY_AGENT_SUPERVISOR_FORCE_LEGACY_REMOUNT";
#[repr(C)]
struct MountAttributes {
    attr_set: u64,
    attr_clear: u64,
    propagation: u64,
    user_namespace_fd: u64,
}

#[repr(C)]
struct CapabilityHeader {
    version: u32,
    pid: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CapabilityData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

type OutgoingProxySetup = Option<OutgoingProxy>;

pub(crate) fn run(policy: SupervisorPolicy, command: Vec<OsString>) -> SupervisorResult<()> {
    enter_user_namespace()?;
    // Hardening follows the user namespace rather than preceding it. Marking the process
    // non-dumpable changes who may inspect it, and the identity mapping written immediately before
    // this is exactly the kind of write that governs. Nothing has forked yet, so everything below
    // inherits the hardening anyway.
    crate::hardening::apply()?;
    // A configured proxy isolates the network exactly as hard as no egress at all. The egress
    // process is forked here, before any namespace is unshared, so it keeps the original network
    // namespace while everything below shares an empty one. Its socketpair is created with it, and
    // a socketpair is unaffected by the unshare that follows.
    let egress = match &policy.network.outgoing_proxy {
        Some(_) => Some(egress::start(&policy.network.allowed_hosts)?),
        None => None,
    };
    let egress_pid = egress.as_ref().map(|egress| egress.pid);
    let egress_link = egress.map(|egress| egress.link);
    let isolate_network = !policy.network.egress || policy.network.outgoing_proxy.is_some();
    let namespace_flags = libc::CLONE_NEWNS
        | libc::CLONE_NEWPID
        | if isolate_network {
            libc::CLONE_NEWNET
        } else {
            0
        };
    syscall_zero("unshare mount, PID, and network namespaces", unsafe {
        libc::unshare(namespace_flags)
    })?;
    make_mounts_private()?;
    if isolate_network {
        bring_loopback_up()?;
    }

    let (status_read, status_write) = create_pipe()?;
    install_signal_forwarders()?;
    let namespace_init = unsafe { libc::fork() };
    if namespace_init < 0 {
        close_fd(status_read);
        close_fd(status_write);
        return Err(std::io::Error::last_os_error().into());
    }
    if namespace_init == 0 {
        close_fd(status_read);
        run_namespace_init(policy, command, status_write, egress_link);
    }

    close_fd(status_write);
    // Only the namespace init keeps the link now, so its exit is what the egress process sees.
    drop(egress_link);
    set_forward_target(namespace_init);
    drop_all_capabilities_and_lock_privileges()?;
    let init_wait_status = wait_for_pid(namespace_init)?;
    set_forward_target(0);
    if let Some(pid) = egress_pid {
        egress::stop(pid);
    }
    let workload_status = read_status(status_read).unwrap_or_else(|| {
        wait_status_to_workload_status(init_wait_status).unwrap_or(WorkloadStatus {
            kind: STATUS_EXIT,
            value: 125,
        })
    });
    reproduce_status(workload_status)
}

fn run_namespace_init(
    policy: SupervisorPolicy,
    command: Vec<OsString>,
    status_write: RawFd,
    egress_link: Option<File>,
) -> ! {
    let setup = (|| -> SupervisorResult<OutgoingProxySetup> {
        syscall_zero("terminate namespace init if its supervisor exits", unsafe {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0)
        })?;
        mount_private_procfs()?;
        apply_filesystem_policy(&policy)?;
        // The front-end listeners are bound here, before the filter below denies `bind` and
        // `listen` for everything that runs afterwards, so serving them re-opens nothing.
        let proxy = match &policy.network.outgoing_proxy {
            Some(proxy) => {
                let link = egress_link.ok_or_else(|| {
                    invalid_input("the outgoing proxy has no link to its egress process")
                })?;
                Some(crate::proxy::prepare(proxy, link)?)
            }
            None => None,
        };
        if !policy.network.local_binding {
            install_local_binding_filter()?;
        }
        drop_all_capabilities_and_lock_privileges()?;
        Ok(proxy)
    })();
    let proxy = match setup {
        Ok(proxy) => proxy,
        Err(error) => {
            eprintln!("happy-agent-supervisor: Linux sandbox setup failed: {error}");
            write_status(
                status_write,
                WorkloadStatus {
                    kind: STATUS_EXIT,
                    value: 125,
                },
            );
            unsafe { libc::_exit(0) };
        }
    };
    let proxy_environment = proxy
        .as_ref()
        .map(|proxy| proxy.environment().to_vec())
        .unwrap_or_default();

    // The workload is forked while this process is still single-threaded, so the proxy's threads
    // cannot be holding an allocator lock when the child runs its way to `execve`.
    let workload = unsafe { libc::fork() };
    if workload < 0 {
        eprintln!(
            "happy-agent-supervisor: failed to fork workload: {}",
            std::io::Error::last_os_error()
        );
        write_status(
            status_write,
            WorkloadStatus {
                kind: STATUS_EXIT,
                value: 125,
            },
        );
        unsafe { libc::_exit(0) };
    }
    if workload == 0 {
        close_fd(status_write);
        reset_signal_handlers();
        let _ = unsafe { libc::setpgid(0, 0) };
        if let Err(error) = exec_target(&command, &proxy_environment) {
            eprintln!("happy-agent-supervisor: failed to exec target: {error}");
        }
        unsafe { libc::_exit(126) };
    }

    set_forward_target(workload);
    // A failure here leaves the front-ends bound but unserved, and dropping the listeners is what
    // turns that into a refused connection rather than a workload waiting forever.
    if let Some(proxy) = proxy
        && let Err(error) = proxy.serve()
    {
        eprintln!("happy-agent-supervisor: failed to serve the outgoing proxy: {error}");
    }
    let status = match wait_for_pid(workload) {
        Ok(status) => wait_status_to_workload_status(status).unwrap_or(WorkloadStatus {
            kind: STATUS_EXIT,
            value: 125,
        }),
        Err(error) => {
            eprintln!("happy-agent-supervisor: failed to wait for target: {error}");
            WorkloadStatus {
                kind: STATUS_EXIT,
                value: 125,
            }
        }
    };
    set_forward_target(0);
    write_status(status_write, status);
    unsafe { libc::_exit(0) };
}

fn enter_user_namespace() -> SupervisorResult<()> {
    let original_uid = unsafe { libc::geteuid() };
    let original_gid = unsafe { libc::getegid() };
    syscall_zero("create user namespace", unsafe {
        libc::unshare(libc::CLONE_NEWUSER)
    })?;
    match fs::write("/proc/self/setgroups", b"deny\n") {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::write("/proc/self/uid_map", format!("0 {original_uid} 1\n"))?;
    fs::write("/proc/self/gid_map", format!("0 {original_gid} 1\n"))?;
    syscall_zero("assume namespace group ID 0", unsafe {
        libc::setresgid(0, 0, 0)
    })?;
    syscall_zero("assume namespace user ID 0", unsafe {
        libc::setresuid(0, 0, 0)
    })?;
    Ok(())
}

fn make_mounts_private() -> SupervisorResult<()> {
    let root = c_path(Path::new("/"))?;
    syscall_zero("make mount propagation private", unsafe {
        libc::mount(
            std::ptr::null(),
            root.as_ptr(),
            std::ptr::null(),
            (libc::MS_REC | libc::MS_PRIVATE) as libc::c_ulong,
            std::ptr::null(),
        )
    })?;
    Ok(())
}

fn mount_private_procfs() -> SupervisorResult<()> {
    let proc_path = c_path(Path::new("/proc"))?;
    let proc_type = c"proc";
    // Mount directly over the inherited procfs. Mounts inherited by a less-privileged user
    // namespace are locked, so detaching `/proc` would always fail with EINVAL. This process is
    // PID 1 in the PID namespace created immediately before the fork, which lets the new procfs
    // expose only that namespace while the overmount hides Docker's inherited procfs and masks.
    syscall_zero("mount private procfs", unsafe {
        libc::mount(
            proc_type.as_ptr(),
            proc_path.as_ptr(),
            proc_type.as_ptr(),
            (libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC) as libc::c_ulong,
            std::ptr::null(),
        )
    })?;
    Ok(())
}

fn apply_filesystem_policy(policy: &SupervisorPolicy) -> SupervisorResult<()> {
    if policy.mode == PermissionMode::FullAccess {
        return Ok(());
    }
    let cwd = std::env::current_dir()?.canonicalize()?;
    let writable_roots = canonical_existing_paths(&policy.writable_roots(&cwd), "writable")?;
    let denied_writes = canonical_existing_paths(&policy.denied_write_paths, "write-denied")?;
    let denied_reads = canonical_optional_paths(&policy.denied_read_paths)?;

    // Bind mounts are used instead of Landlock because a Landlock grant on a writable workspace
    // cannot carve out a denied child such as `.git`. A read-only recursive root plus explicit
    // writable overlays and final deny overlays preserves "denial wins" without that gap.
    bind_mount(Path::new("/"), true)?;
    change_mount_read_only(Path::new("/"), true, true)?;
    for path in &writable_roots {
        let recursive = path.is_dir();
        bind_mount(path, recursive)?;
        change_mount_read_only(path, recursive, false)?;
    }
    for path in &denied_writes {
        let recursive = path.is_dir();
        bind_mount(path, recursive)?;
        change_mount_read_only(path, recursive, true)?;
    }
    for path in &denied_reads {
        mask_read_path(path)?;
    }
    // Binding a mount over a directory does not move a process that is already standing in it: the
    // inherited working directory still refers to the shadowed directory underneath, which is part
    // of the read-only root. Without this the workload can write `/work/file` but not `./file`,
    // which is how almost every command actually writes.
    std::env::set_current_dir(&cwd).map_err(|error| {
        std::io::Error::other(format!(
            "re-enter the working directory {} after mounting the workspace: {error}",
            cwd.display()
        ))
    })?;
    Ok(())
}

fn canonical_existing_paths(
    paths: &[PathBuf],
    description: &str,
) -> SupervisorResult<Vec<PathBuf>> {
    let mut result = Vec::new();
    for path in paths {
        let canonical = path.canonicalize().map_err(|error| {
            invalid_input(format!(
                "{description} path must exist before sandbox setup ({}): {error}",
                path.display()
            ))
        })?;
        if !result.iter().any(|existing| existing == &canonical) {
            result.push(canonical);
        }
    }
    Ok(result)
}

fn canonical_optional_paths(paths: &[PathBuf]) -> SupervisorResult<Vec<PathBuf>> {
    let mut result = Vec::new();
    for path in paths {
        let canonical = match path.canonicalize() {
            Ok(canonical) => canonical,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if !result.iter().any(|existing| existing == &canonical) {
            result.push(canonical);
        }
    }
    // A directory mask already denies every descendant. Keeping a nested target would make setup
    // fail after the parent is masked because that child no longer exists in the mount namespace.
    // Sort first so an ancestor wins regardless of the order in the policy.
    result.sort_by(|left, right| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| left.cmp(right))
    });
    let mut collapsed: Vec<PathBuf> = Vec::with_capacity(result.len());
    for path in result {
        if collapsed
            .iter()
            .any(|ancestor| ancestor.is_dir() && path.starts_with(ancestor))
        {
            continue;
        }
        collapsed.push(path);
    }
    Ok(collapsed)
}

fn bind_mount(path: &Path, recursive: bool) -> SupervisorResult<()> {
    let path = c_path(path)?;
    let flags = libc::MS_BIND | if recursive { libc::MS_REC } else { 0 };
    syscall_zero("create filesystem bind mount", unsafe {
        libc::mount(
            path.as_ptr(),
            path.as_ptr(),
            std::ptr::null(),
            flags as libc::c_ulong,
            std::ptr::null(),
        )
    })?;
    Ok(())
}

fn change_mount_read_only(path: &Path, recursive: bool, read_only: bool) -> SupervisorResult<()> {
    // Every kernel this is developed and tested on has mount_setattr, so the pre-5.12 path would
    // otherwise never execute anywhere it could be observed. This switch lets the behaviour tests
    // drive the real binary down the fallback. It cannot weaken the boundary: the fallback is the
    // same enforcement by older means, and it fails closed on anything it cannot express.
    if std::env::var_os(FORCE_LEGACY_REMOUNT).is_some() {
        return change_mount_read_only_by_remount(path, recursive, read_only);
    }
    let target = c_path(path)?;
    match change_mount_read_only_by_attribute(&target, recursive, read_only) {
        Ok(()) => Ok(()),
        // mount_setattr(2) is Linux 5.12 and newer, and QEMU user emulation does not translate it
        // either. The detection has to be a runtime ENOSYS check rather than a build-time one,
        // because the same binary is shipped to every kernel the agent might land on.
        Err(error) if error.raw_os_error() == Some(libc::ENOSYS) => {
            change_mount_read_only_by_remount(path, recursive, read_only)
        }
        Err(error) => Err(std::io::Error::other(format!(
            "mount_setattr failed for {}: {error}",
            path.display()
        ))
        .into()),
    }
}

fn change_mount_read_only_by_attribute(
    path: &CString,
    recursive: bool,
    read_only: bool,
) -> std::io::Result<()> {
    let attributes = MountAttributes {
        attr_set: if read_only { MOUNT_ATTR_RDONLY } else { 0 },
        attr_clear: if read_only { 0 } else { MOUNT_ATTR_RDONLY },
        propagation: 0,
        user_namespace_fd: 0,
    };
    let flags = if recursive { AT_RECURSIVE } else { 0 };
    let result = unsafe {
        libc::syscall(
            libc::SYS_mount_setattr,
            libc::AT_FDCWD,
            path.as_ptr(),
            flags,
            &attributes,
            size_of::<MountAttributes>(),
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Bind remount is the pre-5.12 equivalent of `mount_setattr`, and it is neither recursive nor
/// able to name a mount other than by path, so the subtree has to be walked by hand.
///
/// Two things make that harder than it sounds, and both were learned from real kernels rather than
/// from the manual page. Mountinfo lists mounts that the process can no longer reach — the
/// inherited procfs and its children survive in the list after a private one is mounted over
/// `/proc` — and mountinfo order is not stacking order, because overmounting `/` does not move a
/// process whose root is the mount underneath. So the list is treated as a set of candidate paths
/// and the kernel is asked about each one, rather than the tree being reconstructed from the file.
///
/// `EINVAL` from the remount is the kernel saying no mount is rooted at that path, which happens
/// exactly for the shadowed entries; whatever covers that path is reached at its own path instead.
/// That one error is skipped. Every other failure, and a requested path that is not a mount root at
/// all, fails closed.
fn change_mount_read_only_by_remount(
    path: &Path,
    recursive: bool,
    read_only: bool,
) -> SupervisorResult<()> {
    let mut targets: Vec<MountPoint> = Vec::new();
    for mount in read_mount_points()? {
        let matches = if recursive {
            mount.path.starts_with(path)
        } else {
            mount.path == path
        };
        if !matches {
            continue;
        }
        match targets.iter_mut().find(|target| target.path == mount.path) {
            // Duplicate entries for one path are copies of a single mount, or a fresh filesystem
            // laid over the one it replaces. Taking the union of their restrictions cannot drop a
            // flag the owning user namespace locked, whichever of them the path resolves to.
            Some(existing) => existing.flags |= mount.flags,
            None => targets.push(mount),
        }
    }
    if !targets.iter().any(|target| target.path == path) {
        return Err(std::io::Error::other(format!(
            "no mount point found for {} in /proc/self/mountinfo, so its read-only state cannot be changed without mount_setattr",
            path.display()
        ))
        .into());
    }
    targets.sort_by(|left, right| left.path.cmp(&right.path));
    for target in &targets {
        // The live state comes from the kernel, not from mountinfo, because mountinfo may be
        // describing a mount this process can no longer reach at that path.
        if live_mount_is_read_only(&target.path)? == read_only {
            continue;
        }
        let mut flags = libc::MS_REMOUNT | libc::MS_BIND | target.flags;
        if read_only {
            flags |= libc::MS_RDONLY;
        }
        let target_path = c_path(&target.path)?;
        let result = unsafe {
            libc::mount(
                std::ptr::null(),
                target_path.as_ptr(),
                std::ptr::null(),
                flags as libc::c_ulong,
                std::ptr::null(),
            )
        };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINVAL) && target.path != path {
                continue;
            }
            return Err(std::io::Error::other(format!(
                "bind remount failed for {}: {error}",
                target.path.display()
            ))
            .into());
        }
    }
    Ok(())
}

fn live_mount_is_read_only(path: &Path) -> SupervisorResult<bool> {
    let target = c_path(path)?;
    let mut statistics = unsafe { std::mem::zeroed::<libc::statfs>() };
    syscall_zero("read live mount flags", unsafe {
        libc::statfs(target.as_ptr(), &mut statistics)
    })?;
    Ok(statistics.f_flags & libc::ST_RDONLY != 0)
}

struct MountPoint {
    path: PathBuf,
    flags: libc::c_ulong,
}

fn read_mount_points() -> SupervisorResult<Vec<MountPoint>> {
    let contents = fs::read_to_string("/proc/self/mountinfo")?;
    let mut result = Vec::new();
    for line in contents.lines() {
        let mut fields = line.split(' ');
        // mountinfo is `id parent major:minor root mountPoint options ...`.
        let (Some(path), Some(options)) = (fields.nth(4), fields.next()) else {
            return Err(std::io::Error::other(format!(
                "unreadable /proc/self/mountinfo line: {line}"
            ))
            .into());
        };
        result.push(MountPoint {
            path: unescape_mount_field(path),
            flags: mount_option_flags(options),
        });
    }
    Ok(result)
}

fn unescape_mount_field(value: &str) -> PathBuf {
    let bytes = value.as_bytes();
    let mut unescaped = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        // mountinfo escapes space, tab, newline and backslash as three octal digits.
        if bytes[index] == b'\\' && index + 3 < bytes.len() {
            let digits = &bytes[index + 1..index + 4];
            if let Ok(byte) = u8::from_str_radix(std::str::from_utf8(digits).unwrap_or("x"), 8) {
                unescaped.push(byte);
                index += 4;
                continue;
            }
        }
        unescaped.push(bytes[index]);
        index += 1;
    }
    PathBuf::from(OsString::from_vec(unescaped))
}

fn mount_option_flags(options: &str) -> libc::c_ulong {
    let mut flags: libc::c_ulong = 0;
    let mut explicit_atime = false;
    for option in options.split(',') {
        match option {
            "nosuid" => flags |= libc::MS_NOSUID,
            "nodev" => flags |= libc::MS_NODEV,
            "noexec" => flags |= libc::MS_NOEXEC,
            "sync" => flags |= libc::MS_SYNCHRONOUS,
            "mand" => flags |= libc::MS_MANDLOCK,
            "dirsync" => flags |= libc::MS_DIRSYNC,
            "nosymfollow" => flags |= libc::MS_NOSYMFOLLOW,
            "nodiratime" => flags |= libc::MS_NODIRATIME,
            "noatime" => {
                flags |= libc::MS_NOATIME;
                explicit_atime = true;
            }
            "relatime" => {
                flags |= libc::MS_RELATIME;
                explicit_atime = true;
            }
            "strictatime" => {
                flags |= libc::MS_STRICTATIME;
                explicit_atime = true;
            }
            "iversion" => flags |= libc::MS_I_VERSION,
            "lazytime" => flags |= libc::MS_LAZYTIME,
            _ => {}
        }
    }
    if !explicit_atime {
        // An absent atime option means strict atime, and the kernel treats a remount that names no
        // atime behaviour as a request to keep the current one only when it is spelled out.
        flags |= libc::MS_STRICTATIME;
    }
    flags
}

fn mask_read_path(path: &Path) -> SupervisorResult<()> {
    let target = c_path(path)?;
    if path.is_dir() {
        let source = c"tmpfs";
        let data = c"size=0,mode=000";
        syscall_zero("mask read-denied directory", unsafe {
            libc::mount(
                source.as_ptr(),
                target.as_ptr(),
                source.as_ptr(),
                (libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC)
                    as libc::c_ulong,
                data.as_ptr().cast(),
            )
        })?;
    } else {
        let source = c"/dev/null";
        syscall_zero("mask read-denied file", unsafe {
            libc::mount(
                source.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                libc::MS_BIND as libc::c_ulong,
                std::ptr::null(),
            )
        })?;
        change_mount_read_only(path, false, true)?;
    }
    Ok(())
}

fn bring_loopback_up() -> SupervisorResult<()> {
    let socket = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    if socket < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut request = unsafe { std::mem::zeroed::<libc::ifreq>() };
    for (index, byte) in b"lo".iter().copied().enumerate() {
        request.ifr_name[index] = byte as libc::c_char;
    }
    if unsafe { libc::ioctl(socket, libc::SIOCGIFFLAGS as libc::Ioctl, &mut request) } < 0 {
        let error = std::io::Error::last_os_error();
        close_fd(socket);
        return Err(error.into());
    }
    let current_flags = unsafe { request.ifr_ifru.ifru_flags };
    request.ifr_ifru.ifru_flags = current_flags | libc::IFF_UP as libc::c_short;
    if unsafe { libc::ioctl(socket, libc::SIOCSIFFLAGS as libc::Ioctl, &request) } < 0 {
        let error = std::io::Error::last_os_error();
        close_fd(socket);
        return Err(error.into());
    }
    close_fd(socket);
    Ok(())
}

fn install_local_binding_filter() -> SupervisorResult<()> {
    #[cfg(target_arch = "x86_64")]
    const AUDIT_ARCH: u32 = 0xc000_003e;
    #[cfg(target_arch = "aarch64")]
    const AUDIT_ARCH: u32 = 0xc000_00b7;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    compile_error!("Linux seccomp supports only x86_64 and aarch64");

    let mut instructions = [
        bpf(BPF_LD_W_ABS, 0, 0, 4),
        bpf(BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH),
        bpf(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
        bpf(BPF_LD_W_ABS, 0, 0, 0),
        bpf(BPF_JMP_JEQ_K, 0, 1, libc::SYS_bind as u32),
        bpf(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | libc::EPERM as u32),
        bpf(BPF_JMP_JEQ_K, 0, 1, libc::SYS_listen as u32),
        bpf(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | libc::EPERM as u32),
        bpf(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW),
    ];
    let program = libc::sock_fprog {
        len: instructions.len() as u16,
        filter: instructions.as_mut_ptr(),
    };
    let result = unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            SECCOMP_MODE_FILTER,
            &program as *const libc::sock_fprog,
            0,
            0,
        )
    };
    if result != 0 {
        return Err(std::io::Error::other(format!(
            "install seccomp filter denying bind and listen: {}",
            std::io::Error::last_os_error()
        ))
        .into());
    }
    Ok(())
}

const fn bpf(code: u16, jump_true: u8, jump_false: u8, value: u32) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt: jump_true,
        jf: jump_false,
        k: value,
    }
}

fn drop_all_capabilities_and_lock_privileges() -> SupervisorResult<()> {
    let cap_last = fs::read_to_string("/proc/sys/kernel/cap_last_cap")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(63);
    let _ = unsafe {
        libc::prctl(
            libc::PR_CAP_AMBIENT,
            libc::PR_CAP_AMBIENT_CLEAR_ALL,
            0,
            0,
            0,
        )
    };
    for capability in 0..=cap_last {
        let result = unsafe { libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EINVAL) {
                return Err(error.into());
            }
        }
    }
    let secure_bits = SECBIT_NOROOT
        | SECBIT_NOROOT_LOCKED
        | SECBIT_NO_SETUID_FIXUP
        | SECBIT_NO_SETUID_FIXUP_LOCKED;
    syscall_zero("lock securebits", unsafe {
        libc::prctl(libc::PR_SET_SECUREBITS, secure_bits, 0, 0, 0)
    })?;
    let header = CapabilityHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let data = [CapabilityData {
        effective: 0,
        permitted: 0,
        inheritable: 0,
    }; 2];
    let result = unsafe { libc::syscall(libc::SYS_capset, &header, data.as_ptr()) };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    syscall_zero("set no_new_privs", unsafe {
        libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
    })?;
    Ok(())
}

fn create_pipe() -> SupervisorResult<(RawFd, RawFd)> {
    let mut descriptors = [-1, -1];
    if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok((descriptors[0], descriptors[1]))
}

fn write_status(descriptor: RawFd, status: WorkloadStatus) {
    let mut bytes = [0_u8; STATUS_MESSAGE_BYTES];
    bytes[0] = status.kind;
    bytes[1..].copy_from_slice(&status.value.to_ne_bytes());
    let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
    let _ = file.write_all(&bytes);
}

fn read_status(descriptor: RawFd) -> Option<WorkloadStatus> {
    let mut bytes = [0_u8; STATUS_MESSAGE_BYTES];
    let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
    file.read_exact(&mut bytes).ok()?;
    Some(WorkloadStatus {
        kind: bytes[0],
        value: i32::from_ne_bytes(bytes[1..].try_into().ok()?),
    })
}

fn close_fd(descriptor: RawFd) {
    if descriptor >= 0 {
        unsafe {
            libc::close(descriptor);
        }
    }
}

fn c_path(path: &Path) -> SupervisorResult<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| invalid_input(format!("path contains a NUL byte: {}", path.display())).into())
}

fn syscall_zero(description: &str, result: libc::c_int) -> SupervisorResult<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "{description}: {}",
            std::io::Error::last_os_error()
        ))
        .into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_denials_collapse_descendants_of_a_denied_directory() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("temporary root: {error}"));
        let denied = root.path().join("denied");
        let nested = denied.join("credential");
        fs::create_dir(&denied).unwrap_or_else(|error| panic!("denied directory: {error}"));
        fs::write(&nested, "secret").unwrap_or_else(|error| panic!("nested credential: {error}"));

        let paths = canonical_optional_paths(&[nested, denied.clone()])
            .unwrap_or_else(|error| panic!("canonical denied paths: {error}"));

        assert_eq!(
            paths,
            vec![
                denied
                    .canonicalize()
                    .unwrap_or_else(|error| panic!("canonical denied directory: {error}"))
            ]
        );
    }

    #[test]
    fn legacy_remount_preserves_existing_mount_restrictions() {
        let flags = mount_option_flags(
            "rw,nosuid,nodev,noexec,sync,mand,dirsync,nosymfollow,noatime,nodiratime,iversion,lazytime",
        );
        let expected = libc::MS_NOSUID
            | libc::MS_NODEV
            | libc::MS_NOEXEC
            | libc::MS_SYNCHRONOUS
            | libc::MS_MANDLOCK
            | libc::MS_DIRSYNC
            | libc::MS_NOSYMFOLLOW
            | libc::MS_NOATIME
            | libc::MS_NODIRATIME
            | libc::MS_I_VERSION
            | libc::MS_LAZYTIME;

        assert_eq!(flags, expected);
    }
}
