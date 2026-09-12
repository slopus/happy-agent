# Skill discovery learnings

## Disablement means unavailable, not uninstalled

The human-directed management contract uses the existing `~/.agents/skills` root and returns
parsed skills, not parsed agent definitions. A disabled skill remains installed, visible in the
human-facing catalog, readable through management APIs, and monitored for file changes. Its
preference must not be implemented by deleting or moving files. Agent skill discovery, prompt
contributions, skill-specific reads, and invocation exclude it; ordinary filesystem permissions
are unchanged. The global management module owns installation state and watching, while native
agent discovery consults its availability without applying local preferences to another compute.
Management remains feature-detected through its endpoint; this additive API does not raise
protocol 25.

If a repository contains the home directory, walking project ancestors must not rediscover
`~/.agents/skills` as a project root. It remains the global installation, so its disabled state
cannot be bypassed by source classification. Separate project installations keep their own
availability even when they share a name.

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
