# Workspaces

A workspace is one place an agent actually works: a branch, a folder, a base it came from, and a
lifecycle that says whether it is usable yet. The module owns that catalog and its migrations in the
Agent Base database, it owns the _decisions_ — which name, which branch, which folder key, which
status — and it does the Git and filesystem work those decisions imply. Cutting the worktree,
copying the folder, running the setup commands, replicating the shared files, renaming the branch,
and removing an archived folder are all this module's own work. There is no host object between the
catalog and the disk.

The important consequence is ordering: the durable reservation happens **first**, and Git happens
after. A workspace row exists, with a unique name, storage key, and branch, before anything touches
the disk. That is what makes creation collision-safe across concurrent sessions and what makes a
crashed creation recoverable rather than a half-made worktree nobody recorded.

```ts
import { Agent } from "@slopus/happy-agent-base";
import {
    ConfigModule,
    GitModule,
    ProjectsModule,
    WorkspacesModule,
} from "@slopus/happy-agent-modules";

const config = await ConfigModule.load();
const git = new GitModule();
const projects = new ProjectsModule(config, git);
const workspaces = new WorkspacesModule(config, projects, git);
const agent = await Agent.create(ctx, { ...options, modules: [projects, workspaces] });
```

Three modules, and nothing else.

| Module                                    | What it answers                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ConfigModule`](../config/README.md)     | Where managed workspace folders live, whether managed workspaces are on at all, and what a workspace folder does by default — setup commands, sync paths, what is kept on archive. |
| [`ProjectsModule`](../projects/README.md) | The project's folder, its credential, its repository lock, and the vocabulary a workspace names things with.                                                                       |
| [`GitModule`](../git/README.md)           | Worktrees, branches, clones, and every path Git is handed.                                                                                                                         |

The dependency on projects is one-way. A workspace is a branch of a project's repository, in a
folder under that project's key, cut from the trunk that project decided on, and every worktree of
a project shares one set of refs — so the projects catalog owns the folder, the credential and the
repository lock, and this catalog takes all three through it. Archiving a project archives
everything cut from it, which this module arranges by subscribing to the projects catalog's own
events inside that transaction rather than by being called back.

There is no `rootContext`, no path string, no settings object and no injected runner. The lifetime
the module's Git and filesystem work runs on is derived from the first context it is used with: a
checkout, a setup command or a folder removal outlives the call that asked for it, so it never runs
on the caller's context. A detached context deliberately carries no storage, so the catalog puts the
agent database back on that lifetime itself.

This catalog does not name anything. A workspace created from a client is called something like
"Workspace 3" until a chat working in it settles on something better, and the module that thinks of
that name is [titles](../titles/README.md): it asks, and then renames the workspace here through
`inheritName`. What a folder and a branch are called is this catalog's to write down and nobody
else's, but what they should be called is not a question it asks.

The catalog records agent placement separately from workspace lifecycle: an agent's workspace is
permanent, and its `orderKey` orders it among that workspace's agents. Repeating the original
attachment is idempotent; attaching the same agent to another workspace is refused. Agent identity
and lifecycle remain in Agent Base. Identities are `crypto.randomUUID()` and time is `Date.now()`,
both the module's own.
`WORKSPACE_PAGE_SIZE` (50) and `MAX_WORKSPACE_OUTPUT_CHARACTERS` (12,000) bound paging and
model-facing text. `onEventTransactional(listener)` and `onEvent(listener)` take a subscriber and
return the call that ends the subscription. When the module's own folder removal or branch rename
throws, it is logged through the context's own logger, so the durable record stands while the
failure is still visible.

`open(ctx, agentId)` picks up whatever the last run left unfinished — every workspace still being
created is carried through to a usable checkout — and `close(ctx)` stops every background lifetime
and waits for the ones in flight.

## The record

Every field below is present on every row. `branch`, `storageKey`, `path`, and `kind` are mandatory
in the schema _and_ `NOT NULL` in the table, because software downstream of this module now depends
on a workspace being able to answer "which branch?" and "which folder?" without a null check.

| Field                                                            | Meaning                                                                                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `projectRef`, `parentId`                                   | Identity, the project containing the workspace, and its parent. `projectRef` itself is the project's implicit root, so no duplicate root workspace row exists.         |
| `name`, `nameConfigured`                                         | Display name, and whether a person chose it. An inherited name may be replaced silently; a configured one may not.                                                     |
| `branch`                                                         | The Git branch, mandatory. Derived as `worktree/<kebab-name>` unless a caller supplies one.                                                                            |
| `storageKey`                                                     | The kebab-case folder key, mandatory and unique within the project.                                                                                                    |
| `kind`                                                           | `"git_worktree"` or `"directory"`.                                                                                                                                     |
| `path`                                                           | The absolute filesystem path, mandatory and globally unique.                                                                                                           |
| `baseRef`, `baseCommit`                                          | What the workspace was cut from, and the exact commit if known.                                                                                                        |
| `gitCommonDir`                                                   | The shared `.git` directory a worktree belongs to, for cleanup.                                                                                                        |
| `presence`                                                       | `"present"` or `"missing"` — whether the folder is still on disk. A reservation starts `missing`, because the durable row is written before anything touches the disk. |
| `status`                                                         | `initializing`, `ready`, `failed`, `archiving`, or `archived`. There is no `active`.                                                                                   |
| `orderKey`                                                       | A fractional order key; lexicographic order is the order among one parent's children. New reservations lead that sibling list.                                         |
| `version`                                                        | An integer bumped on every durable change, and the token for optimistic concurrency.                                                                                   |
| `creatorSessionId`                                               | The session that asked for it, if any.                                                                                                                                 |
| `gitAhead`, `gitBehind`, `gitDetached`, `gitHead`, `gitUpstream` | What the last Git scan observed.                                                                                                                                       |
| `initializationAttempt`, `initializationError`                   | How many initialization runs have been tried, and why the last fatal attempt failed.                                                                                   |
| `createdAt`, `updatedAt`, `archivedAt`                           | Timestamps; `updatedAt` is forced to advance on every change.                                                                                                          |

## Lifecycle

`reserve` → the module cuts the worktree or copies the folder → `recordInitialization` (base commit
and common dir) → the first file replication and setup commands → `markReady`. Setup commands are
best-effort: an install or another project-owned command may fail and write a warning without
discarding the valid checkout. Git, folder creation, parent validation, and initial file replication
still use `markInitializationFailed` when they fail; `markFailed` is the terminal form.
`applyGitFacts` and `applyProbe` fold in what a later scan observed — `applyProbe` is ignored unless
the workspace is ready, so a probe racing initialization cannot resurrect a row, and both are
ignored once the workspace is archived, because an observation that was already in flight describes
a workspace nobody has any more.

Archival is two steps on purpose. `beginArchive` is the durable decision and moves the row to
`archiving` immediately, and that is what `archive` returns. Folder removal does **not** run in the
caller's lifetime: it is started on the catalog's own background lifetime, and `completeArchive`
moves the row to `archived` when it finishes. A tool call therefore returns as soon as the decision
is durable — with status `archiving` — however long a folder takes to delete. If removal throws, the
workspace stays `archiving` and the failure is logged — **cleanup failure never rolls archival
back**. A
person who archived a workspace does not get it handed back because a folder would not delete.
`whenCleanupSettles()` waits for the removals this module started, for shutdown and for tests.

## Tools it provides to the model

- **`create_workspace`** — `{ projectRef, name, baseRef? }`. Reserves one workspace owned by the
  calling agent. `projectRef` is required: a workspace belongs to a project, and there is no
  fallback project to put an unclaimed one in. The tool passes its call ID as the operation ID, so
  a retried call after a crash resolves to the same workspace rather than a second one. The input stays minimal on purpose: `name` is a title a person would recognise,
  not a slug or a path, and the module derives the storage key and branch from it.
- **`rename_workspace`** — `{ workspaceId, name }`. Renames an owned workspace, marks the name as
  configured, and moves the Git branch with it.
- **`list_workspaces`** — `{ projectRef?, includeArchived?, cursor?, limit? }`. A page of the
  calling agent's workspaces in list order, capped at `maxPageSize` (100 by default). Archived
  workspaces are history and are left out unless `includeArchived` is passed.
- **`get_workspace`** — `{ workspaceId, cursor?, limit? }`. One workspace rendered as a bounded
  detail string, paged so a small output budget cannot silently drop identity or lifecycle fields.
- **`archive_workspace`** — `{ workspaceId }`. Archives one workspace, with the two-step semantics
  above.
- **`get_workspace_branch_metadata`** — `{ workspaceId, cursor?, limit? }`. The workspace's branch as
  Git has it right now, paged the same way.

There is deliberately no model tool for `recordInitialization`, `markReady`, `markFailed`,
`markInitializationFailed`, `setBranch`, `inheritName`, `reorder`, `beginArchive`,
`completeArchive`, `applyGitFacts`, or `applyProbe`. Those are lifecycle transitions driven by what
Git actually did; a model guessing at them would be inventing state.

Governing principles across all six tools:

- Read, create, and rename tools use `shouldReviewInAutoMode: () => false`. Archive uses
  `shouldReviewInAutoMode: () => true` and discloses its destructive filesystem effects to the Auto
  reviewer. It does not declare `shouldRunInFullAccessInAutoMode`; review does not grant
  unsandboxed execution.
- `create_workspace`, `rename_workspace`, and `archive_workspace` are durable transactional tools.
  The three read tools are non-durable because a current read does not need replay.
- Every result the store returns is re-validated against its schema and cross-checked against a
  fresh authoritative read before it is trusted. The store's `changed` flag must agree with an
  actual before/after comparison, and a changed row must have advanced its `version`; a mismatch
  throws rather than passing bad state to the model.
- Every page and detail string is re-clipped to `MAX_WORKSPACE_OUTPUT_CHARACTERS`, never truncated
  silently.
- Ownership is enforced on every read and mutation: acting on another agent's workspace is refused.

### Paging

One convention across all three paged reads: pass `cursor` and `limit` in, receive `cursor`,
`nextCursor`, and `total` back. `cursor` is an integer offset. This replaces the three different
conventions the module used to carry (`cursor`/`nextCursor`, `detailOffset`/`nextDetailOffset`, and
an opaque string cursor).

## External functions

All methods take `(ctx, agentId, ...)` and live on `WorkspacesModule` — `agentId` is passed
explicitly on every call, not bound to the instance.

Building a workspace:

- `createWorkspace(ctx, agentId, projectId, request, creatorSessionId?, options?)` — the whole
  operation a person asks for. It reserves the workspace against a live snapshot of the project's
  refs and managed directory, then starts the checkout in the background, so the caller is not held
  while Git works.
- `reconcileInitializingWorkspaces(ctx, agentId)` — carries every workspace that is still being
  created through to a usable checkout. `open` calls it.
- `removeArchivedWorkspace(ctx, agentId, projectId, workspaceId)` — deletes an archived workspace's
  folder and moves the row to `archived`.
- `inheritName(ctx, agentId, { workspaceId, name })` — gives a workspace the name its first chat
  arrived at. A workspace someone has already named keeps that name: only a placeholder is replaced.
- `resolvePath`, `resolveSessionOwnership` — what owns a directory, and the explicit durable owner of
  a new session. Both answer with a `ResolvedProjectOwnership`.
- `reconcileGitFacts(ctx, agentId)` and
  `recordGitFacts(ctx, agentId, workspaceId, facts)` — re-derive presence and Git facts, and persist
  what a live scan observed.

Creation and naming, at the catalog level:

- `reserve(ctx, agentId, input, hooks?): Promise<{ created, workspace }>` — collision-safe
  reservation. `input` requires `projectRef`, and its `path`, when given, must be an absolute
  normalized path. `hooks` carries the caller's predicates (`isBranchUnavailable`,
  `isStorageKeyUnavailable`, `pathForStorageKey`) separately because functions cannot be
  structured-cloned; all three must be answerable, from the hooks or from the module's own Git ref
  snapshot, or the reservation refuses.
  A reservation with no explicit `id` takes its identity from `operationId`, so a tool call retried
  after a crash reserves the same workspace. `created` is the store's authoritative flag, so
  replaying the same workspace ID returns `created: false` with the same row. A replay that
  describes different work — another project, a different base or base commit, a different kind,
  common directory, name or storage seed, a different owner or creator session — is refused instead
  of quietly rewriting the reservation. Losing the race for a name is not an error: the module
  re-picks from a fresh snapshot rather than surfacing a uniqueness conflict.
- `rename(ctx, agentId, input): Promise<Workspace>` — takes an optional `expectedVersion` and
  refuses a stale rename. Sets `nameConfigured: true`.
- `inheritName(ctx, agentId, input): Promise<Workspace>` — replaces the name only while
  `nameConfigured` is false.
- `setBranch(ctx, agentId, input): Promise<Workspace>` — records the branch Git actually ended on.

Lifecycle:

- `recordInitialization`, `markReady`, `markFailed`, `markInitializationFailed`, `applyGitFacts`,
  `applyProbe` — each returns the authoritative `Workspace`.
- `beginArchive`, `completeArchive`, and `archive` — the last commits the decision, starts folder
  removal on the catalog's own background lifetime, and returns the `archiving` row without waiting
  for it. `whenCleanupSettles()` waits for those removals.
- `reorder(ctx, agentId, input)` — `{ workspaceId, afterId, expectedVersion? }`; `afterId: null`
  moves a workspace to the top.

Reading:

- `listPage(ctx, agentId, query?)` and `list(ctx, agentId, query?)` — active workspaces only
  unless `includeArchived: true` is passed.
- `get(ctx, agentId, workspaceId)`, `getByPath(ctx, agentId, path)`, and
  `getPage(ctx, agentId, workspaceId, query?)` — `getPage` returns `{ workspace: null }` for an
  unknown ID instead of throwing.
- `branchMetadata` and `branchMetadataPage`.
- `formatForModel`, `formatPageForModel`, `formatDetailPageForModel`,
  `formatWorkspaceOperationForModel`, `formatWorkspaceForModel`,
  `formatBranchMetadataDetailPageForModel`, `formatBranchMetadataForModel` — the exact rendering
  each tool's `toLLM` uses, exposed so a caller can show the same text outside a tool call.

What a folder key means is the catalog's to answer, and it answers directly:
`pathForStorageKey(projectRef, storageKey)`, `isBranchUnavailable(projectRef, branch)`,
`isStorageKeyUnavailable(projectRef, storageKey)`, and
`nameWithPreservedPrefix(current, generated)` — the last is what [titles](../titles/README.md) asks
so a generated name keeps the number a person sorts by. There is no host object holding these.

Naming helpers are exported too: `workspaceNameKey`, `workspaceStorageKey`, and
`workspaceBranchName` derive the collision key, the kebab folder key, and the `worktree/<key>`
branch. Collisions are suffixed the way a person would expect — `Name (2)` for names, `key-2` for
keys and branches.

## Events

Every changed mutation emits a `WorkspaceEvent`: `workspace_created`, `workspace_updated` (carrying
a `change` naming the transition), `workspace_renamed`, `workspace_reordered` (with
`previousOrderKey`), `workspace_archived`, `workspace_agent_attached`,
`workspace_agent_reordered`, or `workspace_agent_visibility_changed`. Each carries `eventId`, `at`,
and the resulting workspace. A subscriber taken by `onEventTransactional(listener)` runs inside the
same store transaction as the mutation, so a subscriber that throws rolls the mutation back with
it. A subscriber taken by `onEvent(listener)` runs only after that transaction has durably
committed, receiving the identical frozen event object; a failure there is logged and reaches
nobody else — it never fails the mutation that already happened. Both return the call that ends the
subscription.

## Storage

The module owns `happy_agent_module_workspaces` through its ordered Agent Base migrations.
Migration `004-workspace-git-record` drops and recreates the table rather than migrating it column
by column: a workspace is now a branch, a folder, a base, and a lifecycle instead of an opaque
catalog row, and the old rows could not describe a real worktree anyway. Happy Agent is early stage, so
that trade is the honest one. Unique indexes cover `path`, `(project_ref, branch)`,
`(project_ref, storage_key)`, and `(project_ref, name_key)`; listing is ordered by
`(project_ref, order_key, id)`.

Every runtime database operation uses `ctx.db`; direct multi-step mutations use `ctx.inTx`.
Post-commit notification uses stdlib `afterCommit(ctx, ...)`. Each mutation is one
read-decide-write-reconcile transaction, and Agent Base owns transactional tool completion.
