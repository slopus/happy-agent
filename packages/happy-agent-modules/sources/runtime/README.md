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
shutdown uses stdlib's one named coordinator. Agent Base registers the main and review systems as
`agent-system` and `auto-agent-system`; each finishes its in-flight operation, stops before the next
agentic operation, and releases its store lock. The remaining named handlers close their resources
with explicit dependency waits, so health can report exactly what is still pending. The API and
socket stay outside this phase and remain ready until every graceful handler has finished or timed
out; transport and API finalizers run only afterwards.

Each SQLite database acquires its kernel-backed sibling `.lock` database before the real database
client is constructed. A live process therefore excludes every other connector, while process
exit releases ownership even though the reusable lock database remains on disk.

Every agent module is wrapped at composition time with module-labelled logging. The wrapper keeps
Agent Base's hook ordering and failure behavior unchanged, emits bounded hook timing, and leaves
high-volume provider deltas to the observation module's focused phase records.

`CodeModeModule` is always the final module in the ordered array. Its opt-in complete instruction
and tool overrides must see every earlier contribution; moving another module after it would let
that module replace Code Mode's deliberately closed surface.
