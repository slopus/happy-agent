//! Configuration owns the live prompt catalog and global instruction path.
use super::ConfigModule;
use anyhow::Result;
use serde_json::{Value, json};
use std::io::Read;

impl ConfigModule {
    pub fn system_prompt_selection(&self, settings: &Value) -> Result<Value> {
        let mut selection = json!({});
        if let Some(model) = settings.get("model") {
            selection["model"] = model.clone();
        }
        if let Some(kind) = settings["provider"]
            .as_str()
            .and_then(|id| self.compatible_provider_type(id))
        {
            if matches!(
                kind.as_str(),
                "bedrock" | "claude" | "codex" | "grok" | "gym"
            ) {
                selection["providerKind"] = json!(kind);
            }
        }
        Ok(selection)
    }
    pub fn system_prompt_models(&self) -> Result<Vec<Value>> {
        Ok(self.naming_models()?.into_iter().filter(|model| {
            model["providerId"].as_str().is_some_and(|id| !self.values.get("providers").and_then(|providers| providers.get(id)).and_then(|provider| provider.get("hidden")).and_then(toml::Value::as_bool).unwrap_or(false))
        }).map(|model| json!({"name":model["name"],"id":model["id"],"providerId":model["providerId"]})).collect())
    }
    pub fn system_prompt_documentation_paths(&self) -> (std::path::PathBuf, std::path::PathBuf) {
        let docs = self.paths.public.join("docs");
        (docs.join("README.md"), docs.join("DESIGN.md"))
    }
    /// Preserve the Source reader's complete UTF-8 code point oversize sentinel.
    pub async fn read_global_instructions(&self, maximum: usize) -> Result<Option<String>> {
        anyhow::ensure!(
            maximum <= 256 * 1024,
            "The global instructions exceed their configured byte bound."
        );
        let path = self.paths.instructions.clone();
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
                    return Ok(None);
                }
                Err(error) => return Err(error.into()),
            };
            if !file.metadata()?.is_file() {
                return Ok(None);
            }
            let mut bytes = Vec::new();
            file.take(maximum as u64 + 4).read_to_end(&mut bytes)?;
            if bytes.len() <= maximum {
                return Ok(Some(String::from_utf8_lossy(&bytes).into_owned()));
            }
            // TextDecoder streaming strips the initial BOM and retains an incomplete suffix
            // between its two calls, while malformed complete sequences remain replacements.
            let (stream, boundary) = if let Some(stream) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
                (stream, maximum.saturating_sub(3))
            } else {
                (bytes.as_slice(), maximum)
            };
            let prefix_end = complete_stream_prefix(&stream[..boundary]);
            let prefix = String::from_utf8_lossy(&stream[..prefix_end]);
            let remainder = &stream[prefix_end..];
            let remainder =
                String::from_utf8_lossy(&remainder[..complete_stream_prefix(remainder)]);
            let next = remainder.chars().next();
            let candidate = next.map(|next| format!("{prefix}{next}"));
            Ok(Some(match candidate {
                Some(candidate) if candidate.encode_utf16().count() <= maximum + 1 => candidate,
                Some(_) => format!("{prefix}x"),
                None => prefix.into_owned(),
            }))
        })
        .await?
    }
}

fn complete_stream_prefix(bytes: &[u8]) -> usize {
    let mut offset = 0;
    while offset < bytes.len() {
        match std::str::from_utf8(&bytes[offset..]) {
            Ok(_) => return bytes.len(),
            Err(error) => {
                offset += error.valid_up_to();
                match error.error_len() {
                    Some(length) => offset += length,
                    None => return offset,
                }
            }
        }
    }
    offset
}
