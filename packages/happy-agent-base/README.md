# @slopus/happy-agent-base

The minimal durable runtime for Happy agents.

`AgentBase` owns one agent's persistent inference and tool loop. It durably queues messages,
streams provider responses, executes tools, compacts history, resumes interrupted work, and
keeps inference, tool results, and settlement transactionally consistent across process
restarts.

The package also provides the primitives needed to host that runtime:

- `Agent`, `AgentSystem`, and `AgentSystemLocal` for composing and addressing agents;
- Drizzle-backed `AgentStorage` and scoped `AgentKV` for durable state;
- `AgentProviders` for resolving provider/model routes;
- `AgentTool` and lifecycle hooks for extending the loop.

`AgentSystemLocal` accepts `steeringMode` and `sendMode` for the collection. Each is
`"one-at-a-time"` by default or `"all"` when every message already waiting at that queue boundary
should be injected before one response. The choice applies consistently to newly created and
restored agents. Requests with different profiles always split an `"all"` batch because they may
not share model context.

`retryForever: true` is token-max operation: it is for a token-rich caller that wants the agent to
keep consuming tokens and never accept an error as final. `AgentBase`, or every agent in an
`AgentSystemLocal`, always retries forever across provider errors, failed compactions, and fatal
internal run-stage failures, using bounded exponential backoff. The outstanding durable stage
remains active between attempts, so committed tool effects are not replayed. Only explicit abort,
drain, close, provider disablement, or graceful shutdown stops active retrying.

One `AgentSystem` exclusively owns one durable store. `AgentStorage` requires an asynchronous
Drizzle SQLite or PostgreSQL/PGlite database plus a hard database-level lock. It owns the agent
record, key-value, and migration tables itself. `AgentSystem.close()` stops its agents and releases
the lock; the runtime intentionally contains no CAS or multi-owner coordination.

When the system context carries stdlib `GracefulShutdown`, `AgentSystemLocal` registers one named
shutdown handler (`"agent-system"` by default, configurable with `shutdownName`). Shutdown refuses
new work, lets each in-flight inference or tool operation finish, stops before the next agentic
operation, and then releases the storage lock. Durable work left at that boundary resumes when the
next process opens the store.

Agent Base also provides production database implementations through `openAgentSQLiteDatabase`,
`openAgentPGliteDatabase`, and `openAgentPostgresDatabase`. Each returns one
`AgentDatabaseConnection` that owns its Drizzle facade, driver lifetime, root-operation FIFO, root
transactions, and awaited close boundary. All three implementations use the same scheduling
contract: root statements and transactions serialize, while statements already using the active
transaction facade execute directly. Database work must use `agentDatabaseRows`,
`agentDatabaseRun`, or `ctx.inTx`; invoking the exposed root Drizzle facade directly bypasses the
owner and is not a supported persistence path.

`openAgentSQLiteDatabase` acquires a kernel-backed write transaction on a sibling `.lock` SQLite
file before constructing the real database client. A second process therefore cannot even connect
to the agent database, and graceful close, process exit, or `SIGKILL` releases ownership without
stale-file recovery.

Storage uses Drizzle transactions and installs stdlib's universal `afterCommit` scope on their
contexts, draining it only after the outer transaction succeeds. Agent contexts expose the root or
active Drizzle facade as `ctx.db`; `ctx.inTx(work)` and the exported `inTx(ctx, work)` helper open
an outer transaction or reuse the one already carried by the context. Outside a transaction,
stdlib starts post-commit callbacks on the next microtask.

Storage, KV, migrations, transactional module hooks, and message delivery compose with a context's
outer transaction. `send` and `steer` persist their queue entry and pending-work marker inside that
transaction, then publish the in-memory queue and start the run only through `afterCommit`; rollback
therefore leaves no live effect. Delivery inside a transaction never waits on the agent's internal
persistence lock — the caller holds the database writer while its transaction stays open, and a
running turn takes that lock before touching the database, so waiting here could deadlock against a
live turn; the open transaction supplies the atomicity the lock otherwise guarantees.
Transactional routing through `AgentSystem.send` or `steer`
loads an idle target on the way: instantiation reads only committed state and builds memory, so a
rolled-back delivery leaves nothing but an idle live object with no durable work to pick up, and
the target's run starts only when the commit publishes the message. Other live `Agent` and
`AgentSystem` lifetime commands—creating, resolving, mutating, archiving, or closing—remain
rejected inside an outer transaction.

