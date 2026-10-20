# Collaboration learnings

## Subtasks reuse messaging and model selection

Interactive subtasks are a separate creation surface, but use collaboration's same curated model
selection and message delivery. Archived agents refuse further collaboration messages, and a
settling child does not reactivate an archived parent with its automatic report. Model-tool
messaging runs transactionally so checking archival and admitting the message share a snapshot.

Broad creation guidance encouraged user-visible subtasks for small steps. Compact guidance now
reserves `create_subtask` for substantial, distinct workstreams, such as changes across projects,
or explicit subtask requests. Small steps stay inline; ordinary `create_agent` handles hidden
internal work such as research. Second-level subtasks should usually be explicitly requested by
the user. Eligibility and depth enforcement are unchanged.

## Subtasks belong to the tree but consume no collaborator limits

Subtasks live in the same Agent Base parent graph as hidden collaborators, and the `create_agent`
limits counted them as collaborators. A task with five subtasks could not create a collaborator,
neither could any of its subtasks, and a second-level subtask failed on depth before creating
anything. A bot or task may have any number of subtasks; their nesting is limited only by the
subtasks module. Subtasks are not separate roots, unlike workflow agents: they stay in their bot's
or task's tree, and the hidden collaborators any subtask creates share that tree's one budget. A
subtask itself is never counted toward `max_collaborators` and adds no level toward
`max_collaboration_depth`. The check reads a local schema of the `subtask` marker because the
subtasks module depends on this one, not the other way round.

## Broken collaborators can be archived to free their slot

Five collaborators created on a provider whose API key was invalid all failed at once. Their
model could not change, messages only reached the same broken provider, and nothing could remove
them, so they held every `max_collaborators` slot and the tree could create no collaborator on a
working model. `archive_agent` now lets a creator archive an ordinary collaborator it created
directly. Archival aborts the collaborator's subtree, marks only the collaborator archived,
preserves its history, and releases its machine after commit. Archived collaborators no longer
count toward the limit, but anything below them still does. The limit error and the
`create_agent` description point to `archive_agent`. Subtasks keep `archive_subtask`, and
workflow agents remain owned by their workflow.

## Spawn rows describe resolved execution, not task titles

A creation row cannot infer its model from the task name or wait for an arbitrary result string.
The creation path now resolves the eligible model/provider pair once, writes its complete typed
identity through History before creating the child, and adds the child ID only after initial
delivery succeeds. Replay keeps the recorded model name and provider; catalog/configuration
changes must not relabel historical spawns. The call's status describes creation, not the child's
later work. These facts belong to the feature modules, without changing frozen Agent Base.

## The opening task records the collaborator's mode

A collaborator ran on the model its creator chose, but nothing recorded that choice as the
agent's mode, so the mode endpoint and bootstrap reported `null`. Clients treat a null mode as
"use the daemon defaults", so the first user message to a user-visible subtask silently moved it
onto the default model, and could reset its context when the default was another provider type.
Every creation path now resolves the provider, sends the opening task with the creator's
permission mode, stamps the full mode on that message's metadata, and records it as the
agent's `lastMode`, so a person joining composes on top of the coordinator's selection.

## A collaborator inherits its creator's permission mode and, by default, its model

Every collaborator used to start in Auto whatever its creator ran in. A Full access creator's
children then paid for an Auto reviewer on every boundary action, and a Read only or guest creator
could reach Auto through a child. A collaborator now works under its creator's mode: the one on
the creator's turn, or the creator's recorded last mode when a workflow creates it off-turn.
`create_agent` also required a model and an effort, so models routinely picked a higher effort
than their own. As in Codex's `spawn_agent`, both may now be omitted and default to the
creator's, and the description says to set them only when the user or the task calls for it.

Codex's `spawn_agent` also tells the model not to spawn unless the user or AGENTS.md explicitly
asks for delegation. `create_agent` deliberately does not: delegation is a core Happy feature, and
that rule would switch it off in practice. The waste it would have prevented came from how the child
ran (a higher effort and an Auto reviewer), which inheritance fixes.

## Messages and interruption

Messages between a creator and collaborator are steering in both directions. After the opening task
starts a collaborator, either recipient should incorporate a later message after its current
response and complete tool batch rather than waiting for its active run to finish normally.

An explicitly interrupted collaborator sends no automatic settlement report. Its creator already
observed the interrupt result, and any earlier commentary is incomplete progress rather than a
final answer. The interrupted agent remains durable and can still receive a later follow-up.

## Subagent model availability

Ordinary model availability and delegation availability are separate choices. Provider-level
`include_subagent_models` and `exclude_subagent_models` narrow only new collaborator selection,
with exclusions winning. The same filtered list must drive the creation tool's description and its
runtime validation, including direct creation from workflows, so a hidden path cannot select a
model the creating agent was not offered.

## Agent IDs and cross-workspace messaging

Every agent is told its own Agent ID on every turn, including a root with no collaborators.
`features.cross_workspace` is enabled by default; while enabled, `send_agent_message` accepts any
existing agent whose unguessable ID was shared with the sender. Explicitly disabling it limits
messaging to direct creator and collaborator relationships. Unknown IDs are rejected before
delivery. Cross-workspace access does not broaden `interrupt_agent`, which remains ancestry-scoped
because it is destructive.

## Unreported agents are told nobody collects their answer

An exported bot's conversation is a subtask whose runs answer a person in an outside chat, so reporting
each one to the bot would flood the bot with chats it did not start. `unreportedAgentMetadata()`
gives a module that creates such an agent itself the same `reportToCreator: false` decision
`createAgent` records, so its settlement never reaches the creator. The creator line in the
instructions now follows that decision: an unreported agent is told to use `send_agent_message`
when its creator needs to hear from it, rather than that its final words are reported.

## A bot can keep its agents' messages inside its own tree

`features.cross_workspace` remains the installation switch, and a bot setting can only narrow it.
When a bot keeps its agents inside its own tree, `send_agent_message` reaches only agents of that
tree, the cross-workspace instruction is withheld, and the tool describes itself without
cross-workspace reach. Direct parent and child messages are always allowed. The tool hook became
asynchronous because the answer depends on the agent's bot.

## Files in text read elsewhere are linked through the Agent ID

A subtask's report named files as `path:line`, and a parent relaying it showed paths that resolved
against the parent's workspace, so they could not be opened. Agents are now told, next to their
Agent ID, to write a file that will be read outside their own chat as
`[name:line](happy-file://agents/<own ID>/<path>#L…)`, to use another agent's or a workspace's ID
for files elsewhere, and to copy received links unchanged. Plain `path:line` remains the default
inside the agent's own chat. The guidance lives here because the Agent ID it builds on does.
