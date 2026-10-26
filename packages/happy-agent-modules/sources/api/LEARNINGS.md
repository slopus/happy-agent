# API module learnings

## Opaque settings support cannot advertise a membership policy

An older daemon accepts arbitrary `surfaces.autoJoin` values but does not interpret them, so
generic user-settings support cannot make that preference functional. The daemon advertises
protocol 31 for default Surface membership; clients show the preference only at 31 or newer.
Health already carries an integer protocol, so no new wire field or client schema is needed.
Existing clients retain their additive compatibility from protocol 22 onward.

## GitHub credential selection was explicitly retired

The user approved removing `secret` from project clone requests as an exception to the additive
protocol policy. HTTP rejects the old selector with `400 invalid_request`; current client and tool
schemas omit it. GitHub repository sources remain supported and use the Git authentication on the
machine running the clone. This decision does not authorize publishing or pushing local changes.

## Activity children include their recorded token totals

Finished helper rows previously had no usage to show. Activity and the focused bootstrap now
include each child's own lifetime recorded input plus output as `totalTokens`, excluding cache
counters and descendants. No inference record means `null`; a recorded zero remains `0`.
This uses Usage's aggregate rather than provider-reported totals, transcript estimates, or the
tree usage shown for the parent. Other agent projections keep this enrichment off their path.

## Scheduled waits travel through the agent resource

The desktop sidebar could not show waits because agent snapshots and updates omitted Scheduling's
durable interval. The shared projection now carries `wait`, and a Scheduling transition records
its agent event in the same transaction before the API publishes the versioned update. Snapshots
read the version before the interval, so a concurrent finish cannot label an old interval with a
newer version. Idle catalog agents avoid the active-wait query. Desktop sends interrupt waits
after their submission commits, matching the promised message-interruption behavior.

## Project conflicts can happen after the header check

An upload can pass If-Match before image processing and lose its version before the store writes.
Project state conflicts carry the current snapshot through the existing lifecycle error; the API
awaits its normal project projection and returns HTTP 409 with the project and currentVersion.

## Message history reads a page in a fixed number of queries

The traced messages request showed width, not depth: one page of 41 short runs made 297 spans,
because History counted and read each run separately and the handler read usage once per run.
The handler now asks `UsageModule.readRuns` once for the whole page and projects every run in one
span; History batches its own reads. The existence check reads only the agent's configuration
and workspace instead of building a full agent resource. Keep the per-stage spans (agent,
history, usage, projection, serialization) and the response unchanged; a stage that runs once per
run is the regression to look for. Trace instrumentation does not enable export on a deployed
daemon or authorize its restart.

## Projection checks are compiled once

Profiles of concurrent desktop history loads showed the interpreted TypeBox check of each tool
call's arguments and presentation, nested arrays of objects included, costing more than reading
the messages. Message and tool projection now check through validators compiled once per fixed
schema; acceptance is unchanged and no projected value is retained.

## Shell names preserve command presentation

Claude uses PowerShell on native Windows. Its calls use the same existing command presentation
as Bash and exec_command, so live and loaded desktop history keep terminal rendering without
changing the public API schema. Preserve the actual PowerShell tool name in the resource.

## Bootstrap carries independently versioned subtask trees

Activity-only discovery required a separate read for every coordinator and hid delegated work on
initial load. Every full agent now includes its active direct subtasks recursively, including
empty leaves, in newest-first order with ID ties. Hidden children stay out; an archived child
prunes its branch without flattening or archiving descendants. Each nested record keeps its own
version and workspace, so clients reconcile duplicate tree/workspace records by ID and child
events rather than relying on ancestor version changes.

## Ordinary creation no longer accepts a managing parent

The unused managed-root creation option conflated catalog ownership with delegation. The agent
creation request now rejects `parentAgentId` before processing even an existing requested ID,
and creates only parentless roots. Subtasks are the explicit user-interactive delegation path;
response ancestry and existing stored agents remain unchanged.

## Subtask interaction does not require owner-series membership

Parent ancestry previously made every managed agent read-only, and archival assumed that every
user-controlled agent belonged to a project or workspace list. Subtasks are explicitly visible
and user-messageable while retaining their parent. Shared-filesystem subtasks are discovered
through parent activity and have no list membership to update on archive; workspace-bound
subtasks retain ordinary owner-series ordering. Capability flags, focused reads, and archival
events use the same distinction. Ordinary subagents and non-subtask managed roots remain read-only.

