use super::*;

pub(super) fn text(bytes: &[u8]) -> Result<&str> {
    let text = std::str::from_utf8(bytes).context(
        "This file is not valid UTF-8 text. Convert its encoding before reading or editing it.",
    )?;
    ensure!(
        !text.contains('\0'),
        "This is a binary file. Use ReadMediaFile for images, or convert it to UTF-8 text."
    );
    Ok(text)
}
pub(super) fn pure_crlf(text: &str) -> bool {
    text.contains("\r\n") && !text.replace("\r\n", "").contains(['\r', '\n'])
}
fn byte_at_utf16(text: &str, units: usize) -> Result<usize> {
    let mut seen = 0;
    for (index, character) in text.char_indices() {
        if seen == units {
            return Ok(index);
        }
        seen += character.len_utf16();
        ensure!(seen <= units, "column_offset splits a Unicode character.");
    }
    ensure!(seen == units, "column_offset is past the first line.");
    Ok(text.len())
}

impl Files {
    pub(in crate::product::tools) async fn kimi_read(
        &self,
        configuration: &Value,
        mode: &str,
        args: &Value,
        cancel: &CancellationToken,
    ) -> Result<FileResult> {
        let written = args["path"].as_str().unwrap();
        let boundary = self.boundary(configuration, mode)?;
        let path = boundary.resolve(written)?;
        let target = boundary.target(written, false)?;
        let (bytes, metadata) = read_async(target.clone(), 8 * 1024 * 1024, cancel).await?;
        let content = text(&bytes)?;
        ensure!(
            mtime(&native::open(&target)?.metadata()?)? == mtime(&metadata)?,
            "The file changed while it was being read. Read it again."
        );
        let view = if pure_crlf(content) {
            content.replace("\r\n", "\n")
        } else {
            content.replace('\r', "\\r")
        };
        let mut lines = if view.is_empty() {
            Vec::new()
        } else {
            view.split('\n').collect::<Vec<_>>()
        };
        if lines.last() == Some(&"") {
            lines.pop();
        }
        let offset = args["line_offset"].as_i64().unwrap_or(1);
        ensure!(
            offset > 0 || args.get("column_offset").is_none(),
            "column_offset is only supported for forward reads."
        );
        let start = if offset < 0 {
            (lines.len() as i128 + offset as i128).max(0) as usize
        } else {
            offset as usize - 1
        };
        let end = lines.len().min(
            start.saturating_add(args["n_lines"].as_u64().unwrap_or(lines.len() as u64) as usize),
        );
        let maximum = args["max_chars"]
            .as_u64()
            .unwrap_or(100_000)
            .clamp(1024, 500_000) as usize;
        let mut remaining = maximum - 512;
        let mut index = start;
        let mut column = args["column_offset"].as_u64().unwrap_or(0) as usize;
        let mut rows = Vec::new();
        byte_at_utf16(lines.get(start).copied().unwrap_or(""), column)?;
        while index < end {
            let line = lines[index];
            let prefix = format!("{}\t", index + 1);
            let begin = byte_at_utf16(line, column)?;
            let suffix = &line[begin..];
            let overhead = prefix.len() + usize::from(!rows.is_empty());
            let length = suffix.encode_utf16().count();
            if length + overhead <= remaining {
                rows.push(prefix + suffix);
                remaining -= length + overhead;
                index += 1;
                column = 0;
                continue;
            }
            if !rows.is_empty() || remaining <= overhead {
                break;
            }
            let mut count = remaining - overhead;
            let mut end_byte = begin;
            let mut units = 0;
            for (byte, character) in suffix.char_indices() {
                if units + character.len_utf16() > count {
                    break;
                }
                units += character.len_utf16();
                end_byte = begin + byte + character.len_utf8();
            }
            count = units;
            rows.push(prefix + &line[begin..end_byte]);
            column += count;
            break;
        }
        let truncated = index < end;
        let next = if truncated {
            format!(
                " Next Read: {{\"line_offset\":{}{} ,\"n_lines\":{},\"max_chars\":{maximum}}}",
                index + 1,
                if column == 0 {
                    String::new()
                } else {
                    format!(",\"column_offset\":{column}")
                },
                end - index
            )
            .replace(" ,", ",")
        } else {
            String::new()
        };
        let status = format!(
            "<system>Returned {} line{} from line {}; total lines: {}. Requested range {}. EOF {}.{next}</system>",
            rows.len(),
            if rows.len() == 1 { "" } else { "s" },
            start + 1,
            lines.len(),
            if truncated { "incomplete" } else { "complete" },
            if index >= lines.len() {
                "reached"
            } else {
                "not reached"
            }
        );
        let text = format!(
            "{}\n{status}",
            if rows.is_empty() {
                if lines.is_empty() {
                    "(empty file)".into()
                } else {
                    "(empty range)".into()
                }
            } else {
                rows.join("\n")
            }
        );
        Ok(FileResult {
            value: json!({"path":path,"text":text,"truncated":truncated}),
            blocks: vec![Block::text(text)],
            read: Some(read_stamp(&path, &metadata)?),
        })
    }
    pub(in crate::product::tools) async fn kimi_media(
        &self,
        configuration: &Value,
        mode: &str,
        args: &Value,
        cancel: &CancellationToken,
    ) -> Result<FileResult> {
        use base64::Engine;
        let boundary = self.boundary(configuration, mode)?;
        let written = args["path"].as_str().unwrap();
        let path = boundary.resolve(written)?;
        let target = boundary.target(written, false)?;
        ensure!(
            matches!(
                image_mime(&path),
                Some("image/png" | "image/jpeg" | "image/webp" | "image/gif")
            ),
            "Only PNG, JPEG, WebP, and GIF images are supported. Convert other media to one of these formats first."
        );
        let (bytes, metadata) = read_async(target.clone(), 20 * 1024 * 1024, cancel).await?;
        let arguments = args.clone();
        let work = tokio::task::spawn_blocking(move || -> Result<_> {
            let format = image::guess_format(&bytes)?;
            ensure!(
                matches!(
                    format,
                    image::ImageFormat::Png
                        | image::ImageFormat::Jpeg
                        | image::ImageFormat::WebP
                        | image::ImageFormat::Gif
                ),
                "The file is not a supported image format."
            );
            let (width, height) = image::ImageReader::new(std::io::Cursor::new(&bytes))
                .with_guessed_format()?
                .into_dimensions()?;
            ensure!(
                u64::from(width) * u64::from(height) <= 40_000_000,
                "The image exceeds the 40 million pixel limit."
            );
            let mut image = image::load_from_memory(&bytes)?;
            let mut x = 0;
            let mut y = 0;
            if let Some(region) = arguments.get("region") {
                x = region["x"].as_u64().unwrap();
                y = region["y"].as_u64().unwrap();
                let crop_width = region["width"].as_u64().unwrap();
                let crop_height = region["height"].as_u64().unwrap();
                ensure!(
                    x + crop_width <= u64::from(width) && y + crop_height <= u64::from(height),
                    "The requested region is outside the original image."
                );
                image = image.crop_imm(x as u32, y as u32, crop_width as u32, crop_height as u32);
            } else if arguments["full_resolution"] != true {
                image = image.resize(2048, 2048, image::imageops::FilterType::Lanczos3);
            }
            let mut output = std::io::Cursor::new(Vec::new());
            image.write_to(&mut output, image::ImageFormat::Png)?;
            let output = output.into_inner();
            ensure!(
                output.len() <= 3 * 1024 * 1024,
                "Delivered image exceeds the 3 MiB limit. Select a smaller region or create a smaller copy before reading it."
            );
            Ok((output, width, height, image.width(), image.height(), x, y))
        });
        let (bytes, original_width, original_height, width, height, x, y) = tokio::select! {result=work=>result??,_=cancel.cancelled()=>anyhow::bail!("The image read was interrupted.")};
        ensure!(
            mtime(&native::open(&target)?.metadata()?)? == mtime(&metadata)?,
            "The image changed while it was being read. Read it again."
        );
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let text = format!(
            "Image {}: original {original_width}×{original_height}, delivered {width}×{height}; region offset ({x}, {y}).",
            path.display()
        );
        Ok(FileResult {
            value: json!({"path":path,"image":{"data":data,"mime_type":"image/png","bytes":bytes.len()},"original_width":original_width,"original_height":original_height,"width":width,"height":height,"region_x":x,"region_y":y}),
            blocks: vec![
                Block::text(text),
                Block::Image {
                    data,
                    mime_type: "image/png".into(),
                },
            ],
            read: Some(read_stamp(&path, &metadata)?),
        })
    }
}
