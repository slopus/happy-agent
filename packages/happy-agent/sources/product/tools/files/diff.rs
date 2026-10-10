use serde_json::{Value, json};

fn lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines = normalized
        .split('\n')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if normalized.ends_with('\n') {
        lines.pop();
    }
    lines
}

pub(super) fn truncate(text: &str) -> String {
    text.chars().take(2_000).collect()
}

pub(super) fn whole(path: &str, previous: Option<&str>, next: &str) -> Value {
    if let Some(previous) = previous {
        return replacements(path, previous, &[(0, previous, next)]);
    }
    let added = lines(next);
    let shown = added
        .iter()
        .take(500)
        .map(|text| json!({"kind":"add","text":truncate(text)}))
        .collect::<Vec<_>>();
    let mut file = json!({"path":truncate(path),"kind":"add","added":added.len(),"deleted":0,"hunks":if shown.is_empty(){vec![]}else{vec![json!({"oldStart":0,"newStart":1,"lines":shown})]}});
    if added.len() > 500 {
        file["omittedLines"] = json!(added.len() - 500);
    }
    json!({"type":"file_diff","files":[file]})
}

pub(super) fn replacements(
    path: &str,
    content: &str,
    replacements: &[(usize, &str, &str)],
) -> Value {
    let mut added = 0;
    let mut deleted = 0;
    let mut omitted = 0;
    let mut retained = 0;
    let mut prior_delta: i64 = 0;
    let mut hunks = Vec::new();
    for (start, old, new) in replacements {
        let old_lines = lines(old);
        let new_lines = lines(new);
        added += new_lines.len();
        deleted += old_lines.len();
        let old_start = 1 + content[..*start]
            .replace("\r\n", "\n")
            .chars()
            .filter(|character| *character == '\n' || *character == '\r')
            .count();
        let mut shown = Vec::new();
        for (kind, lines) in [("delete", &old_lines), ("add", &new_lines)] {
            for text in lines {
                if retained < 500 {
                    shown.push(json!({"kind":kind,"text":truncate(text)}));
                    retained += 1;
                } else {
                    omitted += 1;
                }
            }
        }
        if !shown.is_empty() {
            hunks.push(
                json!({"oldStart":old_start,"newStart":old_start as i64+prior_delta,"lines":shown}),
            );
        }
        prior_delta += new_lines.len() as i64 - old_lines.len() as i64;
    }
    let mut file = json!({"path":truncate(path),"kind":"update","added":added,"deleted":deleted,"hunks":hunks});
    if omitted > 0 {
        file["omittedLines"] = json!(omitted);
    }
    json!({"type":"file_diff","files":[file]})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_counts_and_line_origins_survive_bounded_presentations() {
        let diff = replacements(
            "a.rs",
            "one\r\ntwo\r\nthree",
            &[(5, "two", "second\nextra"), (10, "three", "last")],
        );
        assert_eq!(diff["files"][0]["hunks"][0]["oldStart"], 2);
        assert_eq!(diff["files"][0]["hunks"][1]["oldStart"], 3);
        assert_eq!(diff["files"][0]["hunks"][1]["newStart"], 4);
        let bounded = whole("a.txt", None, &"a\n".repeat(700));
        assert_eq!(bounded["files"][0]["added"], 700);
        assert_eq!(bounded["files"][0]["omittedLines"], 200);
        assert_eq!(
            bounded["files"][0]["hunks"][0]["lines"]
                .as_array()
                .unwrap()
                .len(),
            500
        );
    }
}
