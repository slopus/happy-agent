# Connection snapshot persistence

One singleton stores only the bounded public roster and its UUIDv7 version. Machine configuration
remains authoritative and retains all credentials and transport settings. Snapshot reads and writes
use the caller's database scope; the module composes reconciliation and post-commit notification.
