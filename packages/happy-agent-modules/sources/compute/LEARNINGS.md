# Compute module learnings

## Kimi and GLM select their harness surfaces by model family

Unknown model families previously fell back to Codex tools, which would give Kimi and GLM
argument names from the wrong harness when served through Bedrock. Kimi now gets its own fixed
array using Bash, Read, Write, Edit, Glob, Grep, ReadMediaFile, and shell Task tools. GLM gets an
explicit Claude-shaped array with a text-only Read, because a successful image read followed by
a provider rejection would break the next inference. Ordinary and reviewer arrays make that
choice explicitly; the agent loop and permission model remain shared.

Kimi Bash's timeout is a wait in seconds, and commands that outlive it become background tasks.
TaskOutput is non-blocking and consumes only new output; TaskInput is a reviewed product extension
that stays inside the process's existing boundary. TaskStop uses the same process-tree cleanup as
other vendors. Kimi's production search and media descriptions state the bounded filesystem,
JavaScript regex, and image behavior actually implemented, while provider reference descriptors
retain the native harness text unchanged.

## Bounded mutation reads stay bounded through the write

An initial bounded inspection followed by the shared helpers' unbounded reread could admit a file
that grew or changed between reads, and an append assembled from the first copy could discard
new content. Shared text mutations now optionally bound the actual source reread, compare it with
the inspected content and timestamp, and bound the resulting UTF-8 bytes. Append is assembled
inside that checked mutation. Kimi uses these bounds for its 8 MiB text limit; existing callers
retain their current behavior. The final timestamp check narrows concurrent-change races without
claiming an atomic compare-and-write filesystem operation.

Bounded edits also cap occurrence collection and check replacement expansion before allocating
the resulting string, so a short repeated token cannot multiply an 8 MiB source into an unbounded
output before the byte check runs.

## Shell descriptions follow the execution environment

Claude's Bash tool used to promise a Bash interpreter on native Windows while Compute ran
PowerShell. Native Windows now exposes PowerShell and PowerShellInput/Output/Stop to the agent;
the reviewer's existing subset uses the same names. Unix and WSL keep Bash. No Git Bash support
is added on Windows.
The fixed tool array and instructions use the same selection. Background handles retain the
existing opaque `bash_id` field; names do not change execution, permissions, or process ownership.
Codex keeps its neutral exec_command name and receives the actual shell in environment guidance.

## Background commands use the ordinary shell process catalog

Workspace services have been removed, including their process variant, revocation hooks, and
teardown barriers. Ordinary shell sessions retain independent process contexts, abort-generation
checks, process-tree cleanup, and public process identities. Archival closes admission and retains
the cached compute until disposal succeeds, so cleanup can be retried without losing its handle.

## Product connections from an agent's machine end with it

The agent proxy must reach the network the agent's commands run on: its container, its runner,
or this computer. `network(ctx, agentId)` resolves the agent's exact cached compute and returns a
connector over its `network.connect`. Compute tracks every connection opened that way and destroys
them when the agent is archived or the module is disposed, whatever kind of machine it is, and the
connector refuses once its machine is gone instead of starting another. A machine without a
network is refused with `ENOTSUP`; nothing falls back to the daemon's own network.

## Agent networks are named from the machine that was built

A browser keeps its cookies and storage per network, so the name must change exactly when the
network does. `networkId` is recorded on the cached machine when `resolve` builds it, from the
environment actually used after the bot's compute choice: `host` for this computer (including work
run as another Linux user), `r-<runnerId>` for a runner, and for a container `c-` and a digest of
the agent, image, and runner. A running machine is never moved, so a newer setting renames nothing
until the machine is rebuilt; a rebuilt container in the same environment keeps its name.

`namedNetwork` serves only what is true now and never starts a machine. `host` is served while
work runs here and `r-<id>` while that runner is configured, through the runners module's product
machine, and neither belongs to an agent: archiving the agent that first named one leaves its
tunnels open. A container's name is served only by its agent's cached, running machine, with the
same tracked connector as `network`, so archival ends its connections. An unknown or stale name is
`undefined`, never another network; after a restart a container's name is unserved until its
machine is resolved again.

## File mutations can explicitly request reviewed elevation

