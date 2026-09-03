# History

The agent's own record of what happened, which it can read back. This is not the model's context:
the context is what the provider is replaying right now, and it is compacted, reset, and thrown
away as the conversation moves. The history is what was said and done, kept whether or not any
model can still see it — so a conversation reset by an incompatible model switch loses its context
entirely and loses none of its history.

The module writes as the agent works: every accepted user message, every completed provider
inference as its own assistant message, every tool result, and every failed inference, from inside
the transactions that commit that work, so the record and the thing recorded become durable
together. Completed messages are append-only. A tool result and its permission review are the
narrow exceptions: the tool-call index updates the inference message that owns the matching call
ID.

The record keeps who actually sent each incoming message. An actual system-role message remains
`role: "system"`. Goal continuations, collaboration deliveries, and some other generated messages
reach the model wearing the user role; history records those under their real sender instead. A
user-role message the host positively stamped as an end-user submission (the same `messageOrigin`
provenance metadata the automatic permission reviewer trusts) is recorded as `role: "user"`;
every other user-role message, including an unstamped one, is recorded as `role: "agent"`, with
`senderAgentId` naming the specific sending agent when its metadata named one — the collaboration
module names the sending collaborator, and a goal continuation names the agent driving itself.
This fails closed: a forgetful path under-attributes rather than a synthetic message being
recorded as the person.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { HistoryModule } from "@slopus/happy-agent-modules";

