# Runtime

This directory owns the complete local Happy agent runtime: configuration, databases, exclusive
storage locks, module composition, the agent system, background lifetimes, and orderly shutdown.
The executable package only binds transport and asks this runtime to start.

```text
Config ──> Observation ──> databases + locks
   │                            │
   └────────> domain modules ───┤
                                v
                        AgentSystemLocal
                                │
                                v
                         API + Happy sync
```

`ApiModule` is placed first in module startup order. It can subscribe to every producer before any
later module restores agents or emits startup events. Migrations still run through the single Agent
Base migration pass.

The main and automatic-review stores are separate databases with separate process locks. Runtime
shutdown cancels the shared provider lifetime first, signals every run in Events' active index,
then waits for admitted work and closes resources in reverse ownership order. Agent Base still owns
its deliberate drain-on-close semantics; the daemon establishes the stronger replacement policy
before entering that close barrier so an Agent upgrade cannot wait on an unbounded provider stream.

Each SQLite database acquires its kernel-backed sibling `.lock` database before the real database
client is constructed. A live process therefore excludes every other connector, while process
exit releases ownership even though the reusable lock database remains on disk.

Every agent module is wrapped at composition time with module-labelled logging. The wrapper keeps
Agent Base's hook ordering and failure behavior unchanged, emits bounded hook timing, and leaves
high-volume provider deltas to the observation module's focused phase records.
