# Rust agent base

`AgentSystem` owns the daemon's original multi-agent store, durable queues and
stage machine. It serves actual feature modules through `AgentModule` hooks.
`DatabaseContext` carries the immutable caller transaction; its notifications
publish only after commit. History, Usage, Config and Compute supply their own
behavior, so the same loop can run a private review without public feature tables.

`Agent` is the earlier diagnostic adapter and still needs consolidation with that
original-store core. It owns one agent's worker, provider session and stage machine.
`Tool` owns its argument schema, durability, permission review, and execution.
`SessionFactory` supplies the provider session; the base never retries inference.

```text
admit message -> inference -> commit completed blocks -> tool batch
                      ^                                  |
                      +---------- commit results ---------+
                      |
                 settlement -> idle / next queued turn
```

`persistence.rs` owns every SQL operation. Its asynchronous `Store::transact`
executes a composable closure against one immutable `Tx` on the blocking pool.
Only a successful commit returns its queued notifications. SQLite's sibling owner
transaction lasts for the entire store lifetime. Each agent has one live instance.

The previous TypeScript runtime was removed. Its tests and formal state-machine
models remain reference evidence, not claims that the new Rust loop already
implements every hook or product module. The original-store core retains the
original immutable migration identities, canonical owner locks and private
records. Native daemon tests cover recovery, tool effects and public history;
the private-core test covers composition and input accepted during worker exit.
