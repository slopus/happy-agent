# Rig connect

`rig-connect` gives a user interface the live state of Rig from one subscription. It connects to a
Rig endpoint, follows a stream, keeps the state in memory, and hands it to the caller as ordered
values plus a stream of deltas.

`connectRig` creates one shared connection. Its session subscription answers what is happening
inside one conversation and its group subscription answers what projects, worktrees, and sessions
exist. The subscriptions are independent, share transport and mutation delivery, and release their
state when the last interested view closes.

It is the only place in the product where sync is reasoned about. A UI embeds it and renders; it
never asks the daemon a follow-up question to understand what it was just told. The single
exception is paging back beyond the opening transcript window, described under The protocol.

The transport uses plain Web APIs — `fetch`, streams, `AbortController`, and standard timers — so
the same build runs in Node, in a browser, and in any runtime that provides them. Runtime boundary
validation uses TypeBox. The package has no runtime dependency on `rig`, and a browser bundle
carries no daemon code.

## Resolving onboarding

Desktop applications use one resolver for the ordered preconnection and daemon-owned onboarding
states:

```ts
import { resolveRigOnboarding } from "@slopus/rig-connect";

const onboarding = await resolveRigOnboarding({
    endpoint,
    token,
    inspectLocalRig: (signal) => nativeBridge.inspectRig(signal),
});
```

The native bridge returns `{ status: "not_installed" }` when the Rig executable is absent,
`{ status: "not_running" }` when its daemon is known to be stopped, or the validated output of
`rig inspect --json` unchanged. `rig-connect` then applies the ordering itself: local availability,
CLI compatibility and data readiness, authenticated daemon discovery, daemon compatibility, and
finally `GET /onboarding`.

The resulting `RigOnboardingState` is one closed TypeBox-validated union:

- `rig_not_installed`, `rig_not_running`, or `rig_unreachable`;
- `version_mismatch`, with `upgrade: "rig" | "happy"` and either the incompatible protocol range
  or the CLI/data-schema facts and message that require a Rig upgrade;
- the daemon-owned `complete`, `provider_setup`, `profile_required`, or `murmur_setup` status.

This keeps process discovery in the native layer without making each Happy surface reproduce the
onboarding decision tree. The exported `localRigOnboardingInspectionSchema` validates native bridge
results, and `rigOnboardingStateSchema` validates the complete result.

After connecting, `getOnboardingStatus` materializes the current status from `GET /onboarding`.
Callers query it after completing a step; onboarding has no live subscription or change event. Rig
checks only whether at least one provider is configured and does not run inference.

When the status is `murmur_setup`, the application records the person's explicit choice:

```ts
const result = await rig.onboardMurmur(
    enabled ? { enabled: true, profileId: selectedProfile.id } : { enabled: false },
);
```

Opting out completes onboarding without generating Murmur keys. Opting in lazily creates or
restores the private identity and returns its public key plus the exact existing Rig profile.

## Discovering a running Rig

Onboarding can discover an authenticated daemon once without opening the live event stream or
allocating stores:

```ts
import { discoverRigInstallation, rigInstallationCompatibility } from "@slopus/rig-connect";

const installation = await discoverRigInstallation({ endpoint, token });
const compatibility = rigInstallationCompatibility(installation);
```

`discoverRigInstallation` accepts only the daemon wire contract:

- `{ formatVersion: 1, source: "daemon", daemonVersion, daemonProtocolVersion }`
- initialized data with a stable `epoch`, `schemaVersion`, and
  `schemaCompatibility: "current"`.

The library validates protocol compatibility using `daemonProtocolVersion`. Discovery is bounded to
five seconds and 16 KiB. A 404 means the server predates discovery and throws the exported
`RigInstallationDiscoveryUnsupportedError`, whose compatibility is `server_outdated`; response
bodies are cancelled before any non-success response is reported.

Local launchers parse `rig inspect --json` with the separate
`rigCliInstallationInspectionSchema` / `RigCliInstallationInspection` contract. Unlike daemon
discovery, inspection may report `absent`, `uninitialized`, `initialized` (including
`schemaCompatibility: "upgrade_required"`), epoch-less `upgrade_required` with reason
`pre_identity`, `incompatible`, or `unavailable` without starting or contacting the daemon.
The daemon contract is separately exported as
`rigDaemonInstallationDiscoverySchema` / `RigDaemonInstallationDiscovery`.
The command exits with status 0 for a completed safe inspection and status 2 when the result is
`incompatible` or `unavailable`; JSON is still emitted in either case.

Local plugin interfaces read the complete plugin and application catalog through one live
subscription:

