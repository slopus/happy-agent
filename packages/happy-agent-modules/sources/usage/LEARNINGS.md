# Usage learnings

## Publish context after every measured inference

A turn may contain several provider inferences separated by tool execution and compaction. The
current context therefore updates inside the turn, not only when the turn settles. Each inference
completion durably stores and publishes its exact input-plus-output measurement in the same
transaction as the inference usage record. The turn record remains a final reconciliation point,
and successful compaction still clears the measurement until the replacement is measured.
