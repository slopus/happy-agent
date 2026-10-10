//! The shipped metadata loader's YAML subset, including its scalar folding.
use super::*;
use regex_lite::Regex;
type Strings = BTreeMap<String, String>;
fn trim(value: &str) -> &str {
    value.trim_matches(space)
}
fn space(value: char) -> bool {
    matches!(
        value,
        '\t' | '\n' | '\u{000b}' | '\u{000c}' | '\r' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
fn indentation(line: &str) -> usize {
    line.chars().take_while(|value| space(*value)).count()
}
fn after_indent(line: &str, count: usize) -> &str {
    &line[line
        .char_indices()
        .nth(count)
        .map(|(index, _)| index)
        .unwrap_or(line.len())..]
}
fn marker(line: &str) -> bool {
    line.strip_prefix("---").is_some_and(|rest| {
        let rest = rest.trim_start_matches([' ', '\t']);
        rest.is_empty() || rest.starts_with('#')
    })
}
pub fn parse(content: &str, directory: &str, schemas: &Schemas) -> Result<(Value, String)> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let lines = normalized.split('\n').collect::<Vec<_>>();
    let closing = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| marker(line.trim_start_matches([' ', '\t'])))
        .map(|(index, _)| index);
    if lines.first().is_none_or(|line| !marker(line)) || closing.is_none() {
        return Ok((json!({"name":directory,"description":""}), String::new()));
    }
    let closing = closing.unwrap();
    let (values, booleans) = yaml_map(&lines[1..closing])?;
    let mut metadata = json!({"name":values.get("name").map(String::as_str).unwrap_or(directory),"description":values.get("description").map(String::as_str).unwrap_or("")});
    if booleans.get("disable-model-invocation") == Some(&true) {
        metadata["disableModelInvocation"] = json!(true);
    }
    anyhow::ensure!(
        schemas.valid("ownerSkillMetadata", &metadata)?,
        "Skill frontmatter metadata is invalid."
    );
    Ok((metadata, lines[closing + 1..].join("\n")))
}
fn yaml_map(lines: &[&str]) -> Result<(Strings, BTreeMap<String, bool>)> {
    let mut values = Strings::new();
    let mut booleans = BTreeMap::new();
    let mut anchors = Strings::new();
    let joined = lines.join("\n");
    let source = trim(&joined);
    if source.starts_with('{') {
        anyhow::ensure!(
            source.ends_with('}'),
            "Skill frontmatter flow map is incomplete."
        );
        for item in split_top(&source[1..source.len() - 1], ',')? {
            if trim(item).is_empty() {
                continue;
            }
            let (key, raw) =
                mapping_line(item)?.context("Skill frontmatter flow entry is invalid.")?;
            set_scalar(&key, raw, &mut values, &mut booleans, &mut anchors)?;
        }
        return Ok((values, booleans));
    }
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let indent = indentation(line);
        if trim(line).is_empty()
            || after_indent(line, indent).starts_with(['#', '%'])
            || trim(line) == "..."
            || indent > 0
        {
            index += 1;
            continue;
        }
        let (key, raw) = mapping_line(line)?.context("Skill frontmatter mapping is invalid.")?;
        if key == "<<" && trim(raw).starts_with('*') {
            index += 1;
            continue;
        }
        if block_scalar(raw) {
            let (value, next) = read_block(lines, index + 1, indent, raw);
            values.insert(key, value);
            index = next;
            continue;
        }
        if trim(raw).is_empty() {
            index += 1;
            while index < lines.len()
                && (trim(lines[index]).is_empty() || indentation(lines[index]) > indent)
            {
                index += 1;
            }
            continue;
        }
        let (value, next) = read_plain(lines, index, indent, raw);
        set_scalar(&key, &value, &mut values, &mut booleans, &mut anchors)?;
        index = next;
    }
    Ok((values, booleans))
}
fn set_scalar(
    key: &str,
    raw: &str,
    values: &mut Strings,
    booleans: &mut BTreeMap<String, bool>,
    anchors: &mut Strings,
) -> Result<()> {
    if let Some(value) = scalar(raw, anchors)? {
        values.insert(key.to_owned(), value);
        booleans.remove(key);
    } else {
        let plain = comment(raw);
        let plain = trim(plain).to_ascii_lowercase();
        if matches!(plain.as_str(), "true" | "false") {
            booleans.insert(key.to_owned(), plain == "true");
            values.remove(key);
        }
    }
    Ok(())
}
fn scalar(raw: &str, anchors: &mut Strings) -> Result<Option<String>> {
    let value = trim(comment(raw));
    if value.is_empty() {
        return Ok(None);
    }
    static ANCHOR: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    if let Some(anchor) = ANCHOR
        .get_or_init(|| Regex::new(r"^&([A-Za-z0-9_-]+)(?:[ \t]+|$)([\s\S]*)$").unwrap())
        .captures(value)
    {
        let parsed = scalar(trim(&anchor[2]), anchors)?;
        if let Some(parsed) = &parsed {
            anchors.insert(anchor[1].to_owned(), parsed.clone());
        }
        return Ok(parsed);
    }
    if let Some(alias) = value.strip_prefix('*') {
        return Ok(anchors.get(trim(alias)).cloned());
    }
    if value.starts_with(['{', '[']) {
        return Ok(None);
    }
    if quoted(value) {
        return Ok(Some(decode_quoted(value)?));
    }
    if non_string(value) {
        return Ok(None);
    }
    Ok(Some(value.to_owned()))
}
fn non_string(value: &str) -> bool {
    if matches!(
        value.to_ascii_lowercase().as_str(),
        "true" | "false" | "null" | "~"
    ) {
        return true;
    }
    static NUMERIC: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    NUMERIC.get_or_init(||Regex::new(r"(?i)^(?:[-+]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]*)?(?:e[-+]?[0-9]+)?|0x[0-9a-f_]+|0o[0-7_]+|0b[01_]+)$").unwrap()).is_match(value)
}
fn quoted(value: &str) -> bool {
    (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''))
}
fn decode_quoted(value: &str) -> Result<String> {
    if value.starts_with('\'') {
        return Ok(if value.len() < 2 {
            String::new()
        } else {
            value[1..value.len() - 1].replace("''", "'")
        });
    }
    serde_json::from_str(value)
        .map_err(|_| anyhow::anyhow!("Skill frontmatter quoted scalar is invalid."))
}
fn decode_key(value: &str) -> Result<String> {
    if quoted(value) {
        decode_quoted(value)
    } else {
        Ok(trim(comment(value)).to_owned())
    }
}
fn mapping_line(line: &str) -> Result<Option<(String, &str)>> {
    let characters = line.char_indices().collect::<Vec<_>>();
    let mut quote = None;
    let mut depth = 0_i32;
    let mut index = 0;
    while index < characters.len() {
        let (offset, value) = characters[index];
        let previous = index.checked_sub(1).map(|index| characters[index].1);
        if let Some(current) = quote {
            if current == '\''
                && value == '\''
                && characters
                    .get(index + 1)
                    .is_some_and(|(_, value)| *value == '\'')
            {
                index += 1;
            } else if value == current && previous != Some('\\') {
                quote = None;
            }
            index += 1;
            continue;
        }
        match value {
            '"' | '\'' => quote = Some(value),
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            ':' if depth == 0 => {
                let key = decode_key(trim(&line[..offset]))?;
                if key.is_empty() {
                    return Ok(None);
                }
                return Ok(Some((key, &line[offset + 1..])));
            }
            _ => {}
        }
        index += 1;
    }
    Ok(None)
}
fn comment(value: &str) -> &str {
    let characters = value.char_indices().collect::<Vec<_>>();
    let mut quote = None;
    let mut depth = 0_i32;
    let mut index = 0;
    while index < characters.len() {
        let (offset, value_at) = characters[index];
        let previous = index.checked_sub(1).map(|index| characters[index].1);
        if let Some(current) = quote {
            if current == '\''
                && value_at == '\''
                && characters
                    .get(index + 1)
                    .is_some_and(|(_, value)| *value == '\'')
            {
                index += 1;
            } else if value_at == current && previous != Some('\\') {
                quote = None;
            }
            index += 1;
            continue;
        }
        match value_at {
            '"' | '\'' => quote = Some(value_at),
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            '#' if depth == 0 && previous.is_none_or(space) => return &value[..offset],
            _ => {}
        }
        index += 1;
    }
    value
}
fn split_top(source: &str, separator: char) -> Result<Vec<&str>> {
    let characters = source.char_indices().collect::<Vec<_>>();
    let mut quote = None;
    let mut depth = 0_i32;
    let mut index = 0;
    let mut start = 0;
    let mut items = Vec::new();
    while index < characters.len() {
        let (offset, value) = characters[index];
        let previous = index.checked_sub(1).map(|index| characters[index].1);
        if let Some(current) = quote {
            if current == '\''
                && value == '\''
                && characters
                    .get(index + 1)
                    .is_some_and(|(_, value)| *value == '\'')
            {
                index += 1;
            } else if value == current && previous != Some('\\') {
                quote = None;
            }
            index += 1;
            continue;
        }
        match value {
            '"' | '\'' => quote = Some(value),
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            _ if value == separator && depth == 0 => {
                items.push(&source[start..offset]);
                start = offset + value.len_utf8();
            }
            _ => {}
        }
        index += 1;
    }
    anyhow::ensure!(
        quote.is_none() && depth == 0,
        "Skill frontmatter flow scalar is incomplete."
    );
    items.push(&source[start..]);
    Ok(items)
}
fn read_plain(lines: &[&str], index: usize, indent: usize, raw: &str) -> (String, usize) {
    let mut parts = vec![trim(comment(raw))];
    let mut next = index + 1;
    while next < lines.len() {
        let line = lines[next];
        if trim(line).is_empty() {
            parts.push("");
            next += 1;
            continue;
        }
        let current = indentation(line);
        if current <= indent {
            break;
        }
        if after_indent(line, current).starts_with('#') {
            next += 1;
            continue;
        }
        parts.push(trim(comment(trim(line))));
        next += 1;
    }
    let mut value = String::new();
    for line in parts {
        if value.is_empty() {
            value.push_str(line);
        } else if line.is_empty() || value.ends_with('\n') {
            value.push('\n');
            value.push_str(line);
        } else {
            value.push(' ');
            value.push_str(line);
        }
    }
    (trim(&value).to_owned(), next)
}
fn block_scalar(value: &str) -> bool {
    static BLOCK: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    BLOCK
        .get_or_init(|| {
            Regex::new(r"^[ \t]*[|>](?:[+-]|[1-9]|[1-9][+-]|[+-][1-9])?[ \t]*(?:#.*)?$").unwrap()
        })
        .is_match(value)
}
fn read_block(lines: &[&str], start: usize, parent: usize, indicator: &str) -> (String, usize) {
    let indicator = indicator.trim_start_matches([' ', '\t']);
    let folded = indicator.starts_with('>');
    let modifiers = indicator[1..]
        .chars()
        .take_while(|value| matches!(value, '+' | '-' | '1'..='9'))
        .collect::<String>();
    let mut content_indent = modifiers
        .chars()
        .find_map(|value| value.to_digit(10))
        .map(|value| parent + value as usize);
    let mut body = Vec::new();
    let mut next = start;
    while next < lines.len() {
        let line = lines[next];
        if trim(line).is_empty() {
            body.push("");
            next += 1;
            continue;
        }
        let indent = indentation(line);
        if indent <= parent {
            break;
        }
        let wanted = *content_indent.get_or_insert(indent);
        if indent < wanted {
            break;
        }
        body.push(after_indent(line, wanted));
        next += 1;
    }
    if body.is_empty() {
        return (String::new(), next);
    }
    let mut value = if folded {
        let mut value = String::new();
        for (index, line) in body.iter().enumerate() {
            value.push_str(line);
            value.push(
                if !line.is_empty() && body.get(index + 1).is_some_and(|next| !next.is_empty()) {
                    ' '
                } else {
                    '\n'
                },
            );
        }
        value
    } else {
        body.join("\n")
    };
    if modifiers.contains('-') {
        value = value.trim_end_matches('\n').to_owned();
    } else if !modifiers.contains('+') {
        value = format!("{}\n", value.trim_end_matches('\n'));
    }
    (value, next)
}
