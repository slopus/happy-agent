//! Installation readiness belongs to Config's private directory.
use super::*;

impl ConfigModule {
    pub async fn onboarding_completed(&self) -> Result<bool> {
        let path = self.paths.directory.join("onboarding-v0");
        tokio::task::spawn_blocking(move || {
            let mut options = fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NONBLOCK);
            }
            match options.open(path) {
                Ok(file) => {
                    anyhow::ensure!(
                        file.metadata()?.is_file(),
                        "The onboarding marker is not an ordinary file."
                    );
                    Ok(true)
                }
                Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(failure) => Err(failure.into()),
            }
        })
        .await?
    }

    pub async fn complete_onboarding(&self) -> Result<()> {
        let path = self.paths.directory.join("onboarding-v0");
        tokio::task::spawn_blocking(move || atomic_private(&path, b"complete\n")).await??;
        Ok(())
    }

    pub fn onboarding_providers(&self) -> Result<Vec<String>> {
        let mut providers = Vec::new();
        for model in self.naming_models()? {
            let provider = model["providerId"]
                .as_str()
                .context("The configured model has no provider.")?;
            if !providers.iter().any(|known| known == provider) {
                providers.push(provider.to_owned());
            }
        }
        Ok(providers)
    }
}
