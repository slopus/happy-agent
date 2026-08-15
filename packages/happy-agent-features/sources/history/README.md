# History

The agent's own record of what happened, which it can read back. This is not the model's context:
the context is what the provider is replaying right now, and it is compacted, reset, and thrown
away as the conversation moves. The history is what was said and done, kept whether or not any
model can still see it — so a conversation reset by an incompatible model switch loses its context
entirely and loses none of its history.

The feature writes as the agent works: every accepted user message, every completed assistant
response, every tool result, and every failed inference, from inside the transactions that commit
that work, so the record and the thing recorded become durable together.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { HistoryFeature } from "@slopus/happy-agent-features";

const history = new HistoryFeature({ store });
const agent = await Agent.create(ctx, { ...options, features: [history] });
```

`HistoryFeatureOptions` also accepts `resolveTarget`, a callback the host provides to let one
agent's history tool read another agent's history (self-access always works without it), and
`toolOutputLimit`, how many characters of a tool's output are worth recording (default `16_000`,
separate from `MAX_HISTORY_TOOL_OUTPUT_LENGTH`, the hard persistence cap). `failureMode` defaults
to `"propagate"`: an archive failure rolls back the Agent Base transaction it happened inside.
Passing `"best-effort"` is an explicit opt-in for hosts that treat history as advisory; a store
failure is then swallowed and the record is dropped.

## Tools

### `read_agent_history`

The only tool the feature exposes. It reads or searches the durable history for the calling agent,
or for another agent when `target` is given and `resolveTarget` (or self-access) allows it.
Reading changes nothing and reaches nothing outside the agent's own store, so the tool is
`durable: true` and `shouldReviewInAutoMode` always returns `false` — there is nothing to review.

Arguments:

- `cursor` — a zero-based original history position, taken from a previous `next_cursor` or
  `previous_cursor`. Cannot be combined with `from`.
- `from` — `"start"`/`"begin"`/`"beginning"` for the first matching page, `"end"`/`"last"` for the
  last one. Results are always returned chronologically regardless of which end was asked for.
  Cannot be combined with `cursor`.
- `limit` — the most matching messages to select before the response is cut by size. Defaults to
  100, capped at `MAX_HISTORY_PAGE_SIZE` (500).
- `query` — case-insensitive text search over the whole stored message: text, thinking, tool
  names, tool arguments, and tool output — not just what a bounded rendering would show.
- `roles` — restrict to up to four of `"user"`, `"assistant"`, `"error"`, `"system"`.
- `include_tools` — include simplified tool calls and truncated tool results in the rendering.
  Defaults to `true`; it never changes what `query` searches.
- `target` — the agent whose history to read. Omitted means the caller.

The response is a rendering, not a replay: `history` is chronological text capped at 80,000
characters (`MAX_HISTORY_CHARACTERS`), one numbered block per message, with long text truncated,
tool arguments and output truncated separately and more tightly, images represented only by media
type, and reasoning the provider hid marked `[redacted]` rather than fabricated. Because the cap is
on characters rather than message count, a requested `limit` can come back with fewer messages than
asked for; `returned_messages`, `cursor`, `next_cursor`, and `previous_cursor` say exactly what was
covered and how to continue. `matched_messages` and `total_messages`, and the three `stats` blocks
(`matched`, `returned`, `total` — assistant/user message counts, text characters, thinking blocks,
tool calls, and tool results), let the model size what it did and did not see without reading it.

## External functions

- `record(ctx, agentId, message: HistoryMessageInput): Promise<void>` — append one message on the
  host's behalf, for anything the feature itself did not observe. The feature allocates `recordId`
  and `at` when the input omits them.
- `read(ctx, agentId, query?: HistoryQuery): Promise<HistoryPage>` — one page, filtered and paged
  exactly the way the tool sees it. This is what `read_agent_history` calls internally.
- `messages(ctx, agentId, { from?, limit? }): Promise<HistoryRecord[]>` — the raw records for a
  page, without the tool's text rendering, for a host that wants to build its own view.
- `stats(ctx, agentId): Promise<HistoryStats>` — exact totals for the whole archive, read through
  the store's bounded page operation rather than derived from a sampled page, since a caller such
  as model handoff may keep only a two-ended sample while still needing the true totals.
- `resolveTarget(ctx, requesterAgentId, requestedTarget): Promise<string | undefined>` — the
  access check behind the tool's `target` argument. Requesting one's own ID always resolves;
  anything else is delegated to the constructor's `resolveTarget`, or refused when none was given.

`HistoryReader` (`messages`, and an optional `stats`) is the read-only structural contract other
consumers — such as model handoff — depend on instead of the concrete feature, so they can be
satisfied by anything answering the same two calls.

The feature also implements the `AgentFeature` lifecycle hooks that do the recording:
`onEventTransact` (buffers each completed text/thinking/tool-call block), `messageAcceptedTransact`
(records an accepted user message), `beforeToolCallTransact`/`afterToolCallTransact` (record one
tool result per call), `afterInferenceTransact` (writes the finished response and, if inference
failed, a separate `role: "error"` message), and `afterAgentSettledTransact` (flushes any response
blocks still pending after an interruption). These are not meant to be called directly by a host.

## Storage

Completed history lives entirely in the host's `HistoryStore`, supplied as `options.store` and
implementing two calls: `append(ctx, agentId, messages)` and `read(ctx, agentId, query)`. The
feature never buffers finished messages itself; every read, including the tool's, goes straight
through `store.read`, so the host enforces the hard per-agent record bound (`MAX_HISTORY_TOTAL_MESSAGES`,
100,000) and any retention policy before a page is ever returned. `recordId` is the append
idempotency key: a store is expected to treat re-appending an existing `recordId` with identical
content as a no-op, which is what makes a retried or resumed transaction safe. `HistoryRecord.position`
is the original, stable position a message was written at; a store that prunes old records must
keep the surviving ones' positions unchanged, since cursors are positions, not offsets.

In-flight work — the part of a response not yet durable — is kept only in `scope.runKV`, the
run-scoped Agent KV the Agent Base lends the feature, under these keys:

- `pending_blocks` — the array of `HistoryBlock`s (text, thinking, tool calls) accumulated by
  `onEventTransact` since the last flush, up to `MAX_HISTORY_PENDING_BLOCKS` (2,048) entries.
- `pending_record_id` — the `recordId` the eventual assistant/error message will carry, allocated
  once per response so a restart resumes the same identity instead of minting a new one.
- `tool_name` — the name of the tool currently dispatched, written by `beforeToolCallTransact` and
  read back by `afterToolCallTransact`.
- `tool_identity` — `{ createdAt, id }` for the in-flight tool call, written once per dispatch so a
  retried `afterToolCallTransact` after a restart reuses the same identity rather than duplicating
  the result record.

Both keys are cleared once their message is appended to the store, so a crash between the append
and the clear resumes cleanly: the next `afterAgentSettledTransact` finds nothing pending and does
nothing. Every message, block, and argument value written to KV or the store is checked against the
bounds in `HistoryMessage.ts` (per-field lengths, `MAX_HISTORY_BLOCKS_PER_MESSAGE`,
`MAX_HISTORY_MESSAGES_PER_APPEND`, and the overall JSON byte ceilings for a message and for one
tool-argument value) before it is written, so a malformed or oversized value fails the write rather
than being silently truncated or stored.
