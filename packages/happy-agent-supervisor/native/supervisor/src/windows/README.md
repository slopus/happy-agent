# Windows process ownership

`Command` builds a native process with pipes or ConPTY. It tracks
environment inheritance explicitly so clearing the environment and removing a
variable never restores ambient credentials through the Windows adapter.
Arguments use the Windows command-line quoting rules, and environment overrides
replace differently cased inherited names. `cmd.exe` receives its script with
intentional raw shell syntax, so quotes inside the script keep their meaning.

`CreateProcessW` receives an explicit startup handle list and a Job list. The
process belongs to its Job before its first instruction; failure to attach the
Job fails process creation. No later operation reopens an arbitrary numeric PID
to take ownership. The Job handle is private and has kill-on-close enabled, so
daemon exit terminates the complete tree. Live descendants retain their owned
Job after a normal leader exit.

`Control` holds one terminal identity for resizing and retirement. ConPTY closes
on a blocking worker while the output reader can drain its final bytes. Async
stream reads and writes use IOCP and apply pipe backpressure. Parent endpoints
are private named-pipe servers with overlapped IO; child endpoints remain
synchronous standard handles. Pipe IO does not occupy Tokio blocking workers,
which keeps output readers from exhausting the worker pool before stdin writes
can run. The single local instance uses a random name and an Owner Rights DACL,
rejects remote clients, and fails if its owned client cannot connect immediately.
Process waits inspect the held process handle, so waiting does not depend on the
caller closing stdin.

These are process primitives. `CreateProcessW` does not establish a filesystem
or network sandbox; the restricted Windows runner must supply its account,
token, ACL, and firewall boundary before launching a workload. A compile check
of this module establishes no native Windows runtime or sandbox proof.

The process-creation contract follows Happy's pinned Codex Windows adapter at
`a62e98d18c6550e3bea152ed1b89d1e931dca961`, particularly its `process.rs`,
`proc_thread_attr.rs`, and `conpty/mod.rs`. The implementation is linked into the
Happy Agent executable and invokes no additional shipped helper or runtime.

The manual `Verify Windows native runtime` workflow separates compiling these
primitives, executing their real Job/ConPTY/pipe regressions on `windows-2025`,
and building and smoke-testing the product executable. The regressions cover
input, Unicode, output drain, terminal resize, environment clearing, tree
termination, and owner cleanup. The child fixture runs inside the same test
executable.

Ordinary Windows commands use these owners in Full access. Restricted admission
fails before spawning a workload, with the reason in the tool or runner error.
The source ACL sandbox attaches deny entries to existing filesystem objects.
Its setup materializes protected paths that start absent, and an object ACL
cannot protect a filename through deletion and recreation. This conflicts with
the required invariant that protected absent paths remain absent throughout
execution; an existing-path-only port would still weaken that invariant.
Workspace write and Auto therefore remain unavailable until an atomic filename
boundary is established.

The source Read only path is distinct: `token.rs` constructs a restricted token
with `WRITE_RESTRICTED`, while `setup.rs`, the dedicated sandbox account and
runner, path ACLs, and WFP provide the remaining boundary. A same-user restricted
token alone cannot enforce sensitive read denials or block networking. This
runtime has not established and verified those source roles, including inherited
handle, hardlink and reparse-point cases, so Read only also remains unavailable.
No placeholder, driver, or replacement host policy is installed.
