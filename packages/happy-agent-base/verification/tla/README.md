# TLA+ verification of `@slopus/happy-agent-base`

This directory holds TLA+ models of the Agent Base runtime and the TLC configurations that check
them. They verify the durable state machine described in master plan 20 (`AgentBase` state,
transactions, crash recovery, abort, single owner) against what `sources/` actually does.

Everything here is **bounded model checking**. TLC explores every reachable state of a finite
instance of the model, so a passing configuration proves its properties only for that instance's
bounds and only for the model's abstractions of the code. That is strong evidence, not a proof of
the TypeScript program. The companion Lean development lives in `../lean/`.

## Files

| File                                            | Purpose                                                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AgentBase.tla`                                 | One `AgentBase` over its durable store: run loop, queues, tool batches, compaction, settlement, crash/restart, abort. |
| `SingleOwner.tla`                               | The SQLite process lock, the database FIFO and close ordering, and "one live `AgentBase` per agent".                  |
| `Safety*.cfg`                                   | The safety invariants under broad bounds.                                                                             |
| `Liveness*.cfg`                                 | Temporal properties under fairness.                                                                                   |
| `SettleRaceAtCrash.cfg` … `StaleBlockReset.cfg` | Focused checks, one per defect found by an earlier version of this model and since fixed in `sources/`.               |
| `SingleOwner.cfg` / `SingleOwnerResolveGap.cfg` | Ownership checks: the first passes; the second shows why an assumption is needed (expected **violation**).            |
| `run.sh`                                        | Runs TLC on every configuration and compares each outcome with its expectation.                                       |

Every configuration except `SingleOwnerResolveGap` is expected to pass, and every configuration uses
the faithful model: nothing is switched off to make a check pass. A configuration that fails is an
open defect in the code (see [Open defects](#open-defects)), or a modelling error.

## Running

```sh
packages/happy-agent-base/verification/tla/run.sh              # everything
packages/happy-agent-base/verification/tla/run.sh SafetyTools  # one configuration
```

The script needs Java 11+ and `tla2tools.jar` (TLC 2.19 / TLA+ tools 1.7.4 was used). It uses
`/opt/tlaplus-1.7.4/tla2tools.jar` when present; otherwise set `TLA2TOOLS`. Logs, counterexample
traces, and TLC's state files go to `<repo>/.context/tla-out` (gitignored), or `TLC_OUT`.
`TLC_HEAP` (default `3g`) and `TLC_WORKERS` (default `auto`) tune the JVM. The script exits
non-zero if any configuration's result differs from its expectation.

TLC exports its fingerprint set over Java RMI at startup and therefore binds a local socket. In a
sandbox that forbids binding, run the script with that permission.

## What `AgentBase.tla` models

State is split into three records:

- `d` is the durable store and survives a crash:
    - the steering/send queue (`steering.*`/`send.*` keys, FIFO);
    - `message.<id>` identity keys;
    - the main context store (`user`, `text`, `call`, `tool`, `compaction` records);
    - the pending record (`owed`: absent, or `inference`/`tools`/`compaction`/`settlement`);
    - whether that record still carries a live inference identity (a response that never ended);
    - the durable tool batch (`tool.*`: pending, or staged with a committed result);
    - `toolResult.*` claims;
    - call-bound KV;
    - the run KV;
    - each call's tool durability.
- `v` is the memory of the live process and is lost on a crash:
    - the loop's program counter;
    - the in-memory queue;
    - `#turnRequested`;
    - the abort scope;
    - `needsInference`;
    - the inherited stage, whether it carried a live inference identity, and whether the
      interrupted-response reset has been decided;
    - whether an abort dropped the requested turn, and the resulting "settle after abort" request;
    - `#recoveryChecked`;
    - the batch being run and its proposed results;
    - live tool executions, including abandoned ones still unwinding;
    - the requested compaction.
- `g` holds ghost counters and flags used only by properties and bounds.

One TLA+ step is one of: a database transaction, a non-transactional durable write, or an
in-memory step between two awaits that matter. A `Crash` may occur between any two steps. It
erases `v` and models `SIGKILL`, power loss, or a database failure (plan 08: fatal). `Restart`
models `AgentSystemLocal.create` → `#start` → `AgentBase.load` / `loadActive`: only an agent whose
pending record exists is started. `Abort` may occur whenever a run is in flight. `Offer`
(`send`/`steer`) and `RequestCompaction` may occur at any time.

