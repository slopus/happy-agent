# Usage

Advisory token and timing accounting for one agent, and for the collection it belongs to. It
answers "how much has this agent cost so far" without becoming a quota system: the feature owns no
database, lock, or authoritative counter, and a failure to record a number never fails a turn or an
inference. Every mutation still goes through a real host transaction, so what does get recorded is
exact and never double-counted across a retry.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { UsageFeature } from "@slopus/happy-agent-features";

const usage = new UsageFeature({ store: hostUsageStore });
const agent = await Agent.create(ctx, { ...options, features: [usage] });
```

One instance serves every agent in a collection; the host injects a `UsageStore` that holds the
durable records and aggregates, keyed by `agentId`.

## Tools

### `get_usage`

Reads bounded usage for the calling agent only. Cross-agent and whole-collection reads are a host
API, never something a tool argument can request.

Arguments (`GetUsageInput`):

- `aggregate?: boolean` — present for symmetry with the host aggregate query; the tool always
  returns an aggregate summary regardless of its value.
- `target?: string` — must equal the calling agent's ID if given; any other value throws
  `"Usage can only be read for the current agent."` before the store is touched.
- `cursor?: number`, `maxGroups?: number` — forwarded to `UsageFeature.read` to page through
  provider/model/effort/tier groups.

The tool is `durable: true` and declares `shouldReviewInAutoMode: () => false`, so it never needs
Auto review — it only reads. It calls `feature.read(ctx, agentId, query)` and returns a
`UsageSummary`. `toLLM` renders the summary through `feature.formatForModel`, which is a compact,
strictly bounded text block: header line, four running totals, then one line per visible group,
each admitted only if the whole candidate output still fits the character budget
(`MAX_USAGE_OUTPUT_CHARACTERS`, default 8,000). If the model asked for more than fits, the last
line names the continuation cursor to call `get_usage` with again — `formatForModel` never returns
a truncated group row, only a note of what to page for next.

## External functions

`UsageFeature` exposes these methods for hosts and other callers (all take a `Context` first):

- `read(ctx, agentId, query?)` / `readAgent` / `readAgentUsage` — the per-agent aggregate; `query`
  accepts `cursor` and `maxGroups`, bounded by `maxPageSize`/`maxGroups` from the constructor
  options. Throws if the context's own `agentId` (via `contextAgentId`) doesn't match `agentId`.
- `readPage(ctx, agentId, query?)` — one bounded page of raw `UsageRecord`s (`cursor`, `limit`),
  for a host that needs provider/model detail rather than totals.
- `aggregate(ctx, query?)` / `readAggregate` / `readAggregateUsage` — a bounded summary for one
  agent (`query.agentId` set) or the whole collection (`query.agentId` omitted). Only reachable
  from a non-agent context; an agent-scoped `ctx` cannot ask for the whole collection.
- `reset(ctx, agentId, options?)` / `resetAgentUsage` — deletes one agent's records and returns the
  number removed.
- `resetAll(ctx, options?)` / `resetAggregateUsage` — resets the whole collection.
- `formatForModel(summary, maxCharacters?)` — the same bounded renderer the tool uses, exposed so a
  host can produce the same text outside a tool call.

`options?.operationId` on a reset lets the caller supply its own idempotency key; if omitted, the
feature generates one. Replaying the same `operationId` against the same target returns the
original `removed` count without touching the store again — the receipt recorded for it is checked
for an exact match on `operationId`, `agentId`, and fingerprint before being trusted.

`UsageFeatureListener` (constructor option `listener`) is notified of every committed mutation as a
`UsageEvent` — `usage_recorded` or `usage_reset` — through `onEventTransactional` (inside the
store's transaction) and `onEvent` (after commit, best-effort: a throwing `onEvent` is reported via
`onObserverError`, not propagated).

`beforeInferenceTransact`, `beforeTurnTransact`, `afterInference`, and `afterTurn` are Agent Base
lifecycle hooks, not host-facing calls: they open and close the pending observation that becomes a
`usage_recorded` event, driving the same `#record` path the tool's `read` surfaces afterward.

## Storage

The feature keeps almost nothing itself. Two kinds of state exist:

**Run KV** (`scope.runKV`, call-scoped to the in-flight inference or turn): one pending
observation, written by `beforeInferenceTransact`/`beforeTurnTransact` and deleted once the
matching `afterInference`/`afterTurn` finishes.

- Key `pending_inference` — `{ id: UsageId, startedAt: UsageTimestamp }`
- Key `pending_turn` — `{ id: UsageId, startedAt: UsageTimestamp }`

This is only what is needed to make one observation's duration and identity stable across a retry;
it is never read back by a host.

**Host `UsageStore`** (constructor option `store`, an injected structural contract — this package
never imports a concrete implementation): the durable records, aggregates, and reset receipts.

- `record(ctx, UsageRecord)` inserts one record (`usage_inference_record` or `usage_turn_record`,
  keyed by `id` and attributed by `agentId`/`provider`/`model?`/`effort?`/`tier?`); a duplicate
  `id` must return `inserted: false` with the original record unchanged.
- `read(ctx, agentId, { cursor, limit })` returns a bounded `UsagePage` (`records`, `cursor`,
  `totalRecords`, `nextCursor?`), capped at `MAX_USAGE_PAGE_SIZE` (100) per page and
  `MAX_USAGE_RECORDS` (500) records overall.
- `aggregate(ctx, { agentId?, cursor, maxGroups })` returns a `UsageSummary`: running totals
  (`inferenceCount`, `turnCount`, token and duration sums) plus a bounded, paged array of
  `UsageGroup` rows (one per provider/model/effort/tier combination), capped at `MAX_USAGE_GROUPS`
  (500) groups.
- `reset(ctx, agentId | undefined, operationId)` deletes matching records and reports how many were
  removed.
- `readResetReceipt` / `writeResetReceipt(ctx, receipt, { maxReceipts })` persist the idempotency
  record for a reset — `{ operationId, agentId, removed, fingerprint }` — and must evict older
  receipts in the same transaction so no more than `maxReceipts` (constructor option
  `maxResetReceipts`, default `MAX_USAGE_RESET_RECEIPTS` = 500) survive.
- `transaction(ctx, work)` is the single read/decide/write boundary every mutation runs inside, and
  `afterCommit(ctx, callback)` registers post-commit event delivery synchronously, inside that same
  transaction.

Every value crossing this boundary is checked against its TypeBox schema and, for records and
mutation results, checked again for an exact match against what the feature expects — a store that
returns a plausible but different record or count is rejected rather than trusted. Token counts,
durations, and timestamps are bounded (`MAX_USAGE_TOKEN_COUNT`, `MAX_USAGE_DURATION_MS`,
`MAX_USAGE_TIMESTAMP`), and a record whose `durationMs` doesn't equal `finishedAt - startedAt`, or
whose timestamps run backwards, is rejected before it reaches the store.
