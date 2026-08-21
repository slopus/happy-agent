# Workspaces

A workspace is a folder an agent works in. In a Git project a workspace is a
worktree: its own checkout, on its own branch, cut from the project.

Every conversation already runs inside a workspace — the working directory. Most
work needs no workspace management at all. This document explains what a
workspace is, how one is created and archived, where it lives on disk, how to
start work inside another workspace, and when creating one is actually the right
call.

## What a workspace is

Happy Agent knows about _projects_ and _workspaces_:

- A **project** is a folder Happy Agent has been pointed at. It has an ID, a name, and a
  storage key derived from the name.
- A **workspace** belongs to one project. It has an ID, a name, a path, a status,
  and — when this session created it — an `owned` flag.

A workspace's status moves through `initializing` → `ready`, or ends at `failed`.
Archiving moves it to `archiving` and then `archived`. Only a `ready` workspace
can be worked in: starting an agent in one that is still initializing is
refused with a message saying so.

Managed workspaces require a Git repository project. `create_workspace` fails
with "Managed workspaces require a Git repository project." when the project
folder is not the top level of a repository. Copying the folder for non-Git
projects is planned, not implemented.

## Where workspaces live

Workspaces are created under a managed root, one directory per project:

```text
<workspaces root>/<project storage key>/<workspace storage key>
```

The root depends on the platform:

| Platform | Root                                                              |
| -------- | ----------------------------------------------------------------- |
| macOS    | `~/Happy/Workspaces`                                              |
| Linux    | `~/happy/workspaces`                                              |
| Any      | `HAPPY_AGENT_WORKSPACES_DIRECTORY` (absolute path) overrides both |

Storage keys are slugs of the display name (lowercase, ASCII, dashes, at most 48
characters). A collision gets a numeric suffix: `workspace`, `workspace-2`,
`workspace-3`. The absolute path is persisted when the workspace is reserved and
stays authoritative afterwards, so changing the root only affects new
workspaces.

Never guess a workspace path. Use the `path` that `create_workspace`,
`list_workspaces`, or `delegate_to_workspace` returns.

## Naming

A workspace is created with a placeholder name, and takes the name of its first
chat once that chat is named. Its branch follows: renaming a workspace, whether
the first chat does it or a person does, renames the Git branch to match. The
folder never moves, because a chat is already working inside it.

A workspace a person has named is never renamed again by a chat.

## How a workspace is created

`create_workspace` takes a human-readable `name` and an optional `base_ref`:

```json
{ "name": "Retry policy rewrite" }
```

What happens, in order:

1. **The base commit is resolved.**
   With no `base_ref`, Happy Agent fetches `origin` and forks `origin/<trunk>` — the
   trunk as the remote has it, not whatever the project folder happens to be
   checked out on. It falls back to the local branch when there is no reachable
   `origin`. An explicit `base_ref` is used exactly as given, and an unknown ref
   is an error. Fetching only writes remote-tracking refs and objects; the
   project's own working tree, `HEAD`, and local branches are never touched.
2. **The workspace row is reserved** with a unique name, storage key, and path,
   and the workspace is published as `initializing`. The tool returns at this
   point.
3. **The worktree is materialized in the background**: `git worktree add -b
worktree/<branch key> <path> <commit>`, then Git's answer is verified — the
   worktree must be at exactly the requested path and belong to the expected
   repository.
4. **Configured sync files are replicated** — every path in `workspace.sync`
   and `workspace.protected_sync` that exists in the project root is copied
   into the workspace. This shares files Git cannot provide, such as gitignored
   `.env` files. While the daemon runs, the project root's copies are watched
   and re-copied to every ready workspace whenever they change. Sync is
   one-way and best-effort: the root copy always wins, deletions in the root
   are not replicated, and a missed event catches up on the next change. Paths
   in `protected_sync` are additionally write-protected in workspaces, exactly
   like `permissions.protected_paths`, so sessions cannot modify their copy
   without Full access.
5. **Setup commands run** — `workspace.setup_commands` from the configuration
   loaded inside the new workspace (for example `pnpm install --frozen-lockfile`).
6. The workspace is marked `ready`. A failure at any step marks it `failed`.

Two consequences worth remembering:

- A worktree is **always** a branch, created with the worktree, named
  `worktree/<branch key>` — the workspace name in kebab-case, with a numeric
  suffix when Git or another workspace already holds it. Other tooling keys off
  branch names, so do not rename branches casually.
- Creation is not instant: the checkout and its setup commands take real time,
  and a fresh workspace has no warm build cache or context.

Creation is idempotent by identity: repeating a create with the same requested
ID answers with the same workspace rather than making a second one. One create
never produces two entries.

## Ownership

A workspace records the session that created it. Only that session may:

- archive it with `archive_workspace`;
- start a hidden workspace agent in it with `spawn_workspace_agent`.

`list_workspaces` marks these with `owned: true`. A workspace created by another
session is not yours to move into. Reuse an existing workspace only to continue
the work already living in it, or when the user explicitly points you at it. If
coordinating across tasks seems to genuinely require somebody else's workspace,
ask the user first.

## Archiving

