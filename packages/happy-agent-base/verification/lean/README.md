# Lean 4 verification of `AgentBase`

A machine-checked model of the durable state machine in `sources/AgentBase.ts`. It has
inductive proofs over traces of any length. Every result is proven for **all** reachable states,
with no bound on the number of messages, tool calls, crashes, or restarts. This is what the
Lean half adds to the bounded TLA+ model in `../tla/`.

**Scope.** The theorems are about the model, not the TypeScript. Each model transition
corresponds to a named piece of code (see the table below). Building the model found several
discrepancies between the code and master plan 20. They were fixed in `sources/AgentBase.ts`,
each with a regression test in `tests/AgentBaseLifecycleEdges.test.ts`, and the model follows
the fixed code (see [Findings](#findings)). Still, nothing here mechanically checks that the
TypeScript implements the model. [Abstractions](#abstractions-and-what-is-not-verified) lists
what the model leaves out.

## Build

```sh
# One-time: install elan and the pinned toolchain (lean-toolchain: leanprover/lean4:v4.22.0).
curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none
cd packages/happy-agent-base/verification/lean
lake build   # about 25 s from clean; core Lean only, no Mathlib, no dependencies
```

The result is `Build completed successfully.` with no warnings. The sources contain no `sorry`,
`admit`, `axiom`, `native_decide`, `implemented_by`, or `unsafe`:

```sh
grep -rnE "sorry|admit|axiom|native_decide|implemented_by|unsafe" AgentBaseVerification AgentBaseVerification.lean
```

`#print axioms` for every headline theorem reports only Lean's standard `propext`,
`Quot.sound`, and (for theorems whose proofs use `grind`/`simp` classical reasoning)
`Classical.choice`. The replayed finding traces use `decide`, which the kernel evaluates.
It does not use `native_decide`, so it adds no trust in compiled code.

## Files

| File                                  | Contents                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `AgentBaseVerification/Tx.lean`       | Generic transaction semantics (`inTx`, nesting, `afterCommit`, rollback, crash) and atomicity proofs |
| `AgentBaseVerification/Lock.lean`     | Single-owner process lock (`AgentSQLiteProcessLock.ts`): mutual exclusion and single writer          |
| `AgentBaseVerification/Model.lean`    | The AgentBase state machine: durable, in-memory, and ghost state, and 34 transitions                 |
| `AgentBaseVerification/Lemmas.lean`   | Facts about the derived views (message IDs, calls, results, queues)                                  |
| `AgentBaseVerification/Safe.lean`     | First inductive invariant: identities, loss, and tool execution bookkeeping                          |
| `AgentBaseVerification/Correct.lean`  | Second inductive invariant: the active flag, pending tool state, results, and block reset            |
| `AgentBaseVerification/Liveness.lean` | Abort reaches idle; restart can resume and settle                                                    |
| `AgentBaseVerification/Findings.lean` | Each finding ruled out in general, and its original trace replayed on the fixed model                |

## The model

State is split three ways:

- **`Durable`** is what the store holds and a crash keeps. It has the `message.<id>` identity
  keys, the `steering.*` and `send.*` queues, the main context records (`user`, completed
  `block`, `result`, `system`, `compaction`), the `tool.*` batch entries (each with its
  optionally committed result), the call-scoped KV (`kv.<agent>.call.<id>.*` /
  `toolResult.<id>`), whether the run KV is non-empty, the `owed` pending record (`some stage`
  is the active flag), and whether that record carries an open provider request
  (`inferenceId`).
- **`Memory`** is what the live instance holds and a crash loses. It has the loop phase
  (`idle | ready | streaming | tools | settling`), the unfinished streamed block, running and
  finished executions, aborted executions still unwinding whose call KV handle is still live,
  the turn request, the abort flag, whether an abort dropped a turn since the run began
  (`#abortDroppedTurn`), the input an abort or failure dropped (`#abandonedQueueKeys`), whether
  the last settlement reopened the record (`#reopenedBySettlement`), whether the batch was restored (`resume`), whether the one-time
  recovery check ran, and the inherited `owed` record.
- **`Ghost`** records what the world observed. It holds accepted deliveries, identities released
  by history replacement, every call ID issued, every tool execution started (an external side
  effect), whether a listener is showing an unfinished block, and the messages that were queued
  when an abort or a failed turn dropped their turn. Transitions only extend it. It exists to state theorems.

Each transition that writes the store is one committed transaction, or one root statement, of
the real code, applied atomically. `Tx.lean` proves that this is exactly how a transaction
appears on disk, so a crash can only fall between model transitions. A crash (`crashEff`)
keeps `Durable` and `Ghost` and replaces `Memory` with what `AgentBase.load` reads: the `owed`
record only.

| Transition         | Code (`sources/AgentBase.ts` unless noted)                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enqueue`          | `#offer` → `#enqueueIndependently` + `#claimPendingWork` (identity key, queue entry, `owed` → inference, one tx)                                                            |
| `enqueueDup`       | the same with an existing identity: ignored uniqueness conflict, `accepted: "existing"`                                                                                     |
| `start`            | `start` / `#startRun` → `#runLoops`' first `#enterStage("inference")`; only for a requested turn, a reopened record, or a restored instance                                 |
| `recover`          | the restart's one-time interruption check (`#resetInterruptedResponse` at run start, then `#resumesInterruptedRun` at the first loaded edge) + resume of the `tool.*` batch |
| `consume`          | `#consumeQueue` (queue delete, user record, input-tool call, `owed`, optional model/profile reset; one tx)                                                                  |
| `beginInference`   | `#requestInference` (`#enterStage("inference")` with an `inferenceId`, provider stream opens)                                                                               |
| `showPartial`      | `#collect` emitting `*_start` / deltas before the block ends                                                                                                                |
| `completeBlock`    | `#collect`'s `persist` on `text_end` / `reasoning_end` / `toolcall_end`                                                                                                     |
| `finish`           | `done` event; the following stage write retires the `inferenceId`                                                                                                           |
| `truncate`         | stream exhausted without `done` (finished blocks kept, `block_reset`, turn requested for queued input)                                                                      |
| `cancel`           | abort reaching `#collect` (`done: cancelled`, finished blocks kept)                                                                                                         |
| `dispatch`         | `#dispatchToolBatch(resume = false)` (batch + `owed` → tools, one tx)                                                                                                       |
| `settleUnanswered` | `#settleUnansweredCalls` (staged error results; its second tx is `commitResult`)                                                                                            |
| `execStart`        | `#executeToolCall` starting an execution                                                                                                                                    |
| `refuse`           | resumed call whose tool is neither `durable` nor `reloadable` (`#isRetryable`)                                                                                              |
| `toolReturn`       | execution returned or threw                                                                                                                                                 |
| `toolCommit`       | `call.commit(ctx, result)` (stored result + call KV cleared, one tx)                                                                                                        |
| `abortEntry`       | batch race resolved by the abort promise (aborted error result; the execution may still be unwinding)                                                                       |
| `zombieExit`       | an abandoned execution finally returns                                                                                                                                      |
| `toolWrite`        | a tool writing its call-bound KV                                                                                                                                            |
| `toolRunWrite`     | a tool writing the run KV through its call context (handle bounded by the call lifetime)                                                                                    |
| `commitResult`     | `commitReady` (ordered result append, entry, claim, call KV erased, handle revoked; `owed` → inference at end)                                                              |
| `runWrite`         | hooks writing the run KV                                                                                                                                                    |
| `abort`            | `abort` → `#signalAbort` (allowed in any phase; see Abstractions)                                                                                                           |
| `newTurn`          | `#runTurn` returns `"continue"` after an aborted turn because input arrived; a fresh abort scope opens                                                                      |
| `beginTurn`        | `#runTurn` starts: claims the turn request and forgets the dropped input, unless its abort scope is already aborted                                                         |
| `failTurn`         | a failed turn or run: the request is answered and the queued input abandoned (`#abandonQueuedInput`)                                                                        |
| `decideSettle`     | `#runLoops` returns `"settling"` (in memory only; aborted, or every queued message dropped)                                                                                 |
| `recordSettlement` | `#enterSettlementStage` (settlement stage, unless input not dropped by an abort is queued; one tx)                                                                          |
| `settleAbandoned`  | `#startRun`'s `finally` → `#runTurns` with `#settleAfterAbort`: records the settlement stage again                                                                          |
| `settle`           | `#settleRecord` (clears `owed`, or reopens it when late work rewrote the stage and remembers that; hooks; `#clearRunStore`; one tx)                                         |
| `enterCompaction`  | `#compactHistoryAttempt`'s `#enterStage("compaction")`, only after the restart's interruption check                                                                         |
| `compact`          | `#compactHistoryAttempt` completed (records and identities erased, replacement written, one tx)                                                                             |
| `crash`            | process death; the next instance runs `AgentBase.load`                                                                                                                      |

## Theorems

### Transactions (`Tx.lean`, generic)

- `Tx.inv_reachable`: while a transaction is open, the disk still equals its pre-transaction
  state. The in-memory pending cache follows the working copy and returns to the disk on
  rollback (`#recordTransaction`). Post-commit callbacks ran exactly for committed transactions.
- `Tx.atomic` / `Tx.crash_mid_transaction`: any step from a state with an open transaction
  leaves the disk either before or after the whole transaction. A crash or rollback
  mid-transaction leaves it before.
- `Tx.commit_complete`: a commit installs all statements in order.
- `Tx.no_publish_without_commit`: rollback and crash never run `afterCommit` work.
- `Tx.nest_composes`: `inTx` inside an open transaction composes into the same transaction.

### Single owner (`Lock.lean`)

- `Lock.single_owner`: two processes never both own one store, including across kills.
- `Lock.writer_is_lock_holder`: every store write comes from the current lock holder.

### Identities and tools (`Safe.lean`)

- `safe_reachable`: **global inductive invariant** (13 clauses) over all finite traces.
- `no_duplicate_messages`: no identity is queued twice, recorded twice, or both.
- `accepted_never_lost`: every delivery answered `"created"` is queued, is in the
  conversation, or was erased deliberately by compaction or reset. Crashes never lose one.
- `redelivery_is_ignored`: a repeated identity of a live message hits its identity key, so the
  only step it can take is the no-op `enqueueDup`.
- `non_retryable_executes_at_most_once`: a call whose tool is neither `durable` nor
  `reloadable` is executed at most once in the whole history of the store. So it never
  re-executes after a crash.
- `unfinished_block_not_persisted`: the block being streamed is never in the store. History
  holds only completed blocks.
- `active_while_running`: while a run loop exists, the store says the agent is active.
- `crash_keeps_store`, `restart_consistent`: a crash keeps everything durable. The restored
  instance reads exactly the stored `owed` record, and the invariant still holds.

### The active flag, tool state, and block reset (`Correct.lean`)

- `inv_reachable`: second inductive invariant (23 clauses).
- `settled_means_no_work`: **the active flag covers all work**. Without an `owed` record there
  is no batch, no unanswered call, no call-scoped state, and no run state, and every message
  still queued was queued when an abort dropped the turn it had asked for. Keeping those is the
  documented abort behaviour: the queued message waits for the next turn, and a restart does
  not run it on its own.
- `settled_without_abort_has_empty_queue`: without an abort, a settled store has nothing
  queued.
- `unrecovered_keeps_interruption_record`: until a restarted instance has made its one-time
  interruption check, no transition replaces an inherited inference stage or retires its open
  request, so a crash anywhere before the check leaves the next instance the record that decides
  the `block_reset`.
- `owed_work_is_scheduled`: **a live owner never strands owed work**. Whenever the store says
  the agent is working and the instance that took it up has no run in flight, a step that starts
  a run is enabled. `start` is enabled only where the code starts one (a requested turn, a
  record the settlement reopened, or an owner starting a restored instance), and the invariant
  clause `idleWorkScheduled` says one of those reasons, or an abort-dropped turn for the
  settle-only run, always holds. Drain is not modelled; under drain the store stays active for
  the next owner by design.
- `call_state_only_for_pending_calls`: call-scoped tool state exists only for calls still in the
  durable batch. Pending tool state never survives a finished turn.
- `results_answer_calls_once`: every tool result answers a call in the conversation, and no
  call is answered twice.
- `no_dangling_block_after_restart`: once a restarted instance has recovered, no listener is
  left showing an unfinished block. The `block_reset` guarantee holds.

### Liveness (`Liveness.lean`)

- `abort_reaches_idle`: from **any** reachable state, `abort` followed only by quiet steps
  reaches a state with no run loop. Quiet steps start no inference, execute no tool (`execs` is
  unchanged), and accept or consume no input.
- `restart_can_settle`: after a crash in **any** reachable state with no queued input, the
  restored agent can resume its batch (re-running only retryable calls), answer any call left
  unanswered, and settle with no `owed` record.

These are possibility ("can reach") results over the model's nondeterminism. They do not rule
out a provider or tool that never returns.

### Findings (`Findings.lean`)

For each finding below, a general theorem rules it out and the trace that used to reach the bad
state is replayed on the fixed model with `decide`: `r1_no_stranded_message` / `r1_replayed` / `w1_replayed`, `a2_replayed`,
`r3_replayed`, `abandoned_work_settles` / `b2_replayed`, `r2_no_orphan_result` /
`r2_replayed`, `truncation_keeps_queued_input_requested`, `r4_replayed`,
`no_tool_starts_after_abort`, `r5_handle_dies_with_its_call` / `r5_replayed`, and
`owed_work_is_scheduled` / `aborted_turn_keeps_request` / `r6_replayed` / `f1_replayed`, and
`unrecovered_keeps_inference_stage` / `c1_replayed` / `c2_replayed`.

## Findings

Each finding was found while building this model or the TLA+ model in `../tla/`, reproduced
against the real `AgentBase`, and then fixed. The regression tests are in
`tests/AgentBaseLifecycleEdges.test.ts`. Line numbers refer to `sources/AgentBase.ts` after the
fixes.

### R1 (TLA+ 1): a message accepted while the run settles

`#runTurns` decides to settle from memory, records the settlement stage, and then settles. A
`send` can commit in either gap. After the stage write it rewrote the stage to `inference`, but
`#settleRecord` deleted `owed` unconditionally. Before the stage write, the stage write
overwrote the send's `inference` back to `settlement`. Either way a crash before the
`#startRun` `finally` restarted the loop, or a graceful drain that suppressed the restart, left
the message queued in a store that looked settled, and `AgentSystemLocal` restores only active
agents.

**Fix.** The settlement stage is written by `#enterSettlementStage` (line 2274). In one
transaction it reads the queues and leaves the record alone when an entry is queued that no
abort or run failure dropped (`#abandonQueuedInput`, line 2262; the dropped keys are
remembered from `#signalAbort` and the failure paths, and forgotten when a turn starts that is
not already aborted, line 2179; a turn whose scope an abort in the loop hooks already ended
keeps them, so that abort still settles over its input). The
settlement transaction then reads `owed` (line 2321). If it no longer holds the settlement
stage, the same transaction still settles the finished run but writes a fresh inference stage
and announces the activation (line 2332). In process, the `#startRun` `finally` starts another
run for the reopened record (line 1994); under drain, which never starts another run in this process, the store stays active so
the next owner resumes it. Input an abort dropped still settles, so 2a is unchanged. Model:
`decideSettle`, `recordSettlement`, `settleEff`, `Memory.dropped`.

This is a check of the owner's own record, not a defence against another owner, so it does not
reintroduce the compare-and-delete that master plan 20 asks to remove.

### R3 / TLA+ 2: abort and queued input

An abort cancels the requested turn; accepted messages stay queued until the next turn, in
memory and after a restart. This is the documented behaviour and was kept deliberately (2a).

**Fix (2b).** An abort that landed after the settlement commit but before the `#startRun`
`finally`, while a message accepted in that window had made the store active again, left the
store active with nothing running. `#signalAbort` now records that it dropped a turn (line
1856); the `finally` then starts a run that only settles (line 1981, `#runTurns` at line 2019),
recording the settlement stage through `#enterSettlementStage` so a message accepted meanwhile
still keeps the store owed. Model: `abortEff`, `settleAbandoned`.

### Round 4: owed work stranded by a live owner

A message sent after an abort but before the aborted turn began lost its request: `#runTurn`
cleared `#turnRequested` on the way in, the aborted turn answered nothing, and the run settled
onto the record the send had rewritten. The settlement reopened it as inference, and nothing in
the process ran it. The same could happen whenever the settlement reopened the record and no
request survived. A turn that failed (for example a failing `messageAcceptedTransact`) left the
store reopened the same way, and once every reopen started a run it retried the same failure
without end.

**Fix.** A turn whose abort scope is already aborted claims no request (line 2179), so the
send's request starts the next turn. `#settleRecord` remembers that it reopened the record
(line 2351), and the `#startRun` `finally` starts another run for it unless the agent is
draining or closed, after the turn-request and settle-after-abort branches (line 1994). A
failed turn abandons its queued input as a failed run does (line 2866), so its settlement
records the settlement stage and reopens nothing; the message stays queued as after an abort.
Model: `beginTurnEff`, `failTurn`, `Memory.reopened`, the `start` guard, and the invariant
clauses `idleRecoveredClean` and `idleWorkScheduled`; `owed_work_is_scheduled` states the
property.

### R2 / TLA+ 6: a stream that ends without `done`

`#collect` returned the unfinished content on EOF, so an unfinished tool call reached
`#messages` and `#settleUnansweredCalls` committed a result for a call the store never
recorded. Separately, the turn ended without raising a turn request, so messages already in
memory were stranded until something else started the agent.

**Fix.** On EOF `#collect` keeps only the persisted blocks and emits `block_reset` for an
unfinished one (line 5230). `#requestInference` raises the turn request when input is still
queued (line 3014). Model: `truncateEff`.

### R4 / TLA+ 3: no `block_reset` after a crash that follows a finished block

`#resumesInterruptedRun` reset and continued only when the last record was `user`, `tool`, or
`system`. A response that had persisted one block before the crash left a `block` last, so the
listener kept the half-shown block and the response was never continued.

**Fix.** A block or compaction last counts as interrupted while the inherited stage still
carries the response's `inferenceId` (line 3065). For that to mean "the request was still
open", the transaction after a response now always retires the identity together with the
token measurement (`#recordContextTokens`, line 3146); before, it stayed on the record whenever
no `afterInferenceTransact` hook was installed. Model: `recoverEff`, `finishEff`,
`Durable.requestOpen`.

### TLA+ 7: a stage recorded over an interrupted response

The restart's `block_reset` is owed only while the inherited record is the inference stage with
the response's open request. A restarted instance wrote stages of its own before its one-time
interruption check: the compaction stage of a requested compaction, and the tools stage of a
batch it resumed or dispatched. If that process died there, the next restart still owed the
response but emitted no `block_reset`, and the listener kept the half-shown block from the
first crash.

**Fix.** One guard, `#resetInterruptedResponse` (line 3104), runs at the start of every run
until it has decided (line 2027), before the settle-only branch, the loop's first stage record,
the batch, the compaction, and the settlement. It decides from the inherited record alone: an
inference stage carrying an open request gets the reset. An inference stage without an open
request never streamed anything; the first loaded edge still resets it when the conversation
owes a response, as before (line 3065). The owed response is now also decided before a
requested compaction (line 2651), so the compaction continues it. Model: every transition that
writes a stage other than inference, or retires an open request, needs `recovered`;
`unrecovered_keeps_interruption_record` in `Correct.lean` proves that over every transition.
`c1_replayed` (compaction) and `c2_replayed` (tool batch) replay both paths.

### TLA+ 4: an abort just before tool dispatch still started the tools

**Fix.** The batch answers a call as aborted without starting it once the turn is aborted or
the agent is closing (line 4308), and `#executeToolCall` refuses to start one whose lifetime
ended during its `beforeToolCall` hook (line 4761). The model always required
`aborted = false` for `execStart`; `no_tool_starts_after_abort` states it.

### R5 / TLA+ 5: an aborted tool could recreate call or run state after its result erased it

The batch committed the aborted result and cleared the call KV, but the call's handles stayed
usable until `#executeToolCall` returned; the run KV handle on the call context was not bounded
at all. A tool writing through a context of its own recreated `kv.<agent>.call.<id>.*`, or run
state, after settlement.

**Fix.** Each execution registers its call lifetime (line 4602), and the batch aborts it right
after committing the call's result (line 4275). The call context's run KV handle is bounded by
the same lifetime (line 4618). Both handles die before the settlement that clears run state.
Model: `commitResultEff` removes the call from `zombies`; `toolWrite` and `toolRunWrite` need a
running or unwinding call.

### Master plan 08: swallowed persistence errors (not fixed)

Master plan 08 says any database failure terminates the system. `AgentBase` still continues
after some persistence failures: `#enterStage` without a hook (line 1028),
`#enterSettlementStage` (line 2286, which keeps the behaviour of the stage write it replaced),
`#settleRecord` (line 2354), `#recordContextTokens` (line 3170), and `#appendFailure` (line
3526). Existing
tests (`AgentSettlementFailure.test.ts`, "settles with the failure even when the conversation
could not record it") specify that behaviour. Making these failures fatal needs a way to tell
a database failure from a hook or provider failure, and a termination path owned by the agent
system, which is a design decision beyond `AgentBase`. The model treats a database failure only
as a crash.

### Other notes

- `#claimPendingWork` overwrites the stage to `inference` while a tool batch is running. The
  model includes this. The proofs show it is harmless, because recovery reads `tool.*`
  entries, not the stage.

## Abstractions and what is not verified

- Identities are natural numbers. Message content, settings, providers, model compatibility,
  metadata, permission modes, profiles, and compaction summaries are not modelled. A
  model/profile reset appears only as `consume … reset := true` (history and identities
  erased atomically).
- Module hooks are folded into the transaction of the transition that calls them. Their own
  writes, and failing `…Transact` hooks, are covered only by `Tx.lean`'s generic rollback
  result.
- Not modelled: system-notice injection, `#enqueueInTransaction` (outer-transaction delivery;
  its durable effect equals `enqueue`), `retryForever`, drain/close/graceful shutdown (the R1
  drain case is covered only by its regression test), steerable and reloadable interruption,
  provider server tools and block-reset replay within a stream, multiple agents per system, the
  active-agent index, and module migrations.
- `abort` may fire in any phase, including `idle`. The code's abort is a no-op on an agent with
  no run; allowing it everywhere over-approximates and covers the window between the settlement
  commit and `#startRun`'s `finally`, which the model's `settle` otherwise merges.
- The restart reset condition is modelled as "the inherited inference stage owes an answer or
  carries an open request". The code additionally requires the last record to be a block or
  compaction in the second case; in the code an open request always follows one of those or a
  record that owes an answer, so the conditions agree.
- Failures are modelled only as `failTurn`, which answers the turn and abandons the queued
  input. Where a failure happens inside the turn, and `retryForever`, are not modelled.
- `#startRun`'s `finally` is modelled by the guards of `start` and `settleAbandoned` and by the
  obligation `idleWorkScheduled`: some reason to start a run always holds while work is owed.
  That a reason leads to the step being taken is the code's `finally`, checked by the regression
  tests; the model's liveness results stay existential.
- Compaction is assumed to run only at a settled boundary (empty batch, no unanswered calls),
  which is what `#runInferenceAttempt` arranges.
- The provider and tools are unconstrained nondeterminism. The liveness results are
  existential.
- The correspondence between each transition and the TypeScript was established by reading
  the code, and was spot-checked by the regression tests. It was not mechanically
  derived.

## Regression tests

The runtime reproductions used while the findings were open were replaced by regression tests
in the package suite: `tests/AgentBaseLifecycleEdges.test.ts`.