```ts
const plugins = rig.connectPlugins({
    onChange(apps, installed, state) {
        renderPluginCatalog(installed, apps, state);
    },
});
```

Apps are in deterministic navigation order: order, label, plugin identity, then app identity.
Unchanged objects preserve reference identity. The stable `id` is
`<plugin-folder>:<app-id>`; `generation` changes whenever the owning process restarts or is
replaced.

Each `LocalPlugin` carries the manifest's bounded `author` label, one canonical `category`, and a
transport-safe icon handle:

```ts
type PluginCategory =
    | "automation"
    | "collaboration"
    | "data"
    | "developer-tools"
    | "media"
    | "productivity"
    | "utilities"
    | "other";

type LocalPlugin = {
    // Existing catalog and lifecycle fields omitted.
    author: string;
    category: PluginCategory;
    icon: { generation: string; mediaType: "image/png"; size: number };
};

const plugin = plugins.plugins()[0]!;
const icon = await plugins.readIcon(plugin);
// icon: { bytes: Uint8Array; mediaType: "image/png" }
```

`readIcon` sends the daemon bearer token itself, checks the response against the declared type and
size, and is cancelled by either its optional `AbortSignal` or `plugins.close()`.
`PluginIconRequestError` exposes `icon_unavailable`, `plugin_not_found`, or `stale_generation`.
The handle contains no filesystem path, URL credential, or arbitrary-read capability.

```ts
const app = plugins.apps()[0]!;
const page = await plugins.readResource(app, app.resourceUri);
const result = await plugins.callTool(app, "Usage", "refresh", {});
await plugins.storageSet(app, "layout", { compact: true });
```

Only declared resources and app-visible MCP tools can be called. Every call includes the rendered generation,
so stale views reject after replacement or uninstall. Resources are checked against declared media
type and byte size and bounded to 256 KiB. Tool inputs and responses are bounded to 1 MiB, and
successful envelopes are runtime-validated. An optional `AbortSignal` cancels either operation;
`plugins.close()` aborts operations owned by that handle and prevents new ones.

The stream opens before `GET /plugins`. Snapshots and full-catalog events carry an ordered catalog
version, so either side of their race can be newer without moving the view backward. A clean
cursor resume reuses the catalog; a gap reloads it. `state.connection` is `connecting`, `live`,
`reconnecting`, or `closed`, and discovery failures remain in `state.failures`.

`listPlugins()` remains available for one-shot diagnostics. `readPluginLog()` returns the newest
bounded 16 KiB snapshot, its source, and whether older output was omitted. Installed plugin
`status` is `running`, `stopped`, or `failed`.

Plugin management uses the same authenticated connection:

```ts
const catalog = await rig.discoverPluginCatalog({
    repository: "owner/repository",
    // ref: "v1.2.0", // Optional; omission means the repository's default branch.
});
const offered = catalog.plugins[0];
if (offered === undefined) throw new Error("The repository offers no plugins.");

// availability is not-installed, update-available, reinstall-available, or downgrade-available.
// When installed is present it names the exact installed folder, name, and Semantic Version that
// Rig compared against the offered version.
console.log(offered.availability, offered.installed);

const installed = await rig.installPlugin(offered.source);
await rig.uninstallPlugin(installed.name);

// Daemon-local folders remain useful for development.
await rig.installPlugin("/Users/steve/Developer/plugins/packages/hello-world");
```

`discoverPluginCatalog` accepts only a GitHub `owner/repo` plus an optional branch, tag, or commit.
Rig resolves that selection to a 40-character commit, validates the complete bounded
`happy-plugins.json`, and returns a closed catalog of actual entries. Each entry's `source` is the
only remote-install input: it binds the repository, requested ref, resolved commit, catalog digest,
and exact indexed package metadata. A client never sends an arbitrary URL or accesses a daemon
filesystem path.

Before download, Rig fetches the catalog again at the resolved commit and rejects a descriptor that
does not match. It downloads the archive for that commit, extracts only the indexed subdirectory,
and checks that the plugin manifest declares the indexed Semantic Version before replacing
anything. The install response and the next `plugins_changed` catalog event carry the authoritative
`fresh-install`, `upgrade`, `reinstall`, or `downgrade` result.

Installs carry a caller-stable request identity. `rig-connect` creates one automatically and
reuses it for up to three transport attempts; callers that must resume an operation in another
connection may pass `{ requestId }`. Rig retains a bounded replay registry, joins concurrent
duplicates, returns a completed result without applying it again, and rejects the same identity
with a different source. A failed or aborted attempt releases the identity for a clean retry.
`{ signal }` cancels the caller's operation, and closing `RigConnection` cancels every operation it
owns.