## Workspace services are an unavailable optional capability

Workspace services and their private credential/tunnel layer have been removed. Their published
routes authenticate and resolve the workspace before returning `501 unsupported`, which the API
already defines as feature unavailability. Existing client schemas, events, and the optional
workspace cleanup field remain compatible with older daemons. Browser previews use the agent's
own workspace proxy instead.

## Team drafts belong to users, not shared agent metadata

Shared agent metadata made teammates read and overwrite each other's composer drafts. Team
drafts now persist one current value and clear timestamp per authenticated user and agent.
Last-write-wins comparison and saving share a transaction, and the exact committed snapshot
becomes an owner-filtered event only after commit. Reads and bootstrap use the same owner;
journal pulls, replay, and live delivery keep private payloads off other users' connections.
Standalone drafts remain in agent metadata, and existing global drafts are never assigned to
team users. Ownership stays internal: endpoints, payloads, and the published client are unchanged.

## User settings pass through opaque and owner-filtered

Per-person preferences such as completion sounds and muted or hidden bots lived on one device.
The API now serves the user settings module's opaque per-key settings at `/v0/user-settings` and
in desktop bootstrap, owned by the caller and never by a route parameter. The key is taken from
the path exactly as sent, so a percent-encoded key is refused rather than decoded.
`user_settings.updated` is appended with its owner and never names it; the journal hides an
unowned one from every team member, as it does drafts and the Happy integration. The addition does
not raise the protocol version: clients detect it by the bootstrap field, and older daemons
answer `404`.

## Filter archived agents before building catalog resources

Desktop bootstrap used to build every attached agent's activity and resource, discard archived
agents afterward, then repeat the work for each project's same-ID root workspace. Collection
reads now check the agent's archival metadata first and pass the already-read configuration and
children into the resource projection. Bootstrap shares each project's built agent series with
its root workspace and reuses its project catalog for onboarding. Known owner-series and bot
resources do not query bot ownership again. All reuse stays within the current request; archival
decisions and activity are never cached across requests. Agent Base currently offers individual
configuration reads only, so reducing that remaining per-agent cost must use a future public
batch API, not reads into its private storage or a second archival index. Preserve archived
by-ID reads and the API's existing archived project/bot collection behavior.

## Bootstrap carries a bounded, newest-first archived agent collection

The desktop's chat history was empty after every launch: project and workspace resources
exclude archived agents, and no endpoint listed them, so a client could show only the chats it
had archived itself in the current run. Desktop bootstrap now also carries `archivedAgents`,
the 200 most recently archived agents of the included owners, newest `archivedAt` first with
the ID as the tie-breaker, each under its owner's `workspaceId`. The owner series build reads
each attached agent's configuration once and records the archived ones with that configuration,
so only agents inside the bound pay for detail reads. Keep the bound: an unbounded list would
grow with every chat ever closed and undo the cost described above. Project and workspace
resources still exclude archived agents; older archived agents stay readable by ID.

## Avatars and artwork share private browser caching

The blanket no-store response policy prevented browsers from retaining images despite their
content-derived ETags. Fixing only project avatars left node avatars, bot avatars, profile photos
(standalone and team), and slash-command artwork uncached. All five image endpoints now use one
header helper for successful reads and conditional 304 responses: one hour of private-cache
freshness followed by 24 hours of stale-while-revalidate. Vary on Authorization isolates cached
images between credentials. Apply this policy only after finding the image; JSON, missing images,
and authentication errors remain no-store. Cache headers enable request-driven revalidation, not
an hourly timer or replacement of an already displayed image.

## The current profile identifies the authenticated team member

The profile endpoint and desktop bootstrap share one profile projection. Its read-only `userId`
is the authenticated member's local Happy ID, matching message authorship and batch user lookup.
It stays the same in profile/photo mutation and conflict responses and after restart. Before team
onboarding and in standalone mode it is explicitly null; the standalone profile's private identity
is never exposed as a team user. Older daemons may omit the field, and team profile events remain
identity-only invalidations rather than broadcasting another member's profile.

## API additions stay concise and fields stay logically grouped

Bot creation's identity fields were scattered alphabetically and its contract was repeated in
long prose and comments. Put request metadata (`mutationId`) first, then related IDs together
(`id`, `workspaceId`, `agentId`), then entity fields. Describe changes in the surrounding endpoint's
concise style. Comments explain only what names do not.

