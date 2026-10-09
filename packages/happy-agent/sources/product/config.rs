use super::filesystem::{atomic_private, private_directory, private_file, remove_missing_ok};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct Paths {
    pub home: PathBuf,
    pub directory: PathBuf,
    pub public: PathBuf,
    pub configuration: PathBuf,
    pub socket: PathBuf,
    pub token: PathBuf,
    pub pid: PathBuf,
    pub log: PathBuf,
    pub observation: PathBuf,
    pub drain: PathBuf,
    pub database: PathBuf,
    pub instructions: PathBuf,
    pub security: PathBuf,
}

pub struct ConfigModule {
    pub paths: Paths,
    pub values: toml::Value,
}

#[derive(Clone, Copy)]
pub enum Document {
    Instructions,
    Security,
}
impl Document {
    pub fn limit(self) -> usize {
        match self {
            Self::Instructions => 256 * 1024,
            Self::Security => 32 * 1024,
        }
    }
    pub fn field(self) -> &'static str {
        match self {
            Self::Instructions => "instructions",
            Self::Security => "policy",
        }
    }
    pub fn schema(self) -> &'static str {
        match self {
            Self::Instructions => "instructions",
            Self::Security => "security",
        }
    }
}

impl ConfigModule {
    pub fn load() -> Result<Self> {
        let os_home = home_directory()?;
        let configured = std::env::var("HAPPY_HOME_DIR").unwrap_or_default();
        let configured = configured.trim();
        let home = if configured.is_empty() {
            os_home.join(".happy")
        } else {
            let expanded = if let Some(relative) = configured.strip_prefix('~') {
                os_home.join(relative.trim_start_matches(['/', '\\']))
            } else {
                PathBuf::from(configured)
            };
            if expanded.is_absolute() {
                expanded
            } else {
                os_home.join(expanded)
            }
        };
        let home = normalize_path(&home);
        let directory = home.join("agent");
        let public = home
            .parent()
            .context("The Happy home must have a parent directory.")?
            .join(if cfg!(target_os = "macos") {
                "Happy"
            } else {
                "happy"
            });
        let configuration = public.join(if cfg!(target_os = "macos") {
            "Config"
        } else {
            "config"
        });
        #[cfg(unix)]
        let socket = directory.join("server.sock");
        #[cfg(windows)]
        let socket = {
            use sha2::{Digest, Sha256};
            let hash = Sha256::digest(directory.to_string_lossy().to_lowercase().as_bytes());
            PathBuf::from(format!(r"\\.\pipe\happy-agent-{hash:x}"))
        };
        let paths = Paths {
            instructions: configuration.join("AGENTS.md"),
            security: configuration.join("SECURITY.md"),
            home,
            public,
            configuration,
            socket,
            token: directory.join("token"),
            pid: directory.join("daemon.pid"),
            log: directory.join("daemon.log"),
            observation: directory.join("observation/agent.log"),
            drain: directory.join("drain.json"),
            database: directory.join("agent.sqlite"),
            directory,
        };
        let mut values: toml::Value = toml::from_str(include_str!("defaults.toml"))?;
        for path in [
            paths.configuration.join("happy.toml"),
            paths.directory.join("runtime.toml"),
        ] {
            match fs::read_to_string(&path) {
                Ok(text) => merge(
                    &mut values,
                    toml::from_str(&text).with_context(|| {
                        format!("Cannot read configuration at {}.", path.display())
                    })?,
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        if let Some(token) = values.get("api").and_then(|v| v.get("token"))
            && (!token.as_str().is_some_and(valid_token) || team_enabled(&values))
        {
            bail!("The configured Happy Agent API token is invalid for this deployment.");
        }
        Ok(Self { paths, values })
    }

    pub fn team_enabled(&self) -> bool {
        team_enabled(&self.values)
    }

    fn document_path(&self, document: Document) -> PathBuf {
        match document {
            Document::Instructions => self.paths.instructions.clone(),
            Document::Security => self.paths.security.clone(),
        }
    }
    pub async fn read_document(&self, document: Document) -> Result<String> {
        use std::io::Read;
        let path = self.document_path(document);
        tokio::task::spawn_blocking(move || {
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NONBLOCK);
            }
            let file = match options.open(path) {
                Ok(file) => file,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) =>
                {
                    return Ok(String::new());
                }
                Err(error) => return Err(error.into()),
            };
            if !file.metadata()?.is_file() {
                return Ok(String::new());
            }
            let mut bytes = Vec::new();
            file.take(document.limit() as u64 + 4)
                .read_to_end(&mut bytes)?;
            let mut end = bytes.len().min(document.limit());
            if end < bytes.len() {
                while end > 0 && bytes.get(end).is_some_and(|byte| byte & 0xc0 == 0x80) {
                    end -= 1;
                }
            }
            let mut text = String::from_utf8_lossy(&bytes[..end]).into_owned();
            let mut end = text.len().min(document.limit());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            Ok(text)
        })
        .await?
    }
    pub async fn write_document(&self, document: Document, contents: String) -> Result<String> {
        anyhow::ensure!(
            contents.len() <= document.limit(),
            "The document exceeds its allowed byte size."
        );
        let path = self.document_path(document);
        tokio::task::spawn_blocking(move || {
            atomic_private(&path, contents.as_bytes())?;
            Ok(contents)
        })
        .await?
    }

    pub fn prepare(&self) -> Result<()> {
        private_directory(&self.paths.home)?;
        private_directory(&self.paths.directory)?;
        private_directory(&self.paths.directory.join("observation"))?;
        fs::create_dir_all(&self.paths.public)?;
        fs::create_dir_all(&self.paths.configuration)?;
        Ok(())
    }

    pub fn prepare_token(&self) -> Result<String> {
        self.prepare()?;
        if self.team_enabled() {
            remove_missing_ok(&self.paths.token)?;
            bail!(
                "Local daemon connections are disabled in team mode. Run 'happy-agent run' under the team deployment's process supervisor."
            );
        }
        let configured = self
            .values
            .get("api")
            .and_then(|v| v.get("token"))
            .and_then(|v| v.as_str());
        if configured.is_none() {
            match fs::read_to_string(&self.paths.token) {
                Ok(value) => {
                    let token = value.trim();
                    if !valid_token(token) {
                        bail!("The Happy Agent API token is invalid.");
                    }
                    private_file(&self.paths.token)?;
                    return Ok(token.to_owned());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let token = if let Some(token) = configured {
            token.to_owned()
        } else {
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            URL_SAFE_NO_PAD.encode(bytes)
        };
        atomic_private(&self.paths.token, format!("{token}\n").as_bytes())?;
        Ok(token)
    }
}

pub fn valid_token(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn team_enabled(values: &toml::Value) -> bool {
    values
        .get("feature")
        .and_then(|v| v.get("team"))
        .and_then(|v| v.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn home_directory() -> Result<PathBuf> {
    #[cfg(unix)]
    {
        // HOME is configuration supplied by the launcher, as in the original process runtime.
        if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
            return Ok(PathBuf::from(home));
        }
        bail!("The operating system home directory is unavailable.")
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .context("The operating system home directory is unavailable.")
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn merge(base: &mut toml::Value, next: toml::Value) {
    match (base, next) {
        (toml::Value::Table(base), toml::Value::Table(next)) => {
            for (key, value) in next {
                if let Some(base) = base.get_mut(&key) {
                    merge(base, value);
                } else {
                    base.insert(key, value);
                }
            }
        }
        (base, next) => *base = next,
    }
}
