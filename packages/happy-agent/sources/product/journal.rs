use super::identity::{Versions, now};
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::Arc};
use tokio::sync::broadcast;

const CAPACITY: usize = 10_000;
const MAX_BYTES: usize = 64 * 1024 * 1024;

pub struct Entry {
    pub envelope: Value,
    pub owner: Option<String>,
    bytes: usize,
}
impl Entry {
    pub fn cursor(&self) -> &str {
        self.envelope["cursor"].as_str().unwrap_or("")
    }
    pub fn visible_to(&self, user: Option<&str>) -> bool {
        if let Some(owner) = self.owner.as_deref() {
            return Some(owner) == user;
        }
        !["happy.integration.updated", "agent.draft.updated"]
            .contains(&self.envelope["type"].as_str().unwrap_or(""))
            || user.is_none()
    }
}

pub struct Journal {
    versions: Versions,
    origin: String,
    entries: VecDeque<Arc<Entry>>,
    bytes: usize,
    sender: broadcast::Sender<Arc<Entry>>,
}
impl Journal {
    pub fn new() -> Self {
        let mut versions = Versions::new();
        let origin = versions.next();
        Self {
            versions,
            origin,
            entries: VecDeque::new(),
            bytes: 0,
            sender: broadcast::channel(256).0,
        }
    }
    pub fn cursor(&self) -> &str {
        self.entries
            .back()
            .map_or(self.origin.as_str(), |entry| entry.cursor())
    }
    pub fn append(&mut self, kind: &str, payload: Value, owner: Option<String>) -> Arc<Entry> {
        let envelope =
            json!({"cursor":self.versions.next(),"occurredAt":now(),"type":kind,"payload":payload});
        let bytes = envelope.to_string().len();
        let entry = Arc::new(Entry {
            envelope,
            owner,
            bytes,
        });
        self.entries.push_back(entry.clone());
        self.bytes += bytes;
        while self.entries.len() > CAPACITY || self.bytes > MAX_BYTES && self.entries.len() > 1 {
            if let Some(removed) = self.entries.pop_front() {
                self.bytes -= removed.bytes;
                self.origin = removed.cursor().to_owned();
            }
        }
        let _ = self.sender.send(entry.clone());
        entry
    }
    pub fn replay(
        &self,
        after: Option<&str>,
        until: Option<&str>,
        limit: usize,
        user: Option<&str>,
    ) -> Option<Value> {
        let start = self.position(after, 0)?;
        let end = self.position(until, self.entries.len())?;
        let scanned = self
            .entries
            .iter()
            .skip(start)
            .take(end.saturating_sub(start).min(limit))
            .collect::<Vec<_>>();
        let cursor = scanned
            .last()
            .map_or_else(|| after.unwrap_or(&self.origin), |entry| entry.cursor());
        Some(
            json!({"cursor":cursor,"latestCursor":self.cursor(),"events":scanned.iter().filter(|entry|entry.visible_to(user)).map(|entry|entry.envelope.clone()).collect::<Vec<_>>()}),
        )
    }
    fn position(&self, cursor: Option<&str>, default: usize) -> Option<usize> {
        match cursor {
            None => Some(default),
            Some(cursor) if cursor == self.origin => Some(0),
            Some(cursor) => self
                .entries
                .iter()
                .position(|entry| entry.cursor() == cursor)
                .map(|index| index + 1),
        }
    }
    pub fn subscribe(
        &self,
        after: Option<&str>,
    ) -> (
        String,
        bool,
        VecDeque<Arc<Entry>>,
        broadcast::Receiver<Arc<Entry>>,
    ) {
        let receiver = self.sender.subscribe();
        let position = self.position(after, self.entries.len());
        let replay = if let Some(position) = position {
            self.entries.iter().skip(position).cloned().collect()
        } else {
            VecDeque::new()
        };
        (
            self.cursor().to_owned(),
            position.is_none(),
            replay,
            receiver,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_retention_keeps_last_evicted_cursor_and_pagination_advances_over_private_events() {
        let mut journal = Journal::new();
        let initial = journal.cursor().to_owned();
        let first = journal
            .append("config.updated", json!({}), None)
            .cursor()
            .to_owned();
        for _ in 0..CAPACITY {
            journal.append("config.updated", json!({}), None);
        }
        assert!(journal.replay(Some(&initial), None, 100, None).is_none());
        assert!(journal.replay(Some(&first), None, 100, None).is_some());
        assert_eq!(journal.entries.len(), CAPACITY);
        let before = journal.cursor().to_owned();
        journal.append(
            "agent.draft.updated",
            json!({"private":"alice"}),
            Some("alice".into()),
        );
        let hidden = journal
            .replay(Some(&before), None, 1, Some("bob"))
            .expect("page");
        assert_eq!(hidden["events"], json!([]));
        assert_ne!(hidden["cursor"], before);
    }
}
