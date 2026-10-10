//! Opening another assistant's credential files without letting the path stall or redirect us.
//!
//! A FIFO, device, or symlink placed at a store or lock path must be refused at once rather than
//! block the opener past its deadline or write through to another file. Only `std` is used here
//! (plus `libc` constants on Unix), so the module also compiles for Windows on its own.
use std::{
    fs::{File, OpenOptions, TryLockError},
    io,
    path::Path,
    time::{Duration, Instant},
};

/// Opens `path` without following a final symlink or waiting on a FIFO, and requires a regular
/// file. `create` makes a missing file with owner-only permissions.
pub(super) fn open_regular(path: &Path, write: bool, create: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(!write).write(write).create(create);
    if create {
        options.truncate(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
            .mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: open a symlink or junction itself, never its target.
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "The credential path is not a regular file.",
        ));
    }
    Ok(file)
}

/// An exclusive lock on a lock file shared with every process refreshing the same store: `flock`
/// on Unix and `LockFileEx` on Windows, through `std`. Dropping the file releases it.
pub(super) struct FileLock {
    _file: File,
}

impl FileLock {
    pub(super) fn acquire_blocking(path: &Path, timeout: Duration) -> io::Result<Self> {
        let file = open_regular(path, true, true)?;
        let deadline = Instant::now() + timeout;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Self { _file: file }),
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "The credential store stayed locked.",
                    ));
                }
                Err(TryLockError::Error(error)) => return Err(error),
            }
        }
    }
}
