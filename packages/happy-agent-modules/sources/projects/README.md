# Projects

A project is a folder. This module is the catalog of the folders an agent
works in: what each one is called, whether it is on disk, how far its setup
got, and what Git last said about it. The module owns those rows, their
settings, their order, their avatar bytes and its own migrations in the Agent
Base database — and it does the work those rows describe. Resolving a path,
importing a folder, cloning a remote, brokering the credential the clone needs,
probing a repository, deciding the trunk, holding the repository lock, storing
avatar bytes: all of it is this module's own. There is no host
object between the catalog and the disk.

```ts
import {
    AbortModule,
    ComputeModule,
    ConfigModule,
    DurableFunctionsModule,
    GitModule,
    ProjectsModule,
    SecretsModule,
} from "@slopus/happy-agent-modules";

const config = await ConfigModule.load();
const secrets = new SecretsModule();
const abort = new AbortModule(new ComputeModule(config, secrets));
const durableFunctions = new DurableFunctionsModule();
const projects = new ProjectsModule(config, new GitModule(), abort, durableFunctions);
```

| Module                                                    | What it answers                                                                                                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ConfigModule`](../config/README.md)                     | Where managed projects live, where the agent keeps its own state, whether cross-workspace work is on, and the GitHub token a clone of a private repository needs. |
| [`GitModule`](../git/README.md)                           | Every Git command, probe, clone and worktree, the credentials they carry, and who this copy of Git commits as.                                                    |
| [`AbortModule`](../abort/README.md)                       | How the agents standing in a project stop when it is archived, together with everything below them.                                                               |
| [`DurableFunctionsModule`](../durableFunctions/README.md) | Provisioning, archival, cleanup, restart recovery, checkpoints, and per-project operation locks.                                                                  |

Both `AbortModule` and the `ComputeModule` beneath it have to be installed on the
agent and started with it: the abort module learns the agent collection from its
`beforeStart` hook, and asking it to cancel anything before that throws.

There is no `rootContext`, no path string, no runner and no callback. Project
provisioning, archival, and cleanup are registered durable functions. Their calls,
checkpoints, locks, detached lifetimes, and restart recovery belong to
`DurableFunctionsModule`, not to a second queue in this catalog.

Two answers that used to be the composition root's are now owned deliberately:

- **The GitHub token is configuration's.** `ConfigModule.githubToken` is where a
  personal access token already lives, beside every other credential a person
  configures, and it is read at the moment a clone needs one.
- **The local Git identity is Git's.** `GitModule.localIdentity()` asks Git what
  this machine commits as, because running Git is what that module is for. The
  one profile a single-machine installation can resolve is named `local` inside
  this module; a caller never passes a profile resolver.

`open(localInstanceId)` supplies this installation's identity before Durable Functions recovers
unfinished project work. There is no project-owned provisioning queue to drain at shutdown.

## The record

`repositoryRef` is the project. It is the canonical absolute folder path, not
an opaque handle, and it is unique across the catalog: one row per folder. The
schema enforces that shape: an absolute path with no `.` or `..` segment and no
control characters, because an unnormalized path is not a folder this catalog
can key on.

- `kind` is `"home"` or `"regular"`. The home directory is the single `home`
  project, always named `Home`, always `ready`; nothing initializes it.
- `storageKey` is a portable kebab-case key, unique across the catalog, for the
  managed directories that belong to the project — its clone, and the folder its
  workspaces live under.
- `presence` is `"present"` or `"missing"` — whether the folder is on disk.
- `initializationStatus` is `"initializing"`, `"ready"` or `"failed"`, with
  `initializationAttempt` counting the attempts and `initializationError`
  holding a bounded message that exists only while the status is `failed`.
- `nameSource` is `"folder"`, `"user"` or `"remote"`. A folder-derived name
  may be replaced by the remote's name; a name a person chose never is.
- `defaultBranch` is the trunk workspaces are cut from. It is decided once.
- `worktreeSupport` is `"supported"`, `"unsupported"` or `"unknown"`, with
  `worktreeUnsupportedReason` set only when it is `unsupported`.
- `remoteSource` is `{ kind: "github", repository }` or `{ kind: "git", url }`
  for a project that still has to be cloned, and `requiredSecretKind` names
  the credential kind a retry needs. No secret material is stored here — and
  the `git` URL must be one a clone would actually run: HTTPS, with a host, and
  with no credentials embedded in it, so a URL that could only fail later is
  refused when it is recorded instead.
- `gitAhead`, `gitBehind`, `gitDetached`, `gitBranch`, `gitHead` and
  `gitUpstream` are what the last Git scan observed. They are a cache of the
  repository, refreshed by `reconcileGitFacts` and by the live watcher, never
  the thing a decision is made against.

Alongside those sit `status`, `orderKey`, `version`, `avatar`, `description`
and the `createdAt`/`updatedAt`/`archivedAt` timestamps. Timestamps are
bounded by a real date rather than `Number.MAX_SAFE_INTEGER`, and `archivedAt`
can never precede `createdAt`.

An image avatar is exactly `{ kind: "image", source, thumbhash }` on the
project, where `source` is `"user"` or `"generated"`. The normalized WebP and
its integrity metadata are read separately by project ID.

Settings are a bounded object, not arbitrary JSON: an optional
`defaultWorkspaceCompute` of `{ type: "local" }` or
`{ type: "docker", image }`. Anything else is rejected.

## Tools

Two durable, provider-neutral tools are available and never review in Auto mode:

- `list_projects` lists projects in their independent main-list order in bounded cursor pages.
- `set_project_avatar` takes a project ID and a PNG, JPEG, or WebP path inside that project's
  folder, then stores the normalized picture as a generated avatar.

Registering, renaming, archiving, reordering, and settings writes happen through the public API
below, on behalf of a person. A model may change only the avatar, through the bounded project-owned
image path accepted by `set_project_avatar`.

The tools exist only when both are true:

- `crossWorkspace` is on. The catalog spans every project on the machine, so
  reading it is exactly what looking outside the current project means, and the
  user's `features.cross_workspace` setting decides whether it is offered.
- The agent is somebody's own conversation. A subagent works inside the task it
  was handed and is given no view of the catalog.

When the tools are absent, a model has no project tools at all rather than a tool
that fails when it is called.

## Public API

Every operation receives `(ctx, agentId, ...)`. Each one that changes a row
bumps `version` and emits exactly one frozen event.

Reads:

- `list` returns a bounded page of the projects someone can still work in;
  archived rows are history and appear only with `includeArchived: true`. A page
  that ended exactly on the last row returns no `nextCursor`.
- `listCatalogPage` returns the same bounded store page without fitting it to a
  model-output budget. Internal consumers follow its cursor when every project
  matters.
- `get` reads by ID, `getByPath` reads by canonical folder path.
- `readSettings` returns the bounded settings record.
- `avatarAsset` reads the project's bounded normalized WebP by project ID,
  verifies its content hash, and returns its strong ETag and ThumbHash.

Folders, clones and Git — the module's own work:

- `resolvePath` finds the project a folder belongs to, importing the folder as a
  project if it is new. `register` validates and records one readable existing
  folder. A Git folder must be its repository root; an ordinary directory is
  equally valid and records Git as absent with unsupported worktrees, so child
  workspaces naturally become copied folders.
  `createRemote` records a project that still has to be cloned and starts the
  clone. `retryRemoteProjects` picks up the clones a newly available credential
  unblocks.
- `scheduleInitialization` converges on one stable durable provisioning call;
  `probe`, `resolveDefaultBranch` and `resolveRemoteName` read the repository
  and fold what they learn back into the row. Clone, probe, branch, name, and
  avatar steps are checkpointed independently. Remote calls additionally hold
  the shared `projects.clone` lock, so network clones run one at a time while
  local project setup remains independent.
- `runInProjectGitLock` is how every worktree of a project takes the one lock
  over its shared refs and reflogs — including the workspaces catalog, which
  takes it through here rather than keeping a second lock over the same
  repository.
- `gitForProject` returns the Git surface for a project, carrying the credential
  its clone needs. `registerGitCredential`, `refreshGitCredential` and
  `gitAuthentication` manage those credentials, which are never stored in a row.
- `reconcileGitFacts` and `recordGitFacts` refresh the Git cache from a scan.

Registration and catalog edits:

- `create` registers a folder and name; `ensure` registers a folder exactly
  once, converges in the same transaction, restores an archived row, and
  returns `{ project, created, changed }`.
- `rename`, `archive`, `restore`, `reorder`, `setAvatar`, `clearAvatar` and
  `updateSettings` all accept an optional `expectedVersion`. `setAvatar`
  accepts raw PNG, JPEG, or WebP bytes, normalizes them, computes their
  ThumbHash, and stores only the API-shaped metadata on the project.
  Archival cancels provisioning and schedules durable agent shutdown in the
  same transaction. Managed remote roots are deleted only after every child
  workspace has archived; restore cancels both archive and cleanup operations.

Lifecycle, each recording what was observed or done:

- `applyProbe` records presence, worktree support and optionally Git facts.
- `applyGitFacts` records branch, head, upstream and divergence.
- `setDefaultBranch` records the trunk, once.
- `adoptRemoteName` replaces the name only while `nameSource` is `"folder"`.
- `markCloneReady` marks the folder as present once the clone landed.
- `markInitializationReady`, `markInitializationFailed` and
  `retryInitialization` move a project through setup.
- `refresh` puts a project back in line for setup; it is a no-op for `home`.

Every one of these writes only when something actually changed. When the
observation matches what is already stored, or a guard says the change does
not apply, the operation returns the existing row untouched: no version bump,
no event. Archival is the terminal decision: a clone result, a probe, a setup
outcome or a refresh that was already in flight when a project was archived
describes a project nobody has any more, and changes nothing about it.
`restore` is how a project comes back.

Every guarded write asserts that it moved exactly the one row it was decided
against, at exactly the version it was read at, and rereads to confirm the
version advanced by one. A reorder is one transaction over the whole list, so
a catalog that moved underneath it is refused whole rather than left half in
the new order and half in the old.

`formatProjectForModel`, `formatPageForModel` and `formatSettingsForModel` are
public so a caller can render the same bounded text the tools use.

## Storage

The module owns the `projects` and `project_settings` tables through its
ordered Agent Base migrations. Migration `004-project-folder-record` drops and
recreates both tables rather than migrating column by column: an opaque
repository reference cannot be turned into a canonical folder path, and
inventing one would put unusable rows in front of a person. `repositoryRef`,
`kind`, `storageKey`, `presence` and `initializationStatus` are `NOT NULL`.
Database operations use `ctx.db`, and multi-step mutations compose with
`ctx.inTx(...)`.

Agent Base owns durable tool-call completion, while Durable Functions owns the
module's long-running filesystem operations. The project module does not maintain
a second receipt, startup sweep, in-memory queue, task registry, or replay system.
Concurrent ensure calls converge through the catalog transaction and the folder
uniqueness constraint.

Every changed mutation is represented by one frozen event: `project_created`,
`project_renamed`, `project_archived`, `project_restored`,
`project_reordered`, `project_avatar_updated`, `project_avatar_cleared`,
`project_settings_updated`, or `project_state_changed` carrying the reason the
lifecycle moved. Transactional and post-commit listeners receive the same
event object. `onEventTransactional(listener)` and `onEvent(listener)` take a
subscriber and return the call that ends the subscription; a post-commit
subscriber that fails is logged through the context's own logger and reaches
nobody else, because the change it describes is already durable. Registration
uses stdlib `afterCommit(ctx, ...)`.

Every non-creation event that carries a project also carries the complete
`previousProject`, so a subscriber can chain versions without rereading
mutable state. Avatar set and clear events are published only from the
transaction that commits both the project metadata and its image bytes.

Access is same-owner only. There is no installable authorization policy: a
project belongs to the agent that made it.

Migration `008-project-avatar-assets` appends the project-owned avatar table.
Its normalized WebP, content hash, ThumbHash, and dimensions commit atomically
with the project row. Replacing or deleting an avatar therefore cannot leave a
durable project pointing at stale or missing bytes.
