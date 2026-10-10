use super::*;
use regex_lite::Regex;
use std::collections::{BTreeSet, VecDeque};

#[derive(Clone)]
struct IgnoreRule {
    directory: PathBuf,
    expression: Regex,
    negated: bool,
    directory_only: bool,
}
struct Walked {
    path: PathBuf,
    metadata: std::fs::Metadata,
}

impl Files {
    pub(in crate::product::tools) async fn discover(
        &self,
        configuration: &Value,
        mode: &str,
        vendor: &str,
        name: &str,
        args: &Value,
        cancel: &CancellationToken,
    ) -> Result<FileResult> {
        let boundary = self.boundary(configuration, mode)?;
        let requested = if name == "list_dir" {
            args["target_directory"].as_str().unwrap()
        } else {
            args["path"].as_str().unwrap_or(".")
        };
        let path = boundary.resolve(requested)?;
        let target = boundary.target(requested, false)?;
        let args = args.clone();
        let vendor = vendor.to_owned();
        let name = name.to_owned();
        let token = cancel.clone();
        let work = tokio::task::spawn_blocking(move || {
            ensure!(!token.is_cancelled(), "The file search was interrupted.");
            if name == "list_dir" {
                return list_directory(&boundary, path, target, &token);
            }
            let (mut files, walk_truncated) = walk(&boundary, &target, name != "Glob", &token)?;
            if name == "Glob" {
                let pattern = args["pattern"].as_str().unwrap();
                let pattern = if vendor == "kimi" && !pattern.contains('/') {
                    format!("**/{pattern}")
                } else {
                    pattern.to_owned()
                };
                let expression = glob(&pattern, true)?;
                files.retain(|file| expression.is_match(&relative(&target, &file.path)));
                files.sort_by(|left, right| {
                    right
                        .metadata
                        .modified()
                        .ok()
                        .cmp(&left.metadata.modified().ok())
                });
                if vendor == "kimi" {
                    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
                    let limit = match args["head_limit"].as_u64() {
                        Some(0) => 10_000,
                        Some(value) => value as usize,
                        None => 100,
                    };
                    let mut shown = Vec::new();
                    let mut characters = 0;
                    for file in files.iter().skip(offset).take(limit) {
                        let path = file.path.to_string_lossy().into_owned();
                        let units = path.encode_utf16().count() + 1;
                        if characters + units > 59_000 {
                            break;
                        }
                        characters += units;
                        shown.push(path);
                    }
                    let more = offset + shown.len() < files.len();
                    let next = offset + shown.len();
                    let mut texts = vec![if shown.is_empty() {
                        "No files found".into()
                    } else {
                        shown.join("\n")
                    }];
                    if more {
                        texts.push(format!(
                            "More collected matches remain. Next offset: {next}"
                        ));
                    }
                    if walk_truncated {
                        texts.push("The scan is incomplete. Narrow the pattern or directory to find uncollected files.".into());
                    }
                    let text = texts.join("\n");
                    let mut value =
                        json!({"text":text,"files":shown,"truncated":more||walk_truncated});
                    if more {
                        value["next_offset"] = json!(next);
                    }
                    return Ok(FileResult {
                        value,
                        blocks: vec![Block::text(text)],
                        read: None,
                    });
                }
                let truncated = walk_truncated || files.len() > 100;
                let shown = files
                    .iter()
                    .take(100)
                    .map(|file| file.path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                let text = if shown.is_empty() {
                    "No files found".into()
                } else {
                    [shown.join("\n"),if truncated{"(Results are truncated. Consider using a more specific path or pattern.)".into()}else{String::new()}].into_iter().filter(|part|!part.is_empty()).collect::<Vec<_>>().join("\n")
                };
                return Ok(FileResult {
                    value: json!({"text":text,"numFiles":shown.len(),"truncated":truncated}),
                    blocks: vec![Block::text(text)],
                    read: None,
                });
            }
            grep(&target, &vendor, &args, files, walk_truncated, &token)
        });
        tokio::select! {result=work=>result?,_=cancel.cancelled()=>anyhow::bail!("The file search was interrupted.")}
    }
}

fn list_directory(
    boundary: &Boundary,
    path: PathBuf,
    target: PathBuf,
    cancel: &CancellationToken,
) -> Result<FileResult> {
    ensure!(
        target.is_dir(),
        "This path is not a directory: {}",
        path.display()
    );
    let mut names = Vec::new();
    let mut counted = 0;
    let mut incomplete = false;
    for entry in std::fs::read_dir(target)? {
        ensure!(
            !cancel.is_cancelled(),
            "The directory listing was interrupted."
        );
        let entry = entry?;
        if !boundary.searchable(&entry.path()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        counted += 1;
        if counted > 20_000 {
            incomplete = true;
            break;
        }
        names.push((name, entry.file_type()?.is_dir()));
    }
    names.sort_by(|left, right| left.0.cmp(&right.0));
    let entries = names
        .iter()
        .take(500)
        .map(|(name, directory)| {
            if *directory {
                format!("{name}/")
            } else {
                name.clone()
            }
        })
        .collect::<Vec<_>>();
    let truncated = incomplete || counted > entries.len();
    let text = if entries.is_empty() {
        "(empty directory)".into()
    } else if truncated {
        format!(
            "{}\n... (showing {} of {counted} entries)",
            entries.join("\n"),
            entries.len()
        )
    } else {
        entries.join("\n")
    };
    Ok(FileResult {
        value: json!({"path":path,"entries":entries,"total_entries":counted,"truncated":truncated}),
        blocks: vec![Block::text(text)],
        read: None,
    })
}

fn walk(
    boundary: &Boundary,
    root: &Path,
    ignore: bool,
    cancel: &CancellationToken,
) -> Result<(Vec<Walked>, bool)> {
    if let Ok(metadata) = std::fs::metadata(root)
        && !metadata.is_dir()
    {
        return Ok((
            vec![Walked {
                path: root.to_owned(),
                metadata,
            }],
            false,
        ));
    }
    let initial = if ignore {
        initial_ignores(root)
    } else {
        Vec::new()
    };
    if initial.len() > 8192 {
        return Ok((Vec::new(), true));
    }
    let mut rules_seen = initial.len();
    let mut queue = VecDeque::from([(root.to_owned(), Arc::new(initial))]);
    let mut files = Vec::new();
    let mut visited = 0;
    let mut truncated = false;
    while let Some((directory, mut rules)) = queue.pop_front() {
        ensure!(!cancel.is_cancelled(), "The file search was interrupted.");
        let read = match std::fs::read_dir(&directory) {
            Ok(read) => read,
            Err(_) => {
                truncated = true;
                continue;
            }
        };
        let mut entries = Vec::new();
        for entry in read.take(20_001 - visited) {
            match entry {
                Ok(entry) => entries.push(entry),
                Err(_) => truncated = true,
            }
        }
        entries.sort_by_key(|entry| entry.file_name());
        if ignore && !rules.iter().any(|rule| rule.directory == directory) {
            let own = ignore_rules(&directory);
            if rules_seen + own.len() > 8192 {
                return Ok((files, true));
            }
            rules_seen += own.len();
            if !own.is_empty() {
                let mut inherited = (*rules).clone();
                inherited.extend(own);
                rules = Arc::new(inherited);
            }
        }
        for entry in entries {
            visited += 1;
            if visited > 20_000 {
                return Ok((files, true));
            }
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => {
                    truncated = true;
                    continue;
                }
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if !boundary.searchable(&path) {
                continue;
            }
            let ignored = ignore && ignored(&path, kind.is_dir(), &rules);
            if kind.is_dir() {
                if entry.file_name() != ".git" && !ignored {
                    queue.push_back((path, rules.clone()));
                }
            } else if !ignored {
                if files.len() >= 10_000 {
                    return Ok((files, true));
                }
                match entry.metadata() {
                    Ok(metadata) => files.push(Walked { path, metadata }),
                    Err(_) => truncated = true,
                }
            }
        }
    }
    Ok((files, truncated))
}
fn initial_ignores(root: &Path) -> Vec<IgnoreRule> {
    let mut directories = Vec::new();
    let mut current = root;
    loop {
        directories.push(current.to_owned());
        if current.join(".git").exists() {
            return directories
                .iter()
                .rev()
                .flat_map(|path| ignore_rules(path))
                .collect();
        }
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent;
    }
    ignore_rules(root)
}
fn ignore_rules(directory: &Path) -> Vec<IgnoreRule> {
    let Ok((bytes, _)) = native::read(&directory.join(".gitignore"), 128 * 1024) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    text.lines()
        .filter_map(|line| {
            let mut pattern = line.trim();
            if pattern.is_empty() || pattern.starts_with('#') {
                return None;
            }
            let negated = pattern.starts_with('!');
            if negated {
                pattern = &pattern[1..];
            }
            if pattern.starts_with("\\#") {
                pattern = &pattern[1..];
            }
            let directory_only = pattern.ends_with('/');
            if directory_only {
                pattern = &pattern[..pattern.len() - 1];
            }
            if pattern.is_empty() {
                return None;
            }
            let anchored = pattern.contains('/');
            if pattern.starts_with('/') {
                pattern = &pattern[1..];
            }
            let body = glob_body(pattern, false);
            let expression = Regex::new(&format!(
                "{}{}$",
                if anchored { "^" } else { "(?:^|/)" },
                body
            ))
            .ok()?;
            Some(IgnoreRule {
                directory: directory.to_owned(),
                expression,
                negated,
                directory_only,
            })
        })
        .take(4096)
        .collect()
}
fn ignored(path: &Path, directory: bool, rules: &[IgnoreRule]) -> bool {
    let mut ignored = false;
    for rule in rules {
        if path.starts_with(&rule.directory)
            && (!rule.directory_only || directory)
            && rule.expression.is_match(&relative(&rule.directory, path))
        {
            ignored = !rule.negated;
        }
    }
    ignored
}
fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
fn glob(pattern: &str, braces: bool) -> Result<Regex> {
    Ok(Regex::new(&format!("^{}$", glob_body(pattern, braces)))?)
}
fn glob_body(pattern: &str, braces: bool) -> String {
    let chars = pattern.chars().collect::<Vec<_>>();
    let mut index = 0;
    let mut body = String::new();
    while index < chars.len() {
        match chars[index] {
            '*' if chars.get(index + 1) == Some(&'*') => {
                if chars.get(index + 2) == Some(&'/') {
                    body.push_str("(?:[^/]*/)*");
                    index += 2;
                } else {
                    body.push_str(".*");
                    index += 1;
                }
            }
            '*' => body.push_str("[^/]*"),
            '?' => body.push_str("[^/]"),
            '{' if braces => {
                if let Some(end) = chars[index + 1..]
                    .iter()
                    .position(|character| *character == '}')
                {
                    let end = index + 1 + end;
                    let alternatives = chars[index + 1..end]
                        .iter()
                        .collect::<String>()
                        .split(',')
                        .map(regex_lite::escape)
                        .collect::<Vec<_>>()
                        .join("|");
                    body.push_str(&format!("(?:{alternatives})"));
                    index = end;
                } else {
                    body.push_str("\\{");
                }
            }
            character => body.push_str(&regex_lite::escape(&character.to_string())),
        }
        index += 1;
    }
    body
}

fn grep(
    root: &Path,
    vendor: &str,
    args: &Value,
    files: Vec<Walked>,
    walk_truncated: bool,
    cancel: &CancellationToken,
) -> Result<FileResult> {
    let pattern = args["pattern"].as_str().unwrap();
    let multiline = args["multiline"] == true;
    ensure!(
        !Regex::new(r"\([^()]*[+*{][^()]*\)[+*{]")?.is_match(pattern),
        "This regular expression may backtrack excessively. Simplify nested repetitions before searching."
    );
    let mut expression = super::regex_worker::Worker::new(
        pattern,
        args["-i"] == true,
        multiline,
        vendor == "kimi",
        cancel,
    )?;
    let filter = args["glob"]
        .as_str()
        .map(|pattern| {
            let pattern = if vendor == "kimi" && !pattern.contains('/') {
                format!("**/{pattern}")
            } else {
                pattern.to_owned()
            };
            glob(&pattern, true)
        })
        .transpose()?;
    let output_mode = if vendor == "grok" {
        "content"
    } else {
        args["output_mode"].as_str().unwrap_or("files_with_matches")
    };
    let context = args["context"]
        .as_f64()
        .or_else(|| args["-C"].as_f64())
        .unwrap_or(0.0)
        .max(0.0)
        .min(10_000.0) as usize;
    let before = if (vendor == "kimi" || vendor == "grok") && args.get("-C").is_some() {
        context
    } else {
        args["-B"]
            .as_f64()
            .unwrap_or(context as f64)
            .max(0.0)
            .min(10_000.0) as usize
    };
    let after = if (vendor == "kimi" || vendor == "grok") && args.get("-C").is_some() {
        context
    } else {
        args["-A"]
            .as_f64()
            .unwrap_or(context as f64)
            .max(0.0)
            .min(10_000.0) as usize
    };
    let numbers = args["-n"] != false;
    let mut budget = 4_000_000usize;
    let mut matched_files = 0;
    let mut match_count = 0;
    let mut raw = Vec::new();
    let mut truncated = walk_truncated;
    let mut content_files = 0;
    for file in files {
        ensure!(!cancel.is_cancelled(), "The file search was interrupted.");
        if filter
            .as_ref()
            .is_some_and(|filter| !filter.is_match(&relative(root, &file.path)))
            || !matches_type(&file.path, args["type"].as_str())
        {
            continue;
        }
        if file.metadata.len() > 1_000_000 {
            truncated = true;
            continue;
        }
        let bytes = match native::read(&file.path, 1_000_000) {
            Ok((bytes, _)) => bytes,
            Err(_) => {
                truncated = true;
                continue;
            }
        };
        let content = String::from_utf8_lossy(&bytes);
        if content.contains('\0') {
            continue;
        }
        let mut lines = content
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line))
            .collect::<Vec<_>>();
        if lines.last() == Some(&"") {
            lines.pop();
        }
        let scanned = expression.scan(&content, budget)?;
        let matches = scanned["matchingLineNumbers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_u64().unwrap() as usize)
            .collect::<Vec<_>>();
        let total = scanned["totalMatches"].as_u64().unwrap() as usize;
        budget = scanned["remainingBudget"].as_u64().unwrap() as usize;
        truncated |=
            scanned["incomplete"] == true || scanned["exhausted"] == true || total > 10_000;
        if total > 0 {
            matched_files += 1;
            match_count += total;
            let path = file.path.to_string_lossy();
            let mut entries = if output_mode == "files_with_matches" {
                vec![path.to_string()]
            } else if output_mode == "count" || output_mode == "count_matches" {
                vec![format!("{path}:{total}")]
            } else {
                let mut included = BTreeSet::new();
                let matching = matches.iter().copied().collect::<BTreeSet<_>>();
                for line in matches {
                    for index in line.saturating_sub(before)
                        ..=line
                            .saturating_add(after)
                            .min(lines.len().saturating_sub(1))
                    {
                        included.insert(index);
                    }
                }
                let mut entries = Vec::new();
                let mut previous = None;
                for index in included {
                    if previous.is_some_and(|previous| index > previous + 1) {
                        entries.push("--".into());
                    }
                    let line = lines[index];
                    let (shown, cut) = super::bound(line, 400);
                    let shown = if cut {
                        format!(
                            "{shown}… ({} more characters)",
                            line.encode_utf16().count() - shown.encode_utf16().count()
                        )
                    } else {
                        shown
                    };
                    let sep = if matching.contains(&index) { ":" } else { "-" };
                    entries.push(if numbers {
                        format!("{path}{sep}{}{sep} {shown}", index + 1)
                    } else {
                        format!("{path}{sep} {shown}")
                    });
                    previous = Some(index);
                }
                entries
            };
            if output_mode == "content" && content_files > 0 {
                entries.insert(0, "--".into());
            }
            if output_mode == "content" {
                content_files += 1;
            }
            for entry in entries {
                if raw.len() < 110_001 {
                    raw.push(entry);
                } else {
                    truncated = true;
                }
            }
        }
        if budget == 0 {
            truncated = true;
            break;
        }
    }
    let offset = args["offset"].as_f64().unwrap_or(0.0).clamp(0.0, 100_000.0) as usize;
    let requested = args["head_limit"].as_f64().unwrap_or(if vendor == "grok" {
        200.0
    } else if vendor == "kimi" {
        250.0
    } else {
        100.0
    });
    let limit = if requested <= 0.0 {
        10_000
    } else {
        requested.min(10_000.0) as usize
    };
    let shown = raw
        .iter()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    truncated |= offset + shown.len() < raw.len();
    let (text, cut) = super::super::surface::shell::bounded(&shown.join("\n"), 40_000, false);
    truncated |= cut;
    let text = if shown.is_empty() {
        "No matches found".into()
    } else {
        text
    };
    let text = if vendor == "kimi" && truncated {
        format!(
            "{text}\nSearch results are incomplete. Narrow the search or adjust offset and head_limit."
        )
    } else if vendor == "grok" && truncated && match_count > 0 {
        format!(
            "{text}\n[Capped. {match_count} matches in {matched_files} files were found in total; narrow the pattern or raise head_limit.]"
        )
    } else {
        text
    };
    Ok(FileResult {
        value: json!({"text":text,"matched_files":matched_files,"match_count":match_count,"truncated":truncated}),
        blocks: vec![Block::text(text)],
        read: None,
    })
}
fn matches_type(path: &Path, file_type: Option<&str>) -> bool {
    let Some(file_type) = file_type else {
        return true;
    };
    let normalized = file_type.trim_start_matches('.').to_ascii_lowercase();
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match normalized.as_str() {
        "js" => matches!(extension.as_str(), "js" | "jsx" | "mjs" | "cjs"),
        "ts" => matches!(extension.as_str(), "ts" | "tsx" | "mts" | "cts"),
        "rust" => extension == "rs",
        "py" => extension == "py",
        "sh" => matches!(extension.as_str(), "sh" | "bash"),
        "yaml" => matches!(extension.as_str(), "yaml" | "yml"),
        "md" => matches!(extension.as_str(), "md" | "markdown"),
        "html" => matches!(extension.as_str(), "html" | "htm"),
        other => extension == other,
    }
}
