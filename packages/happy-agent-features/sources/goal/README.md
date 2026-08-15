# Goal

## What it is

Goal is long-running work: a single objective an agent keeps pursuing across turns until it
reports the work complete or blocked, rather than treating each reply as the end of the
conversation. Without it, an agent that finishes a turn simply goes idle; a user who asked for
something that takes many turns has to keep prompting it forward by hand. Goal closes that gap by
watching each turn end. If the agent's own goal is still active when a turn settles, and the turn
did not itself fail, the feature sends the agent a message asking it to look at where things
actually stand and continue — so the loop starts another turn instead of stopping. Three
consecutive failed turns move the goal to `blocked` automatically, so a broken loop cannot run
forever.

One `GoalFeature` instance serves every agent in a collection; each agent's goal lives in that
agent's own store, so it follows the conversation and survives a restart.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { GoalFeature } from "@slopus/happy-agent-features";

const goals = new GoalFeature({
    storage,        // GoalStorage: storage.persistence(agentId) => GoalPersistence
    afterCommit,     // (ctx, work) => void — registers work to run after the current transaction commits
    wakeScheduler,   // optional durable latest-state outbox for externally activated goals
    listener,        // optional: GoalFeatureListener — onEventTransactional / onEvent
});

const agent = await Agent.create(ctx, {
    ...options,
    persistence,           // must resolve to the same backing store as `storage.persistence(agentId)`
    features: [goals],
});
```

`storage` must route to the same persistence the host also gives `Agent.create`: Goal's public API
(`goal`, `setGoal`, `changeGoalStatus`, `clearGoal`) reads and writes through its own
`GoalStorage`, independent of any running agent, while the feature's hooks read and write through
the `AgentKV` Agent Base hands them for the same agent. Both must land in the same store, scoped
`feature.goal`, or the two views of a goal diverge. A host that permits goal activation outside
the owning agent should supply `wakeScheduler`: its `reconcile` joins the goal transaction and
persists exactly one latest scheduled state or cancellation tombstone per agent, while `read`
lets the feature verify that state after commit. The scheduler's worker must compare the complete
latest state again in the shared transaction that accepts the Agent Base message, so a superseded
activation cannot wake the agent after a newer pause, completion, clear, or activation.

## Tools it provides to the model

Every tool is `durable: true` (idempotent, replayable) and sets `shouldReviewInAutoMode: () =>
false` — Goal's own mutations never require Auto-mode review. Each tool runs `execute` inside
`withGoalToolContext(ctx)`, which requires an Agent Base call-scoped store and scopes it to
`feature.goal`; every model-facing reply is trimmed with `formatGoalForModel(goal,
maxOutputCharacters)`, which never emits more than the feature's configured `maxOutputCharacters`
(default `12_000`) even for a legal maximum-length objective.

- **`create_goal`** — starts the agent's goal. Argument: `objective` (1 to
  `MAX_GOAL_OBJECTIVE_CHARS` = 20,000 characters, trimmed and validated by
  `normalizeGoalObjective`). Fails if the agent already has an unfinished goal; calling it again
  with the same objective on an already-active goal is a no-op that returns the existing goal
  rather than an error. On success it also records the run's observed lifecycle so the turn that
  created the goal is eligible to continue in the same run.
- **`get_goal`** — reads the agent's current goal. No arguments. Returns `{ goal: SessionGoal |
  null }`; `null` when the agent has never had one.
- **`update_goal`** — moves an active goal to a terminal status. Argument: `status`, one of
  `"complete"` or `"blocked"`. The description tells the model to use `complete` only when the full
  objective is verified done, and `blocked` only when it cannot continue without user input or an
  external change; pausing, resuming, and clearing are reserved for the person who owns the goal,
  not the model.
- **`clear_goal`** — abandons the goal outright. No arguments. Returns `{ cleared: boolean }`, true
  only if a goal existed to clear.

Every tool call is one durable operation. A retried call with the same operation identity replays
the same result instead of mutating state again (see Storage, below, for how that identity is
kept). Setting or changing status to `active` wakes the owning agent for another turn only when
the change actually took effect; a no-op call — for example creating a goal with the objective it
already has — never wakes anything.

## External functions

`GoalFeature` exposes four public methods, callable by a host or an API layer outside any running
agent turn, using the same durable machinery as the tools:

- **`goal(ctx, agentId): Promise<SessionGoal | undefined>`** — read one agent's current goal, or
  `undefined` if it has never had one.
- **`setGoal(ctx, agentId, objective, options?): Promise<SessionGoal>`** — start or idempotently
  retry an objective. `options.operationId`, if supplied, is the durable retry identity; omitted,
  the feature generates one. Throws if the agent already has an unfinished goal with a different
  objective.
- **`changeGoalStatus(ctx, agentId, status, options?): Promise<SessionGoal>`** — move an existing
  goal to any `GoalStatus` (`"active" | "paused" | "blocked" | "complete"`). Throws if the agent has
  no goal.
- **`clearGoal(ctx, agentId, options?): Promise<boolean>`** — clear the goal and report whether one
  existed at that point.

All four validate `agentId` (1–256 characters) and, where relevant, `status`. A state-changing
external call reconciles the injected `wakeScheduler`: an active result writes a stable scheduled
message identity, while a non-active or cleared result writes a cancellation tombstone. Calls
from the owning agent's run and no-op replays do not schedule another wake.

Every state-changing call that actually changes something also produces a `GoalEvent`
(`goal_set`, `goal_status_changed`, or `goal_cleared`, each carrying `eventId`, `at`, `agentId`,
and — except for `goal_cleared` — the resulting `goal`). If a `listener` was supplied to the
constructor, `onEventTransactional` runs inside the same transaction as the mutation, and `onEvent`
runs afterward through the `afterCommit` callback; a throw from `onEvent` is reported to
`onPostCommitError` rather than propagated, since durable state has already committed.

The package root also re-exports `formatGoalForModel(goal, maxOutputCharacters)` — the same
bounded formatter the tools use — and `assertGoalFeatureOptions`, the runtime guard the constructor
runs on its own options, for hosts that want to validate a `GoalFeatureOptions` value before
constructing the feature.

## Storage

Goal state lives in two places, both required to be the same underlying store scoped to
`feature.goal` for a given agent (see Wiring, above):

**Host-injected `GoalStorage`** (`storage.persistence(agentId)`, wrapped as `goalKV`) holds the
durable record a host can read outside any run:

| Key | Holds |
|---|---|
| `goal` | The current `SessionGoal` (`createdAt`, `objective`, `status`, `updatedAt`), or absent. |
| `operations` | A bounded ledger of `{ receipt, proof }` pairs, one per durable mutation from a host caller, capped at `MAX_GOAL_RECEIPTS` (256) entries and `MAX_GOAL_LEDGER_BYTES` (1,000,000) encoded bytes total; each receipt and proof is capped at `MAX_GOAL_EVIDENCE_BYTES` (1,000,000) bytes. This is the idempotency ledger for `setGoal`/`changeGoalStatus`/`clearGoal` calls made directly against the feature, keyed by `operationId`; a repeated `operationId` with a different fingerprint or result is rejected. |
| `lifecycleId` | The `operationId` that started or last re-activated the current active goal; distinguishes one activation from the next for wake and continuation logic. |
| `failureCount` | Consecutive failed turns while the goal is active, 0 to `FAILED_TURNS_BEFORE_BLOCKED` (3); reset whenever a turn does not fail. |
| `autoBlockOperationId` | The reserved operation identity for the current lifecycle's one automatic block attempt, derived deterministically from `lifecycleId`. |
| `autoBlockEvidence` | The `{ receipt, proof }` pair for that automatic block, once it has fired; cleared whenever the lifecycle changes. |

**Agent Base's own feature-scoped `AgentKV`** (`scope.kv` / `scope.runKV` in the hooks) holds
run bookkeeping and the call-scoped evidence for a durable tool call in flight:

| Key | Scope | Holds |
|---|---|---|
| `lastInference` | run (`runKV`) | The last inference's `state` (`"cancelled" \| "normal" \| "tool_call" \| "length" \| "error"`), written after every inference and read by `afterAgentLoop` to decide whether the turn failed. |
| `observedLifecycleId` | run (`runKV`) | The `lifecycleId` this run observed as active, written in `beforeAgentLoop` and re-checked in `afterAgentLoop` so a stale or superseded observation cannot trigger a continuation. |
| `continuationId` | run (`runKV`) | The stable message ID used for this run's continuation send, derived from a factory-generated source hashed to a short deterministic string, so a retried continuation reuses the same ID instead of sending twice. |
| `operation` | call (via `withGoalToolContext`) | One pending or completed `{ request, receipt?, proof? }` for the tool call in progress, capped at `MAX_GOAL_CALL_EVIDENCE_BYTES` (= `MAX_GOAL_EVIDENCE_BYTES`, 1,000,000) bytes; written before the mutation and cleared by `afterToolCallTransact` once Agent Base durably commits the tool result, so a rollback leaves it in place for a safe retry. |

Every write is validated against its TypeBox schema before and after persistence — writes read
back their own value and throw if the store did not retain exactly what was written — and every
receipt/proof pair is checked for internal consistency (matching operation, agent, operation ID,
fingerprint, and — per operation kind — a legal before/after transition) before it is trusted.
