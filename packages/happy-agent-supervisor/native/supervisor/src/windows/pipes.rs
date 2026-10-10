//! IOCP parent streams with synchronous child endpoints, including ConPTY.
use super::{arguments::wide, handles::own};
use std::{
    ffi::OsStr,
    future::Future,
    io,
    os::windows::io::OwnedHandle,
    task::{Context, Poll, Waker},
};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::{
    Foundation::{GENERIC_READ, GENERIC_WRITE, LocalFree},
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
        Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom},
        SECURITY_ATTRIBUTES,
    },
    Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING},
};

pub type Stream = NamedPipeServer;

struct Descriptor(*mut std::ffi::c_void);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

/// Only the parent endpoint uses OVERLAPPED. A child's standard stream must
/// remain a synchronous handle so CRT and console reads keep their semantics.
pub(super) fn create(parent_writes: bool) -> io::Result<(Stream, OwnedHandle)> {
    let mut random = [0u8; 16];
    if unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            random.as_mut_ptr(),
            random.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } < 0
    {
        return Err(io::Error::other(
            "Windows could not create a private stream name.",
        ));
    }
    let name = format!(
        r"\\.\pipe\happy-native-{:032x}",
        u128::from_le_bytes(random)
    );
    // Owner Rights restricts the stream to its creating token. The default
    // named-pipe DACL would also admit Everyone and Anonymous read access.
    let sddl = wide(OsStr::new("D:P(A;;GA;;;OW)"))?;
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let descriptor = Descriptor(descriptor);
    let mut security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let server = unsafe {
        ServerOptions::new()
            .access_inbound(!parent_writes)
            .access_outbound(parent_writes)
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .max_instances(1)
            .create_with_security_attributes_raw(
                &name,
                (&mut security as *mut SECURITY_ATTRIBUTES).cast(),
            )?
    };
    let name = wide(OsStr::new(&name))?;
    let client = unsafe {
        own(CreateFileW(
            name.as_ptr(),
            if parent_writes {
                GENERIC_READ
            } else {
                GENERIC_WRITE
            },
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        ))?
    };
    // CreateFile has already connected our only client. ConnectNamedPipe's
    // ERROR_PIPE_CONNECTED path completes immediately and arms Mio's IOCP IO.
    {
        let mut connected = std::pin::pin!(server.connect());
        match connected
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(result) => result?,
            Poll::Pending => {
                return Err(io::Error::other(
                    "The private Windows stream did not connect synchronously.",
                ));
            }
        }
    }
    Ok((server, client))
}