## One onboarding response combines installation and user readiness

The installation completion marker previously made team members skip setup even when they had
no local profile and the API correctly denied product access. Installation onboarding stays
shared, while personal readiness is derived from the authenticated member's durable profile.
The existing onboarding response reports completion only when both are satisfied in team mode;
standalone completion remains unchanged. Desktop bootstrap uses the same calculation. Clients
never select an onboarding scope, maintain separate system and personal flows, or need another
completion call after saving a profile on an already-onboarded installation.

## Cloud is authentication and organizations only

Cloud previously exposed encryption setup, account enrollment, profiles, social state, and device
management. The API now exposes only WorkOS authentication and organizations. Retired routes return
not found; desktop bootstrap and the journal carry only the authentication snapshot, and Cloud
errors include only that snapshot. Keep the separate local profile and Happy integration surfaces
independent of Cloud account state.

Team nodes must not connect an installation-wide personal Cloud account. Both authorization
start and completion now throw the existing unsupported API error before parsing bodies or
calling Cloud, including when an attempt predates team mode. Keep this deployment restriction
at the API seam; standalone authorization and the existing Cloud status and disconnect routes
remain unchanged.

## Input requests and generated calls retain distinct identities

Send accepts the published tool-request block schema, with at most one request among the text
and image blocks. Pending responses, bootstrap, acceptance, and history retain that block exactly.
Acceptance is still carried by the run event, not an extra user-message update.

Release 0.4.45 expressed "at most one request" as one array with `contains`, `minContains: 0`,
and `maxContains: 1`. TypeBox's value check refuses any `contains` array with zero matches
before it reads `minContains`, so every plain text or image `content` array was rejected with a
400 and images stopped working. Only text-only sends, which omit `content`, survived. The send
content schema is now a union of two arrays: text and image blocks alone, or text, image, and
exactly one request. Any schema test for an "at most one" rule must cover the zero case.

A requested call has no inference-start event. Publish its completed acceptance-time assistant
row on tool start and its updated row on completion, using History's call-owned message identity.
Never project it under a synthetic run-level assistant ID: that makes live clients disagree with
reload and leaves the real call without a creation event.

## Protocol revisions identify new capabilities without removing older requests

Unnamed bot creation was added without a distinct advertised revision, leaving clients
unable to know whether omitting a name was supported. The daemon now advertises protocol
24 for that capability. Older name-bearing requests remain valid; clients that omit the
name require protocol 24 or newer. Protocol 22 onward remains additive, so a client must
not reject an otherwise compatible daemon merely because its revision differs. A product
that requires a newer capability may require that capability's protocol and explain the
needed upgrade. The daemon's product version remains display and diagnostic information.

## Local signals and HTTP share one drain boundary

Draining only the agent runtime leaves API mutations admitted and can falsely report that an
installation is safe to maintain. Local OS control now calls the API module's public `beginDrain`
and reads its bounded `drainProgress`, the same operations used by authenticated HTTP. This keeps
the read-only transition, event identity, admitted-mutation count, and agent/reviewer completion
barrier identical without creating an unauthenticated HTTP route. Draining remains separate from
shutdown and does not claim that terminals or background processes have exited.

## Credential diagnostic disclosure

- Credential diagnostics are projected for each authenticated reader. History and the bounded
  event journal retain one caller-neutral record. History reads, event pulls, SSE replay, pending
  flush, and live delivery each project it without mutating the original or retaining recipient
  copies. Team owners may see the source and local recovery commands; members and unresolved
  owners receive the same code, mode, and actions with generic instructions, no commands, and a
  null source. In standalone mode possession of the API bearer is the installation authority;
  there is no separate human credential class. Any future API credential class must be classified
  before it can read messages. Runner and exported-bot credentials remain outside the
  ordinary API admission boundary.

- Invalid diagnostic shapes must not take the unredacted fast path. An unauthorized reader loses
  an out-of-schema error object entirely; an unexpected message-event payload recursively loses
  sensitive diagnostic keys. Valid ordinary content stays unchanged, and authorized delivery
  retains the original immutable record. No recipient-specific variants accumulate in the journal.

- A live failure uses the error row's durable History identity and projection. Synthesizing a
  second ID at settlement made a keyed client show two errors after reload or replay. Settlement
  looks up the existing failure only within its visible run; it never exposes orphan raw records.

