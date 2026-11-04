# Events learnings

## Only a person's steering is a run boundary

Every message accepted after provider work began used to open the next run, so each
`send_agent_message` reply or system notice steered into a working agent ended its run as
`aborted/steering` and opened a new one. The transcript became a row of tiny turns, each cut off
with a "Steered after" footer. Steve asked that agent messages not create a new turn. Steering
that does not carry a person's origin (user or guest) now joins the active run, and its
`message.accepted` payload carries `joinedRun: true` so the API and Happy projections show it inside
that run instead of announcing a boundary. A joined message is not added to the run's accepted IDs;
those only bound the messages that opened it. Queued messages and anything reaching an idle agent
still open a run.

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

## Restoration is recorded on first use, and open runs are reset at start

Every restart used to record `agent.restored` for every agent. The API answers that event with an
`agent.updated`, so a restart of a thousand idle agents moved every agent's version, `updatedAt`,
and cursor without anything having changed, and journaled a thousand events before ready. Agent
Base now restores at start only the agents with work and the rest on first use, so the event is
recorded once per process for each agent the process uses. No client reads `agent.restored`
itself. An open run is still reset at start: the module names the agents in its active-run
projection through `agentsToRestoreTransact`, so a client never keeps showing a block that nobody
is writing until someone happens to use that agent.

## Retention must not rank the whole window on every append

A full window is the steady state, so the retention check runs on nearly every append. Ranking all
ten thousand rows with window functions to find the cut took about nine milliseconds per append and
was the largest single cost inside the stalls. The cut is now read by key order: an offset for the
count bound and a short oldest-first walk for the byte bound. In-memory cursor lookups use a
position index instead of scanning the window.

## The window starts without its payloads

Starting the journal read every retained payload: about 15 MB for a full window of a long-lived
installation, 180 ms of a 1.4 s start, and memory held for the life of the process. Nothing in the
daemon reads a restored payload; only `replay` and `messageCursor` can, and neither runs on the
start path. The window now starts with each event's identity, agent, time, and type, plus the
stored size SQLite reports without reading the text, so an oversized row still stops the start.
The first replay reads the payloads of whatever restored events are still retained, once, for
every caller waiting on it. A malformed payload is therefore found by that replay rather than at
start, and one trimmed before anything asked is never read at all.
