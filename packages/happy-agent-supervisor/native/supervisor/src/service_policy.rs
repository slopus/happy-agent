use crate::{SupervisorResult, invalid_input};
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ServiceInput {
    pub(crate) source: PathBuf,
    pub(crate) destination: PathBuf,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ServiceDestination {
    pub(crate) hostname: String,
    pub(crate) port: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ServicePolicy {
    pub(crate) root: PathBuf,
    pub(crate) cwd: PathBuf,
    pub(crate) inputs: Vec<ServiceInput>,
    pub(crate) scratch: Vec<PathBuf>,
    pub(crate) cgroup_parent: PathBuf,
    pub(crate) execution_id: String,
    pub(crate) controller_pid: i32,
    pub(crate) bridge_socket: PathBuf,
    pub(crate) bridge_token: String,
    pub(crate) port: u16,
    #[serde(rename = "memoryMiB")]
    pub(crate) memory_mi_b: u32,
    pub(crate) processes: u32,
    pub(crate) outbound: Vec<ServiceDestination>,
}

impl ServicePolicy {
    pub(crate) fn validate(&self) -> SupervisorResult<()> {
        for path in [&self.root, &self.cgroup_parent, &self.bridge_socket] {
            if !path.is_absolute() || path.parent().is_none_or(|parent| parent == Path::new("/")) {
                return Err(
                    invalid_input("service control paths must be private absolute paths").into(),
                );
            }
        }
        if self.bridge_socket.starts_with(&self.root) {
            return Err(
                invalid_input("the service bridge must be outside its filesystem root").into(),
            );
        }
        if self.controller_pid < 2
            || self.execution_id.len() < 16
            || self.execution_id.len() > 64
            || !self
                .execution_id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            || self.bridge_token.len() != 64
            || !self
                .bridge_token
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(invalid_input("invalid service execution or bridge identity").into());
        }
        if !(128..=1024).contains(&self.memory_mi_b)
            || !(1..=64).contains(&self.processes)
            || self.port < 1024
            || self.inputs.is_empty()
            || self.inputs.len() > 128
            || self.scratch.len() > 32
            || self.outbound.len() > 32
        {
            return Err(invalid_input("service limits are outside the supported bounds").into());
        }
        if self.cwd != Path::new(".") {
            validate_relative(&self.cwd)?;
        }
        for input in &self.inputs {
            if !input.source.is_absolute() {
                return Err(invalid_input("service input sources must be absolute").into());
            }
            validate_relative(&input.destination)?;
        }
        for (index, input) in self.inputs.iter().enumerate() {
            if self.inputs.iter().skip(index + 1).any(|other| {
                input.destination.starts_with(&other.destination)
                    || other.destination.starts_with(&input.destination)
            }) {
                return Err(invalid_input(
                    "service input mounts must be deduplicated and non-overlapping",
                )
                .into());
            }
        }
        for path in &self.scratch {
            validate_relative(path)?;
        }
        for destination in &self.outbound {
            if destination.port == 0
                || destination.hostname.is_empty()
                || destination.hostname.len() > 253
                || !destination
                    .hostname
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
            {
                return Err(invalid_input(
                    "service outbound entries require an exact hostname and port",
                )
                .into());
            }
        }
        Ok(())
    }
}

fn validate_relative(path: &Path) -> SupervisorResult<()> {
    let spelling = path.to_string_lossy();
    if path.as_os_str().is_empty()
        || path.as_os_str().len() > 4096
        || spelling.contains('\\')
        || spelling
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(
            invalid_input("service workspace paths must be normalized relative paths").into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_relative;
    use std::path::Path;

    #[test]
    fn workspace_paths_cannot_escape_or_depend_on_normalization() {
        for path in [
            "",
            ".",
            "..",
            "/etc",
            "../private",
            "a/../b",
            "a/./b",
            "a//b",
            "a/",
            "a\\b",
        ] {
            assert!(validate_relative(Path::new(path)).is_err(), "{path}");
        }
        assert!(validate_relative(Path::new("src/server.js")).is_ok());
    }
}
