//! Git repository operations run on their owning machine through Runners.
use crate::product::{
    config::ConfigModule,
    owners::{RunOptions, RunnersModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

#[path = "git_credentials.rs"]
mod credentials;

pub struct GitModule {
    config: Arc<ConfigModule>,
    runners: Arc<RunnersModule>,
    schemas: Schemas,
    locks: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    credentials: Arc<credentials::GitCredentialBroker>,
}
impl GitModule {
    pub fn new(config: Arc<ConfigModule>, runners: Arc<RunnersModule>) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in [
            "ownerGitFacts",
            "ownerGitProbe",
            "ownerProjectRemoteSource",
            "ownerWorkspaceBase",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        let credentials = credentials::GitCredentialBroker::new(config.clone())?;
        Ok(Arc::new(Self {
            config,
            runners,
            schemas,
            locks: Mutex::new(HashMap::new()),
            credentials,
        }))
    }
    pub async fn project_lock(
        &self,
        id: &str,
        cancel: &CancellationToken,
    ) -> Result<OwnedMutexGuard<()>> {
        let lock = {
            let mut locks = self
                .locks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
                lock
            } else {
                anyhow::ensure!(
                    locks.len() < 10000,
                    "The project Git lock catalog exceeds its bound."
                );
                let lock = Arc::new(AsyncMutex::new(()));
                locks.insert(id.to_owned(), Arc::downgrade(&lock));
                lock
            }
        };
        tokio::select! {_=cancel.cancelled()=>anyhow::bail!("The Git operation was cancelled."),guard=lock.lock_owned()=>Ok(guard)}
    }
    pub async fn run(
        &self,
        runner: Option<&str>,
        path: &Path,
        args: &[&str],
        cancel: &CancellationToken,
    ) -> Result<String> {
        self.run_with_timeout(runner, path, args, Duration::from_secs(30), cancel)
            .await
    }
    async fn run_with_timeout(
        &self,
        runner: Option<&str>,
        path: &Path,
        args: &[&str],
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<String> {
        let mut environment = BTreeMap::new();
        environment.insert("GIT_TERMINAL_PROMPT".to_owned(), Some("0".to_owned()));
        if let Some(ceiling) = self.config.git_ceiling_directories() {
            environment.insert("GIT_CEILING_DIRECTORIES".to_owned(), Some(ceiling));
        }
        let result = self
            .runners
            .run(
                runner,
                RunOptions {
                    command: "git".to_owned(),
                    args: args.iter().map(|arg| (*arg).to_owned()).collect(),
                    cwd: Some(path.to_path_buf()),
                    environment,
                    maximum_bytes: 1024 * 1024,
                    timeout,
                },
                cancel,
            )
            .await?;
        anyhow::ensure!(
            result.code == 0 && !result.timed_out && !result.truncated,
            "{}",
            if result.stderr.trim().is_empty() {
                "Git could not complete the operation."
            } else {
                result.stderr.trim()
            }
        );
        Ok(String::from_utf8(result.stdout)?.trim().to_owned())
    }
    async fn optional(
        &self,
        runner: Option<&str>,
        path: &Path,
        args: &[&str],
        cancel: &CancellationToken,
    ) -> Result<Option<String>> {
        let result = self.run(runner, path, args, cancel).await;
        anyhow::ensure!(!cancel.is_cancelled(), "The Git operation was cancelled.");
        Ok(result.ok().filter(|text| !text.is_empty()))
    }
    pub async fn top_level(
        &self,
        runner: Option<&str>,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        Ok(normalize(&PathBuf::from(
            self.run(runner, path, &["rev-parse", "--show-toplevel"], cancel)
                .await?,
        )))
    }
    pub async fn common_dir(
        &self,
        runner: Option<&str>,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        let reported = PathBuf::from(
            self.run(
                runner,
                path,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                cancel,
            )
            .await?,
        );
        Ok(normalize(&path.join(reported)))
    }
    pub async fn probe(
        &self,
        runner: Option<&str>,
        path: &Path,
        is_home: bool,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let mut probe = json!({"presence":"present","worktreeSupport":"unsupported"});
        if !self.runners.exists(runner, path, cancel).await? {
            probe["presence"] = json!("missing");
            probe["worktreeSupportReason"] = json!("This folder no longer exists.");
        } else if is_home {
            probe["worktreeSupportReason"] =
                json!("Worktrees cannot be created from your home folder.");
        } else if let Some(top) = self
            .optional(runner, path, &["rev-parse", "--show-toplevel"], cancel)
            .await?
        {
            if normalize(Path::new(&top)) != normalize(path) {
                probe["worktreeSupportReason"] =
                    json!("This folder is inside a Git repository but is not its root.");
            } else {
                let mut facts = json!({"ahead":0,"behind":0,"detached":false});
                let head = self
                    .optional(runner, path, &["rev-parse", "--verify", "HEAD"], cancel)
                    .await?;
                let branch = self
                    .optional(
                        runner,
                        path,
                        &["symbolic-ref", "--quiet", "--short", "HEAD"],
                        cancel,
                    )
                    .await?;
                facts["detached"] = json!(head.is_some() && branch.is_none());
                if let Some(head) = head {
                    facts["head"] = json!(head);
                }
                if let Some(branch) = branch {
                    facts["branch"] = json!(branch);
                    if let Some(upstream) = self
                        .optional(
                            runner,
                            path,
                            &[
                                "rev-parse",
                                "--abbrev-ref",
                                "--symbolic-full-name",
                                "@{upstream}",
                            ],
                            cancel,
                        )
                        .await?
                    {
                        if let Some(divergence) = self
                            .optional(
                                runner,
                                path,
                                &[
                                    "rev-list",
                                    "--left-right",
                                    "--count",
                                    &format!("{upstream}...HEAD"),
                                ],
                                cancel,
                            )
                            .await?
                        {
                            let counts = divergence
                                .split_whitespace()
                                .filter_map(|part| part.parse::<u64>().ok())
                                .collect::<Vec<_>>();
                            if counts.len() == 2 {
                                facts["behind"] = json!(counts[0]);
                                facts["ahead"] = json!(counts[1]);
                            }
                        }
                        facts["upstream"] = json!(upstream);
                    }
                }
                anyhow::ensure!(
                    self.schemas.valid("ownerGitFacts", &facts)?,
                    "Git returned invalid repository facts."
                );
                if facts.get("head").is_some() {
                    probe["worktreeSupport"] = json!("supported");
                } else {
                    probe["worktreeSupportReason"] = json!("This repository has no commits yet.");
                }
                probe["facts"] = facts;
            }
        } else {
            let bare = self
                .optional(runner, path, &["rev-parse", "--is-bare-repository"], cancel)
                .await?;
            probe["worktreeSupportReason"] = json!(if bare.as_deref() == Some("true") {
                "This is a bare Git repository."
            } else {
                "This folder is not a Git repository."
            });
        }
        anyhow::ensure!(
            self.schemas.valid("ownerGitProbe", &probe)?,
            "The repository probe is invalid."
        );
        Ok(probe)
    }
    pub async fn default_branch(
        &self,
        runner: Option<&str>,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<Option<String>> {
        if let Some(head) = self
            .optional(
                runner,
                path,
                &[
                    "symbolic-ref",
                    "--quiet",
                    "--short",
                    "refs/remotes/origin/HEAD",
                ],
                cancel,
            )
            .await?
            && let Some(branch) = head.strip_prefix("origin/")
        {
            return Ok(Some(branch.to_owned()));
        }
        for branch in ["main", "master"] {
            if self
                .optional(
                    runner,
                    path,
                    &[
                        "rev-parse",
                        "--verify",
                        "--quiet",
                        &format!("refs/heads/{branch}"),
                    ],
                    cancel,
                )
                .await?
                .is_some()
                || self
                    .optional(
                        runner,
                        path,
                        &[
                            "rev-parse",
                            "--verify",
                            "--quiet",
                            &format!("refs/remotes/origin/{branch}"),
                        ],
                        cancel,
                    )
                    .await?
                    .is_some()
            {
                return Ok(Some(branch.to_owned()));
            }
        }
        self.optional(
            runner,
            path,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            cancel,
        )
        .await
    }
    pub async fn remote_url(
        &self,
        runner: Option<&str>,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<Option<String>> {
        if let Some(branch) = self
            .optional(
                runner,
                path,
                &["symbolic-ref", "--quiet", "--short", "HEAD"],
                cancel,
            )
            .await?
            && let Some(remote) = self
                .optional(
                    runner,
                    path,
                    &["config", "--get", &format!("branch.{branch}.remote")],
                    cancel,
                )
                .await?
            && remote != "."
            && let Some(url) = self
                .optional(
                    runner,
                    path,
                    &["config", "--get", &format!("remote.{remote}.url")],
                    cancel,
                )
                .await?
        {
            return Ok(Some(url));
        }
        if let Some(url) = self
            .optional(
                runner,
                path,
                &["config", "--get", "remote.origin.url"],
                cancel,
            )
            .await?
        {
            return Ok(Some(url));
        }
        if let Some(remotes) = self.optional(runner, path, &["remote"], cancel).await? {
            for remote in remotes.lines() {
                if let Some(url) = self
                    .optional(
                        runner,
                        path,
                        &["config", "--get", &format!("remote.{remote}.url")],
                        cancel,
                    )
                    .await?
                {
                    return Ok(Some(url));
                }
            }
        }
        Ok(None)
    }
    pub async fn resolve_base(
        &self,
        runner: Option<&str>,
        project: &Path,
        requested: Option<&str>,
        default_branch: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        if requested.is_none_or(|reference| reference.starts_with("origin/"))
            && self
                .optional(runner, project, &["remote", "get-url", "origin"], cancel)
                .await?
                .is_some()
        {
            let _ = self
                .run_with_timeout(
                    runner,
                    project,
                    &["fetch", "origin"],
                    Duration::from_secs(300),
                    cancel,
                )
                .await;
            anyhow::ensure!(
                !cancel.is_cancelled(),
                "Workspace base selection was cancelled."
            );
        }
        let resolved = if let Some(reference) = requested {
            let commit = self
                .run(
                    runner,
                    project,
                    &[
                        "rev-parse",
                        "--verify",
                        "--end-of-options",
                        &format!("{reference}^{{commit}}"),
                    ],
                    cancel,
                )
                .await?;
            json!({"commit":commit,"ref":reference})
        } else {
            let branch=default_branch.context("The project has no branch to start a workspace from. Name an explicit base to fork.")?;
            let remote = format!("refs/remotes/origin/{branch}");
            if let Some(commit) = self
                .optional(
                    runner,
                    project,
                    &[
                        "rev-parse",
                        "--verify",
                        "--end-of-options",
                        &format!("{remote}^{{commit}}"),
                    ],
                    cancel,
                )
                .await?
            {
                json!({"commit":commit,"ref":format!("origin/{branch}")})
            } else {
                let commit = self
                    .run(
                        runner,
                        project,
                        &[
                            "rev-parse",
                            "--verify",
                            "--end-of-options",
                            &format!("refs/heads/{branch}^{{commit}}"),
                        ],
                        cancel,
                    )
                    .await?;
                json!({"commit":commit,"ref":branch})
            }
        };
        anyhow::ensure!(
            self.schemas.valid("ownerWorkspaceBase", &resolved)?,
            "Git returned an invalid workspace base."
        );
        Ok(resolved)
    }
    pub fn remote_name(&self, url: &str) -> Option<String> {
        let repository = url
            .trim_end_matches('/')
            .rsplit(['/', ':'])
            .next()?
            .trim_end_matches(".git");
        if repository.is_empty() {
            None
        } else {
            Some(repository.to_owned())
        }
    }
    pub fn remote_source_url(&self, source: &Value) -> Result<String> {
        anyhow::ensure!(
            self.schemas.valid("ownerProjectRemoteSource", source)?,
            "The Git remote source is invalid."
        );
        Ok(if source["kind"] == "github" {
            format!(
                "https://github.com/{}.git",
                source["repository"]
                    .as_str()
                    .context("The GitHub repository is missing.")?
            )
        } else {
            source["url"]
                .as_str()
                .context("The Git remote URL is missing.")?
                .to_owned()
        })
    }
    pub fn source_matches(&self, actual: &str, source: &Value) -> Result<bool> {
        let expected = self.remote_source_url(source)?;
        let Ok(actual) = reqwest::Url::parse(actual) else {
            return Ok(false);
        };
        if source["kind"] == "github" {
            if actual.scheme() != "https"
                || actual.host_str() != Some("github.com")
                || !actual.username().is_empty()
                || actual.password().is_some()
            {
                return Ok(false);
            }
            let parts = actual
                .path()
                .trim_end_matches(".git")
                .split('/')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            Ok(parts.len() == 2
                && format!("https://github.com/{}.git", parts.join("/"))
                    .eq_ignore_ascii_case(&expected))
        } else {
            Ok(actual.as_str() == expected)
        }
    }
    pub async fn clone_repository(
        &self,
        runner: Option<&str>,
        destination: &Path,
        source: &Value,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.clone_with_environment(runner, destination, source, clone_environment(), cancel)
            .await
    }
    #[expect(clippy::too_many_arguments)]
    pub async fn clone_project(
        &self,
        project: &str,
        creator: &Value,
        runner: Option<&str>,
        destination: &Path,
        source: &Value,
        required_secret: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if source["kind"] == "github"
            && let Some(token) = self.config.github_token()
        {
            self.credentials
                .register(
                    project,
                    creator,
                    source["repository"]
                        .as_str()
                        .context("The GitHub repository is missing.")?,
                    &token,
                )
                .await?;
        }
        let lease = self.credentials.authentication(project, creator)?;
        anyhow::ensure!(
            required_secret != Some("github") || lease.is_some(),
            "GitHub credentials are unavailable. Try this project again once GitHub is connected."
        );
        let mut environment = clone_environment();
        if let Some(lease) = &lease {
            let mut authenticated = lease.environment.clone();
            if let Some(runner) = runner {
                let port = self
                    .runners
                    .credential_proxy_port(runner, lease.loopback_port, cancel)
                    .await?;
                for value in authenticated.values_mut().flatten() {
                    *value = value.replace(
                        &format!("http://127.0.0.1:{}/", lease.loopback_port),
                        &format!("http://127.0.0.1:{port}/"),
                    );
                }
            }
            environment.extend(authenticated);
        }
        self.clone_with_environment(runner, destination, source, environment, cancel)
            .await
    }
    pub async fn revoke_credentials(&self, project: &str) {
        self.credentials.revoke_project(project);
    }
    pub async fn close(&self) {
        self.credentials.close().await;
    }
    async fn clone_with_environment(
        &self,
        runner: Option<&str>,
        destination: &Path,
        source: &Value,
        environment: BTreeMap<String, Option<String>>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let remote = self.remote_source_url(source)?;
        anyhow::ensure!(
            destination.is_absolute() && normalize(destination) == destination,
            "The clone destination must be an absolute normalized path."
        );
        let parent = destination
            .parent()
            .context("The clone destination has no parent.")?;
        self.runners.mkdir(runner, parent, cancel).await?;
        self.real_directory(runner, parent, cancel).await?;
        anyhow::ensure!(
            !self.runners.exists(runner, destination, cancel).await?,
            "The clone destination already exists."
        );
        let root = parent.join(".rig");
        let staging_root = root.join("clones");
        for path in [&root, &staging_root] {
            self.runners.mkdir(runner, path, cancel).await?;
            self.real_directory(runner, path, cancel).await?;
        }
        let staging = staging_root.join(format!(
            "{}-{}",
            destination
                .file_name()
                .context("The clone destination has no name.")?
                .to_string_lossy(),
            cuid2::create_id()
        ));
        let identities = if runner.is_none() {
            Some([
                directory_identity(parent)?,
                directory_identity(&root)?,
                directory_identity(&staging_root)?,
            ])
        } else {
            None
        };
        let clone = async {
            let cloned = self
                .runners
                .run(
                    runner,
                    RunOptions {
                        command: "git".to_owned(),
                        args: vec![
                            "clone".to_owned(),
                            "--".to_owned(),
                            remote.clone(),
                            staging.to_string_lossy().into_owned(),
                        ],
                        cwd: Some(parent.to_path_buf()),
                        environment: environment.clone(),
                        maximum_bytes: 1024 * 1024,
                        timeout: Duration::from_secs(3600),
                    },
                    cancel,
                )
                .await?;
            anyhow::ensure!(
                cloned.code == 0 && !cloned.truncated && !cloned.timed_out,
                "{}",
                if cloned.stderr.trim().is_empty() {
                    "The clone did not complete.".to_owned()
                } else {
                    credentials::redact(cloned.stderr.trim(), &environment)
                }
            );
            anyhow::ensure!(
                self.top_level(runner, &staging, cancel).await? == staging,
                "The cloned folder is not a repository root."
            );
            let origin = self
                .run(runner, &staging, &["remote", "get-url", "origin"], cancel)
                .await?;
            anyhow::ensure!(
                self.source_matches(&origin, source)?,
                "The cloned folder has an unexpected origin."
            );
            for path in [parent, &root, &staging_root] {
                self.real_directory(runner, path, cancel).await?;
            }
            if let Some(identities) = identities {
                for (path, identity) in [parent, &root, &staging_root].into_iter().zip(identities) {
                    anyhow::ensure!(
                        directory_identity(path)? == identity,
                        "The clone destination's directory identity changed while cloning."
                    );
                }
            }
            anyhow::ensure!(
                !self.runners.exists(runner, destination, cancel).await?,
                "The clone destination appeared while cloning."
            );
            self.runners
                .move_path(runner, &staging, destination, cancel)
                .await
        }
        .await;
        let cleanup = CancellationToken::new();
        let _ = self.runners.remove(runner, &staging, &cleanup).await;
        clone
    }
    pub async fn real_directory(
        &self,
        runner: Option<&str>,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let metadata = self.runners.inspect(runner, path, cancel).await?;
        anyhow::ensure!(
            metadata["isDirectory"] == true && metadata["isSymbolicLink"] == false,
            "The managed path must be a real directory."
        );
        anyhow::ensure!(
            self.runners.canonical_path(runner, path, cancel).await? == path,
            "The managed path must be canonical."
        );
        Ok(())
    }
    pub async fn is_worktree(
        &self,
        runner: Option<&str>,
        path: &Path,
        common: &Path,
        cancel: &CancellationToken,
    ) -> Result<bool> {
        let identity = async {
            Ok::<_, anyhow::Error>(
                self.top_level(runner, path, cancel).await? == path
                    && self.common_dir(runner, path, cancel).await? == common,
            )
        }
        .await;
        anyhow::ensure!(
            !cancel.is_cancelled(),
            "The worktree operation was cancelled."
        );
        Ok(identity.unwrap_or(false))
    }
    #[expect(clippy::too_many_arguments)]
    pub async fn create_worktree(
        &self,
        runner: Option<&str>,
        project: &Path,
        workspace: &Path,
        branch: &str,
        commit: &str,
        common: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.runners
            .mkdir(
                runner,
                workspace
                    .parent()
                    .context("The workspace path has no parent.")?,
                cancel,
            )
            .await?;
        self.run_with_timeout(
            runner,
            project,
            &[
                "worktree",
                "add",
                "-b",
                branch,
                "--",
                &workspace.to_string_lossy(),
                commit,
            ],
            Duration::from_secs(1800),
            cancel,
        )
        .await?;
        anyhow::ensure!(
            self.is_worktree(runner, workspace, common, cancel).await?,
            "Git created the workspace from an unexpected repository."
        );
        Ok(())
    }
    pub async fn remove_worktree(
        &self,
        runner: Option<&str>,
        project: &Path,
        workspace: &Path,
        common: &Path,
        remove_directory: bool,
        cancel: &CancellationToken,
    ) -> Result<()> {
        anyhow::ensure!(
            self.common_dir(runner, project, cancel).await? == common,
            "The source repository no longer owns this workspace."
        );
        if remove_directory {
            self.real_directory(runner, workspace, cancel).await?;
            anyhow::ensure!(
                self.is_worktree(runner, workspace, common, cancel).await?,
                "The workspace belongs to an unexpected repository."
            );
            self.run_with_timeout(
                runner,
                project,
                &[
                    "worktree",
                    "remove",
                    "--force",
                    "--force",
                    &workspace.to_string_lossy(),
                ],
                Duration::from_secs(1800),
                cancel,
            )
            .await?;
        }
        self.run(runner, project, &["worktree", "prune"], cancel)
            .await?;
        Ok(())
    }
}

fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn clone_environment() -> BTreeMap<String, Option<String>> {
    let mut environment = BTreeMap::new();
    for name in [
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_ASKPASS",
        "GIT_AUTHOR_EMAIL",
        "GIT_AUTHOR_NAME",
        "GIT_COMMITTER_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_CONFIG",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_DIR",
        "GIT_EXEC_PATH",
        "GIT_OBJECT_DIRECTORY",
        "GIT_PROXY_COMMAND",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_TEMPLATE_DIR",
        "GIT_WORK_TREE",
    ] {
        environment.insert(name.to_owned(), None);
    }
    for (name, _) in std::env::vars_os() {
        let name = name.to_string_lossy();
        if name.starts_with("GIT_CONFIG_KEY_") || name.starts_with("GIT_CONFIG_VALUE_") {
            environment.insert(name.into_owned(), None);
        }
    }
    for (name, value) in [
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_CONFIG_COUNT", "1"),
        ("GIT_CONFIG_KEY_0", "credential.helper"),
        ("GIT_CONFIG_VALUE_0", ""),
        ("GIT_TERMINAL_PROMPT", "0"),
    ] {
        environment.insert(name.to_owned(), Some(value.to_owned()));
    }
    environment
}

#[cfg(unix)]
fn directory_identity(path: &Path) -> Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::symlink_metadata(path)?;
    anyhow::ensure!(
        metadata.is_dir() && !metadata.is_symlink(),
        "The clone's managed directory is not a real directory."
    );
    Ok((metadata.dev(), metadata.ino()))
}
#[cfg(windows)]
fn directory_identity(path: &Path) -> Result<(u64, u64)> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt};
    #[repr(C)]
    struct Information {
        attributes: u32,
        creation: [u32; 2],
        access: [u32; 2],
        write: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const c_void,
            creation: u32,
            flags: u32,
            template: *mut c_void,
        ) -> *mut c_void;
        fn GetFileInformationByHandle(handle: *mut c_void, information: *mut Information) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            0x80,
            7,
            std::ptr::null(),
            3,
            0x02000000 | 0x00200000,
            std::ptr::null_mut(),
        )
    };
    anyhow::ensure!(
        handle as isize != -1,
        "The clone directory cannot be opened: {}",
        std::io::Error::last_os_error()
    );
    let mut information = std::mem::MaybeUninit::<Information>::uninit();
    let result = unsafe { GetFileInformationByHandle(handle, information.as_mut_ptr()) };
    let error = std::io::Error::last_os_error();
    unsafe {
        CloseHandle(handle);
    }
    anyhow::ensure!(
        result != 0,
        "The clone directory identity cannot be read: {error}"
    );
    let information = unsafe { information.assume_init() };
    anyhow::ensure!(
        information.attributes & 0x10 != 0 && information.attributes & 0x400 == 0,
        "The clone's managed directory is not a real directory."
    );
    Ok((
        u64::from(information.volume),
        (u64::from(information.index_high) << 32) | u64::from(information.index_low),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::owners::tests::Fixture;

    async fn owner(fixture: &Fixture) -> Arc<GitModule> {
        let runners = RunnersModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        runners.load().await.unwrap();
        GitModule::new(fixture.config.clone(), runners).unwrap()
    }
    async fn committed_repository(git: &GitModule, path: &Path) {
        tokio::fs::create_dir_all(path).await.unwrap();
        let cancel = CancellationToken::new();
        git.run(None, path, &["init", "--initial-branch=main"], &cancel)
            .await
            .unwrap();
        git.run(
            None,
            path,
            &["config", "user.name", "Native owner test"],
            &cancel,
        )
        .await
        .unwrap();
        git.run(
            None,
            path,
            &["config", "user.email", "owner@example.test"],
            &cancel,
        )
        .await
        .unwrap();
        tokio::fs::write(path.join("tracked.txt"), "original\n")
            .await
            .unwrap();
        git.run(None, path, &["add", "tracked.txt"], &cancel)
            .await
            .unwrap();
        git.run(None, path, &["commit", "-m", "Original commit"], &cancel)
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn real_worktrees_keep_their_original_base_and_repository_owner() {
        let fixture = Fixture::new().await;
        let git = owner(&fixture).await;
        let cancel = CancellationToken::new();
        let repository = fixture.directory.path().join("repository");
        committed_repository(&git, &repository).await;
        let probe = git.probe(None, &repository, false, &cancel).await.unwrap();
        assert_eq!(probe["worktreeSupport"], "supported");
        assert_eq!(probe["facts"]["branch"], "main");
        let common = git.common_dir(None, &repository, &cancel).await.unwrap();
        let base = git
            .resolve_base(None, &repository, None, Some("main"), &cancel)
            .await
            .unwrap();
        let checkout = fixture.directory.path().join("checkout");
        git.create_worktree(
            None,
            &repository,
            &checkout,
            "worktree/native-test",
            base["commit"].as_str().unwrap(),
            &common,
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(checkout.join("tracked.txt"))
                .await
                .unwrap(),
            "original\n"
        );
        assert!(
            git.is_worktree(None, &checkout, &common, &cancel)
                .await
                .unwrap()
        );
        assert!(
            !git.is_worktree(
                None,
                &checkout,
                &fixture.directory.path().join("other/.git"),
                &cancel
            )
            .await
            .unwrap()
        );
        git.remove_worktree(None, &repository, &checkout, &common, true, &cancel)
            .await
            .unwrap();
        assert!(!checkout.exists());
        assert!(repository.join("tracked.txt").exists());
        git.close().await;
        fixture.close().await;
    }
    #[tokio::test]
    async fn a_project_lock_is_shared_and_a_cancelled_waiter_does_not_acquire_it() {
        let fixture = Fixture::new().await;
        let git = owner(&fixture).await;
        let held = git
            .project_lock("same-project", &CancellationToken::new())
            .await
            .unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(git.project_lock("same-project", &cancel).await.is_err());
        let separate = git
            .project_lock("another-project", &CancellationToken::new())
            .await
            .unwrap();
        drop(separate);
        drop(held);
        git.project_lock("same-project", &CancellationToken::new())
            .await
            .unwrap();
        git.close().await;
        fixture.close().await;
    }
    #[tokio::test]
    async fn repository_adoption_requires_the_original_remote_contract() {
        let fixture = Fixture::new().await;
        let git = owner(&fixture).await;
        let source = json!({"kind":"github","repository":"owner/repository"});
        assert!(
            git.source_matches("https://github.com/OWNER/repository.git", &source)
                .unwrap()
        );
        for remote in [
            "git@github.com:owner/repository.git",
            "https://attacker.test/owner/repository.git",
            "https://user@github.com/owner/repository.git",
            "https://github.com/owner/other.git",
        ] {
            assert!(!git.source_matches(remote, &source).unwrap());
        }
        let generic = json!({"kind":"git","url":"https://example.test/repository.git"});
        assert!(
            git.source_matches("https://example.test/repository.git", &generic)
                .unwrap()
        );
        assert!(
            !git.source_matches("https://example.test/repository", &generic)
                .unwrap()
        );
        git.close().await;
        fixture.close().await;
    }
}
