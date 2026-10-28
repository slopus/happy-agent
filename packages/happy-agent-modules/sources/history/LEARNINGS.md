# History learnings

## Spawn identity belongs to the durable call before its result

Result-only presentations arrive too late to name a sub-agent while it is being created. History
now retains a typed `spawnPresentation` on the indexed original call and emits its update only
after commit. Repeated identical writes are harmless; conflicting model or child identities are
rejected. Results, failures, and restart keep that original identity. API live and history
projections share it, and spawn calls retain raw data on compact history loads so older clients
can fall back when they do not recognize the new presentation.

## Human authorship belongs to the submitted message

Team-mode submissions capture the authenticated local user ID in daemon-owned message metadata.
History retains that ID in pending and accepted records; acceptance uses the pending record when
one exists, including its absence of authorship on older messages. Direct person-authored deliveries
may carry a validated ID in their own metadata. Agent-generated messages and client-owned metadata
never supply human authorship. Retries and restarts preserve the original author without changing
content. History keeps profile text out of user messages and public history; Team separately owns
model-facing system notifications when the sender or their displayed profile changes.

A guest of an exported bot is a person too, so a message stamped with the guest origin is archived
as a user message with the guest's ID, in either mode. Archiving it as an agent message would have
hidden who wrote it. Only the role and author follow; the trust the user origin carries elsewhere
is decided by each consumer, and none of them accepts the guest origin.

## Requested tools are user content followed by a separate assistant call

User input is no longer just text or images. Preserve `tool_call_request` unchanged in pending
and accepted history, search, and readable excerpts. It records what the person asked for; the
generated assistant call and its result record what actually happened.

Requested calls arrive transactionally before any inference identity exists. History commits an
assistant row under the generated call ID in that same acceptance transaction and indexes it for
ordinary permission and result updates. Waiting for an inference-completion hook loses that call
or joins it to the later model response. The call row and the later inference stay separate.

An unexecutable request must fail its tool, not the transaction accepting the user's message.
Requested call rows carry an internal marker and preserve exact JSON arguments within the overall
message limit, even when ordinary tool argument limits reject their size or complexity. Enforce
those execution limits in the nontransactional `beforeToolCall` hook, where Agent Base records a
normal failed result and continues. Rejecting inside acceptance or transactional dispatch leaves
the same queued message permanently blocking later work. Invalid requested names also remain
intact on the request and call; the failed result uses a safe display label.

The parsed-argument execution check applies only to a call whose durable row explicitly marks it
as requested. Ordinary model calls keep the existing raw-JSON fallback for arguments deeper or
wider than History's structured representation allows. Applying that storage schema to every
tool's parsed arguments incorrectly rejected valid MCP and task calls with more permissive tool
schemas. Determine provenance per call from durable History, so restart preserves the distinction
and a request cannot change validation for later model-generated calls.

## Request profiles are disposable compatibility markers

History stores request profiles using the stable `string | null` transport shape, but every read
decodes the stored value through the current modules-owned codec. A feature may remove a profile
identity later without making pending messages or accepted history unreadable; the old string then
projects as `null`. The profile is only a notice that Agent Base may need a fresh provider context,
never feature state or model input.

## Client metadata stays distinct from message provenance

A client may attach opaque JSON to a person-authored message. Carry it through Agent Base's
durable message metadata, but persist it as the dedicated `clientMetadata` field on both pending
and accepted History records. Public projections return that field unchanged and never merge it
into daemon-owned provenance metadata. A repeated send with the same message ID reads the original
pending or accepted record, so later payloads cannot replace its client metadata.

## Assistant history is append-only by inference and materializes completed blocks live

Each provider inference creates its own durable assistant message under the inference's stable ID,
and a later inference never appends blocks to an earlier message even when both belong to the same
run. Buffering completed blocks in `runKV` until `afterInferenceTransact` hid mid-turn text,
thinking, and tool calls from transcript readers while a long or foreign-harness turn was still
running, and left bridged MCP tool calls without an indexed durable assistant row when they ran
inside the provider request.

