use super::{Child, Control, create_terminal, process};
use std::{ffi::OsStr, io, path::Path};

/// A pipe-backed native command. ConPTY replaces its pipes when requested.
/// Track environment clearing explicitly; the standard builder cannot expose
/// that state to a native CreateProcess adapter.
pub struct Command {
    pub(super) inner: std::process::Command,
    pub(super) inherits_environment: bool,
    terminal: Option<Control>,
}
impl Command {
    pub fn new(program: impl AsRef<OsStr>) -> Self {
        Self {
            inner: std::process::Command::new(program),
            inherits_environment: true,
            terminal: None,
        }
    }
    pub fn arg(&mut self, argument: impl AsRef<OsStr>) -> &mut Self {
        self.inner.arg(argument);
        self
    }
    pub fn args(&mut self, arguments: impl IntoIterator<Item = impl AsRef<OsStr>>) -> &mut Self {
        self.inner.args(arguments);
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
    ) -> io::Result<(tokio::fs::File, tokio::fs::File, Control)> {
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
