//! Source filesystem RPC behavior over the compute's checked native paths.
use super::{
    filesystem::{Backend, ComputeFilesystem},
    *,
};

const MAX_READ: usize = 64 * 1024 * 1024 - 64 * 1024;

impl ComputeFilesystem {
    pub async fn native_runner_request(
        &self,
        method: &str,
        params: &Value,
        body: &[u8],
        cancel: &CancellationToken,
    ) -> Result<(Value, Vec<u8>)> {
        ensure!(
            self.is_native(),
            "A native runner request requires its own native compute."
        );
        ensure!(
            self.schemas.valid(
                &format!("ownerRunnerParams_{}", method.replace('.', "_")),
                params
            )?,
            "The runner filesystem request is invalid."
        );
        ensure!(
            !cancel.is_cancelled(),
            "The filesystem operation was interrupted."
        );
        let filesystem = self.with_permissions(&params["permissions"])?;
        let Backend::Local(boundary) = &filesystem.backend else {
            unreachable!()
        };
        let path = params["path"].as_str().map(Path::new);
        let mut bytes = Vec::new();
        let result = match method {
            "fs.exists" => json!({"exists":filesystem.exists(path.unwrap(), cancel).await?}),
            "fs.stat" | "fs.lstat" => {
                let stat = filesystem
                    .stat(path.unwrap(), method == "fs.lstat", cancel)
                    .await?;
                if stat.is_null() {
                    return Err(std::io::Error::from(std::io::ErrorKind::NotFound).into());
                }
                json!({"stat":stat})
            }
            "fs.lstatMany" => {
                let paths = params["paths"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|path| PathBuf::from(path.as_str().unwrap()))
                    .collect::<Vec<_>>();
                json!({"stats":filesystem.lstat_many(&paths,cancel).await?})
            }
            "fs.realpath" => json!({"path":filesystem.canonical_path(path.unwrap(),cancel).await?}),
            "fs.readdirPage" => {
                filesystem
                    .entries(
                        path.unwrap(),
                        params["after"].as_str(),
                        params["limit"].as_u64().unwrap() as usize,
                        cancel,
                    )
                    .await?
            }
            "fs.readdir" => {
                let target = boundary.target(params["path"].as_str().unwrap(), false)?;
                let mut directory = tokio::fs::read_dir(target).await?;
                let mut entries = Vec::new();
                let mut size = 0;
                loop {
                    let entry = tokio::select! {entry=directory.next_entry()=>entry?,_=cancel.cancelled()=>anyhow::bail!("The filesystem operation was interrupted.")};
                    let Some(entry) = entry else { break };
                    let name = entry.file_name().into_string().map_err(|_| {
                        anyhow::anyhow!("The directory contains an invalid UTF-8 name.")
                    })?;
                    size += serde_json::to_vec(&name)?.len() + 1;
                    ensure!(
                        size <= MAX_READ,
                        "The directory cannot fit in one runner response."
                    );
                    entries.push(name);
                }
                entries.sort();
                json!({"entries":entries})
            }
            "fs.readFile" | "fs.readFileBuffer" => {
                let maximum = params["maxBytes"]
                    .as_u64()
                    .unwrap_or(MAX_READ as u64)
                    .min(MAX_READ as u64) as usize;
                bytes = filesystem
                    .read_file(path.unwrap(), maximum, params["noFollow"] == true, cancel)
                    .await?;
                if method == "fs.readFile" {
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    bytes.clear();
                    json!({"text":text})
                } else {
                    json!({})
                }
            }
            "fs.writeFile" => {
                let target = boundary.target(params["path"].as_str().unwrap(), true)?;
                let content = if params["encoding"] == "text" {
                    let text = String::from_utf8_lossy(body);
                    text.strip_prefix('\u{feff}')
                        .unwrap_or(&text)
                        .as_bytes()
                        .to_vec()
                } else {
                    body.to_vec()
                };
                tokio::task::spawn_blocking(move || native::write_direct(&target, &content))
                    .await??;
                json!({})
            }
            "fs.mkdir" => {
                let target = boundary.target(params["path"].as_str().unwrap(), true)?;
                let recursive = params["recursive"] == true;
                tokio::task::spawn_blocking(move || native::mkdir(&target, recursive)).await??;
                json!({})
            }
            "fs.chmod" => {
                let target = boundary.target(params["path"].as_str().unwrap(), true)?;
                let mode = params["mode"].as_u64().unwrap() as u32;
                tokio::task::spawn_blocking(move || native::chmod(&target, mode)).await??;
                json!({})
            }
            "fs.move" => {
                let source = boundary.entry(params["source"].as_str().unwrap())?;
                let destination = boundary.entry(params["destination"].as_str().unwrap())?;
                tokio::task::spawn_blocking(move || native::rename(&source, &destination))
                    .await??;
                json!({})
            }
            "fs.setModificationTime" => {
                let target = boundary.target(params["path"].as_str().unwrap(), true)?;
                let time = params["mtimeMs"].as_f64().unwrap();
                tokio::task::spawn_blocking(move || native::set_modified(&target, time)).await??;
                json!({})
            }
            "fs.rm" => {
                let target = boundary.entry(params["path"].as_str().unwrap())?;
                let recursive = params["recursive"] == true;
                let force = params["force"] == true;
                let boundary = boundary.clone();
                let cancellation = cancel.clone();
                tokio::task::spawn_blocking(move || {
                    native::remove_tree(&target, recursive, force, &boundary, &cancellation)
                })
                .await??;
                json!({})
            }
            _ => anyhow::bail!("The runner filesystem method is unavailable."),
        };
        ensure!(
            self.schemas.valid(
                &format!("ownerRunnerResult_{}", method.replace('.', "_")),
                &result
            )?,
            "The runner filesystem result is invalid."
        );
        Ok((result, bytes))
    }
}
