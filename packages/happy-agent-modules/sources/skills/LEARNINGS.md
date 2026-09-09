# Skill discovery learnings

## Concurrent agents share scans, not stale catalogs

Startup used to scan the same skill files separately for every restored agent. Discovery now
coalesces overlapping loads with the same filesystem identity, working directory, home, and complete
operation permissions. Compute identifies native filesystems with identical boundaries; alternate
providers share only the exact filesystem object, never an advertised provider name or path.
At most 128 scans are retained for sharing, and every entry is removed when its scan settles.

Completed catalogs are deliberately not cached. The API requires discovery on creation,
restoration, each turn, and invocation, and a removed command must not be dispatched from stale
data. Later calls rescan immediately, including after partial filesystem failures. Directory
metadata uses the backend's bounded batch operation, and canonical non-symlink child directories
do not need another realpath lookup. Symbolic links still resolve through the permission-aware
backend; individual unreadable or disappearing files do not hide other skills.
