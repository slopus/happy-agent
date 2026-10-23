# `@slopus/happy-agent-client`

A typed client for the Happy agent HTTP API, specified endpoint by endpoint in
`packages/happy-agent/API.md`.

Surfaces are named instances of predefined shared features. `createSurface()` creates a todo
list with its own CUID2 ID, name, and optional managed image. `listSurfaces()` returns the catalog with `members`
nested inside every Surface, `[]` when nobody joined. Each member's `orderKey` places that
Surface in that person's sidebar. `joinSurface()`, `leaveSurface()`, and `reorderSurface()`
change only the caller's member record. Standalone members have `userId: null`, as in the
profile; team members use their installation-local Happy user ID. Desktop bootstrap's optional `surfaces`
field composes these same objects. Older daemons return `404` or `501` for the catalog. Follow
shared `surface.updated` and use its normal version chain to reconcile the complete member array.
When health reports `capabilities.surfaceEditing`, `updateSurface(surfaceId, { name, image })`
renames a Surface or replaces its image, and `image: null` removes it. `surface.updated` then
carries the new `name` or `image`; refetch the image bytes when `image` is present.

The first Surface type is Todo, served at `/v0/surfaces/todo/:surfaceId`. Every todo method takes
the Surface ID first. `listTodos(surfaceId)` loads every active todo
in fractional key order; use `scope: "completed"`, `"deleted"`, or `"all"` for other states.
`createTodo()` appends; supply an ID to resolve an uncertain creation result. `updateTodo()`
edits text or status, and `reorderTodo()` moves active items only. `deleteTodo()` retains a
tombstone; updating an inactive todo to `status: "active"` appends it at the end. Every mutation of an existing todo takes
`ifMatch` with its current version. `listTodoVersions()` and `getTodoVersion()` expose permanent
full revisions with trusted actor and source details. To apply a previous state, read its fields
and use ordinary update and reorder operations with the current version. There is no separate
restoring command. Todo access never joins the caller.
Follow shared `todo.created` and `todo.updated` from the list cursor, refetching on a version gap.
The client exposes these events without adding an automatic Todo store to `HappyReducer`.

System Monitor Surfaces are served at `/v0/surfaces/system-monitor/:surfaceId` when health reports
`capabilities.systemMonitorSurfaces`. `getSystemMonitor(surfaceId)` returns the host snapshot
directly, including CPU, GPU, memory, disks, disk activity, bounded history, and a nullable live
process list. Poll at `intervalMs` while visible. Missing readings are null or empty arrays;
there are no telemetry events or content versions. Process CPU uses a whole-machine percentage,
and process names never include arguments or environments.

Calendar Surfaces are served at `/v0/surfaces/calendar/:surfaceId` when health reports
`capabilities.calendarSurfaces`. `listCalendarEvents(surfaceId, { from, to, timeZone })` reads at
most 100 days of daemon-expanded occurrences with the events they belong to; never expand
recurrence in the client. `createCalendarEvent()`, `updateCalendarEvent()`, and
`deleteCalendarEvent()` change whole series, and mutations of existing events take `ifMatch`.
`listCalendarEventVersions()` and `getCalendarEventVersion()` expose permanent full snapshots;
restore one by sending its fields through ordinary update. After `calendar_event.created` or
`calendar_event.updated` for a shown calendar, read the visible range again.

Chat Surfaces are conversations among people, served at `/v0/surfaces/chat/:surfaceId/messages`
when health reports `capabilities.chatSurfaces`. Their messages are separate from every Surface's
shared agent chat (`ensureSurfaceChat()`). `listSurfaceMessages(surfaceId)` reads the newest page,
oldest first; continue older with `beforeSeq: nextBeforeSeq` or forward with `afterSeq`.
`sendSurfaceMessage()` takes a client-generated `id` so a retry never posts twice.
`editSurfaceMessage()` and `deleteSurfaceMessage()` take `ifMatch` and are refused with
`forbidden` for anyone but the author. `listSurfaceMessageVersions()` and
`getSurfaceMessageVersion()` expose permanent snapshots, including a deleted message's text.
Follow `surface_message.created` and `surface_message.updated`; when a created message's `seq` is
not one past the newest held, read forward with `afterSeq`.

`HappyAgentClient` is built from an endpoint and a bearer token. The token may be a function called
for every request, so refreshed credentials apply without a new client; it may be omitted only to
call `getAuthentication()` before signing in.

