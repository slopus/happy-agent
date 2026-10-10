use anyhow::{Context, Result, ensure};
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};

pub(super) const MAX_TEXT_BYTES: usize = 44 * 1024 * 1024;

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
                unsafe { libc::fchmod(file.as_raw_fd(), metadata.mode() & 0o7777) } == 0,
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
    #[cfg(target_os = "linux")]
    let moved = unsafe {
        libc::renameat2(
            from.as_raw_fd(),
            name.as_ptr(),
            to.as_raw_fd(),
            destination_name.as_ptr(),
            libc::RENAME_NOREPLACE,
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
