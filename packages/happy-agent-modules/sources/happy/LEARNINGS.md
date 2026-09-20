# Happy module learnings

## Mobile reads are a transport adapter, not another file API

The first native bridge duplicated file readers, Git response mapping and output schemas. It now
calls the existing file methods with optional limits and shares GitModule's public projection
with HTTP. One JSON byte check before encryption handles the relay's size ceiling; an oversized
preview is an explicit error. Catalog ownership still determines the root, absolute file links
remain contained, and missing files, failed reads and unavailable comparisons remain distinct.
Request validation and the small success/error envelope belong to Happy; filesystem and Git
behavior stay in their existing modules.

## Personal team connections are transparent to clients

Adding an owner field and a protocol bump for personal mobile connections was unnecessary.
The agreed contract keeps the existing routes, request and response shapes, bootstrap, and event
payloads unchanged: authentication selects the user's connection inside the daemon, including
private event delivery. Each team user owns independent pairing, credentials, and parallel mobile
connections; standalone behavior stays installation-wide. This is internal ownership and routing,
not a new client capability, so it needs documentation and daemon work, not an SDK release or
protocol-version negotiation. Happy mobile is separate from the WorkOS-based Cloud integration.

The module now owns one connection lifecycle per user. Owner-keyed storage isolates projection
cursors, queued messages, remote bindings, and rejection fingerprints even when two members pair
the same mobile account. Credentials never come from the shared CLI login in team mode. Pairing's
independent context retains the member identity so subsequent mobile RPCs and messages cannot
fall back to standalone authority. Existing standalone records retain the empty owner through
new migrations; no existing migration is rewritten and no old link is assigned to a team member.

## Rich user input remains one message

Text envelopes carrying an explicit tool request retain their ordered input blocks in optional
`content`, alongside the existing text fallback for older phones. Live acceptance and historical
backfill use the same representation. Incoming rich content is validated as text, images, and at
most one request, then queued intact; its display fallback must not become duplicate model prose.
Malformed rich content is refused rather than silently downgraded to a text-only message.
Tool execution may begin before inference. Its start opens the Happy turn when no turn is open,
so requested tools and their eventual settlement share the normal turn lifecycle.

Rich input can exceed the relay outbox's single-message limit, particularly with inline images.
Both live and historical projection replace an oversized envelope with a bounded, visible sync
failure notice under the same identity. The full content remains in local History; subsequent
events keep syncing. An optional relay projection must not permanently stall a session behind
one message it cannot carry.

## Mobile tool wire normalization

- Native Windows PowerShell calls retain their real name, command purpose, and background-shell
  descriptions. Do not relabel them Bash just to reuse a mobile renderer.

- Normalize tool calls at the Happy sync boundary only when the mobile app already owns the same
  semantic renderer and argument contract. Preserve every other real tool name and send a precise
  activity description through the generic canonical tool-call envelope; a familiar but false
  tool shape is worse than an honest generic row.
- Parse Codex `apply_patch` text inside Happy Agent and send the established mobile
  `CodexPatch { changes }` payload. Mobile clients should render structured file changes and must
  never need to parse Codex's patch grammar.
- Send Codex update hunks as `modify { old_content, new_content }`, which mobile already routes
  through the same paired, intra-line diff renderer as Claude `Edit`. A raw unified patch sends
  native mobile down its simpler prefix-colored fallback instead.

## Pairing and public state