Archiving is an immediate, irreversible logical action. `archive_workspace` marks
the workspace `archiving`, stops its setup work, and removes it from the active
list; removing the worktree and the folder is background cleanup afterwards. If
cleanup fails the workspace still ends up archived and the failure is logged —
archival is never rolled back because a folder could not be deleted.

Archive an owned workspace when its work is finished or abandoned. Do not keep
workspaces around "for later": a later task gets a fresh one.

`archive_workspace` is reviewed in Auto mode, and the review text names the
workspace and says its managed worktree will be removed.

## Working inside a workspace

Work in a workspace runs _from inside_ it. There are two ways to start it, and
they differ in whether the user sees a conversation.

### `spawn_workspace_agent` — hidden subagent

Starts a managed subagent whose working directory is the workspace. It does not
appear in the user's session list; it appears under your session as a subagent
and reports its result back to you.

```json
{
    "workspace_id": "ws_...",
    "description": "Port the retry policy",
    "prompt": "Full instructions...",
    "provider": "codex",
    "model": "openai/gpt-5.6-sol",
    "reasoning_effort": "medium",
    "background": true
}
```

It returns `{ sessionId, taskName, path, status, output }`. Background agents are
the default; read their output with `TaskOutput` (or your provider's equivalent),
stop them with `TaskStop`, and send follow-up work with `SendMessage`. `read_only:
true` restricts the child to Read only instead of inheriting your permission mode.
Model and reasoning effort are required. `provider` is optional and selects a
specific visible account when the user's request calls for one; otherwise Happy Agent
resolves and routes the provider. `context: "parent"` includes the delegator's
conversation; the default, `"task"`, starts with only the prompt.
`service_tier: "priority"` requests priority service when supported.

Use this when the workspace's work is _your_ work, delegated for isolation, and
the user only needs your final answer.

### `delegate_to_workspace` — visible session

Starts a full, user-visible conversation in the workspace. It gets its own place
in the session list, keeps your session as its parent, and can be reached
afterwards through `agent_info` + `agent_send` with the returned `agentId`.

```json
{
    "workspace_id": "ws_...",
    "title": "Retry policy rewrite",
    "prompt": "Full instructions...",
    "provider": "codex",
    "model": "openai/gpt-5.6-sol",
    "reasoning_effort": "medium"
}
```

It returns `{ agentId, sessionId, projectId, title, workspaceId, workspacePath }`.
Model and reasoning effort are required here too. `provider`, `read_only`, and
`service_tier` are optional and have the same meaning as for a hidden workspace
agent.

When the delegated run finishes, you receive a notification with its status and
result. Messages the user writes in that conversation stay there.

`delegate_to_workspace` is reviewed in Auto mode, because it starts a user-visible
agent working outside your own workspace. Only a primary session can delegate —
a subagent cannot — and you cannot delegate into the workspace you are already
working in.

### The rule that matters

Never start an agent in your own directory and have it reach into another
workspace's folder by path. An agent whose working directory is one workspace
must not edit files in another. Start it _in_ the workspace with
`spawn_workspace_agent` or `delegate_to_workspace`.

## Inspecting what exists

- `list_workspaces` — workspaces of your project, or of another project when you
  pass `project_id` (that needs cross-workspace access). Listing is for
  inspecting and following up on existing work, **not** for shopping for a
  workspace to reuse.
- `list_workspace_sessions` — conversations of a project or of one workspace,
  most recently active first. Each entry carries `id`, `agentId`, `title`,
  `status`, `updatedAt`, and `delegatedBy` when an agent started it. The
  `agentId` is what you pass to `agent_info` / `agent_send`.
- `list_projects` — every project on the machine. Requires cross-workspace access.

## When to create a workspace

A separate workspace exists to **isolate** work, not to organize it.

Create one when a piece of work will run alongside other work and their changes
could collide. That is the only criterion — not the number of tasks, not their
size.

**Create a workspace when:**

- you are starting two or more tasks that will edit the same repository at the
  same time; each gets its own fresh workspace;
- a long-running piece of work must proceed without disturbing the branch the
  user is looking at.

**Do not create a workspace when:**

- the work is a subtask of what you are already doing — that belongs in the
  current workspace, however many subagents help with it;
- you just want tidier organization; a workspace is a full checkout with its own
  dependencies and its own cold context, and that cost has to be bought by real
  isolation;
- two parallel tasks could be squeezed into one workspace — they must not be.

One task, however many hands, is one workspace.

## Availability and configuration

The workspace tools appear only in a **primary session** (never in a subagent)
and only when `features.workspaces` is enabled — it is on by default.
`list_projects` additionally requires `features.cross_workspace`; when that is
off, the tool is not offered at all rather than failing when it is called.

Relevant configuration keys:

```toml
[features]
workspaces = true
cross_workspace = false

[workspace]
setup_commands = ["pnpm install --frozen-lockfile"]
# Project files copied into every workspace and re-copied whenever the project root
# copy changes, such as gitignored .env files. Sync is one-way: the root copy wins.
sync = [".env"]
# Synced like sync, and additionally protected from writing without Full access.
protected_sync = [".env.production"]
```

## Tracking changes

For a workspace branch, the baseline for "what changed" is the branch's merge
base with `origin/main`; local `main` is never used. Happy Agent tracks changes
line by line, detects binary files, and handles large files separately.
