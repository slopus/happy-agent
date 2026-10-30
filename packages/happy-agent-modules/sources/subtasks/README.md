# Subtasks

User-visible, parent-managed conversations. `create_subtask` creates them, `archive_subtask`
lets their direct coordinator archive them, and `switch_subtask_model` lets it move one to another
model. Existing collaboration messaging and the agent API
handle interaction; users may also archive through the API.

```text
Bot or task
└── Subtask (shared folder or project workspace)
    ├── Subtask in project A's workspace
    └── Subtask in project B's workspace
```

Active bots and active tasks are the roots of subtask trees. The two-level limit counts ancestry
below that root, not siblings. Ordinary agents cannot create subtasks.
A bot whose settings keep it inside its own tree may create only shared-folder subtasks; a
workspace-bound request is refused before any workspace is made.
Creation commits the agent, optional workspace association, and Durable Functions startup intent
together. Initial delivery waits for workspace readiness and uses the agent ID as its durable
message identity. Every full API agent includes its active direct subtasks recursively, including
in bootstrap, in sibling order that `reorder` moves. Workspace-bound subtasks also appear in the
workspace's ordered agent series, whose order is separate.
Archival stops the target and descendants but marks only the target archived, preserving its
history. A workspace-bound subtask and its workspace archive together in one transaction, from
either side; a shared-filesystem subtask never archives the folder it shares.
Another module may create a conversation subtask with `createConversation`: it shares the parent's
folder, has no opening task, is marked `subtaskConversation`, and does not report its runs to the
parent, because that module delivers its messages itself. The exported bots module holds each
guest's chat this way.
A subtask runs in its coordinator's persistent permission mode unless `read_only` hands it less or
`full_mode`, from a coordinator in Full access, asks for Full access. Creation settles the mode and
records it with the durable start, because the start runs on a context that names no agent.
Modules creating subtasks of their own, such as Voice and Prioritizing, get the product default.
`switch_subtask_model` takes the same model, effort, harness, provider, and service-tier choices
as creation, checked by collaboration against what new agents are offered. Only the direct
coordinator may use it, on an active subtask. It sends the subtask a short message from the
coordinator through collaboration's `sendMessage` with the new model, so it is the same switch a
person makes from the subtask's conversation: applied when the message is read, after the current
response and tool batch, recorded as the subtask's mode, and introduced by the model-switch notice
when the new model cannot read the old context. An idle subtask wakes on the new model and replies
briefly, which reaches the coordinator as its ordinary report. `send_agent_message` carries the
same fields for a switch that comes with new instructions.
Archival is final: a subtask is never restored. Durable Functions owns post-commit compute
cleanup. Agent Base remains unchanged.
Coordinators are told to mention a subtask as `[title](happy://agents/<agentId>)`, and
`create_subtask` returns that exact link; clients show the subtask's live title as the link text.
