use crate::product::schemas::Schemas;
use anyhow::Result;
use serde_json::json;
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

pub fn name(value: &str) -> Result<String> {
    let name = value.trim();
    anyhow::ensure!(
        Schemas::new()?.valid("ownerProjectDisplayNameGuard", &json!(name))?,
        "The name cannot be empty or contain control characters."
    );
    anyhow::ensure!(
        name.chars().count() <= 100,
        "The name cannot be longer than 100 characters."
    );
    Ok(name.to_owned())
}
pub fn base_ref(value: Option<&str>) -> Result<Option<String>> {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    if let Some(value) = value {
        anyhow::ensure!(
            Schemas::new()?.valid("ownerProjectBaseRefGuard", &json!(value))?,
            "The workspace base reference is invalid."
        );
    }
    Ok(value.map(str::to_owned))
}
pub fn storage_key(name: &str) -> String {
    let mut result = String::new();
    let mut separator = false;
    for character in name
        .nfkd()
        .filter(|character| !is_combining_mark(*character))
        .flat_map(char::to_lowercase)
    {
        if character.is_ascii_alphanumeric() {
            if separator && !result.is_empty() {
                result.push('-');
            }
            result.push(character);
            separator = false;
        } else {
            separator = true;
        }
    }
    result.truncate(result.len().min(48));
    let result = result.trim_end_matches('-');
    if result.is_empty() {
        "project".to_owned()
    } else {
        result.to_owned()
    }
}