The local install path is an absolute ready-to-run plugin folder on the machine running the Rig
daemon. It is not a browser upload and is not resolved on the client machine. Rig stages and
validates the folder before replacing an existing installation. Uninstall stops the plugin, removes
its managed code, and keeps its writable data folder.

Discovery rejects with `PluginCatalogRequestError`; install and uninstall reject with
`PluginManagementRequestError`. Both expose stable `code`, `status`, and human-readable `message`
fields, including `request_failed` for exhausted transport retries and `invalid_response` when the
daemon's success envelope fails validation. Successful envelopes are runtime-validated before they
reach the caller.

MCP App mounting is a host concern. To make clicking instant, prefetch every declared resource
by generation as soon as it enters the catalog, then expose navigation only when that bounded
bundle is ready. The Happy2 Electron bridge contract is in the repository `INTEGRATIONS.md`.

## Creating a connection

```ts
import { connectRig } from "@slopus/rig-connect";

const rig = connectRig({
    endpoint: "http://127.0.0.1:4517",
    token: process.env.RIG_TOKEN!,
});
const connection = rig.connectSession({
    sessionId: "01960f2c-...",
    onChange(elements, session) {
        render(elements, session);
    },
});

// Later, when the view goes away.
connection.close();
rig.close();
```

An endpoint and a token are the only inputs. Obtaining the token is somebody else's job:
`rig-connect` never logs in, never reads credentials from disk, and never touches the environment.

The endpoint is any HTTP address serving Rig's protocol; the port above is only an example.
Platform clients may supply a Fetch-compatible transport. Rig's local Node client uses this seam to
reach the daemon's Unix socket without adding Node built-ins to this package.

`onChange` fires whenever any element changes, with the current list and the current session state.
`close` releases everything the connection holds and stops all reporting.

`onDelta` is optional and receives ordered notifications for callers that would rather react than
re-render. It always fires after `onChange` for the same update, so a consumer handling a delta
already sees state that reflects it. `onError` reports a failure that ended the connection for
good; ordinary disconnections are not failures and are handled by reconnecting. Group
subscriptions also receive recoverable protocol diagnostics there while their connection state
stays live.

## Sharing contacts

Sharing uses Murmur for a private, durable person-to-person identity and contact handshake. It
reuses a local Rig human profile—the same profile used for P2P and message attribution—instead of
maintaining a second Sharing profile. The first binding is permanent for that Murmur identity.
The Murmur handshake carries the profile's bounded text metadata but excludes its photo bytes;
photos continue through Rig's existing profile path.

```ts
const sharing = rig.connectSharing({
    onChange(snapshot) {
        renderContacts(snapshot);
    },
});

const profiles = await rig.listProfiles();
const murmur = await rig.onboardMurmur({
    enabled: true,
    profileId: profiles[0]!.id,
});
console.log(murmur.publicKey, murmur.profile);

const { invitation, expiresAt } = await rig.createSharingInvitation();
const outgoing = await rig.requestSharingContact(invitationFromAnotherPerson);

await rig.acceptSharingContactRequest(incomingRequestId);
await rig.rejectSharingContactRequest(otherIncomingRequestId);
await rig.removeSharingContact(contactIdentity);
```

The authoritative snapshot contains the Murmur identity, selected profile ID, connection state,
confirmed contacts, folder-share synchronization status, and incoming and outgoing requests.
After contacts are confirmed, `shareFolder(folderId, contactIdentities)` creates one typed Murmur
group whose encrypted invitation descriptor carries the folder's current virtual subtree. Later
folder additions, removals, moves, ordering, and metadata changes synchronize through that group.
Contact and request profiles may be `null`
when a remote application sent data outside Rig's profile contract; such a request cannot be
accepted. A remote profile is display metadata asserted by that authenticated Murmur identity; its
profile ID and parent Rig ID are not authorization credentials. Invitations are opaque, one-use,
five-minute capabilities and should be transported as secrets. Sharing handshake methods await
their external result and callers should refresh the snapshot after an ambiguous transport
failure. `connectSharing` follows `sharing_changed` on the same global stream as chats and
refetches the bounded snapshot after reconnect gaps.

## The chat state

The chat state is a flat, time-ordered list of elements. There is one element per message, per
block, and per tool call — a tool call is its own element rather than something nested inside the
message that produced it, so a consumer renders the list in order and never walks a tree.

