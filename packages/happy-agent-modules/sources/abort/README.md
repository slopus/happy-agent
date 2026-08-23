# Abort

Immediately aborts an agent's current run, every current run below it, and all background process
trees owned by those agents.

```ts
const abort = new AbortModule(compute);
await abort.abort(ctx, agentId);
```

The module takes the `ComputeModule` that owns processes. It reads the complete descendant tree
from the agent collection and asks Agent Base to abort each identity while one `ctx.inTx`
transaction is active:

```text
target ──> child ──> grandchild
   ③          ②           ①   abort signals issued together at commit
```

For every agent that owns running processes, that transaction first stores a one-shot notice in
Compute's shared Agent KV, scoped by agent identity. The notice names each live shell session and
counts any additional detached process trees. Compute's instructions hook prepends it to the
agent's next inference, then consumes it as that inference begins. It never enters public history
or a conversation queue.

If ancestry traversal, notice recording, or any abort request fails, the transaction rolls back
and no abort or process signal is issued. On commit, every run signal is issued immediately.
Public process state moves to `exited`, then every retained operating-system process group receives
`SIGKILL` directly. Abort never sends `SIGTERM` and has no graceful waiting period. Nested callers
reuse their transaction, so the operation composes with API and tool mutations without an early
commit.

The compute module advances an abort generation for every agent in the subtree, including one
whose process snapshot was empty. If a command was still crossing its spawn boundary when abort
committed, it observes that generation change as soon as spawn returns and is hard-killed too. A
command started by a later turn captures the new generation and is left alone.

Signals are registered from the deepest descendants back to the target. A descendant may report
its settlement to its creator; leaf-first cancellation ensures that report arrives before the
creator's own abort and cannot reopen an ancestor that was already canceled.

The traversal is breadth-first, rejects cycles or duplicate identities, and refuses a chain larger
than `MAX_ABORT_CHAIN_AGENTS` rather than consuming unbounded memory.

Several aborts sharing one transaction cancel each identity once between them. Archiving a project
is the case that needs it: the projects catalog cancels the project's own root agents and the
workspaces catalog cancels each workspace's agents, in the same transaction, and a subagent can
appear on both sides. Cancelling it twice would replace the notice it has already been left with a
poorer one. The record of who a transaction has already reached lives exactly as long as that
transaction, so a later one — including a retry of one that rolled back — starts from nothing.

The module owns no tools, tables, migrations, events, or persistent state of its own; the one-shot
notice belongs to Compute's shared Agent KV. API and collaboration modules call its public `abort`
operation.
