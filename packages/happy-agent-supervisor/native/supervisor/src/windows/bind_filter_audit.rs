//! Test-only kernel experiment. Read only admission remains closed.
//!
//! Microsoft HCS shim's exact BindFlt signature and flag definitions:
//! https://github.com/microsoft/hcsshim/blob/main/internal/winapi/bindflt.go
//! Its Job::PromoteToSilo / ApplyFileBinding use an empty kill-on-close Job,
//! JobObjectCreateSilo and READ_ONLY_MAPPING | USE_CURRENT_SILO_MAPPING (1 | 4):
//! https://github.com/microsoft/hcsshim/blob/main/internal/jobobject/jobobject.go
//! The Silo information ABI is copied from the Windows structure documented in:
//! https://github.com/microsoft/hcsshim/blob/main/internal/winapi/jobobject.go
//!
//! This maps only the owned fixture's volume in an owned, non-NULL Job. It never
//! installs a driver, changes host policy, or sets up a host/global mapping.
//! Passing proves these filesystem cases, not sensitive-read or network isolation.
use super::{
    Command, Job,
    arguments::wide,
    handles::{own, raw},
};
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    mem::size_of,
    os::windows::{ffi::OsStringExt, io::AsRawHandle},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::AsyncReadExt;
use windows_sys::Win32::{
    Foundation::{
        FreeLibrary, GENERIC_READ, GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT, HMODULE, LocalFree,
        SetHandleInformation,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SE_FILE_OBJECT, SetNamedSecurityInfoW,
        },
        DACL_SECURITY_INFORMATION, GetAce, GetFileSecurityW, GetSecurityDescriptorDacl,
        GetSecurityDescriptorOwner, GetSecurityDescriptorSacl, GetSidIdentifierAuthority,
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation,
        LABEL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES,
        SYSTEM_MANDATORY_LABEL_ACE, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    Storage::FileSystem::{
        CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_ID_INFO, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FileIdInfo, GetFileInformationByHandleEx,
        GetFinalPathNameByHandleW, GetVolumePathNameW, VOLUME_NAME_GUID, VOLUME_NAME_NT,
    },
    System::{
        JobObjects::{
            JobObjectCreateSilo, JobObjectSiloBasicInformation, QueryInformationJobObject,
            SetInformationJobObject,
        },
        LibraryLoader::{GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW},
        SystemServices::{SYSTEM_MANDATORY_LABEL_ACE_TYPE, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP},
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

const OPERATION: &str = "HAPPY_WINDOWS_BINDFLT_OPERATION";
const CONTENT: &[u8] = b"owned read-only fixture\n";
const INHERITED_CONTENT: &[u8] = b"owned inherited handle control\n";

struct Local(*mut std::ffi::c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}
struct Library(HMODULE);
impl Drop for Library {
    fn drop(&mut self) {
        unsafe { FreeLibrary(self.0) };
    }
}
fn checked(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

// DWORD, DWORD, DWORD, BOOLEAN, BYTE[3], total 16 bytes on both Windows ABIs.
#[repr(C)]
#[derive(Default)]
struct SiloInformation {
    id: u32,
    parent_id: u32,
    processes: u32,
    server_silo: u8,
    reserved: [u8; 3],
}
fn silo_id(job: HANDLE) -> io::Result<u32> {
    let mut information = SiloInformation::default();
    assert_eq!(size_of::<SiloInformation>(), 16);
    checked(unsafe {
        QueryInformationJobObject(
            job,
            JobObjectSiloBasicInformation,
            (&mut information as *mut SiloInformation).cast(),
            size_of::<SiloInformation>() as u32,
            std::ptr::null_mut(),
        )
    })?;
    assert_ne!(
        information.id, 0,
        "the owned Job must have a real Silo identity"
    );
    Ok(information.id)
}

// HRESULT BfSetupFilter(HANDLE, DWORD, LPCWSTR, LPCWSTR, LPCWSTR*, DWORD).
type SetupFilter =
    unsafe extern "system" fn(HANDLE, u32, *const u16, *const u16, *const *const u16, u32) -> i32;
fn readonly_mapping(job: &Job, fixture: &Path, writable_temp: &Path) -> io::Result<Library> {
    assert!(
        !job.raw().is_null(),
        "a host/global BindFlt mapping is forbidden"
    );
    assert_eq!(job.active_processes()?, 0);
    checked(unsafe {
        SetInformationJobObject(job.raw(), JobObjectCreateSilo, std::ptr::null(), 0)
    })
    .map_err(|error| io::Error::other(format!("owned Job Silo promotion failed: {error}")))?;
    println!("BINDFLT_SILO_CREATED:{}", silo_id(job.raw())?);
    let name = wide(OsStr::new("bindfltapi.dll"))?;
    let module = unsafe {
        LoadLibraryExW(
            name.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    };
    if module.is_null() {
        return Err(io::Error::other(format!(
            "required system bindfltapi.dll unavailable: {}",
            io::Error::last_os_error()
        )));
    }
    let library = Library(module);
    let procedure = unsafe { GetProcAddress(module, c"BfSetupFilter".as_ptr().cast()) }
        .ok_or_else(|| io::Error::other("required BfSetupFilter export unavailable"))?;
    let setup: SetupFilter = unsafe { std::mem::transmute(procedure) };
    let fixture = wide(fixture.as_os_str())?;
    let mut volume = vec![0u16; 32_768];
    checked(unsafe {
        GetVolumePathNameW(fixture.as_ptr(), volume.as_mut_ptr(), volume.len() as u32)
    })?;
    let exception = wide(writable_temp.as_os_str())?;
    let exceptions = [exception.as_ptr()];
    // Exactly hcsshim's read-only Silo flags. No GLOBAL_MAPPING (2), no NULL Job.
    // The single exception is this test's owned private temporary directory.
    let result = unsafe {
        setup(
            job.raw(),
            1 | 4,
            volume.as_ptr(),
            volume.as_ptr(),
            exceptions.as_ptr(),
            1,
        )
    };
    if result != 0 {
        return Err(io::Error::other(format!(
            "owned Job BfSetupFilter(flags=5) failed: HRESULT {result:#010x}"
        )));
    }
    println!("BINDFLT_READONLY_MAPPING_READY:flags=5:owned_job:private_temp_exception");
    Ok(library)
}

fn user_sid() -> io::Result<String> {
    let mut token = std::ptr::null_mut();
    checked(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
    let token = unsafe { own(token)? };
    let mut needed = 0;
    unsafe { GetTokenInformation(raw(&token), TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    let mut buffer = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    checked(unsafe {
        GetTokenInformation(
            raw(&token),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    })?;
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    sid_text(user.User.Sid)
}
fn sid_text(sid: *mut std::ffi::c_void) -> io::Result<String> {
    let mut text = std::ptr::null_mut();
    checked(unsafe { ConvertSidToStringSidW(sid, &mut text) })?;
    let allocation = Local(text.cast());
    let mut length = 0;
    while unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    let result = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
    drop(allocation);
    Ok(result)
}

fn create_secured(path: &Path, sddl: &str) -> io::Result<()> {
    let sddl = wide(OsStr::new(sddl))?;
    let mut descriptor = std::ptr::null_mut();
    checked(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    })
    .map_err(|error| {
        io::Error::other(format!(
            "Parse owned fixture security descriptor for {}: {error}",
            path.display()
        ))
    })?;
    let descriptor = Local(descriptor);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let name = wide(path.as_os_str())?;
    let handle = unsafe {
        own(CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        ))?
    };
    let mut file = File::from(handle);
    file.write_all(CONTENT)
}

fn security(path: &Path, information: u32) -> io::Result<Vec<usize>> {
    let name = wide(path.as_os_str())?;
    let mut needed = 0;
    unsafe {
        GetFileSecurityW(
            name.as_ptr(),
            information,
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    assert_ne!(needed, 0, "a real file security descriptor is required");
    let mut buffer = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    checked(unsafe {
        GetFileSecurityW(
            name.as_ptr(),
            information,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    })?;
    Ok(buffer)
}
fn assert_lowest_label_null_dacl(path: &Path) -> io::Result<()> {
    let descriptor = security(path, DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION)?;
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = std::ptr::null_mut();
    checked(unsafe {
        GetSecurityDescriptorDacl(
            descriptor.as_ptr().cast_mut().cast(),
            &mut present,
            &mut dacl,
            &mut defaulted,
        )
    })?;
    assert_ne!(present, 0);
    assert!(dacl.is_null(), "fixture must have a real null DACL");
    let mut sacl = std::ptr::null_mut();
    checked(unsafe {
        GetSecurityDescriptorSacl(
            descriptor.as_ptr().cast_mut().cast(),
            &mut present,
            &mut sacl,
            &mut defaulted,
        )
    })?;
    assert_ne!(present, 0);
    assert!(!sacl.is_null());
    assert_eq!(unsafe { (*sacl).AceCount }, 1);
    let mut ace = std::ptr::null_mut();
    checked(unsafe { GetAce(sacl, 0, &mut ace) })?;
    let label = unsafe { &*ace.cast::<SYSTEM_MANDATORY_LABEL_ACE>() };
    assert_eq!(label.Header.AceType, SYSTEM_MANDATORY_LABEL_ACE_TYPE as u8);
    assert_eq!(label.Mask, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP);
    let sid = (&label.SidStart as *const u32).cast_mut().cast();
    assert_eq!(
        unsafe { (*GetSidIdentifierAuthority(sid)).Value },
        [0, 0, 0, 0, 0, 16]
    );
    let count = unsafe { *GetSidSubAuthorityCount(sid) };
    assert_eq!(count, 1);
    assert_eq!(
        unsafe { *GetSidSubAuthority(sid, 0) },
        0,
        "the label must be Untrusted, the lowest integrity level"
    );
    println!("BINDFLT_NULL_DACL_LOWEST_LABEL_VERIFIED");
    Ok(())
}
fn assert_owner(path: &Path, expected: &str) -> io::Result<()> {
    let descriptor = security(path, OWNER_SECURITY_INFORMATION)?;
    let mut owner = std::ptr::null_mut();
    let mut defaulted = 0;
    checked(unsafe {
        GetSecurityDescriptorOwner(
            descriptor.as_ptr().cast_mut().cast(),
            &mut owner,
            &mut defaulted,
        )
    })?;
    assert!(!owner.is_null());
    assert_eq!(
        sid_text(owner)?,
        expected,
        "WRITE_DAC must be tested as the real file owner"
    );
    Ok(())
}

fn identity(handle: HANDLE) -> io::Result<String> {
    let mut information: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    checked(unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&mut information as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    })?;
    Ok(format!(
        "{}:{:02x?}",
        information.VolumeSerialNumber, information.FileId.Identifier
    ))
}
fn env_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("missing fixture {name}")))
}
fn denied(error: io::Error, operation: &str) {
    assert!(
        matches!(error.raw_os_error(), Some(5 | 19)),
        "{operation} must fail with access denied or write protected, got {error}"
    );
    println!(
        "BINDFLT_DENIED:{operation}:{}",
        error
            .raw_os_error()
            .unwrap_or_else(|| panic!("missing native error for {operation}"))
    );
}
fn deny_write(path: &Path, operation: &str) {
    let result = OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|mut file| file.write_all(b"unexpected write"));
    match result {
        Ok(()) => panic!("{operation}: changed an owned read-only fixture"),
        Err(error) => denied(error, operation),
    }
}
fn deny_dacl_change(path: &Path, operation: &str) -> io::Result<()> {
    let mut path = wide(path.as_os_str())?;
    // Removing the DACL is an actual WRITE_DAC operation on an owned file.
    let result = unsafe {
        SetNamedSecurityInfoW(
            path.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    assert_ne!(result, 0, "{operation}: changed the owned file's DACL");
    denied(io::Error::from_raw_os_error(result as i32), operation);
    Ok(())
}
fn final_alias(path: &Path, flags: u32) -> io::Result<PathBuf> {
    let file = File::open(path)?;
    let mut buffer = vec![0u16; 32_768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            flags,
        )
    };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    assert!((length as usize) < buffer.len());
    let name = OsString::from_wide(&buffer[..length as usize]);
    if flags == VOLUME_NAME_NT {
        let mut global_root = OsString::from(r"\\?\GLOBALROOT");
        global_root.push(name);
        Ok(PathBuf::from(global_root))
    } else {
        Ok(PathBuf::from(name))
    }
}

fn fixture(operation: &str, source: &Path) -> io::Result<Command> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "--exact",
            "windows::bind_filter_audit::child_fixture",
            "--nocapture",
        ])
        .env(OPERATION, operation)
        .env("HAPPY_WINDOWS_BINDFLT_SOURCE", source)
        .current_dir(source);
    Ok(command)
}
async fn run(mut command: Command) -> io::Result<String> {
    let mut child = command.spawn()?;
    child.stdin.take();
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("missing fixture stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("missing fixture stderr"))?;
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        let output = async {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).await.map(|_| bytes)
        };
        let errors = async {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).await.map(|_| bytes)
        };
        let (status, output, errors) = tokio::join!(child.wait(), output, errors);
        let status = status?;
        let output = String::from_utf8_lossy(&output?).into_owned();
        let errors = String::from_utf8_lossy(&errors?).into_owned();
        assert!(
            status.success(),
            "BindFlt fixture failed: {status}\n{output}\n{errors}"
        );
        println!("{output}");
        Ok(output)
    })
    .await
    .map_err(|error| io::Error::other(format!("BindFlt fixture deadline: {error}")))?;
    // Drop the command's prepared Job clone before its fixture directory cleanup.
    command.prepared_job.take();
    result
}

