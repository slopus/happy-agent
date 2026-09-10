# History learnings

## Human authorship belongs to the submitted message

Team-mode submissions capture the authenticated local user ID in daemon-owned message metadata.
History retains that ID in pending and accepted records; acceptance uses the pending record when
one exists, including its absence of authorship on older messages. Direct person-authored deliveries
may carry a validated ID in their own metadata. Agent-generated messages and client-owned metadata
never supply human authorship. Retries and restarts preserve the original author without changing
content or adding profile text to the model context.

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

## Assistant history is append-only by inference

Each completed provider inference creates its own durable assistant message under the inference's
stable ID. A later inference never appends blocks to an earlier message, even when both belong to
the same run. This preserves the exact order of service messages such as automatic compaction
across reload and event reconciliation.

Tool completion is the narrow mutation exception. The tool-call index resolves Agent Base's
generated CUID2 to the inference message that owns it, and the result and permission review update
only that message. This keeps a call and its result together without turning the whole run into one
mutable history row.

When Agent Base reconstructs a tool call after a process interruption, its completed response
blocks may still be in the run KV because inference completion was a later transaction. The
reconstructed batch still lacks a durable History row. When Base transactionally reactivates the
interrupted inference, History flushes the pending blocks before the recovered batch can run. The
call index therefore exists before the recovered result can commit. Recovery follows Agent Base's
durability rules; it never re-executes a tool merely to repair the history projection.
Base retires the interrupted inference ID once a completed response block exists, so any provider
request after recovered tool results receives a fresh identity and remains a separate history row.

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