| Kind            | What it is                                                                    |
| --------------- | ----------------------------------------------------------------------------- |
| `user_message`  | Something the user sent, with any attachments.                                |
| `system_notice` | A non-internal notice Rig intends the person to read.                         |
| `agent_text`    | A block of the model's reply. `complete` is false while it is still arriving. |
| `thinking`      | Model reasoning, when the provider exposes it.                                |
| `tool_call`     | One tool invocation, from streamed arguments through to its result.           |
| `compaction`    | A conversation compaction, reflecting its current state.                      |
| `failure`       | An attempt that failed. `outcome` says whether the run retried or gave up.    |
| `inference`     | An inference that has started but produced nothing yet.                       |
| `group_end`     | The final element of an inference group.                                      |

Every `system_notice` has complete human-readable `text`. Notices Rig understands structurally
also carry optional `structured` detail so an application can customize the row while an older or
simpler client keeps rendering the text. Compute preparation uses
`structured.kind: "compute_preparation"` with its instance, provider, phase, state, message, and
optional current-phase percent, elapsed time, `startedAt`, `lastProgressAt`, and classified error
with canonical retryability. Elapsed time freezes when preparation completes, while percent is
omitted from later phases unless explicitly reported. `unavailable` remains distinct from failed,
stopped, and ready. Each phase is a separate append-only element, and replaying the same session
event after reconnect does not duplicate it. When a newer Rig sends a structured notice kind this
version does not know,
`rig-connect` discards only that structured payload, bounds its text fallback to the protocol
limit, and retains the resulting validated notice.
Service notices are ordered alongside the transcript but do not open or close inference groups,
produce turn footers, or consume the conversation's bootstrap-turn allowance.

Every element carries a `groupId` and the `runId` it belongs to. A group is one stretch of work the
person is waiting on: the question they asked, everything the agent produced answering it — text,
thinking, and every tool call across as many turns of the tool loop as it took — and one `group_end`
footer saying when it finished and how. Reaching the model again to work through a tool result is
not a boundary; the group closes only when the work stops, for one of five reasons: `completed`,
`steering`, `compaction`, `abort`, or `error`. Steering therefore splits a run into consecutive
groups while the `runId` stays the same, and the steering message itself lands between the previous
footer and the next group's first element. Compaction is the same kind of boundary and lands in the
same place.

A `group_end` carries two durations: `elapsedMs`, the group's own stretch since the last boundary,
and `turnElapsedMs`, measured from where the turn really began. They differ once a run has been
steered or compacted, and a consumer picks whichever suits where it is drawing. Failures inside a
group appear as `failure` elements in it: every retried attempt, and, when the group ends in an
error rather than a steering, compaction, or abort, one last `failure` carrying the message.

Group identity is stable for the life of the connection, including across a reconnect, so a
consumer can key rendering on `groupId` without waiting for anything to settle. That a group always
closes is a guarantee the library makes rather than something a consumer infers from silence: a
group interrupted with a tool still running still gets its final element, and the open tool call is
closed as `interrupted`.

Elements change by delta, not by replacement. Text grows as it is generated, tool-call arguments
fill in as they stream, and a result lands on the tool-call element that was already there.

A user message applied as steering carries `steeredAt` and `steeringElapsedMs`. The interval starts
at the turn's `startedAt` for the first steering message and at the preceding `steeredAt` for each
later one. A message still waiting at the transcript tail has `delivery: "pending_steering"` and
does not gain steering timing until Rig reports that it was applied.

## Rendering from it

The list is built for React. When it changes, every element that did not change comes back as the
same object, and a new reference appears only where something actually did. A consumer can render
from the list directly and rely on referential equality to skip the rest of the conversation.

Tool calls issued together share a `groupId`, so a burst of calls can be drawn as one coherent unit
instead of a column of unrelated rows.

### Tool presentation

A tool call carries a `presentation`: what the call is doing and what it produced, as an ordinary
application value. A consumer narrows on `kind` and never decodes Rig's wire format.

| Kind             | What it is                                                              |
| ---------------- | ----------------------------------------------------------------------- |
| `command`        | A command Rig ran. Gains `output` when it finishes.                     |
| `exploration`    | Files and searches the tool looked at, as `list`/`read`/`search` steps. |
| `file_edit`      | A diff of the files the tool changed.                                   |
| `terminal_input` | Input sent to a terminal that was already running.                      |

The projection is where the wire format stops. Rig describes a running command and a finished one
as two unrelated shapes; both become one `command` that gains its output, so a UI does not swap one
shape for another halfway through. Where a call and its result disagree, the result wins, being the
later and fuller account.

Exploration steps keep the daemon's own terms — `list`, `read`, `search`, with the target, name,
query, path, and command each reports. Wording is left to the interface, because a sidebar, a
transcript row, and a screen reader describe the same search differently, and none of them can
recover the query once it has been folded into a phrase.

