//! A controller-owned cgroup for the workload, not for the daemon or supervisor.
use crate::service_policy::ServicePolicy;
use crate::{SupervisorResult, invalid_input};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

pub(super) struct ServiceCgroup {
    path: PathBuf,
    admission: File,
}

impl ServiceCgroup {
    pub(super) fn create(policy: &ServicePolicy) -> SupervisorResult<Self> {
        let parent = policy.cgroup_parent.canonicalize()?;
        let metadata = fs::metadata(&parent)?;
        if parent != policy.cgroup_parent
            || !parent.starts_with("/sys/fs/cgroup")
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(invalid_input("workspace services require an administrator-delegated cgroup owned by the daemon user").into());
        }
        let name = CString::new(parent.as_os_str().as_bytes())?;
        let mut stat = unsafe { std::mem::zeroed::<libc::statfs>() };
        if unsafe { libc::statfs(name.as_ptr(), &mut stat) } != 0 || stat.f_type != 0x6367_7270 {
            return Err(
                invalid_input("workspace services require a real cgroup v2 filesystem").into(),
            );
        }
        let controllers = fs::read_to_string(parent.join("cgroup.subtree_control"))?;
        if !["memory", "pids"].iter().all(|controller| {
            controllers
                .split_whitespace()
                .any(|item| item == *controller)
        }) {
            return Err(invalid_input("workspace services require delegated memory and pids controllers; sandbox startup never changes the daemon's cgroup configuration").into());
        }
        let path = parent.join(format!("happy-service-{}", policy.execution_id));
        // Never reuse a group from a previous execution or erase unknown work.
        fs::create_dir(&path)?;
        let setup = (|| -> SupervisorResult<File> {
            fs::write(
                path.join("memory.max"),
                (u64::from(policy.memory_mi_b) * 1024 * 1024).to_string(),
            )?;
            fs::write(path.join("memory.swap.max"), "0")?;
            fs::write(path.join("memory.oom.group"), "1")?;
            fs::write(path.join("pids.max"), policy.processes.to_string())?;
            Ok(OpenOptions::new()
                .write(true)
                .open(path.join("cgroup.procs"))?)
        })();
        match setup {
            Ok(admission) => Ok(Self { path, admission }),
            Err(error) => {
                let _ = fs::remove_dir(&path);
                Err(error)
            }
        }
    }

    /// Called only in the workload child, before it executes any application instruction.
    pub(super) fn enter(&mut self) -> SupervisorResult<()> {
        self.admission.write_all(b"0")?;
        Ok(())
    }

    /// A process exit is not the confirmation: the entire cgroup must be empty.
    pub(super) fn confirm_and_remove(&self) -> SupervisorResult<()> {
        if !is_empty(&fs::read_to_string(self.path.join("cgroup.events"))?) {
            return Err(invalid_input(
                "service termination is unconfirmed; its cgroup is still populated",
            )
            .into());
        }
        fs::remove_dir(&self.path)?;
        Ok(())
    }
}

impl Drop for ServiceCgroup {
    fn drop(&mut self) {
        // remove_dir cannot remove a populated cgroup. A failed cleanup leaves evidence intact.
        let _ = fs::remove_dir(&self.path);
    }
}

fn is_empty(events: &str) -> bool {
    events
        .lines()
        .any(|line| line.split_whitespace().eq(["populated", "0"]))
}

#[cfg(test)]
mod tests {
    use super::is_empty;
    #[test]
    fn cleanup_requires_explicit_kernel_empty_confirmation() {
        assert!(is_empty("populated 0\nfrozen 0\n"));
        for value in ["", "populated 1\n", "frozen 0\n", "populated 00\n"] {
            assert!(!is_empty(value));
        }
    }
}
