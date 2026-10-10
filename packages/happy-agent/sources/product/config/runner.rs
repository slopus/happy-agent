//! Config supplies the standalone runner's immutable native filesystem policy.
use super::{ComputeFileEnvironment, ConfigModule};
use anyhow::{Context as _, Result, ensure};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub enum RunnerEndpoint {
    WebSocket(String),
    Unix {
        socket: PathBuf,
        url: String,
    },
    Tailcat {
        address: String,
        port: u16,
        url: String,
    },
}
#[derive(Clone)]
pub struct RunnerSettings {
    pub endpoint: RunnerEndpoint,
    pub token: String,
    pub home: PathBuf,
    pub private_directories: Vec<PathBuf>,
}
impl RunnerEndpoint {
    pub fn url(&self) -> &str {
        match self {
            Self::WebSocket(url) | Self::Unix { url, .. } | Self::Tailcat { url, .. } => url,
        }
    }
}

fn absolute(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                result.pop();
            }
            component => result.push(component.as_os_str()),
        }
    }
    Ok(result)
}

fn parse(
    args: &[std::ffi::OsString],
    mut endpoint: Option<String>,
    token: Option<String>,
    os_home: &Path,
) -> Result<RunnerSettings> {
    let mut home = os_home.to_owned();
    let mut token_file = None;
    let mut index = 0;
    while index < args.len() {
        let argument = args[index]
            .to_str()
            .context("The runner argument is not UTF-8.")?;
        ensure!(
            ["--endpoint", "--token-file", "--home"].contains(&argument),
            "The runner does not take {argument}. Run happy-agent runner --help to see its options."
        );
        let value = args
            .get(index + 1)
            .and_then(|value| value.to_str())
            .filter(|value| !value.starts_with("--"))
            .with_context(|| format!("{argument} needs a value."))?;
        match argument {
            "--endpoint" => endpoint = Some(value.to_owned()),
            "--token-file" => token_file = Some(absolute(Path::new(value))?),
            "--home" => home = absolute(Path::new(value))?,
            _ => unreachable!(),
        }
        index += 2;
    }
    let state = os_home.join(".happy-runner");
    let token_file = token_file.unwrap_or_else(|| state.join("token"));
    let trim = |token: &str| {
        token
            .trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
            .to_owned()
    };
    let token=token.map(|token|trim(&token)).filter(|token|!token.is_empty()).map(Ok).unwrap_or_else(||std::fs::read_to_string(&token_file).map(|token|trim(&token)).with_context(||format!("The runner has no token: {} could not be read. Write its daemon token to that file or set HAPPY_RUNNER_TOKEN.",token_file.display())))?;
    let schemas = crate::product::schemas::Schemas::new()?;
    ensure!(
        schemas.valid(
            "ownerRunnersConfiguration",
            &json!({"entries":{"runner":{"name":"Runner","token":token}}})
        )?,
        "The runner's token is not a 43-character token."
    );
    let endpoint = endpoint.filter(|endpoint| !endpoint.is_empty()).context(
        "The runner does not know where its daemon is. Pass --endpoint with the daemon's address.",
    )?;
    let endpoint = if let Some(socket) = endpoint.strip_prefix("unix:") {
        let socket = PathBuf::from(socket);
        ensure!(
            socket.is_absolute(),
            "A unix: endpoint must name an absolute socket path."
        );
        RunnerEndpoint::Unix {
            socket,
            url: "ws://localhost/v0/runners/connect".into(),
        }
    } else if let Some(tailcat) = endpoint.strip_prefix("tailcat:") {
        let endpoint_schemas =
            happy_agent_base::RuntimeSchemas::compile(include_str!("runner_schemas.json"))?;
        ensure!(
            endpoint_schemas.valid("tailcatEndpoint", &json!(endpoint))?,
            "The runner endpoint is not a Tailcat address."
        );
        let mut parts = tailcat.split(':');
        let address = parts.next().unwrap();
        let port = parts.next();
        ensure!(
            parts.next().is_none(),
            "The runner endpoint is not a Tailcat address."
        );
        ensure!(
            schemas.valid("ownerTailcatAddress", &json!(address))?,
            "The runner endpoint is not a Tailcat address."
        );
        let port = match port {
            Some(port) => {
                ensure!(
                    port.len() <= 5 && !port.is_empty(),
                    "The Tailcat port is invalid."
                );
                port.parse::<u16>()
                    .context("The Tailcat port is invalid.")?
            }
            None => 24779,
        };
        ensure!(port > 0, "The Tailcat port is invalid.");
        RunnerEndpoint::Tailcat {
            address: address.to_owned(),
            port,
            url: "ws://server.tailcat/v0/runners/connect".into(),
        }
    } else {
        let mut url=reqwest::Url::parse(&endpoint).context("The runner endpoint is not an address. Use https://host, http://host:port, or unix:/path/to/socket.")?;
        ensure!(
            matches!(url.scheme(), "http" | "https"),
            "The runner endpoint must use https, http, or unix."
        );
        ensure!(
            url.username().is_empty()
                && url.password().is_none_or(str::is_empty)
                && url.query().is_none_or(str::is_empty)
                && url.fragment().is_none_or(str::is_empty),
            "The runner endpoint must not carry credentials, a query, or a fragment."
        );
        url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
            .map_err(|_| anyhow::anyhow!("The runner endpoint scheme is invalid."))?;
        url.set_path(&format!(
            "{}/v0/runners/connect",
            url.path().trim_end_matches('/')
        ));
        RunnerEndpoint::WebSocket(url.to_string())
    };
    let mut private_directories = vec![state];
    let parent = token_file
        .parent()
        .context("The runner token file has no parent.")?
        .to_owned();
    if !private_directories.contains(&parent) {
        private_directories.push(parent);
    }
    Ok(RunnerSettings {
        endpoint,
        token,
        home,
        private_directories,
    })
}