A `kind` this library does not know projects to `undefined` rather than leaking a half-understood
shape, and the call's plain `result` text remains the fallback. That is what lets a newer daemon
talk to an older client. `ToolCallPresentation` and `ToolResultPresentation` remain exported for a
consumer that wants the raw wire values, and `projectToolPresentation` is exported for one driving
the state itself.

## The session state

Separate from the list is one small value answering what the session is doing right now.

```ts
const { activity, git, modelId, tokens, title } = connection.session();
```

`activity.kind` is one of `idle`, `queued`, `thinking`, `generating_message`,
`generating_tool_call`, `reviewing_tool_call`, `executing_tool_call`, `awaiting_input`,
`compacting`, `retrying`, `stopped`, or `error`, and `activity.label` is ready to display. A status
line renders from this without walking the list.

While the session is executing tools, `activity.toolCalls` is the list of calls it is still waiting
on, each with its tool name, start time, and latest progress status. `describeSessionActivity`
turns that into the sentence a status line shows, phrased by what the running tools have in common
rather than by their provider-specific names.

```ts
const { label, toolCategory, awaitingTools } = describeSessionActivity(
    connection.session().activity,
);
// Bash, exec_command, run_terminal_command -> "Waiting for bash"
// Agent, spawn_workspace_agent             -> "Waiting for subagents"
// a mixture                                -> "Running 2 tools"
```

While Auto is deciding whether a tool may run, `activity.reviewingToolCalls` identifies those
calls and `describeSessionActivity(...).reviewingTools` exposes the same application-ready list.
Each tool-call element carries `permissionReview.status: "reviewing"` during that work, then
updates in place to `"completed"` with the decision, risk, reason, and user-authorization level.

`classifyToolName` is the same classification on its own, for a UI that wants an icon per category.
A tool this library has not seen classifies as `unknown` and is named literally rather than
described as something it is not. A retry, a compaction, a question, or a scheduled wait outranks
the tools running underneath it in `label`, while `awaitingTools` still lists those calls.

The session state also carries the live facts a complete conversation surface renders: project,
worktree, environment and agent identity; model locking, effort and service tier; permission mode;
composer draft and recap; title generation and structured interruption state; pending steering and
input requests; tasks, goal, subagents, MCP servers and workflows; secret attachments; background
processes and ordered shell commands; permission reviews,
context size, usage, quota, and Git changes. Each is initialized by the opening frame and tracked
continuously rather than fetched on demand. `connection` is `connecting`, `live`, `reconnecting`,
or `closed`, so a transport interruption is visible rather than a silent stall.

## Actions

Actions live on the shared `RigConnection`. They update subscribed state synchronously and return
their ordered mutation ID; delivery, retry, per-entity ordering, reconnect survival, conflict
reconciliation, and rejection rollback happen in the background.

```ts
const mutationId = rig.setDraft(sessionId, "Unsent message");
rig.setPermissionMode(sessionId, "full_access");
rig.setGoal(sessionId, "Ship the release");
rig.sendMessage(sessionId, "Continue.");
```

The same contract covers create and fork, model/effort/service-tier changes, appended prompts,
structured answers, goals, secrets, shell and background-process controls, external-call
resolution, workflow stop, archive, reset, rewind, compaction, and run stop. Terminal clients can
also maintain focus/presence through the shared transport. `onMutationRejected` receives failures
even when no view is currently subscribed to the affected entity. Loading earlier transcript turns
and process output remain the only operations with a loading state.

Project registration is entity-first because the daemon must validate the host folder before there
is anything safe to predict:

```ts
const project = await rig.projects.add("/Users/steve/Developer/my-project");
```

Rig Connect assigns one project ID and reuses it across transport retries, so a response lost after
the daemon commits converges on the same entity. The returned value is the authoritative `Project`
shape used by the catalog. Invalid folders reject with `ProjectRegistrationError`; its `code`,
`status`, and human-readable message are safe to display. An optional `{ projectId, signal }`
controls identity and cancellation.

### Happy Cloud enrollment and capability consent

`connectHappyCloud()` follows one versioned singleton through the shared live stream, including
local optimistic choices. Its `authority` is always `local_record_only`: enrollment is only a local
record, and all four capabilities remain denied until each is granted explicitly.

```ts
const cloud = rig.connectHappyCloud({
    onChange(status) {
        renderCloudChoices(status);
    },
});

const mutationId = rig.applyHappyCloudCommand({
    action: "set_capability",
    capability: "remote_control",
    consent: "granted",
});
```

The capabilities are `group_chats`, `remote_control`, `session_blob_persistence`, and
`happy_profile`. Rig Connect assigns the strict contract version, expected state version, and
mutation identity, then owns FIFO delivery, retry, reconciliation, and rejection. The daemon
rejects stale commands and mutation-identity reuse with different content.
The newest 4,096 successful mutation receipts are retained. Within that window, an exact duplicate
returns current authoritative status and reuse with different content is rejected. After expiry, a
stale expected version rejects the command rather than replaying its old response.

