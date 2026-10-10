# Compute and tools

## Terminal input belongs to a real controlling terminal

The first native command transport used pipes even when a command requested a
terminal. Terminal commands now receive a controlling PTY on all three standard
descriptors, with an 80 by 24 size and the same pager and color defaults as the
original implementation. Terminal input and control characters go through its
nonblocking master descriptor. Pipe commands keep separate output streams.

## Processes outlive the caller that first waited for them

The initial bounded wait borrows the caller's cancellation. A returned command
session belongs to Compute's independent application lifetime; cancellation of a
completed caller or a later poll does not terminate that session. An explicit
stop, permission reduction, abort, archival, or shutdown owns the corresponding
cleanup. Starts remember their agent's abort generation before provisioning so a
command waiting on storage cannot cross an abort and start work for the old turn.

Runner background shell and program starts belong to the compute even while
their request disconnects. Foreground runs and bounded reads keep their caller's
cancellation. Compute disposal cancels pending starts before launch and joins
both program and shell cleanup. Program streams use their own 256-program bound;
they do not inherit the shell's 64-session eviction. Runner shells retain at
most 64 completed snapshots per compute, independently of ordinary tool sessions.

The shared Unix process-group catalog previously rejected the 129th real program
despite the runner's larger quota. It now bounds ownership at 4,096 groups,
retaining every live group until confirmed cleanup instead of forgetting it to
make room. Runner admission still enforces its own program quota.

Product program terminals receive their requested size and terminal name before
the child starts, while preserving its configured environment. Ordinary agent
terminals retain their shared color and pager defaults.

## A shell exit is different from whole-group teardown

The first native supervisor terminated descendants whenever their shell exited.
Normal completion now retains ownership of surviving groups, including commands
deliberately left running by an exited shell. Explicit cleanup signals only those
known groups, without falling back to a reusable bare PID. On Linux the
application is a subreaper; Compute waits for the exact leader through Tokio
before reaping adopted descendants by that group's identity. Cleanup has bounded
grace and forceful waits and remains unconfirmed when the group cannot be proved
gone. Archival checks that proof and preserves every other agent's processes.

## Public process rows and observers are transient

A detached shell receives one public CUID2 identity distinct from its private
numeric input handle. Its lifecycle keeps that identity and advances a UUIDv7
version exactly once on exit. Completed rows are bounded per agent and globally;
there is no durable process catalog or replay after restart. Optional observers
cannot fail command execution. The API appends public process events
synchronously to its bounded journal, then coalesces bounded canonical metadata
work, reconciling current counts if it falls behind. An abort publishes the shell
row's exit before sending its hard-kill signal; actual teardown still has its own
positive cleanup barrier.

## Windows process ownership and restricted admission are separate

Windows Full access commands use one native Job attached during process creation
and keep its handle after a normal leader exit. Cleanup operates on that held
kernel identity, including descendants, rather than reopening a numeric PID.
ConPTY supplies the requested terminal dimensions before launch. Parent stream
endpoints use IOCP; blocking file reads could otherwise consume the entire
worker pool before a command could receive stdin.

The source Windows ACL sandbox creates placeholders for protected names that
start absent and cannot preserve a filename denial through deletion and
recreation. That violates the required absence invariant. Workspace write and
Auto fail before launch with the specific missing boundary.

Read only is assessed independently of that filename issue. A real Windows
kernel regression reproduces Source's elevated restricting SID pattern and
confirms an actual write to an existing Everyone-writable file. The token's
Everyone restricting SID accepts that grant, so Source's token cannot establish
a denial of all writes outside isolated TEMP unchanged. Read only fails until a
correct token boundary and the dedicated-account, read-denial and firewall roles
are established and verified. Full access process tests do not prove restricted
policy enforcement. Windows shell interruption retains Source's unavailable
result; explicit termination and cleanup use the Job.

## Secret selection and sandbox elevation remain separate

Immediately before spawning, Compute resolves exact project, workspace, and
agent grants through Secrets. It removes every attached environment name from
ambient inheritance without regard to case, then adds only explicitly selected
values. Selecting a bundle does not change the execution boundary. Full access
uses the original direct-shell path; restricted commands use the shared native
supervisor. A missing grant or invalid working directory fails before launch.

## Vendor arrays and guidance come from the frozen Source

The first native surface covered only Codex commands. Source has five ordinary
and reviewer arrays: Codex, Claude, Grok, Kimi, and GLM. Native tools use those
fixed arrays, captured parameter and result schemas, permission guidance, and
independent durable, reloadable, and steerable flags. The common history tool
uses its own captured flags. Vendor descriptor files remain reference data.

## File knowledge commits with the final result

Reads and successful mutations prepare Source read stamps and bounded file
diffs. The final tool-result transaction records them in the owning database,
including the reviewer's private database, and removes staging only after
commit. Caller rollback preserves the old knowledge. A bounded staging slot is
reserved before any mutation; cancellation cannot resurrect a slot already
consumed by a terminal result. An atomic native write finishes under its owned
execution even when its caller has stopped waiting.
Knowledge retains the normalized written path, including a symlink alias,
while mutations use the checked canonical target. Canonical-only patch stamps
previously let a later edit through the alias overwrite an external change.

## Files use the Config-owned boundary

Config supplies the workspace, private directories and protected project paths.
File operations check written and canonical paths, including aliases, and deny
private directories before Full access is considered. Discovery applies that
same rule to every descendant. Restricted writes preserve absent protected
names without creating placeholders. Anchored descriptor operations preserve
mode bits and avoid following a substituted symlink. Patch deletes remove a
symlink's directory entry; patch moves preserve the original file and refuse
occupied targets. The compute filesystem's raw move uses checked native rename
and can replace a destination, as its Source RPC contract requires.

Directory pages compare UTF-8 bytes and retain only the requested page plus one
sentinel while scanning. Sorting UTF-16 changed both the page and its cursor for
non-BMP names. Optional metadata lookups return an internal missing value;
runner stat replies retain their required object and report missing paths as
errors. Per-call filesystem permissions preserve explicit denied paths even in
Full access, and protected absent names remain absent.

## Output and search preserve Source text semantics

Capture retains both the beginning and end of a large stream and carries an
incomplete UTF-8 suffix into the next poll. Search uses ECMAScript expressions
and UCS-2 indexing, including lookaround and backreferences, in a native worker
with no inherited environment. The worker has bounded frames, memory, CPU,
elapsed time and caller cancellation, and is killed and reaped on every exit.
Source's search budgets and truncation disclosures remain in the result. A
rejected regex worker releases its bounded response receiver before joining the
producer, so malformed extra output cannot deadlock cleanup.

## Agent runners carry each operation's actual permissions

The product machine's Full access RPCs cannot serve agent tools. Agent computes
use their own identities, per-call permissions, binary bodies and generation
bound command handles. Only the runner's explicit unknown-compute error proves
a request did no work and permits its one recovery attempt. A disconnected or
timed-out request remains unproven. Unsupported local container execution fails
before launching anything on the host.
