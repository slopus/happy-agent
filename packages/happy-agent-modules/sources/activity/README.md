# Activity

Remembers when a person last wrote in each conversation, so sidebar rows can be ordered and dated
by what people did instead of by every run, tool call, or bookkeeping write.

```ts
const activity = new ActivityModule(durableFunctions);
```

When a user-role message from a user or an exported bot's guest is accepted, the module invokes
the durable function `activity.person-message` in the acceptance's transaction, keyed by the
message and locked per agent. After commit it writes `lastPersonMessageAt` into the agent's
metadata, only ever moving it forward. Messages from agents, including a parent's, never count.

```text
person's message accepted -> durable intent (same transaction)
    -> after commit: agent metadata lastPersonMessageAt -> agent.metadata-changed
    -> API: agent.lastActivityAt = max(lastPersonMessageAt, statusLine.updatedAt) ?? createdAt
```

The API projects the agent's `lastActivityAt` from this key and the status line Stories writes,
and emits it in `agent.updated` whenever either changes.
