//! Bounded native counterpart of node:util.parseEnv and the Source file guard.
use super::*;
use std::{fs::OpenOptions, io::Read, path::Path};
const MAX_BYTES: u64 = 1_048_576;
pub(super) fn read(path: &str, schemas: &Schemas) -> Result<Value> {
    ensure!(
        schemas.valid("secretDotenvFile", &json!(path))? && Path::new(path).is_absolute(),
        "A secret dotenv source must be an absolute file path."
    );
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| anyhow::anyhow!("Could not open the secret dotenv file."))?;
    let facts = file.metadata().map_err(|_| {
        anyhow::anyhow!("The secret dotenv source must be a regular file no larger than 1 MiB.")
    })?;
    ensure!(
        facts.is_file() && facts.len() <= MAX_BYTES,
        "The secret dotenv source must be a regular file no larger than 1 MiB."
    );
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            anyhow::anyhow!("The secret dotenv source must be a regular file no larger than 1 MiB.")
        })?;
    ensure!(
        bytes.len() <= MAX_BYTES as usize,
        "The secret dotenv source must be a regular file no larger than 1 MiB."
    );
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| anyhow::anyhow!("The secret dotenv file is not valid UTF-8 dotenv syntax."))?;
    let environment = parse(text.strip_prefix('\u{feff}').unwrap_or(text));
    validate_environment(schemas, &environment, true).map_err(|_| {
        anyhow::anyhow!(
            "The secret dotenv file contains invalid, colliding, or oversized environment entries."
        )
    })?;
    Ok(environment)
}
fn trim(value: &str) -> &str {
    value.trim_matches([' ', '\t', '\n', '\r'])
}
fn parse(source: &str) -> Value {
    let source = source.replace('\r', "");
    let mut remaining = source.as_str();
    let mut result = serde_json::Map::new();
    while !remaining.is_empty() {
        remaining = remaining.trim_start_matches([' ', '\t', '\n']);
        if remaining.is_empty() {
            break;
        }
        let line_end = remaining.find('\n').unwrap_or(remaining.len());
        let line = &remaining[..line_end];
        if line.starts_with('#') || !line.contains('=') {
            remaining = remaining.get(line_end + 1..).unwrap_or("");
            continue;
        }
        let equal = line.find('=').expect("line equals");
        let mut key = trim(&line[..equal]);
        if let Some(export) = key.strip_prefix("export ") {
            key = trim(export);
        }
        let value_source = remaining[equal + 1..].trim_start_matches([' ', '\t']);
        let quoted = value_source
            .as_bytes()
            .first()
            .filter(|byte| matches!(byte, b'\'' | b'"' | b'`'))
            .copied();
        let (value, consumed) = if let Some(quote) = quoted {
            if let Some(end) = value_source[1..].find(quote as char) {
                let value = &value_source[1..end + 1];
                let value = if quote == b'"' {
                    value.replace("\\n", "\n")
                } else {
                    value.to_owned()
                };
                (value, end + 2)
            } else {
                let end = value_source.find('\n').unwrap_or(value_source.len());
                let value = trim(value_source[..end].split('#').next().unwrap_or("")).to_owned();
                (value, end)
            }
        } else {
            let end = value_source.find('\n').unwrap_or(value_source.len());
            let value = trim(value_source[..end].split('#').next().unwrap_or("")).to_owned();
            (value, end)
        };
        result.insert(key.to_owned(), json!(value));
        let tail = &value_source[consumed..];
        remaining = tail
            .find('\n')
            .and_then(|end| tail.get(end + 1..))
            .unwrap_or("");
    }
    Value::Object(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn node_parse_env_golden_cases() {
        for (source, expected) in [
            (
                "A=one\nB=\"two\\nlines\"\nC=three # hi\n",
                json!({"A":"one","B":"two\nlines","C":"three"}),
            ),
            (
                "export A=1\nexport\tB=2\nA=3\n",
                json!({"A":"3","export\tB":"2"}),
            ),
            (
                "A=\"unterminated\nB=two\n",
                json!({"A":"\"unterminated","B":"two"}),
            ),
            ("INVALID\nB=good\n", json!({"B":"good"})),
            ("A=1\r\nB=2\rC=3", json!({"A":"1","B":"2C=3"})),
            (
                "A=`back\ntick`\nB=\"a\\\"b\"",
                json!({"A":"back\ntick","B":"a\\"}),
            ),
            ("A=x=y\nB=\"x\"tail\n", json!({"A":"x=y","B":"x"})),
            ("A=\nB= \n", json!({"A":"","B":""})),
            ("A=one\nA=two", json!({"A":"two"})),
            ("A=\"x\\t\\r\\n\\\\y\"", json!({"A":"x\\t\\r\n\\\\y"})),
        ] {
            assert_eq!(parse(source), expected);
        }
    }
    #[test]
    fn dotenv_regular_file_bounds_utf8_bom_symlinks_and_case_collisions() {
        let schemas = Schemas::new().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fixture.env");
        std::fs::write(&path, "\u{feff}TOKEN='fixture-value'\n").unwrap();
        assert_eq!(
            read(path.to_str().unwrap(), &schemas).unwrap(),
            json!({"TOKEN":"fixture-value"})
        );
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(
            read(path.to_str().unwrap(), &schemas)
                .unwrap_err()
                .to_string()
                .contains("UTF-8")
        );
        std::fs::write(&path, "TOKEN=fixture-sensitive\ntoken=other\n").unwrap();
        let error = read(path.to_str().unwrap(), &schemas)
            .unwrap_err()
            .to_string();
        assert!(!error.contains("fixture-sensitive"));
        std::fs::write(&path, vec![b'a'; MAX_BYTES as usize + 1]).unwrap();
        assert!(read(path.to_str().unwrap(), &schemas).is_err());
        assert!(read(directory.path().to_str().unwrap(), &schemas).is_err());
        assert!(read("relative.env", &schemas).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = directory.path().join("link.env");
            symlink(&path, &link).unwrap();
            std::fs::write(&path, "TOKEN=fixture-value\n").unwrap();
            assert_eq!(
                read(link.to_str().unwrap(), &schemas).unwrap(),
                json!({"TOKEN":"fixture-value"})
            );
            let fifo = directory.path().join("fifo.env");
            let native = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(native.as_ptr(), 0o600) }, 0);
            assert!(read(fifo.to_str().unwrap(), &schemas).is_err());
        }
    }
}
