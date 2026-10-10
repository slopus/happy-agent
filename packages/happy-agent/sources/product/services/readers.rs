//! Independent bounded cursors over an execution's existing output capture.
use super::execution::Execution;
use anyhow::{Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{Duration, Instant},
};

pub(super) struct Readers(Mutex<State>);
struct State {
    positions: BTreeMap<String, Reader>,
    retired: [u8; 8192],
}
struct Reader {
    position: (u64, u64),
    touched: Instant,
    reset: bool,
}

impl Readers {
    pub fn new() -> Self {
        Self(Mutex::new(State {
            positions: BTreeMap::new(),
            retired: [0; 8192],
        }))
    }
    pub fn reserve(&self, identity: &Value) -> Result<()> {
        self.with_reader(identity, |_| ()).map(|_| ())
    }
    pub fn read(
        &self,
        execution: &Execution,
        identity: &Value,
        max_bytes: usize,
    ) -> Result<(String, bool)> {
        ensure!(
            (1..=262144).contains(&max_bytes),
            "The service output byte limit is invalid."
        );
        self.with_reader(identity, |reader| {
            let delta = execution.read(reader.position);
            let produced = match (delta.stdout.is_empty(), delta.stderr.is_empty()) {
                (false, false) => format!("{}\n{}", delta.stdout, delta.stderr),
                (false, true) => delta.stdout,
                _ => delta.stderr,
            };
            let (output, bounded) = bound(&produced, max_bytes);
            let truncated = delta.truncated || reader.reset || bounded;
            reader.position = delta.position;
            reader.reset = false;
            (output, truncated)
        })
    }
    fn with_reader<T>(&self, identity: &Value, work: impl FnOnce(&mut Reader) -> T) -> Result<T> {
        let key = if identity["kind"] == "agent" {
            serde_json::json!(["agent", identity["agentId"]])
        } else {
            serde_json::json!(["api", identity["principalId"], identity["readerId"]])
        }
        .to_string();
        let now = Instant::now();
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let expired: Vec<_> = state
            .positions
            .iter()
            .filter(|(_, reader)| reader.touched + Duration::from_secs(1800) <= now)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            for bit in bits(&key) {
                state.retired[bit >> 3] |= 1 << (bit & 7);
            }
            state.positions.remove(&key);
        }
        if !state.positions.contains_key(&key) {
            ensure!(
                state.positions.len() < 64,
                "This service already has 64 active output readers."
            );
            let reset = bits(&key)
                .iter()
                .all(|bit| state.retired[bit >> 3] & (1 << (bit & 7)) != 0);
            state.positions.insert(
                key.clone(),
                Reader {
                    position: (0, 0),
                    touched: now,
                    reset,
                },
            );
        }
        let reader = state.positions.get_mut(&key).expect("reserved reader");
        reader.touched = now;
        Ok(work(reader))
    }
}
fn bits(key: &str) -> [usize; 4] {
    let digest = Sha256::digest(key.as_bytes());
    std::array::from_fn(|index| {
        u16::from_le_bytes([digest[index * 2], digest[index * 2 + 1]]) as usize
    })
}
fn bound(value: &str, maximum: usize) -> (String, bool) {
    if value.len() <= maximum {
        return (value.to_owned(), false);
    }
    let mut head = maximum.div_ceil(2);
    while !value.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = value.len() - (maximum - head);
    while !value.is_char_boundary(tail) {
        tail += 1;
    }
    (format!("{}{}", &value[..head], &value[tail..]), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_budget_keeps_both_ends_without_splitting_unicode() {
        let (value, truncated) = bound("🌿first 🌿last", 9);
        assert!(truncated);
        assert!(value.len() <= 9);
        assert!(value.starts_with('🌿'));
        assert!(value.ends_with("last"));
    }
    #[test]
    fn retired_reader_discloses_loss_without_unbounded_tombstones() {
        let readers = Readers::new();
        let identity = serde_json::json!({"kind":"agent","agentId":"serviceoutputfixture"});
        readers.reserve(&identity).unwrap();
        {
            let mut state = readers.0.lock().unwrap();
            state.positions.values_mut().next().unwrap().touched =
                Instant::now() - Duration::from_secs(1801);
        }
        assert!(
            readers
                .with_reader(&identity, |reader| reader.reset)
                .unwrap()
        );
        for number in 0..63 {
            readers.reserve(&serde_json::json!({"kind":"api","principalId":"alice","readerId":number.to_string()})).unwrap();
        }
        assert!(
            readers
                .reserve(
                    &serde_json::json!({"kind":"api","principalId":"alice","readerId":"overflow"})
                )
                .is_err()
        );
        assert_eq!(readers.0.lock().unwrap().positions.len(), 64);
    }
}
