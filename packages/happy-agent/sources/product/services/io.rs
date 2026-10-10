//! A real controlling PTY for services that request terminal input.
use anyhow::Result;
use std::{
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf, unix::AsyncFd};

pub(super) struct Pty(AsyncFd<OwnedFd>);
pub(super) fn attach(command: &mut tokio::process::Command) -> Result<(Pty, Pty)> {
    let (mut master, mut slave) = (-1, -1);
    let size = libc::winsize {
        ws_row: 24,
        ws_col: 80,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            &size,
        )
    } < 0
    {
        return Err(io::Error::last_os_error().into());
    }
    let master = unsafe { OwnedFd::from_raw_fd(master) };
    let slave = unsafe { OwnedFd::from_raw_fd(slave) };
    for descriptor in [&master, &slave] {
        if unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error().into());
        }
    }
    if unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error().into());
    }
    command
        .stdin(std::process::Stdio::from(slave.try_clone()?))
        .stdout(std::process::Stdio::from(slave.try_clone()?))
        .stderr(std::process::Stdio::from(slave));
    use std::os::unix::process::CommandExt;
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
        Pty(AsyncFd::new(master)?),
    ))
}
impl AsyncRead for Pty {
    fn poll_read(
        self: Pin<&mut Self>,
        ctx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            let mut ready = std::task::ready!(self.0.poll_read_ready(ctx))?;
            match ready.try_io(|fd| {
                let destination = buffer.initialize_unfilled();
                let count = unsafe {
                    libc::read(
                        fd.get_ref().as_raw_fd(),
                        destination.as_mut_ptr().cast(),
                        destination.len(),
                    )
                };
                if count >= 0 {
                    Ok(count as usize)
                } else {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(libc::EIO) {
                        Ok(0)
                    } else {
                        Err(error)
                    }
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
        ctx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        loop {
            let mut ready = std::task::ready!(self.0.poll_write_ready(ctx))?;
            match ready.try_io(|fd| {
                let count = unsafe {
                    libc::write(
                        fd.get_ref().as_raw_fd(),
                        buffer.as_ptr().cast(),
                        buffer.len(),
                    )
                };
                if count >= 0 {
                    Ok(count as usize)
                } else {
                    Err(io::Error::last_os_error())
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
        Poll::Ready(Ok(()))
    }
}
