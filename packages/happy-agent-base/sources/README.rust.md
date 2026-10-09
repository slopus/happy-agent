# Rust agent base

`Agent` owns one agent's worker, provider session, durable queue and stage machine.
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
implements every hook or product module. The Rust tests directly cover this loop.
