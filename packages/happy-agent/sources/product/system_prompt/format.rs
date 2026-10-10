use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

pub(super) const SPEC: &str = include_str!("agents-md-spec.txt");
pub(super) const REPLACEMENT: &str =
    "These AGENTS.md instructions replace all previously provided AGENTS.md instructions.";
pub(super) const REMOVAL: &str = "The previously provided AGENTS.md instructions no longer apply.";
pub(super) const TRUNCATION: &str = "[Some AGENTS.md instruction content was omitted or truncated to stay within the instruction limit.]";
const DOCUMENT_TRUNCATION: &str =
    "[This AGENTS.md document was truncated to stay within the instruction limit.]";
const OUTPUT_TRUNCATION: &str =
    "[Some AGENTS.md instruction content was omitted to stay within the system prompt byte limit.]";
pub(super) const OMITTED: &str = "[The contents of this AGENTS.md document were omitted because it exceeded the instruction limit.]";

pub(super) fn trim(text: &str) -> &str {
    text.trim_matches(|value: char| {
        value == '\u{feff}'
            || matches!(
                value,
                '\t' | '\n'
                    | '\u{000b}'
                    | '\u{000c}'
                    | '\r'
                    | ' '
                    | '\u{00a0}'
                    | '\u{1680}'
                    | '\u{2000}'
                    ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
            )
    })
}
pub(super) fn decode(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
}
pub(super) fn prefix(text: &str, maximum: usize) -> &str {
    let mut end = maximum.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
fn character_prefix(text: &str, maximum: usize) -> String {
    // Source slices UTF-16 units. A boundary inside a pair is subsequently encoded as U+FFFD.
    String::from_utf16_lossy(&text.encode_utf16().take(maximum).collect::<Vec<_>>())
}
fn join(sections: &[String], maximum: usize) -> String {
    let mut result = String::new();
    let mut count = 0;
    for section in sections {
        let separator = if result.is_empty() { "" } else { "\n\n" };
        let length = section.encode_utf16().count();
        if count + separator.len() + length <= maximum {
            result.push_str(separator);
            result.push_str(section);
            count += separator.len() + length;
            continue;
        }
        let Some(available) = maximum
            .checked_sub(count + separator.len())
            .filter(|available| *available > 0)
        else {
            break;
        };
        result.push_str(separator);
        if available <= TRUNCATION.len() {
            result.push_str(&character_prefix(TRUNCATION, available));
        } else {
            result.push_str(&character_prefix(section, available - TRUNCATION.len()));
            result.push_str(TRUNCATION);
        }
        break;
    }
    result
}
fn document(heading: String, tag: &str, doc: &Value) -> String {
    format!(
        "{heading}\n\n<{tag}>\n{}{}\n</{tag}>",
        doc["text"].as_str().unwrap(),
        if doc["truncated"] == true {
            format!("\n\n{DOCUMENT_TRUNCATION}")
        } else {
            String::new()
        }
    )
}
fn directory(doc: &Value) -> String {
    Path::new(doc["path"].as_str().unwrap())
        .parent()
        .unwrap_or(Path::new("."))
        .display()
        .to_string()
}
pub(super) fn body(snapshot: Option<&Value>) -> String {
    let Some(snapshot) = snapshot else {
        return String::new();
    };
    let mut sections = Vec::new();
    if let Some(global) = snapshot.get("global") {
        sections.push(document(
            "# Global AGENTS.md instructions".to_owned(),
            "INSTRUCTIONS",
            global,
        ));
    }
    if let Some(security) = snapshot.get("security") {
        sections.push(document(
            format!("# AGENTS_SECURITY.md rules for {}", directory(security)),
            "SECURITY_RULES",
            security,
        ));
    }
    for doc in snapshot["documents"].as_array().unwrap() {
        sections.push(document(
            format!("# AGENTS.md instructions for {}", directory(doc)),
            "INSTRUCTIONS",
            doc,
        ));
    }
    if snapshot["truncated"] == true {
        sections.push(TRUNCATION.to_owned());
    }
    join(&sections, 300_000 - SPEC.encode_utf16().count() - 2)
}
pub(super) fn instructions(snapshot: Option<&Value>) -> String {
    let body = body(snapshot);
    if body.is_empty() {
        SPEC.to_owned()
    } else {
        join(&[SPEC.to_owned(), body], 300_000)
    }
}
pub(super) fn fingerprint(text: &str) -> Value {
    if text.is_empty() {
        Value::Null
    } else {
        Value::String(format!("{:x}", Sha256::digest(text.as_bytes())))
    }
}
pub(super) fn fit_instructions(value: &str, maximum: isize) -> String {
    if maximum <= 0 {
        return String::new();
    }
    let maximum = maximum as usize;
    if value.len() <= maximum {
        return value.to_owned();
    }
    let suffix = format!("\n\n{OUTPUT_TRUNCATION}");
    if suffix.len() >= maximum {
        prefix(OUTPUT_TRUNCATION, maximum).to_owned()
    } else {
        format!("{}{}", prefix(value, maximum - suffix.len()), suffix)
    }
}
pub(super) fn models(models: &[Value]) -> String {
    if models.is_empty() {
        return String::new();
    }
    let mut lines = vec!["## Available models".to_owned()];
    lines.extend(models.iter().map(|model| {
        format!(
            "- {} — model ID: `{}`; provider ID: `{}`",
            model["name"].as_str().unwrap(),
            model["id"].as_str().unwrap(),
            model["providerId"].as_str().unwrap()
        )
    }));
    lines.join("\n")
}
pub(super) fn environment(input: &Value) -> String {
    let environment = &input["environment"];
    let windows = environment["platform"] == "win32";
    let shell = if windows {
        "Windows PowerShell 5.1 (powershell.exe)"
    } else {
        trim(environment["shell"].as_str().unwrap())
    };
    let mut lines = vec![
        "# Environment".to_owned(),
        format!(
            "- Primary working directory: {}",
            environment["workingDirectory"].as_str().unwrap()
        ),
        format!("- Platform: {}", environment["platform"].as_str().unwrap()),
    ];
    if !shell.is_empty() {
        lines.push(format!("- Shell: {shell}"));
    }
    lines.push(format!(
        "- OS version: {}",
        environment["osVersion"].as_str().unwrap()
    ));
    if windows {
        lines.extend([
        "- Commands run on native Windows in PowerShell. Use native Windows tools and paths. Bash is available only in a Linux environment such as WSL, not in this native Windows session; do not use Git Bash.",
        "- Use PowerShell syntax: $env:NAME = 'value' for environment variables; & 'C:\\Program Files\\tool.exe' for a quoted executable; -LiteralPath for file operations. Separate commands with newlines. PowerShell 5.1 does not support &&, ||, export, or Bash heredocs. Check $LASTEXITCODE after native programs before continuing dependent work.",
        "- Start background helpers with Start-Process -WindowStyle Hidden unless the user needs a visible window. Keep filesystem operations in one shell and verify the resolved target before recursive deletion or moving files.",
    ].map(str::to_owned));
    }
    let models = input["availableModels"].as_array().unwrap();
    if let Some(model) = input["currentModel"].as_str() {
        let route = models
            .iter()
            .find(|entry| entry["id"] == model && entry["providerId"] == input["currentProvider"])
            .or_else(|| models.iter().find(|entry| entry["id"] == model));
        lines.push(match route {
            Some(entry) => format!(
                "- Current model: {} (`{model}`)",
                entry["name"].as_str().unwrap()
            ),
            None => format!("- Current model: `{model}`"),
        });
    }
    lines.extend([
        format!("- Current provider: `{}`", input["currentProvider"].as_str().unwrap()),
        format!("- Happy Agent documentation: {}", input["documentationPath"].as_str().unwrap()),
        format!("- Happy design system: When the user asks for a temporary page unrelated to their work, or asks to use the Happy design system, read and follow {}.", input["designSystemPath"].as_str().unwrap()),
        "- Scratch directory: `.context/` in the working directory. Strongly prefer it for temporary files, throwaway scripts, and notes or instructions for other agents; keep it gitignored (add the entry if missing) unless there is a real reason not to, and never commit it.".to_owned(),
        "- By default the user sees only the last message you send before stopping; earlier messages are collapsed. Include all essential information in that last message.".to_owned(),
        "- When the project is a Git folder, a workspace and a worktree are the same thing: creating a workspace creates a new worktree, and deleting a workspace archives it.".to_owned(),
    ]);
    if !models.is_empty() {
        lines.push(String::new());
        lines.push(self::models(models));
    }
    lines.join("\n")
}
