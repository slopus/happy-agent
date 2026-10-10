use anyhow::{Context, Result, bail, ensure};
use std::path::{Component, Path, PathBuf};

/// One operation's immutable filesystem boundary. The owning Config module
/// supplies the workspace and home; tools never derive a second workspace.
#[derive(Clone)]
pub(super) struct Boundary {
    pub root: PathBuf,
    pub home: PathBuf,
    pub mode: String,
    pub private_paths: Vec<PathBuf>,
    pub protected_paths: Vec<PathBuf>,
    pub allowed_write_paths: Vec<PathBuf>,
    pub denied_read_paths: Vec<PathBuf>,
    pub denied_write_paths: Vec<PathBuf>,
}

impl Boundary {
    pub fn resolve(&self, path: &str) -> Result<PathBuf> {
        ensure!(
            !path.is_empty() && !path.contains('\0'),
            "The file path is invalid."
        );
        let path = if path == "~" {
            self.home.clone()
        } else if let Some(relative) = path.strip_prefix("~/") {
            self.home.join(relative)
        } else {
            let written = Path::new(path);
            if written.is_absolute() {
                written.to_owned()
            } else {
                self.root.join(written)
            }
        };
        Ok(normalize(&path))
    }

    pub fn review(&self, written: &str, write: bool) -> bool {
        let Ok(path) = self.resolve(written) else {
            return true;
        };
        let Ok(target) = canonical(&path) else {
            return true;
        };
        !path.starts_with(&self.root)
            || !target.starts_with(&self.root)
            || self.private(&path)
            || self.private(&target)
            || (write && (self.protected(&path) || self.protected(&target)))
    }

    pub fn target(&self, written: &str, write: bool) -> Result<PathBuf> {
        let path = self.resolve(written)?;
        let target = canonical(&path)?;
        ensure!(
            !self.private(&path) && !self.private(&target),
            "The private Happy installation directory cannot be accessed through file tools."
        );
        let denied = if write {
            &self.denied_write_paths
        } else {
            &self.denied_read_paths
        };
        ensure!(
            !denied.iter().any(|denied| path.starts_with(denied)
                || target.starts_with(denied)
                || canonical(denied).is_ok_and(|denied| target.starts_with(denied))),
            "The permission boundary blocks access to this path: {}.",
            path.display()
        );
        if !write || self.mode == "full_access" {
            return Ok(target);
        }
        if self.mode == "read_only" {
            bail!("File changes are disabled in Read only mode.");
        }
        ensure!(
            (path.starts_with(&self.root) && target.starts_with(&self.root))
                || self
                    .allowed_write_paths
                    .iter()
                    .any(|allowed| path.starts_with(allowed)
                        || canonical(allowed).is_ok_and(|allowed| target.starts_with(allowed))),
            "Workspace write mode cannot modify files outside the working directory: {}.",
            self.root.display()
        );
        ensure!(
            !self.protected(&path) && !self.protected(&target),
            "Workspace write mode cannot modify protected project or Git control files without Full access."
        );
        Ok(target)
    }
    pub fn searchable(&self, path: &Path) -> bool {
        path.to_str()
            .is_some_and(|path| self.target(path, false).is_ok())
    }
    pub fn entry(&self, written: &str) -> Result<PathBuf> {
        self.target(written, true)?;
        let path = self.resolve(written)?;
        Ok(canonical(
            path.parent()
                .context("The operation requires a parent directory.")?,
        )?
        .join(
            path.file_name()
                .context("The operation requires a file name.")?,
        ))
    }
    fn private(&self, path: &Path) -> bool {
        self.private_paths.iter().any(|private| {
            path.starts_with(private)
                || canonical(private).is_ok_and(|private| path.starts_with(private))
        })
    }
    fn protected(&self, path: &Path) -> bool {
        self.protected_paths.iter().any(|protected| {
            path.starts_with(protected)
                || canonical(protected).is_ok_and(|protected| path.starts_with(protected))
        }) || git_control(path)
    }
}

/// Resolve the nearest existing ancestor, preserving missing names without
/// creating a placeholder. Failed resolution is never treated as containment.
fn canonical(path: &Path) -> Result<PathBuf> {
    let mut current = path.to_owned();
    let mut missing = Vec::new();
    for _ in 0..=64 {
        match std::fs::canonicalize(&current) {
            Ok(mut resolved) => {
                for name in missing.iter().rev() {
                    resolved.push(name);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if std::fs::symlink_metadata(&current).is_ok_and(|metadata| metadata.is_symlink()) {
                    let destination = std::fs::read_link(&current)?;
                    current = normalize(&if destination.is_absolute() {
                        destination
                    } else {
                        current
                            .parent()
                            .context("The symbolic link has no parent directory.")?
                            .join(destination)
                    });
                    continue;
                }
                missing.push(
                    current
                        .file_name()
                        .context("The file path has no resolvable ancestor.")?
                        .to_owned(),
                );
                ensure!(current.pop(), "The file path has no resolvable ancestor.");
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("The file path cannot be resolved: {}.", path.display())
                });
            }
        }
    }
    bail!("The file path exceeds the unresolved directory depth limit.")
}

fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            component => result.push(component.as_os_str()),
        }
    }
    result
}

fn git_control(path: &Path) -> bool {
    path.components().any(|part| {
        part.as_os_str().to_str().is_some_and(|name| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                ".git" | ".gitconfig" | ".gitmodules"
            )
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_paths_guard_missing_names_and_symlink_destinations_without_placeholders() -> Result<()>
    {
        let workspace = tempfile::tempdir()?;
        let outside = tempfile::tempdir()?;
        let boundary = Boundary {
            root: std::fs::canonicalize(workspace.path())?,
            home: outside.path().to_owned(),
            mode: "workspace_write".into(),
            private_paths: Vec::new(),
            protected_paths: ["AGENTS.md", "happy.toml", "mcp.toml", "AGENTS_SECURITY.md"]
                .map(|name| workspace.path().join(name))
                .to_vec(),
            allowed_write_paths: Vec::new(),
            denied_read_paths: Vec::new(),
            denied_write_paths: Vec::new(),
        };
        assert!(
            boundary
                .target("new/tree/file.txt", true)?
                .starts_with(workspace.path())
        );
        for path in [
            "happy.toml",
            "AGENTS_SECURITY.md",
            "mcp.toml",
            ".git/config",
            "nested/.GIT/config",
            "nested/.gitmodules",
        ] {
            assert!(boundary.review(path, true), "{path}");
            assert!(boundary.target(path, true).is_err(), "{path}");
            assert!(!workspace.path().join(path).exists());
        }
        assert!(!boundary.review("rig.toml", true));
        assert!(boundary.target("rig.toml", true).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), workspace.path().join("escape"))?;
            assert!(boundary.review("escape/new/file", true));
            assert!(boundary.target("escape/new/file", true).is_err());
            std::os::unix::fs::symlink(
                workspace.path().join("happy.toml"),
                workspace.path().join("dangling"),
            )?;
            assert!(boundary.review("dangling", true));
            assert!(boundary.target("dangling", true).is_err());
        }
        let read_only = Boundary {
            mode: "read_only".into(),
            ..boundary
        };
        assert!(read_only.target("ordinary.txt", true).is_err());
        assert!(
            read_only
                .target(outside.path().to_str().unwrap(), false)
                .is_ok()
        );
        let full = Boundary {
            mode: "full_access".into(),
            ..read_only
        };
        assert!(full.target("happy.toml", true).is_ok());
        Ok(())
    }
}
