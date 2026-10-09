use rand::Rng;

const RANDOM_MASK: u128 = (1u128 << 74) - 1;
const LOW_MASK: u128 = (1u128 << 62) - 1;

/// The original UUIDv7 layout keeps its random tail and increments it within one
/// millisecond, including when the system clock moves backwards.
pub struct Versions {
    timestamp: Option<u64>,
    random: u128,
}
impl Versions {
    pub fn new() -> Self {
        Self {
            timestamp: None,
            random: 0,
        }
    }
    pub fn next(&mut self) -> String {
        self.next_at(now())
    }
    pub fn observe(&mut self, value: uuid::Uuid) {
        let value = value.as_u128();
        let timestamp = (value >> 80) as u64;
        let random = (((value >> 64) & 0xfff) << 62) | (value & LOW_MASK);
        if self.timestamp.is_none_or(|previous| timestamp > previous) {
            self.timestamp = Some(timestamp);
            self.random = random;
        } else if self.timestamp == Some(timestamp) {
            self.random = self.random.max(random);
        }
    }
    fn next_at(&mut self, now: u64) -> String {
        let mut timestamp = now.max(self.timestamp.unwrap_or(0));
        if self.timestamp == Some(timestamp) {
            self.random = (self.random + 1) & RANDOM_MASK;
            if self.random == 0 {
                timestamp += 1;
            }
        } else {
            self.random = rand::rng().random::<u128>() & RANDOM_MASK;
        }
        self.timestamp = Some(timestamp);
        let value = ((timestamp as u128) << 80)
            | (7u128 << 76)
            | ((self.random >> 62) << 64)
            | (2u128 << 62)
            | (self.random & LOW_MASK);
        uuid::Uuid::from_u128(value).to_string()
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

pub fn resource_version(timestamp: u64, version: u64, id: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(id.as_bytes());
    let tail = u32::from_be_bytes(hash[..4].try_into().expect("SHA-256 prefix")) & 0x1fffff;
    let random = ((version as u128 & ((1 << 53) - 1)) << 21) | tail as u128;
    let value = ((timestamp as u128 & 0xffffffffffff) << 80)
        | (7 << 76)
        | ((random >> 62) << 64)
        | (2 << 62)
        | (random & LOW_MASK);
    uuid::Uuid::from_u128(value).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_are_strictly_ordered_across_equal_and_backwards_clock_values() {
        let mut versions = Versions::new();
        let first = versions.next_at(1000);
        let second = versions.next_at(1000);
        let third = versions.next_at(999);
        let fourth = versions.next_at(1001);
        assert!(first < second && second < third && third < fourth);
        for value in [first, second, third, fourth] {
            assert_eq!(
                uuid::Uuid::parse_str(&value)
                    .expect("valid UUID")
                    .get_version_num(),
                7
            );
        }
    }
}
