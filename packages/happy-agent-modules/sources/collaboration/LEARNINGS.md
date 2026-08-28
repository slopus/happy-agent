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