Patch, write, and edit tools previously inferred elevation only from their target paths, so a model
could not request it using the same explicit controls as shell tools. Codex `apply_patch` now accepts
`sandbox_permissions` and `justification`; Claude `Write` and `Edit` accept
`dangerouslyDisableSandbox`; Grok `write` and `search_replace` accept `sandbox_permissions` and
`description`. These optional Happy Agent extensions request review and temporary Full access for
one call, never a persistent mode change. Omitting the flag retains automatic review for protected,
outside-workspace, and symlink-escaping paths. Read only and Workspace write do not elevate.

## Filesystem discovery identity must come from its owner

Agents on separate containers or emulated machines can advertise the same provider name, working
directory, and home. Those strings do not establish shared files. Compute now exposes a discovery
identity that shares only its own native filesystems with identical cwd, home, and host policy;
alternate filesystems retain object identity. Discovery additionally partitions by the full
per-operation permissions. This permits safe concurrent scan sharing without mixing machines or
reusing elevated reads in a restricted call.

## Bash calls start from a fixed working directory

Each Bash invocation opens a fresh shell in the compute's primary working directory. A directory
change belongs to that invocation, including a background process that continues from it, and does
not alter where a later Bash call starts. Claude's Bash description states this positively so the
model can use relative paths without adding a redundant absolute directory change. Do not describe
the working directory as mutable session-wide shell state.

## Secret attachments are selected per command and resolved at spawn

Shell tools carry only attached secret bundle IDs. The default host machine resolves those IDs
through `SecretsModule` immediately before spawning and gives the process a one-command environment;
values never cross a model-facing schema or compute result. Before selected values are added, every
environment-variable name belonging to any bundle attached to that command scope is removed from
the ambient environment case-insensitively. Omitted and empty selections therefore mean no secrets
and cannot inherit an attached value accidentally.

The catalog has one installation-wide owner. A native agent compute carries its project and exact
workspace identity; command resolution unions matching project, workspace, and agent grants before
checking the explicit selection. Secret provisioning and sandbox elevation are independent
permission decisions. A non-empty selection triggers Auto review but keeps the command in its
current sandbox; only the vendor's explicit escalation argument requests temporary Full access.
Either may be used alone or both may be used together. A background session records whether it
holds secrets so later reviewed input can disclose that fact, but input continues under the
process's existing boundary. Alternate compute providers receive the selected IDs unchanged and
own their own resolution boundary.

## Reloadable reads must be replay-safe in every permission mode

Idempotent file inspection tools are both durable and reloadable. A graceful daemon reload may
leave their pending call for the next process, which can safely read the file, directory, image, or
search result again.

Do not infer reloadability from a read-oriented name or from the restricted mode a particular
caller happens to use. Shell and command-input definitions can mutate when the same tools run in a
wider permission mode, while background command-output reads consume the delta they return. Those
tools must keep producing an interrupted result instead of replaying after a restart.

## Codex command output follows the model policy after capture

Codex command sessions request a Codex-only 1 MiB capture ceiling for each compute output stream,
using the same ceiling value as vanilla unified exec without changing the collection limits of
Claude or Grok. `exec_command` and `write_stdin` then apply the smaller of the model-requested
`max_output_tokens` and Codex's 10,000-token model policy. The default request is also 10,000
tokens. A larger request therefore cannot multiply context pressure, while output dropped during
collection or model-facing truncation continues to be disclosed. Every OpenAI model in Happy
Agent's current curated catalog publishes that token policy; this is not a provider-global
assumption for arbitrary future models, whose metadata must be checked when the catalog changes.

## File-edit presentations belong to structured tool results

Every successful built-in file mutation returns the exact bounded `file_diff` presentation in its
structured result. Exact replacements produce delete/add hunks at their actual old and new line
numbers; whole-file writes produce an add or full rewrite; patches preserve context lines and
represent moves as a delete plus an add.

The presentation keeps exact added/deleted totals even when rows are omitted. It retains at most
20 files and 500 diff rows shared across those files, truncates paths and row text to 2,000 Unicode
characters, and reports `omittedFiles` and `omittedLines`. These are product payload bounds, not UI
rendering choices.

History recognizes the validated `presentation` envelope after execution, keeps it in the
call-scoped durable run store, and records it with the transactional tool result. This makes live
and loaded API projections use one persisted value and keeps presentations intact across daemon
restarts without adding tool-name dispatch or extra runtime wiring.

## Read-log serialization follows the database lock

