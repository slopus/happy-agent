//! Source Live's UUIDv7 versions advance the millisecond when random tails regress.
use anyhow::Result;
use rand::Rng;
pub fn next(previous: Option<&str>) -> Result<String> {
    next_at(
        previous,
        crate::product::identity::now(),
        rand::rng().random::<u128>(),
    )
}
fn next_at(previous: Option<&str>, timestamp: u64, random: u128) -> Result<String> {
    let previous = previous
        .map(uuid::Uuid::parse_str)
        .transpose()?
        .map(|uuid| uuid.as_u128())
        .unwrap_or(0);
    let timestamp = (timestamp as u128).max(previous >> 80);
    let random = random & ((1u128 << 74) - 1);
    let mut value = (timestamp << 80)
        | (7 << 76)
        | ((random >> 62) << 64)
        | (2 << 62)
        | (random & ((1u128 << 62) - 1));
    if value <= previous {
        value = (((previous >> 80) + 1) << 80) | (value & ((1u128 << 80) - 1));
    }
    anyhow::ensure!(
        value >> 80 < 1u128 << 48,
        "The voice session version timestamp is exhausted."
    );
    Ok(uuid::Uuid::from_u128(value).to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_live_version_advances_future_clock_without_corrupting_reserved_bits() {
        let first = next_at(None, 2000, 100).unwrap();
        let next = next_at(Some(&first), 1, 0).unwrap();
        assert!(next > first);
        let uuid = uuid::Uuid::parse_str(&next).unwrap();
        assert_eq!(uuid.get_version_num(), 7);
        assert_eq!(uuid.get_variant(), uuid::Variant::RFC4122);
        assert_eq!(uuid.as_u128() >> 80, 2001);
    }
}
