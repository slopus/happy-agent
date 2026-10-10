use anyhow::Result;
use serde_json::{Value, json};

pub(super) fn current() -> Result<Value> {
    let shell = if cfg!(windows) {
        compute_shell()
    } else {
        std::env::var("SHELL").unwrap_or_default()
    };
    let value = json!({"osVersion":release()?,"platform":if cfg!(target_os="macos"){"darwin"}else if cfg!(windows){"win32"}else{"linux"},"workingDirectory":std::env::current_dir()?,"shell":shell});
    anyhow::ensure!(
        super::super::schemas::Schemas::new()?
            .valid("agentConfig", &json!({"environment":value}))?,
        "The current machine environment is invalid."
    );
    Ok(value)
}
pub(super) fn compute_shell() -> String {
    #[cfg(windows)]
    {
        std::path::PathBuf::from(
            std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()),
        )
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
        .to_string_lossy()
        .into_owned()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

#[cfg(unix)]
fn release() -> Result<String> {
    let mut information = std::mem::MaybeUninit::<libc::utsname>::uninit();
    if unsafe { libc::uname(information.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let information = unsafe { information.assume_init() };
    Ok(
        unsafe { std::ffi::CStr::from_ptr(information.release.as_ptr()) }
            .to_string_lossy()
            .into_owned(),
    )
}
#[cfg(windows)]
fn release() -> Result<String> {
    #[repr(C)]
    struct Version {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(information: *mut Version) -> i32;
    }
    let mut information = Version {
        size: std::mem::size_of::<Version>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service_pack: [0; 128],
    };
    anyhow::ensure!(
        unsafe { RtlGetVersion(&mut information) } >= 0,
        "The Windows version could not be read."
    );
    Ok(format!(
        "{}.{}.{}",
        information.major, information.minor, information.build
    ))
}
