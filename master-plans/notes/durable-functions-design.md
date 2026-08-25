# Durable Functions: module design

Design note supporting [master plan 23](../23-durable-functions.md). This is
the intended shape of the module before implementation; the master plan is the
authority where the two disagree.

## What it is

`DurableFunctionsModule` in
`packages/happy-agent-modules/sources/durableFunctions/` is a generic durable
asynchronous execution mechanism. A caller creates a _call_ to a registered
function inside its own database transaction; the call becomes durable with
that commit and executes after it, in the background, surviving restarts.
Calls are procedures: nothing can await their result, and a function cannot
wait on another function's call.

It follows the `SchedulingModule` pattern: an ordinary `AgentModule` with its
own tables via module `migrations`, a detached named context for background
execution, and transactional plus post-commit behavior composed through
`ctx.inTx` / `afterCommit`.

## Construction and registration

The module is constructed near the beginning of module assembly, before every
module that uses it. Per the module rules, consumers take the
`DurableFunctionsModule` instance as a constructor argument and register their
functions on it — in their constructor or in their `beforeStart`.

```ts
interface DurableFunctionDefinition<
    Arguments extends TSchema = TSchema,
    Result extends TSchema = TSchema,
> {
    /** Stable name; the durable call records reference it. Renaming orphans calls. */
    readonly name: string;
    /** TypeBox schema the stored arguments must satisfy, at invoke time and at recovery. */
    readonly argumentsSchema: Arguments;
    /** TypeBox schema the executor's return value must satisfy. */
    readonly resultSchema: Result;
    /**
     * Does the work. Not retried by the module: an executor that wants retries loops with
     * `backoff` itself, honoring the abort signal on its context. A resolved executor is a
     * successful completion; a thrown error is a terminal failure.
     */
    readonly executor: (
        ctx: Context,
        call: DurableFunctionExecution<Static<Arguments>>,
    ) => Promise<Static<Result>>;
    /** Runs inside the transaction that deletes a successfully completed call. */
    readonly onSuccess?: (
        ctx: Context,
        call: DurableFunctionCompletion<Static<Arguments>, Static<Result>>,
    ) => Promise<void>;
}

interface DurableFunctionExecution<Arguments> {
    readonly callId: string;
    readonly operationId: string | undefined;
    readonly arguments: Arguments;
    /** A real AgentKV scoped to this call, for the executor's own durable state. */
    readonly kv: AgentKV;
}
```

`register(definition)` is allowed from construction until the module's
`afterStart` begins recovery; after that it throws. Registering two functions
with one name throws. `afterStart` runs only after every module's
`beforeStart` has settled, so recovery always sees the complete registry.

## Storage

The module owns its rows through module `migrations` on the agent database,
because the system-level `beforeStart`/`afterStart` contexts carry the
database but no shared KV. Two tables:

- `durable_function_calls` — one row per pending call: `id` (cuid2-shaped),
  optional unique `operation_id`, `function` name, JSON `arguments`, JSON
  `lock_keys` array, `created_at`. A row exists exactly while the call is
  owed; deletion is completion.
- `durable_function_kv` — key/value rows for executor state, keyed by full
  string key.

The executor's `kv` is a genuine `AgentKV` instance scoped to
`call.<callId>.`, built over a small module-owned `AgentPersistence` adapter
whose value operations read and write `durable_function_kv` through `ctx.tx`.
The record-store operations of that adapter (`load`, `append`,
`clearRecords`) are never reached by `AgentKV` and throw. State written by
the executor therefore joins whatever transaction the executor opens, and the
completion transaction deletes the whole `call.<callId>.` scope together with
the call row.

## Invoking

```ts
interface DurableFunctionInvoke {
    readonly function: string;
    readonly arguments: unknown;      // validated against argumentsSchema
    readonly operationId?: string;    // optional; unique among pending calls
    readonly lockKeys?: readonly string[];
}

interface DurableFunctionInvokeResult {
    /** The new call's ID, or the pending call already holding the operation ID. */
    readonly callId: string;
    readonly status: "created" | "duplicate";
}

invoke(ctx: Context, input: DurableFunctionInvoke): Promise<DurableFunctionInvokeResult>;
```

