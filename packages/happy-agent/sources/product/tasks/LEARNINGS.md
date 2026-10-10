# Native task learnings

Tasks remain per agent in the original task-state table. Each mutation reads, decides, writes,
and invokes transactional listeners in the caller's transaction. The native database transaction
already serializes the full operation, so no additional promise queue or authoritative cache is
needed. Notifications publish only after commit.

Dependencies are stored in both directions. Updating a task can change another task's forward
dependencies; reverse links are then derived in display order. Completing a dependency hides it
from list output while retaining the full graph in storage and detail lookups. Removing a task
unlinks it and compacts every remaining ordering in the same transaction.

Task creation uses the tool-call identity and reports duplicate IDs as an ordinary domain error.
All mutation tools are transactional and durable. Lookup and listing are also reloadable. Metadata
has the original depth and byte bounds, null patches delete keys, and string normalization follows
JavaScript's precise whitespace set, including the byte-order mark.
