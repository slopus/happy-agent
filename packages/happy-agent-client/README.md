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

Remote connection rosters are read with `listConnections()`. The typed `connections.updated`
event carries the complete `{ connections, version }` snapshot: keep the greater UUIDv7 version
across list responses and events, ignoring duplicate or older snapshots. An empty array clears
the roster. Capture a cursor before the initial roster read and follow updates after it to avoid
missing a concurrent change. Refetch on state loss or daemon replacement. The list's `version`
is optional for older daemons. `authentication: "workos"` identifies team remotes
and includes `organizationId`; `"bearer"` identifies standalone remotes. Older daemons may support
roster reads without emitting this additive event. `connection(id)` creates a separate client
for the selected remote, without merging its events or state into the parent.

Installation display information is `config.node`, read through `getConfig()` and already included
in desktop bootstrap's config. Its `avatar` is either `{ thumbhash }` or `null` when no image is set.
Use `patchConfig({ node: { name } })` to rename the installation independently of `p2p.name`;
avatar mutations belong to admin-bot tools. `getNodeAvatar()` fetches authenticated image bytes,
accepts `ifNoneMatch`, and returns `null` for `304`. An absent image rejects with `404`.
The existing `config.updated` invalidation covers name and avatar changes: refetch config and
conditionally refetch image bytes even if the ThumbHash is unchanged. Serialize config refreshes
and refresh again if an invalidation arrives during a read. Follow the bootstrap cursor and refetch
on state loss or daemon replacement. Older compatible daemons may omit `config.node` and return
`404` for the avatar route; absence means this feature is unavailable, not that the node has no image.

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

Happy integration state is available in the desktop bootstrap and through focused read, start,
cancel, disconnect, and re-pair methods. Its `status` is a discriminated union: pairing always has
renderable opaque QR data, failure always has a display-safe error, and connected states always
carry configured credentials. A desktop client installs the bootstrap snapshot, follows complete
`happy.integration.updated` replacements from the bootstrap cursor, and keeps the greater version.
The integration remains separate from required onboarding, so a product may present pairing as an
optional onboarding screen or later in settings without changing onboarding completion.

The global secrets surface exposes only safe metadata: descriptions, environment-variable names,
availability, attachments, versions, and timestamps. Raw values appear only in typed create and
update request bodies. Project, workspace, and exact-agent attachment targets are discriminated by
`type`; attach results preserve the meaningful `200` versus `201` status. The event union includes
versioned secret changes and immutable attachment creation/removal without introducing a value-
bearing response or event type.

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

`HAPPY_AGENT_PROTOCOL_VERSION` is 25; `HAPPY_AGENT_MIN_PROTOCOL_VERSION` is 22. The range
is additive, so clients should not require exact protocol equality for existing features.
Creating a bot without `name` requires a daemon advertising protocol 24 or newer. With
an older compatible daemon, supply a deliberate name or leave unnamed creation unavailable.
An application that requires unnamed creation may require protocol 24 throughout its UI.

`createBot({ id, workspaceId, agentId })` supports optimistic creation on protocol 25+. The caller
checks the daemon's protocol and may open the conversation locally, queuing sends until creation
succeeds. Keep `id` for retries; conflicting child IDs return `409`. Omitted IDs are daemon-generated.

Tool calls expose the complete `ToolPresentation` discriminated union — exploration, command,
background-terminal interaction, file diff, and web/X search — together with an exported TypeBox
schema for each variant and `toolPresentationSchema` for the whole set.

Cloud exposes WorkOS authentication and organization management. Use `getCloud()` for local
status, `startCloudAuthorization()` and `completeCloudAuthorization()` for PKCE sign-in,
`mintCloudAccessToken()` for a verified access token, and `disconnectCloud()` for local sign-out.
`listCloudOrganizations()`, `createCloudOrganization()`, and `deleteCloudOrganization()` manage
the connected user's organizations. Desktop bootstrap includes the Cloud snapshot; follow
`cloud.updated` replacements and keep the greater version.

Focused agent responses and agent bootstrap include the current module-contributed slash-command
catalog. `invokeSlashCommand` executes one through its owning module, while
`agent.slash_commands.updated` carries complete catalog replacements discovered at turn time.