`getAuthentication()` reports whether the client is signed in and lists sign-in methods. An `oauth`
method uses the authorization code flow with PKCE, talking to the deployer's authorization server
directly; the daemon never sees the code, the PKCE verifier, or a refresh token.
`beginOAuthSignIn(method, { redirectUri })` returns the URL to open in the system browser, the
server's `host` to show the person, and the state and verifier to keep in memory.
`completeOAuthSignIn(signIn, callbackUrl)` checks `state` and exchanges the code at that method's
token URL. `refreshOAuthCredential(credential)` refreshes only at the refresh URL recorded at
sign-in, never at one a daemon advertises later. Failures throw `HappyAgentOAuthError` with an OAuth
or client `code`. In JWT team mode, a `401` `HappyAgentApiError` carries the same methods in
`authentication`. Unknown method types are skipped. Older daemons return `404` for discovery.

Remote connection rosters are read with `listConnections()`. The typed `connections.updated`
event carries the complete `{ connections, version }` snapshot: keep the greater UUIDv7 version
across list responses and events, ignoring duplicate or older snapshots. An empty array clears
the roster. Capture a cursor before the initial roster read and follow updates after it to avoid
missing a concurrent change. Refetch on state loss or daemon replacement. The list's `version`
is optional for older daemons. `authentication: "workos"` identifies team remotes
and includes `organizationId`; `"bearer"` identifies standalone remotes. Older daemons may support
roster reads without emitting this additive event. `connection(id)` creates a separate client
for the selected remote, without merging its events or state into the parent.

Ordering-capable daemons return a required fractional `orderKey` on every connection, backfill
existing connections in their previous order, and append new ones at the end. The roster is
already sorted by key. Use `reorderConnection(id, { afterId, mutationId }, { ifMatch: version })`
to move one after another, or pass `afterId: null` to move it first. The response and the existing
`connections.updated` event carry the complete ordered roster; neighbours retain their keys.
Older daemons may omit keys and return `404` for reordering; leave the feature unavailable there.

Runners are read with `listRunners()`. The typed `runners.updated` event carries the complete
`{ runners, version }` list, in ascending ID order, after any runner changes, connection status
included. Keep the greater UUIDv7 version across list responses and events, ignoring duplicate or
older lists. Capture a cursor before the initial read and follow updates after it to avoid missing
a concurrent change; refetch on state loss or daemon replacement. Each runner reports its
`status`, whether it is the `default`, the `machine` it last reported (or `null` before it has ever
connected), its runner `protocol`, `since`, and the last disconnection `reason`. Tokens and
transport addresses never appear. Runners require protocol 26: older daemons answer `404`, so
treat runners as unavailable there.

Provider-account usage is read with `getUsage()` and, from protocol 29, followed live: the typed
`provider.usage.updated` event carries one account's complete entry state — the reading,
`checkedAt`, `error`, `refreshedAt`, `refreshError`, `retryAt`, and `refreshing` — after every
change, so the latest event per `providerId` wins. `refreshProviderUsage({ providerIds,
olderThanMs })` asks for fresher readings and answers at once with `{ started }`; the readings
arrive as events. An entry without `refreshedAt` comes from an older daemon that neither emits the
event nor serves the refresh, so keep polling `getUsage()` there. Readings live in daemon memory;
read `getUsage()` again after a resync or a daemon restart.

A folder on a runner has a `{ type: "runner", runnerId, path }` compute, with `path` in the
runner's filesystem and `null` for the home project before its runner first connects. Docker
workspace computes may carry the mounted `path` and the holding `runnerId`. `registerProject()` and
`cloneProject()` accept an optional `runnerId`; a runner project's `defaultWorkspaceCompute` is
`{ type: "runner", runnerId }` or `{ type: "docker", image, runnerId }`. Work on a folder whose
runner is not connected fails with `503 runner_unavailable`; registering or using a folder on the
daemon's own machine while runners are configured fails with `409 local_execution_disabled`. A
compute `type` this client does not recognize means the folder is on another machine with no
local-path actions.

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
In team mode, these same methods, bootstrap, and events transparently address the authenticated
user's personal mobile connection. Ownership is resolved inside the daemon, not exposed as a new
snapshot field or request argument. Routes, wire shapes, and the protocol version remain unchanged;
no SDK update or capability negotiation is needed. Discard the old snapshot and restart bootstrap
and event subscriptions when switching authenticated users. The daemon filters private mobile
events in both pulls and SSE; a pull page may contain no visible events while advancing its cursor
past another user's events.
The integration remains separate from required onboarding, so a product may present pairing as an
optional onboarding screen or later in settings without changing onboarding completion.