#[tokio::test]
async fn owned_silo_bind_filter_denies_acl_independent_writes_with_private_reads_and_temp()
-> io::Result<()> {
    let directory = tempfile::tempdir()?;
    let source = directory.path().join("source");
    let temp = directory.path().join("private-temp");
    fs::create_dir(&source)?;
    fs::create_dir(&temp)?;
    let private = source.join("private-user");
    let null = source.join("null-dacl-untrusted");
    let user = user_sid()?;
    create_secured(&private, &format!("O:{user}D:P(A;;GA;;;{user})"))?;
    // Sddl.h has no UN abbreviation. Use the explicit SID: mandatory authority
    // 16 and SECURITY_MANDATORY_UNTRUSTED_RID 0. Microsoft documents both forms:
    // https://learn.microsoft.com/en-us/windows/win32/secauthz/sid-strings
    // https://learn.microsoft.com/en-us/windows/win32/secauthz/well-known-sids
    create_secured(
        &null,
        &format!("O:{user}D:NO_ACCESS_CONTROLS:(ML;;NW;;;S-1-16-0)"),
    )?;
    assert_owner(&private, &user)?;
    assert_owner(&null, &user)?;
    assert_lowest_label_null_dacl(&null)?;
    let inherited_path = source.join("inherited-writable");
    fs::write(&inherited_path, INHERITED_CONTENT)?;
    let inherited = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&inherited_path)?;
    checked(unsafe {
        SetHandleInformation(
            inherited.as_raw_handle(),
            HANDLE_FLAG_INHERIT,
            HANDLE_FLAG_INHERIT,
        )
    })?;
    let inherited_identity = identity(inherited.as_raw_handle())?;

    let job = Arc::new(Job::create()?);
    let library = readonly_mapping(&job, &source, &temp)?;
    let id = silo_id(job.raw())?;
    fs::write(source.join("parent-write-control"), b"parent unaffected")?;
    let sibling = run(fixture("outside-job", &source)?).await?;
    assert!(sibling.contains("BINDFLT_SIBLING_WRITE_ALLOWED"));
    println!("BINDFLT_PARENT_AND_SIBLING_UNAFFECTED");

    let mut command = fixture("boundary", &source)?;
    command
        .env("HAPPY_WINDOWS_BINDFLT_TEMP", &temp)
        .env("TMP", &temp)
        .env("TEMP", &temp)
        .env("HAPPY_WINDOWS_BINDFLT_SILO", id.to_string())
        .env(
            "HAPPY_WINDOWS_BINDFLT_INHERITED_HANDLE",
            (inherited.as_raw_handle() as usize).to_string(),
        )
        .env(
            "HAPPY_WINDOWS_BINDFLT_INHERITED_IDENTITY",
            inherited_identity,
        );
    // The production PROC_THREAD_ATTRIBUTE_JOB_LIST attaches this exact prepared
    // Job at CreateProcessW. The test seam does not assign a running process.
    command.prepared_job = Some(job.clone());
    let output = run(command).await?;
    assert!(output.contains("BINDFLT_BOUNDARY_ASSERTIONS_COMPLETE"));
    assert_eq!(fs::read(&private)?, CONTENT);
    assert_eq!(fs::read(&null)?, CONTENT);
    assert_eq!(fs::read(&inherited_path)?, INHERITED_CONTENT);
    assert!(!source.join("AGENTS.md").exists());
    assert!(!temp.join("hardlink-to-null").exists());
    assert_eq!(job.active_processes()?, 0);
    drop(inherited);
    drop(job);
    drop(library);
    directory.close()?;
    Ok(())
}

