//! Explicit imports may reuse the installation's existing GitHub CLI login.
use super::ConfigModule;
use crate::product::schemas::Schemas;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

impl ConfigModule {
    fn github_environment(&self) -> BTreeMap<String, String> {
        #[cfg(test)]
        if let Some(environment) = self
            .github_test_environment
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            return environment.clone();
        }
        std::env::vars().collect()
    }
    #[cfg(test)]
    pub(crate) fn set_github_test_environment(&self, environment: BTreeMap<String, String>) {
        *self
            .github_test_environment
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(environment);
    }
    pub fn github_token(&self) -> Option<String> {
        token(&self.github_environment())
    }
    pub async fn resolve_github_token_for_import(
        &self,
        cancel: &CancellationToken,
    ) -> Option<String> {
        let environment = self.github_environment();
        if ["GITHUB_TOKEN", "GH_TOKEN"]
            .iter()
            .any(|name| environment.contains_key(*name))
            || self.team_enabled()
        {
            return token(&environment);
        }
        let home = environment
            .get("HOME")
            .filter(|home| !home.trim().is_empty())
            .map_or_else(|| self.os_home.clone(), |home| PathBuf::from(home.trim()));
        discover(&environment, &home, cancel).await
    }
}

fn token(environment: &BTreeMap<String, String>) -> Option<String> {
    for name in ["GITHUB_TOKEN", "GH_TOKEN"] {
        if let Some(value) = environment.get(name) {
            let value = value.trim().to_owned();
            return Schemas::new()
                .ok()?
                .valid("ownerGithubToken", &serde_json::json!(&value))
                .ok()?
                .then_some(value);
        }
    }
    None
}

async fn discover(
    environment: &BTreeMap<String, String>,
    home: &Path,
    cancel: &CancellationToken,
) -> Option<String> {
    if !home.is_absolute() {
        return None;
    }
    let trusted = if cfg!(windows) {
        vec![
            PathBuf::from(
                environment
                    .get("ProgramFiles")
                    .map(String::as_str)
                    .unwrap_or("C:\\Program Files"),
            )
            .join("GitHub CLI"),
        ]
    } else {
        vec![
            home.join(".local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]
    };
    let paths = std::env::split_paths(
        environment
            .get("PATH")
            .or_else(|| environment.get("Path"))
            .map(String::as_str)
            .unwrap_or(""),
    )
    .take(32)
    .filter(|path| path.is_absolute() && trusted.contains(&super::normalize_path(path)))
    .collect::<Vec<_>>();
    for path in &paths {
        let executable = path.join(if cfg!(windows) { "gh.exe" } else { "gh" });
        let Ok(metadata) = tokio::fs::metadata(&executable).await else {
            continue;
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                continue;
            }
        }
        if !metadata.is_file() {
            continue;
        }
        let result = async {
            let mut command = tokio::process::Command::new(&executable);
            command
                .args(["auth", "token", "--hostname", "github.com"])
                .current_dir(home)
                .env_clear()
                .env("HOME", home)
                .env("PATH", std::env::join_paths(&paths).ok()?)
                .env("GH_PROMPT_DISABLED", "1")
                .env("GH_NO_UPDATE_NOTIFIER", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            for name in [
                "GH_CONFIG_DIR",
                "XDG_CONFIG_HOME",
                "APPDATA",
                "LOCALAPPDATA",
                "USERPROFILE",
                "SystemRoot",
                "DBUS_SESSION_BUS_ADDRESS",
                "XDG_RUNTIME_DIR",
            ] {
                if let Some(value) = environment.get(name) {
                    command.env(name, value);
                }
            }
            let mut child = command.spawn().ok()?;
            let mut output = Vec::new();
            child
                .stdout
                .take()?
                .take(16_387)
                .read_to_end(&mut output)
                .await
                .ok()?;
            if output.len() > 16_386 || !child.wait().await.ok()?.success() {
                return None;
            }
            let mut token = String::from_utf8(output).ok()?;
            if token.ends_with('\n') {
                token.pop();
                if token.ends_with('\r') {
                    token.pop();
                }
            }
            Schemas::new()
                .ok()?
                .valid("ownerGithubToken", &serde_json::json!(token))
                .ok()?
                .then_some(token)
        };
        return tokio::select! { _ = cancel.cancelled() => None, result = tokio::time::timeout(Duration::from_secs(3), result) => result.ok().flatten() };
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_github_tokens_trim_and_prevent_fallback_when_blank_or_invalid() {
        for (primary, secondary, expected) in [
            (Some(" primary "), Some("secondary"), Some("primary")),
            (None, Some(" secondary "), Some("secondary")),
            (Some(" "), Some("secondary"), None),
            (Some("bad\0token"), Some("secondary"), None),
        ] {
            let mut environment = BTreeMap::new();
            if let Some(primary) = primary {
                environment.insert("GITHUB_TOKEN".to_owned(), primary.to_owned());
            }
            if let Some(secondary) = secondary {
                environment.insert("GH_TOKEN".to_owned(), secondary.to_owned());
            }
            assert_eq!(token(&environment).as_deref(), expected);
        }
    }
    #[tokio::test]
    #[cfg(unix)]
    async fn github_cli_import_uses_only_trusted_paths_and_a_bounded_private_environment() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let script = bin.join("gh");
        std::fs::write(&script, "#!/bin/sh\ntest \"$*\" = 'auth token --hostname github.com' || exit 1\ntest \"$PWD\" -ef \"$HOME\" || exit 1\ntest \"$PATH\" = \"$HOME/.local/bin\" || exit 1\ntest -z \"$GH_DEBUG$GIT_CONFIG_COUNT$NODE_OPTIONS\" || exit 1\nprintf 'fixture-private-token\\n'\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let environment = BTreeMap::from([
            ("PATH".to_owned(), bin.to_str().unwrap().to_owned()),
            ("GH_DEBUG".to_owned(), "api".to_owned()),
            ("NODE_OPTIONS".to_owned(), "--invalid".to_owned()),
        ]);
        let cancel = CancellationToken::new();
        assert_eq!(
            discover(&environment, root.path(), &cancel)
                .await
                .as_deref(),
            Some("fixture-private-token")
        );
        for script_text in [
            "exit 1",
            "printf 'invalid\\001token\\n'",
            "printf 'invalid\\n\\n'",
            "i=0; while [ \"$i\" -lt 20000 ]; do printf x; i=$((i+1)); done",
        ] {
            std::fs::write(&script, format!("#!/bin/sh\n{script_text}\n")).unwrap();
            assert!(discover(&environment, root.path(), &cancel).await.is_none());
        }
        let untrusted =
            BTreeMap::from([("PATH".to_owned(), root.path().to_str().unwrap().to_owned())]);
        assert!(discover(&untrusted, root.path(), &cancel).await.is_none());
        cancel.cancel();
        assert!(discover(&environment, root.path(), &cancel).await.is_none());
    }
}
