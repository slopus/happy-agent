//! JavaScript string semantics the original product's observable text depends on.
//!
//! Lengths and slice offsets in the original are UTF-16 code units, and `trim` strips the
//! ECMAScript whitespace set. Output a model or client reads must cut and count the same way.
//! A cut that would split a surrogate pair moves back to the character boundary, because a Rust
//! string cannot hold half a character.
use serde_json::{Map, Value};

/// `string.length`: UTF-16 code units.
pub fn js_length(value: &str) -> usize {
    value.encode_utf16().count()
}

/// The byte offset of a UTF-16 offset, clamped to the string and rounded down to a character.
pub fn js_byte_offset(value: &str, units: usize) -> usize {
    let mut seen = 0;
    for (offset, character) in value.char_indices() {
        let width = character.len_utf16();
        if seen + width > units {
            return offset;
        }
        seen += width;
    }
    value.len()
}

/// `string.slice(start, end)` for non-negative UTF-16 offsets.
pub fn js_slice(value: &str, start: usize, end: usize) -> &str {
    let start = js_byte_offset(value, start);
    let end = js_byte_offset(value, end).max(start);
    &value[start..end]
}

/// Whether ECMAScript's `trim` removes this character.
pub fn js_is_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `string.trim()`.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(js_is_whitespace)
}

/// `string.trimEnd()`.
pub fn js_trim_end(value: &str) -> &str {
    value.trim_end_matches(js_is_whitespace)
}

/// A number as `JSON.stringify` writes it: whole values carry no fraction.
pub fn js_json_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return Value::from(value as i64);
    }
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// JavaScript's `Number.prototype.toString()`.
pub fn js_number(number: f64) -> String {
    if number.is_nan() {
        return "NaN".into();
    }
    if number.is_infinite() {
        return if number > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if number == 0.0 {
        return "0".into();
    }
    let magnitude = number.abs();
    if (1e-6..1e21).contains(&magnitude) {
        if number.fract() == 0.0 && magnitude < 9.007_199_254_740_992e15 {
            return format!("{}", number as i64);
        }
        return format!("{number}");
    }
    // Exponential form: shortest round-trip digits with a signed exponent.
    let formatted = format!("{number:e}");
    let (mantissa, exponent) = formatted.split_once('e').unwrap_or((&formatted, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let sign = if exponent < 0 { "-" } else { "+" };
    format!("{mantissa}e{sign}{}", exponent.abs())
}

/// `String(value)` for a JSON value, the way a template literal interpolates it.
pub fn js_display(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number
            .as_i64()
            .map(|integer| integer.to_string())
            .unwrap_or_else(|| js_number(number.as_f64().unwrap_or(0.0))),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".into(),
        Value::Array(items) => items.iter().map(js_display).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// Whether JavaScript treats an object key as an array index: the canonical decimal form of an
/// integer from 0 through 2^32 - 2. Such keys enumerate before every other key.
fn js_is_array_index(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) || (bytes[0] == b'0' && bytes.len() > 1) {
        return false;
    }
    key.parse::<u64>().is_ok_and(|index| index < u64::from(u32::MAX))
}

/// An object's entries in JavaScript enumeration order: array-index keys first in ascending
/// numeric order, then every other key in insertion order.
fn js_object_entries(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u64, (&String, &Value))> = Vec::new();
    let mut named = Vec::with_capacity(map.len());
    for (key, value) in map {
        if js_is_array_index(key) {
            indexed.push((key.parse().unwrap_or_default(), (key, value)));
        } else {
            named.push((key, value));
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    indexed.into_iter().map(|(_, entry)| entry).chain(named).collect()
}

/// `JSON.stringify(value)` for a JSON value: numbers are written the way JavaScript writes them,
/// so a whole float has no fraction and large magnitudes use JavaScript's exponent form, and object
/// keys enumerate the way JavaScript enumerates them.
pub fn js_json_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_js_json(value, &mut out);
    out
}

fn write_js_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                out.push_str(&number.to_string());
            } else {
                out.push_str(&js_number(number.as_f64().unwrap_or(0.0)));
            }
        }
        Value::String(text) => out.push_str(&serde_json::to_string(text).unwrap_or_default()),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_js_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in js_object_entries(map).into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                write_js_json(item, out);
            }
            out.push('}');
        }
    }
}

/// Quote untrusted text while making terminal and bidi controls visible to an approval reviewer.
pub fn quote_visible_exact(value: &str) -> String {
    let mut visible = String::with_capacity(value.len() + 2);
    visible.push('"');
    for character in value.chars() {
        let code = character as u32;
        match character {
            '\\' => visible.push_str("\\\\"),
            '"' => visible.push_str("\\\""),
            '\n' => visible.push_str("\\n"),
            '\r' => visible.push_str("\\r"),
            '\t' => visible.push_str("\\t"),
            _ if code < 0x20 || code == 0x7f || (0x202a..=0x202e).contains(&code) || (0x2066..=0x2069).contains(&code) => {
                visible.push_str(&format!("\\u{{{code:04x}}}"));
            }
            _ => visible.push(character),
        }
    }
    visible.push('"');
    visible
}

