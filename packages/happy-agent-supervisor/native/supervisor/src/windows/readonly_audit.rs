//! Kernel counterexample for admitting Source's token as a whole-root write denial.
use super::{
    arguments::wide,
    handles::{own, raw},
};
use std::{
    ffi::OsStr,
    io::{self, Write},
};
use windows_sys::Win32::{
    Foundation::{GENERIC_WRITE, LocalFree},
    Security::{
        AccessCheck,
        Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW,
        },
        CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, DuplicateToken, GENERIC_MAPPING,
        GetTokenInformation, ImpersonateLoggedOnUser, LUA_TOKEN, PRIVILEGE_SET, RevertToSelf,
        SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES, SecurityImpersonation, TOKEN_DUPLICATE,
        TOKEN_QUERY, TOKEN_USER, TokenUser, WRITE_RESTRICTED,
    },
    Storage::FileSystem::{
        CREATE_NEW, CreateFileW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_EXECUTE,
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_WRITE_DATA,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

struct Local(*mut std::ffi::c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}
struct Impersonation;
impl Drop for Impersonation {
    fn drop(&mut self) {
        if unsafe { RevertToSelf() } == 0 {
            // A failure to restore the test thread's identity cannot continue.
            std::process::abort();
        }
    }
}
fn checked(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn sid(value: &str) -> io::Result<Local> {
    let value = wide(OsStr::new(value))?;
    let mut sid = std::ptr::null_mut();
    checked(unsafe { ConvertStringSidToSidW(value.as_ptr(), &mut sid) })?;
    Ok(Local(sid))
}

#[test]
fn source_everyone_restricting_sid_still_grants_everyone_writable_file_access() -> io::Result<()> {
    let mut base = std::ptr::null_mut();
    checked(unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY,
            &mut base,
        )
    })?;
    let base = unsafe { own(base)? };
    let everyone = sid("S-1-1-0")?;
    let capability = sid("S-1-5-21-10-20-30-40")?;
    let mut needed = 0;
    unsafe { GetTokenInformation(raw(&base), TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    assert!(needed != 0, "Windows returned no token user size");
    let mut user = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
    checked(unsafe {
        GetTokenInformation(
            raw(&base),
            TokenUser,
            user.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    })?;
    let user_sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    // Source includes Everyone, its capability and the dedicated account's user
    // SID among its restricting SIDs. Adding logon or route SIDs cannot subtract
    // the Everyone grant: the second access check accepts any granting SID.
    let restricting = [
        SID_AND_ATTRIBUTES {
            Sid: capability.0,
            Attributes: 0,
        },
        SID_AND_ATTRIBUTES {
            Sid: user_sid,
            Attributes: 0,
        },
        SID_AND_ATTRIBUTES {
            Sid: everyone.0,
            Attributes: 0,
        },
    ];
    let mut restricted = std::ptr::null_mut();
    checked(unsafe {
        CreateRestrictedToken(
            raw(&base),
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            restricting.len() as u32,
            restricting.as_ptr(),
            &mut restricted,
        )
    })?;
    let restricted = unsafe { own(restricted)? };
    let mut impersonation = std::ptr::null_mut();
    checked(unsafe {
        DuplicateToken(raw(&restricted), SecurityImpersonation, &mut impersonation)
    })?;
    let impersonation = unsafe { own(impersonation)? };
    let descriptor = wide(OsStr::new("O:SYG:SYD:P(A;;GA;;;WD)"))?;
    let mut security = std::ptr::null_mut();
    checked(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            descriptor.as_ptr(),
            1,
            &mut security,
            std::ptr::null_mut(),
        )
    })?;
    let security = Local(security);
    let mapping = GENERIC_MAPPING {
        GenericRead: FILE_GENERIC_READ,
        GenericWrite: FILE_GENERIC_WRITE,
        GenericExecute: FILE_GENERIC_EXECUTE,
        GenericAll: FILE_ALL_ACCESS,
    };
    let mut privileges: PRIVILEGE_SET = unsafe { std::mem::zeroed() };
    let mut privilege_bytes = std::mem::size_of::<PRIVILEGE_SET>() as u32;
    let mut granted = 0;
    let mut allowed = 0;
    checked(unsafe {
        AccessCheck(
            security.0,
            raw(&impersonation),
            FILE_WRITE_DATA,
            &mapping,
            &mut privileges,
            &mut privilege_bytes,
            &mut granted,
            &mut allowed,
        )
    })?;
    assert_ne!(
        allowed, 0,
        "the Source token's Everyone SID grants file writes"
    );
    assert_ne!(granted & FILE_WRITE_DATA, 0);

    // The same access grant reaches a real file. No host ACLs or accounts are
    // modified: the object is created with this DACL inside an owned temp dir.
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("everyone-writable");
    let file_descriptor = wide(OsStr::new("D:P(A;;GA;;;WD)"))?;
    let mut file_security = std::ptr::null_mut();
    checked(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            file_descriptor.as_ptr(),
            1,
            &mut file_security,
            std::ptr::null_mut(),
        )
    })?;
    let file_security = Local(file_security);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: file_security.0,
        bInheritHandle: 0,
    };
    let name = wide(path.as_os_str())?;
    let file = unsafe {
        own(CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            0,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        ))?
    };
    drop(file);
    {
        checked(unsafe { ImpersonateLoggedOnUser(raw(&impersonation)) })?;
        let _identity = Impersonation;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)?
            .write_all(b"write permitted by the Source token")?;
    }
    assert_eq!(
        std::fs::read(&path)?,
        b"write permitted by the Source token"
    );
    Ok(())
}
