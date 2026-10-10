//! Bounded project images and the original ThumbHash wire representation.
use crate::product::{owners::RunnersModule, schemas::Schemas};
use anyhow::{Context as _, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use image::{ImageDecoder, ImageFormat, ImageReader, imageops::FilterType};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Cursor,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub struct AvatarAsset {
    pub bytes: Vec<u8>,
    pub metadata: Value,
}
const MAX_BYTES: usize = 8 * 1024 * 1024;
static NORMALIZATION_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

pub fn normalize(bytes: &[u8], declared_content_type: Option<&str>) -> Result<AvatarAsset> {
    anyhow::ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_BYTES,
        "The project image must be no larger than 8 MiB."
    );
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let format = reader
        .format()
        .context("The project image does not contain a readable picture.")?;
    let content_type = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        _ => anyhow::bail!("The project image does not contain a supported picture."),
    };
    anyhow::ensure!(
        declared_content_type.is_none_or(|declared| declared == content_type),
        "The project image does not match its content type."
    );
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(100_000_000);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    anyhow::ensure!(
        width > 0 && height > 0 && u64::from(width) * u64::from(height) <= 25_000_000,
        "The project image exceeds its decoded pixel bound."
    );
    let orientation = decoder.orientation()?;
    let mut decoded = image::DynamicImage::from_decoder(decoder)?;
    decoded.apply_orientation(orientation);
    let resized = if decoded.width() > 256 || decoded.height() > 256 {
        decoded.resize(256, 256, FilterType::Lanczos3)
    } else {
        decoded
    };
    let rgba = resized.to_rgba8();
    let bytes = webp::Encoder::from_rgba(&rgba, rgba.width(), rgba.height())
        .encode(82.0)
        .to_vec();
    anyhow::ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_BYTES,
        "The normalized project image exceeds its byte bound."
    );
    let stored = image::load_from_memory_with_format(&bytes, ImageFormat::WebP)?;
    let preview = if stored.width() > 100 || stored.height() > 100 {
        stored.resize(100, 100, FilterType::Lanczos3)
    } else {
        stored
    };
    let preview = preview.to_rgba8();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let thumbhash = STANDARD.encode(thumb_hash(
        preview.width() as usize,
        preview.height() as usize,
        &preview,
    )?);
    let metadata = json!({"contentHash":hash,"contentType":"image/webp","etag":format!("\"{hash}\""),"width":rgba.width(),"height":rgba.height(),"thumbhash":thumbhash});
    anyhow::ensure!(
        Schemas::new()?.valid("ownerProjectAvatarAssetMetadata", &metadata)?,
        "The normalized project avatar metadata is invalid."
    );
    Ok(AvatarAsset { bytes, metadata })
}

async fn normalize_owned(bytes: Vec<u8>) -> Result<AvatarAsset> {
    normalize_declared(bytes, None).await
}
pub async fn normalize_declared(
    bytes: Vec<u8>,
    declared_content_type: Option<String>,
) -> Result<AvatarAsset> {
    let permit = NORMALIZATION_SLOTS.acquire().await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        normalize(&bytes, declared_content_type.as_deref())
    })
    .await?
}

