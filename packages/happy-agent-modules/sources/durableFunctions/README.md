# Durable Functions

Durable fire-and-forget procedures. A caller records work inside its own transaction, execution
begins only after that transaction commits, and a restart runs every call whose row is still
pending.

```ts
const durableFunctions = new DurableFunctionsModule();

durableFunctions.register({
    name: "publish-report",
    argumentsSchema: Type.Object({ reportId: Type.String() }),
    resultSchema: Type.Object({ url: Type.String() }),
    executor: async (ctx, call) => {
        const attemptId = await call.kv.getOrCreate(ctx, "attempt", () => createId());
        return await publish(ctx, call.arguments.reportId, attemptId);
    },
    onSuccess: async (ctx, call) => {
        await markPublished(ctx, call.arguments.reportId, call.result.url);
    },
});
```

Registration stays open through every module's `beforeStart` and closes when Durable Functions'
`afterStart` recovery begins. Names are durable identifiers: renaming one leaves old calls without
a registration, so recovery deletes those calls and their state.

## Invoking and cancelling

`invoke(ctx, input)` joins the transaction already carried by `ctx`, or opens one when needed. It
validates the arguments against the registered TypeBox schema and writes one pending call. Its
post-commit callback hands the call to the in-process dispatcher; a rollback neither leaves a row
nor executes anything.

An optional operation ID makes pending creation idempotent. A second invoke with the same operation
ID returns `{ status: "duplicate", callId }` and writes nothing. `cancel(ctx, operationId)` deletes
that pending call and all of its executor state in one transaction. If it is already running, the
executor's context is aborted after the cancellation commits.

Function names, operation IDs, and lock keys are non-empty and at most 256 characters. One call may
carry at most 64 lock keys.

Calls have no result API. Nobody can await, poll, or read a result, and one durable function must
not wait on another. The returned call ID is informational only.

## Execution, locks, and state

Every executor runs on the module's detached `durable-functions` context. Calls without lock keys
run fully in parallel. A call with keys acquires its complete set atomically; overlapping calls are
FIFO by creation time and ID, while disjoint calls remain concurrent. Locks exist only in this
process because the agent store has one owner. Pending call rows are the durable truth rebuilt on
restart.

The executor receives a real `AgentKV` scoped to `call.<callId>.`. Its values live in the module's
own table and its transactions compose with the agent database transaction on the supplied
context. Completion and cancellation erase the entire scope with the call row.

An executor resolution is checked against its result schema. The successful completion transaction
deletes the call and its state, then runs `onSuccess` in that same transaction. If `onSuccess`
throws, everything rolls back and the call remains for the next restart. If the executor throws or
returns an invalid result, one transaction deletes the call and state and the failure is logged.
There is no failure handler and no module retry.

Executors and `onSuccess` handlers must be idempotent. A process can die after external work but
before its completion transaction commits, causing the executor to run again after restart. An
executor that wants in-process retries implements its own backoff loop and honours `ctx.lifetime`.