### Action → code map

Line numbers are `sources/AgentBase.ts` at the time of the last run unless noted; the function
names are the stable reference.

| Action                                                  | Code                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Offer`                                                 | `#enqueueIndependently` (1309): identity `writeValueIfAbsent`, `#queueKey`, `#claimPendingWork` (1068), `afterCommit` publication + `#startRun`. Atomic with its publication because `AgentDatabaseConnection.transaction` holds the root FIFO through commit **and** `committed()`.                                                                    |
| `Abort`                                                 | `abort` → `#signalAbort` (1850), which also marks `#abortDroppedTurn` and abandons the queued input (`#abandonQueuedInput`, 2262)                                                                                                                                                                                                                       |
| `RequestCompaction`                                     | `compact` → `#ensureCompaction`                                                                                                                                                                                                                                                                                                                         |
| `Crash` / `Restart`                                     | process death; `AgentSystemLocal.#start` (`AgentSystemLocal.ts` 768) with `#instantiate(onlyIfActive)`; `#loadPendingState`                                                                                                                                                                                                                             |
| `Start`                                                 | `#runTurns` (2019): first `#resetInterruptedResponse` (3104), then the direct-settlement path for a stored `settlement` stage and the `#settleAfterAbort` path                                                                                                                                                                                          |
| `LoopOpen`                                              | `#runLoops` (2104): `#openAbortScope`, `#enterStage("inference")`                                                                                                                                                                                                                                                                                       |
| `Turn`                                                  | `#runTurn` (2160): unless its abort scope is already aborted, clear `#turnRequested` and `#abandonedQueueKeys`; `#ensureLoaded` → `#loadHistory` (4085), including undispatched-call recovery                                                                                                                                                           |
| `ResumeTools` / `PostResume`                            | `#runInferenceAttempt` (2587)                                                                                                                                                                                                                                                                                                                           |
| `CompactCheck`, `CompStage`, `CompSucceed`, `CompFail`  | `#runCompaction` (3186) / `#compactHistoryAttempt` (3213), `#preserveCompactionContinuation` (3354)                                                                                                                                                                                                                                                     |
| `Recovery`                                              | `#resumesInterruptedRun` (3065), emitting `block_reset` if `#resetInterruptedResponse` left it undecided; a trailing `block` or `compaction` record is owed when the inherited `inference` stage carries a live inference identity                                                                                                                      |
| `LoopTop`                                               | the abort check at the top of the drain loop in `#runInferenceAttempt`                                                                                                                                                                                                                                                                                  |
| `Consume`                                               | `#consumeQueue` (3590): durable-key filter, then one transaction (delete key, append user record, pending `inference`)                                                                                                                                                                                                                                  |
| `Infer`                                                 | `#requestInference` (2928) up to `session.run`                                                                                                                                                                                                                                                                                                          |
| `BlockBegin`, `BlockText`, `BlockCall`, `StreamEnd`     | `#collect` (4892): only finished blocks are appended; outcomes `normal`/`error`/`tool_call`/stream ends without `done` (`eof`)/`cancelled`. On `eof` with input still queued the turn is requested again (3004–3015). `#recordContextTokens` retires the inference identity when the response ends.                                                     |
| `SettleUnanswered`, `SettleUnanswered2`                 | `#settleUnansweredCalls` (3369), both transactions                                                                                                                                                                                                                                                                                                      |
| `Dispatch`                                              | `#dispatchToolBatch(resume=false)` (4176)                                                                                                                                                                                                                                                                                                               |
| `CallStart`                                             | the per-entry body of `#dispatchToolBatch`: staged result reuse, non-durable refusal on resume, the "cancelled before it started" check (4306), `#executeToolCall`, and its lifetime check before `execute` (4761)                                                                                                                                      |
| `CallReturn`, `CallCommit`, `CallAborted`, `CallUnwind` | `#executeToolCall` (4557), `call.commit`, the race against `abortPromise` (4331), `#settleLater`                                                                                                                                                                                                                                                        |
| `CallWriteKV`, `CallWriteRunKV`                         | a tool writing `call.kv` or the run KV (`AgentKV.#assertLive`, `AgentKV.until`). The call KV handle is bounded by `callLifetime`, which the batch aborts when it commits the call's result (4275); the call's run KV handle is bounded by the same lifetime (4612–4618).                                                                                |
| `CommitNext`                                            | `commitReady` (4225): claim, append tool record, delete `tool.*` and `toolResult.*`, `afterToolCallTransact`, clear call KV, end the call's KV lifetime after commit                                                                                                                                                                                    |
| `BatchDone`                                             | `#recordPending(lockCtx, "inference")` after the batch, a separate write                                                                                                                                                                                                                                                                                |
| `EndTurn`, `LoopEnd`                                    | `#runTurn` tail, the `#runLoops` condition (2150), the `#hasOpenToolCalls` guard in `#runTurns`                                                                                                                                                                                                                                                         |
| `SettleStage`, `SettleTx`                               | `#enterSettlementStage` (2274): one transaction reads the queues and records `settlement` only if every queued key was abandoned; `#settleRecord` (2312): read the record, `#clearPending` + settle hook + `#clearRunStore`, and reopen as `inference` in the same commit (setting `#reopenedBySettlement`) when the record no longer says `settlement` |
| `Finally`                                               | `#startRun` `.finally` (1958–2000): restart on `#turnRequested`; else settle when an abort dropped the turn while the store still owes work; else run a turn when the settlement reopened the record                                                                                                                                                    |