pub async fn discover_repository(
    runners: Arc<RunnersModule>,
    runner: Option<&str>,
    root: &Path,
    cancel: &CancellationToken,
) -> Result<Option<AvatarAsset>> {
    let work = async {
        let canonical_root = runners.canonical_path(runner, root, cancel).await?;
        let directories = [
            "",
            ".github",
            "assets",
            "branding",
            "docs",
            "public",
            "resources",
            "static",
            "src",
        ];
        let mut inspected = 0;
        let mut candidates: Vec<(i32, PathBuf)> = Vec::new();
        for relative in directories {
            if inspected >= 200 {
                break;
            }
            let directory = root.join(relative);
            let Ok(names) = runners.entries(runner, &directory, cancel).await else {
                continue;
            };
            for name in names.into_iter().take(200) {
                inspected += 1;
                if inspected > 200 {
                    break;
                }
                let path = directory.join(&name);
                let Ok(metadata) = runners.inspect(runner, &path, cancel).await else {
                    continue;
                };
                if metadata["isSymbolicLink"] == true
                    || [
                        ".git",
                        ".next",
                        "build",
                        "cache",
                        "coverage",
                        "dist",
                        "node_modules",
                        "target",
                        "vendor",
                    ]
                    .contains(&name.as_str())
                {
                    continue;
                }
                if metadata["isDirectory"] == true && relative == "src" {
                    let Ok(children) = runners.entries(runner, &path, cancel).await else {
                        continue;
                    };
                    for child in children.into_iter().take(200 - inspected.min(200)) {
                        inspected += 1;
                        let child_path = path.join(&child);
                        let Ok(metadata) = runners.inspect(runner, &child_path, cancel).await
                        else {
                            continue;
                        };
                        if metadata["isFile"] == true
                            && metadata["isSymbolicLink"] == false
                            && image_extension(&child_path)
                        {
                            candidates.push((candidate_score(&child_path, 2), child_path));
                        }
                    }
                } else if metadata["isFile"] == true && image_extension(&path) {
                    candidates.push((
                        candidate_score(&path, i32::from(!relative.is_empty())),
                        path,
                    ));
                }
            }
        }
        candidates.sort_by(|(left_score, left_path), (right_score, right_path)| {
            right_score
                .cmp(left_score)
                .then_with(|| left_path.cmp(right_path))
        });
        for (_, path) in candidates.into_iter().take(32) {
            let read = async {
                let metadata = runners.inspect(runner, &path, cancel).await?;
                anyhow::ensure!(
                    metadata["isFile"] == true
                        && metadata["isSymbolicLink"] == false
                        && metadata["size"]
                            .as_u64()
                            .is_some_and(|size| size <= MAX_BYTES as u64),
                    "The project image is not a bounded regular file."
                );
                let canonical = runners.canonical_path(runner, &path, cancel).await?;
                anyhow::ensure!(
                    canonical.starts_with(&canonical_root),
                    "The project image leaves its selected folder."
                );
                runners
                    .read_no_follow(runner, &path, MAX_BYTES, cancel)
                    .await
            }
            .await;
            if let Ok(bytes) = read
                && let Ok(asset) = normalize_owned(bytes).await
            {
                return Ok::<_, anyhow::Error>(Some(asset));
            }
        }
        Ok(None)
    };
    let result = tokio::select! {_=cancel.cancelled()=>anyhow::bail!("Project image discovery was cancelled."),result=tokio::time::timeout(Duration::from_secs(2),work)=>result};
    Ok(result.ok().and_then(Result::ok).flatten())
}

