use super::*;
use std::collections::BTreeMap;

struct Hunk {
    anchor: Option<String>,
    eof: bool,
    lines: Vec<(char, String)>,
}
enum Operation {
    Add(String, Vec<String>),
    Delete(String),
    Update(String, Option<String>, Vec<Hunk>),
}
struct Simulated {
    content: Option<String>,
    metadata: Option<std::fs::Metadata>,
}
enum Planned {
    Write(PathBuf, PathBuf, String),
    Delete(PathBuf),
    Move(PathBuf, PathBuf, String, bool),
}

impl Files {
    pub(in crate::product::tools) fn patch_paths(
        &self,
        configuration: &Value,
        args: &Value,
    ) -> Result<Vec<String>> {
        let boundary = self.boundary(configuration, "auto")?;
        let workdir = boundary.resolve(args["workdir"].as_str().unwrap_or("."))?;
        let relative = Boundary {
            root: workdir,
            ..boundary
        };
        let mut paths = Vec::new();
        for line in args["patch"]
            .as_str()
            .unwrap_or("")
            .replace("\r\n", "\n")
            .lines()
        {
            if let Some((_, path)) = directive(line) {
                let path = relative.resolve(path).map_or_else(
                    |_| path.to_owned(),
                    |path| path.to_string_lossy().into_owned(),
                );
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
        }
        Ok(paths)
    }
    pub(in crate::product::tools) async fn patch(
        &self,
        agent: &str,
        configuration: &Value,
        mode: &str,
        args: &Value,
        cancel: &CancellationToken,
    ) -> Result<FileResult> {
        let operations = parse(args["patch"].as_str().unwrap())?;
        let boundary = self.boundary(configuration, mode)?;
        let workdir = boundary.resolve(args["workdir"].as_str().unwrap_or("."))?;
        let relative = Boundary {
            root: workdir,
            home: boundary.home.clone(),
            mode: mode.into(),
            private_paths: boundary.private_paths.clone(),
            protected_paths: boundary.protected_paths.clone(),
            allowed_write_paths: boundary.allowed_write_paths.clone(),
            denied_read_paths: boundary.denied_read_paths.clone(),
            denied_write_paths: boundary.denied_write_paths.clone(),
            reviewed_paths: boundary.reviewed_paths.clone(),
            restricted_read_paths: boundary.restricted_read_paths.clone(),
            restricted_write_paths: boundary.restricted_write_paths.clone(),
        };
        let mut simulated = BTreeMap::new();
        let mut expected = BTreeMap::new();
        let mut plans = Vec::new();
        let mut changes = Vec::new();
        let mut summaries = Vec::new();
        let mut diffs = Vec::new();
        for operation in operations {
            ensure!(!cancel.is_cancelled(), "The patch was interrupted.");
            let written = match &operation {
                Operation::Add(path, _)
                | Operation::Delete(path)
                | Operation::Update(path, _, _) => path,
            };
            let path = relative.resolve(written)?;
            let target =
                boundary.target(path.to_str().context("The file path is not UTF-8.")?, true)?;
            if !simulated.contains_key(&path) {
                let previous = if target.exists() {
                    Some(read_async(target.clone(), native::MAX_TEXT_BYTES, cancel).await?)
                } else {
                    None
                };
                let file = Simulated {
                    content: previous
                        .as_ref()
                        .map(|(bytes, _)| String::from_utf8_lossy(bytes).into_owned()),
                    metadata: previous.map(|(_, metadata)| metadata),
                };
                expected.insert(target.clone(), file.metadata.clone());
                simulated.insert(path.clone(), file);
            }
            match operation {
                Operation::Add(written, lines) => {
                    let file = simulated.get_mut(&path).unwrap();
                    ensure!(
                        file.content.is_none(),
                        "This patch adds a file that already exists: {}",
                        path.display()
                    );
                    let content = lines.join("\n");
                    diffs.push(diff::whole(&written, None, &content));
                    file.content = Some(content.clone());
                    plans.push(Planned::Write(target, path.clone(), content));
                    changes.push(json!({"kind":"add","path":path}));
                    summaries.push(format!("A {written}"));
                }
                Operation::Delete(written) => {
                    let entry =
                        boundary.entry(path.to_str().context("The file path is not UTF-8.")?)?;
                    if entry != target {
                        expected.insert(entry.clone(), Some(std::fs::symlink_metadata(&entry)?));
                    }
                    let file = simulated.get_mut(&path).unwrap();
                    let content = file
                        .content
                        .as_ref()
                        .context("This patch deletes a file that does not exist.")?;
                    if let Some(metadata) = &file.metadata {
                        self.assert_read(agent, &path, metadata).await?;
                    }
                    let mut presentation = diff::whole(&written, Some(content), "");
                    presentation["files"][0]["kind"] = json!("delete");
                    diffs.push(presentation);
                    file.content = None;
                    plans.push(Planned::Delete(entry));
                    changes.push(json!({"kind":"delete","path":path}));
                    summaries.push(format!("D {written}"));
                }
                Operation::Update(written, destination, hunks) => {
                    let file = simulated.get(&path).unwrap();
                    let content = file
                        .content
                        .as_ref()
                        .context("This patch updates a file that does not exist.")?;
                    let proven = hunks
                        .iter()
                        .all(|hunk| hunk.lines.iter().any(|(marker, _)| *marker != '+'));
                    if !proven && let Some(metadata) = &file.metadata {
                        self.assert_read(agent, &path, metadata).await?;
                    }
                    let old = content.clone();
                    let (updated, presentation) = apply(content, &hunks, &written)?;
                    ensure!(
                        updated.len() <= native::MAX_TEXT_BYTES,
                        "The patched file exceeds the text byte limit."
                    );
                    if let Some(destination) = destination {
                        let entry = boundary
                            .entry(path.to_str().context("The file path is not UTF-8.")?)?;
                        if entry != target {
                            expected
                                .insert(entry.clone(), Some(std::fs::symlink_metadata(&entry)?));
                        }
                        let moved = relative.resolve(&destination)?;
                        let moved_target = boundary
                            .target(moved.to_str().context("The file path is not UTF-8.")?, true)?;
                        ensure!(
                            moved_target != target,
                            "This patch moves {} onto itself.",
                            path.display()
                        );
                        if !simulated.contains_key(&moved) {
                            let previous = if moved_target.exists() {
                                Some(
                                    read_async(
                                        moved_target.clone(),
                                        native::MAX_TEXT_BYTES,
                                        cancel,
                                    )
                                    .await?,
                                )
                            } else {
                                None
                            };
                            let file = Simulated {
                                content: previous
                                    .as_ref()
                                    .map(|(bytes, _)| String::from_utf8_lossy(bytes).into_owned()),
                                metadata: previous.map(|(_, metadata)| metadata),
                            };
                            expected.insert(moved_target.clone(), file.metadata.clone());
                            simulated.insert(moved.clone(), file);
                        }
                        ensure!(
                            simulated[&moved].content.is_none(),
                            "This patch moves a file onto one that already exists: {}",
                            moved.display()
                        );
                        simulated.get_mut(&path).unwrap().content = None;
                        simulated.get_mut(&moved).unwrap().content = Some(updated.clone());
                        let mut removed = diff::whole(&written, Some(&old), "");
                        removed["files"][0]["kind"] = json!("delete");
                        diffs.push(removed);
                        diffs.push(diff::whole(&destination, None, &updated));
                        let moved_entry = boundary
                            .entry(moved.to_str().context("The file path is not UTF-8.")?)?;
                        let changed = updated != old;
                        plans.push(Planned::Move(entry, moved_entry, updated, changed));
                        changes.push(json!({"kind":"move","path":path,"moved_to":moved}));
                    } else {
                        ensure!(
                            updated != old,
                            "This update changes nothing in {}.",
                            path.display()
                        );
                        simulated.get_mut(&path).unwrap().content = Some(updated.clone());
                        diffs.push(presentation);
                        plans.push(Planned::Write(target, path.clone(), updated));
                        changes.push(json!({"kind":"update","path":path}));
                    }
                    summaries.push(format!("M {written}"));
                }
            }
        }
        // Every parse, path, context and freshness check completed before any
        // filesystem mutation. Actual commits also check captured identities.
        let mut reads = Vec::new();
        for plan in plans {
            ensure!(!cancel.is_cancelled(), "The patch was interrupted.");
            match plan {
                Planned::Write(path, written, content) => {
                    write_async(
                        path.clone(),
                        content.into_bytes(),
                        expected.get(&path).cloned().flatten(),
                        cancel,
                    )
                    .await?;
                    let metadata = native::open(&path)?.metadata()?;
                    expected.insert(path.clone(), Some(metadata.clone()));
                    reads.push(read_stamp(&written, &metadata)?);
                }
                Planned::Delete(path) => {
                    let metadata = expected
                        .get(&path)
                        .and_then(Option::as_ref)
                        .context("The deleted file is no longer available.")?;
                    native::remove(&path, metadata)?;
                    expected.insert(path, None);
                }
                Planned::Move(source, destination, content, changed) => {
                    let metadata = expected
                        .get(&source)
                        .and_then(Option::as_ref)
                        .context("The moved file is no longer available.")?;
                    native::move_file(&source, &destination, metadata)?;
                    expected.insert(source, None);
                    let target = boundary.target(
                        destination
                            .to_str()
                            .context("The file path is not UTF-8.")?,
                        true,
                    )?;
                    let mut metadata = native::open(&target)?.metadata()?;
                    if changed {
                        write_async(target.clone(), content.into_bytes(), Some(metadata), cancel)
                            .await?;
                        metadata = native::open(&target)?.metadata()?;
                    }
                    expected.insert(destination.clone(), Some(metadata.clone()));
                    reads.push(read_stamp(&destination, &metadata)?);
                }
            }
        }
        let summary = [
            vec!["Success. Updated the following files:".to_owned()],
            summaries,
        ]
        .concat()
        .join("\n");
        Ok(FileResult {
            value: json!({"changes":changes,"summary":summary,"presentation":combine(diffs)}),
            blocks: vec![Block::text(summary)],
            read: Some(json!(reads)),
        })
    }
}

fn directive(line: &str) -> Option<(&'static str, &str)> {
    for (kind, prefix) in [
        ("add", "*** Add File: "),
        ("delete", "*** Delete File: "),
        ("update", "*** Update File: "),
        ("move", "*** Move to: "),
    ] {
        if let Some(path) = line.strip_prefix(prefix) {
            return Some((kind, path));
        }
    }
    None
}
fn parse(patch: &str) -> Result<Vec<Operation>> {
    let normalized = patch.replace("\r\n", "\n");
    let lines = normalized.split('\n').collect::<Vec<_>>();
    ensure!(
        lines.first() == Some(&"*** Begin Patch"),
        "This patch is missing its `*** Begin Patch` first line."
    );
    ensure!(
        lines.contains(&"*** End Patch"),
        "This patch is missing its `*** End Patch` last line."
    );
    let mut operations = Vec::new();
    let mut index = 1;
    while index < lines.len() {
        let line = lines[index];
        if line == "*** End Patch" {
            ensure!(
                lines[index + 1..].iter().all(|line| line.trim().is_empty()),
                "This patch has content after its `*** End Patch` last line."
            );
            break;
        }
        let (kind, path) = directive(line).context("This is not a patch directive.")?;
        ensure!(kind != "move", "This is not a patch directive: {line}");
        index += 1;
        if kind == "add" {
            let mut body = Vec::new();
            while index < lines.len() && !lines[index].starts_with("*** ") {
                body.push(
                    lines[index]
                        .strip_prefix('+')
                        .with_context(|| {
                            format!("Every line of an added file must start with \"+\": {path}")
                        })?
                        .to_owned(),
                );
                index += 1;
            }
            operations.push(Operation::Add(path.into(), body));
            continue;
        }
        if kind == "delete" {
            operations.push(Operation::Delete(path.into()));
            continue;
        }
        let destination = lines
            .get(index)
            .and_then(|line| directive(line))
            .filter(|(kind, _)| *kind == "move")
            .map(|(_, path)| path.to_owned());
        if destination.is_some() {
            index += 1;
        }
        let mut hunks = Vec::new();
        while index < lines.len() && !lines[index].starts_with("*** ") {
            let header = lines[index];
            ensure!(
                header == "@@" || header.starts_with("@@ "),
                "An update hunk must begin with \"@@\": {path}"
            );
            let anchor = header.strip_prefix("@@ ").map(str::to_owned);
            index += 1;
            let mut body = Vec::new();
            while index < lines.len()
                && !lines[index].starts_with("@@")
                && !lines[index].starts_with("*** ")
            {
                let line = lines[index];
                let marker = line.chars().next().context(
                    "Every line of an update hunk must start with a space, \"-\", or \"+\".",
                )?;
                ensure!(
                    matches!(marker, ' ' | '-' | '+'),
                    "Every line of an update hunk must start with a space, \"-\", or \"+\": {path}"
                );
                body.push((marker, line[1..].to_owned()));
                index += 1;
            }
            let eof = lines.get(index) == Some(&"*** End of File");
            if eof {
                index += 1;
            }
            hunks.push(Hunk {
                anchor,
                eof,
                lines: body,
            });
        }
        ensure!(
            !hunks.is_empty(),
            "This update has no hunks, so it changes nothing: {path}"
        );
        operations.push(Operation::Update(path.into(), destination, hunks));
    }
    ensure!(!operations.is_empty(), "This patch changes no files.");
    Ok(operations)
}
fn apply(content: &str, hunks: &[Hunk], path: &str) -> Result<(String, Value)> {
    let eol = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let normalized = content.replace("\r\n", "\n");
    let final_newline = normalized.ends_with('\n');
    let mut lines = if normalized.is_empty() {
        Vec::new()
    } else {
        normalized
            .split('\n')
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    if final_newline {
        lines.pop();
    }
    let mut cursor = 0;
    let mut prior_delta = 0i64;
    let mut diffs = Vec::new();
    let mut added = 0;
    let mut deleted = 0;
    for hunk in hunks {
        let remove = hunk
            .lines
            .iter()
            .filter(|(marker, _)| *marker != '+')
            .map(|(_, text)| text.clone())
            .collect::<Vec<_>>();
        let add = hunk
            .lines
            .iter()
            .filter(|(marker, _)| *marker != '-')
            .map(|(_, text)| text.clone())
            .collect::<Vec<_>>();
        let search = if let Some(anchor) = &hunk.anchor {
            seek(&lines, std::slice::from_ref(anchor), cursor, false).with_context(|| {
                format!("This patch looks for {anchor:?} in {path}, and it is not there.")
            })? + 1
        } else {
            cursor
        };
        let at = if remove.is_empty() {
            lines.len()
        } else {
            seek(&lines, &remove, search, hunk.eof)
                .with_context(|| format!("This patch hunk does not match anything in {path}."))?
        };
        let rows = hunk
            .lines
            .iter()
            .map(|(marker, text)| {
                let kind = match marker {
                    '+' => {
                        added += 1;
                        "add"
                    }
                    '-' => {
                        deleted += 1;
                        "delete"
                    }
                    _ => "context",
                };
                json!({"kind":kind,"text":diff::truncate(text)})
            })
            .collect::<Vec<_>>();
        diffs.push(
            json!({"oldStart":(at as i64-prior_delta+1).max(1),"newStart":at+1,"lines":rows}),
        );
        lines.splice(at..at + remove.len(), add.clone());
        cursor = at + add.len();
        prior_delta += add.len() as i64 - remove.len() as i64;
    }
    let updated = if lines.is_empty() {
        String::new()
    } else {
        lines.join(eol) + if final_newline { eol } else { "" }
    };
    Ok((
        updated,
        json!({"type":"file_diff","files":[{"path":diff::truncate(path),"kind":"update","added":added,"deleted":deleted,"hunks":diffs}]}),
    ))
}
fn seek(lines: &[String], pattern: &[String], start: usize, eof: bool) -> Option<usize> {
    if pattern.len() > lines.len() {
        return None;
    }
    let last = lines.len() - pattern.len();
    let start = if eof { last } else { start };
    for normalization in 0..3 {
        for at in start..=last {
            if pattern
                .iter()
                .enumerate()
                .all(|(index, text)| match normalization {
                    1 => lines[at + index].trim_end() == text.trim_end(),
                    2 => lines[at + index].trim() == text.trim(),
                    _ => &lines[at + index] == text,
                })
            {
                return Some(at);
            }
        }
    }
    None
}
fn combine(presentations: Vec<Value>) -> Value {
    let mut files = Vec::new();
    let mut omitted_files = 0;
    let mut retained = 0;
    for presentation in presentations {
        for mut file in presentation["files"].as_array().unwrap().iter().cloned() {
            if files.len() >= 20 {
                omitted_files += 1;
                continue;
            }
            let mut omitted = file["omittedLines"].as_u64().unwrap_or(0);
            let mut hunks = Vec::new();
            for hunk in file["hunks"].as_array().unwrap() {
                let lines = hunk["lines"].as_array().unwrap();
                let available = 500usize.saturating_sub(retained);
                let shown = lines.iter().take(available).cloned().collect::<Vec<_>>();
                retained += shown.len();
                omitted += (lines.len() - shown.len()) as u64;
                if !shown.is_empty() {
                    let mut hunk = hunk.clone();
                    hunk["lines"] = json!(shown);
                    hunks.push(hunk);
                }
            }
            file["hunks"] = json!(hunks);
            if omitted > 0 {
                file["omittedLines"] = json!(omitted);
            }
            files.push(file);
        }
    }
    let mut result = json!({"type":"file_diff","files":files});
    if omitted_files > 0 {
        result["omittedFiles"] = json!(omitted_files);
    }
    result
}