An agent runs in one of four permission modes — `read_only`, `workspace_write`, `auto`, and
`full_access` — carried on every context it derives and read back with `agentPermissionMode`. A
message changes it: `steer(ctx, message, { permissionMode })` takes effect when that message is
consumed, so a response and the tools it dispatched finish under the mode they started in. The mode
is durable, and a change is reported through `permissionModeChangedTransact` and
`permissionModeChanged`; every message entering the conversation is reported the same way through
`messageAcceptedTransact` and `messageAccepted`. The runtime enforces nothing — it cannot know what
a tool touches — so enforcement belongs to modules and tools; see the companion
[`@slopus/happy-agent-features`](../happy-agent-features) package.

A tool call is bracketed by four hooks and executed by the loop itself. `beforeToolCallTransact`
runs inside the transaction that makes a dispatched batch durable; `beforeToolCall` decides what
one validated call may do — leave it alone, run another tool, other arguments, or another
permission mode for that one execution, or answer the model directly so the tool never runs;
`afterToolCall` observes what the call produced; and `afterToolCallTransact` runs inside the
transaction that appends a result. A provider-owned server tool may set `visibleToUser: false` to
suppress its live call/result events and `persistInHistory: false` to suppress normal history
publication; Base still retains its call and result in private model context. Executable tools
cannot hide from correctness or security observers. Nothing outside the loop ever executes a tool:
a hook that drove execution would be deciding inside machinery that also commits results, resumes
interrupted batches, and settles cancelled ones.

Every tool call receives a Base-generated cuid2 `id`; executable calls also receive a call-bound
`kv`. Events, hooks, task context, modules, results, and execution use that ID. The provider-native
ID remains only in the raw stream and private provider-context records so replay and server-tool
results can still be correlated after a restart; each context record pairs it with the Base ID as
a separate sidecar, never in `vendor`. Calling `call.commit(ctx, result)` inside a transaction
atomically saves that result with the tool's writes. The first successful commit wins; later
commits and the tool's eventual return or throw are ignored. Committed results survive a crash,
remain ordered with their batch, and the call-bound KV is erased in the result transaction.
Setting a tool's optional `transactional` property to `true` wraps its `execute` call, result
validation, rendering, and automatic result commit in one outer transaction. It defaults to
`false`.

Tool lifetime flags describe distinct interruption guarantees. `durable` means an unfinished call
may execute again after a crash. `reloadable` additionally lets graceful drain abandon the live
execution without writing a result, leaving the same call ID pending for the next process; it is
therefore retry-safe even when `durable` is omitted. `steerable` lets newly accepted steering abort
the execution lifetime, and lets drain settle the interrupted call instead of waiting. Ordinary
tools finish before graceful drain reaches its edge.

Modules may provide an ordered array of `[key, migration]` tuples. Agent base tracks each
successful key and runs every missing migration transactionally before any `beforeStart` hook; a
failure aborts system startup. Every module migration and hook context carries the common Drizzle
facade in `ctx.db`: a root database outside a transaction and its active transaction facade inside
one. A migration also receives that facade explicitly to retain its exact engine-specific type.
Driver-only root members such as `$client` and `batch` are deliberately not part of that surface.
A module is a name, its migrations, and one entry point: `beforeStart(ctx, agents)`. Everything
the module does at runtime is in the `AgentModuleHooks` object that entry point returns —
including `afterStart` and every agent and lifecycle hook — so implementations close over the
state `beforeStart` built instead of living on the module object. Returning nothing means the
module only migrates and initializes. Every `beforeStart` settles successfully before active
agents are restored; every returned `afterStart` runs after those agents are restored and
started. Both receive the system's `AgentSystemRef`; their context carries the root database.
All hooks may return synchronously or with a promise, including `onEvent`; the runtime awaits each
answer and contains failures from observing hooks.

