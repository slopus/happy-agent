//! How MCP names become tool names and readable labels, how a call is disclosed for review, and
//! the identity one pooled connection is shared under.

use std::sync::LazyLock;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::text::{js_json_stringify, quote_visible_exact};

/// A display name in the stable identifier form tool names use. The original replaced UTF-16
/// code units, so a character outside the Basic Multilingual Plane becomes two underscores.
pub fn normalize_mcp_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for character in name.chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            out.push(character);
        } else {
            out.extend(std::iter::repeat_n('_', character.len_utf16()));
        }
    }
    out
}

/// One JavaScript regular expression with the `u` flag, as the original wrote it.
fn pattern(source: &str) -> regress::Regex {
    regress::Regex::with_flags(source, "u").unwrap_or_else(|error| panic!("The MCP name pattern {source} is invalid: {error}"))
}

/// `text.replace(pattern, replace)` with the global flag.
fn replace_all(pattern: &regress::Regex, text: &str, replace: impl Fn(&str, &regress::Match) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for found in pattern.find_iter(text) {
        let range = found.range();
        out.push_str(&text[last..range.start]);
        out.push_str(&replace(text, &found));
        last = range.end;
    }
    out.push_str(&text[last..]);
    out
}

fn group<'t>(text: &'t str, found: &regress::Match, index: usize) -> &'t str {
    found.group(index).map_or("", |range| &text[range])
}

/// A readable label: words split at case changes and separators, each starting with a capital,
/// with the brand spellings the original corrected.
pub fn humanize_mcp_name(value: &str) -> String {
    static CAMEL: LazyLock<regress::Regex> = LazyLock::new(|| pattern(r"([a-z0-9])([A-Z])"));
    static SEPARATORS: LazyLock<regress::Regex> = LazyLock::new(|| pattern(r"[_-]+"));
    static SPACES: LazyLock<regress::Regex> = LazyLock::new(|| pattern(r" +"));
    static EDGES: LazyLock<regress::Regex> = LazyLock::new(|| pattern(r"^ +| +$"));
    static WORD_START: LazyLock<regress::Regex> = LazyLock::new(|| pattern(r"(^|[^\p{L}\p{N}])(\p{L})"));
    static OPENAI: LazyLock<regress::Regex> = LazyLock::new(|| pattern(r"\bOpenai\b|\bOpen Ai\b"));
    static POSTHOG: LazyLock<regress::Regex> = LazyLock::new(|| pattern(r"\bPosthog\b|\bPost Hog\b"));
    let words = replace_all(&CAMEL, value, |text, found| format!("{} {}", group(text, found, 1), group(text, found, 2)));
    let words = replace_all(&SEPARATORS, &words, |_, _| " ".into());
    let words = replace_all(&SPACES, &words, |_, _| " ".into());
    let words = replace_all(&EDGES, &words, |_, _| String::new()).to_lowercase();
    if words.is_empty() {
        return "MCP".into();
    }
    let titled = replace_all(&WORD_START, &words, |text, found| format!("{}{}", group(text, found, 1), group(text, found, 2).to_uppercase()));
    let titled = replace_all(&OPENAI, &titled, |_, _| "OpenAI".into());
    replace_all(&POSTHOG, &titled, |_, _| "PostHog".into())
}

/// What an Auto reviewer is told one tool call does, including the boundary it crosses.
pub fn describe_mcp_call(arguments: &Value, server: &str, tool: &str) -> String {
    let serialized = if arguments.is_null() { "{}".to_string() } else { js_json_stringify(arguments) };
    format!(
        "calling {} from {} with arguments {}. Access: the MCP server can perform actions outside Happy Agent’s filesystem sandbox",
        quote_visible_exact(&humanize_mcp_name(tool)),
        quote_visible_exact(&humanize_mcp_name(server)),
        quote_visible_exact(&serialized)
    )
}

fn stable_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!("[{}]", items.iter().map(stable_json).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
            let body: Vec<String> =
                entries.into_iter().map(|(key, entry)| format!("{}:{}", js_json_stringify(&Value::String(key.clone())), stable_json(entry))).collect();
            format!("{{{}}}", body.join(","))
        }
        other => js_json_stringify(other),
    }
}

/// The identity of one reusable transport or process, independent of its catalog name, its
/// owner, and its tool policy.
pub fn connection_fingerprint(config: &Value) -> String {
    let mut connection = config.as_object().cloned().unwrap_or_default();
    for key in ["disabledTools", "enabled", "enabledTools"] {
        connection.shift_remove(key);
    }
    Sha256::digest(stable_json(&Value::Object(connection)).as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_read_the_way_the_original_wrote_them() {
        let golden: Value = serde_json::from_str(include_str!("goldens/humanize.json")).unwrap();
        for (name, expected) in golden.as_object().unwrap() {
            assert_eq!(humanize_mcp_name(name), expected.as_str().unwrap(), "{name}");
        }
        assert_eq!(normalize_mcp_name("Linear App"), "Linear_App");
        assert_eq!(normalize_mcp_name("a.b😀"), "a_b__");
    }

    #[test]
    fn identical_connections_share_one_fingerprint() {
        let golden: Value = serde_json::from_str(include_str!("goldens/fingerprints.json")).unwrap();
        let stdio = json!({"transport": "stdio", "command": "node", "args": ["server.js"], "env": {"B": "2", "A": "1"}, "enabled": true, "enabledTools": ["x"]});
        let http = json!({"transport": "http", "url": "https://example.com/mcp", "headers": {"X-Key": "v"}, "toolTimeoutMs": 5000});
        assert_eq!(golden["stdio"].as_str().unwrap(), connection_fingerprint(&stdio));
        assert_eq!(golden["http"].as_str().unwrap(), connection_fingerprint(&http));
    }
}
