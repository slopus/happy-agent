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
