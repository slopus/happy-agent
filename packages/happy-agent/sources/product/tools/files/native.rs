use anyhow::{Context, Result, ensure};
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};

pub(super) const MAX_TEXT_BYTES: usize = 44 * 1024 * 1024;

#[cfg(unix)]
pub(super) fn write_direct(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let (directory, name) = parent(path, false)?;
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o666,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut file = unsafe { File::from_raw_fd(descriptor) };
    file.write_all(bytes)?;
    Ok(())
}
#[cfg(unix)]
pub(super) fn mkdir(path: &Path, recursive: bool) -> Result<()> {
    use std::os::fd::AsRawFd;
    if recursive && path.is_dir() {
        return Ok(());
    }
    let (directory, name) = parent(path, recursive)?;
    if unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o777) } < 0 {
        let error = std::io::Error::last_os_error();
        if recursive && error.kind() == std::io::ErrorKind::AlreadyExists {
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    metadata.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } == 0
                && unsafe { metadata.assume_init() }.st_mode & libc::S_IFMT == libc::S_IFDIR
            {
                return Ok(());
            }
        }
        return Err(error.into());
    }
    Ok(())
}
#[cfg(unix)]
pub(super) fn chmod(path: &Path, mode: u32) -> Result<()> {
    use std::os::fd::AsRawFd;
    let (directory, name) = parent(path, false)?;
    if unsafe {
        libc::fchmodat(
            directory.as_raw_fd(),
            name.as_ptr(),
            mode as libc::mode_t,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } < 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(unix)]
pub(super) fn rename(source: &Path, destination: &Path) -> Result<()> {
    use std::os::fd::AsRawFd;
    let (from, name) = parent(source, false)?;
    let (to, target) = parent(destination, false)?;
    if unsafe {
        libc::renameat(
            from.as_raw_fd(),
            name.as_ptr(),
            to.as_raw_fd(),
            target.as_ptr(),
        )
    } < 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(unix)]
pub(super) fn set_modified(path: &Path, milliseconds: f64) -> Result<()> {
    use std::os::fd::AsRawFd;
    ensure!(
        milliseconds.is_finite(),
        "The file modification time is invalid."
    );
    let (directory, name) = parent(path, false)?;
    let seconds = (milliseconds / 1000.0).floor();
    ensure!(
        seconds >= libc::time_t::MIN as f64 && seconds <= libc::time_t::MAX as f64,
        "The file modification time is out of range."
    );
    let times = [
        libc::timespec {
            tv_sec: 0,
            tv_nsec: libc::UTIME_OMIT,
        },
        libc::timespec {
            tv_sec: seconds as libc::time_t,
            tv_nsec: ((milliseconds / 1000.0 - seconds) * 1e9).floor() as libc::c_long,
        },
    ];
    if unsafe {
        libc::utimensat(
            directory.as_raw_fd(),
            name.as_ptr(),
            times.as_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } < 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(unix)]
pub(super) fn remove_tree(
    path: &Path,
    recursive: bool,
    force: bool,
    boundary: &super::Boundary,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<()> {
    use std::os::fd::AsRawFd;
    ensure!(
        !cancel.is_cancelled(),
        "The filesystem operation was interrupted."
    );
    boundary.target(
        path.to_str().context("The removed path is not UTF-8.")?,
        true,
    )?;
    let (directory, name) = match parent(path, false) {
        Ok(value) => value,
        Err(error)
            if force
                && error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } < 0
    {
        let error = std::io::Error::last_os_error();
        if force && error.kind() == std::io::ErrorKind::NotFound {
            return Ok(());
        }
        return Err(error.into());
    }
    let is_directory = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT == libc::S_IFDIR;
    if is_directory && !recursive {
        return Err(std::io::Error::from(std::io::ErrorKind::IsADirectory).into());
    }
    if is_directory {
        let descriptor = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let stream = unsafe { libc::fdopendir(descriptor) };
        if stream.is_null() {
            unsafe {
                libc::close(descriptor);
            };
            return Err(std::io::Error::last_os_error().into());
        }
        struct Directory(*mut libc::DIR);
        impl Drop for Directory {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let stream = Directory(stream);
        loop {
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                break;
            }
            let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            use std::os::unix::ffi::OsStrExt;
            remove_tree(
                &path.join(std::ffi::OsStr::from_bytes(name.to_bytes())),
                true,
                force,
                boundary,
                cancel,
            )?;
        }
    }
    if unsafe {
        libc::unlinkat(
            directory.as_raw_fd(),
            name.as_ptr(),
            if is_directory { libc::AT_REMOVEDIR } else { 0 },
        )
    } < 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(not(unix))]
pub(super) fn write_direct(_path: &Path, _bytes: &[u8]) -> Result<()> {
    anyhow::bail!("Native runner file changes require a supported filesystem boundary.")
}
#[cfg(not(unix))]
pub(super) fn mkdir(_path: &Path, _recursive: bool) -> Result<()> {
    anyhow::bail!("Native runner file changes require a supported filesystem boundary.")
}
#[cfg(not(unix))]
pub(super) fn chmod(_path: &Path, _mode: u32) -> Result<()> {
    anyhow::bail!("Native runner file changes require a supported filesystem boundary.")
}
#[cfg(not(unix))]
pub(super) fn rename(_source: &Path, _destination: &Path) -> Result<()> {
    anyhow::bail!("Native runner file changes require a supported filesystem boundary.")
}
#[cfg(not(unix))]
pub(super) fn set_modified(_path: &Path, _milliseconds: f64) -> Result<()> {
    anyhow::bail!("Native runner file changes require a supported filesystem boundary.")
}
#[cfg(not(unix))]
pub(super) fn remove_tree(
    _path: &Path,
    _recursive: bool,
    _force: bool,
    _boundary: &super::Boundary,
    _cancel: &tokio_util::sync::CancellationToken,
) -> Result<()> {
    anyhow::bail!("Native runner file changes require a supported filesystem boundary.")
}

/// Open every resolved component through an owned directory descriptor. A
/// substituted symlink cannot redirect an operation after boundary review.
#[cfg(unix)]
fn parent(path: &Path, create: bool) -> Result<(File, std::ffi::CString)> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    };
    ensure!(path.is_absolute(), "The file path must be absolute.");
    let mut directory = File::open("/")?;
    let components = path
        .components()
        .filter_map(|part| match part {
            std::path::Component::Normal(name) => Some(name),
            _ => None,
        })
        .collect::<Vec<_>>();
    let (name, parents) = components
        .split_last()
        .context("The operation requires a file name.")?;
    for name in parents {
        let name = std::ffi::CString::new(name.as_bytes())?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut descriptor = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if descriptor < 0
            && create
            && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound
        {
            let result = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o777) };
            if result < 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(std::io::Error::last_os_error().into());
            }
            descriptor = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        }
        ensure!(
            descriptor >= 0,
            "The parent directory changed or cannot be opened safely: {}: {}.",
            path.display(),
            std::io::Error::last_os_error()
        );
        directory = unsafe { File::from_raw_fd(descriptor) };
    }
    Ok((directory, std::ffi::CString::new(name.as_bytes())?))
}

