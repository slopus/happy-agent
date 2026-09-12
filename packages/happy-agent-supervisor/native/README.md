# Native workspace

This Cargo workspace produces one small supervisor binary for Linux and macOS.
The platform-specific boundary lives below `supervisor/src/platform`; policy
parsing and direct `execve` handling are shared.

Windows uses `windows/main.rs` and `windows/happy.patch` against the exact upstream
commit in `windows/source.json`. The build produces Happy's supervisor, runner,
and setup helper; it does not require an installed Codex executable. Windows
capability identities derive from an installation seed and canonical path, while
preserving previously recorded identities. Private command scratch paths do not
append persistent capability entries. Write-denial ACLs are only needed where a
path overlaps an actual writable root; elsewhere the restricted token already
denies writes.