### Abstractions

- **One agent, one owner.** Other agents, modules, and hooks are not modelled. Transactional hooks
  (`*Transact`) are part of the transaction that runs them. A throwing transactional hook rolls the
  transaction back, which the model treats like a database failure (a crash). Observing hooks are
  omitted: they cannot affect durable state.
- **Steering and sends are one FIFO queue** with one-at-a-time consumption. `"all"` batching,
  profiles, provider/model switching and resets, permission modes, input tools
  (`tool_call_request`), system-notice injections (`inject.*`), outer-transaction delivery
  (`#enqueueInTransaction`, `#refreshCommittedQueues`), `retryForever`, drain, graceful shutdown,
  and `close` are **not** modelled.
- **Identities** (loop/turn/inference/settlement cuid2s) are not modelled, except whether the
  pending record carries a live inference identity, which is what `#resumesInterruptedRun` reads.
- **Tool durability** is chosen by the model when it emits the call. `reloadable` is folded into
  `durable`, since both mean "may run again" (`#isRetryable`). `steerable` tools are not modelled.
- **Provider streams** emit at most `MaxBlocks` finished blocks. Server-side tools are not
  modelled. Tool calls are numbered `1..NumCalls` for the whole behaviour.
- **In-process unwinding** is only partly modelled: `#settled()` waits before the next request are
  omitted. An abandoned tool keeps running and can still write through a context only when
  `ForeignCtxTools` is true.
- Each database transaction is atomic and serializable. The database is a single SQLite
  connection behind a FIFO.

### Properties

Safety (invariants):

| Property                                                       | Meaning                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TypeOK`                                                       | Type correctness of the model.                                                                                                                                                                                                                                                                          |
| `AcceptedExactlyOnce`                                          | For every message: (times it entered the conversation) + (copies still queued) = (acceptances answered `created`). No accepted message is lost or duplicated across any crash/restart.                                                                                                                  |
| `IdentityDedup`                                                | An identity is accepted again (`created`) only after history replacement released it.                                                                                                                                                                                                                   |
| `IdentityTracksMessage`                                        | The `message.<id>` key exists exactly while that message is queued or in the current conversation.                                                                                                                                                                                                      |
| `HistoryWellFormed`                                            | No result without an earlier call, no two results for one call, no call twice.                                                                                                                                                                                                                          |
| `NoMessageInsideToolExchange`                                  | A queued message is never appended after a call that is still unanswered.                                                                                                                                                                                                                               |
| `ToolStateClearedWithResult`                                   | Once a result is in history, its batch entry, claim, and call KV are gone (same transaction).                                                                                                                                                                                                           |
| `SettledCallStateClean`                                        | With no pending record there is no batch entry, claim, or call KV ("all pending states are deleted completely when a turn finishes").                                                                                                                                                                   |
| `SettledRunKVClean`                                            | With no pending record there is no run KV. `SettledIsClean` is the conjunction of the two.                                                                                                                                                                                                              |
| `ToolEntriesMatchHistory`                                      | Batch entries exist only for calls in history that are still unanswered.                                                                                                                                                                                                                                |
| `NonDurableAtMostOnce`                                         | A non-durable tool is executed at most once, even across crashes.                                                                                                                                                                                                                                       |
| `DurableBounded`                                               | Any call executes at most `1 + crashes` times.                                                                                                                                                                                                                                                          |
| `DurableWorkImpliesActiveAtCrash`, `WorkImpliesActiveWhenIdle` | When the process is dead, or alive with nothing running, a queued message, a batch entry, or an unanswered call implies a pending record, so a restart resumes it. A queued message after an abort is exempt: an abort keeps accepted input queued for the next turn and deliberately does not owe one. |
| `StaleBlockResetBeforeNewOutput`                               | A block begun by a dead process is reset before the agent shows new output or settles (plan 20).                                                                                                                                                                                                        |
| `NoToolStartAfterAbort`                                        | No tool execution starts after its turn was aborted (plan 20: abort as fast as possible).                                                                                                                                                                                                               |

Liveness (under weak fairness of the run loop, restart, and tool unwinding; the environment may
stop at any time):

| Property                          | Meaning                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EventuallyQuiescent`             | The run always stops.                                                                                                                                                                                                                                                      |
| `EventuallySettled`               | The store eventually says "settled".                                                                                                                                                                                                                                       |
| `EventuallyAllConsumed`           | Every accepted message eventually enters the conversation.                                                                                                                                                                                                                 |
| `EventuallyConsumedUnlessAborted` | Every accepted message is eventually consumed, or an abort happened and the store is settled. This is the abort contract: accepted input stays queued for the next requested turn, a restart does not run it on its own, and the store must not claim work nobody will do. |
| `AbortTerminates`                 | An abort always ends the aborted work.                                                                                                                                                                                                                                     |

