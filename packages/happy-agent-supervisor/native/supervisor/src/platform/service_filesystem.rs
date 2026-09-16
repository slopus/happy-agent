//! An empty filesystem with explicit inputs, not a read-only view of the host.
use super::linux::{change_mount_read_only, deny_service_input_devices, syscall_zero};
use crate::service_policy::ServicePolicy;
use crate::{SupervisorResult, invalid_input};
use std::ffi::CString;
use std::fs::{self, File};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub(super) fn establish(policy: &ServicePolicy) -> SupervisorResult<()> {
    let metadata = fs::symlink_metadata(&policy.root)?;
    // UID 0 is the daemon's mapped UID inside the new user namespace.
    if !metadata.is_dir()
        || metadata.uid() != 0
        || metadata.mode() & 0o077 != 0
        || policy.root.canonicalize()? != policy.root
        || fs::read_dir(&policy.root)?.next().is_some()
    {
        return Err(invalid_input(
            "the service filesystem root must be empty, private, and daemon-owned",
        )
        .into());
    }
    mount_tmpfs(&policy.root, policy.memory_mi_b)?;
    for directory in ["workspace", "home/service", "tmp", "proc", "dev", "etc"] {
        fs::create_dir_all(policy.root.join(directory))?;
    }
    // Fixed system runtime: no user's home, general /etc, /var, daemon state, or shell profile.
    for runtime in [
        "/usr/bin",
        "/usr/lib",
        "/usr/lib64",
        "/usr/share/nodejs",
        "/usr/share/zoneinfo",
        "/bin",
        "/lib",
        "/lib64",
        "/etc/ld.so.cache",
        "/etc/ssl/certs",
    ] {
        let source = Path::new(runtime);
        if source.try_exists()? {
            bind_read_only(
                source,
                &policy.root.join(runtime.trim_start_matches('/')),
                false,
            )?;
        }
    }
    for device in ["null", "zero", "random", "urandom"] {
        bind_read_only(
            &Path::new("/dev").join(device),
            &policy.root.join("dev").join(device),
            false,
        )?;
    }
    for input in &policy.inputs {
        let destination = policy.root.join("workspace").join(&input.destination);
        reject_symlink_ancestors(&policy.root, &destination)?;
        bind_read_only(&input.source, &destination, true)?;
        deny_service_input_devices(&destination, true)?;
    }
    // Overlapping scratch needs an existing mount point in a read-only input.
    // Never create that point through the host input or grant host write access.
    let mut scratch_mounts = Vec::new();
    for scratch in &policy.scratch {
        let destination = policy.root.join("workspace").join(scratch);
        if !policy
            .inputs
            .iter()
            .any(|input| scratch.starts_with(&input.destination))
        {
            // No externally mutable input is a parent: this is controller-private storage.
            fs::create_dir_all(&destination)?;
        }
        let mount_point = open_path(&destination, true)?;
        if !mount_point.metadata()?.is_dir() {
            return Err(invalid_input("service scratch mount points must be directories").into());
        }
        scratch_mounts.push(mount_point);
    }
    change_mount_read_only(&policy.root, false, true)?;
    for scratch in &scratch_mounts {
        mount_tmpfs(&descriptor_path(scratch), policy.memory_mi_b)?;
    }
    for scratch in ["home/service", "tmp"] {
        mount_tmpfs(&policy.root.join(scratch), policy.memory_mi_b)?;
    }
    let root = CString::new(policy.root.as_os_str().as_bytes())?;
    syscall_zero("enter the private service filesystem", unsafe {
        libc::chroot(root.as_ptr())
    })?;
    // chroot does not move cwd. Leave the inherited host cwd before dropping capabilities.
    std::env::set_current_dir("/")?;
    std::env::set_current_dir(Path::new("/workspace").join(&policy.cwd))?;
    Ok(())
}

fn reject_symlink_ancestors(root: &Path, target: &Path) -> SupervisorResult<()> {
    let mut current = root.to_path_buf();
    for part in target.strip_prefix(root)?.components() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(
                    invalid_input("service mount destinations may not traverse symlinks").into(),
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn bind_read_only(source: &Path, target: &Path, no_symlinks: bool) -> SupervisorResult<()> {
    let source_handle = open_path(source, no_symlinks)?;
    let metadata = source_handle.metadata()?;
    if metadata.is_dir() {
        fs::create_dir_all(target)?;
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
    }
    let source = CString::new(descriptor_path(&source_handle).as_os_str().as_bytes())?;
    let destination = CString::new(target.as_os_str().as_bytes())?;
    syscall_zero("mount a read-only service input", unsafe {
        libc::mount(
            source.as_ptr(),
            destination.as_ptr(),
            std::ptr::null(),
            (libc::MS_BIND | if metadata.is_dir() { libc::MS_REC } else { 0 }) as libc::c_ulong,
            std::ptr::null(),
        )
    })?;
    change_mount_read_only(target, metadata.is_dir(), true)?;
    Ok(())
}

fn descriptor_path(file: &File) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

fn open_path(path: &Path, no_symlinks: bool) -> SupervisorResult<File> {
    let path = CString::new(path.as_os_str().as_bytes())?;
    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }
    let descriptor = if no_symlinks {
        let how = OpenHow {
            flags: (libc::O_PATH | libc::O_CLOEXEC) as u64,
            mode: 0,
            resolve: 0x02 | 0x04,
        };
        // Resolve the complete path without symlinks, then mount the held inode. A rename
        // between validation and mount cannot redirect a source or scratch mount outside.
        unsafe {
            libc::syscall(
                libc::SYS_openat2,
                libc::AT_FDCWD,
                path.as_ptr(),
                &how,
                std::mem::size_of::<OpenHow>(),
            )
        }
    } else {
        unsafe { libc::open(path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) as libc::c_long }
    };
    if descriptor < 0 {
        return Err(std::io::Error::other(format!(
            "open a pinned service mount path: {}",
            std::io::Error::last_os_error()
        ))
        .into());
    }
    Ok(unsafe { File::from_raw_fd(descriptor as libc::c_int) })
}

fn mount_tmpfs(target: &Path, memory_mib: u32) -> SupervisorResult<()> {
    let target = CString::new(target.as_os_str().as_bytes())?;
    let options = CString::new(format!("size={}m,mode=0755", memory_mib))?;
    syscall_zero("mount private service storage", unsafe {
        libc::mount(
            c"tmpfs".as_ptr(),
            target.as_ptr(),
            c"tmpfs".as_ptr(),
            (libc::MS_NOSUID | libc::MS_NODEV) as libc::c_ulong,
            options.as_ptr().cast(),
        )
    })?;
    Ok(())
}
