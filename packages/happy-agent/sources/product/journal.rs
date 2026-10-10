use super::identity::{Versions, now};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
};
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
        self.append_with_cursor(kind, |_| payload, owner)
    }
    pub fn agent_cursor(&self, id: &str) -> &str {
        self.entries
            .iter()
            .rev()
            .find(|entry| {
                entry.envelope["payload"]["agentId"] == id
                    || entry.envelope["payload"]["agent"]["id"] == id
            })
            .map_or_else(|| self.cursor(), |entry| entry.cursor())
    }
    pub fn append_with_cursor(
        &mut self,
        kind: &str,
        payload: impl FnOnce(&str) -> Value,
        owner: Option<String>,
    ) -> Arc<Entry> {
        self.append_with_cursor_at(kind, payload, owner, now())
    }
    pub fn append_at(
        &mut self,
        kind: &str,
        payload: Value,
        owner: Option<String>,
        occurred_at: u64,
    ) -> Arc<Entry> {
        self.append_with_cursor_at(kind, |_| payload, owner, occurred_at)
    }
    pub fn append_subtask_update(
        &mut self,
        mut payload: Value,
        mut subtasks: Vec<Value>,
        occurred_at: u64,
    ) -> Arc<Entry> {
        let cursor = self.versions.next();
        // Cursors have a fixed encoded size. Measure with this frame's fallback before making
        // room, then choose each child's cursor from the history that will remain afterwards.
        stamp_subtask_cursors(&mut subtasks, &BTreeMap::new(), &cursor);
        payload["changes"]["subtasks"] = json!(subtasks);
        let mut envelope = json!({"cursor":cursor,"occurredAt":occurred_at,"type":"agent.updated","payload":payload});
        let bytes = envelope.to_string().len();
        self.retain_for_append(bytes);
        // Child updates from the same commit have already appended. This temporary index is
        // bounded by journal retention and belongs only to this publication.
        let mut cursors = BTreeMap::new();
        for entry in &self.entries {
            for id in [
                entry.envelope["payload"]["agentId"].as_str(),
                entry.envelope["payload"]["agent"]["id"].as_str(),
            ]
            .into_iter()
            .flatten()
            {
                cursors.insert(id.to_owned(), entry.cursor().to_owned());
            }
        }
        stamp_subtask_cursors(
            envelope["payload"]["changes"]["subtasks"]
                .as_array_mut()
                .expect("TypeBox-validated public subtask tree"),
            &cursors,
            &cursor,
        );
        debug_assert_eq!(envelope.to_string().len(), bytes);
        self.publish_entry(envelope, None, bytes)
    }
    fn append_with_cursor_at(
        &mut self,
        kind: &str,
        payload: impl FnOnce(&str) -> Value,
        owner: Option<String>,
        occurred_at: u64,
    ) -> Arc<Entry> {
        let cursor = self.versions.next();
        let payload = payload(&cursor);
        let envelope =
            json!({"cursor":cursor,"occurredAt":occurred_at,"type":kind,"payload":payload});
        let bytes = envelope.to_string().len();
        self.retain_for_append(bytes);
        self.publish_entry(envelope, owner, bytes)
    }
    fn retain_for_append(&mut self, bytes: usize) {
        while !self.entries.is_empty()
            && (self.entries.len() >= CAPACITY || self.bytes + bytes > MAX_BYTES)
        {
            if let Some(removed) = self.entries.pop_front() {
                self.bytes -= removed.bytes;
                self.origin = removed.cursor().to_owned();
            }
        }
    }
    fn publish_entry(
        &mut self,
        envelope: Value,
        owner: Option<String>,
        bytes: usize,
    ) -> Arc<Entry> {
        let entry = Arc::new(Entry {
            envelope,
            owner,
            bytes,
        });
        self.entries.push_back(entry.clone());
        self.bytes += bytes;
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

fn stamp_subtask_cursors(
    subtasks: &mut [Value],
    cursors: &BTreeMap<String, String>,
    fallback: &str,
) {
    for subtask in subtasks {
        let id = subtask["id"]
            .as_str()
            .expect("TypeBox-validated public agent identity");
        subtask["lastCursor"] = json!(cursors.get(id).map_or(fallback, String::as_str));
        if let Some(nested) = subtask.get_mut("subtasks") {
            stamp_subtask_cursors(
                nested
                    .as_array_mut()
                    .expect("TypeBox-validated optional public subtask tree"),
                cursors,
                fallback,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subtask_update_uses_the_retained_cursor_after_its_own_append_evicts_child_history() {
        let mut journal = Journal::new();
        journal.append("agent.updated", json!({"agentId": "child"}), None);
        for _ in 1..CAPACITY {
            journal.append("config.updated", json!({}), None);
        }
        let update = journal.append_subtask_update(
            json!({"agentId": "parent", "changes": {}}),
            vec![json!({"id": "child", "lastCursor": journal.agent_cursor("child")})],
            42,
        );
        assert_eq!(
            update.envelope["payload"]["changes"]["subtasks"][0]["lastCursor"],
            journal.agent_cursor("child"),
            "the published subtree and following snapshot must agree after retention"
        );
        assert_eq!(journal.entries.len(), CAPACITY);
    }

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
