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

## Subtasks are substantial workstreams, not small steps

Broadly preferring interactive delegation encouraged unnecessary task splitting and nesting.
Compact prompts now reserve subtasks for substantial, distinct workstreams, such as changes across
projects, while small steps stay inline and hidden subagents handle internal research. Explicit
subtask requests are honored within eligibility and depth limits. Second-level subtasks should
usually be explicitly requested by the user. These are prompt defaults, not new runtime restrictions.

## Titles are short sidebar labels

Subtask session titles were too long for the sidebar. The creation tool now asks for 2–3 words,
with 4 at most and only as a last resort, and directs task details into the message text. This is
loose prompt guidance, not a runtime word-count limit or automatic truncation.
