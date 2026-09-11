# Project files — learnings

## Smaller transports reuse the existing read methods

Separate bounded-reader siblings duplicated the file API unnecessarily. `read` now accepts an
optional byte limit and shares one regular-file, contained, bounded stream with every caller.
It checks size before reading and reads at most one extra byte to detect growth. `readRevision`
accepts the same limit through options; strict callers preserve failures while the default keeps
the HTTP preview's nullable result. Absolute native file links are normalized only within the
selected root; the HTTP request schema still requires relative paths. The 44 MiB default is unchanged.

## Preserve parent ignore rules when upgrading the native finder

FFF 0.10.6 includes image and binary filenames in plain folders, but its walker loses parent
Git ignore rules when indexing a subfolder. This made dependency trees such as `node_modules`
appear in autocomplete. The upgrade was reverted by user direction; the module remains on
0.9.6, with its known limitation that binary filenames are omitted outside Git repositories.
A future upgrade must prove both behaviors together, including a child folder whose ignore
rules live in its ancestor. Plain-folder fixtures must live outside any checkout so an ancestor
Git repository cannot silently hide the binary-filename limitation.

## Native search starts only when it is needed

Loading the FFF native binding while composing the daemon put optional file indexing on the
workspace-startup critical path. The module imports FFF lazily on the first search request. Later
requests reuse the loaded binding and a bounded set of watched workspace indexes. Because native
watchers can miss external changes, an index older than two seconds starts a rescan before search,
but the request waits at most 100 milliseconds and then uses the live partial index.

## File trees must not wait for autocomplete indexing

Using FFF's ignore set to filter tree branches made valid physical folders disappear and forced a
one-level tree request to await a workspace-wide scan. Tree pages now read only the requested
physical directory and return ignored folders such as `node_modules` immediately. FFF remains the
right boundary for ranked autocomplete, where ignoring dependency trees prevents expensive and
noisy suggestions.

## Watch only what the client rendered

A recursive second watcher would recreate the dependency-tree cost that FFF removed. File reads
and tree pages instead arm non-recursive watches only for their containing directories, retained
in a bounded least-recently-used set. External changes and successful API writes are debounced into
bounded path invalidations so clients can refresh visible state without file contents entering the
event journal.

## Search belongs to the selected physical workspace

The API resolves a project or child-workspace resource through `ProjectFilesModule` first. The
index uses that canonical root without deriving another path, so a child workspace searches and
lists its own checkout rather than the root project's files.

## Viewer access is not a model permission boundary

The project-files API is an authenticated client surface for browsing, previewing and occasional
human edits. Every valid path inside the selected root is available there, including `.git`,
`AGENTS.md` and `AGENTS_SECURITY.md`; traversal and symlink escapes remain forbidden. Restrictions
on model writes belong to the compute sandbox and its host policy, not to the file viewer.
