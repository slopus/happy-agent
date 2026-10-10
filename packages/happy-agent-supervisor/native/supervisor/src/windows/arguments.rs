use std::{collections::BTreeMap, ffi::OsStr, io, os::windows::ffi::OsStrExt};

pub(super) fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut result: Vec<_> = value.encode_wide().collect();
    if result.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "A Windows command value contains a null character.",
        ));
    }
    result.push(0);
    Ok(result)
}

pub(super) fn command_line(command: &super::Command) -> io::Result<Vec<u16>> {
    let mut result = Vec::new();
    for (index, value) in std::iter::once(command.inner.get_program())
        .chain(command.inner.get_args())
        .enumerate()
    {
        if !result.is_empty() {
            result.push(b' ' as u16);
        }
        let value = wide(value)?;
        let value = &value[..value.len() - 1];
        if index > 0 && command.raw_arguments.contains(&(index - 1)) {
            result.extend_from_slice(value);
            continue;
        }
        if !value.is_empty()
            && !value
                .iter()
                .any(|value| matches!(*value, 9 | 10 | 13 | 32 | 34))
        {
            result.extend_from_slice(value);
            continue;
        }
        result.push(b'"' as u16);
        let mut slashes = 0;
        for &value in value {
            if value == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            let count = if value == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            };
            result.extend(std::iter::repeat_n(b'\\' as u16, count));
            result.push(value);
            slashes = 0;
        }
        result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        result.push(b'"' as u16);
    }
    result.push(0);
    if result.len() > 32_767 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "The Windows command line exceeds 32,767 characters.",
        ));
    }
    Ok(result)
}

pub(super) fn environment(command: &super::Command) -> io::Result<Vec<u16>> {
    // Windows environment keys are case insensitive. A differently cased
    // override must replace an inherited value, including a secret removal.
    let mut entries = BTreeMap::new();
    if command.inherits_environment {
        for (key, value) in std::env::vars_os() {
            entries.insert(key.to_string_lossy().to_uppercase(), (key, value));
        }
    }
    for (key, value) in command.inner.get_envs() {
        let normalized = key.to_string_lossy().to_uppercase();
        if let Some(value) = value {
            entries.insert(normalized, (key.to_owned(), value.to_owned()));
        } else {
            entries.remove(&normalized);
        }
    }
    let mut result = Vec::new();
    for (_, (key, value)) in entries {
        let key = wide(&key)?;
        let value = wide(&value)?;
        result.extend_from_slice(&key[..key.len() - 1]);
        result.push(b'=' as u16);
        result.extend_from_slice(&value);
    }
    if result.is_empty() {
        result.push(0);
    }
    result.push(0);
    Ok(result)
}