## `SingleOwner.tla`

This spec models:

- `acquireAgentSQLiteProcessLock` (`BEGIN IMMEDIATE`, `busy_timeout 0`, released by the kernel on
  exit or `SIGKILL`);
- `openAgentSQLiteDatabase`: the lock is taken before the client exists and released after
  `client.close()`;
- the `AgentDatabaseConnection` FIFO, whose `close()` refuses new admissions and runs after
  everything already admitted;
- `AgentSystemLocal.#resolve` versus `#transactionAgent`.

It checks:

- `OneOwner`: at most one process uses the database.
- `NoWriteWithoutLock`: no statement executes without the lock, including after close.
- `OneLiveInstance`: at most one running `AgentBase` per agent.

`OneLiveInstance` relies on an assumption. The resolver's gap between its last database read and
its synchronous `#publish` contains no I/O, so no other caller's transaction can begin and reach
its `#agents` check inside it. `SingleOwnerResolveGap.cfg` drops the assumption, and TLC shows the
consequence. `#transactionAgent` builds a provisional instance, and its `afterCommit` `#publish`
throws. stdlib's `drainAfterCommit` still runs the message's `#activateCommittedMessages`, which
starts the provisional instance's run beside the published one. That path was not exercised in
code. It is recorded as an assumption, not a finding.

## Results