`FileReadLog.record` enters the Agent Database's owned-operation boundary before taking the
per-agent read-log lock. Transactional reads already hold the global database slot when they record
a file, so letting a nontransactional edit take the read-log lock before requesting that slot
creates the opposite order and can deadlock every queued database route. The database-first order
keeps the read-log update together, composes with transactional read tool results, and leaves
unrelated database work responsive. It does not open a new libSQL transaction for a
nontransactional edit, because the local libSQL client rotates its native connection after each
transaction; custom stores without the production database boundary use an Agent KV transaction as
the safe fallback.

## One agent's file changes run one at a time

A model can send several Edits to the same file in one parallel batch. Each change used to check
the read log, write, and then record its own write, so the later edits in a batch saw a file
modified since their read and were refused as stale even though nothing outside the agent had
touched it. Every file-changing operation (Claude and Kimi Edit and Write, Codex apply_patch,
delete, move) now runs inside `FileReadLog.change`, which holds one per-agent lock from the
staleness check through recording the result. A batch therefore applies as if its edits were made
one after another. The lock is re-entrant through the context, so a change that calls another
change does not deadlock.

## A stale Claude Edit applies when its text still matches

Claude Code does not refuse an Edit just because the file changed after it was read. If
`old_string` still matches exactly once (or `replace_all` was requested), the edit applies and the
result carries Claude Code's note that the file has other changes not in the model's context. Only
when the text no longer applies is the edit refused with the read-again error. Write and the other
vendors' tools keep the strict refusal, because a whole-file write over unseen changes would
discard them.

## Windows protected placeholders

The Windows product policy permits empty protected placeholders when project metadata is absent.
Native NTFS denials need an existing object, so the supervisor creates protected root files as
empty files and protects metadata directories before releasing a restricted command. The same
Windows metadata names belong to the file-tool policy. Existing content is preserved, missing
denies outside writable roots remain absent, and macOS/Linux behavior stays unchanged. This is
the explicitly approved Windows exception to the general no-placeholder rule.

## Claude's Read fits images within 2000 pixels

Claude's Read used to send images exactly as stored. Claude rejects any image wider or taller than
2000 pixels once a request carries more than 20 images, and every read image stays in the history
each later request replays, so one large screenshot made the conversation fail permanently once
enough images accumulated. Read now decodes the image and scales a longer side down to 2000 pixels,
as Claude Code does, and tells the model the original and shown sizes. A file that does not decode
as an image is refused rather than sent. Codex `view_image` still shows images as stored.

## A bot's compute choice applies when the machine is built

A bot's owner may run its agents in a Docker container of a chosen image. The choice is read only
while an agent's machine is built, because a running machine is never moved: new agents get it at
once and running agents after a restart. The bot's image is applied on whichever machine holds the
folder — this computer or the agent's runner — and a workspace that already runs in Docker keeps
its own image. Docker machines still refuse attached secrets.

## Work for a separate Linux user never gets a host compute

With `[execution]` configured, an agent with no runner used to be the one case that reached
`#createHere`, so a bug in routing would have run agent commands as the daemon's user, which can
read the database and credentials. Resolution now asks `RunnersModule.userFor` first and uses a
host compute only when there is no runner, no container, and no user; every other agent machine,
the permission reviewer's included, is built on the user's local runner. Secrets are refused there
because they would have to be delivered across the user boundary first.

## A drain answers reads that are only waiting for output

A reload spent four minutes draining because a Claude `BashOutput` with `block: true` and a
ten-minute timeout was waiting on a benchmark that kept running. Drain lets ordinary tools finish,
so it waited for that read to time out. `ComputeModule.releaseOutputWaits` is raised when the
daemon starts draining. Every read through `readComputeCommand`, which serves Claude and GLM
`BashOutput`, Codex's empty `write_stdin` poll, and Grok's `get_command_or_subagent_output`,
then stops waiting and returns what the command has said so far as its ordinary, committed result.
Reads that start later don't wait. The command keeps running, and the cursor advances only past
output that was returned. Foreground commands, typed input, and every other tool keep their
behavior, and there is no drain deadline.

The release is an abort signal passed to the shell's wait. It is safe only where the shell
answers a cancelled wait with its snapshot, as host, Docker, and just-bash shells do. A runner's
transport rejects a cancelled request after the runner has already consumed the output it would
have returned, so releasing a runner read would lose that output. Compute therefore records every
machine it builds on a runner, including the reviewer's workload-user runner, and hands those tools
no release signal: a runner read keeps waiting exactly as before. Tools never guess this from a
name or a compute kind. A released read also tells the model that Happy Agent is restarting, so a
result saying the command is still running is not mistaken for an ordinary timeout.