`getUsers()` resolves the authors in message `metadata.userId`. Team mode resolves members and
guests; standalone mode, where `getProfile()` describes the one person, resolves only guests. A
guest is someone who reaches an exported bot from an outside chat service: `kind` is `"guest"` and
`canLogIn` is `false`, and a guest has no photo. Older daemons omit both fields, so treat a missing
`kind` as `"member"` and a missing `canLogIn` as `true`; older daemons also answer `404` in
standalone mode.

User settings are the caller's own opaque key-value preferences, kept on the daemon so they follow
the person across devices: the authenticated member's in team mode, the installation's one person's
in standalone mode. The daemon checks only shape and size. Prefix keys with your application's name
and a dot, such as `happy-desktop.completionSound`. Read `userSettings` from desktop bootstrap, or
use `getUserSettings()`, and follow `user_settings.updated` from that response's `cursor`. A
snapshot replaces the whole local copy. For each event, keep the entry with the greater `version`
for its key. `saveUserSetting(key, { value, updatedAt, mutationId })` sets a value, and
`value: null` clears it. Each key is last-write-wins by `updatedAt`. Send an offline change with the
time the person made it, and adopt the returned entry: it is unchanged when the write was stale. A
clear keeps its version, so a stale device cannot bring the value back. `getUserSetting(key)`
returns an unset entry, never `404`. Invalid keys throw before any request, and the exported
`MAX_USER_SETTING_*` constants are the specified limits. Discard the copy when the authenticated user
changes. An absent bootstrap field, or `404` from `getUserSettings()`, means the daemon has no user
settings, so keep those preferences on the device. Through `connection(id)`, settings belong to the
remote daemon and the person it authenticates.

The mobile connector pairs a phone with this daemon over its own Tailcat socket. The client covers
only the desktop's side: `getMobileConnector()` reads the caller's snapshot, `startMobilePairing()`
returns it with a `happy://direct?…` QR code to show and never log, `confirmMobilePairing(id)` and
`cancelMobilePairing(id)` answer the emoji comparison, and `removeMobileDevice(id)` removes a paired
phone. Every call returns the complete snapshot, and `mobile_connector.updated` delivers it to its
owner only; keep the one with the greater `version`. Phones implement their side natively from the
specification. `404` from `getMobileConnector()` means a daemon older than protocol 27.

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

## Live voice sessions

`createLiveSession({ id, windowId, sdp, credential, contextRevision, context })` binds GPT-Live
to the initiating desktop window and returns its resource and WebRTC SDP answer. Select the
server-held credential explicitly as `{ providerId, type: "codex_subscription" }` or
`{ providerId, type: "openai_api_key" }`. The former is experimental and does not promise
subscription entitlement; the latter opts into API billing. There is no automatic fallback.
The client never receives a provider token or API key.

```text
Client microphone/speaker <— WebRTC —> GPT-Live
Client — authenticated SDP —> Happy daemon — sideband —> GPT-Live
                                   └— typed UI actions/context <—> initiating window
```

Use a stable caller-chosen `id`: creation is never automatically retried, and a repeated ID
returns a conflict with the current session rather than starting another billable call. After
an uncertain outcome, use `getLiveSession(id)` and close before deliberately replacing it.
Follow owner-private `live.session.created` and version-chained `live.session.updated` events
through `updates()`. Refetch on gaps; `HappyReducer` does not maintain a second voice store.

`closeLiveSession(id)` may return `closing`. `closed` means a deliberate end completed, not
that usage was finalized; only `usage.final` confirms the final provider duration. A failed
connection may have `usage.seconds: null`, which is unknown, not zero. Voice closure never
aborts coding sessions or their tasks. The desktop explicitly selects at most five watched sessions.
These additions do not change existing protocol compatibility. Older daemons may return `404`
or `501`; leave voice unavailable rather than changing authentication or silently enabling billing.

Require `getHealth().capabilities?.desktopLiveControl === true` before offering voice startup.
`liveSessionControlUrl(id, windowId)` builds the authenticated WebSocket upgrade address; the
trusted desktop host supplies bearer headers, never URL credentials. The exported
`LiveControlClientMessage` and `LiveControlServerMessage` schemas define both directions.
After verifying `hello` identifies the expected call/window, wait for `status: active`.

The `LiveDesktopAction` union contains state/open, public session read/watch, exact-text message
staging, non-overwriting draft append to an explicitly named session, task creation with an
unsent opening draft, and next-message model selection. Workspace, conversation, and bot creation
remain in the union for older daemons, but current daemons never request them.

