use anyhow::Result;
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

pub fn name_key(value: &str) -> String {
    value.nfkc().collect::<String>().to_lowercase()
}
pub fn storage_key(value: &str) -> String {
    let transliterated = value
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            match character {
                'а' => "a",
                'б' => "b",
                'в' => "v",
                'г' => "g",
                'д' => "d",
                'е' => "e",
                'ё' => "yo",
                'ж' => "zh",
                'з' => "z",
                'и' => "i",
                'й' => "y",
                'к' => "k",
                'л' => "l",
                'м' => "m",
                'н' => "n",
                'о' => "o",
                'п' => "p",
                'р' => "r",
                'с' => "s",
                'т' => "t",
                'у' => "u",
                'ф' => "f",
                'х' => "h",
                'ц' => "ts",
                'ч' => "ch",
                'ш' => "sh",
                'щ' => "sch",
                'ъ' | 'ь' => "",
                'ы' => "y",
                'э' => "e",
                'ю' => "yu",
                'я' => "ya",
                _ => return character.to_string(),
            }
            .to_owned()
        })
        .collect::<String>();
    let mut result = String::new();
    let mut separator = false;
    for character in transliterated
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
        "workspace".to_owned()
    } else {
        result.to_owned()
    }
}
pub fn between(before: Option<&str>, after: Option<&str>) -> Result<String> {
    let lower = before.unwrap_or("");
    anyhow::ensure!(
        after.is_none_or(|after| lower < after),
        "Workspace order keys are out of order."
    );
    let mut prefix = String::new();
    for index in 0..64 {
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
                    anyhow::ensure!(
                        prefix.len() <= 64,
                        "Workspace order key space is exhausted."
                    );
                    return Ok(prefix);
                }
                prefix.push('9');
            }
        }
        prefix.push(char::from(b'0' + low));
    }
    anyhow::bail!("Workspace order key space is exhausted.")
}
pub fn unique(
    base: &str,
    maximum: usize,
    human: bool,
    taken: impl Fn(&str) -> bool,
) -> Result<String> {
    if !taken(base) {
        return Ok(base.to_owned());
    }
    for count in 2..=1_000_000 {
        let suffix = if human {
            format!(" ({count})")
        } else {
            format!("-{count}")
        };
        let room = maximum - suffix.len();
        let mut units = 0;
        let stem = base
            .chars()
            .take_while(|character| {
                units += character.len_utf16();
                units <= room
            })
            .collect::<String>();
        let stem = if human {
            stem.as_str()
        } else {
            stem.trim_end_matches('-')
        };
        let candidate = format!("{stem}{suffix}");
        if !taken(&candidate) {
            return Ok(candidate);
        }
    }
    anyhow::bail!("No available workspace name was found.")
}
