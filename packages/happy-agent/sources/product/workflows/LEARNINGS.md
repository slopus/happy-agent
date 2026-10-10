# Native workflow ownership

The original workflow owner persists launches, Monty snapshots, and agent calls in its own SQL tables. A checkpoint commits before host work begins, and each host call closes its interpreter checkout before awaiting collaborators. The native implementation uses the same pinned Monty 0.0.21 Rust interpreter and protocol inside the packaged Agent executable.

Workflow collaborators suppress automatic reports to the creating chat. Their final answer or failure commits during agent settlement before any workflow waiter wakes. Recovery reads that durable answer and keeps the original collaborator identity, so a process restart does not create a replacement agent for the same call.

Original parallel requests and pipeline items run concurrently, keep input ordering, and yield `None` for a failed item. Batch size is 4,096; total reserved agent calls are capped at 1,000. Option normalization trims model and provider and preserves labels. Structured answers implement the original supported JSON Schema subset.

Workflows are disabled by default. Saved scripts use the Tools owner's existing filesystem permissions. Inline scripts request no extra filesystem permission. The exact original tool definitions and durable/reloadable flags are captured from the original TypeBox definitions.

Progress notes are advisory. Native pending progress work uses a bounded queue, while the original durable log history and its paging contract remain owned by the workflow database.