Rig does not create or inspect Happy Cloud cryptography. Profile and mobile-session payloads are
caller-encrypted canonical base64url strings of at most 2 MiB, stored and returned verbatim through
`getHappyCloudProfile()` and `getHappyCloudSessionBlob()`. At most 64 session blobs are retained;
writing a 65th distinct session evicts the oldest write. The active database therefore retains at
most about 128 MiB of session-blob ciphertext plus one 2 MiB profile. Unenrollment and targeted
revocation logically remove the affected active rows, but SQLite pages, its WAL, and backups may
retain old encrypted bytes. This is not secure erasure.

These records do not create a Happy Cloud account or device enrollment, upload anything, authorize
remote control, or activate or gate existing Happy or terminal integrations. Those effects require
separate cloud and integration primitives.

## The groups

A session does not live alone. Above it is a project, and inside a project are worktrees; both hold
sessions. `rig.connectGroups` keeps that whole tree current from one stream.

```ts
import { connectRig } from "@slopus/rig-connect";

const rig = connectRig({
    endpoint: "http://127.0.0.1:4517",
    token: process.env.RIG_TOKEN!,
});
const groups = rig.connectGroups({
    onChange(projects, state) {
        render(projects, state);
    },
});

// Later, when the view goes away.
groups.close();
rig.close();
```

Each entry is a project with its worktrees and its sessions already joined and ordered, so no
client repeats that work:

```ts
for (const group of groups.projects()) {
    group.name; // application-shaped project fields, not a wire object
    group.branch; // current branch, available from the opening catalog
    group.usage.totalTokens; // aggregate usage across the project's sessions
    group.git?.changedFiles; // live Git state, when the daemon is watching it
    group.unread.count; // chats in the project itself waiting for the person
    group.sessions; // sessions in the project root
    group.workspaces; // worktrees, each with its own sessions and Git state
    group.workspaces[0]?.error; // protocol-enforced bounded failure reason when setup failed
}
```

### Chats waiting for the person

A chat becomes unread when it stops working or asks the person something, and stays that way until
they catch up on it. Each `GroupSession` carries its own `unread`, and a project and a worktree each
carry a `GroupUnread` counting the chats waiting in it.

That count does not roll up. A project counts only the chats sitting directly in it, never those in
its worktrees, because a worktree is somewhere the person goes rather than a detail of the project:
folding its waiting chats into the project's badge would send them to the wrong place. `usage` is
aggregated the other way, deliberately.

`reason` is `turn_finished` when the agent simply stopped and `attention_needed` when it is asking.
The stronger reason wins, so a chat that asked a question and then stopped working is still asking.

Rig keeps unread state only for chats that asked for it, reported as `trackUnread` and requested
with `trackUnread: true` at creation. Subagents never have it, so a subagent finishing its work is
never something to read.

`rig.markSessionRead(sessionId)` clears a chat, which is what an interface without a terminal uses
in place of focusing one. It clears the badge immediately, is idempotent, and is durable: every
client sees the chat as read. A terminal focused on a chat still clears it on its own.

### Being told when a chat finishes

`onSessionFinished` reports the moment a chat starts waiting, which is what an interface plays a
sound for:

```ts
const rig = connectRig({
    endpoint: "http://127.0.0.1:4517",
    token,
    onSessionFinished({ reason, sessionId }) {
        play(reason === "attention_needed" ? asking : done);
    },
});
```

It reports the transition rather than the state, so a chat already waiting does not announce itself
again, a stopped run that had asked a question announces only the question, and a reconnect that
reloads a waiting chat makes no sound. It is told from the shared stream and the catalog, so
supplying it keeps the catalog loaded and the notification arrives whether or not any view is
subscribed.

The `GET /catalog` snapshot contains every unarchived session, project, and worktree. Catalog
sessions are not paged; only transcript history is. Archived session history is filtered by the
storage query before the catalog is projected.

The tree is referentially stable in the same way the element list is: a project whose subtree did
not change comes back as the same object, so a React consumer re-renders only the branch that
actually moved.

Two details are worth knowing. Sessions and projects are merged by an ordered identity rather than
by arrival, so a snapshot racing a live event cannot make the view go backwards. And an archived
session leaves the tree while remaining known, so restoring it puts it back rather than requiring a
reconnect.

## The folders

Beside the projects, and not replacing them, is a tree of folders: places to work on media,
documents, and everything that is not code. `rig.connectFolders` keeps that tree current from the
same stream and the same opening catalog the groups use, so following it adds no request of its own.