#[cfg(unix)]
pub(super) fn open(path: &Path) -> Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let (directory, name) = parent(path, false)?;
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    ensure!(
        descriptor >= 0,
        "The file cannot be opened safely: {}: {}.",
        path.display(),
        std::io::Error::last_os_error()
    );
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(not(unix))]
pub(super) fn open(path: &Path) -> Result<File> {
    Ok(File::open(path)?)
}

pub(super) fn read(path: &Path, limit: usize) -> Result<(Vec<u8>, std::fs::Metadata)> {
    let file = open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file(),
        "This path is not an ordinary file: {}.",
        path.display()
    );
    ensure!(
        metadata.len() <= limit as u64,
        "The file exceeds the {} byte limit.",
        limit
    );
    let mut bytes = Vec::with_capacity((metadata.len() as usize).min(limit));
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= limit,
        "The file exceeds the {} byte limit.",
        limit
    );
    Ok((bytes, metadata))
}

/// Stage beside the target and replace its directory entry atomically. This
/// preserves existing mode bits and never truncates an aliased hard link.
#[cfg(unix)]
pub(super) fn write(path: &Path, bytes: &[u8], expected: Option<&std::fs::Metadata>) -> Result<()> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    };
    let (directory, name) = parent(path, true)?;
    let temporary = std::ffi::CString::new(format!(".happy-edit-{}.tmp", uuid::Uuid::new_v4()))?;
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o666,
        )
    };
    ensure!(
        descriptor >= 0,
        "The staged file cannot be created: {}.",
        std::io::Error::last_os_error()
    );
    let result = (|| {
        let mut file = unsafe { File::from_raw_fd(descriptor) };
        if let Some(metadata) = expected {
            ensure!(
                unsafe {
                    libc::fchmod(file.as_raw_fd(), (metadata.mode() & 0o7777) as libc::mode_t)
                } == 0,
                "The existing file permissions cannot be preserved."
            );
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        let mut current = std::mem::MaybeUninit::<libc::stat>::uninit();
        let exists = unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name.as_ptr(),
                current.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0;
        if let Some(expected) = expected {
            ensure!(
                exists,
                "The file changed before the modification. Read it again."
            );
            let current = unsafe { current.assume_init() };
            ensure!(
                current.st_dev as u64 == expected.dev()
                    && current.st_ino as u64 == expected.ino()
                    && current.st_size as u64 == expected.len(),
                "The file changed before the modification. Read it again."
            );
            #[cfg(target_os = "linux")]
            ensure!(
                current.st_mtime == expected.mtime()
                    && current.st_mtime_nsec == expected.mtime_nsec(),
                "The file changed before the modification. Read it again."
            );
            #[cfg(target_os = "macos")]
            ensure!(
                current.st_mtime == expected.mtime()
                    && current.st_mtime_nsec == expected.mtime_nsec(),
                "The file changed before the modification. Read it again."
            );
        } else {
            ensure!(
                !exists && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound,
                "The file appeared before the modification. Read it again."
            );
        }
        ensure!(
            unsafe {
                libc::renameat(
                    directory.as_raw_fd(),
                    temporary.as_ptr(),
                    directory.as_raw_fd(),
                    name.as_ptr(),
                )
            } == 0,
            "The staged file cannot be committed: {}.",
            std::io::Error::last_os_error()
        );
        Ok(())
    })();
    unsafe {
        libc::unlinkat(directory.as_raw_fd(), temporary.as_ptr(), 0);
    }
    result
}

