use anyhow::Result;
use happy_agent_supervisor::windows::Command;
pub(super) use happy_agent_supervisor::windows::Control;
pub(super) type Pty = happy_agent_supervisor::windows::Stream;

pub(super) fn attach(command: &mut Command) -> Result<(Pty, Pty, Control)> {
    for (name, value) in [
        ("TERM", "dumb"),
        ("COLORTERM", ""),
        ("NO_COLOR", "1"),
        ("PAGER", "cat"),
        ("GIT_PAGER", "cat"),
        ("GH_PAGER", "cat"),
    ] {
        command.env(name, value);
    }
    Ok(command.attach_terminal(80, 24)?)
}

pub(super) fn attach_product(
    command: &mut Command,
    cols: u16,
    rows: u16,
    term: &str,
) -> Result<(Pty, Pty, Control)> {
    command.env("TERM", term);
    Ok(command.attach_terminal(cols, rows)?)
}