impl ConfigModule {
    /// # Safety
    /// Call before creating threads, so captured runner credentials can be removed from inheritance.
    pub unsafe fn load_runner(args: &[std::ffi::OsString]) -> Result<Self> {
        let os_home = super::home_directory()?;
        let mut config = Self::from_home_configuration(os_home.join(".happy-runner"), true)?;
        unsafe {
            config.configure_runner(args)?;
        }
        Ok(config)
    }
    /// Capture runner credentials before any runtime or process threads exist.
    ///
    /// # Safety
    /// The caller must invoke this during single-threaded application startup.
    pub unsafe fn configure_runner(&mut self, args: &[std::ffi::OsString]) -> Result<()> {
        let endpoint = std::env::var("HAPPY_RUNNER_ENDPOINT").ok();
        let token = std::env::var("HAPPY_RUNNER_TOKEN").ok();
        // The caller owns single-threaded startup; no child can inherit these.
        unsafe {
            std::env::remove_var("HAPPY_RUNNER_ENDPOINT");
            std::env::remove_var("HAPPY_RUNNER_TOKEN");
        }
        self.runner_settings = Some(parse(args, endpoint, token, &self.os_home)?);
        Ok(())
    }
    pub fn runner_settings(&self) -> Result<RunnerSettings> {
        self.runner_settings
            .clone()
            .context("The standalone runner has not been configured.")
    }
    pub fn runner_identity(&self) -> Result<Value> {
        let settings = self.runner_settings.as_ref();
        let home = settings.map_or_else(|| self.os_home.clone(), |settings| settings.home.clone());
        let mut hostname = [0u8; 256];
        #[cfg(unix)]
        unsafe {
            libc::gethostname(hostname.as_mut_ptr().cast(), hostname.len());
        }
        let hostname = String::from_utf8_lossy(&hostname)
            .trim_end_matches('\0')
            .chars()
            .take(255)
            .collect::<String>();
        Ok(
            json!({"version":option_env!("HAPPY_AGENT_RELEASE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),"platform":match std::env::consts::OS{"macos"=>"darwin","windows"=>"win32",platform=>platform},"arch":match std::env::consts::ARCH{"x86_64"=>"x64","aarch64"=>"arm64",arch=>arch},"hostname":hostname,"home":home}),
        )
    }
    pub fn runner_shell_policy(&self, request: &Value, permissions: &Value) -> Result<Value> {
        let schemas = crate::product::schemas::Schemas::new()?;
        ensure!(schemas.valid("ownerRunnerParams_shell_startSession",&json!({"computeId":"validation","options":{"command":"","permissions":permissions}}))?,"The runner shell permissions are invalid.");
        let environment = self.runner_file_environment(request)?;
        let root = std::fs::canonicalize(&environment.root)?;
        let resolve = |paths: &Value| -> Result<Vec<PathBuf>> {
            paths
                .as_array()
                .into_iter()
                .flatten()
                .map(|path| {
                    let path = PathBuf::from(
                        path.as_str()
                            .context("The runner policy path is invalid.")?,
                    );
                    absolute(&if path.is_absolute() {
                        path
                    } else {
                        root.join(path)
                    })
                })
                .collect()
        };
        let mut denied_reads = resolve(&permissions["deniedReadPaths"])?;
        denied_reads.extend(environment.private_paths.clone());
        if !self.is_container_worker() {
            denied_reads.extend(self.runner_sensitive_read_paths(&environment.home, &root)?);
        }
        let read_only = permissions["mode"] == "read_only";
        let mut denied_writes = Vec::new();
        if !read_only {
            denied_writes = resolve(&permissions["deniedWritePaths"])?;
            denied_writes.extend(environment.private_paths);
            denied_writes.extend(resolve(&request["policy"]["readableDirectories"])?);
            denied_writes.extend(environment.protected_paths);
            denied_writes.push(root.join(".git"));
            for path in &denied_writes {
                match std::fs::symlink_metadata(path) {
                    Ok(metadata) => ensure!(
                        !metadata.is_symlink(),
                        "Restricted host commands cannot protect a symbolic-link path: {}.",
                        path.display()
                    ),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        let mut network = permissions["network"].clone();
        let hosts = network["allowedHosts"].as_array();
        ensure!(
            !hosts.is_some_and(|hosts| hosts.contains(&json!("*"))),
            "Network allowedHosts cannot contain a bare '*'; leave allowedHosts empty for open egress."
        );
        if network["egress"] == true && hosts.is_some_and(|hosts| !hosts.is_empty()) {
            network["outgoingProxy"] = json!({"frontEnds":["http","socks5"]});
        }
        let mut policy = json!({"mode":permissions["mode"],"allowedReadPaths":resolve(&permissions["allowedReadPaths"])?,"deniedReadPaths":denied_reads,"deniedWritePaths":denied_writes,"network":network});
        if !read_only {
            policy["allowedWritePaths"] = json!(resolve(&permissions["allowedWritePaths"])?);
        }
        Ok(policy)
    }
    fn runner_sensitive_read_paths(&self, home: &Path, root: &Path) -> Result<Vec<PathBuf>> {
        let home = match std::fs::canonicalize(home) {
            Ok(home) => home,
            Err(_) => absolute(home)?,
        };
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".config"));
        let mut paths = if root != home && root.starts_with(&home) {
            Vec::new()
        } else {
            vec![home.clone()]
        };
        paths.extend(
            [
                ".aws",
                ".azure",
                ".bash_history",
                ".claude",
                ".codex",
                ".docker",
                ".env",
                ".git-credentials",
                ".gnupg",
                ".kube",
                ".netrc",
                ".node_repl_history",
                ".npmrc",
                ".password-store",
                ".psql_history",
                ".pypirc",
                ".python_history",
                ".ssh",
                ".zsh_history",
                "Library/Keychains",
                ".local/share/keyrings",
            ]
            .into_iter()
            .map(|name| home.join(name)),
        );
        paths.extend(
            ["1Password", "gcloud", "gh", "glab-cli", "op"]
                .into_iter()
                .map(|name| config.join(name)),
        );
        for name in [
            "AWS_CONFIG_FILE",
            "AWS_SHARED_CREDENTIALS_FILE",
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
            "DOCKER_CONFIG",
            "GIT_CONFIG_GLOBAL",
            "GNUPGHOME",
            "KUBECONFIG",
            "NETRC",
            "NPM_CONFIG_USERCONFIG",
        ] {
            if let Some(path) = std::env::var_os(name).filter(|path| !path.is_empty()) {
                let path = PathBuf::from(path);
                paths.push(absolute(&if path.is_absolute() {
                    path
                } else {
                    root.join(path)
                })?);
            }
        }
        Ok(paths)
    }
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
        for field in ["protectedProjectFiles", "networkPolicyFiles"] {
            for name in request["policy"][field].as_array().into_iter().flatten() {
                let name = name
                    .as_str()
                    .context("The protected runner path is invalid.")?;
                let path = Path::new(name);
                ensure!(
                    !name.is_empty()
                        && name != "."
                        && name != ".."
                        && !path.is_absolute()
                        && path
                            .parent()
                            .is_some_and(|parent| parent.as_os_str().is_empty()),
                    "Host project policy file '{name}' must be a root file name."
                );
                protected.insert(name.to_owned());
            }
        }
        let protected_paths = protected
            .into_iter()
            .map(|name| root.join(Path::new(&name)))
            .collect();
        let mut private_paths = self.runner_settings.as_ref().map_or_else(
            || vec![self.paths.directory.clone()],
            |settings| {
                let mut paths = settings.private_directories.clone();
                paths.push(self.paths.directory.clone());
                paths
            },
        );
        for value in request["policy"]["privateDirectories"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let path = PathBuf::from(
                value
                    .as_str()
                    .context("The private runner path is invalid.")?,
            );
            private_paths.push(absolute(&if path.is_absolute() {
                path
            } else {
                root.join(path)
            })?);
        }
        for name in request["policy"]["privatePathVariables"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(path) = std::env::var_os(
                name.as_str()
                    .context("The private runner variable is invalid.")?,
            )
            .filter(|path| !path.is_empty())
            {
                let path = PathBuf::from(path);
                private_paths.push(absolute(&if path.is_absolute() {
                    path
                } else {
                    root.join(path)
                })?);
            }
        }
        Ok(ComputeFileEnvironment {
            root,
            home: self
                .runner_settings
                .as_ref()
                .map_or_else(|| self.os_home.clone(), |settings| settings.home.clone()),
            private_paths,
            protected_paths,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN: &str = "0123456789012345678901234567890123456789012";
    #[test]
    fn runner_shell_policy_preserves_source_read_only_and_network_host_rules() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let config = ConfigModule::from_home(directory.path().join("private")).unwrap();
        let request = json!({"computeId":"policy","cwd":root,"policy":{"protectedProjectFiles":["guarded.txt"],"networkPolicyFiles":["network.toml"]}});
        let read = config.runner_shell_policy(&request, &json!({"mode":"read_only","allowedWritePaths":["extra"],"deniedWritePaths":["other"],"network":{"egress":false,"localBinding":false}})).unwrap();
        assert_eq!(read["deniedWritePaths"], json!([]));
        assert!(read.get("allowedWritePaths").is_none());
        let write = config.runner_shell_policy(&request, &json!({"mode":"workspace_write","network":{"egress":true,"localBinding":false,"allowedHosts":["example.com"]}})).unwrap();
        assert_eq!(
            write["network"]["outgoingProxy"],
            json!({"frontEnds":["http","socks5"]})
        );
        assert!(
            write["deniedWritePaths"]
                .as_array()
                .unwrap()
                .contains(&json!(root.join("network.toml")))
        );
        assert!(
            write["deniedReadPaths"]
                .as_array()
                .unwrap()
                .contains(&json!(config.os_home.join(".ssh")))
        );
        assert!(config.runner_shell_policy(&request, &json!({"mode":"workspace_write","network":{"egress":true,"localBinding":false,"allowedHosts":["*"]}})).is_err());
        for name in ["../escaped", "/absolute", "nested/file", "", ".", ".."] {
            let request =
                json!({"computeId":"policy","cwd":root,"policy":{"networkPolicyFiles":[name]}});
            assert!(config.runner_file_environment(&request).is_err(), "{name}");
        }
    }
    #[test]
    fn runner_options_preserve_source_endpoint_prefixes_and_private_token_roots() {
        let directory = tempfile::tempdir().unwrap();
        let token_file = directory.path().join("private/token");
        std::fs::create_dir(token_file.parent().unwrap()).unwrap();
        std::fs::write(&token_file, format!("\u{feff}{TOKEN}\n")).unwrap();
        let args = vec![
            "--endpoint".into(),
            "https://example.com/prefix/".into(),
            "--token-file".into(),
            token_file.into_os_string(),
            "--home".into(),
            directory.path().join("alternate-home").into_os_string(),
        ];
        let settings = parse(&args, None, None, directory.path()).unwrap();
        assert_eq!(
            settings.endpoint.url(),
            "wss://example.com/prefix/v0/runners/connect"
        );
        assert_eq!(settings.token, TOKEN);
        assert_eq!(settings.home, directory.path().join("alternate-home"));
        assert_eq!(
            settings.private_directories,
            vec![
                directory.path().join(".happy-runner"),
                directory.path().join("private")
            ]
        );
    }
    #[test]
    fn runner_options_reject_wrong_tokens_and_non_source_tailcat_ports() {
        let directory = tempfile::tempdir().unwrap();
        for endpoint in [
            "tailcat:tcfixture:+42",
            "tailcat:tcfixture:0",
            "tailcat:tcfixture:65536",
            "tailcat:tcfixture:000042",
            "tailcat:tcfixture:42:43",
            "https://user@example.com",
            "https://example.com?query=1",
            "unix:relative",
        ] {
            assert!(
                parse(
                    &[],
                    Some(endpoint.into()),
                    Some(TOKEN.into()),
                    directory.path()
                )
                .is_err(),
                "{endpoint}"
            );
        }
        assert!(
            parse(
                &[],
                Some("https://example.com".into()),
                Some("wrong".into()),
                directory.path()
            )
            .is_err()
        );
        for endpoint in [
            "tailcat:tcfixture",
            "tailcat:tcfixture:65535",
            "unix:/runner/socket",
        ] {
            assert!(
                parse(
                    &[],
                    Some(endpoint.into()),
                    Some(format!(" {TOKEN} \n")),
                    directory.path()
                )
                .is_ok(),
                "{endpoint}"
            );
        }
    }
}
