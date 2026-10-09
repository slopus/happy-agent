mod entries;
mod evidence;
mod prompt;
mod transcript;
mod verdict;

#[cfg(test)]
fn goldens() -> serde_json::Value {
    serde_json::from_str(include_str!("../../tests/auto_goldens.json")).unwrap()
}
