mod capture;
mod entries;
mod evidence;
mod prompt;
mod routes;
mod transcript;
mod verdict;

#[cfg(test)]
fn goldens() -> serde_json::Value {
    serde_json::from_str(include_str!("../../tests/auto_goldens.json")).unwrap()
}

#[cfg(test)]
fn runtime_goldens() -> serde_json::Value {
    serde_json::from_str(include_str!("../../tests/auto_runtime_goldens.json")).unwrap()
}
