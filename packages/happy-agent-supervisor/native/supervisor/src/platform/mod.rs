use crate::policy::SupervisorPolicy;
use crate::{SupervisorResult, invalid_input};
use std::ffi::OsString;

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod child;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
mod service_bridge;
#[cfg(target_os = "linux")]
mod service_cgroup;
#[cfg(target_os = "linux")]
mod service_filesystem;

pub(crate) fn run(policy: SupervisorPolicy, command: Vec<OsString>) -> SupervisorResult<()> {
    #[cfg(target_os = "linux")]
    {
        return linux::run(policy, command);
    }
    #[cfg(target_os = "macos")]
    {
        if policy.service.is_some() {
            return Err(invalid_input("workspace services require Linux namespace and cgroup isolation; macOS service isolation is not available").into());
        }
        return macos::run(policy, command);
    }
    #[allow(unreachable_code)]
    Err(invalid_input("happy-agent-supervisor supports only Linux and macOS").into())
}