These results come from TLC 2.19 on 2 cores, run against `sources/AgentBase.ts` after the fixes
described under [History of this model](#history-of-this-model).

- **Counts.** "Generated / distinct" are TLC's final counts, and every passing run explored its
  state graph completely.
- **Bounds.** "eof" means provider streams may also end without a `done` event. "symmetry" means
  states equal up to renaming messages were merged; it is used only for safety.
- **Violations.** TLC stops at the first counterexample, so a violation's count is only what it
  explored before it. Search is breadth-first, so each trace is a shortest one.

| Configuration               | Bounds                                                                                     | Properties                                                                                       | Result               | Generated / distinct states | Depth | Time  |
| --------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------- | --------------------------- | ----- | ----- |
| `SafetyMessages`            | 2 msg × 2 offers, 1 call, 1 crash, 1 abort, 1 compaction, 2 blocks, eof (symmetry)         | all 13 safety invariants                                                                         | **pass**             | 122,080,126 / 54,439,338    | 101   | 1922s |
| `SafetyTools`               | 1 msg × 2 offers, 2 calls, 1 crash, 1 abort, 1 compaction, 2 blocks, eof                   | all 13 safety invariants                                                                         | **pass**             | 49,824,113 / 27,693,326     | 95    | 1139s |
| `SafetyCrash2`              | 1 msg × 2 offers, 1 call, 2 crashes, 1 abort, 1 compaction, 2 blocks, eof                  | all 13 safety invariants                                                                         | **pass**             | 14,631,285 / 7,215,575      | 88    | 213s  |
| `LivenessNoFaults`          | 2 msg × 2 offers, 2 calls, 0 crashes, 0 aborts, 1 compaction, 2 blocks                     | `EventuallyQuiescent`, `EventuallyAllConsumed`, `EventuallySettled`, `AbortTerminates`           | **pass**             | 17,763,967 / 8,202,949      | 94    | 921s  |
| `LivenessCrash`             | 1 msg × 2 offers, 2 calls, 1 crash, 0 aborts, 1 compaction, 2 blocks                       | `EventuallyQuiescent`, `EventuallySettled`, `EventuallyAllConsumed`                              | **pass**             | 5,604,568 / 3,315,209       | 101   | 186s  |
| `LivenessAbort`             | 1 msg × 2 offers, 2 calls, 0 crashes, 1 abort, 1 compaction, 2 blocks                      | `EventuallyQuiescent`, `AbortTerminates`, `EventuallySettled`, `EventuallyConsumedUnlessAborted` | **pass**             | 1,235,917 / 689,612         | 79    | 71s   |
| `LivenessAbortSettleWindow` | as `LivenessAbort`                                                                         | `EventuallySettled`, `EventuallyConsumedUnlessAborted`                                           | **pass**             | 1,235,917 / 689,612         | 79    | 37s   |
| `LivenessAbortQueue`        | 2 msg × 1 offer, 0 calls, 0 crashes, 1 abort, 0 compactions, 1 block                       | `EventuallyConsumedUnlessAborted`, `EventuallySettled`                                           | **pass**             | 3,273 / 2,401               | 45    | 2s    |
| `SettleRaceAtCrash`         | 2 msg × 1 offer, 0 calls, 1 crash, 0 aborts, 0 compactions, 1 block                        | `DurableWorkImpliesActiveAtCrash`, `WorkImpliesActiveWhenIdle`                                   | **pass**             | 3,829 / 2,699               | 47    | 2s    |
| `LivenessSettleRace`        | 2 msg × 1 offer, 0 calls, 1 crash, 0 aborts, 0 compactions, 1 block                        | `EventuallyAllConsumed`, `EventuallySettled`                                                     | **pass**             | 3,829 / 2,699               | 47    | 2s    |
| `LivenessStreamEof`         | 2 msg × 1 offer, 0 calls, 0 crashes, 0 aborts, 0 compactions, 1 block, eof                 | `EventuallyAllConsumed`, `EventuallySettled`                                                     | **pass**             | 817 / 617                   | 38    | 1s    |
| `StaleBlockReset`           | 1 msg × 1 offer, 1 call, 1 crash, 0 aborts, 0 compactions, 2 blocks                        | `StaleBlockResetBeforeNewOutput`                                                                 | **pass**             | 13,850 / 11,076             | 57    | 2s    |
| `AbortStartsNoTool`         | 1 msg × 1 offer, 1 call, 0 crashes, 1 abort, 0 compactions, 1 block                        | `NoToolStartAfterAbort`                                                                          | **pass**             | 1,287 / 958                 | 38    | 2s    |
| `ForeignCtxCleanup`         | 1 msg × 1 offer, 1 call, 0 crashes, 1 abort, 0 compactions, 1 block, foreign-context tools | `SettledCallStateClean`, `SettledRunKVClean`                                                     | **pass**             | 1,327 / 958                 | 38    | 1s    |
| `SingleOwner`               | Procs={p1,p2,p3}, MaxOps=2, gap=FALSE                                                      | `TypeOK`, `OneOwner`, `NoWriteWithoutLock`, `OneLiveInstance`                                    | **pass**             | 132,889 / 25,284            | 27    | 1s    |
| `SingleOwnerResolveGap`     | Procs={p1,p2,p3}, MaxOps=2, gap=TRUE                                                       | `TypeOK`, `OneOwner`, `NoWriteWithoutLock`, `OneLiveInstance`                                    | violation (expected) | 1,530 / 586                 | –     | 1s    |

## History of this model

An earlier version of this model, checked against the code before the fixes, found six defects;
each focused configuration began as a reproduction of one of them. Checking the fixes then found
five more, which were also fixed. The model now describes the fixed code.

| Configuration                             | Defect                                                                                                                                                                                                                                                                                                                                                                                                | What the code does now                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SettleRaceAtCrash`, `LivenessSettleRace` | A message accepted while the run settled was erased with the pending record; a crash before the in-memory restart stranded it behind an idle store. The first fix still lost a message accepted between the loop's settle decision and the settlement-stage write, because `#enterStage("settlement")` overwrote the `inference` record the message had written.                                      | `#enterSettlementStage` reads the queues in the same transaction and records `settlement` only when every queued key was abandoned by an abort or failure. `#settleRecord` reopens the record as `inference` in its own commit when it no longer says `settlement`, and `#startRun().finally` then runs a turn (drain and close leave it for the next owner).                                                    |
| `LivenessAbortQueue`                      | After an abort, queued messages sat behind a settled store. That is intended, so the property is now `EventuallyConsumedUnlessAborted`. The settle-window fix then broke it twice: an abort before the turn started had its abandonment cleared by that turn, and a send after the abort had its turn request swallowed by the already-aborted turn. Both left the store active with nothing running. | A turn whose abort scope is already aborted clears neither `#turnRequested` nor the abandoned keys, and a reopened settlement runs a turn.                                                                                                                                                                                                                                                                       |
| `LivenessAbortSettleWindow`               | An abort in the `#startRun().finally` window left the store active with no run in memory.                                                                                                                                                                                                                                                                                                             | `.finally` sees `#abortDroppedTurn` with work still recorded and runs a settle-after-abort pass, which settles unless a tool call is still open.                                                                                                                                                                                                                                                                 |
| `StaleBlockReset`, `Safety*`              | No `block_reset` after a crash that followed a completed block, and the truncated response was never continued. Later, a compaction stage or a resumed tool batch recorded between two crashes replaced the inherited `inference` stage and hid the interrupted response from the reset check.                                                                                                        | `#resumesInterruptedRun` also owes a response when the last record is a `block` (or `compaction`) and the inherited stage still carries a live inference identity. `#resetInterruptedResponse` runs first in `#runTurns`, before any stage write, and resets a block whenever the inherited stage is `inference` with an open request; an `inference` stage without one is still reset at the first loaded edge. |
| `AbortStartsNoTool`                       | An abort between the response and dispatch still started every tool.                                                                                                                                                                                                                                                                                                                                  | A call whose batch signal is already aborted is answered as aborted and never starts, and `#executeToolCall` checks the lifetime again right before `execute`.                                                                                                                                                                                                                                                   |
| `ForeignCtxCleanup`                       | A tool that ignored cancellation could write its call KV, and then its run KV, through a kept handle after its result committed, leaving state behind a settled agent.                                                                                                                                                                                                                                | Both handles are bounded by the call's lifetime, which ends when its result commits.                                                                                                                                                                                                                                                                                                                             |
| `LivenessStreamEof`                       | A stream that ended without `done` settled the run with messages still queued.                                                                                                                                                                                                                                                                                                                        | The turn is requested again when input is still queued.                                                                                                                                                                                                                                                                                                                                                          |

Each of these was also exercised against the real `AgentBase`, using the package's
`InMemoryPersistence` and `ScriptedProvider` in throwaway Vitest harnesses outside the package
suite. They are covered permanently by `tests/AgentBaseLifecycleEdges.test.ts`.

## Open defects

None. Every configuration except the documented `SingleOwnerResolveGap` assumption passes.

## What is not verified

- **Anything listed under Abstractions.** That covers `"all"` batching, input tools, notices,
  model and profile resets, permission modes, outer-transaction delivery, drain, close, graceful
  shutdown, `retryForever`, and steerable and reloadable interruption. It also covers thrown
  failures such as a failed turn, which now abandons its queued input like an abort, and more
  than one agent. The drain variant of the settle-window race was checked only against the code,
  with a throwaway harness.
- **Anything beyond the bounds in the results table.**
    - Safety was checked in three shapes: 2 messages and 1 tool call, 1 message and 2 tool calls,
      and 1 message with 2 crashes.
    - In all three, every message is offered twice, every response has at most 2 blocks, and there
      is 1 abort and 1 compaction request.
    - Liveness with 2 messages and 2 tool calls was checked only without faults.
    - An earlier model version was also run on 2 messages and 2 tool calls with all faults
      together. It passed 33 million distinct states at depth 42 without error but was stopped
      before completion, so it is not claimed.
- **The match between model and code.** It is argued by the map above, the reproductions, and
  review. It is not mechanically established.
- **Other storage.** PGlite and PostgreSQL backends are not covered, nor are hosts that supply
  their own `AgentStorage` lock.
