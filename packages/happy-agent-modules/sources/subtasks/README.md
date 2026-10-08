# Subtasks

User-visible, parent-managed conversations. `create_subtask` creates them and `archive_subtask`
lets their direct coordinator archive them. Existing collaboration messaging and the agent API
handle interaction; users may also archive through the API.

```text
Bot
└── Subtask (shared folder or project workspace)
    ├── Subtask in project A's workspace
    └── Subtask in project B's workspace
```

The two-level limit counts ancestry, not siblings. Ordinary agents cannot create subtasks.
Creation commits the agent, optional workspace association, and Durable Functions startup intent
together. Initial delivery waits for workspace readiness and uses the agent ID as its durable
message identity. Every full API agent includes its active direct subtasks recursively, including
in bootstrap, in sibling order that `reorder` moves. Workspace-bound subtasks also appear in the
workspace's ordered agent series, whose order is separate.
Archival stops the target and descendants but marks only the target archived, preserving its
history. A workspace-bound subtask and its workspace archive together in one transaction, from
either side; a shared-filesystem subtask never archives the folder it shares.
Archival is final: a subtask is never restored. Durable Functions owns post-commit compute
cleanup. Agent Base remains unchanged.
