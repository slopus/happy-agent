# Git learnings

## What a folder is comes from the Git that acts on it

When the GitHub credential broker was removed, `probe`, `topLevel`, `commonDir`, and the other
structural reads fell through to the sandboxed read-only scanner. Before that they had always run
on foreground Git, because every project carried a credential. On a Linux host where the sandbox
cannot start, such as a GitHub Ubuntu 24.04 runner that restricts unprivileged user namespaces,
every scanner read failed. The probe then recorded each repository as "not a Git repository", and
every new workspace became a copy of the project folder, dirty working tree included. Nothing
reported an error.

The structural reads now use foreground Git, the same Git that cuts, adopts, and removes the
worktree, so the answer and the action can never disagree. Reads of a repository's contents and
changes (snapshots, file listings, revision reads, live tracking) stay on the hardened scanner.

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

## Only a repository gets a recursive watch

A long-running daemon held 127,825 of the host's 129,317 inotify watches, and every new watch then
failed (`ENOSPC`): live Git fell back to polling and watcher tests timed out. About 112,000 of them
covered five task folders that were not Git repositories. Live tracking armed the recursive
working-tree watch on every tracked folder before asking whether it was a repository, and a folder
outside a repository ignores nothing but `.git` and `node_modules`, so an agent's `.context`
holding a Nix store (80,000 directories) or cloned references cost one watch per directory. The
tracker now looks the folder up first. Only a repository gets the working-tree and Git directory
watches; any other folder gets one non-recursive watch of its own entries on this machine, or
polling on a runner, and is upgraded when `.git` appears or a later scan finds a repository.

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

## The home directory is never watched

The daemon starts in the home directory, and the Home project's folder is the home directory, so
live Git tracking armed a recursive Parcel watch on `~`. On macOS, Parcel's FSEvents backend
stats every changed path it reports. Each time another application wrote inside
`~/Library/Containers`, the Photos library, Contacts or Documents, that stat made macOS ask the
user to let Happy access other apps' data, or Photos, Contacts or Documents, and it kept asking
every few seconds while the daemon sat idle. The prompt seemed to come from the bundled Tailcat
process because it appeared just after Tailcat started. The unified log named the daemon as the
accessor, and a bare watch on `~` reproduced it. On Linux the same watch would also spend an
inotify watch on every directory in the home.

A root that is the home directory or one of its ancestors, compared after resolving symlinks, now
never gets a native watch and never runs its ignore listing. Its observers see `watching: false`
and poll, the same as for a folder that cannot be watched. Git status on a home folder still
works.

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

## Folders worked on as a separate Linux user use the runner path

With `[execution]` configured, a folder on this machine belongs to the workload user, and the
daemon's own Git would run as the daemon's user against it. Every native branch now asks
`RunnersModule.native(runnerId)`, so worktrees, clones, and probes on such a folder run through the
default workload user's runner, exactly as on a runner. Live tracking runs there too, below.

## Live tracking on a runner swaps the machine, not the tracker

Runner folders used to have no live Git at all (`404`, left out of `git/watch`). Porting it as a
second tracker would have duplicated the debounce, the path-scoped classification, and the
fingerprint stale checks, and they would drift. The tracker now asks `#machine(entity)` for a
`GitRepositoryMachine` — scan runner, working files, tree watch, metadata watch — and everything
else is shared. `GitWorkingFiles` is the seam for the reads the scanner used to make with `node:fs`
(index fingerprint, worktree fingerprint, untracked counts, display bytes); the local one keeps the
`O_NOFOLLOW` open-once behavior, the runner one uses `lstatMany` and `readFileBuffer` with
`noFollow`. A runner's fingerprint is size, mtime, and mode, since it reports no inode or ctime.

A scan reports a failed Git command as its result, so a runner that went away mid-scan would have
published "not a repository". Both the tracker and `snapshot` ask the machine whether it is still
reachable after a failed scan and throw `RunnerUnavailableError` instead; `snapshot` also refuses
its cache for a runner that is not connected. On a Windows runner the scan's hooks path and global
configuration point at `NUL`, not `/dev/null`, or every scan fails.

The `.git/` filter on tree events is case-insensitive everywhere, because a runner on macOS or
Windows can report `.GIT/` paths whatever the daemon's own platform is.