pub async fn discover_hosting(
    remote: &str,
    cancel: &CancellationToken,
) -> Result<Option<AvatarAsset>> {
    let work = async {
        let url = if let Some(ssh) = remote.strip_prefix("git@") {
            let (host, path) = ssh
                .split_once(':')
                .context("The hosting remote is invalid.")?;
            reqwest::Url::parse(&format!("https://{host}/{path}"))?
        } else {
            reqwest::Url::parse(remote)?
        };
        anyhow::ensure!(
            url.username().is_empty() && url.password().is_none(),
            "The hosting remote contains credentials."
        );
        let host = url.host_str().context("The hosting remote has no host.")?;
        let segments = url
            .path()
            .trim_matches('/')
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        anyhow::ensure!(segments.len() >= 2, "The hosting remote has no repository.");
        let owner = segments[..segments.len() - 1].join("/");
        let repository = segments.last().unwrap().trim_end_matches(".git");
        let encode = |text: &str| {
            text.bytes()
                .map(|byte| {
                    if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                        (byte as char).to_string()
                    } else {
                        format!("%{byte:02X}")
                    }
                })
                .collect::<String>()
        };
        let (metadata, allowed): (_, &[&str]) = match host {
            "github.com" => (
                format!("https://api.github.com/users/{}", encode(&owner)),
                &["avatars.githubusercontent.com"],
            ),
            "gitlab.com" => (
                format!(
                    "https://gitlab.com/api/v4/projects/{}",
                    encode(&format!("{owner}/{repository}"))
                ),
                &["gitlab.com", "secure.gravatar.com"],
            ),
            "bitbucket.org" => (
                format!(
                    "https://api.bitbucket.org/2.0/repositories/{}/{}",
                    owner.split('/').map(encode).collect::<Vec<_>>().join("/"),
                    encode(repository)
                ),
                &["bitbucket.org", "secure.gravatar.com"],
            ),
            _ => return Ok(None),
        };
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .user_agent("Happy Agent")
            .build()?;
        let response = client
            .get(metadata)
            .header("accept", "application/json")
            .send()
            .await?
            .error_for_status()?;
        let metadata: Value = serde_json::from_slice(&response_bytes(response, 1048576).await?)?;
        anyhow::ensure!(
            Schemas::new()?.valid("ownerHostingAvatarMetadata", &metadata)?,
            "The hosting avatar metadata is invalid."
        );
        let avatar = if host == "bitbucket.org" {
            metadata["links"]["avatar"]["href"].as_str()
        } else {
            metadata["avatar_url"].as_str()
        };
        let Some(avatar) = avatar else {
            return Ok(None);
        };
        let avatar = reqwest::Url::parse(avatar)?;
        anyhow::ensure!(
            avatar.scheme() == "https"
                && avatar.username().is_empty()
                && avatar.password().is_none()
                && avatar
                    .host_str()
                    .is_some_and(|host| allowed.contains(&host)),
            "The hosting avatar leaves its expected HTTPS domain."
        );
        let response = client
            .get(avatar)
            .header("accept", "image/*")
            .send()
            .await?
            .error_for_status()?;
        anyhow::ensure!(
            response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.starts_with("image/")),
            "The hosting response is not an image."
        );
        let bytes = response_bytes(response, MAX_BYTES).await?;
        Ok(Some(normalize_owned(bytes).await?))
    };
    let result = tokio::select! {_=cancel.cancelled()=>anyhow::bail!("Hosting image discovery was cancelled."),result=tokio::time::timeout(Duration::from_secs(2),work)=>result};
    Ok(result.ok().and_then(Result::ok).flatten())
}
async fn response_bytes(response: reqwest::Response, maximum: usize) -> Result<Vec<u8>> {
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= maximum as u64),
        "The remote image exceeds its byte bound."
    );
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        anyhow::ensure!(
            bytes.len() + chunk.len() <= maximum,
            "The remote image exceeds its byte bound."
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["gif", "jpeg", "jpg", "png", "tif", "tiff", "webp"]
                .contains(&extension.to_ascii_lowercase().as_str())
        })
}
fn candidate_score(path: &Path, depth: i32) -> i32 {
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let preferred = ["logo", "icon", "app-icon", "appicon", "brand"];
    let score = preferred
        .iter()
        .position(|name| *name == stem)
        .map_or(0, |index| 100 - index as i32 * 10);
    score
        - depth * 10
        - if [
            "wordmark",
            "banner",
            "screenshot",
            "badge",
            "favicon",
            "dark",
            "light",
        ]
        .iter()
        .any(|word| stem.contains(word))
        {
            60
        } else {
            0
        }
}