Messages receive a generated cuid2 identity, or accept one through `{ id }` for idempotent
delivery. A repeated ID is an ignored persistence conflict while its message remains in the
durable conversation; deliberate conversation replacement releases identities for the records it
removes. `send` and `steer` return the effective ID, delivery mode, and whether durable acceptance
created the identity or found it already present. Inside an outer transaction, delivery completes
its durable queue write before returning because work may not retain a transaction context after
the transaction body ends. Optional immutable metadata
travels beside the provider message and reaches both message-accepted hooks; module-generated send
and steer actions accept the same fields. Every message also selects an opaque nullable `profile`.
Omission selects `null`; changing the effective profile clears private model history and starts a
fresh provider session. The profile is durable control data and is never sent to the provider.

Base allocates cuid2 identities for every settled-to-settled loop, turn, inference, and settlement.
The IDs are persisted with outstanding work before their first lifecycle hook, survive restart,
and are passed to transactional and observing hook counterparts without imposing a host protocol.
An inference ID survives only while that provider request has produced no completed block. If a
restart finds completed response content whose inference transaction never finished, Base retires
that request's ID before recovering its tool calls or making another provider request. Recovery
therefore never gives two provider requests the same inference identity.
Modules may also observe agent creation, restoration, metadata changes, and archival. Creation,
restoration, and archival provide transactional and post-commit hook pairs with an immutable agent
ID/metadata snapshot and module-scoped shared KV.

Agent configuration may contain immutable metadata such as `title`. `updateMetadata` is available
from `AgentBase`, `Agent`, `AgentRef`, `AgentSystem`, and `AgentSystemRef`; updates shallow-merge,
commit before memory changes, and fire transactional and post-commit hooks. Created agents also
record a durable parent. An `AgentSystemRef` carries its owning agent ID (or `null`) and uses it as
the default parent, while creation options may override the parent or explicitly choose `null`.
`parentOf` and `childOf` query the resulting direct relationship, and `AgentRef.parent` exposes it.

`AgentKV.getOrCreate(ctx, key, factory)` standardizes durable allocate-once values. Used on a
tool's call-bound KV, it supplies retry-stable operation identities without heap state or provider
call IDs.

Agent hooks also receive `agentHistoryKV(ctx)`, exposed to modules as `scope.historyKV`. It is
durable across turns and restarts but belongs only to the current conversation history: successful
compaction and model/profile resets clear it atomically with the replaced history and expire
retained old handles. The existing `modelChanged` hook handles both model and profile reset
handoffs; across modules, the first returned message wins and a failure preserves the old history.
Lifecycle action hooks may return `{ type: "inject", message }` to queue a system notice. Notices
are durable and append only after pending tool results and compaction have settled, immediately
before the inference that should see them.
`prepareInference` runs after queued input has joined the conversation and immediately before a
possible provider request. It may return only `{ type: "compact" }`; the replacement runs before
the durable inference stage opens, then preparation is evaluated against the replacement. The
replacement and its still-owed inference continuation update the pending record atomically, so a
restart between them continues the active turn. A failed attempt is not repeated on the unchanged
provider measurement before that request.
Compaction exposes `beforeCompaction`, transactional `historyErasedTransact`, and
`afterCompaction` hooks. The middle hook runs after the old records and history KV are cleared but
before replacement history is appended, so its writes and the replacement commit or roll back
together.

This package contains no ready-made product modules. Reusable tools, hooks, permissions,
workspaces, search, workflows, and other capabilities belong in
[`@slopus/happy-agent-features`](../happy-agent-features). Provider protocols and vendor
implementations belong in [`@slopus/happy-providers`](../happy-providers).

## Validation

```sh
pnpm --filter @slopus/happy-agent-base check
pnpm --filter @slopus/happy-agent-base test
pnpm --filter @slopus/happy-agent-base build
```

The full suite selects its production database backend with
`HAPPY_AGENT_BASE_TEST_DATABASE=sqlite|pglite|postgres`; SQLite is the local default. PostgreSQL
also requires `HAPPY_AGENT_BASE_TEST_POSTGRES_URL`:

```sh
HAPPY_AGENT_BASE_TEST_DATABASE=pglite pnpm --filter @slopus/happy-agent-base test
HAPPY_AGENT_BASE_TEST_DATABASE=postgres \
HAPPY_AGENT_BASE_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/happy_agent_base \
pnpm --filter @slopus/happy-agent-base test
```