- Resolve the Happy CLI home and server URL through `ConfigModule` even before credentials exist. Reading `process.env` directly bypasses daemon-owned environment overrides and can accidentally inspect another installation during hermetic tests.
- Create the server authorization request before publishing QR data. If that initial request fails, keep the prior integration snapshot unchanged and return `happy_unavailable`; a client must never render a QR code that the server did not accept.
- Persist the resolved Happy server in owner-only settings before saving newly authorized credentials. Credentials are scoped to the server that issued them, and the pairing must reconnect to that same server after a restart.
- Publish complete, versioned integration snapshots and deduplicate identical content. Pairing owns its authorization and failure transitions, while the machine connection owns connecting, connected, disconnected, and rejected-credential transitions.
- Persist the integration version high-water mark before publishing a replacement. UUIDv7 comparison is the client reconciliation rule, so ordering must survive daemon restart and system-clock rollback.
- Pairing secrets are process-local, expire after two minutes, and are erased when the attempt settles, is cancelled, is replaced, or the daemon stops. Bound every authorization poll by the remaining lifetime and reject even a valid response that arrives after expiry. Persist credentials only after decrypting and validating the authorized bundle.
- Bound authorization response bytes and every credential-bearing string before validation or decryption. The server is an external input boundary, and a small successful pairing payload must never permit unbounded buffering.
- Serialize pairing, cancel, unlink, re-pair, activation, and credential invalidation. Generation-check work that can finish after cancellation so an obsolete authorization can never restore credentials or publish a later state.
- Coalesce the entire start operation, including configured credential refresh, rather than only QR creation. Attach a rejection observer as soon as a pairing promise crosses into module ownership; cancellation can invalidate it before the lifecycle queue installs the normal settlement handler.
- Happy is optional onboarding-adjacent state. Desktop bootstrap returns it beside onboarding for a polished first-run flow, but it is not an onboarding step and never blocks completion.

## Credential ownership and reconnects

- Desktop can finish the existing Agent QR before the legacy CLI gets its own machine ID. Read the sibling from the explicitly resolved live CLI home, validate its V2 account and server, and refresh metadata on an explicit integration start. The daemon-owned settings copy is not an authoritative live CLI identity. This refresh must not restart Agent work, replace credentials, or introduce another phone authorization protocol.
- Only standalone connections may resolve a sibling CLI home. Personal team connections omit it entirely, even when paired to the same account as the shared CLI. Standalone QR settlement allows sibling validation separately from credential adoption, so loading its newly saved credential cannot replace it with an existing CLI login.

- Check the disable flag before credential adoption. Disabled mode may inspect an already daemon-owned credential to report `configured`, but must not read or copy the external Happy login or create a machine identity.
- Remember a bounded fingerprint of credentials rejected by Happy or explicitly unlinked. Suppress only that exact daemon/external credential across restart, accept a genuinely changed external login, and clear rejection history after successful pairing. Fingerprints are metadata; never persist another copy of the token or encryption key.
- Unlinking owns only this daemon's credential copy and live clients. It must not edit the external Happy CLI installation, and repeated unlink or cancel requests must be no-ops without duplicate events.
- A Socket.IO connection error is not proof that credentials are bad. Abandon that socket and repeat authenticated HTTP machine registration; only an HTTP 401 or 403 invalidates credentials, while other failures remain retryable.
- Explicit retry must reload credentials and retry machine-identity creation instead of reusing a cached configuration that already lacks an identity.

## Session state

- Bot pictures travel as encrypted relay session avatars, not synthetic projects. Ordinary project
  sessions leave this field unset so mobile can inherit project artwork. The local bot catalog
  remains the image authority, including removal. Image uploads run independently of message and
  question delivery, are bounded and cancelled with the session connection, and old relays that
  omit the additive avatar field continue syncing normally. An encrypted content hash in the
  preview prevents restart from re-uploading unchanged images; upload retries retain their
  completed blob reference until activation succeeds. No avatar bytes or new resource fields are
  added to Happy Agent's direct API or Agent Base.
  Sessions are the relay image owner because pictures may eventually differ per conversation;
  synthetic bot projects would expose invalid creation actions on older phones. Keep small
  resource-specific validation and error messages local, while reusing the encryption primitives.
  Read bot metadata and bytes in one transaction. Artwork failures use five exponentially spaced
  retries independently of chat, then wait for a new bot revision or a recreated session client;
  a socket reconnect alone does not reset the budget. Archival never waits for artwork to finish.

- Capture an archive transition's timestamp once per session-client lifetime.
  Recomputing it while composing metadata makes each relay echo appear to be a
  new change: the sync loop writes forever, `archive()` never reaches remote
  archival or closure, and phones are flooded with metadata updates. An echoed
  write must converge without another write; restoration uses a new client.
- Bots are discovered through `BotsModule`, not project/workspace membership. Each bot projects
  its existing agent into one Happy session, with optional encrypted `bot` identity and no synthetic
  project or worktree. Startup includes idle bots; catalog events attach new bots and refresh names.