- Configuration reservations are captured synchronously when a provider block enters the event
  queue. Looking up its account later during conversion could read the next routed attempt.
  Journal the reserved record immediately before that block, and suppress its durable append
  only after creation was actually announced. Every eligible History creation uses the same
  per-agent queue, so committed service rows cannot overtake delayed stream conversion. Snapshot
  failures log identifiers only and prevent completion-time backfill instead of guessing a mode.

## Composer mode

- Switching a failed turn used to change only its hidden continuation. `lastMode` still named the
  failed route, so the next composer send silently selected it again and later child reports
  continued failing there. The switch now records its complete mode on the hidden notice and
  commits `lastMode` with failure resolution and message admission. It preserves permission mode
  and supported effort and service tier, clears an unsupported tier, and rolls everything back
  if admission fails. The existing mode endpoint and focused bootstrap return the new selection.

- Execution provenance is output-only. Send, slash-command, and draft inputs validate known
  `account` and `providerType` fields using the published bounds, then immediately project them
  away before routing, pending messages, history, last mode, or either draft store. SDK stripping
  alone left other clients able to persist forged provenance and made skill-message modes
  disappear. Send retains its existing unknown-field rejection; slash and draft modes retain
  their existing acceptance of extra keys but discard them rather than persisting them. Their
  API shapes are not closed, so tightening that acceptance would change the contract. Opaque
  user settings are unrelated and remain untouched.

- A null `mode.serviceTier` must reach Agent Base as an explicit `null`, never as an omission and
  never as a sentinel tier string. Agent Base persists the last tier and reads an omitted message
  option as "keep the previous tier", so omission leaves a stale tier in force — including the
  retired `"default"` sentinel written by earlier releases, which Codex rejects on every turn and
  which nothing else ever clears. The same rule applies to every sibling send path that stamps a
  mode on a message: the tier the mode claims is the tier the message must carry.

## System bot identity

- Every public bot projection includes the database-backed `systemKey`: a stable snake_case key for
  a built-in bot and `null` for an ordinary bot. The one shared projection feeds reads, mutations,
  conflicts, bootstrap, and events, so this discriminator must stay there rather than being added
  route by route. Client schemas keep the field optional only for older compatible daemons and
  tolerate unknown keys so newer built-ins retain ordinary bot behavior in older UIs.

## Every workspace proxy connection opens through an explicit network

The proxy used to treat a missing route as "this machine": an attachment admitted without one, an
expired or replayed key, or a Bun tunnel connected natively all quietly reached the daemon's own
network. Admission now always mints a route, a one-time key naming the network every connection
on the attachment opens from, and a request or tunnel without a valid route is answered `502`.
The folder proxy uses the host network or the folder's runner. A workspace whose agents each work
in a container (Docker workspace, or a bot whose compute is Docker) has no single network, so the
folder proxy answers `501` instead of picking one. `CONNECT
/v0/workspaces/:workspaceId/agents/:agentId/proxy` checks that the agent belongs to the workspace
and opens through `ComputeModule.network`, the agent's exact cached machine; never guess an agent.

The proxy is a plain forwarder. Only opening a connection is bounded (30 seconds, `504`); the
listeners disable Node's request timeout and nothing caps a body, so server-sent events and slow
uploads stream for as long as both sides keep them open. Disabling the request timeout also set
Node's header timeout to zero, which let a client that never finished its headers hold a socket
open forever, so both listeners set an explicit 60-second header bound, answered `408`. Node
enforces it only on a server that listens, so the private Unix socket and the TCP hop are bounded.
Attachments the Node front door hands over directly are not, because that front door has already
authenticated them. Bun's HTTP server also drops a stalled header on its own after about 12 seconds.
Abandoning a request destroys its upstream. Hop-by-hop headers, `Proxy-Authorization`, and the route header are dropped; the
client's own `Authorization` and `Cookie` pass through and nothing is added. Tunnels forward
end of stream as a half-close and a reset or early close as a close. IPv6 literals reach the
connector without brackets.

## Agent networks let a browser keep state per network