History now materializes each completed block into the active inference's durable assistant row inside
`onEventTransact`, flushing any reserved execution configuration records ahead of the first block
and indexing tool calls immediately so mid-turn transcript reads and bridged tool results find the
call before the provider request finishes. When a single inference turn exceeds `MAX_HISTORY_BLOCKS_PER_MESSAGE` (keeping one slot reserved per
unanswered tool call for its result) or the per-message byte ceiling, History allocates a fresh CUID2
continuation assistant message ID in `pending_inference_id` and continues appending in the same run
rather than failing the turn. Because each in-place block or tool-result update rewrites the active
row's `message_json` in SQLite (up to the 64 MiB per-message ceiling), append notifications are sent
when a row is first created, when a tool result is attached, when a full chunk rolls over to a
continuation, and when the inference or settlement finishes, avoiding $O(N^2)$ notification payloads
across intermediate blocks.

Tool completion is the narrow mutation on an existing assistant row. The tool-call index resolves
each call ID to the assistant message that owns it, and permission review, spawn identity, and tool
results update only that message. Provider-executed native tool results (`toolcall_result_end`),
which bypass `beforeToolCallTransact` and `afterToolCallTransact`, record their `tool_result` block
idempotently on the indexed assistant message from both `onEventTransact` and `onEvent`, so foreign
and provider-local calls settle to `completed` or `failed` instead of remaining stuck on `running`.

When Agent Base reconstructs a tool call after a process interruption from an older `pending_blocks`
buffer, History still reconciles any buffered blocks on activation or settlement before recovered
tool results commit, and Base retires the interrupted inference ID so the subsequent provider
request receives a fresh identity.

## Run lifecycle belongs to History

The run table is the durable authority for normal turns and standalone maintenance alike. Callers
that need lifecycle correctness use the exact `run`, `runningRun`, and `previousRun` readers rather
than inferring state from an event cache or from `runs()` pagination. The paged reader is organized
around person-visible messages and intentionally skips message-less runs, while lifecycle readers
must still see an explicit-compaction maintenance run.

An exact database reader is not a substitute for a nonblocking live signal while Agent Base owns
an active transaction: the reader may wait until that transaction settles and then truthfully see
no running row. Interactive guards therefore take a current normal-run ID from the Events module,
which owns and restart-restores that live provider state, and fall back to History for standalone
maintenance runs that Events intentionally does not represent. This does not make an API-side
cache authoritative; emitted run metadata and every terminal outcome still come from History.

Successful loop settlement is not always a public run settlement. When durable user steering is
still pending, History leaves the current run open. Accepting that steering then performs the one
atomic transition the public contract describes: the old run becomes `aborted/steering` and the
successor becomes running. Provider failure and explicit abort still settle immediately; queued
messages do not defer settlement.

## The first cursor has no previous page

An explicit cursor of zero is the same first page as `from: "start"`; it does not prove that an
earlier page exists. A previous cursor is emitted only when the selected first matching record has
an earlier matching record. Otherwise returning zero as its own predecessor makes bounded readers
reject the page as stalled.

## A run page costs queries per batch, not per run

Short runs are common, so a 50-message page can span dozens of runs. Counting and reading each
run separately made the query count grow with runs rather than messages. `runs()` now counts
candidate runs in fixed batches with one grouped query each, stops at the limit as before, and
reads every selected run's messages in one query split by run in memory. The anchor run of an
`after` page is the only one narrowed to later positions. The oversized-run check happens on the
counts, before any message is read.

## History validation must not repeatedly interpret schema trees

Concurrent desktop history loads spent more time interpreting nested message schemas than reading
SQLite. History now compiles its fixed TypeBox schemas once during module construction and reuses
them across records, runs, and pages. All existing checks, byte limits, and corruption errors remain;
the cache contains schemas only, never messages or user-specific state. UTF-8 size checks use byte
length directly instead of allocating another full encoded payload. Prewarming keeps compilation
off the first request's database transaction and prevents a cold-load latency spike.

Reading a stored message checks its schema once. The persistence bounds that follow measure the
stored JSON's own bytes and each tool argument's size, without checking the message's shape
again or encoding the parsed message a second time; writes still encode before measuring.

