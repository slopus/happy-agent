# Usage learnings

## Publish context after every measured inference

A turn may contain several provider inferences separated by tool execution and compaction. The
current context therefore updates inside the turn, not only when the turn settles. Each inference
completion durably stores and publishes its exact input-plus-output measurement in the same
transaction as the inference usage record. The turn record remains a final reconciliation point,
and successful compaction still clears the measurement until the replacement is measured.

## Agent usage tools are structurally self-scoped

The agent-scoped `get_usage` schema omits `target`; rejecting another agent only after execution
advertises a capability the caller does not have and invites guaranteed failures. The host-neutral
tool keeps its target field for collection administration, while an agent tool can read only the
agent identity captured when it was constructed.

## Provider-default inference has no usage tier

The public API uses `null` to select ordinary provider service, while Agent Base needs an explicit
internal `default` value to replace a previously selected priority tier. Usage records omit that
internal value: only actual priority inference is attributed to a tier, and provider-default
inference remains in the ordinary untiered bucket.