Additive capabilities are negotiated per call. When `getHealth().capabilities?.desktopLiveCapabilities`
lists names from `LIVE_DESKTOP_CAPABILITIES`, send the ones the desktop implements as
`desktopCapabilities` and read the accepted set from `hello.capabilities`. `appState` adds the
`LiveAppState` sidebar snapshot (creation `appState` and the `appState` control frame) and task
targets; `voiceFocus` adds the decorative `voiceFocus` highlight frame; `taskCreate` and
`sessionModelChange` add those actions. Never send a frame, field, or target for a capability the
daemon did not accept. Machine voice settings are `config.voice`, changed through
`patchConfig({ voice })`.
The desktop validates target namespaces, context revisions, permissions, and action identities.
It never exposes generic shell/API/JavaScript execution or permission answers. Transcripts are
provider-derived fragments, not authoritative user confirmations. Both interval fields are present
only when the provider supplies real timing; native untimed fragments omit both. A `sessionSend`
result with output `{ type: "staged" }` means the text awaits an independent human Send, never that
it was submitted. Context
contains only bounded visible names, IDs, public user/assistant text, structured status, and draft
presence. A control disconnect ends voice; already-running coding work continues. There is no
automatic controller reconnect or mutation replay, and no older Realtime fallback.

## Sandboxed workspace services

Services are started by an agent's separate `service_start` tool. This client manages and observes
the same execution; it does not expose another command-launch route or a global services catalog.

```text
Workspace client → list/get service → shared process input/output
                                  → stop and observe confirmed teardown
                                  → scoped credential + fixed-endpoint CONNECT
```

Use `listWorkspaceServices(workspaceId)` and `getWorkspaceService(workspaceId, serviceId)` for
discovery. Follow the list's journal `cursor` through `updates()` and reconcile `service.created`
and version-chained `service.updated` events. Refetch on gaps or daemon replacement. Services are
an on-demand surface; `HappyReducer` does not materialize a second service store automatically.
For a known workspace, `404` or `501` means the feature is unavailable, not an empty catalog.

`inputWorkspaceService(workspaceId, serviceId, { readerId, chars, waitMs })` reads when `chars` is
empty and otherwise writes stdin then reads. Give every UI reader its own stable `readerId` so
views do not consume each other's output. This ID grants no permission. Neither reads nor writes
are retried automatically: a lost write response may already have delivered input. The response
includes bounded output, an explicit truncation flag, and the current service snapshot.

`stopWorkspaceService()` records a stop decision. A response with `status: "stopping"` does not
prove the process tree is gone. Workspace `serviceCleanup` progress reports the mandatory barrier
before deleting files; a blocked cleanup keeps the files intact.

Trusted desktop hosts use `issueWorkspaceServiceAccessToken()` and `workspaceServiceProxyUrl()`.
The latter returns an address only: supply normal API authorization and the separately scoped
`WORKSPACE_SERVICE_AUTHORIZATION_HEADER` on CONNECT. Keep these credentials out of URLs, page
JavaScript, ordinary application requests, and unrelated origins. The same methods work through
`client.connection(id)`, preserving that connection's authenticated route. No public sharing or
invitation is created by issuing a token.

## Local bridges

A bridge brings a USB device, a USB Bluetooth adapter, or a local TCP service from the client's
machine to a workspace's machine. The client opens it with a WebSocket and holds it; closing that
WebSocket ends the bridge.

```text
Desktop USB/IP server ⇄ bridges/usb WebSocket ⇄ daemon USB/IP client ⇄ vhci_hcd on the workspace's machine
Program on the workspace's machine → 127.0.0.1:port → bridges/port control: { type: "connection" }
                                                    → bridges/:bridgeId/connections/:id ⇄ local target
```

Require `getHealth().capabilities?.workspaceBridges === true`, then read
`listWorkspaceBridges(workspaceId)` for the workspace's `capabilities` and open `bridges`. Each
capability names a `reason` when unavailable; show its message. Follow the list's `cursor` through
`updates()` for `bridge.created`, version-chained `bridge.updated`, and the
`bridges.capabilities.updated` invalidation. `404` means the daemon has no bridges.

`workspaceUsbBridgeUrl()`, `workspacePortBridgeUrl()`, and `workspaceBridgeConnectionUrl()` build
the WebSocket addresses; supply the bearer token on the upgrade. `WorkspacePortBridgeServerMessage`
and `WorkspacePortBridgeClientMessage` define the port bridge's JSON control messages, and
`WORKSPACE_BRIDGE_CLOSE_CODES` names the close codes. `closeWorkspaceBridge()` closes one bridge.
Forwarding a local port into a workspace uses `workspaceProxyUrl()` with a nested `CONNECT`. All of
these work through `client.connection(id)`.

