# Windows process ownership

`Command` builds a native process with anonymous pipes or ConPTY. It tracks
environment inheritance explicitly so clearing the environment and removing a
variable never restores ambient credentials through the Windows adapter.
Arguments use the Windows command-line quoting rules, and environment overrides
replace differently cased inherited names.

`CreateProcessW` receives an explicit startup handle list and a Job list. The
process belongs to its Job before its first instruction; failure to attach the
Job fails process creation. No later operation reopens an arbitrary numeric PID
to take ownership. The Job handle is private and has kill-on-close enabled, so
daemon exit terminates the complete tree. Live descendants retain their owned
Job after a normal leader exit.

`Control` holds one terminal identity for resizing and retirement. ConPTY closes
on a blocking worker while the output reader can drain its final bytes. Async
stream reads and writes use Tokio's file driver and apply pipe backpressure.
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