- A bot can be made from the phone through the same `spawn-happy-session` machine RPC as a
  project session, as a `bot` target that always carries its name. The phone has the person type
  the name first, so the daemon never invents one and the folder is named from birth. The bot,
  workspace and agent ids are all derived from `clientRequestId` (`:bot`, `:workspace`, and the
  session id itself), so a retry finds the bot it already made through `createWithResult` instead of
  making another; the phone's composer choices are seeded as the bot's draft exactly as they are for
  a project session. The machine advertises `capabilities.bots` so an older phone offers nothing.
- A spawn is durable before the phone hears back: a bot exists locally while the answer is still
  `pending`. A Stop pressed in that window leaves it, and the next press makes another; that
  duplicate is accepted rather than served by a cancel RPC, which would be a second machine method
  for one narrow window. Machine RPC failures answer `{ type: "error", errorMessage }` everywhere;
  the phone reads only that field, and a `message` variant was shown as an empty alert.
- The picture a person picks for a new bot reaches the daemon as a session attachment, not as
  bytes in the spawn request. The phone uploads the painted face the way it uploads an image for a
  message, then asks the session's `setAvatar` RPC to wear it by `ref`, `size` and `mimeType`. That
  reuses the one encrypted attachment download, keeps the spawn answer small and retryable, and
  lets the catalog's `setAvatar` do its usual version check. Only a bot's session accepts it; a
  project session shows its project.
- Bot lifecycle stays in the bot catalog. Phone archival calls `BotsModule.archive`; late messages
  to archived bots and attempts to create a second conversation in their exact folder are refused
  (subdirectories remain ordinary session locations). Resolve and archive the bot in one transaction
  so concurrent renames cannot invalidate the version between those operations. Restoration awaits
  the explicit post-commit archive completion, reuses the same remote identity, and replaces stale
  archive/project metadata. Never infer completion from a map entry not yet installed by `afterCommit`.
  Mobile needs no separate bot resource on the relay.

- The phone has no tier selector, but preserves the shared draft's service tier. Its sends pass
  that tier explicitly, including `null` when unset. Omitting the option tells Agent Base to keep
  the previously persisted tier, contradicting the stamped mode and potentially retaining a
  retired tier such as the `"default"` sentinel Codex rejects.