`workspaceAgentProxyUrl(workspaceId, agentId)` opens the same tunnel in one agent's network. On
protocol 28 or newer, `getWorkspaceAgentNetwork(workspaceId, agentId)` answers `{ networkId }`, the
network that agent's connections leave from, and `networkProxyUrl(networkId)` opens a tunnel in it.
Agents on this computer share one `networkId`, agents on one runner share that runner's, and an
agent in a container has its own, so a browser keeps one profile per `networkId`. Treat the ID as
opaque; `networkProxyUrl` throws for one outside its specified form. A `404` from the network's
`CONNECT` means it is not served right now: read the agent's network again and use what it
returns. A different `networkId` gets a new profile; never move the old profile's cookies to it.

`HAPPY_AGENT_PROTOCOL_VERSION` is 28; `HAPPY_AGENT_MIN_PROTOCOL_VERSION` is 22. The range
is additive, so clients should not require exact protocol equality for existing features.
Creating a bot without `name` requires a daemon advertising protocol 24 or newer. With
an older compatible daemon, supply a deliberate name or leave unnamed creation unavailable.
An application that requires unnamed creation may require protocol 24 throughout its UI.

`createBot({ id, workspaceId, agentId })` supports optimistic creation on protocol 25+. The caller
checks the daemon's protocol and may open the conversation locally, queuing sends until creation
succeeds. Keep `id` for retries; conflicting child IDs return `409`. Omitted IDs are daemon-generated.

Tasks are additive without a protocol bump. Detect support through `listTasks()`: `404` means the
daemon has no tasks. `listTasks()` returns every task, oldest first, and `listTasks({ scope:
"joined" })` only the caller's joined tasks in the caller's order; both carry the caller's
`memberships` in that order. `joinTask()`, `leaveTask()`, and `reorderTask()` change only the
caller's own list. Leaving never archives. `archiveTask()` and `unarchiveTask()` take the task's
`version` as `ifMatch` and succeed only when the task reports `canArchive`; resolve the owner
through `getUsers()` and `getUserPhoto()`. `createTask()` creates a task the caller owns, named or
left to name itself from its first message, and `renameTask()` renames it. A task's
`workspaceId` works with every workspace route, files, terminals, and Git included. Follow `task.created` and `task.updated` for the tasks, and `task.joined`,
`task.reordered`, and `task.left` for the caller's memberships.

Spaces, the sidebar, are additive without a protocol bump. Detect support through `listSpaces()`:
`404` means the daemon has no Spaces. It returns the caller's rows, sections, and the event cursor
to follow `space.*` events from. `createStemCell()` starts new work, `updateSpace()` and
`updateSpaceSection()` apply the person's own changes at once, and `removeSpace()` drops new work
nobody wrote in. Prioritizing, a subtask of Happy, organises the rest; its changes apply in
batches. `reportSpaceAttention()` holds them back while the person is `interacting` and lets one
apply when `calm`, and `tidySpaces()` posts "Tidy the sidebar now" into its conversation. `listSpaceBatches()` reads the applied batches with their notes.
`getSpaceSidebar()` reads the sidebar document with the session icons Prioritizing chose
(`agentIcons`, empty when an older daemon omits it) and `seed: true` while it still mirrors the
classic sidebar.

Artifacts are additive without a protocol bump. Detect support through `listArtifacts()`: `404`
means the daemon has no artifacts. The catalog is global and pages newest-created first; filter it by
`type`, `sourceKind`/`sourceId`, `agentId`, or `authorKind`/`authorId`, and follow
`nextPageCursor`. Every artifact names its extensible `source` and its `createdBy`, `updatedBy`, and
`deletedBy` authors. Each version is a small tree of files: `getArtifactVersion(artifactId, number
or "latest")` returns its manifest and its `entry`, the file to open. Read a file by its path with
`getArtifactFile(artifactId, version, path)`, ranges included, or hand
`artifactFileUrl(artifactId, version, path)` to a frame or media element; every file of a version
shares one URL prefix, so relative references in a Markdown or HTML entry resolve. People publish
binary files with `uploadArtifactFile()` and place them at paths in `createArtifact()` or
`updateArtifact()`, next to text files given inline as `{ path, text }`. `updateArtifact()` makes a
new version from the latest one's files, adding, replacing, or removing paths, and
`deleteArtifact()` leaves a tombstone; both take the artifact's `version` as `ifMatch`.
`listArtifactVersions()` reads the history. Follow `artifact.created`, `artifact.updated`, and
`artifact.deleted`.