Browser state kept per agent or workspace either leaked cookies between containers or split one
machine's sessions. `GET /v0/workspaces/:workspaceId/agents/:agentId/proxy` answers the agent's
`networkId` from `ComputeModule.networkId`, refused exactly as that agent's `CONNECT` is, and
`CONNECT /v0/networks/:networkId/proxy` routes through `ComputeModule.namedNetwork`. A malformed,
unknown, or no-longer-served ID is `404`; the daemon never opens such a tunnel in another network.
Both proxy routes share `prepareWorkspaceProxySocket`, so the Node and Bun front doors admit them
the same way. Protocol 28 marks the routes.

Live artifacts use their own `CONNECT /v0/artifacts/:artifactId/proxy` admission. Artifacts owns
the single destination policy and returns an artifact-scoped connector; the forwarding proxy
only carries the requested hostname spelling and renders its refusal as 403. Both HTTP and
nested CONNECT use that connector. Existing network and workspace connectors are unchanged.
The artifact is reread for every connection, so changing its URL or deleting it affects the next
connection on an already-open outer tunnel without interrupting established destination streams.
The independently owned proxy context explicitly carries the database namespace: detaching the
admission request alone drops it and makes subsequent artifact reads fail.

The route first matched only well-formed IDs, so `/v0/artifacts/Not-An-Id/proxy` fell through
admission and the Node front door destroyed the socket instead of answering. Like the network
proxy, it now matches any single segment, authenticates, and only then answers a malformed ID
`404`, so a stranger still gets `401` and learns nothing from the ID's shape.

## Artifact files are matched on the resolved path

The file route once read the raw request target so that `files/css/../index.html` answered `404`.
Production never sees that target: under Bun, `Bun.serve` resolves `.`, `..`, and `%2e%2e`
segments before any handler runs, so the rule held only in Node gyms. The contract now tells
clients and artifacts to request exact manifest paths, and resolves any dot segments before
routing; the route reads the parsed pathname on both runtimes, and the resolved path must still be
exactly a manifest path. Each segment is decoded separately, so an encoded `/` or an empty segment
is still `404`. Sandbox, caching, and range headers are written only with a served file, so
`404`, `416`, and every other error keep the ordinary `no-store` JSON response.

## Tool-call media is served by call and position, never from history bytes

Generated images and presented files reach the desktop through a `media` presentation and
`GET /v0/agents/:agentId/tool-calls/:toolCallId/media/:index`. History stores each item's digest
for the private snapshot; the projection removes that digest, and the route asks Chat Media for
the snapshot of the recorded item. Because one call's item never changes, responses are cached
as immutable rather than with the shorter image policy. Range, ETag, `nosniff`, and the sandboxing
CSP come from the same stored-file sender as artifact files. `media` and `artifact` blocks keep
their raw data under `omitToolData`, as `agent_spawn` does, so released desktops that render
these calls from raw data do not regress to an empty block.

## A drain logs what holds it open

A slow reload could not be explained afterwards because only lingering HTTP mutations were ever
logged. The drain now logs `daemon:drain:start`, then `daemon:drain:waiting` at once and whenever
its blockers change, or every five seconds otherwise, and finally `daemon:drain:finish` with its
duration. Blockers are grouped by running tool name, or by agent stage when no tool runs, with the
age of the oldest of each. A drain source may supply `work`, which the runtime takes from
Observation's active tools and inferences. Lines carry names, counts, and ages only, never
arguments, commands, prompts, or output. The report runs in its own `daemon-drain` context
because it outlives the request or signal that started the drain.

## Large JSON responses are compressed for clients that accept it

macOS gives a local stream socket an 8 KiB send buffer, so a response leaves the daemon a few
kilobytes per event-loop turn. Idle, that is invisible; while other agents stream, the loop turns
every 15–30 ms and a 600 KB history page took 1.3 s to flush after it was ready. JSON bodies of 64
KiB or more are therefore sent Brotli-compressed at quality 1 (or gzip at level 1) when the
request's `Accept-Encoding` allows it: about a sixth of the bytes for roughly a millisecond per half
megabyte. A client that does not ask, such as the SDK's socket fetch, gets the body exactly as
before. Desktop's proxy forwards Chromium's `Accept-Encoding` and pipes the response through
unchanged, so the renderer decodes it natively.

## A compaction measurement is not a status change

A manual compaction set the agent idle on every compaction event that was not running, including
the late `tokensAfter` measurement recorded during the next run. That run then flickered idle
between working updates. A manual compaction now moves the agent status only when it is created
or its own status changes; the measurement updates the message alone.

