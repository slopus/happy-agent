//! A compute-owned filesystem value shared by feature callers and file tools.
use super::*;
use crate::product::owners::RunnerCompute;

#[derive(Clone)]
enum Backend {
    Local(Boundary),
    Runner(Arc<RunnerCompute>),
}
#[derive(Clone)]
pub struct ComputeFilesystem {
    backend: Backend,
    identity: String,
    permissions: Value,
    schemas: Arc<Schemas>,
}
impl ComputeFilesystem {
    pub(super) fn local(boundary: Boundary, identity: String) -> Result<Self> {
        let full = boundary.mode == "full_access";
        let permissions =
            json!({"mode":boundary.mode,"network":{"egress":full,"localBinding":full}});
        Ok(Self {
            backend: Backend::Local(boundary),
            identity,
            permissions,
            schemas: Arc::new(Schemas::new()?),
        })
    }
    pub(in crate::product::tools) fn runner(
        compute: Arc<RunnerCompute>,
        mode: &str,
    ) -> Result<Self> {
        let permissions = compute.permissions(mode)?;
        Ok(Self {
            identity: compute.filesystem_identity(),
            backend: Backend::Runner(compute),
            permissions,
            schemas: Arc::new(Schemas::new()?),
        })
    }
    pub fn is_native(&self) -> bool {
        matches!(self.backend, Backend::Local(_))
    }
    pub fn cwd(&self) -> &Path {
        match &self.backend {
            Backend::Local(boundary) => &boundary.root,
            Backend::Runner(compute) => compute.cwd(),
        }
    }
    pub fn home(&self) -> Option<PathBuf> {
        match &self.backend {
            Backend::Local(boundary) => Some(boundary.home.clone()),
            Backend::Runner(compute) => compute.home(),
        }
    }
    pub fn identity(&self) -> String {
        match &self.backend {
            Backend::Local(boundary) => {
                format!("native:{}:{}", self.identity, boundary.root.display())
            }
            Backend::Runner(compute) => compute.filesystem_identity(),
        }
    }
    pub fn permissions(&self) -> Value {
        self.permissions.clone()
    }
    pub fn resolve(&self, written: &str) -> Result<PathBuf> {
        match &self.backend {
            Backend::Local(boundary) => boundary.resolve(written),
            Backend::Runner(compute) => compute.resolve(written),
        }
    }
    fn path<'a>(&self, path: &'a Path) -> Result<&'a str> {
        path.to_str().context("The filesystem path is not UTF-8.")
    }
    fn check(cancel: &CancellationToken) -> Result<()> {
        ensure!(
            !cancel.is_cancelled(),
            "The filesystem operation was interrupted."
        );
        Ok(())
    }
    pub async fn exists(&self, path: &Path, cancel: &CancellationToken) -> Result<bool> {
        Self::check(cancel)?;
        match &self.backend {
            Backend::Runner(compute) => compute.exists(&self.permissions, path, cancel).await,
            Backend::Local(boundary) => {
                let path = boundary.target(self.path(path)?, false)?;
                match tokio::fs::metadata(path).await {
                    Ok(_) => Ok(true),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                    Err(error) => Err(error.into()),
                }
            }
        }
    }
    pub async fn stat(
        &self,
        path: &Path,
        no_follow: bool,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        Self::check(cancel)?;
        match &self.backend {
            Backend::Runner(compute) => {
                compute
                    .stat(&self.permissions, path, no_follow, cancel)
                    .await
            }
            Backend::Local(boundary) => {
                let target = boundary.target(self.path(path)?, false)?;
                let path = if no_follow {
                    boundary.resolve(self.path(path)?)?
                } else {
                    target
                };
                let metadata = if no_follow {
                    tokio::fs::symlink_metadata(path).await
                } else {
                    tokio::fs::metadata(path).await
                };
                let stat = match metadata {
                    Ok(metadata) => {
                        let modified = metadata
                            .modified()?
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or_else(
                                |error| -(error.duration().as_secs_f64() * 1000.0),
                                |duration| duration.as_secs_f64() * 1000.0,
                            );
                        json!({"isFile":metadata.is_file(),"isDirectory":metadata.is_dir(),"isSymbolicLink":metadata.is_symlink(),"size":metadata.len(),"mtimeMs":modified})
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
                    Err(error) => return Err(error.into()),
                };
                ensure!(
                    self.schemas
                        .valid("ownerRunnerResult_fs_lstat", &json!({"stat":stat}))?,
                    "The filesystem metadata is invalid."
                );
                Ok(stat)
            }
        }
    }
    pub async fn lstat_many(
        &self,
        paths: &[PathBuf],
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>> {
        ensure!(
            paths.len() <= 10000,
            "The filesystem metadata batch exceeds its bound."
        );
        match &self.backend {
            Backend::Runner(compute) => compute.lstat_many(&self.permissions, paths, cancel).await,
            Backend::Local(_) => {
                let mut result = Vec::with_capacity(paths.len());
                for path in paths {
                    result.push(self.stat(path, true, cancel).await?);
                }
                Ok(result)
            }
        }
    }
    pub async fn entries(
        &self,
        path: &Path,
        after: Option<&str>,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        Self::check(cancel)?;
        ensure!(
            limit > 0 && limit <= 100000,
            "The directory page size is invalid."
        );
        match &self.backend {
            Backend::Runner(compute) => {
                compute
                    .entries(&self.permissions, path, after, limit, cancel)
                    .await
            }
            Backend::Local(boundary) => {
                let path = boundary.target(self.path(path)?, false)?;
                let mut directory = tokio::fs::read_dir(path).await?;
                let mut names = Vec::new();
                while let Some(entry) = directory.next_entry().await? {
                    Self::check(cancel)?;
                    ensure!(
                        names.len() < 100000,
                        "The directory exceeds its entry bound."
                    );
                    let name = entry.file_name().into_string().map_err(|_| {
                        anyhow::anyhow!("The directory contains an invalid UTF-8 name.")
                    })?;
                    if after
                        .is_none_or(|after| name.encode_utf16().cmp(after.encode_utf16()).is_gt())
                    {
                        names.push(name);
                    }
                }
                names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
                let more = names.len() > limit;
                names.truncate(limit);
                let result = json!({"entries":names,"hasMore":more});
                ensure!(
                    self.schemas
                        .valid("ownerRunnerResult_fs_readdirPage", &result)?,
                    "The directory page is invalid."
                );
                Ok(result)
            }
        }
    }
    pub async fn canonical_path(&self, path: &Path, cancel: &CancellationToken) -> Result<PathBuf> {
        Self::check(cancel)?;
        match &self.backend {
            Backend::Runner(compute) => {
                compute
                    .canonical_path(&self.permissions, path, cancel)
                    .await
            }
            Backend::Local(boundary) => {
                let target = boundary.target(self.path(path)?, false)?;
                Ok(tokio::fs::canonicalize(target).await?)
            }
        }
    }
    pub async fn read_file(
        &self,
        path: &Path,
        maximum: usize,
        no_follow: bool,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        Self::check(cancel)?;
        ensure!(
            maximum <= 64 * 1024 * 1024,
            "The file byte limit exceeds the compute boundary."
        );
        match &self.backend {
            Backend::Runner(compute) => {
                compute
                    .read_file(&self.permissions, path, maximum, no_follow, cancel)
                    .await
            }
            Backend::Local(boundary) => {
                let target = boundary.target(self.path(path)?, false)?;
                let path = if no_follow {
                    boundary.resolve(self.path(path)?)?
                } else {
                    target
                };
                Ok(read_async(path, maximum, cancel).await?.0)
            }
        }
    }
}
