//! Configuration owns the Docker executable, socket, workspace mounts and policy.
use super::ConfigModule;
use anyhow::{Context as _, Result, ensure};
use serde_json::{Value, json};
use std::path::PathBuf;
pub struct DockerConfiguration {
    pub request: Value,
    pub executable: PathBuf,
    pub socket: PathBuf,
}
impl ConfigModule {
    pub fn require_docker_fuse(&self) -> Result<()> {
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::{FileTypeExt, MetadataExt};
            let device=std::fs::metadata("/dev/fuse").context("Native Docker workspace-write enforcement needs the Docker engine host's /dev/fuse character device (10:229). It is unavailable on this Linux host.")?;
            ensure!(
                device.file_type().is_char_device()
                    && libc::major(device.rdev()) == 10
                    && libc::minor(device.rdev()) == 229,
                "Native Docker workspace-write enforcement requires /dev/fuse to be the FUSE character device (10:229)."
            );
            Ok(())
        }
        #[cfg(not(target_os = "linux"))]
        anyhow::bail!(
            "The Docker engine host must provision its FUSE character device for native workspace-write enforcement; this host cannot establish that Linux device identity."
        )
    }
    pub fn is_container_worker(&self) -> bool {
        self.container_worker
    }
    #[cfg(test)]
    pub fn set_container_worker_fixture(&mut self) {
        self.container_worker = true;
    }
    pub fn container_file_environment(
        &self,
        request: &Value,
    ) -> Result<super::ComputeFileEnvironment> {
        ensure!(
            self.container_worker,
            "Private container filesystem configuration is reserved for the container runtime role."
        );
        ensure!(
            crate::product::schemas::Schemas::new()?
                .valid("ownerRunnerParams_compute_createContainer", request)?,
            "The private container compute request is invalid."
        );
        let mut baseline = request.clone();
        if let Some(policy) = baseline.get_mut("policy") {
            policy.as_object_mut().unwrap().remove("privateDirectories");
            policy
                .as_object_mut()
                .unwrap()
                .remove("privatePathVariables");
        }
        self.runner_file_environment(&baseline)
    }
    pub fn container_restricted_paths(
        &self,
        request: &Value,
    ) -> Result<(Vec<PathBuf>, Vec<PathBuf>)> {
        let baseline = self.container_file_environment(request)?;
        let environment = self.runner_file_environment(request)?;
        let reads = environment
            .private_paths
            .into_iter()
            .filter(|path| !baseline.private_paths.contains(path))
            .collect::<Vec<_>>();
        let mut writes = reads.clone();
        writes.extend(
            request["policy"]["readableDirectories"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|value| PathBuf::from(value.as_str().unwrap())),
        );
        Ok((reads, writes))
    }
    pub fn docker_configuration(
        &self,
        agent: &str,
        configuration: &Value,
    ) -> Result<DockerConfiguration> {
        let compute = &configuration["modules"]["compute"];
        let schemas = crate::product::schemas::Schemas::new()?;
        ensure!(
            schemas.valid("computeAgentConfiguration", compute)?,
            "The agent's Docker compute configuration is invalid."
        );
        let image = compute["docker"]["image"]
            .as_str()
            .context("The agent's Docker image is missing.")?;
        let environment = self.compute_file_environment(configuration)?;
        let cwd = environment.root;
        ensure!(
            cwd.is_absolute(),
            "Docker compute needs an absolute workspace path."
        );
        // Source agent containers bind the selected workspace at its same path.
        let request = json!({"computeId":format!("agent-{agent}"),"cwd":cwd,"docker":{"image":image,"workingDirectory":cwd,"mounts":[{"source":cwd,"target":cwd}]},"policy":{"privateDirectories":environment.private_paths,"protectedProjectFiles":environment.protected_paths.iter().map(|path|path.file_name().unwrap().to_string_lossy()).collect::<Vec<_>>()}});
        self.docker_runner_configuration(&request)
    }
    pub fn docker_runner_configuration(&self, request: &Value) -> Result<DockerConfiguration> {
        let schemas = crate::product::schemas::Schemas::new()?;
        let mut request = request.clone();
        if schemas.valid("ownerRunnerParams_compute_create", &request)?
            && request["docker"].is_object()
        {
            let cwd = request["cwd"].clone();
            request["docker"] = json!({"image":request["docker"]["image"],"workingDirectory":cwd,"mounts":[{"source":cwd,"target":cwd}]});
        }
        // Ubuntu's Source live fixture explicitly selects a CI-only profile that
        // allows user namespaces. This does not change the product's default or
        // add a configuration field to the public image-only API contract.
        #[cfg(test)]
        if !request["docker"]["container"].is_string()
            && request["docker"]["apparmorProfile"].is_null()
            && let Ok(profile) = std::env::var("HAPPY_AGENT_TEST_DOCKER_APPARMOR_PROFILE")
        {
            request["docker"]["apparmorProfile"] = json!(profile);
        }
        ensure!(
            schemas.valid("dockerEnvironmentRequest", &request)?,
            "The Docker compute request is invalid."
        );
        let docker = request
            .get("docker")
            .context("The Docker compute configuration is missing.")?;
        ensure!(
            cfg!(target_os = "linux"),
            "Native Docker compute requires this same executable built for Linux. This platform cannot run its own executable inside a Linux container."
        );
        if let Some(architecture) = docker["architecture"].as_str() {
            let expected = match std::env::consts::ARCH {
                "x86_64" => ["x64", "amd64", "x86_64"].as_slice(),
                "aarch64" => ["arm64", "aarch64"].as_slice(),
                _ => &[],
            };
            ensure!(
                expected.contains(&architecture),
                "The configured Docker architecture cannot run this executable; cross-architecture worker binaries are not shipped."
            );
        }
        let executable = std::env::current_exe()?;
        #[cfg(test)]
        let executable = std::env::var_os("HAPPY_AGENT_TEST_COMPUTE_BINARY")
            .map(PathBuf::from)
            .unwrap_or(executable);
        let executable = std::fs::canonicalize(executable)?;
        let socket = docker["socketPath"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/var/run/docker.sock"));
        ensure!(
            socket.is_absolute(),
            "The Docker engine socket path must be absolute."
        );
        ensure!(
            request["cwd"] == docker["workingDirectory"],
            "The Docker compute must open in its configured working directory."
        );
        Ok(DockerConfiguration {
            request,
            executable,
            socket,
        })
    }
    pub fn container_worker() -> Result<Self> {
        ensure!(
            cfg!(target_os = "linux"),
            "The container worker requires Linux."
        );
        ensure!(
            std::env::var("HAPPY_CONTAINER_WORKER").as_deref() == Ok("1"),
            "The container worker must be started by its owning Docker compute."
        );
        let mut config = Self::from_home_configuration(
            PathBuf::from(format!("/tmp/.happy-compute-{}", uuid::Uuid::new_v4())),
            true,
        )?;
        config.container_worker = true;
        Ok(config)
    }
}
