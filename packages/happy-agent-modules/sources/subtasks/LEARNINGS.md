# Subtasks learnings

## User interaction is independent of parent management

Treating every parent-managed agent as a hidden, read-only subagent prevents a person from
participating in delegated work. Subtasks explicitly retain their parent while allowing user
messages and archival. Ordinary subagents keep their existing restrictions. Depth is limited to
two subtask levels below a bot, not two children, so one task may coordinate several projects.

## Coordinators create and archive; existing messaging handles interaction

Subtasks use `create_subtask` and `archive_subtask`, never a wait tool or a create/archive
multiplexer. Follow-ups use existing agent messaging. Only the direct coordinating bot or subtask
may archive through the tool; users retain the agent API. Archival marks only the selected agent,
stops its running descendants, and preserves history and workspace. Metadata, cancellation, and
durable compute-cleanup intent commit together; cleanup starts after commit and restoration cancels
pending cleanup. A workspace identifies its resident subtask, whose parent identifies the coordinator.
Sharing the parent's filesystem does not add a second workspace association.

## Interactive delegation is the default for eligible agents

Generic collaboration guidance did not distinguish human-collaborative tasks from hidden internal
work. Bots and subtasks now prefer subtasks for delegated work the user may collaborate on and
honor explicit subtask requests. Ordinary subagents remain appropriate for internal research and
other parts that need no human collaboration. This does not allow ordinary agents to create
subtasks or extend the two-level hierarchy.