Show an artifact on a transparent slot unless its version names `background`, a lowercase hex
colour (`#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa`) to paint behind the content; check
`artifactBackgroundSchema` again before using it, and only as a background colour. Older daemons
omit the field. `createArtifact()` takes an optional `background`, and in `updateArtifact()` a
colour sets it, `null` clears it, and omitting it keeps the latest version's.

HTML artifacts can carry `live: { url, networkId }` on the artifact, its versions, and
`artifact.updated` changes. `null` or absence means file content. When present, open `live.url`
through `artifactProxyUrl(artifactId)` on the same daemon or connection, not through the file
entry or `networkProxyUrl`. This helper only builds the address; the caller opens the raw
`CONNECT` tunnel with its transport and supplies the daemon bearer token. The network is frozen
at creation: if the artifact route or network is unavailable, show an unavailable page rather
than using an unrestricted proxy or another network. The required `entry` remains an inert HTML
notice for older clients. Versions pin the URL and metadata, not the external server's changing
contents.

The daemon checks every destination connection against the artifact's current URL, including
when showing a pinned version. Public destinations are allowed. The only non-public exception
is the exact host and effective port of a recorded `localhost` or literal loopback URL, with
every resolved address loopback. Private LAN and link-local destinations are always refused.
The daemon resolves on its own host and connects the recorded network's machine to the checked
IP literal without a second lookup. The exact recorded loopback exception needs no DNS.
URL updates govern subsequent connections; already-open connections remain.

`artifactAddressPublic`, `artifactAddressLoopback`, and `artifactNetworkHost` share the artifact
address policy between browsers and daemons without Node APIs or DNS. The first two accept IP
literals and return false for invalid addresses. `artifactNetworkHost` uses URL normalization
to classify numeric hostname spellings; it throws when URL parsing fails. Do not use that normalization
for the exact loopback-origin comparison: compare the requested and recorded spellings instead.
Public IPv6 is limited to `2000::/3` excluding `2001::/23`, `2001:db8::/32`, `2002::/16`, and
`3fff::/20`, plus mapped, translated, and well-known NAT64 addresses whose embedded IPv4 is public.
Only `127/8`, `::1`, and mapped/translated `127/8` count as loopback.

Use a browser profile scoped to the artifact ID on its daemon or connection, shared by that
artifact's versions and views but never by other artifacts or the workspace browser. Never send
daemon credentials to the live page, expose the artifact data bridge, or forward its `/api/*`
requests to the daemon. Only agent tools create or change live URLs; the REST request shapes are
unchanged. Metadata-only updates preserve `live`, while file mutations on live artifacts fail.
Use `create_artifact` with `type: "html"` and `url` for live pages. Keep reading legacy `page`
presentations in history.

`MessageMode.account` is optional server-resolved provenance only in configuration/error execution
snapshots, not an account selector. It is absent from user-message/composer modes and drafts.
`null` means unestablished; a known account has an opaque local ID and optional human-readable label.
`MessageMode.providerType` optionally records the canonical configured provider family for that
execution. The client omits both output-only fields from sends, slash-command request modes, and
saved drafts without mutating the caller's snapshot, preserving compatibility with older daemons.
Configuration service messages carry actual before/after execution modes, where `providerId`
is the concrete route rather than the requested routing alias. Their `beforeMessageId` anchor
is nullable: null retains chronological append placement. Desktop can honor an anchor; an
append-only terminal appends when inserting it would move already-stable history.
The initial `before: null` record is a hidden baseline. Render model names from the catalog and
account-only changes within the same known provider family, preserving unknown identities honestly.
Family comes from the persisted snapshot's `providerType`; Bedrock remains Bedrock regardless of
the model vendor. Never derive historical family from the current catalog or provider/model ID prefixes.
A same-family concrete provider change still shows a configured-connection change when vendor
account IDs are unknown. Use configured labels or exact route identifiers, without presenting
those connection names as verified vendor identity.

Error service messages retain full multiline text and may carry `error: MessageError` with the
actual failed mode, a safe credential-source descriptor, manual steps, recovery actions, and optional
copy-only recovery commands. Commands are typed `{ label, command }` values, never extracted from
error text or executed automatically. Manual recovery remains available without another AI credential.
Source kinds and action names are extensible strings. Use `knownCredentialSourceKindSchema`
and `knownErrorRecoveryActionSchema` for recognized semantics; ignore unknown actions and do not
guess a source-specific remedy for an unknown kind. The current action allowlist is `ask_chief`.
Details supplement text rather than replacing or clipping it. The Chief of Staff action uses the
existing bot catalog's `systemKey` to open a diagnostic draft for review, preserving existing draft
text and model selection. Sending requires an explicit user request and ordinary `sendMessage()`;
normal tool permissions and manual instructions remain intact. No credentials or credential-file
paths belong in those details. Older messages without this metadata remain valid.

