# Compaction learnings

## Compaction is a history message

A person-visible compaction is not a parallel API resource. It is one durable `service` message
whose sole content block is typed as `compaction`. The message ID is the stable compaction ID.
Manual compaction owns a standalone maintenance run with that same ID; automatic compaction joins
the active run. Clients recover both running and terminal state through normal message history and
never infer lifecycle from agent status or human-readable text.

Model-context replacement is provider-owned state, not history provenance. The public block does
not expose replaced message identities, and code must never scan person-visible history positions
to infer what a compaction replaced.

## History and events move together

Creating or updating the compaction message and appending its raw agent-journal event are one
transaction. The API projects those durable facts through ordinary `message.created` and
`message.updated` events. The module's private table exists only to correlate provider attempts,
enforce one running attempt per agent, and attach the first later context measurement; it is not a
second public source of truth.

## Provider usage replaces the provisional source size

A running compaction may begin with the most recent context measurement so the UI has an immediate
provisional size. Once the provider completes, a usable normalized `usage.input` is the exact
source size and replaces that provisional value. Native compaction may report multiple iterations,
so retaining the earlier inference measurement can undercount the source substantially. A zero
input does not replace a known positive context because test doubles and providers without a
measurement use zeroed usage objects. The generated compaction output is not part of the source
size.

## Recovery must settle visible state

Failure, cancellation, settlement without a provider outcome, and daemon restart all move a
running message to a terminal failure with a displayable reason. Startup performs this repair
before readiness, so reconnect cannot leave the transcript permanently showing an active
compaction.
