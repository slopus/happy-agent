use happy_agent_supervisor::windows::Command;

/// Source selects shell syntax from its configured executable.
pub(super) fn arguments(command: &mut Command, shell: &str, script: &str) {
    let name = std::path::Path::new(shell)
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new(shell))
        .to_string_lossy()
        .to_ascii_lowercase();
    match name.as_str() {
        "cmd.exe" | "cmd" => {
            // /s removes this outer pair. Quotes inside the script belong to
            // cmd's language and cannot be escaped with CRT backslashes.
            command
                .args(["/d", "/s", "/c"])
                .raw_arg(format!("\"{script}\""));
        }
        "powershell.exe" | "powershell" | "pwsh.exe" | "pwsh" => {
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ]);
        }
        _ => {
            command.args(["-lc", script]);
        }
    }
}
