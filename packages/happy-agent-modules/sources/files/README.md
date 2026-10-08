# Project files

This module owns safe file access, the file-tree API, and the fuzzy file-name index used by composer
`@` mentions. Every operation is rooted at one canonical project or child-workspace folder.

```text
workspace root ──┬──> one-level physical tree pages
                 ├──> confined reads and compare-and-swap writes
                 ├──> bounded watches ──> debounced change events
                 └──> FFF path index ──> ranked autocomplete paths
```

Indexes are created lazily and kept in least-recently-used order. The module retains at most eight
indexes; eviction and shutdown destroy the native finder and release its working-tree watch.
File contents are not indexed. A search spends at most a small first-result budget waiting for an
active scan, then queries FFF's live index instead of blocking on the entire workspace. FFF's own
watcher is off: the index follows the Git module's shared working-tree watch and rescans only
after a path appears or disappears. When a tree cannot be watched, a search rescans an index more
than two seconds old instead.

Tree pages never start or await FFF. They read one physical directory directly, so ignored folders
such as `node_modules` remain visible without being recursively indexed. Reading a file or tree
page adds only its containing directory to a bounded least-recently-used watch set. Changes there,
and successful module writes, coalesce into `files_changed` events with exact relative paths when
the operating system provides them.

Smaller transports pass an optional byte limit to `read` or `readRevision`; the default remains
44 MiB. Current reads verify a contained regular file and stream at most the limit plus one byte.
Revision callers may request strict errors; the HTTP preview retains its nullable default.

## Folders on runners

A folder may live on a runner instead of this machine. The root then carries the runner's ID, and
every read, tree page, and write runs on that machine through the same compute calls a local
folder uses, with the same containment and compare-and-swap rules. Two things differ, because they
lean on this machine's own disk:

- Search lists the folder on the runner — Git's ignore-aware view of the working tree, or a bounded
  walk outside a repository — and ranks the names here. Each of the eight most recently searched
  runner folders keeps one listing, listed again after its watch reports a change, or after two
  seconds when nothing watches it.
- Watching uses the runner's own recursive watcher for the whole folder, skipping dependency and
  repository directories, for at most eight recently read runner folders. A runner that disconnects
  ends its watches; the next read arms them again.

Live Git state stays local, so writes to a runner folder do not touch the Git module's caches.
