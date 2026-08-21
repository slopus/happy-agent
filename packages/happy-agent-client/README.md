# `@slopus/happy-agent-client`

A typed client for the Happy agent HTTP API, specified endpoint by endpoint in
`packages/happy-agent/API.md`.

`HappyAgentClient` is built from an endpoint and a bearer token. It has one typed method per
request-response route, and it opens the event journal both as pulled pages and as a typed
async iterator over the live Server-Sent Events stream, cancelled with an `AbortSignal`.
`updates()` adds the durable client-side behavior a live view normally needs: it reconnects with
exponential backoff from the last accepted cursor, filters duplicate and outdated events, and
emits ordered `connected`, `state_lost`, `disconnected`, and `event` items. A state-loss item
carries the fresh cursor from which authoritative snapshots can be reloaded. Resource caching,
version reconciliation, and optimistic mutations remain decisions for the live view built on top.

`HappyReducer` is the small stateful layer over that feed. Construct it with a client, register
update listeners, and start it when the application wants live synchronization. `getState()` and
`subscribe()` expose a read-only Zustand-style external store suitable for
`useSyncExternalStore`: the snapshot reference changes only when state changes. Every update
listener registered with `subscribeUpdates()` receives every original ordered SSE item—connection
changes, state loss, and ordinary events—after it has been reduced, together with that immutable
snapshot. The initial state contains only `connection`, with `"connecting"`,
`"connected"`, and `"disconnected"` values. Stopping is synchronous, immediately makes the
reducer disconnected, and ignores any late update while stream cleanup finishes internally. A
later start resumes from the last cursor the reducer observed.

```ts
const reducer = new HappyReducer(client);
const removeUpdateSubscription = reducer.subscribeUpdates((update, state) => {
    console.log(update.kind, state.connection);
});
const removeStateSubscription = reducer.subscribe((state, previousState) => {
    console.log(previousState.connection, "→", state.connection);
});

reducer.start();
console.log(reducer.getState());
reducer.stop();
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