// A child portal, like the existing native fixture: a no-op in the controller.
// This is a second test entry, so the full native suite has exactly 17 tests.
#[test]
fn child_fixture() -> io::Result<()> {
    let Some(operation) = std::env::var_os(OPERATION) else {
        return Ok(());
    };
    let source = env_path("HAPPY_WINDOWS_BINDFLT_SOURCE");
    if operation == "outside-job" {
        fs::write(source.join("sibling-write-control"), b"sibling unaffected")?;
        println!("BINDFLT_SIBLING_WRITE_ALLOWED");
        return Ok(());
    }
    assert_eq!(operation, "boundary");
    let expected: u32 = std::env::var("HAPPY_WINDOWS_BINDFLT_SILO")
        .map_err(io::Error::other)?
        .parse()
        .map_err(io::Error::other)?;
    // NULL means query the current Job, not configure a NULL/global mapping.
    // This must match the controller's specific Silo before any fixture I/O.
    assert_eq!(
        silo_id(std::ptr::null_mut())?,
        expected,
        "child must begin inside the exact owned Silo"
    );
    println!("BINDFLT_CHILD_ATTACHED_BEFORE_FIXTURE_IO:{expected}");
    let temp = env_path("HAPPY_WINDOWS_BINDFLT_TEMP");
    let private = source.join("private-user");
    let null = source.join("null-dacl-untrusted");
    assert_eq!(fs::read(&private)?, CONTENT);
    assert_eq!(fs::read(&null)?, CONTENT);
    let user = user_sid()?;
    assert_owner(&private, &user)?;
    assert_owner(&null, &user)?;
    assert_lowest_label_null_dacl(&null)?;
    println!("BINDFLT_PRIVATE_USER_AND_NULL_DACL_READ_ALLOWED");
    let scratch = temp.join("owned-writable-temp");
    fs::write(&scratch, b"private temporary storage works")?;
    assert_eq!(fs::read(&scratch)?, b"private temporary storage works");
    fs::remove_file(&scratch)?;
    println!("BINDFLT_PRIVATE_TEMP_WRITE_ALLOWED");
    deny_write(&private, "private-user-data-write");
    deny_write(&null, "null-dacl-lowest-label-data-write");
    deny_dacl_change(&private, "private-user-owner-WRITE_DAC")?;
    deny_dacl_change(&null, "null-dacl-lowest-label-owner-WRITE_DAC")?;
    let create = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(source.join("AGENTS.md"));
    match create {
        Ok(_) => panic!("created AGENTS.md outside the owned writable temp directory"),
        Err(error) => denied(error, "create-outside-private-temp"),
    }
    match fs::hard_link(&null, temp.join("hardlink-to-null")) {
        Ok(()) => panic!("created a hardlink to the owned read-only source inode"),
        Err(error) => denied(error, "hardlink-from-readonly-source"),
    }
    for (flags, description) in [
        (VOLUME_NAME_GUID, "volume-guid-alias-write"),
        (VOLUME_NAME_NT, "nt-globalroot-alias-write"),
    ] {
        let alias = final_alias(&null, flags)?;
        assert_eq!(
            fs::read(&alias)?,
            CONTENT,
            "the alias must resolve to the actual fixture"
        );
        deny_write(&alias, description);
    }
    let handle: usize = std::env::var("HAPPY_WINDOWS_BINDFLT_INHERITED_HANDLE")
        .map_err(io::Error::other)?
        .parse()
        .map_err(io::Error::other)?;
    let expected =
        std::env::var("HAPPY_WINDOWS_BINDFLT_INHERITED_IDENTITY").map_err(io::Error::other)?;
    // Handle values can be reused by the loader. Compare the actual object ID;
    // never write through a numeric handle that could name an unrelated object.
    assert_ne!(
        identity(handle as HANDLE).ok(),
        Some(expected),
        "the deliberately inheritable writable file handle escaped the stdio whitelist"
    );
    println!("BINDFLT_INHERITABLE_WRITABLE_FILE_HANDLE_EXCLUDED");
    assert_eq!(fs::read(&private)?, CONTENT);
    assert_eq!(fs::read(&null)?, CONTENT);
    println!("BINDFLT_BOUNDARY_ASSERTIONS_COMPLETE");
    Ok(())
}