Global skill management is additive without a protocol bump. Detect support through
`listGlobalSkills()`: `404` or `501` means unavailable; protocol 25 alone does not guarantee support.
`listGlobalSkills()` includes disabled and broken
skills; `getGlobalSkill(id)` returns parsed metadata, the original document, and its Markdown body.
`updateGlobalSkill(id, { enabled, mutationId }, { ifMatch: skill.version })` changes availability
without deleting files. `listGlobalSkillFiles()` pages through supporting files, and
`readGlobalSkillFile()` reads their original bytes, including while disabled.

Follow `skills.updated` from the first catalog page's event `cursor`. Its bounded `skillIds` and
root-relative `paths` invalidate affected catalog pages, details, and open files; `null` means
refresh broadly. An enablement-only change has `paths: []`. Page cursors are separate from journal
cursors, and a `409` during pagination requires restarting the list. Refresh again if an event
arrives during a read, keep the newer summary version, and resync on state loss or daemon replacement.
The client exposes the feed without automatically caching skills in `HappyReducer`. Older daemons'
missing endpoints mean this feature is unavailable, not that no skills are installed.

Tool calls expose the complete `ToolPresentation` discriminated union — exploration, command,
background-terminal interaction, file diff, web/X search, sub-agent creation, media, and
artifact — together with an exported TypeBox schema for each variant and `toolPresentationSchema`
for the whole set.

`MediaPresentation` lists the images, videos, PDF documents, and other files a completed call
showed inline: generated images, images the agent read, and files presented with `present_files`.
Image items always carry displayed `width`, `height`, and a base64 `thumbhash` to show until the
bytes load, and an optional `scale` (2 or 3 for a Retina-density file) that divides them into the
natural CSS size; render an unknown item kind as a file. Its optional `layout` arranges the items:
`columns` with one or two columns, or a `tree` of typed `MediaLayoutNode` elements, item
placements, text, and breaks that an agent wrote and the daemon parsed. No HTML reaches the client.
Each `MediaLayoutStyle` field is a CSS property under its camelCase name with a normalized value
from a closed subset of CSS; check every value with `mediaLayoutStyleValue(key, value)` and drop
any it refuses. Use the automatic layout when `layout` is absent or unrecognized, ignore unknown
style fields, skip out-of-range or repeated item nodes, and show items a tree leaves out after it.
An image without explicit sizing shows at its natural size, shrunk to fit and never enlarged, in
every layout. An item's optional `source`, `{ path, absolutePath }`, names the file it came
from, so layout blocks in agent text can place it. Read an item's bytes with
`getToolCallMedia(agentId, toolCallId, index)`, ranges and `ifNoneMatch` included, or hand
`toolCallMediaUrl(agentId, toolCallId, index)` to an image, video, or document element through a
transport that adds the bearer token. The URL's content never changes. `ArtifactPresentation`
carries the `artifactId`, produced `version`, `artifactType`, and `title` a card needs to open an
artifact a call created or updated. Both are additive; older daemons omit them, and their blocks
keep raw tool data even with `omitToolData: true`.

`AgentSpawnPresentation` carries an optional complete `model: { modelId, providerId, name }`
identity resolved before child creation, and an optional `agentId` after creation and initial-task
delivery succeed. The enclosing tool status owns the spawning/completed/failed lifecycle, not the
child's later work. Use the catalog `model.name` for the inline label, or a generic sub-agent label
when absent; never infer model identity from task titles or raw tool data. The daemon retains the
resolved identity across history loads and restart. Older daemons may omit this additive
presentation; older clients can use raw tool data, which remains present for `agent_spawn` even
with `omitToolData: true`. No protocol-version bump is required.

Cloud exposes WorkOS authentication and organization management. Use `getCloud()` for local
status, `startCloudAuthorization()` and `completeCloudAuthorization()` for PKCE sign-in,
`mintCloudAccessToken()` for a verified access token, and `disconnectCloud()` for local sign-out.
`listCloudOrganizations()`, `createCloudOrganization()`, and `deleteCloudOrganization()` manage
the connected user's organizations. Desktop bootstrap includes the Cloud snapshot; follow
`cloud.updated` replacements and keep the greater version.

Focused agent responses and agent bootstrap include the current module-contributed slash-command
catalog. `invokeSlashCommand` executes one through its owning module, while
`agent.slash_commands.updated` carries complete catalog replacements discovered at turn time.

