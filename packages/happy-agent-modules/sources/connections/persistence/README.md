# Connection snapshot persistence

One singleton stores only the bounded public roster and its UUIDv7 version. Machine configuration
remains authoritative and retains all credentials and transport settings. Snapshot reads and writes
use the caller's database scope; the module composes reconciliation and post-commit notification.

The snapshot owns required connection order keys independently of machine settings. The second
migration backfills old snapshots in ascending ID order and advances nonempty roster versions;
the original migration is unchanged. Reordering atomically replaces this bounded snapshot,
preserving all neighbour keys. Configuration reconciliation retains existing keys and appends
new connections after surviving entries.

A third table keeps every ID that ever named a server connection by URL. Rows are written before
the configuration that uses or removes the ID and are never deleted, so a removed server's ID is
never reused.