```ts
const folders = rig.connectFolders({
    onChange(tree, state) {
        render(tree, state);
    },
});

for (const folder of folders.folders()) {
    folder.name;
    folder.icon; // a single emoji, when it has one
    folder.description; // what it is for
    folder.rules; // standing instructions for agents working in it
    folder.path; // its flat storage directory, which never moves
    folder.children; // the folders nested inside it, ordered
}

folders.close();
```

Nesting is virtual. A folder's place in the tree is its parent and its order among its siblings,
while `path` is a flat directory named after the folder's own id: rearranging the tree moves nothing
on disk. A folder carries no Git state at all — no branch, no diff, no changed files.

The tree is referentially stable in the same way the project tree is, so a React consumer
re-renders only the branch that actually moved. An archived folder leaves the tree together with
everything nested under it.

A chat has one canonical scope. Project and workspace chats appear only in the project tree;
folder chats appear only in their folder; and Unsorted chats appear only in the global Unsorted
list.

Changing the tree is entity-first, because the daemon has to derive a folder's place among its
siblings itself:

```ts
const mediaId = rig.folders.create({ icon: "🎬", name: "Media" });
rig.folders.update(mediaId, { description: "Where the videos live." });
rig.folders.move(travelId, { afterId: mediaId, parentId: null });
rig.folders.archive(mediaId);
rig.folders.moveSession(sessionId, {
    afterId: null,
    scope: { folderId: mediaId, kind: "folder" },
});
rig.folders.setSessionFolder(sessionId, null); // Convenience: back to Unsorted.
```

A move says where the folder landed — the folder it was dropped into and the sibling it was dropped
below, each `null` at the root and at the top of a list. Rig derives the fractional order key from
that pair, so a client never sends or invents one. `update` clears an optional field with an
explicit `null` and leaves an absent one alone.

Every call returns a mutation ID immediately and applies its prediction synchronously. The
authoritative result also arrives through the live stream, and conflicts are rebased and retried in
order. Rig Connect names the folder it creates and reuses that identity across transport retries,
so an answer lost after the daemon committed converges on the same folder. `{ folderId }` on
`create` supplies a caller-owned identity.

## The timeline

`rig.connectTimeline` answers a different question from the groups: not what exists, but when it
worked. It gives back the agents in a scope, nested under whoever started them, each with the
stretches of time it spent working, waiting for the person, or asking them something — the shape a
Gantt chart is drawn from.

```ts
const timeline = rig.connectTimeline({
    scope: { kind: "project", projectId },
    onChange(agents, state) {
        render(agents, state); // state.from and state.to bound the whole chart
    },
});

for (const agent of timeline.agents()) {
    agent.label; // the name to draw on the row
    agent.startedAt; // where its bar begins
    agent.endedAt; // absent while anything under it is still going
    agent.spans; // working, waiting, and asking, each with an outcome
    agent.children; // the agents this one started
}

timeline.close();
```

A scope is global, a project, a worktree, or a single chat. Global covers every agent across every
project; a project reaches every worktree and chat inside it; a worktree stops there; a chat covers
itself and its subagents at any depth. Pass `includeArchived` to keep archived chats, and `since` to
drop work that had already finished.

A global chart grows with everything Rig has ever run, so `since` is worth pairing with it. Note
that a span still open has no end to fall outside the window: a chat waiting for the person right
now stays on the chart however recent the window is, which is usually what you want from a view of
what is happening.

Every boundary is a millisecond timestamp, because that is what Rig records. A chart that reads in
minutes is the consumer's choice, and nothing is rounded on the way out.

Nothing new is written to make this work. The daemon folds the durable lifecycle events it already
keeps — messages submitted, runs started and finished, questions asked and answered — into spans at
load, and this library applies the identical rules to the live stream from then on. A reload
therefore produces the same chart a client watched being built, and clearing history clears the
chart with it.

A span stays open while the work behind it is still going, and an open bar is drawn to now. Where
Rig recorded no ending at all — a daemon that stopped mid-run — the span is reported as
`interrupted` rather than being quietly completed, because that is what actually happened. After a
gap in the stream, the chart is rebuilt from the daemon instead of being left to drift, since a
missed event may have been the one that closed a bar.

## The protocol

Everything above is reachable through one continuous stream of events. That is the design
constraint, not an optimization.

The shared connection first opens `GET /events/live` with a bearer token and reads Server-Sent
Events. Its `hello` frame is deliberately light: it reports only the global cursor, whether the
requested cursor was resumed, and whether a gap was detected. The stream carries every project,
worktree, session, terminal, and presence update, so adding another view never adds another event
subscription.

