use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Pipes::CreatePipe;

pub(super) fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle()
}

/// The returned owner must be the only owner of the new kernel handle.
pub(super) unsafe fn own(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

pub(super) fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
    // All handles start non-inheritable. Only an explicit startup handle list
    // may pass the child's three standard streams across process creation.
    if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((unsafe { own(read)? }, unsafe { own(write)? }))
}
