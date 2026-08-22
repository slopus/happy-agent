# `@slopus/happy-agent-client`

A typed client for the Happy agent HTTP API, specified endpoint by endpoint in
`packages/happy-agent/API.md`.

`HappyAgentClient` is built from an endpoint and a bearer token. It has one typed method per
request-response route, and it opens the event journal both as pulled pages and as a typed
async iterator over the live Server-Sent Events stream, cancelled with an `AbortSignal`.
`updates()` adds the durable client-side behavior a live view normally needs: it reconnects with
exponential backoff from the last accepted cursor, filters duplicate and outdated events, and
emits ordered `connected`, `daemon_started`, `draining`, `state_lost`, `disconnected`, and `event`
items. The stream hello carries a per-process daemon identity, so `daemon_started` appears once for
the first process and again only after reconnecting to a replacement. A state-loss item carries
the fresh cursor from which authoritative snapshots can be reloaded. Resource caching, version
reconciliation, and optimistic mutations remain decisions for the live view built on top.

`HappyReducer` is the stateful layer over that feed. Construct it with a client, register update
listeners, and start it when the application wants live synchronization. `getState()` and
`subscribe()` expose a read-only Zustand-style external store suitable for `useSyncExternalStore`:
the snapshot reference changes only when state changes, and unchanged agent children retain their
references. Every listener registered with `subscribeUpdates()` receives every original ordered
SSE item—connection changes, state loss, and ordinary events—after reduction, together with the
current snapshot. Connection state includes `draining` while the daemon remains connected for
reads but no longer admits mutations.

State contains `connection` and an `agents` record keyed by Agent ID. Calling `agentVisible(id)`
registers visible interest and returns an idempotent cleanup that lowers the agent to background
priority. One agent bootstrap supplies its draft, last-used provider/model, context occupancy,
pending input, current activity phase, processes, and direct subagents. The reducer also reads the
focused question endpoint, and calls the separate activity endpoint only when an older compatible
daemon omits the additive activity fields. Pending messages leave state when a run accepts them;
the question becomes `null` when it is answered or canceled. At most three agents sync at once;
visible agents are selected before tracked background agents. The reducer opens SSE first, retains
a bounded 60-second event window, and reconciles each field against its private cursor before
reapplying events received during snapshot loading. A stream gap or broken resource-version chain
marks affected agents dirty and queues an authoritative refresh. Failed reads retry with
exponential backoff.

Stopping is synchronous: it immediately makes the reducer disconnected, aborts snapshot reads,
and ignores late results. A later start resumes the SSE cursor and refreshes every tracked agent.

```ts
const reducer = new HappyReducer(client);
const hideAgent = reducer.agentVisible(agentId);
const removeUpdateSubscription = reducer.subscribeUpdates((update, state) => {
    console.log(update.kind, state.connection);
});
const removeStateSubscription = reducer.subscribe((state, previousState) => {
    console.log(previousState.connection, "→", state.connection);
});

reducer.start();
console.log(reducer.getState());
reducer.stop();
hideAgent();
removeUpdateSubscription();
removeStateSubscription();
```

It is built on plain Web APIs — `fetch`, streams, `AbortController`, standard timers — so the
same build runs unchanged in Node and in a browser. The daemon listens on a Unix domain
socket; a caller reaching one supplies its own runtime's socket-capable `fetch`, and the
client never dials a socket itself or reads credentials from disk.

`applyMessageDelta` implements the protocol's offset-aware text reduction without adding client
state: exact and overlapping replays converge idempotently, while a gap or conflicting overlap
returns `reconcile` so the caller can replace the message from authoritative history.

Protocol shapes live in `sources/protocol/`, one file per API chapter, with shared wire
values declared as TypeBox schemas and their TypeScript types derived with `Static`.

Tool calls expose the complete `ToolPresentation` discriminated union — exploration, command,
background-terminal interaction, file diff, and web/X search — together with an exported TypeBox
schema for each variant and `toolPresentationSchema` for the whole set.

Focused agent responses and agent bootstrap include the current module-contributed slash-command
catalog. `invokeSlashCommand` executes one through its owning module, while
`agent.slash_commands.updated` carries complete catalog replacements discovered at turn time.