## A reply does not fail a committed mutation

The focused agent reply loads the agent's slash commands after the route's mutation has
committed. A catalog that could not load turned a successful reorder, rename or creation into a
`500`, though the change had landed. The reply now carries an empty catalog when it cannot load
one and logs why; the catalog's own update event brings it once it does.

## Each agent's run owns its mutation echo

A manual compaction wakes the agent loop inside its own mutation scope, and the loop keeps that
async scope for its whole life, as does every helper agent the loop starts. A message queued
during the compaction therefore ran its turn, its context updates, the helper it spawned, and that
helper's own events all echoing the compaction's `mutationId`. Inferring an owner from the scope
kept leaking: per-scope agent maps, a daemon-wide root scope, and a "first agent in the scope"
fallback each retagged some other run's events.

Ownership is now explicit. Every request runs in a scope of its own, and the moment that scope's
chain accepts a message into an agent loop it is marked as running a loop and echoes nothing on
its own again. An agent event then echoes only through the agent its producer names: the agent's
current run records the mutation that started it, written in `messageAcceptedTransact` when a
message starts the agent's next run as Events decides the boundary, and deleted when that run
settles. The owner is the `mutationId` the message carries, else none. A message joining the run
already going changes nothing, and a steer that opens a successor run counts as a new run.
Questions name their asking agent. An event that names no agent gets no inherited echo.
Accepted-message batches announce later, so each message keeps the owner it had when it was
accepted.

A message from another agent once took its owner from the sender's run at the moment the
recipient accepted it. A message that waited in a busy recipient's inbox was then labelled with
the sender's later run, or with nothing once the sender had settled; a helper's report, sent as
the helper settles, always lost it. Every module that sends a message on an agent's behalf now
stamps the sending run's mutation on it when it is sent, read from History's `runMutationId` and
written with `impl/mutationEcho.ts`: collaboration messages and reports, messages to bots and
tasks, goal continuations, and scheduled messages, which keep it with the schedule until due. A
helper keeps its parent's retry and its report keeps it too. A created agent's `agent.created`
echoes the mutation recorded in its metadata at creation. Acceptance never consults the sender's
live run.

The run owners live in memory, so a run left in flight by a stopped process resumed with none and
every event after the restart echoed nothing. When Agent Base restores an agent whose run is still
active, the API now reads that run's mutation back from History.

The owners were also capped at 10,000 and evicted oldest first, so enough other runs could drop
the owner of a run still going. `RunMutationOwners` now keeps an owner exactly as long as its run,
with no cap, and keeps only runs that answer a mutation; the bound is the number of runs in
progress.

Two creation paths still announce agents with no echo, found in the last review and not yet
fixed. A subtask created from a tagged run gets no owner at all: Subtasks creates the agent
without a `mutationId` before Collaboration delivers its opening task, and Collaboration's retry
branch keeps that absence, so the subtask's `agent.created`, its run and its report echo nothing.
A task or bot an agent creates with `create_task` or `create_bot` announces `agent.created` with
no echo, although a task's opening run echoes correctly. Both need the creating run's mutation
written into the new agent's metadata at creation, through `impl/mutationEcho.ts`.

## A failure retry's run echoes the retry's mutation

Retry and switch accepted `mutationId` but started their run with a hidden notice that carried
none, and History kept a message's `mutationId` only on person-attributed messages, so their runs
echoed nothing. The notice now records the request's `mutationId`, and History keeps it on any
accepted message.

## Restoring an agent with no journaled history is not an error

On a long-lived install the journal trims an idle agent's events, and the first `agent.restored`
after a restart then has no earlier version, so answering it with `agent.updated` threw "An agent
update has no prior resource version" and logged an error for every such agent. The restoration
changes nothing a client reads and there is no version a client could hold, so the API now skips
that update; a client reads the agent's current version when it next fetches it.

## Hidden collaborators archive without an owner series

`archive_agent` failed for every hidden collaborator with "The agent owner was not found.": writing
`archivedAt` refreshes owner visibility, and a collaborator has no bot, task, chat, workspace, or
project holding it, so the refresh threw and rolled the archival back. Any agent with a parent
and no project now skips the refresh, as shared-filesystem subtasks already did; parentless roots
without an owner still fail. Collaboration's unit tests replace the agent collection, so the
regression test runs archival through the real runtime.
