# Presence

What the person the agent is working with is doing right now — online, away, offline, do not
disturb, or a custom status with its own message — plus an optional short-lived override with a
fallback to return to and an optional set of recurring weekly windows. The model benefits from
knowing this: a presence of "do not disturb" or "away" is a reason to hold a question rather than
interrupt, and the feature exists so that fact reaches the model's instructions and, where a host
allows it, lets the model change it on the user's explicit request.

The feature owns none of this data. A host wires it up with a `PresenceStore` — the object that
actually reads, writes, and resolves the effective value, including how expiry, fallback, and
schedules interact at a given instant. The feature contributes validation, operation identity,
idempotent retries, and event semantics around whatever the store does.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { PresenceFeature } from "@slopus/happy-agent-features";

const presence = new PresenceFeature({
    store: hostPresenceStore,
    allowModelMutation: true,
    maxSchedules: 64,
});
const agent = await Agent.create(ctx, { ...options, features: [presence] });
```

`store` is required; `clock`, `listener`, `allowModelMutation`, `maxSchedules`, and
`onPostCommitError` are optional. `clock` defaults to `Date.now` and is what every read and
mutation is timestamped against. `maxSchedules` bounds the schedule list and defaults to 64.

## Tools it provides to the model

`get_presence` is always offered. `set_presence` is offered only when the host passes
`allowModelMutation: true`; without it the model can read presence but never change it.

- **`get_presence`** — no arguments. Reads the store's resolved presence at the feature's clock
  instant and returns `{ presence: PresenceState | null }`. The model sees a plain sentence:
  `"Current presence: <status>."` or `"No presence is configured."`
- **`set_presence`** — arguments are the small model-facing shape (`presenceToolInputSchema`):
  `status` (`online` | `away` | `offline` | `dnd` | `custom`) and `message` (required and 1–240
  characters for `custom`, optional and the same bound otherwise). It cannot set `effectiveFrom`,
  `expiresAt`, or `fallback` — those are host/API-only. Its description tells the model to use it
  "only when the user explicitly asked you to change it" and never to infer consent from context.
  It returns `{ presence: PresenceState }` and the model sees `"Presence set to <status> — <message>"`.

Both tools are `durable: true` and `shouldReviewInAutoMode: () => false`, so neither goes through
Auto-mode review — presence is not a sandboxed or destructive action. Mutations are idempotent
per call: the feature allocates one operation ID per tool call (see Storage) and replays the same
result if that call is retried, so a retried `set_presence` never double-applies or reports a
different outcome the second time.

The feature also contributes an instruction rather than a tool: `instructions(ctx, scope)` reads
the current presence and, when one is configured, returns `"Current user presence: <status> — <message>."`
(or without the message when there is none) for the system prompt. When no presence is configured
it contributes nothing.

## External functions

All of these take a `Context` first and are exported on the `PresenceFeature` instance. `ctx`
carries whatever call-scoped `AgentKV` the caller has (see Storage); it is otherwise opaque to the
feature.

- **`read(ctx)`** / **`state(ctx)`** — `state` is an alias of `read`. Returns the store's resolved
  `PresenceState | undefined` at the current clock instant, cloned. This is what `PresenceReader`
  (the narrow structural interface the feature implements) exposes to other consumers.
- **`setPresence(ctx, input, options?)`** — `input` is either a full `PresenceState` or the smaller
  `PresenceToolInput`. Normalizes it, resolves an idempotent operation, and returns the stored
  `PresenceState`. `options.operationId` lets a caller supply its own idempotency key instead of
  the feature allocating one.
- **`clear(ctx, options?)`** — removes the configured presence. Returns `true` if something was
  cleared, `false` if nothing was configured (idempotent no-op).
- **`setTemporary(ctx, input, options?)`** — sets a presence with a required `expiresAt` and an
  optional `fallback` to return to once it expires; `effectiveFrom` defaults to now. Delegates to
  `setPresence` after filling those defaults in.
- **`listSchedules(ctx)`** — returns every stored `PresenceSchedule`, up to `maxSchedules`.
- **`setSchedule(ctx, input, options?)`** — `input` is a `PresenceScheduleInput`: `days` (0–6,
  unique), `startTime`/`endTime` (`HH:MM`), `timeZone`, and a `presence` fallback. Days are
  canonicalized to ascending order. A schedule identical to an existing one (by content, not ID)
  is returned unchanged rather than duplicated; otherwise a new one is stored and given an ID by
  the store. Throws once `maxSchedules` is reached.
- **`clearSchedule(ctx, scheduleId, options?)`** — removes a schedule by ID. Returns `true` if
  removed, `false` if it did not exist.
- **`tools(ctx, scope)`** and **`instructions(ctx, scope)`** — the `AgentFeature` hooks the agent
  loop calls; these are what back `get_presence`/`set_presence` and the system-prompt line above.

Throughout, `options.operationId` on every mutation is the same idempotency mechanism the tools
use internally, exposed so a host API endpoint can make its own retries safe the same way.

A configured `listener` (`onEventTransactional`, `onEvent`) receives one `PresenceEvent` per
change: `presence_changed` (with `previous`/`current`), `presence_cleared` (with `previous`),
`presence_schedule_set`, or `presence_schedule_cleared`. `onEventTransactional` runs inside the
store's transaction, before commit; `onEvent` runs after commit, via the store's `afterCommit`
registration, and its failures are reported to `onPostCommitError` (if supplied) rather than
undoing the already-committed mutation.

## Storage

The feature holds no state of its own beyond one small idempotency record per in-flight operation;
everything else — the configured presence, its resolution policy, and schedules — lives in the
host's `PresenceStore`, injected at construction. The store contract (`PresenceStoreSchema`)
requires: `transaction`, `afterCommit` (must register synchronously), `read(ctx, at)` (resolved
value at a clock instant), `readConfigured(ctx)` (the raw configured value, unresolved), `set`,
`clear`, `readReceipt`/`writeReceipt` (see below), and an optional `schedule` sub-store
(`list`/`set`/`find`/`clear`) that is required only when schedule methods are called — calling them
without one throws "Presence scheduling is not configured."

**Mutation receipts.** Every `set_presence`/`clear_presence`/`set_schedule`/`clear_schedule`
mutation writes a `PresenceMutationReceipt` — `{ kind, operationId, fingerprint, result }` — inside
the same transaction, via `store.writeReceipt`. `fingerprint` is `JSON.stringify` of the requested
state or schedule input, bounded to 4096 characters. A replayed call with the same `operationId`
is answered straight from the receipt without touching the configured state, and if the fingerprint
doesn't match what was stored the first time, the feature throws rather than silently applying a
different mutation under a reused ID.

**Operation identity.** When a mutation call does not supply `options.operationId`, the feature
allocates one and, if the passed `ctx` carries a call-scoped `AgentKV` (via `agentKV(ctx)`),
persists it under the key `presence.<kind>.operation_id` (e.g. `presence.set_presence.operation_id`)
inside that KV's own transaction before running the store transaction. That makes a retried tool
call — which is handed the same call-scoped KV — resolve to the same operation ID and therefore
the same idempotent outcome instead of applying twice. Without a call-scoped KV, an operation ID is
generated fresh in memory for that one invocation, which is safe for a single call but is not
retry-durable across separate invocations.

**Schedules and their bound.** `listSchedules`/`setSchedule` pass `{ limit: maxSchedules }`
(default 64, configurable 1–10,000) to the store's `schedule.list`, and the feature rejects a
response longer than that limit or containing duplicate IDs. `setSchedule` checks for an identical
existing schedule (by `find`, then by scanning the full list) before asking the store to create a
new one, so a schedule is never silently duplicated by content.

Every value crossing the store boundary — read, write, receipt, and event — is validated against
its TypeBox schema and deep-cloned before it reaches the caller, and results/events emitted by a
transaction are checked to exactly match what the feature itself decided, so a store implementation
cannot substitute a different outcome after the fact.