## Visible message activity means human text or a final model response

History reports the newest non-hidden `user` message with non-whitespace text immediately. An
`assistant` message counts only when its durable run has completed successfully; text without an
owning completed run is not assumed to be final. This prevents intermediate model prose around
tool calls from repeatedly reordering a conversation. Tool calls and results, reasoning, system
and service prose, failed or aborted runs, and generated agent-to-agent handoffs do not count. A
human message received from a remote client still counts even though its `remoteMessageId`
suppresses an echo. User-facing questions are meaningful session activity too, but they belong to
UserInput and are combined by the consumer rather than being faked as history.

## A run starts when its accepted work was submitted

`startedAt` is the accepted message's durable submission time, or the maintenance operation's
creation time. A later loop or provider event is not a second start clock. Keeping the timestamp on
the History run makes live events, elapsed-time UI, restart recovery, and paged history agree.

## A restricted bot reads only its own agents' history

Any agent may otherwise read any agent's history by ID. A bot whose owner keeps it inside its own
tree may read only the history of agents in that tree, so `resolveTarget` asks the bot settings
module and refuses other targets. An agent's own history is always readable.

## The permission reviewer reads history through the review's context

The Auto reviewer runs in a private agent system whose store holds none of this history, so
`reviewerTools(ctx, agentId)` hands it the same `read_agent_history` with the same reach and
output, bound to the review's context that carries the main database. That variant is not
deferred, because the reviewer has no tool discovery, and not transactional, because its call
runs in the private system and must not open main storage inside a private transaction.

## Execution diagnostics are not model context

Typed error metadata and configuration blocks are daemon-owned presentation data, not model
messages. History accepts the published shapes, but its readable formatter and search text omit
configuration blocks, and a configuration-only row contributes no header or blank entry. Ordinary
safe error prose remains intact, including paragraphs. This also protects model-facing history
reads and copied excerpts without weakening the durable record used by authorized API readers.

Excerpt assembly filters empty formatted rows before adding separators, so configuration-only
history stays truly empty rather than producing blank headers or whitespace.

## Execution history records actual attempts, not requested selections

History consumes Config's bounded execution observations and commits configuration records with
the affected inference. The last actual snapshot lives in agent KV, so compaction and restart do
not invent a new baseline. Requested user modes remain untouched. Coalesced requests record only
the route actually used; concrete fallback attempts remain ordered. A committed visible message
in the same run can anchor the first change, while a mid-run fallback stays chronological.
Account labels and uncertainty update the baseline without proving an account switch.

Completion-time configuration creation put live assistant messages before rows that durable
history placed first. History now prepares the committed baseline and visible anchor before
inference, then reserves immutable records synchronously when a provider block is published.
Earlier finalized attempts and the current attempt are considered in order against the last
allocated mode. A failed current lookup prevents late backfill; no-output terminal failures still
record all observed attempts before the error. Completion persists the exact reserved IDs and
content. The cache holds at most 512 operations, 64 attempts each, for fifteen minutes from
preparation; settlement and abort release it. Restart and persistence rollback discard uncommitted
reservations like streamed output, and a resumed attempt creates fresh configuration IDs.

Typed terminal failures carry the last actual attempt's source and mode. An exception translated
outside the native observation boundary retains safe plain text without invented classification;
the API explicitly makes structured error metadata optional. Config exposes only public snapshot
types through its module index; History never imports the observation store implementation.

A run whose provider cannot even be opened has no attempt. Settlement failures, and smart-route
failures without a typed attempt, ask Config for the missing-credential failure it raised for
exactly that text; any other text keeps the generic legacy fallback.

Base can currently resume a settled failure as an unsolicited inference after restart. Such an
inference has no accepted visible History run, so History does not manufacture configuration rows
or make its existing raw orphan error visible. This deliberate Base behavior (8be07b97) remains
under maintainer discussion #9, outside the writer, and is recorded by an explicit expected-failure
test of the alternative: one foreground request per send.

## A failed turn carries a typed failure that every reader shares

