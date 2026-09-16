# Subtasks

User-visible, parent-managed conversations. `create_subtask` creates them and `archive_subtask`
lets their direct coordinator archive them. Existing collaboration messaging and the agent API
handle interaction; users may also archive and restore through the API.

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
in bootstrap. Workspace-bound subtasks also appear in the workspace's ordered agent series.
Archival stops the target and descendants but marks only the target archived, preserving its
workspace and history. Durable Functions owns post-commit compute cleanup. Agent Base remains unchanged.
