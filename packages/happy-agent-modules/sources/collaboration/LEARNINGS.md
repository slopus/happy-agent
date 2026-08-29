# Collaboration learnings

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
