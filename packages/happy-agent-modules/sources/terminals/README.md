# Terminals

Real interactive terminals on a project folder, or on one of that project's managed workspaces.

A terminal here is not an agent's shell command and not a chat. It is a pseudo-terminal a person
types into, and it belongs to the folder rather than to whoever opened it: everybody looking at the
same project or workspace sees the same collection. The module owns three things per terminal — the
process, the one canonical Ghostty emulator it writes into, and the
[`@slopus/ghostty-web`](../../../ghostty-web/README.md) protocol server that keeps every attached
replica in step with that emulator.

Nothing here is durable, and that is the point. A terminal is a running process and a live screen,
and both end with the daemon that started them. A stored record would only describe something
nobody can attach to.

## Public API

The module has no model-facing tools. A terminal is a place a person works, not a capability an
agent calls, and everything below is a host operation.

| Method                                            | What it does                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `create(ctx, agentId, scope, input)`              | Opens one terminal in the folder that scope names.                  |
| `list(ctx, agentId, scope)`                       | Every terminal open on that folder, running and finished.           |
| `get(ctx, agentId, scope, terminalId)`            | One terminal's record.                                              |
| `session(ctx, agentId, scope, terminalId)`        | The live terminal, for a caller about to attach a stream.           |
| `attach(ctx, agentId, scope, terminalId, stream)` | Attaches one duplex stream, returning the call that detaches it.    |
| `resize(ctx, agentId, scope, terminalId, input)`  | Resizes the process, the canonical emulator, and every replica.     |
| `stop(ctx, agentId, scope, terminalId)`           | Kills the process at once. The record stays, holding the exit code. |
| `closeScope(scope)` / `closeProject(projectId)`   | Ends a folder's terminals when the folder itself goes away.         |
| `close()`                                         | Ends everything and opens nothing more.                             |

A scope is `{ projectId }` or `{ projectId, workspaceId }`. A project and its workspaces are
separate collections, because they are separate folders.

The module subscribes to both catalogs when it is built. Archiving a workspace ends that
workspace's collection and archiving a project ends every collection under it, so a shell is never
left standing in a folder that is about to be deleted. Neither catalog knows terminals exist.

The closing runs behind the archival rather than inside it: an archive answers as soon as its
decision is durable, and the shells die on their own lifetime, which is why `close()` waits for
those closures to settle before it returns. A folder being closed stops accepting terminals the
moment its closure starts, so a `create` racing an archive is refused instead of opening a shell in
a folder that is going away.

## What it depends on

The two catalogs that own the folders, given directly:

- [`ProjectsModule`](../projects/README.md) — where a project's checkout is, and whether the
  project is archived.
- [`WorkspacesModule`](../workspaces/README.md) — where a managed worktree is, which project it
  belongs to, and whether it is ready to be worked in.

Both are required. A terminal never derives a path of its own, so the catalog that decided where a
folder is is the only thing it will ask.

Everything else the module does itself. Production always spawns a real pseudo-terminal; the one
test-only seam is `TerminalsModule.withProcessFactory(projects, workspaces, factory)`, which
replaces that boundary so a test can drive the lifecycle without a shell. There is no constructor
option for it, because nothing in the product supplies one.

```ts
import {
    AbortModule,
    ComputeModule,
    ConfigModule,
    GitModule,
    ProjectsModule,
    TerminalsModule,
    WorkspacesModule,
} from "@slopus/happy-agent-modules";

const config = await ConfigModule.load();
const git = new GitModule();
const abort = new AbortModule(new ComputeModule(config));
const projects = new ProjectsModule(config, git, abort);
const workspaces = new WorkspacesModule(config, projects, git, abort);
const terminals = new TerminalsModule(projects, workspaces);
```

Every module here — including the compute beneath abort — is installed on the agent. A catalog
whose abort module was never started refuses to archive rather than leaving live work behind.

## Bounds

| Thing                | Limit                          |
| -------------------- | ------------------------------ |
| Columns              | 1–500, 80 by default           |
| Rows                 | 1–200, 24 by default           |
| Scrollback rows      | 0–100,000, 10,000 by default   |
| Terminals per folder | 32 (`MAX_TERMINALS_PER_SCOPE`) |
| Command              | 8,192 characters               |

Reaching the terminal limit discards a terminal that has already finished. When every terminal is
still running the limit is real, and the request is refused rather than quietly killing someone's
work.

## Refusals

`TerminalError` carries a `code` a caller turns into a status: `not_found` for a project,
workspace, or terminal nobody has; `conflict` for an archived project, a workspace that is not ready,
a stale scrollback basis, or a folder already at its limit; `invalid` for settings that are not
terminal settings; `unavailable` once the module has closed.

## Storage

None. The module owns no table and runs no migration.
