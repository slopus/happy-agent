# Usage

Advisory token and timing accounting for one agent, and for the collection it belongs to. It
answers "how much has this agent cost so far" without becoming a quota system: the module owns
one durable record table it never prunes, and a failure to record a number never fails a turn or
an inference.
Lifecycle records join Agent Base's existing completion transactions instead of opening their own.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { EventsModule, UsageModule } from "@slopus/happy-agent-modules";

const events = new EventsModule();
const usage = new UsageModule(events);
const agent = await Agent.create(ctx, { ...options, modules: [usage] });
```

The module takes the Events module so every record uses the journal's exact durable run identity.
One instance serves every agent in a collection: it owns its tables,
uses the database carried by the current context, reads the wall clock itself, mints its own event
identities, and holds the collection of agents it was started with so it can answer questions about
one agent's subtree. Its bounds are constants — `USAGE_PAGE_SIZE` (50 raw records per page),
`USAGE_GROUP_PAGE_SIZE` (100 aggregate groups per page), and `USAGE_OUTPUT_CHARACTERS` (8,000
characters per rendering) — so no caller can widen them.

## Tools

### `get_usage`

Reads bounded usage for the calling agent. A host-neutral caller can set `aggregate: true` (or
construct the exported tool without an agent ID) to read one target or the whole collection; an
agent-scoped context cannot turn an argument into a cross-agent read.

Arguments (`GetUsageInput`):

- `aggregate?: boolean` — a host-neutral `true` requests the collection aggregate; an
  agent-scoped call remains limited to its own aggregate.
- `target?: string` — must equal the calling agent's ID if given; any other value throws
  `"Usage can only be read for the current agent."` before the store is touched.
- `cursor?: number`, `maxGroups?: number` — forwarded to `UsageModule.read` to page through
  provider/model/effort/tier groups.

The tool is `durable: true` and declares `shouldReviewInAutoMode: () => false`, so it never needs
Auto review — it only reads. It calls `module.read(ctx, agentId, query)` and returns a
`UsageSummary`. `toLLM` renders the summary through `module.formatForModel`, which is a compact,
strictly bounded text block: header line, running totals including current context fullness, then one line per visible group,
each admitted only if the whole candidate output still fits the character budget
(`USAGE_OUTPUT_CHARACTERS`, 8,000). If the model asked for more than fits, the last
line names the continuation cursor to call `get_usage` with again — `formatForModel` never returns
a truncated group row, only a note of what to page for next.

### `get_agent_tree_usage`

Reads a bounded, exact lifetime token snapshot for the current agent and every recursively linked
subagent or delegated agent.

The module builds the snapshot itself. Its shape comes from the collection of agents the module was
started with — `childOf` for the walk, `parentOf` for the ancestry check, and each agent's
configuration for its title and its creator — and every token count comes from the module's own
records, summed in one pass. Each row carries the agent's stable ID, its parent, its canonical path
from the root of the snapshot, its `relation`, its `title` when its metadata has one, and its total
tokens; the tree carries the sum.

`relation` is `root` for the agent the snapshot is rooted at, `subagent` for one whose recorded
creator is its own parent — work that parent started with a tool — and `delegated` for one placed
under a parent that did not create it.

An agent may read its own subtree and the subtree of any agent it started, however deep, and
nothing above or beside it; the ancestry walk that decides this is the collection's own answer
rather than a policy anyone wires in. A context that names no agent is host code and is not
subject to it. A snapshot larger than `MAX_USAGE_TREE_SESSIONS` (1,000) agents, or deeper than
`MAX_USAGE_TREE_PATH_LENGTH` characters of path, is refused rather than silently cut short.
Calling this before the module has started is an error.

Lifecycle status and the provider or model an agent is currently configured for are deliberately
absent: they belong to the collection and change while the snapshot is being read. The provider and
model a cost was actually spent on live on the records and are read through `readPage` or
`aggregate`.

## External functions

`UsageModule` exposes these methods for hosts and other callers (all take a `Context` first):

- `read(ctx, agentId, query?)` / `readAgent` / `readAgentUsage` — the per-agent aggregate; `query`
  accepts `cursor` and `maxGroups`, bounded by `USAGE_GROUP_PAGE_SIZE`. Throws if the context's own
  `agentId` (via `contextAgentId`) doesn't match `agentId`.
- `readPage(ctx, agentId, query?)` — one bounded page of raw `UsageRecord`s (`cursor`, `limit`),
  for a host that needs provider/model detail rather than totals.
- `readWindowUsage(ctx, since)` — provider-then-model inference totals for everything started at
  or after one instant, across the whole collection. Only host code may ask, because the answer
  spans every agent. `ApiModule` builds the `GET /v0/usage` hour, day, week, and month windows
  from it.
- `readRun(ctx, agentId, runId)` — the bounded provider-then-model inference usage attributed to
  one exact run, including cache reads and writes. `costUsd` is `null` because the current provider
  contract does not report monetary cost; the module never estimates one.
- `aggregate(ctx, query?)` / `readAggregate` / `readAggregateUsage` — a bounded summary for one
  agent (`query.agentId` set) or the whole collection (`query.agentId` omitted). Only reachable
  from a non-agent context; an agent-scoped `ctx` cannot ask for the whole collection.
- `readAgentTreeUsage(ctx, agentId)` / `readAgentTree` — the bounded subtree snapshot described
  above, built from the agent collection and the module's own records.
- `reset(ctx, agentId)` / `resetAgentUsage` — deletes one agent's records and returns the
  number removed.
- `resetAll(ctx)` / `resetAggregateUsage` — resets the whole collection.
- `formatForModel(summary, maxCharacters?)` / `formatAgentTreeUsageForModel(tree, maxCharacters?)`
  — the same bounded renderers the tools use, exposed so a host can produce the same text outside a
  tool call. `maxCharacters` defaults to `USAGE_OUTPUT_CHARACTERS` and may only ask for less.
- `onEventTransactional(listener)` — watch every committed mutation as a `UsageEvent`
  (`usage_recorded`, `usage_context_changed`, or `usage_reset`) from inside the recording
  transaction; a failure there fails the mutation. Returns the function that ends the subscription.
- `onEvent(listener)` — watch the same events after commit. Accounting is advisory, so a failing
  subscriber is logged through `ctx.log.warn` and the subscribers behind it still hear about the
  change. Returns the function that ends the subscription.

Every advisory failure — a provider that reported no tokens, a clock that moved backwards, a
subscriber that threw — is reported through `ctx.log.warn` with the phase it happened in, and never
fails the turn or inference it was accounting for.

`beforeInferenceTransact`, `beforeTurnTransact`, `afterInferenceTransact`, and
`afterTurnTransact` are Agent Base lifecycle hooks, not host-facing calls. Base's stable
`inferenceId` and `turnId` become the corresponding usage record IDs.

`beforeStart(ctx, agents)` is where the module takes hold of the agent collection; the agent-tree
read is the only thing that uses it.

## Storage

The module keeps almost nothing itself. Two kinds of state exist:

**Run KV** (`scope.runKV`, scoped to the active run): the start time and exact Events-owned run ID
of the current inference and turn, written by the before hooks and deleted by the matching
completion hooks. Inference state also retains the latest provider-reported cache usage.

- Key `pending_inference` — `{ startedAt, runId, usage? }`
- Key `pending_turn` — `{ startedAt, runId }`

The identities come from Agent Base rather than module-owned replay state.

**Module-owned tables**: durable records, bounded aggregates, and the current context snapshot.
Migration `002-drop-usage-reset-receipts` removes the obsolete reset-receipt table created by the
immutable first migration. Migration `003-usage-run-attribution` adds the exact run ID and its
bounded lookup index. Migration `004-usage-current-context` adds one current-context row per agent;
a `null` payload is a durable invalidation tombstone. Migration `005-usage-model-totals` adds the
lifetime per-agent/provider/model counters that survive pruning of recent detail.

Lifetime totals and the agent-tree snapshot read the model counters. The installation-wide time
windows read the records, because a counter has no time dimension and cannot answer what happened
in the last hour.

Records are kept forever. Nothing is evicted to make room, because a window that quietly drops the
oldest work reports the wrong number: a model used yesterday must still appear in a reading about
yesterday no matter how busy today was.

A record is one JSON document in `record_json`, and it stays that way. Because history is
unbounded, every total is summed by the database — reaching into that document with
`json_extract` — rather than by reading records into memory. The check that per-row parsing used
to perform rides along on the same scan: a row whose duration contradicts its own timestamps fails
the read instead of becoming part of a trusted number, and so does a record that is no longer
valid JSON, because reading its fields is what the scan does. The cost of that choice is a scan
per read, since the sums are computed from a document rather than from indexed columns.

- `record(ctx, UsageRecord)` inserts one record (`usage_inference_record` or `usage_turn_record`),
  keyed by Base's `inferenceId` or `turnId` and attributed by
  `agentId`/`provider`/`model?`/`effort?`/`tier?`. An attributed inference increments its model
  totals in the same transaction.
- `read(ctx, agentId, { cursor, limit })` returns a bounded `UsagePage` (`records`, `cursor`,
  `totalRecords`, `nextCursor?`), capped at `USAGE_PAGE_SIZE` (50) per page. `totalRecords` counts
  everything the agent ever recorded, so a caller can page through the complete history.
- `windowUsage(ctx, since)` sums provider/model inference tokens for everything started at or
  after one instant, across the whole collection. This is what the installation-wide hour, day,
  week, and month windows are built from. The breakdown is keyed by model, so inference the
  provider never attributed to one is left out, exactly as the lifetime model totals leave it out.
- `modelUsage(ctx, agentId)` reads lifetime provider/model input, output, cache-read, and
  cache-write totals; `totalTokensByAgent(ctx)` sums those durable counters in one pass for an
  agent-tree snapshot.
- `aggregate(ctx, { agentId?, cursor, maxGroups })` returns a `UsageSummary`: running totals
  (`inferenceCount`, `turnCount`, token and duration sums) plus a bounded, paged array of
  `UsageGroup` rows (one per provider/model/effort/tier combination), capped at
  `USAGE_GROUP_PAGE_SIZE` (100) groups per page. It also exposes `currentContext` when the latest turn has a provider-measured
  context size from `happy_agent_usage_contexts`; the value is exact (`approximate: false`) and
  disappears after a reset/compaction writes an invalidation until a later response measures the
  new context. Updating this row and recording the turn share Agent Base's completion transaction.
- `reset(ctx, agentId | null)` deletes matching records, contexts, and lifetime model totals and
  reports how many records were removed.
- The host transaction is the single read/decide/write boundary every mutation runs inside, and
  stdlib `afterCommit(ctx, callback)` registers post-commit event delivery inside that same
  transaction.

Every value crossing this boundary is checked against its TypeBox schema. Token counts, durations,
and timestamps are bounded (`MAX_USAGE_TOKEN_COUNT`, `MAX_USAGE_DURATION_MS`,
`MAX_USAGE_TIMESTAMP`), and a record whose `durationMs` doesn't equal `finishedAt - startedAt`, or
whose timestamps run backwards, is rejected before it reaches the store.
