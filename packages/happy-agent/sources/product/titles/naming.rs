//! The original tagged naming prompts and their bounded text grammar.
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

pub fn request(wanted: &Value, message: &str) -> (String, String) {
    let names = ["title", "slug"]
        .into_iter()
        .filter(|name| wanted[*name] == true)
        .collect::<Vec<_>>();
    let mut lines = vec!["You name a piece of work from its first user message.".to_owned()];
    for name in &names {
        lines.push(if *name=="title"{"The title is what the saved chat is called in a list a person reads."}else{"The slug names the folder the work happens in and the Git branch it happens on, which are the same name."}.to_owned());
    }
    lines.extend([
        String::new(),
        if names.len() == 1 {
            "Reply with exactly this tag and nothing else:"
        } else {
            "Reply with exactly these tags and nothing else:"
        }
        .to_owned(),
        String::new(),
    ]);
    for name in &names {
        lines.push(
            if *name == "title" {
                "<title>The name</title>"
            } else {
                "<slug>the-name</slug>"
            }
            .to_owned(),
        );
    }
    lines.push(String::new());
    for name in &names {
        lines.push(if *name=="title"{"<title>: two to six words naming what the work is about, the way a person writes a title. No quotes, no trailing punctuation, no markdown."}else{"<slug>: two to four words in lower-case kebab-case, letters and digits only, such as retry-policy-rewrite. No path, no prefix, no number, no file extension."}.to_owned());
    }
    lines.extend([
        String::new(),
        "Use only what you were given; do not guess at work you cannot see.".to_owned(),
    ]);
    (
        lines.join("\n"),
        format!("The first user message:\n{}", tail(message, 4000)),
    )
}
pub fn bot_request(message: &str) -> (String, String) {
    ("Name a persistent assistant from the function its first user message suggests it will perform.\nWrite a compact entity-like identity: one to three words that sound like a person, role, or\ncharacter rather than a task title. Prefer names such as Scout, Release Steward, Bug Hunter,\nor Archivist. Name the likely ongoing function, not the particular first task.\n\nReply with exactly this tag and nothing else:\n\n<title>The name</title>\n\nAt most three words and 40 characters. No quotes, punctuation, markdown, or generic words such as Bot or Assistant.\n\nUse only what you were given; do not guess at work you cannot see.".to_owned(),format!("The bot's first user message:\n{}",tail(message,4000)))
}
pub fn refine_request(transcript: &str, current: Option<&str>) -> (String, String) {
    ("You are looking at a saved chat that already has a title. Keep it exactly as it is\nunless the conversation makes it misleading, and only then write a better one.\n\nReply with exactly this tag and nothing else:\n\n<title>The name</title>\n\n<title>: two to six words naming what the work is about, the way a person writes a title. No quotes, no trailing punctuation, no markdown.\n\nUse only what you were given; do not guess at work you cannot see.".to_owned(),format!("Current title: {}\n\nThe conversation so far:\n{}",current.unwrap_or("(untitled)"),tail(transcript,12000)))
}
pub fn parse(text: &str, wanted: &Value) -> Value {
    let count = ["title", "slug"]
        .into_iter()
        .filter(|name| wanted[*name] == true)
        .count();
    let fallback = if count == 1 {
        Some(strip_fences(text))
    } else {
        None
    };
    let mut names = json!({});
    for name in ["title", "slug"] {
        if wanted[name] != true {
            continue;
        }
        let expression = regex_lite::Regex::new(&format!("(?i)<{name}>([\\s\\S]*?)</{name}>"))
            .expect("The fixed naming tag is valid.");
        let tagged = expression
            .captures(text)
            .and_then(|captures| captures.get(1));
        let text = tagged
            .as_ref()
            .map(|matched| matched.as_str())
            .or(fallback.as_deref())
            .unwrap_or("");
        let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let normalized = if name == "title" {
            title(&normalized)
        } else {
            slug(&normalized)
        };
        if !normalized.is_empty() {
            names[name] = json!(normalized);
        }
    }
    names
}
fn strip_fences(text: &str) -> String {
    let expression =
        regex_lite::Regex::new("(?i)```[a-z]*\\n?").expect("The fixed fence expression is valid.");
    expression.replace_all(text, "").replace("```", "")
}
fn title(text: &str) -> String {
    let text = text
        .trim_start_matches('#')
        .trim_start()
        .trim_start_matches(['\"', '\'', '`'])
        .trim_end_matches(|character: char| {
            ['\"', '\'', '`', '.', '!', '?', ':', ';', ','].contains(&character)
                || character.is_whitespace()
        });
    let text = text
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join(" ");
    if text.encode_utf16().count() <= 80 {
        text
    } else {
        format!("{}…", prefix(&text, 79).trim_end())
    }
}
fn slug(text: &str) -> String {
    let mut output = String::new();
    let mut separating = false;
    for character in text.nfkd().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            if separating && !output.is_empty() {
                output.push('-');
            }
            output.push(character);
            separating = false;
        } else {
            separating = true;
        }
    }
    output.truncate(output.len().min(48));
    output.trim_end_matches('-').to_owned()
}
pub fn prefix(text: &str, maximum: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= maximum
        })
        .collect()
}
pub fn tail(text: &str, maximum: usize) -> String {
    let text = text.replace('\r', "");
    let text = text.trim();
    if text.encode_utf16().count() <= maximum {
        text.to_owned()
    } else {
        let mut units = 0;
        let mut result = text
            .chars()
            .rev()
            .take_while(|character| {
                units += character.len_utf16();
                units <= maximum
            })
            .collect::<Vec<_>>();
        result.reverse();
        format!("…{}", result.into_iter().collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tagged_and_untagged_names_follow_the_original_limits() {
        assert_eq!(
            parse(
                "Greeting <TITLE>\"Repair retry handling!\"</TITLE>\n<slug>Café/Retry Handling</slug> end",
                &json!({"title":true,"slug":true})
            ),
            json!({"title":"Repair retry handling","slug":"cafe-retry-handling"})
        );
        assert_eq!(
            parse("```text\nRelease Steward\n```", &json!({"title":true})),
            json!({"title":"Release Steward"})
        );
        assert_eq!(
            parse(
                "Ambiguous untagged answer",
                &json!({"title":true,"slug":true})
            ),
            json!({})
        );
        assert_eq!(
            parse("résumé editor", &json!({"slug":true})),
            json!({"slug":"re-sume-editor"})
        );
        assert_eq!(
            parse("one two three four five six seven", &json!({"title":true}))["title"],
            "one two three four five six"
        );
        assert_eq!(tail("begin\r\nfinal request", 7), "…request");
    }
}
