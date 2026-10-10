//! Config supplies the standalone runner's immutable native filesystem policy.
use super::{ComputeFileEnvironment, ConfigModule};
use anyhow::{Context as _, Result, ensure};
use serde_json::Value;
use std::path::{Path, PathBuf};

impl ConfigModule {
    pub fn runner_file_environment(&self, request: &Value) -> Result<ComputeFileEnvironment> {
        let root = PathBuf::from(
            request["cwd"]
                .as_str()
                .context("The runner working directory is missing.")?,
        );
        ensure!(
            root.is_absolute(),
            "The runner working directory must be an absolute path."
        );
        let mut protected = ["AGENTS.md", "AGENTS_SECURITY.md", "happy.toml", "mcp.toml"]
            .into_iter()
            .map(str::to_owned)
            .collect::<std::collections::BTreeSet<_>>();
        for name in request["policy"]["protectedProjectFiles"]
            .as_array()
            .into_iter()
            .flatten()
        {
            protected.insert(
                name.as_str()
                    .context("The protected runner path is invalid.")?
                    .to_owned(),
            );
        }
        let protected_paths = protected
            .into_iter()
            .map(|name| root.join(Path::new(&name)))
            .collect();
        Ok(ComputeFileEnvironment {
            root,
            home: self.os_home.clone(),
            private_paths: vec![self.paths.directory.clone()],
            protected_paths,
        })
    }
}
