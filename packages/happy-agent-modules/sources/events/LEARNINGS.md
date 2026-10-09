# Events learnings

## Oversized tool arguments belong in History, not repeated replay projections

An explicit tool request can contain arguments larger than the event journal permits. Repeating
them in raw events, tool presentations, and active-run partials can prevent dispatch from committing
before Agent Base can record an ordinary failed tool result. Bound argument copies in completed
tool-call and dispatch events with a readable reference to the original History message. Keep call
and run identities unchanged and leave the exact input in canonical History and execution context.

## Streamed fragments are live, not journaled

Every streamed text, reasoning, and tool-argument fragment used to be its own journal transaction:
an event row, a latest-event update, a full active-run rewrite, the Happy projection, and a synced
commit. One agent streaming a tool call produced about fifty of these a second. On Happy Core that
pinned the daemon's only JavaScript thread, and every HTTP request, including unauthenticated
ones, stalled for hundreds of milliseconds at a time. Nothing reads the fragments back: the
journal rows are reloaded only to refill the replay window, phone sync ignores deltas, and
restoration resets an interrupted block anyway.

Tool-argument fragments are now dropped. A tool call is announced when its generation starts and,
with complete arguments, when it ends; tool execution events follow. Text and reasoning fragments
update the in-memory run and go straight to live subscribers, so the desktop still receives
`message.delta`. The durable start and end bracket each block, and the end carries the complete
text.

The API contract is unchanged. A streamed fragment still mints a UUIDv7 agent version, and
`agent.updated` still carries its `previousVersion` and `version`. Those versions live in a bounded
in-memory overlay that `previousCursor` and `latestAgentEvent` merge with the durable answer. A
restart forgets them, and the next durable event is newer than any of them. A lookup that falls
behind the bounded tail answers with the durable predecessor, which a client sees as a version gap
and repairs by refetching.

## Retention must not rank the whole window on every append

A full window is the steady state, so the retention check runs on nearly every append. Ranking all
ten thousand rows with window functions to find the cut took about nine milliseconds per append and
was the largest single cost inside the stalls. The cut is now read by key order: an offset for the
count bound and a short oldest-first walk for the byte bound. In-memory cursor lookups use a
position index instead of scanning the window.
