use super::super::{
    config::ConfigModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result, ensure};
use happy_providers::Block;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;
mod boundary;
mod diff;
mod discovery;
mod filesystem;
mod kimi;
mod native;
mod patch;
mod regex_worker;
mod runner;
use boundary::Boundary;
pub use filesystem::ComputeFilesystem;

pub(super) fn compute_regex_worker() -> std::process::ExitCode {
    regex_worker::run()
}

/// The result remains structured until the owner records it with the durable
/// tool result. Provider-facing text and images use the vendor's own format.
pub(super) struct FileResult {
    pub value: Value,
    pub blocks: Vec<Block>,
    pub read: Option<Value>,
}

pub(super) struct Files {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    schemas: Schemas,
    identity: String,
}
impl Files {
    pub(super) fn runner_filesystem(&self, request: &Value) -> Result<ComputeFilesystem> {
        let private = self.config.is_container_worker()
            && self
                .schemas
                .valid("ownerRunnerParams_compute_createContainer", request)?;
        ensure!(
            private
                || self
                    .schemas
                    .valid("ownerRunnerParams_compute_create", request)?,
            "The runner compute request is invalid."
        );
        ensure!(
            request.get("docker").is_none(),
            "Native Docker compute has not been migrated; this runner cannot execute container work on the host."
        );
        let environment = if private {
            self.config.container_file_environment(request)?
        } else {
            self.config.runner_file_environment(request)?
        };
        let (restricted_read_paths, restricted_write_paths) = if private {
            self.config.container_restricted_paths(request)?
        } else {
            (Vec::new(), Vec::new())
        };
        ComputeFilesystem::local(
            Boundary {
                root: environment.root,
                home: environment.home,
                mode: "full_access".into(),
                private_paths: environment.private_paths,
                protected_paths: environment.protected_paths,
                allowed_write_paths: Vec::new(),
                denied_read_paths: Vec::new(),
                denied_write_paths: Vec::new(),
                reviewed_paths: None,
                restricted_read_paths,
                restricted_write_paths,
            },
            format!("runner:{}", request["computeId"].as_str().unwrap()),
        )
    }
    pub(super) async fn read_workflow_script(
        &self,
        configuration: &Value,
        mode: &str,
        path: &str,
        cancel: &CancellationToken,
    ) -> Result<String> {
        let target = self.boundary(configuration, mode)?.target(path, false)?;
        let (bytes, _) = read_async(target, 524_288 * 4, cancel).await?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        ensure!(
            text.encode_utf16().count() <= 524_288,
            "The workflow script exceeds the character limit."
        );
        Ok(text)
    }
    pub fn new(config: Arc<ConfigModule>, runtime: Arc<RuntimeModule>) -> Result<Self> {
        Ok(Self {
            config,
            runtime,
            schemas: Schemas::new()?,
            identity: uuid::Uuid::new_v4().to_string(),
        })
    }
    fn boundary(&self, configuration: &Value, mode: &str) -> Result<Boundary> {
        let environment = self.config.compute_file_environment(configuration)?;
        let (restricted_read_paths, restricted_write_paths) = configuration
            .get("_dockerRequest")
            .map(|request| self.config.container_restricted_paths(request))
            .transpose()?
            .unwrap_or_default();
        Ok(Boundary {
            root: environment.root,
            home: environment.home,
            mode: mode.into(),
            private_paths: environment.private_paths,
            protected_paths: environment.protected_paths,
            allowed_write_paths: Vec::new(),
            denied_read_paths: Vec::new(),
            denied_write_paths: Vec::new(),
            reviewed_paths: configuration
                .get("_dockerReviewedPaths")
                .and_then(Value::as_array)
                .map(|paths| {
                    paths
                        .iter()
                        .map(|binding| {
                            (
                                PathBuf::from(binding["path"].as_str().unwrap()),
                                PathBuf::from(binding["target"].as_str().unwrap()),
                                binding["write"].as_bool().unwrap(),
                            )
                        })
                        .collect()
                }),
            restricted_read_paths,
            restricted_write_paths,
        })
    }
    pub(super) fn filesystem(
        &self,
        configuration: &Value,
        mode: &str,
    ) -> Result<ComputeFilesystem> {
        ComputeFilesystem::local(self.boundary(configuration, mode)?, self.identity.clone())
    }
    pub fn review(&self, configuration: &Value, path: &str, write: bool) -> bool {
        self.boundary(configuration, "auto")
            .map_or(true, |boundary| boundary.review(path, write))
    }
    pub(in crate::product::tools) fn review_binding(
        &self,
        configuration: &Value,
        path: &str,
        write: bool,
    ) -> Result<Value> {
        let boundary = self.boundary(configuration, "full_access")?;
        Ok(
            json!({"path":boundary.resolve(path)?,"target":boundary.target(path,false)?,"write":write}),
        )
    }
    pub fn describe(
        &self,
        configuration: &Value,
        path: &str,
        verb: &str,
        write: bool,
        full: bool,
    ) -> String {
        let boundary = self.boundary(configuration, "auto");
        let path = boundary
            .as_ref()
            .ok()
            .and_then(|boundary| boundary.resolve(path).ok())
            .map_or_else(
                || path.to_owned(),
                |path| path.to_string_lossy().into_owned(),
            );
        let reviewed = full
            || boundary
                .as_ref()
                .map_or(true, |boundary| boundary.review(&path, write));
        format!(
            "{verb} {}. Access: {}",
            json!(path),
            if reviewed {
                "reviewed filesystem access outside the current workspace boundary, including protected files"
            } else {
                "the current workspace filesystem boundary"
            }
        )
    }
    pub fn record(&self, ctx: &Context<'_>, agent: &str, read: &Value) -> Result<()> {
        ensure!(
            self.schemas.valid("computeFileReadLog", &json!([read]))?,
            "The file read stamp is invalid."
        );
        let key = format!("kv.{agent}.module.compute.reads");
        let current = ctx.value(agent, &key)?.unwrap_or(json!([]));
        let mut entries = if self.schemas.valid("computeFileReadLog", &current)? {
            current
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["path"] != read["path"])
                .cloned()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        entries.push(read.clone());
        if entries.len() > 512 {
            entries.drain(..entries.len() - 512);
        }
        ctx.put_value(agent, &key, &json!(entries))
    }
    async fn assert_read(
        &self,
        agent: &str,
        written: &Path,
        metadata: &std::fs::Metadata,
    ) -> Result<()> {
        let schemas = Schemas::new()?;
        let agent = agent.to_owned();
        let path = written.to_string_lossy().into_owned();
        let stamp = mtime(metadata)?;
        self.runtime.transact(move |ctx| {
            let current = ctx.value(&agent,&format!("kv.{agent}.module.compute.reads"))?.unwrap_or(json!([]));
            if schemas.valid("computeFileReadLog",&current)? && let Some(known) = current.as_array().unwrap().iter().find(|entry|entry["path"]==path) {
                ensure!(known["mtimeMs"].as_f64()==Some(stamp), "This file has changed since it was last read, so a change now would discard that work. Read it again first: {path}");
            }
            Ok(())
        }).await
    }
    pub async fn read(
        &self,
        configuration: &Value,
        mode: &str,
        vendor: &str,
        arguments: &Value,
        image_only: bool,
        cancel: &CancellationToken,
    ) -> Result<FileResult> {
        let written = if image_only {
            arguments["path"].as_str()
        } else if vendor == "grok" {
            arguments["target_file"].as_str()
        } else {
            arguments["file_path"].as_str()
        }
        .context("The file path is missing.")?;
        let boundary = self.boundary(configuration, mode)?;
        let path = boundary.resolve(written)?;
        let target = boundary.target(written, false)?;
        let lower = path.to_string_lossy().to_ascii_lowercase();
        if !image_only && vendor != "grok" && (lower.ends_with(".ipynb") || lower.ends_with(".pdf"))
        {
            let text = if lower.ends_with(".ipynb") {
                "Jupyter notebooks are not supported. Export the notebook to a plain-text format first."
            } else {
                "PDF rendering is not supported. Convert the PDF to text or images first."
            };
            return Ok(FileResult {
                value: json!({"outcome":"unsupported","path":path,"text":text}),
                blocks: vec![Block::text(text)],
                read: None,
            });
        }
        let mime = image_mime(&path);
        if image_only || (vendor != "grok" && mime.is_some()) {
            if vendor == "glm" {
                let text = "This model does not support image input. Convert the image to text before reading it.";
                return Ok(FileResult {
                    value: json!({"outcome":"unsupported","path":path,"text":text}),
                    blocks: vec![Block::text(text)],
                    read: None,
                });
            }
            return self
                .image(path, target, vendor, arguments, image_only, cancel)
                .await;
        }
        let (bytes, metadata) = read_async(target, native::MAX_TEXT_BYTES, cancel).await?;
        let content = String::from_utf8_lossy(&bytes);
        let lines = content
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line))
            .collect::<Vec<_>>();
        let start = arguments["offset"].as_u64().unwrap_or(1).max(1) as usize;
        let max_lines = if vendor == "grok" { 1000 } else { 2000 };
        let count = arguments["limit"]
            .as_u64()
            .unwrap_or(max_lines)
            .min(max_lines) as usize;
        let empty = content.is_empty();
        let selected = lines.iter().skip(start - 1).take(count).collect::<Vec<_>>();
        let numbered = selected
            .iter()
            .enumerate()
            .map(|(index, line)| {
                format!(
                    "{}{}{line}",
                    start + index,
                    if vendor == "grok" { "→" } else { "\t" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let (numbered, bounded) = bound(&numbered, 60_000);
        let returned = if empty { 0 } else { selected.len() };
        let total = if empty { 0 } else { lines.len() };
        let truncated = bounded || start - 1 + returned < total;
        let text = if returned == 0 {
            if total == 0 {
                "(empty file)".into()
            } else {
                format!("(no lines there; the file has {total} lines)")
            }
        } else if truncated {
            format!(
                "{numbered}\n[Showing lines {start} to {} of {total}. Read on with offset.]",
                start + returned - 1
            )
        } else {
            numbered.clone()
        };
        let mut value = json!({"path":path,"content":if empty{""}else{&numbered},"start_line":start,"returned_lines":returned,"total_lines":total,"truncated":truncated});
        if vendor != "grok" {
            value["outcome"] = json!("text");
        }
        Ok(FileResult {
            value,
            blocks: vec![Block::text(text)],
            read: Some(read_stamp(&path, &metadata)?),
        })
    }
    async fn image(
        &self,
        path: PathBuf,
        target: PathBuf,
        vendor: &str,
        arguments: &Value,
        image_only: bool,
        cancel: &CancellationToken,
    ) -> Result<FileResult> {
        use base64::Engine;
        let mime = image_mime(&path).context("This is not a supported image file.")?;
        let (bytes, metadata) = read_async(target, 3 * 1024 * 1024, cancel).await?;
        let original_len = bytes.len();
        let (bytes, mime, resized) = if image_only {
            (bytes, mime.to_owned(), None)
        } else {
            let decode = tokio::task::spawn_blocking(move || -> Result<_> {
                let format = image::guess_format(&bytes).context("The image cannot be decoded.")?;
                let (input_width, input_height) =
                    image::ImageReader::new(std::io::Cursor::new(&bytes))
                        .with_guessed_format()?
                        .into_dimensions()?;
                ensure!(
                    u64::from(input_width) * u64::from(input_height) <= 40_000_000,
                    "The image exceeds the 40 million pixel limit."
                );
                let image =
                    image::load_from_memory(&bytes).context("The image cannot be decoded.")?;
                let width = image.width();
                let height = image.height();
                let original_mime = match format {
                    image::ImageFormat::Jpeg => Some("image/jpeg"),
                    image::ImageFormat::Png => Some("image/png"),
                    image::ImageFormat::WebP => Some("image/webp"),
                    _ => None,
                };
                let resize = width > 2000 || height > 2000;
                if !resize && let Some(mime) = original_mime {
                    return Ok((bytes, mime.to_owned(), None));
                }
                let scale = (2000.0 / f64::from(width.max(height))).min(1.0);
                let scaled = if resize {
                    image.resize_exact(
                        (f64::from(width) * scale).round().max(1.0) as u32,
                        (f64::from(height) * scale).round().max(1.0) as u32,
                        image::imageops::FilterType::Triangle,
                    )
                } else {
                    image
                };
                let dimensions = if resize {
                    Some(
                        json!({"original_width":width,"original_height":height,"width":scaled.width(),"height":scaled.height()}),
                    )
                } else {
                    None
                };
                let mut output = std::io::Cursor::new(Vec::new());
                let output_mime = original_mime.unwrap_or("image/png");
                match format {
                    image::ImageFormat::Jpeg => {
                        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 85)
                            .encode_image(&scaled)?
                    }
                    image::ImageFormat::WebP => {
                        scaled.write_to(&mut output, image::ImageFormat::WebP)?
                    }
                    _ => scaled.write_to(&mut output, image::ImageFormat::Png)?,
                }
                Ok((output.into_inner(), output_mime.into(), dimensions))
            });
            tokio::select! {result=decode=>result??,_=cancel.cancelled()=>anyhow::bail!("The image read was interrupted.")}
        };
        ensure!(
            bytes.len() <= 3 * 1024 * 1024,
            "The resized image exceeds the 3 MiB limit."
        );
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let mut image = json!({"data":data,"mime_type":mime,"bytes":if image_only{original_len}else{bytes.len()}});
        if let Some(resized) = resized {
            image["resized"] = resized;
        }
        let text = if image.get("resized").is_some() {
            format!(
                "Image: {} (original {}×{}, shown at {}×{})",
                path.display(),
                image["resized"]["original_width"],
                image["resized"]["original_height"],
                image["resized"]["width"],
                image["resized"]["height"]
            )
        } else {
            format!("Image: {}", path.display())
        };
        let value = if image_only {
            json!({"path":path,"detail":arguments["detail"].as_str().unwrap_or("high"),"image":image})
        } else {
            json!({"outcome":"image","path":path,"image":image})
        };
        Ok(FileResult {
            value,
            blocks: vec![
                Block::text(text),
                Block::Image {
                    data,
                    mime_type: mime,
                },
            ],
            read: Some(read_stamp(&path, &metadata)?),
        })
    }
    pub async fn write(
        &self,
        agent: &str,
        configuration: &Value,
        mode: &str,
        vendor: &str,
        arguments: &Value,
        cancel: &CancellationToken,
    ) -> Result<FileResult> {
        let written = arguments[if vendor == "kimi" {
            "path"
        } else {
            "file_path"
        }]
        .as_str()
        .context("The file path is missing.")?;
        let requested = arguments["content"]
            .as_str()
            .context("The file content is missing.")?;
        let limit = if vendor == "kimi" {
            8 * 1024 * 1024
        } else {
            native::MAX_TEXT_BYTES
        };
        let boundary = self.boundary(configuration, mode)?;
        let path = boundary.resolve(written)?;
        let target = boundary.target(written, true)?;
        let previous = if target.exists() {
            Some(read_async(target.clone(), limit, cancel).await?)
        } else {
            None
        };
        if vendor == "kimi"
            && let Some((bytes, _)) = &previous
        {
            kimi::text(bytes)?;
        }
        let content = if vendor == "kimi" && arguments["mode"] == "append" {
            previous
                .as_ref()
                .map(|(bytes, _)| String::from_utf8_lossy(bytes).into_owned())
                .unwrap_or_default()
                + requested
        } else {
            requested.to_owned()
        };
        ensure!(
            content.len() <= limit,
            "The resulting file exceeds the text byte limit."
        );
        if vendor == "kimi" {
            ensure!(
                !content.contains('\0'),
                "The resulting file is not text within the byte limit."
            );
        }
        if let Some((_, metadata)) = &previous {
            self.assert_read(agent, &path, metadata).await?;
        }
        let presentation = diff::whole(
            &path.to_string_lossy(),
            previous
                .as_ref()
                .map(|(bytes, _)| String::from_utf8_lossy(bytes))
                .as_deref(),
            &content,
        );
        write_async(
            target,
            content.as_bytes().to_vec(),
            previous.as_ref().map(|(_, metadata)| metadata.clone()),
            cancel,
        )
        .await?;
        let target = boundary.target(written, false)?;
        let metadata = native::open(&target)?.metadata()?;
        Ok(FileResult {
            value: json!({"path":path,"created":previous.is_none(),"characters":content.encode_utf16().count(),"presentation":presentation}),
            blocks: Vec::new(),
            read: Some(read_stamp(&path, &metadata)?),
        })
    }
    pub async fn edit(
        &self,
        agent: &str,
        configuration: &Value,
        mode: &str,
        vendor: &str,
        arguments: &Value,
        cancel: &CancellationToken,
    ) -> Result<FileResult> {
        let written = arguments[if vendor == "kimi" {
            "path"
        } else {
            "file_path"
        }]
        .as_str()
        .context("The file path is missing.")?;
        let old = arguments["old_string"]
            .as_str()
            .context("The original text is missing.")?;
        let new = arguments["new_string"]
            .as_str()
            .context("The replacement text is missing.")?;
        ensure!(
            old != new,
            "The replacement is identical to the text it replaces."
        );
        let boundary = self.boundary(configuration, mode)?;
        let path = boundary.resolve(written)?;
        let target = boundary.target(written, true)?;
        let limit = if vendor == "kimi" {
            8 * 1024 * 1024
        } else {
            native::MAX_TEXT_BYTES
        };
        let (bytes, metadata) = read_async(target.clone(), limit, cancel).await?;
        self.assert_read(agent, &path, &metadata).await?;
        let content = String::from_utf8_lossy(&bytes);
        if vendor == "kimi" {
            kimi::text(&bytes)?;
        }
        let crlf = vendor == "kimi" && kimi::pure_crlf(&content);
        let old = if crlf {
            old.replace("\r\n", "\n").replace('\n', "\r\n")
        } else {
            old.to_owned()
        };
        let new = if crlf {
            new.replace("\r\n", "\n").replace('\n', "\r\n")
        } else {
            new.to_owned()
        };
        let old = old.as_str();
        let new = new.as_str();
        ensure!(
            !old.is_empty(),
            "This text does not appear in {}.",
            path.display()
        );
        let all = arguments["replace_all"] == true;
        let mut starts = Vec::new();
        for (start, _) in content.match_indices(old) {
            ensure!(
                starts.len() < 10_000,
                "This edit exceeds the 10000-replacement limit. Narrow the edit or split the work into smaller files."
            );
            starts.push(start);
        }
        ensure!(
            !starts.is_empty(),
            "This text does not appear in {}.",
            path.display()
        );
        ensure!(
            all || starts.len() == 1,
            "This text appears {} times in {}. Add surrounding context to make it unique, or replace every occurrence.",
            starts.len(),
            path.display()
        );
        let resulting =
            content.len() as i128 + starts.len() as i128 * (new.len() as i128 - old.len() as i128);
        ensure!(
            resulting <= limit as i128,
            "The resulting file exceeds the text byte limit."
        );
        if vendor == "kimi" {
            ensure!(
                !new.contains('\0'),
                "The resulting file is not text within the byte limit."
            );
        }
        let updated = if all {
            content.replace(old, new)
        } else {
            content.replacen(old, new, 1)
        };
        let presentation = diff::replacements(
            &path.to_string_lossy(),
            &content,
            &starts
                .iter()
                .map(|start| (*start, old, new))
                .collect::<Vec<_>>(),
        );
        write_async(target, updated.into_bytes(), Some(metadata), cancel).await?;
        let metadata = native::open(&boundary.target(written, false)?)?.metadata()?;
        Ok(FileResult {
            value: json!({"path":path,"replacements":starts.len(),"presentation":presentation}),
            blocks: Vec::new(),
            read: Some(read_stamp(&path, &metadata)?),
        })
    }
}

fn read_stamp(path: &Path, metadata: &std::fs::Metadata) -> Result<Value> {
    Ok(json!({"path":path,"mtimeMs":mtime(metadata)?}))
}
fn mtime(metadata: &std::fs::Metadata) -> Result<f64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(metadata.mtime() as f64 * 1000.0 + metadata.mtime_nsec() as f64 / 1_000_000.0)
    }
    #[cfg(not(unix))]
    {
        Ok(
            match metadata.modified()?.duration_since(std::time::UNIX_EPOCH) {
                Ok(duration) => {
                    duration.as_secs() as f64 * 1000.0
                        + f64::from(duration.subsec_nanos()) / 1_000_000.0
                }
                Err(error) => {
                    let duration = error.duration();
                    -(duration.as_secs() as f64 * 1000.0
                        + f64::from(duration.subsec_nanos()) / 1_000_000.0)
                }
            },
        )
    }
}
fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpeg" | "jpg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}
fn bound(text: &str, maximum: usize) -> (String, bool) {
    let mut units = 0;
    let mut shown = String::new();
    for character in text.chars() {
        if units + character.len_utf16() > maximum {
            return (shown, true);
        }
        units += character.len_utf16();
        shown.push(character);
    }
    (shown, false)
}
async fn read_async(
    path: PathBuf,
    limit: usize,
    cancel: &CancellationToken,
) -> Result<(Vec<u8>, std::fs::Metadata)> {
    let read = tokio::task::spawn_blocking(move || native::read(&path, limit));
    tokio::select! {result=read=>result?,_=cancel.cancelled()=>anyhow::bail!("The file read was interrupted.")}
}
async fn write_async(
    path: PathBuf,
    bytes: Vec<u8>,
    metadata: Option<std::fs::Metadata>,
    cancel: &CancellationToken,
) -> Result<()> {
    ensure!(!cancel.is_cancelled(), "The file change was interrupted.");
    // Once an atomic mutation starts it must finish before its caller receives
    // cancellation; dropping a blocking write would leave an unowned effect.
    tokio::task::spawn_blocking(move || native::write(&path, &bytes, metadata.as_ref())).await?
}

#[cfg(test)]
mod tests;
