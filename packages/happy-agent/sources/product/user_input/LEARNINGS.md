# Native user input learnings

Questions retain the original tool-call identity across restart. Creating a request again checks
its owner and normalized questions, then rejoins the same durable row. Relative deadlines remain
anchored to its original creation time. The waiting tool is reloadable so graceful drain can leave
the original pending call for the next daemon.

Waiting never retains a database transaction. A bounded watch counter wakes callers, which read
the authoritative request again; presence has its own subscription. Request mutations and
transactional listeners share the caller's transaction, while notifications run after commit.

The shipped module treats away and timeout as terminal outcomes. Its model text still describes
them as waiting in the inbox. Preserve those existing semantics during the rewrite; allowing a
later answer would be new product behavior. Presence changes reset the presence wait duration,
while a request's own deadline remains absolute. When both deadlines exist, the original timeout
validation requires the request deadline even if the presence deadline was earlier.