Entities load by request-response after the stream is open. `GET /catalog` loads projects,
worktrees, sessions, and terminals; `GET /sessions/:id/state` loads one conversation and its recent
transcript; `POST /timeline` loads the agents and spans for one scope. Each answer carries the
global cursor at which it was taken. Events that arrive while a
load is in flight are held in a bounded buffer and replayed over that answer, so neither a slow
snapshot nor an out-of-order response can move an entity backwards.

**The transcript window is measured in turns, not messages.** It carries the most recent
`SESSION_STREAM_TURN_LIMIT` turns, currently 20, together with the boundaries and outcome of each
one. Cutting on turn boundaries is what keeps the window honest: half a turn is not a shorter
answer but a broken one, since a tool result whose call was trimmed away has nothing to attach to.
Because turns vary in length, so does the message count — a window of short replies is small, and a
single long run of tool calls can fill it alone. The bound follows the conversation's own structure,
so the cost of attaching tracks recent activity rather than the age of the session.

Those reported boundaries are also what let history render like live output: each turn in the window
carries the groups it contained, so a conversation read from history is replayed group by group with
each one's real duration and outcome, ending in the same `group_end` elements a client watching live
would have seen.

When the conversation began before the window, `session.transcriptComplete` is `false`. A UI that
scrolls back past it loads whole earlier turns through `GET /sessions/:id/transcript?before=`.

Every global update carries what changed and enough content to apply it. Nothing is a bare
notification that something changed, so there is no polling loop and no fan-out of requests after
each event.

The interpreted events include activity, context, Git, configuration, permissions, title, draft,
secrets, MCP, workflows, external calls, structured input, tasks, goals, subagents, shell commands,
messages, runs, retries, reset, and rewind. Rig emits more than these; anything unrecognised is
ordered and cursored like the rest and then ignored, so a daemon that gained an event does not
break a client that has not learned it yet.

### Reconnection

Every delivery carries an ordered UUIDv7 cursor. The library reconnects the one global stream with
`?after=`. If its bounded replay cache still serves that position, every missed event is delivered
without duplication. If not, the next `hello` reports a gap; rig-connect reloads only the entities
it currently holds and asks each conversation forward from the newest message already present.
Those forward pages overlap their anchor turn, making a partial final turn safe to replace without
resending the conversation from the beginning.

Reconnection is automatic, with a short exponential backoff capped at one second. A response the
daemon refuses is not retried unchanged, and surfaces as `LiveStreamRefused` through `onError`.

## Protocol types

The protocol types this library reads are declared in `sources/protocol.ts` rather than imported,
so a browser bundle carries no daemon code. `tests/protocolConformance.test.ts` asserts those
declarations against the daemon's own types, which means a drift between them is a failed
type-check rather than a runtime surprise. Run it with `pnpm check`.

## Layers

`connectRig` and its session/group subscriptions and actions are the public surface, and most
callers need nothing else.
The pieces beneath them are exported for consumers that want to supply their own transport or drive
the state directly:

- `ChatStore` applies protocol events to the element list and the session state, and knows nothing
  about transport. The same store is driven by a live stream, by a replay in a test, or by a
  reconnect.
- `projectToolPresentation` turns Rig's call and result presentations into the one application
  value a `tool_call` element carries.
- `GroupStore` does the same for the project tree: it joins projects, worktrees, and sessions,
  merges by ordered identity, and knows nothing about transport.
- `FolderStore` does the same for the folder tree: it nests folders by their parents, orders
  siblings, drops what has been archived, and merges by version so a snapshot racing the stream
  cannot move the tree backwards.
- `streamLiveEvents` follows the global stream with cursor-based resume and reports frames to
  callbacks.
- `sessionUnreadAfterEvent` decides the unread state one event leaves a chat in. The daemon
  publishes no event announcing that a chat became unread — the transition rides on the events that
  cause it — so this mirrors the daemon's own rule, and `tests/sessionUnread.test.ts` runs both over
  the same sequences to keep them from drifting apart.

## Releasing

From a clean `main` worktree whose `HEAD` matches `origin/main`, run:

```sh
pnpm release:rig-connect:patch
```

The command verifies that the checked-in version matches npm `latest`, runs the workspace checks
and tests, builds and previews the package, creates a `Release rig-connect vX.Y.Z` commit and a
`rig-connect-vX.Y.Z` tag, then atomically pushes both to `main`. The shared publish workflow selects
rig-connect from that tag prefix and publishes it through npm trusted publishing.

Before the first automated release, the npm settings for `@slopus/rig-connect` must name
`slopus/rig` and `.github/workflows/publish.yml` as its trusted publisher, using the `npm` GitHub
environment.
