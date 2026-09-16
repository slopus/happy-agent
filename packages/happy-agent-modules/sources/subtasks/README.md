# Subtasks

User-visible, parent-managed conversations. One `create_subtask` tool creates them; existing
collaboration messaging and the agent API handle interaction and archival.

```text
Bot
└── Subtask (shared folder or project workspace)
    ├── Subtask in project A's workspace
    └── Subtask in project B's workspace
```

The two-level limit counts ancestry, not siblings. Ordinary agents cannot create subtasks.
Creation commits the agent, optional workspace association, and Durable Functions startup intent
together. Initial delivery waits for workspace readiness and uses the agent ID as its durable
message identity. Shared-folder subtasks appear in parent activity; workspace-bound subtasks also
appear in the workspace's ordered agent series. Agent Base remains unchanged.
