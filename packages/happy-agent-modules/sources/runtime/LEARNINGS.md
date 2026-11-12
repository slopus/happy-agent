# Runtime learnings

## Upstream pooling owns database connection reuse

libSQL client 0.18 returns completed transaction connections to its pool, replacing our
per-transaction close patch. Idle pooled connections are expected while the client is open;
only final client shutdown must release every database handle. Statement finalization remains
necessary for immediate Windows file release before garbage collection.

The process-owner lock must hold an explicit write transaction for its lifetime. A raw
`BEGIN IMMEDIATE` through root `execute` is rolled back when the pooled connection is returned,
silently dropping ownership. Retaining the transaction until release preserves the kernel lock.

## Windows shutdown controls survive graceful cleanup

Closing the tray with the first shutdown handlers removed the user's only Force stop control
while other handlers could still be stuck. Windows now retains its tray through graceful
shutdown and closes it during finalization. Its parent-exit observer also handles abrupt death.

## Module loading belongs in distributed traces

Module timing logs alone did not reveal startup and restoration in the trace viewer. The shared
module wrapper now creates spans for initialization and ordinary hooks, including after-start and
agent restoration, passing the span context into module work so child spans nest correctly. It
preserves synchronous returns, asynchronous completion, and original failures. Raw provider events
remain uninstrumented so streaming deltas cannot flood telemetry.

## Probe startup is not the database responsiveness deadline

The isolated database deadlock test previously allowed four seconds for cold TypeScript imports,
database setup, and its gated tool batch. Under CI CPU contention, startup took over six seconds
even though the database check completed in under 110 milliseconds. The probe now has a separate,
bounded fifteen-second startup allowance. Its one-second deadline after `READY` and every
concurrency assertion remain unchanged, so slow process startup cannot masquerade as a deadlock.

## Shared event streams do not reserve the next frame for one feature

The team mobile-connection test assumed its next event frame was a connection update. An
asynchronous slash-command catalog update legitimately arrived first and failed release checks.
The test now waits for the next integration event while skipping only unrelated event types,
with explicit time and frame-count bounds. It must not filter by the expected member, version,
or payload: the first integration event is still compared exactly, so another member's leaked
connection state cannot be skipped. Real profile updates force unrelated events ahead of both
replayed and live connection updates, making the ordering regression deterministic.

## Disclosure snapshots settle the seeded bot's public catalog

The disclosure reader test waited for its fixture agent's cached catalog, but the built-in Chief
of Staff discovers and publishes its catalog independently. Its initial publication could arrive
after the retained snapshot and look like a reader mutation. Setup now waits for that bot's exact
public catalog and creation events before capturing cursors. The original mutation whitelist,
privacy checks, canonical-record checks, and cursor assertions remain intact.

## Incompatible data changes need a migration in their own module

The startup refusal and `data-version.json` are triggered only by a migration key an older build
does not know, in a module that build has. A change to stored data that an older release would
misread, such as a new document format, must add a migration to the module that owns that data,
even an empty marker. Otherwise the older release opens the data and fails later, while it is
running. Fields that older code ignores need no migration, and neither does a new module.

## Commits do not wait for an fsync

With `synchronous = FULL`, every commit to the daemon's database waited for an fsync on the JS
thread, about 1.8 ms each on the host's NVMe and seconds on a saturated disk. A 30-turn gym run
with five tool calls a turn took 22 s instead of 8 s, and its event-loop lag p99 was 137 ms
instead of 46 ms. The daemon now uses `synchronous = NORMAL` in WAL mode: a daemon crash loses
nothing, and an OS crash or power loss can lose only the commits since the last checkpoint, never
consistency.

It also keeps a 128 MiB page cache, enough that rereading a large conversation is served from
memory: a 34 MB history page read fell from 17 ms to 4 ms, where 64 MiB was too small to help. The
WAL file is truncated to 64 MiB after checkpoints. `mmap_size` was rejected: this libSQL build
maps at most the first 2 GiB of the file, a quarter of an 8 GB database, and it helped no more
than the cache. `temp_store` is already memory in this build. All of these settings are per
connection, so they hold only while the serialized queue keeps libSQL's pool at one connection.
