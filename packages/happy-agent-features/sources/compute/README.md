# Compute

A machine to work on. An agent that can only talk cannot build anything, so this feature gives it
one: a filesystem to read and change, and a shell to run commands in. It offers ten common Rig
tools — not any vendor's — over one `Compute`, so every model gets exactly these tools, under these
names, with these arguments, regardless of which provider is serving it.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { ComputeFeature } from "@slopus/happy-agent-features";

const compute = new ComputeFeature({ compute: hostCompute });
const agent = await Agent.create(ctx, { ...options, features: [compute] });
```

`hostCompute` is the host's own machine: `Compute.ts` declares the shape it must answer to —
`cwd`, `fs` (`ComputeFileSystem`), `shell` (`ComputeShell`), and `permissions`
(`ComputePermissions`) — copied down from `@slopus/happy-agent-compute`'s real types and narrowed
to what these tools call. The interface is structural on purpose: this package does not depend on
`@slopus/happy-agent-compute`, so a real compute satisfies it with nothing to adapt, and so does
anything else answering the same calls, such as the in-memory `FakeCompute` the tests drive the
tools with.

One `ComputeFeature` instance serves every agent in a collection: the machine is shared, and the
only per-agent state is the log of files that agent has read.

## Tools

### `read_file`

Reads a text file, numbering its lines in the output (the numbers are not part of the file and
must never be echoed back into `edit_file`). `path` may be absolute or relative to the working
directory; `offset` (1-based line) and `limit` page through a longer file. Up to 2,000 lines and
60,000 characters come back at once; a truncated answer says so and tells the model to read on
with `offset`. The read is recorded in the agent's `FileReadLog` under the file's `mtimeMs`, which
is what later earns the right to change it. Marked `durable`: reading the same file again reads
the same file, so a call interrupted mid-turn can simply be retried.

### `write_file`

Creates a file or replaces one whole, creating missing parent directories. An existing file must
have been read first and must not have changed on disk since (`FileReadLog.assertRead`); a file
that does not exist yet needs no prior read, since there is nothing to lose. A successful write
records itself as a read, so a following edit is not refused as stale. `durable`: the same content
written twice leaves the same file.

### `edit_file`

Replaces exact text (`old_text` → `new_text`) inside a file the agent has read. `old_text` must
appear exactly once unless `replace_all` is set, and it refuses a no-op replacement. Deliberately
not durable: repeating an edit that already landed would either find nothing to replace or hit
different text that happens to match.

### `list_directory`

Lists one directory's entries, sorted, with directory names carrying a trailing slash. `path`
defaults to the working directory. Up to 1,000 entries are returned; a truncated answer says how
many of the total are shown. `durable`.

### `find_files`

Finds files by glob (`**`, `*`, `?`, `{a,b}`) under a directory, matched against the whole path
relative to where the search started. Results are ordered by most recent modification time first.
`limit` defaults to 100. Git's own directory is skipped and symbolic links are not followed
(`walkComputeFiles`, capped at 20,000 visited entries and 10,000 collected files); a walk that hit
either cap reports `truncated` even if nothing beyond it happened to match. `durable`.

### `search_files`

Searches file contents line by line with a regular expression (`pattern`), optionally narrowed by
`file_pattern` (a glob) and `case_insensitive`. Each match is reported as `path:line: text`, with
lines over 400 characters shortened and the whole answer bounded to 40,000 characters. Files over
1,000,000 characters or containing a null byte are skipped as not text. `limit` defaults to 100
matching lines. `durable`.

### `run_command`

Runs a shell command, starting fresh each call: nothing carries over between calls, including
directory changes or environment variables. It waits up to `timeout_ms` (default 60s, capped at
600s) for the command to finish; reaching the timeout does not kill it — the command keeps running
and the tool answers with a `command_id` the model comes back to. `background: true` starts a
command meant to outlive the call (a dev server, a watcher) and only waits a short grace period
(3s) to see it did not immediately fail. `workdir` overrides the working directory for that one
command; `tty` runs it under a pseudo-terminal. `escalate_sandbox` (with a short `justification`)
asks Auto to review running the command with unrestricted filesystem and network access outside
the workspace sandbox — every other command runs sandboxed and needs no review. A command the
model is waiting on is stopped if its turn is cancelled; one already handed back as backgrounded
is detached from the turn and left running. `exit_code !== 0` marks the result as an error to the
model.

### `read_command_output`

Reads what a background command has produced since the command was last read, waiting up to
`wait_ms` (default 5s, capped at 300s) for something new to arrive. A command that has already
ended keeps answering for a while so its last output is never lost. Deliberately not durable: a
read consumes what it returns, so retrying after a restart would lose that output rather than
repeat it. Needs no review — it only reads output of work Rig itself already started.

### `send_command_input`

Types `input` into a running command and waits up to `wait_ms` (default 250ms, capped at 30s) for
a response, useful for prompts and REPLs; a line needs its own trailing newline. Only output
produced since the last read comes back. Reviewed whenever `input` is non-empty, since typing into
a live program is the program acting rather than a lookup, but it never needs Full access — it
reaches nothing the command could not already reach inside its own sandbox.

### `stop_command`

Stops a running command and everything it started, asking first and forcing a moment later.
Stopping one that already ended is not an error — the answer simply says `stopped: false`.
`durable`: stopping something already stopped stops nothing. Needs no review, for the same reason
as `read_command_output`: it only ends work Rig itself started.

## Principles

Two rules govern every file tool and are stated to the model directly in `instructions()`, since
tool descriptions alone cannot carry them:

- **Reading earns the right to change.** `FileReadLog` remembers, per agent, which files it has
  read and at what `mtimeMs`. `write_file` and `edit_file` refuse a file this agent has not read,
  and refuse one that changed on disk since it was read, rather than silently discarding whoever
  changed it.
- **A command that outlives its wait is not killed.** It keeps running under a `command_id`, and
  every later read of it — `read_command_output`, `send_command_input`, or the next `run_command`
  wait — returns only what is new since the last read.

Permissions are decided per path or per command, not per tool. `shouldReviewComputePath` resolves
the written path, checks it stays inside `compute.cwd`, and — following every symbolic link with
`canonicalComputePath` — checks it still stays inside once resolved; anything unresolved or
leaving the workspace is reviewed. Writes are additionally reviewed when the path is one
`compute.permissions.protectedPaths()` names (such as Git's own control files), even inside the
workspace. `describeComputePathAction` renders the exact decision for a reviewer: the resolved
path, the operation, and which of "protected workspace path requiring Full access", "path inside
the workspace that the machine guards", or "unrestricted filesystem access outside the workspace
sandbox" applies. A call Auto allows for a path outside the workspace, or a protected path, runs
under Full access for that one call. Shell commands take the opposite default — sandboxed unless
the model explicitly asks to leave, via `escalate_sandbox` — since an ordinary command is the
common case and a reviewer has nothing useful to weigh over it.

Every read tool returns paged, size-bounded results and states, in its own `truncated` and count
fields, when more exists than was shown, rather than letting a short answer be read as a complete
one. `boundOutputText` is the shared mechanism: it cuts text to a character budget and always
leaves a note behind saying how much was left out, keeping the head for a file (read from the
top) and the tail for a command (whose newest lines say how it went).

## External functions

`ComputeFeature` (`ComputeFeature.ts`) implements `AgentFeature`:

- `constructor(options: ComputeFeatureOptions)` — `options.compute: Compute` is the machine every
  tool acts on.
- `readonly name = "compute"`.
- `instructions(): string` — the working directory and the two rules above, given to the model.
- `tools(ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[]` — builds a fresh
  `FileReadLog` from `scope.kv` and `scope.agent.id` and returns the ten tools bound to it, in the
  fixed order every model sees.
- `runningCommands(): readonly ComputeSessionActivity[]` — the commands running right now, for a
  person looking at what an agent has left behind (`compute.shell.activeSessions?.() ?? []`; a
  machine that does not offer the list simply reports none).
- `readCommand(commandId: number): Promise<ComputeSessionSnapshot | undefined>` — reads a
  command's state and output without consuming it (`peek: true`), so a person watching does not
  take output the model has not been given yet.
- `stopCommand(commandId: number): Promise<boolean>` — stops a command by hand; answers whether
  there was one still running to stop.

The feature never disposes of the compute. Commands left running belong to the compute, and only
disposing the compute ends them — not a cancelled turn and not an idle agent.

## Storage

The only state this feature persists is `FileReadLog` (`impl/FileReadLog.ts`), one per agent, kept
in the `AgentKV` the agent lends the feature through `scope.kv` (`feature.compute` scope). It holds
a single key:

- `"reads"` → an array of `{ path: string, mtimeMs: number }`, oldest first, validated against a
  TypeBox schema on read (`Value.Check`); anything that fails validation, such as a log written by
  an older version, is treated as empty rather than blocking every edit.

`record(ctx, path, mtimeMs)` removes any existing entry for `path`, appends the new one, and keeps
only the most recent 512 entries (`MAX_REMEMBERED_READS`) — the log is a guard against a blind
edit, not a transcript, so only recently-read files are worth remembering. Every change to one
agent's log runs inside a per-agent lock (`MapAsyncLock`, keyed by `agentId`) so two tool calls in
the same turn recording reads do not race against the same snapshot; agents never wait on one
another. The log belongs to the agent's conversation rather than to a single run, so a write
interrupted by a restart can simply be retried — the file it left behind is one this agent has
already read.

Command state itself is not persisted by this feature at all: a running command's output, status,
and delta cursor live in the compute's own `ComputeShell`, which is the host's to keep or drop when
it disposes the compute.
