# Collaboration learnings

An agent's durable inbox, ancestry and settlement belong to Agent Base.
Collaboration keeps no parallel agent or message tables. Its four original
migration keys retain their released meanings, ending with removal of obsolete
collaboration storage.

New collaborator selection and the advertised creation choices use the same
enabled, curated subagent catalog. Exclusions win over inclusions. The creator's
account is preferred only when it serves the requested model; otherwise an
ambiguous model needs an explicit account. The opening task records the complete
selected mode and `lastMode`, including the initial permission mode. Later
messages steer without selecting a new model or changing permissions.

A model-facing creation retains its resolved model identity in the original
history tool call before creating the child. The child ID is added only after
opening delivery succeeds. Replaying that call must preserve the recorded model
name and account and reuse the same child and message identities. Tool capacity
is checked in the same transaction as creation; workflow-owned roots have their
own budget.

Automatic settlement reports commit with the child's settlement and use its
stable settlement identity for delivery. The report contains the last completed
text or the real settlement error when no answer exists. An explicit interrupt
sends no report. Archived parents are never reactivated by a report, and archived
recipients refuse ordinary messages.

Cross-workspace messaging uses shared unguessable agent IDs when enabled.
Disabling it retains direct parent and child messaging only. Destructive
interruption always checks that direct relationship and its tool owns automatic
review. User-visible subtasks reuse this same selection and delivery contract.