fn thumb_hash(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>> {
    anyhow::ensure!(
        width > 0
            && height > 0
            && width <= 100
            && height <= 100
            && rgba.len() == width * height * 4,
        "The ThumbHash source image is invalid."
    );
    let mut averages = [0.0f64; 4];
    for pixel in rgba.chunks_exact(4) {
        let alpha = f64::from(pixel[3]) / 255.0;
        for channel in 0..3 {
            averages[channel] += alpha / 255.0 * f64::from(pixel[channel]);
        }
        averages[3] += alpha;
    }
    if averages[3] > 0.0 {
        for channel in 0..3 {
            averages[channel] /= averages[3];
        }
    }
    let has_alpha = averages[3] < (width * height) as f64;
    let limit = if has_alpha { 5.0 } else { 7.0 };
    let lx = (limit * width as f64 / width.max(height) as f64)
        .round()
        .max(1.0) as usize;
    let ly = (limit * height as f64 / width.max(height) as f64)
        .round()
        .max(1.0) as usize;
    let mut channels = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    for pixel in rgba.chunks_exact(4) {
        let alpha = f64::from(pixel[3]) / 255.0;
        let red = averages[0] * (1.0 - alpha) + alpha / 255.0 * f64::from(pixel[0]);
        let green = averages[1] * (1.0 - alpha) + alpha / 255.0 * f64::from(pixel[1]);
        let blue = averages[2] * (1.0 - alpha) + alpha / 255.0 * f64::from(pixel[2]);
        channels[0].push((red + green + blue) / 3.0);
        channels[1].push((red + green) / 2.0 - blue);
        channels[2].push(red - green);
        channels[3].push(alpha);
    }
    let encode = |channel: &[f64], nx: usize, ny: usize| {
        let mut dc = 0.0;
        let mut ac: Vec<f64> = Vec::new();
        let mut scale = 0.0f64;
        for cy in 0..ny {
            let mut cx = 0;
            while cx * ny < nx * (ny - cy) {
                let mut factor = 0.0;
                for y in 0..height {
                    let fy =
                        (std::f64::consts::PI / height as f64 * cy as f64 * (y as f64 + 0.5)).cos();
                    for x in 0..width {
                        let fx =
                            (std::f64::consts::PI / width as f64 * cx as f64 * (x as f64 + 0.5))
                                .cos();
                        factor += channel[x + y * width] * fx * fy;
                    }
                }
                factor /= (width * height) as f64;
                if cx == 0 && cy == 0 {
                    dc = factor;
                } else {
                    ac.push(factor);
                    scale = scale.max(factor.abs());
                }
                cx += 1;
            }
        }
        if scale > 0.0 {
            for factor in &mut ac {
                *factor = 0.5 + 0.5 / scale * *factor;
            }
        }
        (dc, ac, scale)
    };
    let (ldc, lac, ls) = encode(&channels[0], lx.max(3), ly.max(3));
    let (pdc, pac, ps) = encode(&channels[1], 3, 3);
    let (qdc, qac, qs) = encode(&channels[2], 3, 3);
    let (adc, aac, as_) = if has_alpha {
        encode(&channels[3], 5, 5)
    } else {
        (0.0, Vec::new(), 0.0)
    };
    let landscape = width > height;
    let h24 = (63.0 * ldc).round() as u32
        | (((31.5 + 31.5 * pdc).round() as u32) << 6)
        | (((31.5 + 31.5 * qdc).round() as u32) << 12)
        | (((31.0 * ls).round() as u32) << 18)
        | (u32::from(has_alpha) << 23);
    let h16 = (if landscape { ly } else { lx }) as u32
        | (((63.0 * ps).round() as u32) << 3)
        | (((63.0 * qs).round() as u32) << 9)
        | (u32::from(landscape) << 15);
    let mut hash = vec![
        h24 as u8,
        (h24 >> 8) as u8,
        (h24 >> 16) as u8,
        h16 as u8,
        (h16 >> 8) as u8,
    ];
    if has_alpha {
        hash.push((15.0 * adc).round() as u8 | (((15.0 * as_).round() as u8) << 4));
    }
    let start = hash.len();
    for (index, factor) in lac.into_iter().chain(pac).chain(qac).chain(aac).enumerate() {
        let offset = start + (index >> 1);
        if hash.len() <= offset {
            hash.push(0);
        }
        hash[offset] |= ((15.0 * factor).round() as u8) << ((index & 1) << 2);
    }
    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn solid_pixel_thumb_hash_matches_the_original_encoder() {
        assert_eq!(
            STANDARD.encode(thumb_hash(1, 1, &[255, 0, 0, 255]).unwrap()),
            "1fsrB38I9wiIh4hwj3CI+AiIgIAICIgA"
        );
        assert_eq!(
            STANDARD.encode(thumb_hash(2, 1, &[255, 0, 0, 255, 0, 255, 0, 128]).unwrap()),
            "1auqA727eAiIiIB4iPCIKIkGiIhgePg="
        );
        assert!(thumb_hash(101, 1, &[0; 404]).is_err());
    }
    #[test]
    fn normalization_keeps_small_images_and_hashes_the_actual_webp() {
        let image = image::RgbaImage::from_pixel(3, 2, image::Rgba([40, 80, 120, 255]));
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let asset = normalize(png.get_ref(), Some("image/png")).unwrap();
        assert_eq!(asset.metadata["width"], 3);
        assert_eq!(asset.metadata["height"], 2);
        assert_eq!(
            asset.metadata["contentHash"],
            json!(format!("{:x}", Sha256::digest(&asset.bytes)))
        );
        assert_eq!(asset.metadata["contentType"], "image/webp");
        assert!(normalize(png.get_ref(), Some("image/jpeg")).is_err());
        assert!(normalize(&[], None).is_err());
    }
}
