/// Native port of Source's BoundedOutputBuffer. Retention keeps a stable
/// beginning and ending; an incomplete UTF-8 suffix belongs to the next poll.
pub(super) struct BoundedOutput {
    maximum: usize,
    head: Vec<u8>,
    tail: Vec<u8>,
    pending: Vec<u8>,
    head_closed: bool,
    total: usize,
}
impl BoundedOutput {
    pub fn new(maximum: usize) -> Self {
        Self {
            maximum,
            head: Vec::new(),
            tail: Vec::new(),
            pending: Vec::new(),
            head_closed: false,
            total: 0,
        }
    }
    pub fn append(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.total = self.total.saturating_add(bytes.len());
        if self.maximum == 0 {
            return;
        }
        let mut combined = std::mem::take(&mut self.pending);
        combined.extend_from_slice(bytes);
        let pending = incomplete_suffix(&combined);
        let complete = combined.len() - pending;
        self.pending.extend_from_slice(&combined[complete..]);
        let combined = &combined[..complete];
        let budget = if self.head_closed {
            0
        } else {
            (self.maximum / 2).saturating_sub(self.head.len())
        };
        let mut prefix = combined.len().min(budget);
        if prefix < combined.len() {
            while prefix > 0 && continuation(combined[prefix]) {
                prefix -= 1;
            }
        }
        self.head.extend_from_slice(&combined[..prefix]);
        if prefix < combined.len() {
            self.head_closed = true;
        }
        let tail_budget = self.maximum - self.maximum / 2;
        self.tail.extend_from_slice(&combined[prefix..]);
        let mut discard = self.tail.len().saturating_sub(tail_budget);
        while discard < self.tail.len() && continuation(self.tail[discard]) {
            discard += 1;
        }
        self.tail.drain(..discard);
    }
    pub fn drain(&mut self) -> (String, usize) {
        let total = self.total.saturating_sub(self.pending.len());
        let omitted = total.saturating_sub(self.head.len() + self.tail.len());
        let head = std::mem::take(&mut self.head);
        let tail = std::mem::take(&mut self.tail);
        self.head_closed = false;
        self.total = self.pending.len();
        let bytes = if omitted == 0 {
            [head, tail].concat()
        } else {
            let mut parts = Vec::new();
            if !head.is_empty() {
                parts.push(head);
            }
            parts.push(format!("... {omitted} bytes omitted ...").into_bytes());
            if !tail.is_empty() {
                parts.push(tail);
            }
            let mut bytes = Vec::new();
            for (index, part) in parts.into_iter().enumerate() {
                if index > 0 {
                    bytes.push(b'\n');
                }
                bytes.extend(part);
            }
            bytes
        };
        (String::from_utf8_lossy(&bytes).into_owned(), omitted)
    }
}
fn continuation(byte: u8) -> bool {
    byte & 0xc0 == 0x80
}
fn incomplete_suffix(bytes: &[u8]) -> usize {
    let Some(mut lead) = bytes.len().checked_sub(1) else {
        return 0;
    };
    while continuation(bytes[lead]) {
        if lead == 0 {
            return 0;
        }
        lead -= 1;
    }
    let expected = match bytes[lead] {
        byte if byte & 0x80 == 0 => 1,
        byte if byte & 0xe0 == 0xc0 => 2,
        byte if byte & 0xf0 == 0xe0 => 3,
        byte if byte & 0xf8 == 0xf0 => 4,
        _ => 1,
    };
    let actual = bytes.len() - lead;
    if actual < expected { actual } else { 0 }
}
