//! Configuration owns the machine's security documents; agent paths belong to compute.
use super::ConfigModule;
use anyhow::{Result, ensure};
use std::{io::Read, path::PathBuf};

impl ConfigModule {
    pub async fn read_global_security(&self, maximum: usize) -> Result<String> {
        read_security_document(self.paths.security.clone(), maximum).await
    }

    pub async fn read_project_security(&self, maximum: usize) -> Result<String> {
        read_security_document(self.paths.public.join("AGENTS_SECURITY.md"), maximum).await
    }
}

async fn read_security_document(path: PathBuf, maximum: usize) -> Result<String> {
    ensure!(
        maximum <= 32 * 1024,
        "The security policy exceeds its configured byte bound."
    );
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
                    std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::NotADirectory
                        | std::io::ErrorKind::IsADirectory
                ) =>
            {
                return Ok(String::new());
            }
            Err(error) => return Err(error.into()),
        };
        if !file.metadata()?.is_file() {
            return Ok(String::new());
        }
        let mut bytes = Vec::with_capacity(maximum);
        file.take(maximum as u64).read_to_end(&mut bytes)?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        Ok(if text.trim().is_empty() {
            String::new()
        } else {
            text
        })
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn reviews_reread_the_configured_machine_policy_with_source_headings_and_byte_bounds() {
        let directory = tempfile::tempdir().unwrap();
        let config = ConfigModule::isolated(&directory.path().join(".happy")).unwrap();
        config.prepare().unwrap();
        std::fs::write(&config.paths.security, " Global policy \n").unwrap();
        std::fs::write(
            config.paths.public.join("AGENTS_SECURITY.md"),
            "Project policy",
        )
        .unwrap();
        let (policy, _) = config.review_documents(&json!({})).await.unwrap();
        assert_eq!(
            policy,
            "## Global SECURITY.md\n\n Global policy \n\n\n## Project AGENTS_SECURITY.md\n\nProject policy"
        );
        std::fs::write(&config.paths.security, "abc🚀tail").unwrap();
        assert_eq!(config.read_global_security(5).await.unwrap(), "abc�");
        std::fs::write(config.paths.public.join("AGENTS_SECURITY.md"), " \t\n").unwrap();
        assert!(
            config
                .read_project_security(32 * 1024)
                .await
                .unwrap()
                .is_empty()
        );
        std::fs::remove_file(config.paths.public.join("AGENTS_SECURITY.md")).unwrap();
        std::fs::create_dir(config.paths.public.join("AGENTS_SECURITY.md")).unwrap();
        assert!(
            config
                .read_project_security(32 * 1024)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
