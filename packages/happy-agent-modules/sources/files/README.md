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
indexes; eviction and shutdown destroy the native finder so its watcher and memory are released.
File contents are not indexed. A search spends at most a small first-result budget waiting for an
active scan, then queries FFF's live index instead of blocking on the entire workspace. Searches
also start a rescan when the current index is more than two seconds old, covering external changes
that a native watcher missed while preserving the same bounded response budget.

Tree pages never start or await FFF. They read one physical directory directly, so ignored folders
such as `node_modules` remain visible without being recursively indexed. Reading a file or tree
page adds only its containing directory to a bounded least-recently-used watch set. Changes there,
and successful module writes, coalesce into `files_changed` events with exact relative paths when
the operating system provides them.
