# Git

Everything the product does with a repository. `GitModule` reads facts and change snapshots, probes
a folder, clones a remote, cuts and retires worktrees, renames branches, brokers repository
credentials, and watches repositories for change. It has no database, no migrations, no tools, and
no protocol or HTTP coupling.

```ts
const git = new GitModule();
```

The constructor takes nothing. The module reaches Git itself: unattended reads go through the
hardened read-only scanner, while mutations, fetches and clones use the foreground boundary. Cache
lifetime, cache size, the snapshot file cap and the watch batch cap are internal constants, and the
module reads the clock and mints its own identity.

`GitModule.withRunner(runner)` is the one alternate construction, and it exists for tests: it
replaces the whole execution boundary with a supplied one so a test can watch which commands were
issued or make one fail. Production never uses it.

It is an `AgentModule` (`name = "git"`). `beforeStart` adopts the collection's lifetime for its
watchers and background scans and returns no hooks. A caller that uses the module without an agent
collection still works — it takes a lifetime of its own.

## The surface

- **Paths and names.** `normalizeProjectCwd`, `normalizeFuturePath`, `remoteProjectName`,
  `parseHostingRepository`, `remoteUrlForSource`, `supportsRecursiveWorktreeWatch`.
- **Running Git.** `run(cwd, args, options)` returns exit status and both streams so a caller can
  read a failure without losing Git's own text. `readOnly(cwd, args)` is the unattended read: it
  disables prompts, optional locks, lazy fetches, hooks, credential helpers, fsmonitor and external
  diff programs, and bounds both time and output.
- **Reading a repository.** `probe`, `facts`, `topLevel`, `commonDir`, `worktreeIdentity`,
  `isWorktreeAt`, `defaultBranch`, `selectRemoteUrl`, `resolveCommit`, `resolveComparisonBase`,
  `readFileAtRevision`, `listWorkingTreeFiles`, `countUntrackedFileLines`.
- **Changing a repository.** `clone`, `resolveWorkspaceBase`, `createWorktree`, `removeWorktree`,
  `renameBranch`.
- **Credentials.** `registerCredential`, `commandAuthentication`, `daemonAuthentication`,
  `revokeCredentials`. A repository token never reaches Git: it stays in this process behind a
  loopback proxy that serves only the repository it was registered for. Any method that touches a
  private repository takes `{ credential: { projectId, creator } }` and resolves the environment
  itself, so no caller ever holds a Git runner of its own.
- **Snapshots.** `generation`, `snapshot`, `watch`, `invalidate`.
- **Live tracking.** `track`, `untrack`, `replaceTracked`, `markChanged`, `trackedSnapshot`,
  `trackedKeys`, `liveSnapshots`, `refresh`, and `onSnapshot(observer)` which returns its own
  unsubscribe.
- **Shutdown.** `dispose` stops every watcher, clears the cache and closes the credential broker.

## Behavior worth knowing

A snapshot compares the branch with its merge base against `origin/main`; local `main` is never
used. It combines committed, staged, unstaged, conflicted and untracked work, detects binary files,
keeps totals separate from the capped display list, omits files larger than the display limit, and
carries both old and new bytes for binary deltas that remain displayable.

Watching is a subscription, not a scan. Worktrees share physical watchers for their common Git
directory and refs, while ref events fan out only to worktrees whose branch, upstream, or
`origin/main` comparison can change. Recursive working-tree events are debounced and first checked
with a path-scoped status, so ignored build output does not schedule the full snapshot scan. Full
rescans run two at a time on the module's own lifetime. A single stale deadline is the fallback for
missed events; renewing an unchanged subscription only extends its lifetime and does not make it
dirty. Platforms without recursive working-tree watches use a shorter stale deadline.

A repository that has not been scanned yet simply has no snapshot to report. Subscribers hear only
about repositories that actually changed, and a subscriber that throws is treated as a failed
delivery rather than a successful one, so the same snapshot stays pending behind the watcher's
bounded backoff and is offered again. Watcher and scan failures are logged through `ctx.log`; nothing
calls back to report them.

Worktree deletion and adoption rely on both top-level and shared common-directory identity, and
refuse symbolic-link destinations. A clone runs in a private staging directory and is renamed into
place only after its identity is proved, so a failed or interrupted clone never exposes a partial
project.

## Boundaries

`GitModule` is the whole feature. `index.ts` publishes the class and the types callers need to speak
about what its methods take and return — the commands themselves are private to this folder. When
something outside needs Git behavior there is no method for, add the method here rather than
importing a file out of this directory.
