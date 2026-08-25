# Master plan 23: Durable Functions

## Big picture

A very large number of modules repeat the same pattern: commit some database
state, then perform an action — start a process, call some service — and
continue that work reliably after the agent system restarts. We already do
this for tool calls, but we need a more generic mechanism.

Durable Functions is that mechanism: a generic asynchronous execution module.
Each module registers functions at start, by name, with a TypeBox argument
schema and a result schema. From then on, any place in the system can invoke a
registered function by its name, and the invocation is guaranteed to be
carried until successful completion, surviving restarts.

The system itself does not retry a function. Retrying is the executor's own
job — an executor that wants to retry forever retries forever inside itself.

## How a call works

- Any operation may create a call inside its own transaction. The call becomes
  durable with the caller's commit, and execution begins only after that
  commit. On a restart, pending calls begin executing in `afterStart`, once
  the whole system is up.
- The executor is handed an `AgentKV` where it keeps its own state.
- These are procedures, not functions in the awaitable sense. A function
  cannot wait for another function's call, and nobody at all can await a
  call's result. Fire it and let it run.
- A call may carry an optional operation ID, and a call can be cancelled by
  that operation ID. Cancellation invokes no handler. Invoking while a call
  with the same operation ID is already pending is not an error: the invoke
  simply returns a status saying so.
- A call may carry an array of lock keys. It does not start executing until
  every one of those keys is free, and it takes them all together. This is how
  the same function invoked several times runs in parallel when it may, and
  serially when it must not.
- A registration carries the executor and possibly an on-success handler.
  There is no on-failure handler. When an executor fails, the record of the
  call is deleted in one transaction, and that is the whole failure handling.
- If at restart the stored call no longer matches the registered TypeBox
  schemas, the function is not invoked. Its state is simply deleted.

## Shape

One module in `happy-agent-modules`, created somewhere near the beginning so
other modules can register into it. For now only the mutation surface is
needed: registering, invoking, and cancelling. No query surface yet.

## Order and criteria

1. Write the module: registration, transactional invocation, locks, operation
   IDs with cancellation, and restart recovery with schema checking. Done when
   a call created inside a committing transaction executes after the commit,
   survives a restart, respects its lock keys, and is removed in one
   transaction on success or failure.
2. Then investigate the existing modules that hand-roll this pattern and see
   which of them should move onto it.
