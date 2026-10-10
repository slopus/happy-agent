//! Original decimal-fraction ordering has no subtask-specific maximum length.
use anyhow::Result;
pub fn between(before: Option<&str>, after: Option<&str>) -> Result<String> {
    let lower = before.unwrap_or("");
    anyhow::ensure!(
        after.is_none_or(|after| lower < after),
        "Subtask order keys are out of order."
    );
    let mut prefix = String::new();
    let mut index = 0;
    loop {
        let low = lower.as_bytes().get(index).map_or(0, |digit| digit - b'0');
        let high = after
            .and_then(|after| after.as_bytes().get(index))
            .map_or(10, |digit| digit - b'0');
        if high > low + 1 {
            prefix.push(char::from(b'0' + low + (high - low) / 2));
            return Ok(prefix);
        }
        if high == low + 1 {
            prefix.push(char::from(b'0' + low));
            for digit in lower
                .as_bytes()
                .get(index + 1..)
                .unwrap_or_default()
                .iter()
                .copied()
                .chain(std::iter::once(b'0'))
            {
                if digit < b'9' {
                    prefix.push(char::from(digit + (b':' - digit) / 2));
                    return Ok(prefix);
                }
                prefix.push('9');
            }
        }
        prefix.push(char::from(b'0' + low));
        index += 1;
    }
}