An authentication failure after a credential was loaded used to say the provider had no
credentials, hiding rejected or failed renewals behind a claim about discovery. The typed
`signin_missing` kind still covers both cases, but only Config's missing-credential failure says
"has no credentials". A rejected configured sign-in says it could not authenticate; native
default login commands retain their existing guidance. Neither display path changes recovery.

Clients used to receive the provider's prose plus owner-only recovery steps, and wrote nothing of
their own. Error rows now also carry `failure`, discriminated by `kind` and identical for every
reader; the row's text block is `failure.message`, the plain-text fallback for agents and older
clients. The kind comes only from typed classification — the last actual attempt's error code, or
Config's missing credential — never from the text, which survives only as `internal`'s detail and
message. A usage reset is written as a duration ("in about 2 hours") because the reader's time zone
is unknown here; clients format `resetsAt` themselves. Retry and Switch record `resolution`
on the failed row in the transaction that queues a hidden notice, so the history line survives a
reload and no user message is added; a resolved failure starts nothing again.

A failure names what failed, never what to switch to. Rows used to store a ranked snapshot of
other accounts with their usage in `fallbackProviders`, and the failure card's switch menu showed
that snapshot: one stale account at 39% while the model picker beside it listed four live accounts
with current usage. Switch targets and usage are live data the picker already reads and refreshes,
so History writes `fallbackProviders: []` (the field stays for older clients), reads rows stored
earlier back with an empty array, and Switch accepts any route the live catalog offers.

The route's own state also decides the kind. A chat whose provider is turned off, and which never
reached a provider, gets `provider_disabled`. A smart route gets `no_account_available` only when
it is spent: its last account ran out of usage, or every account is turned off. A pool that ended on
a rejected sign-in is not spent, because the person has to sign in rather than wait; an early
version called every failed-over pool spent and hid sign-in problems. Its `resetsAt` is the
earliest reset among the spent accounts. Its `members` list each account the pool set aside, in
configured order, from Config's `routeFailedAccounts`. Each member's `command` and `resetsAt` come
from the same sources its own `signin_missing` or `usage_limit` would use. A retry reopens the smart route the way a sent message
does, so its accounts are tried again.

The failed attempt is the one the route reports, not always the last one. An exhausted pool
reports a rejected sign-in ahead of a spent account, so History asks Config which account that is
and describes its latest attempt; reading the last attempt paired a sign-in message with the
spent account's out-of-tokens code. When that account failed before inference, there is no
attempt, and Config's missing-credential failure names it instead.

A spent subscription window must never read as a momentary throttle. Claude answers both with the
same `rate_limit` error, and a spent weekly limit used to show "rate-limited, try again in a
minute" when it would not reset for days. Providers now classify Claude's own limiter verdict as
out of tokens, and History also checks ProviderUsage: a `rate_limit` on an account whose vendor
reported it spent in the last fifteen minutes, with its blocking window not yet reset, becomes
`usage_limit` with that window's reset. A sign-in, a disabled route, or a spent pool still wins.

Record IDs are the API's message IDs, so they are CUID2s as API.md requires. Error rows once got
UUIDs, which the retry and switch routes could not address. Rows recorded before that change keep
their UUIDs, so those old failures cannot be retried or switched from their own message.

A context overflow is recovered before it is reported. When a response overflows before saying
anything visible, Agent Base resets the context once and retries the turn. History records no error
row for that first overflow, because the person would otherwise see a failure card for something
already being fixed. The reset's own transaction records the "Context reset" service row with
`notice: { kind: "context_reset" }`, and the API reports the one retry as `retrying` with
`kind: "context_too_long"`. Only an overflow later in the same run becomes the `context_too_long`
failure.

## A transactional tool's presentation outlives its commit

An image the agent read never reached the chat: `Read`, `view_image`, and `ReadMediaFile` are
transactional, so Agent Base commits their result inside the tool's transaction and ends the call's
stores before `afterToolCall` runs. The presentation History wrote there was refused, and the
result was recorded without it. History now keeps each successful presentation in its history
store under the call ID until `afterToolCallTransact` records it and deletes it, which works for
every tool whether or not it commits its own result.
