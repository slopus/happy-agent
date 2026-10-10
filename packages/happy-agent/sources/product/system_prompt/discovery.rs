use super::{SystemPromptModule, format};
use crate::product::tools::ComputeFilesystem;
use anyhow::{Result, ensure};
use happy_agent_base::AgentScope;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

const DOCUMENT_BYTES: usize = 64 * 1024;
const GLOBAL_BYTES: usize = 256 * 1024;
const SECURITY_BYTES: usize = 32 * 1024;
struct Document {
    value: Option<Value>,
    bytes: usize,
    truncated: bool,
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        if let Some(error) = error.downcast_ref::<std::io::Error>() {
            return matches!(
                error.kind(),
                std::io::ErrorKind::NotFound
                    | std::io::ErrorKind::NotADirectory
                    | std::io::ErrorKind::IsADirectory
            );
        }
        let text = error.to_string();
        text.starts_with("No such path:")
            || ["ENOENT: ", "ENOTDIR: ", "EISDIR: "]
                .iter()
                .any(|prefix| text.starts_with(prefix))
    })
}
fn omitted(path: &Path) -> Document {
    Document {
        value: Some(json!({"path":path,"text":format::OMITTED,"truncated":true})),
        bytes: 0,
        truncated: true,
    }
}
impl SystemPromptModule {
    async fn bounded_document(
        &self,
        compute: &ComputeFilesystem,
        path: &Path,
        maximum: usize,
        cancel: &CancellationToken,
    ) -> Result<Document> {
        let stat = match compute.stat(path, true, cancel).await {
            Ok(stat) => stat,
            Err(error) if missing(&error) => Value::Null,
            Err(error) => return Err(error),
        };
        if stat.is_null() {
            return Ok(Document {
                value: None,
                bytes: 0,
                truncated: false,
            });
        }
        ensure!(
            self.schemas.valid("ownerAgentsMdStat", &stat)?,
            "Compute returned an invalid file stat for {}.",
            path.display()
        );
        ensure!(
            stat["isSymbolicLink"] != true,
            "AGENTS.md document must not be a symbolic link: {}",
            path.display()
        );
        if stat["isFile"] != true {
            return Ok(Document {
                value: None,
                bytes: 0,
                truncated: false,
            });
        }
        let size = stat["size"].as_u64().unwrap();
        if maximum == 0 {
            return Ok(Document {
                value: None,
                bytes: 0,
                truncated: size > 0,
            });
        }
        if size > maximum as u64 {
            return Ok(omitted(path));
        }
        let bytes = match compute.read_file(path, maximum, true, cancel).await {
            Ok(bytes) => bytes,
            Err(error) => {
                if let Ok(current) = compute.stat(path, true, cancel).await {
                    if self.schemas.valid("ownerAgentsMdStat", &current)?
                        && current["isFile"] == true
                        && current["isSymbolicLink"] != true
                        && current["size"]
                            .as_u64()
                            .is_some_and(|size| size > maximum as u64)
                    {
                        return Ok(omitted(path));
                    }
                }
                return Err(error);
            }
        };
        let truncated = size > maximum as u64 || bytes.len() > maximum;
        let bounded = &bytes[..bytes.len().min(maximum)];
        let decoded = format::decode(bounded);
        let text = format::trim(&decoded);
        if text.is_empty() {
            return Ok(Document {
                value: None,
                bytes: bounded.len(),
                truncated,
            });
        }
        let mut document = json!({"path":path,"text":text});
        if truncated {
            document["truncated"] = json!(true);
        }
        ensure!(
            self.schemas.valid("ownerAgentsMdDocument", &document)?,
            "AGENTS.md document is invalid: {}",
            path.display()
        );
        Ok(Document {
            value: Some(document),
            bytes: bounded.len(),
            truncated,
        })
    }
    async fn global_document(&self) -> Result<Option<Value>> {
        ensure!(
            self.schemas
                .valid("ownerAgentsMdPath", &json!(self.config.paths.instructions))?,
            "The configured global AGENTS.md path is invalid."
        );
        let Some(raw) = self.config.read_global_instructions(GLOBAL_BYTES).await? else {
            return Ok(None);
        };
        let truncated = raw.encode_utf16().count() > GLOBAL_BYTES || raw.len() > GLOBAL_BYTES;
        let bounded = format::prefix(&raw, GLOBAL_BYTES);
        let text = format::trim(bounded);
        if text.is_empty() {
            return Ok(None);
        }
        let mut document = json!({"path":self.config.paths.instructions,"text":text});
        if truncated {
            document["truncated"] = json!(true);
        }
        ensure!(
            self.schemas
                .valid("ownerAgentsMdGlobalDocument", &document)?,
            "Global AGENTS.md reader returned an invalid document."
        );
        Ok(Some(document))
    }
    pub async fn read_agents_md(
        &self,
        scope: &AgentScope<'_>,
        cancel: &CancellationToken,
    ) -> Result<Option<Value>> {
        ensure!(
            self.schemas
                .valid("ownerAgentsMdAgentId", &json!(scope.id))?,
            "AGENTS.md agent ID is invalid."
        );
        let global = self.global_document().await?;
        let compute = self.compute.compute_filesystem(scope, cancel).await?;
        let mut snapshot = if let Some(compute) = compute {
            let directories = relevant_directories(&compute, cancel).await;
            let root = directories
                .first()
                .map(PathBuf::as_path)
                .unwrap_or(compute.cwd());
            let security = self
                .bounded_document(
                    &compute,
                    &root.join("AGENTS_SECURITY.md"),
                    SECURITY_BYTES,
                    cancel,
                )
                .await?;
            let mut documents = Vec::new();
            let mut total = 0;
            let mut truncated = global
                .as_ref()
                .is_some_and(|document| document["truncated"] == true)
                || security.truncated;
            for directory in directories {
                if documents.len() >= 32 || total >= GLOBAL_BYTES {
                    truncated = true;
                    break;
                }
                let result = self
                    .bounded_document(
                        &compute,
                        &directory.join("AGENTS.md"),
                        DOCUMENT_BYTES.min(GLOBAL_BYTES - total),
                        cancel,
                    )
                    .await?;
                truncated |= result.truncated;
                total += result.bytes;
                if let Some(document) = result.value {
                    documents.push(document);
                }
            }
            let mut snapshot = json!({"cwd":compute.cwd(),"documents":documents});
            if let Some(security) = security.value {
                snapshot["security"] = security;
            }
            if truncated {
                snapshot["truncated"] = json!(true);
            }
            snapshot
        } else {
            let Some(global) = global.as_ref() else {
                return Ok(None);
            };
            let mut snapshot = json!({"cwd":Path::new(global["path"].as_str().unwrap()).parent().unwrap_or(Path::new(".")),"documents":[]});
            if global["truncated"] == true {
                snapshot["truncated"] = json!(true);
            }
            snapshot
        };
        if let Some(global) = global {
            snapshot["global"] = global;
        }
        ensure!(
            self.schemas.valid("ownerAgentsMdSnapshot", &snapshot)?,
            "AGENTS.md filesystem snapshot is invalid."
        );
        Ok(Some(snapshot))
    }
    pub async fn read_agents_md_instructions(
        &self,
        scope: &AgentScope<'_>,
        cancel: &CancellationToken,
    ) -> Result<Option<String>> {
        let snapshot = self.read_agents_md(scope, cancel).await?;
        if format::body(snapshot.as_ref()).is_empty() {
            Ok(None)
        } else {
            Ok(Some(format::instructions(snapshot.as_ref())))
        }
    }
    pub(super) fn sound_snapshot(&self, snapshot: &Value) -> Result<bool> {
        if !self.schemas.valid("ownerAgentsMdTurnSnapshot", snapshot)? {
            return Ok(false);
        }
        if snapshot.is_null() {
            return Ok(true);
        }
        for (field, maximum) in [("global", GLOBAL_BYTES), ("security", SECURITY_BYTES)] {
            if snapshot
                .get(field)
                .is_some_and(|document| document["text"].as_str().unwrap().len() > maximum)
            {
                return Ok(false);
            }
        }
        let mut paths = BTreeSet::new();
        Ok(snapshot["documents"]
            .as_array()
            .unwrap()
            .iter()
            .all(|document| {
                document["text"].as_str().unwrap().len() <= DOCUMENT_BYTES
                    && paths.insert(document["path"].as_str().unwrap())
            }))
    }
}
async fn relevant_directories(
    compute: &ComputeFilesystem,
    cancel: &CancellationToken,
) -> Vec<PathBuf> {
    let ancestors = compute
        .cwd()
        .ancestors()
        .map(Path::to_owned)
        .collect::<Vec<_>>();
    let mut root = 0;
    for (index, directory) in ancestors.iter().enumerate() {
        if compute
            .exists(&directory.join(".git"), cancel)
            .await
            .unwrap_or(false)
        {
            root = index;
            break;
        }
    }
    ancestors[..=root].iter().rev().cloned().collect()
}