- Runs through `ctx.inTx`, so it composes into the caller's open transaction:
  the caller's state change and the call record commit or roll back together.
- Arguments are validated against the registered schema at invoke time;
  invalid arguments or an unregistered name reject the invoke (and therefore
  the caller's transaction).
- `afterCommit` hands the call to the in-process dispatcher. Before system
  `afterStart` has run, dispatch is held; the dispatcher starts draining only
  once `afterStart` releases it, so nothing executes before the system is up.
- An `operationId` that already names a pending call is not an error: the
  invoke writes nothing and returns `status: "duplicate"` with the existing
  call's ID. This is the durable-idempotency handle — a durable caller
  re-running after a crash just invokes again and observes the status.
- The returned `callId` is informational only. There is deliberately no way
  to await, poll, or read a call's result.

## Locks

- A call's `lockKeys` are acquired all together, atomically: the call does
  not start until every key is free, and it never holds a subset while
  waiting.
- Locks are in-memory in the dispatcher. The store has a single owner
  (master plan 20), so no durable lock rows exist — the pending call rows are
  the only durable truth, and a restart rebuilds the queue from them.
- Fairness is FIFO by `created_at` (then `id`): among calls waiting for
  overlapping keys, the oldest eligible call whose full key set is free runs
  next. A call with no keys runs immediately and concurrently with anything.
- This is what controls same-function concurrency: identical invocations with
  no keys run in parallel; invocations sharing a lock key serialize.

## Execution lifecycle

1. Dispatcher acquires the call's lock keys, then runs the executor on a
   detached context named `durable-functions` (the scheduling
   `#deliveryCtx` pattern), carrying the agent database and an abort signal.
2. Executor resolves → the result is validated against `resultSchema`, then
   one transaction deletes the call row and its KV scope and runs `onSuccess`
   inside it. `onSuccess` failing rolls that back, leaving the call pending;
   it will run again after restart, so executors and handlers must be
   idempotent.
3. Executor throws (or resolves an invalid result) → one transaction deletes
   the call row and its KV scope, and the error is logged. There is no
   failure handler; that deletion is the whole failure handling, and the
   module never retries on its own.
4. Process dies mid-execution → the row is still there; the call runs again
   after the next start. "Guaranteed until successful completion" means
   exactly this re-run guarantee, not automatic in-process retry.

## Cancellation

```ts
cancel(ctx: Context, operationId: string): Promise<boolean>;
```

- Transactionally deletes the pending call row and its state; returns whether
  something was cancelled. A call still waiting on locks simply never runs.
- A call already executing has its abort signal fired after the deleting
  transaction commits. The executor is expected to honor the signal; its
  completion or failure transaction then finds no row and writes nothing.
- Cancellation invokes no handler. The canceller asked for the removal and
  can do its own cleanup in the same transaction.

## Restart recovery

In `afterStart`, the module loads all pending call rows in `created_at`
order and, for each:

- Function name not registered, or stored arguments no longer satisfy the
  registered `argumentsSchema` → the call is not invoked. Its row and KV
  scope are deleted, silently (per dictation: "its state is simply deleted").
  A log line records it.
- Otherwise the call enters the dispatcher exactly like a fresh post-commit
  call, subject to its lock keys.

## Surface for now

Mutation only: `register`, `invoke`, `cancel`. No hooks returned from
`beforeStart` beyond none, no tools, no events, no query or listing surface
yet. The class keeps the door open for `onEventTransactional`/`onEvent`
subscribers later, following the scheduling shape, but they are not part of
this first cut.

## Settled points

Confirmed by Steve after the first draft:

1. There is no `onFailure` handler at all; an executor failure transactionally
   deletes the call and is logged, nothing more.
2. Cancellation invokes no handler.
3. A duplicate pending `operationId` is not an error; the invoke returns a
   `duplicate` status with the existing call's ID.
4. `onSuccess` failure rolls back the completion, so the call re-runs — the
   alternative (log and delete anyway) would break atomicity of "handled
   together with removal".
