//! Source's 80 × 24 controlling terminal, with nonblocking native I/O.
use anyhow::Result;
use std::{
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf, unix::AsyncFd};

pub(super) struct Pty(AsyncFd<OwnedFd>);
pub(super) struct Control(OwnedFd);
impl Control {
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let size = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        if unsafe { libc::ioctl(self.0.as_raw_fd(), libc::TIOCSWINSZ, &size) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

pub(super) fn attach(command: &mut tokio::process::Command) -> Result<(Pty, Pty, Control)> {
    for (name, value) in [
        ("TERM", "dumb"),
        ("COLORTERM", ""),
        ("NO_COLOR", "1"),
        ("PAGER", "cat"),
        ("GIT_PAGER", "cat"),
        ("GH_PAGER", "cat"),
    ] {
        command.env(name, value);
    }
    attach_dimensions(command, 80, 24)
}

pub(super) fn attach_product(
    command: &mut tokio::process::Command,
    cols: u16,
    rows: u16,
    name: &str,
) -> Result<(Pty, Pty, Control)> {
    command.env("TERM", name);
    attach_dimensions(command, cols, rows)
}

fn attach_dimensions(
    command: &mut tokio::process::Command,
    cols: u16,
    rows: u16,
) -> Result<(Pty, Pty, Control)> {
    let (master, slave) = open(cols, rows)?;
    command
        .stdin(std::process::Stdio::from(slave.try_clone()?))
        .stdout(std::process::Stdio::from(slave.try_clone()?))
        .stderr(std::process::Stdio::from(slave));
    use std::os::unix::process::CommandExt;
    // Commands has already registered setsid: this second, async-signal-safe
    // child hook gives that new session its controlling terminal.
    unsafe {
        command.as_std_mut().pre_exec(|| {
            if libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok((
        Pty(AsyncFd::new(master.try_clone()?)?),
        Pty(AsyncFd::new(master.try_clone()?)?),
        Control(master),
    ))
}

fn open(cols: u16, rows: u16) -> io::Result<(OwnedFd, OwnedFd)> {
    #[cfg(target_os = "linux")]
    let (master, slave) = {
        // Allocate with CLOEXEC atomically: concurrent process starts must never
        // inherit another terminal's master or keep its slave alive.
        let fd = unsafe {
            libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC | libc::O_NONBLOCK)
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let master = unsafe { OwnedFd::from_raw_fd(fd) };
        if unsafe { libc::grantpt(fd) } < 0 || unsafe { libc::unlockpt(fd) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut path = [0; 256];
        let error = unsafe { libc::ptsname_r(fd, path.as_mut_ptr(), path.len()) };
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        (master, unsafe { OwnedFd::from_raw_fd(fd) })
    };
    #[cfg(not(target_os = "linux"))]
    let (master, slave) = {
        let (mut master, mut slave) = (-1, -1);
        if unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        let master = unsafe { OwnedFd::from_raw_fd(master) };
        let slave = unsafe { OwnedFd::from_raw_fd(slave) };
        for descriptor in [&master, &slave] {
            if unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        if unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        (master, slave)
    };
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe { libc::ioctl(slave.as_raw_fd(), libc::TIOCSWINSZ, &size) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((master, slave))
}

impl AsyncRead for Pty {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        loop {
            let mut ready = std::task::ready!(self.0.poll_read_ready(context))?;
            match ready.try_io(|fd| {
                let destination = buffer.initialize_unfilled();
                loop {
                    let count = unsafe {
                        libc::read(
                            fd.get_ref().as_raw_fd(),
                            destination.as_mut_ptr().cast(),
                            destination.len(),
                        )
                    };
                    if count >= 0 {
                        return Ok(count as usize);
                    }
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    // Linux reports slave closure as EIO, the terminal's EOF.
                    return if error.raw_os_error() == Some(libc::EIO) {
                        Ok(0)
                    } else {
                        Err(error)
                    };
                }
            }) {
                Ok(Ok(count)) => {
                    buffer.advance(count);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(error)) => return Poll::Ready(Err(error)),
                Err(_) => {}
            }
        }
    }
}
impl AsyncWrite for Pty {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        loop {
            let mut ready = std::task::ready!(self.0.poll_write_ready(context))?;
            match ready.try_io(|fd| {
                loop {
                    let count = unsafe {
                        libc::write(
                            fd.get_ref().as_raw_fd(),
                            buffer.as_ptr().cast(),
                            buffer.len(),
                        )
                    };
                    if count >= 0 {
                        return Ok(count as usize);
                    }
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        return Err(error);
                    }
                }
            }) {
                Ok(result) => return Poll::Ready(result),
                Err(_) => {}
            }
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        // A terminal has no pipe half-close. Source sends its EOF character.
        Poll::Ready(Ok(()))
    }
}