/// The ICU root collation's ordering of the ASCII punctuation and symbols, which all sort before
/// digits and letters.
const COLLATION_PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// `left.localeCompare(right)` as the original's default ICU collation orders ordinary names:
/// whitespace, then punctuation in ICU's order, then digits, then letters alphabetically without
/// regard to case or accents; ties then go to the unaccented and to the lowercase spelling.
pub fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    fn base(character: char) -> (char, u32) {
        // Strip the accents Latin-1 and Latin Extended-A letters commonly carry.
        const FOLDS: &[(&str, char)] = &[
            ("àáâãäåāăą", 'a'), ("çćĉċč", 'c'), ("ďđ", 'd'), ("èéêëēĕėęě", 'e'), ("ĝğġģ", 'g'), ("ĥħ", 'h'),
            ("ìíîïĩīĭįı", 'i'), ("ĵ", 'j'), ("ķ", 'k'), ("ĺļľŀł", 'l'), ("ñńņňŉ", 'n'), ("òóôõöøōŏő", 'o'),
            ("ŕŗř", 'r'), ("śŝşš", 's'), ("ţťŧ", 't'), ("ùúûüũūŭůűų", 'u'), ("ŵ", 'w'), ("ýÿŷ", 'y'), ("źżž", 'z'),
        ];
        let lower = character.to_lowercase().next().unwrap_or(character);
        for (index, (accented, plain)) in FOLDS.iter().enumerate() {
            if let Some(position) = accented.chars().position(|candidate| candidate == lower) {
                return (*plain, (index as u32 + 1) * 32 + position as u32 + 1);
            }
        }
        (lower, 0)
    }
    fn primary(character: char) -> (u8, u32) {
        if character.is_whitespace() {
            return (0, character as u32);
        }
        if let Some(index) = COLLATION_PUNCTUATION.chars().position(|candidate| candidate == character) {
            return (1, index as u32);
        }
        if character.is_ascii_digit() {
            return (2, character as u32);
        }
        let (plain, _) = base(character);
        if plain.is_alphabetic() {
            return (3, plain as u32);
        }
        (if character.is_ascii() { 1 } else { 4 }, character as u32 + 64)
    }
    let primaries = |text: &str| text.chars().map(primary).collect::<Vec<_>>();
    let accents = |text: &str| text.chars().map(|character| base(character).1).collect::<Vec<_>>();
    let cases = |text: &str| text.chars().map(|character| u8::from(character.is_uppercase())).collect::<Vec<_>>();
    primaries(left)
        .cmp(&primaries(right))
        .then_with(|| accents(left).cmp(&accents(right)))
        .then_with(|| cases(left).cmp(&cases(right)))
        .then_with(|| left.cmp(right))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_cuts_in_utf16_units() {
        assert_eq!(js_length("a😀b"), 4);
        assert_eq!(js_slice("a😀b", 0, 3), "a😀");
        assert_eq!(js_slice("a😀b", 0, 2), "a");
        assert_eq!(js_slice("abc", 2, 10), "c");
    }

    #[test]
    fn quotes_controls_visibly() {
        assert_eq!(quote_visible_exact("a\"b\\c\nd\u{202e}\u{1b}"), "\"a\\\"b\\\\c\\nd\\u{202e}\\u{001b}\"");
    }

    #[test]
    fn stringifies_numbers_and_keys_like_javascript() {
        let value: Value = serde_json::from_str(r#"{"a":1.0,"b":2.5,"c":[1e21,-0.0000001],"d":"é\n"}"#).unwrap();
        assert_eq!(js_json_stringify(&value), r#"{"a":1,"b":2.5,"c":[1e+21,-1e-7],"d":"é\n"}"#);
        let value: Value =
            serde_json::from_str(r#"{"b":1,"10":2,"4294967295":3,"2":4,"01":5,"4294967294":6,"a":{"z":0,"1":true,"0":false},"-1":7,"":8}"#).unwrap();
        assert_eq!(
            js_json_stringify(&value),
            r#"{"2":4,"10":2,"4294967294":6,"b":1,"4294967295":3,"01":5,"a":{"0":false,"1":true,"z":0},"-1":7,"":8}"#
        );
        assert_eq!(js_display(&serde_json::json!([1, "a", null, 2.5])), "1,a,null,2.5");
    }

    #[test]
    fn collates_names_the_way_icu_orders_them() {
        let mut names = vec!["beta", "Alpha", "alpha", "a_b", "a-b", "ab", "a1", "Zed", "éclair", "eclair", "a"];
        names.sort_by(|left, right| locale_compare(left, right));
        assert_eq!(names, ["a", "a_b", "a-b", "a1", "ab", "alpha", "Alpha", "beta", "eclair", "éclair", "Zed"]);
    }

    #[test]
    fn trims_the_ecmascript_whitespace_set() {
        assert_eq!(js_trim("\u{FEFF} x \u{0085}"), "x \u{0085}");
        assert_eq!(js_trim_end("x\u{3000}\t"), "x");
    }
}