## Reference tags

Agent text may mention Happy entities as `<happy-artifact id="…"/>`, `<happy-agent id="…"/>`,
`<happy-workspace id="…"/>`, `<happy-project id="…"/>`, or `<happy-service id="…"/>`, as API.md
specifies under "Reference tags". This package holds the one shared parser, so every client and
the daemon agree on what is a tag:

- `parseHappyReferences(markdown, { streaming? })` splits text into `text` and `reference`
  segments. Tags in code spans, fenced code, or after a backslash stay text.
- `replaceHappyReferences(markdown, replace, { streaming? })` substitutes each tag in the Markdown
  source before a Markdown parser sees it. Tags are never Markdown HTML, so substitute them instead
  of reading HTML nodes.
- With `streaming: true`, both functions drop a trailing incomplete tag such as `<happy-arti`.
  `happyReferencePartialTagLength(markdown)` reports how many characters that is.
- `renderHappyReferencesAsMarkdown(markdown, resolve)` is the plain-Markdown fallback. Each tag
  becomes its escaped label, or `happyReferencePlaceholder(reference)` when `resolve` returns
  nothing.
- `parseHappyReferenceTag(tag)` parses exactly one tag. `formatHappyReferenceTag(reference)` writes
  the canonical one. `isKnownHappyReferenceKind(kind)` tells which kinds to resolve.
- `escapeMarkdownText(text)` is the escaping the fallback uses for labels.

Show a resolved reference as a link whose text is the live title. Indicate a busy entity on the
link. Show unknown kinds and unresolvable references as inert placeholder text.

## Media layouts in text

Agent text may arrange media already shown in the conversation with plain HTML blocks such as
`<div style="display: grid; grid-template-columns: 1fr 1fr"><img src="a.png"><img src="b.png"></div>`,
as API.md specifies under "Media layouts in text". This package holds the one splitter and parser:

- `splitMediaLayoutBlocks(markdown)` splits text into `markdown` and `layout` segments that join
  back to the input. A block starts at a line beginning with `<div`, `<section`, `<figure`, `<p`,
  or `<img`, outside code, and runs until its root element closes, across blank lines. A block
  without an `<img` stays Markdown. A block that never closes is the last segment, with
  `complete: false`: hold it while the text streams, and show it as Markdown once it is final.
- `parseMediaLayoutHtml(html, resolve)` reads one block, or `present_files`' layout, into
  `MediaLayoutNode`s. `resolve(src)` returns an index into a list of items the caller builds, or
  `undefined`; the result reports the indexes `placed`, what was `ignored`, and whether content
  was `truncated` by a limit. Resolve each `src` to the most recent earlier media item for which
  `mediaSourceMatches(item.source, src)` holds, and show the tree with those items as a `tree`
  layout. Show the block as Markdown when nothing was placed or content was truncated.
- `stripMediaLayoutBlocks(markdown)` is the fallback for surfaces that cannot show blocks.

Never load a `src` yourself; show only the matched item's snapshot.

## File links

A file outside the reader's own workspace is linked as an ordinary Markdown link to a `happy-file`
URL, as API.md specifies under "File links":
`[Foo.tsx:42](happy-file://agents/<agentId>/packages/app/Foo.tsx#L42-L50)` or
`[README](happy-file://workspaces/<workspaceId>/README.md)`.

- `parseHappyFileLink(url)` returns a `HappyFileLink`, `{ target, path, lines? }`, or `undefined`
  for anything malformed. `target` is `{ type: "agent", agentId }` or
  `{ type: "workspace", workspaceId }`; `path` is decoded and relative to the workspace root;
  `lines` is inclusive, so `#L42` is `{ start: 42, end: 42 }`.
- `formatHappyFileLink(link)` writes the canonical URL and throws a `TypeError` for an invalid
  link. `happyFileLinkSchema` is the TypeBox schema, and `HAPPY_FILE_LINK_SCHEME` and
  `MAX_HAPPY_FILE_LINK_LENGTH` are the scheme and the longest URL.
- `renderHappyFileLinksAsText(markdown)` is the fallback for surfaces that cannot open file links:
  each inline link or image to a `happy-file` URL becomes its label. Links in code stay literal.
  The general form is `replaceHappyFileLinks(markdown, replace)`.

Resolve an agent link through `GET /v0/agents/:agentId` to its `workspaceId`, then read the file
from that workspace. Open it read-only inside the reader's own conversation, and show the usual
"could not open" treatment for a malformed or unresolvable link. Never hand a `happy-file` URL to
the operating system or a browser.
