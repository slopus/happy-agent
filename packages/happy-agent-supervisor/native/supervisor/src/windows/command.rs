use super::{Child, Control, create_terminal, process};
use std::{ffi::OsStr, io, path::Path};

/// A pipe-backed native command. ConPTY replaces its pipes when requested.
/// Track environment clearing explicitly; the standard builder cannot expose
/// that state to a native CreateProcess adapter.
pub struct Command {
    pub(super) inner: std::process::Command,
    pub(super) inherits_environment: bool,
    pub(super) raw_arguments: std::collections::BTreeSet<usize>,
    argument_count: usize,
    terminal: Option<Control>,
    #[cfg(test)]
    pub(super) prepared_job: Option<std::sync::Arc<super::Job>>,
}
impl Command {
    pub fn new(program: impl AsRef<OsStr>) -> Self {
        Self {
            inner: std::process::Command::new(program),
            inherits_environment: true,
            raw_arguments: std::collections::BTreeSet::new(),
            argument_count: 0,
            terminal: None,
            #[cfg(test)]
            prepared_job: None,
        }
    }
    pub fn arg(&mut self, argument: impl AsRef<OsStr>) -> &mut Self {
        self.inner.arg(argument);
        self.argument_count += 1;
        self
    }
    pub fn args(&mut self, arguments: impl IntoIterator<Item = impl AsRef<OsStr>>) -> &mut Self {
        for argument in arguments {
            self.arg(argument);
        }
        self
    }
    /// Append intentional shell syntax without applying CRT argument escaping.
    /// This matches Windows CommandExt::raw_arg, particularly cmd.exe /s /c.
    pub fn raw_arg(&mut self, argument: impl AsRef<OsStr>) -> &mut Self {
        self.raw_arguments.insert(self.argument_count);
        self.arg(argument);
        self
    }
    pub fn current_dir(&mut self, path: impl AsRef<Path>) -> &mut Self {
        self.inner.current_dir(path);
        self
    }
    pub fn env(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> &mut Self {
        self.inner.env(key, value);
        self
    }
    pub fn env_remove(&mut self, key: impl AsRef<OsStr>) -> &mut Self {
        self.inner.env_remove(key);
        self
    }
    pub fn env_clear(&mut self) -> &mut Self {
        self.inherits_environment = false;
        self.inner.env_clear();
        self
    }
    pub fn attach_terminal(
        &mut self,
        cols: u16,
        rows: u16,
    ) -> io::Result<(super::Stream, super::Stream, Control)> {
        if self.terminal.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "The command already owns a Windows terminal.",
            ));
        }
        let (reader, writer, control) = create_terminal(cols, rows)?;
        self.terminal = Some(control.clone());
        Ok((reader, writer, control))
    }
    pub fn spawn(&mut self) -> io::Result<Child> {
        let terminal = self.terminal.take();
        process::spawn(self, terminal.as_ref())
    }
}
