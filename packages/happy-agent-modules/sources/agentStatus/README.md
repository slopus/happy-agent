# Agent status

The short status line under a task's or bot's title in the sidebar, kept by that task's or bot's
own agent.

```ts
const agentStatus = new AgentStatusModule(durableFunctions, bots, tasks);
```

A task's or bot's own agent gets `set_status` with its other tools, not deferred, and a short
instruction to keep the line current. Subtasks, helpers, and project or workspace sessions have
no row of their own and get neither. The tool takes one short phrase, two lines split by one line
break, or `null` to clear it; the wire limit is the only hard bound.

```text
set_status -> durable intent (the tool call's transaction)
    -> after commit: agent metadata statusLine { text, updatedAt } -> agent.metadata-changed
    -> API: agent.statusLine, and lastActivityAt counts statusLine.updatedAt
```

The durable function keeps the name `stories.set-status` from when Stories owned the line, so a
write a restart interrupted still lands.
