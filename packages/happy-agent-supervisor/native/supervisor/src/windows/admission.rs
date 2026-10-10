use std::io;

/// Do not turn an unenforceable restricted policy into an unrestricted launch.
pub fn require_full_access(mode: &str) -> io::Result<()> {
    let reason = match mode {
        "full_access" => return Ok(()),
        "workspace_write" | "auto" => {
            "Windows restricted commands are unavailable: the source ACL sandbox cannot protect filenames that start absent or are deleted and recreated while keeping those paths absent. The required atomic filename boundary is not available in this runtime."
        }
        "read_only" => {
            "Windows Read only commands are unavailable: the native dedicated-account, restricted-token and firewall boundary has not been established and verified."
        }
        _ => "The command permission mode is not valid.",
    };
    Err(io::Error::new(io::ErrorKind::Unsupported, reason))
}
