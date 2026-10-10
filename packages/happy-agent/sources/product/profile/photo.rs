//! Profile-owned image normalization and the canonical ThumbHash encoder.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageDecoder, ImageFormat, ImageReader, imageops::FilterType};
use sha2::{Digest, Sha256};
use std::io::Cursor;
pub struct ProfilePhotoAsset {
    pub bytes: Vec<u8>,
    pub metadata: Value,
}
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
impl ProfileModule {
    pub async fn normalize_photo(
        &self,
        bytes: Vec<u8>,
        content_type: String,
    ) -> Result<ProfilePhotoAsset> {
        self.validate(
            "ownerProfilePhotoType",
            &json!(content_type),
            "The profile photo must be a PNG, JPEG, or WebP image.",
        )?;
        ensure!(
            !bytes.is_empty() && bytes.len() <= MAX_BYTES,
            "The profile photo must be no larger than 8 MiB."
        );
        let slot = SLOTS.acquire().await?;
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            normalize(&bytes, &content_type)
        })
        .await?
    }
    pub fn get_photo(&self, ctx: &Context<'_>) -> Result<Option<ProfilePhotoAsset>> {
        self.runtime.assert_context(ctx)?;
        let length: Option<usize> = ctx
            .database()
            .query_row(
                "SELECT length(photo_bytes) FROM happy_agent_profile_photo WHERE singleton_id=1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(length) = length else {
            return Ok(None);
        };
        ensure!(
            length > 0 && length <= MAX_BYTES,
            "The stored profile photo is invalid."
        );
        let (bytes,content_type,hash,thumb,width,height):(Vec<u8>,String,String,String,u32,u32)=ctx.database().query_row("SELECT photo_bytes,content_type,content_hash,thumbhash,width,height FROM happy_agent_profile_photo WHERE singleton_id=1",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))?;
        let metadata = json!({"contentHash":hash,"contentType":content_type,"etag":format!("\"{hash}\""),"height":height,"thumbhash":thumb,"width":width});
        self.validate(
            "ownerProfilePhotoAssetMetadata",
            &metadata,
            "The stored profile photo metadata is invalid.",
        )?;
        ensure!(
            format!("{:x}", Sha256::digest(&bytes)) == hash,
            "The stored profile photo does not match its content hash."
        );
        Ok(Some(ProfilePhotoAsset { bytes, metadata }))
    }
    pub fn put_photo(
        &self,
        ctx: &Context<'_>,
        asset: &ProfilePhotoAsset,
        expected: Option<&str>,
    ) -> Result<Value> {
        self.options(expected, "The profile photo update is not valid.")?;
        self.validate(
            "ownerProfilePhotoAssetMetadata",
            &asset.metadata,
            "The profile photo update is not valid.",
        )?;
        ensure!(
            !asset.bytes.is_empty() && asset.bytes.len() <= MAX_BYTES,
            "The profile photo must be no larger than 8 MiB."
        );
        ensure!(
            format!("{:x}", Sha256::digest(&asset.bytes))
                == asset.metadata["contentHash"].as_str().unwrap(),
            "The profile photo does not match its content hash."
        );
        let before = self.ensure(ctx)?;
        self.owned(&before)?;
        self.expected(&before, expected)?;
        let at = now();
        let mut after = before.clone();
        after["photo"] = json!({"contentHash":asset.metadata["contentHash"],"height":asset.metadata["height"],"thumbhash":asset.metadata["thumbhash"],"width":asset.metadata["width"]});
        after["updatedAt"] = json!(at);
        after["version"] = json!(version(before["version"].as_str(), at)?);
        ctx.database().execute("INSERT INTO happy_agent_profile_photo(singleton_id,photo_bytes,content_type,content_hash,thumbhash,width,height) VALUES(1,?1,?2,?3,?4,?5,?6) ON CONFLICT(singleton_id) DO UPDATE SET photo_bytes=excluded.photo_bytes,content_type=excluded.content_type,content_hash=excluded.content_hash,thumbhash=excluded.thumbhash,width=excluded.width,height=excluded.height",params![asset.bytes,asset.metadata["contentType"].as_str(),asset.metadata["contentHash"].as_str(),asset.metadata["thumbhash"].as_str(),asset.metadata["width"].as_u64(),asset.metadata["height"].as_u64()])?;
        self.write(ctx, &after)?;
        self.publish(ctx, &before, &after)?;
        Ok(after)
    }
    pub fn delete_photo(&self, ctx: &Context<'_>, expected: Option<&str>) -> Result<Value> {
        self.options(expected, "The profile photo update is not valid.")?;
        let before = self.ensure(ctx)?;
        self.owned(&before)?;
        self.expected(&before, expected)?;
        if before["photo"].is_null() {
            return Ok(before);
        }
        let at = now();
        let mut after = before.clone();
        after["photo"] = Value::Null;
        after["updatedAt"] = json!(at);
        after["version"] = json!(version(before["version"].as_str(), at)?);
        ctx.database().execute(
            "DELETE FROM happy_agent_profile_photo WHERE singleton_id=1",
            [],
        )?;
        self.write(ctx, &after)?;
        self.publish(ctx, &before, &after)?;
        Ok(after)
    }
}
fn normalize(bytes: &[u8], declared: &str) -> Result<ProfilePhotoAsset> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let format = reader
        .format()
        .context("The profile photo does not contain a readable picture.")?;
    let actual = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        _ => anyhow::bail!("The profile photo must be a PNG, JPEG, or WebP image."),
    };
    ensure!(
        actual == declared,
        "The profile photo does not match its content type."
    );
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(100_000_000);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    ensure!(
        width > 0 && height > 0 && u64::from(width) * u64::from(height) <= 25_000_000,
        "The profile photo exceeds its decoded pixel bound."
    );
    let orientation = decoder.orientation()?;
    let mut image = image::DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let image = if image.width() > 512 || image.height() > 512 {
        image.resize(512, 512, FilterType::Lanczos3)
    } else {
        image
    };
    let rgba = image.to_rgba8();
    let bytes = webp::Encoder::from_rgba(&rgba, rgba.width(), rgba.height())
        .encode(82.0)
        .to_vec();
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_BYTES,
        "The normalized profile photo is invalid."
    );
    let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::WebP)?;
    let preview = if decoded.width() > 100 || decoded.height() > 100 {
        decoded.resize(100, 100, FilterType::Lanczos3)
    } else {
        decoded
    };
    let preview = preview.to_rgba8();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let thumbhash = STANDARD.encode(thumb_hash(
        preview.width() as usize,
        preview.height() as usize,
        &preview,
    )?);
    let metadata = json!({"contentHash":hash,"contentType":"image/webp","etag":format!("\"{hash}\""),"height":rgba.height(),"thumbhash":thumbhash,"width":rgba.width()});
    ensure!(
        Schemas::new()?.valid("ownerProfilePhotoAssetMetadata", &metadata)?,
        "The normalized profile photo metadata is invalid."
    );
    Ok(ProfilePhotoAsset { bytes, metadata })
}
fn thumb_hash(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>> {
    ensure!(
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
        let (mut dc, mut scale) = (0.0, 0.0f64);
        let mut ac = Vec::new();
        for cy in 0..ny {
            let mut cx = 0;
            while cx * ny < nx * (ny - cy) {
                let mut factor = 0.0;
                let xs = (0..width)
                    .map(|x| {
                        (std::f64::consts::PI / width as f64 * cx as f64 * (x as f64 + 0.5)).cos()
                    })
                    .collect::<Vec<_>>();
                for y in 0..height {
                    let fy =
                        (std::f64::consts::PI / height as f64 * cy as f64 * (y as f64 + 0.5)).cos();
                    for x in 0..width {
                        factor += channel[x + y * width] * xs[x] * fy;
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
    fn profile_thumbhash_matches_original_rgba_encoder() {
        let source: Value = serde_json::from_str(include_str!("source_goldens.json")).unwrap();
        for case in source["thumbhashes"].as_array().unwrap() {
            let rgba = case["rgba"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_u64().unwrap() as u8)
                .collect::<Vec<_>>();
            assert_eq!(
                STANDARD.encode(
                    thumb_hash(
                        case["width"].as_u64().unwrap() as usize,
                        case["height"].as_u64().unwrap() as usize,
                        &rgba
                    )
                    .unwrap()
                ),
                case["result"].as_str().unwrap()
            );
        }
    }
}