- Account quota and per-turn token usage are different projections. The native Happy app reads plan limits from each session's encrypted `agentState.usageLimits`, so Happy Agent maps the selected provider's latest account snapshot into the legacy open-window shape and republishes attached sessions whenever that snapshot changes. Fable's separate allowance uses Claude's native `seven_day_fable` id so current and older apps can render it without a new machine-metadata contract.
- A message received from the phone is steering, not an ordinary queued send. Store its pending History row and offer the same ID through `AgentSystemRef.steer` in one transaction. History's committed-pending notification is what makes the message visible to an already-open desktop transcript before Agent Base accepts it at the next run boundary.
- Acceptance of a phone-originated message must not stay silent on the session stream. Suppressing the text echo also withheld the acceptance position, so the phone could not align its transcript with run order or tell "daemon offline" from "steering queued". The mapper now emits a content-free `user-message-accepted` receipt — server message ID, durable message ID, run ID — after the same steering turn close every other accepted user message causes. The phone's vocabulary silently drops unknown event kinds, so the receipt is additive and needs no server change: the server relays opaque encrypted payloads.
- Permanent refusal is a terminal send outcome too. A turn-less service notice was discarded by mobile, leaving receipt-enabled messages pending forever. Emit `user-message-rejected` with the original relay `ref` and readable `reason`; mobile marks the original bubble failed without inventing acceptance, a turn boundary, or a timeout.
- Echo suppression is personal-connection scoped. A different participant's phone does not have the sender's original relay message: live projection and backfill must include its text, while only the sending connection gets a receipt. Use History's authenticated `userId` for that decision, independently of profile lookup. Optional author ID, display name, and connection-relative ownership travel inside the encrypted envelope; the relay learns no participant identity. Advertise receipt support explicitly so older daemons never leave newly sent bubbles waiting for an event they cannot emit.
- A queued user's submission timestamp can precede the previous archive row. Backfill keeps projected timestamps nondecreasing without changing the source History record. Mobile deliberately sorts by timestamp only, with no sequence tie-breaker; equal timestamps have no guaranteed archive ordering.
- Use Happy product language for new integration contracts. The synchronized composer value is a `HappyComposerDraft`, never a `RigComposerDraft` or another legacy Rig-prefixed name. Existing generic API field names such as `draft` stay unchanged when they already define the wire contract.
- Happy Agent's mobile integration has no real users yet; preserving its old picker contract is not a requirement. Duplicated mode fields and legacy picker adapters made the session state unnecessarily complex. Prefer matching Happy Agent's own composer state in Happy session metadata, and remove obsolete integration-only compatibility when simplifying it. This does not waive the separate Happy Agent public API compatibility rules.
- Composer state has one durable source in Happy Agent: per-user Team storage in team mode, agent metadata in standalone mode. Each Happy connection reads and writes only its owner's draft and receives only that owner's draft notifications. Moving ownership out of the API must preserve existing unsent drafts atomically. Happy session metadata mirrors the flat `draft`, `draftUpdatedAt`, and `lastMode` fields. The draft contains text, provider, model, effort, service tier, and permission mode; incoming edits and clears use the desktop API's last-write-wins timestamp, and outgoing metadata republishes the authoritative state. Selection is `draft → lastMode → defaults`. Only accepted messages write `lastMode`; metadata cannot override it. New Happy-created sessions seed an empty-text draft for their owner, not a fake last-sent mode. Keeping that draft null would discard the creation-screen choices or require separate first-message plumbing; the empty-text draft preserves them through the ordinary composer path. There is no session-level `metadata.happy` fallback, duplicated picker selection, or picker-only write adapter. The phone also keeps a local copy of the pending draft so an offline edit survives restart; that copy is not a second source of truth. On load the newer stamp wins, and a winning local draft is written to session metadata as soon as the session connects. `lastMode` is never stored locally.
- Happy does not replay missed session updates. Every socket connection, including the first, therefore forces one metadata compare-and-swap even when the local projection looks unchanged. The version conflict retrieves edits made during a disconnect or between HTTP hydration and the first socket connection.
- Keep composer synchronization simple at its existing boundaries: compare and save a draft in one database transaction, reconcile equal-stamped remote edits using the latest metadata version, and flush only pending local typing on React cleanup. Treating equal stamps as echoes or an old render as unsaved input lost newer edits. A clear's echo keeps its captured picker selection, but a changed `lastMode` must refresh it; draft timestamps alone do not version the last sent mode. Store mobile drafts per session so typing does not rewrite every saved draft or rebuild an unchanged session list.
- The Happy draft schema must accept the same additional fields as the desktop draft API. A stricter mirror interpreted a valid desktop draft as a timestamped clear. Accept those fields when projecting the draft; do not change the public API to accommodate the adapter.
- Compare metadata by content rather than serialized key order: the phone's parser reorders keys without changing values, and byte comparisons doubled metadata traffic. A failed phone write must also remain scheduled while connected instead of waiting for another edit or reconnect. Reuse its single per-session timer with capped backoff, read the latest draft on retry, and stop when the draft catches up, the session disappears, or the socket disconnects.

## Tests

- Keep composer coverage compact. Repeating complete fixtures and the same round trip at several layers inflated the change without testing distinct failures. Consolidate related scenarios, share only small local fixtures, and retain the transaction, React lifecycle, ordering, retry, and reconnect regressions at the boundary that exposes each failure.
- AgentGym must enforce its isolated `HAPPY_HOME_DIR` after merging caller-supplied environment values. A default placed before that merge can be overridden accidentally, causing an API test to import the developer's real Happy credentials and register persistent machines against the production backend. The harness prevents the connection rather than relying on remote teardown.
- Build package `dist` output before running AgentGym because the harness imports package exports, not sibling TypeScript source. A stale build can make a correct source change appear absent at the public boundary.
- Exercise the independent Happy protocol fixture through `HappyAgentClient`: successful authorization and current-agent attachment, concurrent start joining, lifecycle controls, restart ordering, rejection suppression and changed-login recovery, socket-auth revalidation, server affinity, expiry, and disabled isolation are release-risk behavior rather than optional unit coverage.
