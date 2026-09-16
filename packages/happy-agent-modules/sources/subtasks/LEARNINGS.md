# Subtasks learnings

## User interaction is independent of parent management

Treating every parent-managed agent as a hidden, read-only subagent prevents a person from
participating in delegated work. Subtasks explicitly retain their parent while allowing user
messages and archival. Ordinary subagents keep their existing restrictions. Depth is limited to
two subtask levels below a bot, not two children, so one task may coordinate several projects.

## One new tool creates work; existing surfaces handle the rest

Subtasks add only `create_subtask`, not a wait tool or a create/archive multiplexer. Follow-ups use
existing agent messaging; users archive through the existing agent API. A workspace identifies
its resident subtask, whose parent identifies the coordinator. Sharing the parent's filesystem
does not add a second workspace association.