const history = new HistoryModule();
const agent = await Agent.create(ctx, { ...options, modules: [history] });
```

The module takes no construction arguments and no callbacks. Any agent may read any agent's
history: a target is a stable Agent ID, reading one's own always resolves, and an agent that has
recorded nothing simply has an empty archive. Every tool response carries the bounded roster of
the agents it concerns — the reader, and the agent read when that is someone else — each with its
own archive count.

A tool result is summarized by the module's own bounded one-line display, and only the first
16,000 characters of a tool's output are worth recording (separately from
`MAX_HISTORY_TOOL_OUTPUT_LENGTH`, the hard persistence cap); output past that is truncated with a
note saying how much was dropped. An archive failure always propagates: it rolls back the Agent
Base transaction it happened inside, so the record and the thing recorded stay in agreement.

## Tools

### `read_agent_history`

The only tool the module exposes. It reads or searches the durable history for the calling agent,
or for any other agent when `target` is given — history is readable by every agent.
Reading changes nothing and reaches nothing outside the agent's own store, so the tool is
`durable: true`, `transactional: true`, and `shouldReviewInAutoMode` always returns `false` —
there is nothing to review. Agent Base owns the page-read and result transaction.

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
- `roles` — restrict to up to five of `"user"`, `"agent"`, `"assistant"`, `"error"`, `"system"`.
- `include_tools` — include simplified tool calls and truncated tool results in the rendering.
  Defaults to `true`; it never changes what `query` searches.
- `target` — a stable Agent ID. Omitted means the caller; any well-formed ID may be read, including
  one that has recorded nothing yet.

The response always includes `agents`, the bounded roster of the agents it concerns with `agent_id`,
`description`, `message_count`, `path`, and `status`, so a model can see what it is reading.
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

- `record(ctx, agentId, message: HistoryMessageInput): Promise<void>` — append one message a
  caller observed, for anything the module itself did not. The module allocates `recordId`
  and `at` when the input omits them.
- `read(ctx, agentId, query?: HistoryQuery): Promise<HistoryPage>` — one page, filtered and paged
  exactly the way the tool sees it. This is what `read_agent_history` calls internally.
- `messages(ctx, agentId, { from?, limit? }): Promise<HistoryRecord[]>` — the raw records for a
  page, without the tool's text rendering, for a caller that wants to build its own view.
- `stats(ctx, agentId): Promise<HistoryStats>` — exact totals for the whole archive, read through
  the store's bounded page operation rather than derived from a sampled page, since a caller such
  as model handoff may keep only a two-ended sample while still needing the true totals.
- `readExcerpt(ctx, agentId, maxCharacters): Promise<HistoryExcerpt | undefined>` — a bounded
  two-ended quotation of a whole archive: the first and last pages read, merged and deduplicated,
  rendered into `beginning` and `recent` text within `maxCharacters` (at most
  `MAX_HISTORY_EXCERPT_CHARACTERS`, 200,000), with `stats` for the whole archive when the exact
  totals agree with what was sampled and `statsAreSampled` saying which it got. An archive with
  nothing in it returns `undefined`. This is what a model handoff quotes, so the caller never has
  to page, merge, or reconcile totals itself.
- `listAgents(ctx, requesterAgentId, targetAgentId?): Promise<HistoryAgentSummaries>` — the bounded
  roster returned with every tool response: the reader, and the agent read when that is someone
  else, each described from its own archive count.
- `resolveTarget(ctx, requesterAgentId, requestedTarget): Promise<string>` — the resolution behind
  the tool's `target` argument. Requesting one's own ID always resolves; anything else is used as
  a raw Agent ID as long as it is a well-formed one, and is refused when it is not.
- `onAppend(listener): () => void` — subscribe to committed appends. The listener is called after
  the appending transaction commits, with a private clone of the messages, and the returned
  function unsubscribes. Subscribers are independent: one that fails is logged through `ctx.log`
  and the rest are still told. This is how the observation module's history dump follows the
  archive.
- `onPending(listener): () => void` — subscribe to committed pending user messages. The listener
  receives a private clone only after the outer transaction that stores the pending row and offers
  it to Agent Base commits. API projection uses this so submissions from non-HTTP producers are
  visible immediately while they wait.

The module also implements the `AgentModule` lifecycle hooks that do the recording:
`beforeInferenceTransact` (retains the inference identity until its message commits),
`onEventTransact` (buffers each completed text/thinking/tool-call block), `messageAcceptedTransact`
(records an accepted user message), `beforeToolCallTransact`/`afterToolCallTransact` (record one
tool result per call on the message containing that call, including its one-line display summary),
`afterInferenceTransact` (writes the finished response and, if inference failed, a separate
`role: "error"` message), `afterAgentActivatedTransact` (reconciles response blocks left pending
when Base restores interrupted work), and
`afterAgentSettledTransact` (flushes any response blocks still pending after an interruption).
These are not meant to be called directly.

## Storage

Completed history lives in the module's migrated database table. Agent lifecycle hooks use the
transaction already supplied by Agent Base; a direct call opens its own through `ctx.inTx`, which
joins the caller's transaction when there already is one. `recordId` identifies a record, and reusing one is a database conflict,
not a module-owned replay signal. Agent Base owns durable tool retry and completion. A
`HistoryRecord.position` is the original, stable position at which a message was written; cursors
are positions rather than offsets.

In-flight work — the part of a response not yet durable — is kept in the top-level `scope.runKV`,
the run-scoped Agent KV that Agent Base lends the module, under these keys:

- `pending_blocks` — the array of `HistoryBlock`s (text, thinking, tool calls) accumulated by
  `onEventTransact` since the last flush, up to `MAX_HISTORY_PENDING_BLOCKS` (2,048) entries.
- `pending_inference_id` — the stable inference ID that becomes the next assistant message ID;
  retained until the pending blocks commit or settlement flushes them after interruption.

Per-call presentation state uses that call's scoped `scope.runKV` instead: `tool_name` is written by
`beforeToolCallTransact`, and `tool_presentation` is written after successful execution. Both are
read by `afterToolCallTransact`; the run store clears them when the agent settles.

The pending blocks are cleared in the same transaction that appends their message, so a crash
cannot commit only one side. Base retires that interrupted response's inference identity before it
recovers the tool batch, so the provider request after the recovered results creates its own
assistant message. Every message, block, and argument value written to KV or the database is
checked against the
bounds in `HistoryMessage.ts` (per-field lengths, `MAX_HISTORY_BLOCKS_PER_MESSAGE`,
`MAX_HISTORY_MESSAGES_PER_APPEND`, and the overall JSON byte ceilings for a message and for one
tool-argument value) before it is written, so a malformed or oversized value fails the write rather
than being silently truncated or stored.
