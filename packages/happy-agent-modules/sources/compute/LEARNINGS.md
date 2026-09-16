# Compute module learnings

## Services share the process catalog, not ordinary shell completion shortcuts

A service's public process ID refers to its actual strict SDK execution. Stopping that process
uses the service's revocation and whole-sandbox teardown barrier; a shell exit notice or an abort
signal is not proof that its namespace, descendants, and bridges are gone. Failed cleanup leaves
the process active and addressable. Service starts use Compute's independently owned process
context and an abort-generation check, including starts that finish after the abort snapshot.
Public process stops persist service revocation with the caller's transaction and signal only after
commit; a rollback leaves the execution untouched. Independent native reconciliation may later
confirm a previously failed cleanup and finalize that same public process identity.

Archival previously removed the cached compute before disposal succeeded. It now closes admission
and retains the compute until cleanup is confirmed, so a failed archive can be retried without
losing the only handle able to stop its processes. Disposal attempts every owned cleanup path even
when an earlier one fails. Normal tool and turn completion do not dispose service runtimes.

## Service inputs remain live and read-only

Workspace services use selected live read-only inputs and private writable scratch. Changes made
from outside the service are intentional and do not require copying the workspace into a startup
snapshot. Preserve directory watching and hot reload rather than introducing snapshots implicitly.

Linux read-only mounts prevent regular-file writes, but a named pipe in a selected directory can
still communicate with a host process. The service cannot create that pipe in its read-only inputs;
it must already exist or be added from outside, and a host process must consume it for the edge
case to matter. This conditional IPC risk is explicitly accepted for the first service version.
Do not describe it as arbitrary host-file write access or an automatic Happy escape.

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

## Windows protected placeholders

The Windows product policy permits empty protected placeholders when project metadata is absent.
Native NTFS denials need an existing object, so the supervisor creates protected root files as
empty files and protects metadata directories before releasing a restricted command. The same
Windows metadata names belong to the file-tool policy. Existing content is preserved, missing
denies outside writable roots remain absent, and macOS/Linux behavior stays unchanged. This is
the explicitly approved Windows exception to the general no-placeholder rule.