#[cfg(not(unix))]
pub(super) fn write(
    _path: &Path,
    _bytes: &[u8],
    _expected: Option<&std::fs::Metadata>,
) -> Result<()> {
    anyhow::bail!("Native file changes require a supported filesystem boundary on this platform.")
}

#[cfg(unix)]
pub(super) fn remove(path: &Path, expected: &std::fs::Metadata) -> Result<()> {
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    let (directory, name) = parent(path, false)?;
    let mut current = std::mem::MaybeUninit::<libc::stat>::uninit();
    ensure!(
        unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name.as_ptr(),
                current.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0,
        "The file changed before the modification. Read it again."
    );
    let current = unsafe { current.assume_init() };
    ensure!(
        current.st_dev as u64 == expected.dev()
            && current.st_ino as u64 == expected.ino()
            && current.st_size as u64 == expected.len()
            && current.st_mtime == expected.mtime()
            && current.st_mtime_nsec == expected.mtime_nsec(),
        "The file changed before the modification. Read it again."
    );
    ensure!(
        unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } == 0,
        "The file cannot be deleted: {}",
        std::io::Error::last_os_error()
    );
    Ok(())
}
#[cfg(not(unix))]
pub(super) fn remove(_path: &Path, _expected: &std::fs::Metadata) -> Result<()> {
    anyhow::bail!("Native file changes require a supported filesystem boundary on this platform.")
}

#[cfg(unix)]
pub(super) fn move_file(
    source: &Path,
    destination: &Path,
    expected: &std::fs::Metadata,
) -> Result<()> {
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    let (from, name) = parent(source, false)?;
    let (to, destination_name) = parent(destination, true)?;
    let mut current = std::mem::MaybeUninit::<libc::stat>::uninit();
    ensure!(
        unsafe {
            libc::fstatat(
                from.as_raw_fd(),
                name.as_ptr(),
                current.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0,
        "The moved file is no longer available."
    );
    let current = unsafe { current.assume_init() };
    ensure!(
        current.st_dev as u64 == expected.dev()
            && current.st_ino as u64 == expected.ino()
            && current.st_size as u64 == expected.len()
            && current.st_mtime == expected.mtime()
            && current.st_mtime_nsec == expected.mtime_nsec(),
        "The file changed before the move. Read it again."
    );
    // The system call rather than libc's wrapper: the static musl a release links against may
    // predate renameat2 even though every supported kernel provides it.
    #[cfg(target_os = "linux")]
    let moved = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            from.as_raw_fd() as libc::c_long,
            name.as_ptr(),
            to.as_raw_fd() as libc::c_long,
            destination_name.as_ptr(),
            libc::RENAME_NOREPLACE as libc::c_long,
        )
    };
    #[cfg(target_os = "macos")]
    let moved = unsafe {
        libc::renameatx_np(
            from.as_raw_fd(),
            name.as_ptr(),
            to.as_raw_fd(),
            destination_name.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let moved = -1;
    ensure!(
        moved == 0,
        "The move could not commit without overwriting another file: {}.",
        std::io::Error::last_os_error()
    );
    Ok(())
}
#[cfg(not(unix))]
pub(super) fn move_file(
    _source: &Path,
    _destination: &Path,
    _expected: &std::fs::Metadata,
) -> Result<()> {
    anyhow::bail!("Native file moves require a supported filesystem boundary on this platform.")
}
