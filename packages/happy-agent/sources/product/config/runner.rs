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
        let mut denied_writes = resolve(&permissions["deniedWritePaths"])?;
        denied_writes.extend(environment.private_paths);
        denied_writes.extend(environment.protected_paths);
        denied_writes.push(root.join(".git"));
        Ok(
            json!({"mode":permissions["mode"],"allowedReadPaths":resolve(&permissions["allowedReadPaths"])?,"allowedWritePaths":resolve(&permissions["allowedWritePaths"])?,"deniedReadPaths":denied_reads,"deniedWritePaths":denied_writes,"network":permissions["network"]}),
        )
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
            home: self
                .runner_settings
                .as_ref()
                .map_or_else(|| self.os_home.clone(), |settings| settings.home.clone()),
            private_paths: self.runner_settings.as_ref().map_or_else(
                || vec![self.paths.directory.clone()],
                |settings| {
                    let mut paths = settings.private_directories.clone();
                    paths.push(self.paths.directory.clone());
                    paths
                },
            ),
            protected_paths,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN: &str = "0123456789012345678901234567890123456789012";
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
