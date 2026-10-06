# Git learnings

## Internal Git events must not launch worktree scans

Recursive Windows watches also report object packs, lock files and reflogs under `.git`.
Classifying each event launched an unnecessary sandboxed PowerShell/Git command. Those paths
now stay with the dedicated metadata watchers; ordinary source changes still reach Git status.
Direct Git operations and clones explicitly hide their background console windows.

## Every repository has a comparison base

Comparison used to require a merge base with a literal `origin/main`, and an unborn branch had
none on purpose. That left Changes and the sidebar counts empty for every project the agent
creates in a new folder (no commits, no remote), for `master` and other default branches, and
for branches unrelated to origin/main — new projects, exactly where users look first, showed
nothing. The user reversed the earlier decision.

The base is now the first that exists: the merge base with `origin/<default branch>` (from
`detectGitDefaultBranch`), the merge base with the local default branch when the remote has none
(matching how workspaces are cut without a remote), HEAD itself (uncommitted work only), and for
an unborn branch the empty tree, named by `git hash-object -t tree /dev/null` so sha256
repositories work. A remote base still wins whenever it exists, so a moved local main never
replaces it. Comparison is unavailable only when Git itself cannot be read. Because the base can
now come from a local branch or appear later, a snapshot records `baseRef`, and a worktree
without a remote base also rescans on its local default branch and on any `origin` ref.

A typed "why unavailable" field for clients was proposed alongside this and dropped: with these
fallbacks the only cause left is a failed Git read, which a client's "temporarily unavailable"
message already describes correctly, so the protocol did not change.

## A missing revision is not a missing file

Git's path lookup can say a file does not exist in an object even when that object itself is
missing. Historical reads now verify that the revision names a tree before classifying path
absence. Unknown or unavailable history remains an operational failure; only an absent path
within an existing tree returns `found: false`. Oversized blobs have a typed error so bounded
viewers can explain their limit without parsing Git's human-readable output.

## Idle repositories must cost nothing

Linux had no working-tree watch, so every tracked repository — every workspace the phone knew
about, renewed each minute — got a full scan every thirty seconds: status over the whole tree, a
rename-detecting diff against the merge base, and reads of untracked and binary files. On a server
with many workspaces this showed up as periodic IO storms. Working trees are now watched on every
platform, with Git-ignored directories excluded from the Linux Parcel watch so inotify
spends hundreds of watches per checkout instead of tens of thousands. Polling remains only as the
fallback for a tree that cannot be watched, backs off while nothing changes, and proves "nothing
changed" with a status and a stat of each changed path before it will run a diff.

## A working-tree watch must never be replaced or outlive its folder

Two watcher failures surfaced only in the release gate. On Linux, replacing a folder's Parcel
subscription with a narrower one after `.gitignore` changed left the new subscription registered
but deaf, because both share the backend's cached directory tree; a folder now keeps one
subscription for life and events from newly ignored directories are filtered instead. Native
subscribe and unsubscribe calls are serialized process-wide, because a watch opened while the
backend was tearing down after its last close attached to the dying backend.

On Windows, a stopped daemon left its workspace folder undeletable (`EBUSY`). The watcher had
started a sandboxed `git ls-files` in the folder to learn what to ignore, and a process whose
working directory is a folder keeps it locked on Windows even after its parent exits. Windows
watches recursively in the kernel, so it no longer lists ignored directories at all and keeps
Node's `fs.watch`; everywhere, closing a watch aborts a listing still in flight.

## A missing workspace must not corrupt the JavaScript runtime

Parcel 2.6 destroys a failed subscription on its worker thread, including releasing JavaScript
references there. Watching a missing directory while other file operations run reproduces a
native crash in Node's later stat callback, with the same freed handle seen in the live daemon.
Bun also crashed during exception handling, so changing JavaScript engines or disabling JIT
did not solve the incident.

macOS and Linux now use Parcel with an exact-version pnpm patch. Its thread-safe-function
finalizer resets callback references on their owning JavaScript thread, covering both failed
subscriptions and backend errors. The native addon is compiled during installation, and both
development and release builds load that compiled file; a source patch must never silently load
an unchanged upstream prebuild. Windows keeps its existing `fs.watch` path for immediate folder
release. The missing-workspace process regression remains unchanged, and native checks also
verify ordinary events, ignored directories, unsubscribe, and callback garbage collection.

Parcel reports canonical event paths. Each subscription resolves its native root and uses that
same root for ignore paths and relative event names, so a caller's symlink alias cannot hide
changes. Missing roots keep the original path and the ordinary subscription retry behavior.
