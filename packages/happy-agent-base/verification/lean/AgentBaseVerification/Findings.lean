import AgentBaseVerification.Correct
import AgentBaseVerification.Liveness

set_option linter.unusedSimpArgs false

/-!
# The findings, ruled out

Building this model against the code found the discrepancies listed in the README. The code
was then fixed and the model updated to match. For each finding this file states the general
property that now rules it out, and replays the trace that used to reach the bad state to show
where it ends instead.

Tool calls in the traces are non-retryable (`P₀`), which does not matter for any of them.
-/

namespace AgentBaseVerification.Findings

open AgentBaseVerification

def P₀ : Params := ⟨fun _ => false⟩

/-- Shared prefix: message `1` is sent, the loop starts, consumes it, and opens an inference. -/
def s1 : State := enqueueEff init false 1
def s2 : State := startEff s1
def s3 : State := consumeEff s2 1 [] [] false none
def s4 : State := beginInferenceEff s3

theorem reach_s4 : Reachable P₀ s4 := by
  have r1 : Reachable P₀ s1 := .step .init (.enqueue false 1 (by decide))
  have r2 : Reachable P₀ s2 := .step r1 (.start (by decide) (by decide))
  have r3 : Reachable P₀ s3 :=
    .step r2 (.consume 1 [] [] false none (by decide) (by decide) (by decide) (by decide)
      (by decide) (by decide) (by intro c h; cases h))
  exact .step r3 (.beginInference (by decide) (by decide) (by decide) (by decide) (by decide))

/-! ## R1 — a message accepted while the run settles

The run decides to settle in memory, records the settlement stage, and then settles. A `send`
can commit in either gap. Before the stage is recorded, the stage write sees input not dropped
by an abort and leaves the send's inference stage in place; after it, the send rewrites the
stage. Either way the settlement transaction finds the record rewritten and reopens it, so a
crash right after it leaves an active store the owner restores. -/

/-- **R1, general.** Every message queued in a settled store was queued when an abort dropped
the turn it asked for; without an abort, a settled store has nothing queued. -/
theorem r1_no_stranded_message {P : Params} {s : State} (h : Reachable P s)
    (hp : s.d.pending = none) : ∀ x ∈ queued s.d, x ∈ s.g.abandoned :=
  (settled_means_no_work h hp).1

def r1_5 : State := finishEff s4
def r1_6 : State := decideSettleEff r1_5
def r1_7 : State := recordSettlementEff r1_6
def r1_8 : State := enqueueEff r1_7 false 2
def r1_9 : State := settleEff r1_8
def r1_10 : State := crashEff r1_9

theorem r1_reachable : Reachable P₀ r1_10 := by
  have r5 : Reachable P₀ r1_5 := .step reach_s4 (.finish (by decide))
  have r6 : Reachable P₀ r1_6 :=
    .step r5 (.decideSettle (by decide) (by decide) (by decide) (by decide) (by decide)
      (Or.inr (by decide)))
  have r7 : Reachable P₀ r1_7 := .step r6 (.recordSettlement (by decide) (by decide))
  have r8 : Reachable P₀ r1_8 := .step r7 (.enqueue false 2 (by decide))
  have r9 : Reachable P₀ r1_9 := .step r8 (.settle (by decide) (by decide))
  exact .step r9 .crash

/-- **R1, replayed.** A send after the settlement stage was recorded: the restarted store is
active, inheriting the inference stage that answers message `2`. -/
theorem r1_replayed : r1_10.d.pending = some .inference ∧ r1_10.d.send = [2] ∧
    r1_10.m.inherited = some .inference := by decide

def w1_7 : State := enqueueEff r1_6 false 2
def w1_8 : State := recordSettlementEff w1_7
def w1_9 : State := settleEff w1_8
def w1_10 : State := crashEff w1_9

theorem w1_reachable : Reachable P₀ w1_10 := by
  have r6 : Reachable P₀ r1_6 :=
    .step (.step reach_s4 (.finish (by decide)))
      (.decideSettle (by decide) (by decide) (by decide) (by decide) (by decide)
        (Or.inr (by decide)))
  have r7 : Reachable P₀ w1_7 := .step r6 (.enqueue false 2 (by decide))
  have r8 : Reachable P₀ w1_8 := .step r7 (.recordSettlement (by decide) (by decide))
  have r9 : Reachable P₀ w1_9 := .step r8 (.settle (by decide) (by decide))
  exact .step r9 .crash

/-- **R1 in the decision window, replayed.** A send after the decision but before the stage is
recorded: the stage write leaves the send's inference stage in place, and the restarted store is
again active. -/
theorem w1_replayed : w1_8.d.pending = some .inference ∧ w1_10.d.pending = some .inference ∧
    w1_10.d.send = [2] := by decide

/-! ## R3 / TLA+ 2a — an abort leaves accepted messages queued

This is the documented behaviour, kept deliberately: the abort cancels the requested turn and
the queued message waits for the next one, also across a restart. What the abort must not leave
behind is tool or run state; `settled_means_no_work` covers that. -/

def r3_5 : State := enqueueEff s4 false 2
def r3_6 : State := abortEff r3_5
def r3_7 : State := cancelEff r3_6
def r3_8 : State := decideSettleEff r3_7
def r3_85 : State := recordSettlementEff r3_8
def r3_9 : State := settleEff r3_85

theorem r3_reachable : Reachable P₀ r3_9 := by
  have r5 : Reachable P₀ r3_5 := .step reach_s4 (.enqueue false 2 (by decide))
  have r6 : Reachable P₀ r3_6 := .step r5 .abort
  have r7 : Reachable P₀ r3_7 := .step r6 (.cancel (by decide) (by decide))
  have r8 : Reachable P₀ r3_8 :=
    .step r7 (.decideSettle (by decide) (by decide) (by decide) (by decide) (by decide)
      (Or.inl (by decide)))
  have r85 : Reachable P₀ r3_85 := .step r8 (.recordSettlement (by decide) (by decide))
  exact .step r85 (.settle (by decide) (by decide))

theorem r3_replayed : r3_9.d.pending = none ∧ r3_9.d.send = [2] ∧ r3_9.g.abandoned = [2] ∧
    r3_9.d.batch = [] ∧ r3_9.d.callKV = [] ∧ r3_9.d.runKV = false := by decide

/-- An abort that lands while the run is starting, before its first turn begins. The turn
starts already aborted, so it keeps the dropped input, answers nothing, and the run settles over
the queued message exactly as after any abort. -/
def a2_1 : State := enqueueEff init false 1
def a2_2 : State := startEff a2_1
def a2_3 : State := abortEff a2_2
def a2_4 : State := beginTurnEff a2_3
def a2_5 : State := decideSettleEff a2_4
def a2_6 : State := recordSettlementEff a2_5
def a2_7 : State := settleEff a2_6

theorem a2_reachable : Reachable P₀ a2_7 := by
  have r1 : Reachable P₀ a2_1 := .step .init (.enqueue false 1 (by decide))
  have r2 : Reachable P₀ a2_2 := .step r1 (.start (by decide) (by decide))
  have r3 : Reachable P₀ a2_3 := .step r2 .abort
  have r4 : Reachable P₀ a2_4 := .step r3 (.beginTurn (by decide))
  have r5 : Reachable P₀ a2_5 :=
    .step r4 (.decideSettle (by decide) (by decide) (by decide) (by decide) (by decide)
      (Or.inl (by decide)))
  have r6 : Reachable P₀ a2_6 := .step r5 (.recordSettlement (by decide) (by decide))
  exact .step r6 (.settle (by decide) (by decide))

theorem a2_replayed : a2_7.d.pending = none ∧ a2_7.d.send = [1] ∧ a2_7.g.execs = [] ∧
    a2_7.m.phase = .idle := by decide

/-! ## TLA+ 2b — an abort between the settlement commit and the run's `finally`

A message accepted after the settlement committed records work again; an abort then drops the
turn it asked for. The unwinding run settles that record once more instead of leaving the
store active with nothing running. -/

/-- **TLA+ 2b, general.** From an idle agent whose store an abort left owing work it will not
run, the settle-only run reaches a settled store without starting anything and without
touching the queue. -/
theorem abandoned_work_settles {P : Params} {s : State} (h : Reachable P s)
    (hph : s.m.phase = .idle) (hr : s.m.recovered = true) (hd : s.m.abortDropped = true)
    (htr : s.m.turnRequested = false) (hp : s.d.pending ≠ none) (hb : s.d.batch = [])
    (hu : unanswered s.d.history = []) :
    ∃ t, Star (Quiet P) s t ∧ t.m.phase = .idle ∧ t.d.pending = none ∧
      queued t.d = queued s.d := by
  have hdq := (inv_reachable h).droppedQueued hd htr hph
  let s1 := settleAbandonedEff s
  let s2 := recordSettlementEff s1
  have st1 : Step P s s1 := .settleAbandoned hph hr hd htr hp hb hu
  have st2 : Step P s1 s2 :=
    .recordSettlement (by simp [s1, settleAbandonedEff]) (by simp [s1, settleAbandonedEff])
  have st3 : Step P s2 (settleEff s2) :=
    .settle (by simp [s2, s1, recordSettlementEff, settleAbandonedEff])
      (by simp [s2, recordSettlementEff])
  have hall : ∀ x ∈ queued s1.d, x ∈ s1.m.dropped := by
    simpa [s1, settleAbandonedEff] using hdq
  exact ⟨_, .head ⟨st1, rfl, rfl, by simp [s1, settleAbandonedEff]⟩
    (.head ⟨st2, rfl, rfl, by simp [s2, s1, recordSettlementEff, settleAbandonedEff]⟩
      (Star.single ⟨st3, rfl, rfl, by simp [settleEff]⟩)),
    by simp [settleEff],
    by simp [settleEff, s2, recordSettlementEff]; exact fun x hx hn => absurd (hall x hx) hn,
    rfl⟩

def b2_5 : State := finishEff s4
def b2_6 : State := recordSettlementEff (decideSettleEff b2_5)
def b2_7 : State := settleEff b2_6
def b2_8 : State := enqueueEff b2_7 false 2
def b2_9 : State := abortEff b2_8

theorem b2_reachable : Reachable P₀ b2_9 := by
  have r5 : Reachable P₀ b2_5 := .step reach_s4 (.finish (by decide))
  have r6 : Reachable P₀ b2_6 :=
    .step (.step r5 (.decideSettle (by decide) (by decide) (by decide) (by decide) (by decide)
      (Or.inr (by decide)))) (.recordSettlement (by decide) (by decide))
  have r7 : Reachable P₀ b2_7 := .step r6 (.settle (by decide) (by decide))
  have r8 : Reachable P₀ b2_8 := .step r7 (.enqueue false 2 (by decide))
  exact .step r8 .abort

/-- **TLA+ 2b, replayed.** Message `2` arrived after the settlement committed and an abort then
dropped its turn: the store settles again with the message still queued. -/
theorem b2_replayed :
    ∃ t, Star (Quiet P₀) b2_9 t ∧ t.m.phase = .idle ∧ t.d.pending = none ∧
      queued t.d = [2] := by
  obtain ⟨t, ht, hph, hp, hq⟩ := abandoned_work_settles b2_reachable (by decide) (by decide)
    (by decide) (by decide) (by decide) (by decide) (by decide)
  exact ⟨t, ht, hph, hp, by rw [hq]; decide⟩

/-! ## R2 / TLA+ 6 — a stream that ends without `done`

Only finished blocks are kept, so no result is ever written for a call the store never
recorded; and input still queued raises the turn request, so the run cannot decide to settle
over it (`decideSettle` requires no turn request, and an unaborted settle decision requires an
empty queue). -/

/-- **R2, general.** Every tool result in the conversation answers a call in the conversation. -/
theorem r2_no_orphan_result {P : Params} {s : State} (h : Reachable P s) :
    ∀ c ∈ results s.d.history, c ∈ calls s.d.history :=
  (results_answer_calls_once h).1

def r2_5 : State := showPartialEff s4 (.call 7)
def r2_6 : State := truncateEff r2_5

theorem r2_reachable : Reachable P₀ r2_6 := by
  have r5 : Reachable P₀ r2_5 :=
    .step reach_s4 (.showPartial (.call 7) (by decide) (by decide) (by intro c h; cases h; decide))
  exact .step r5 (.truncate (by decide))

/-- **R2, replayed.** After the truncated stream nothing is owed, so no result is ever written
for call `7`, and the listener was told to drop the unfinished block. -/
theorem r2_replayed : unanswered r2_6.d.history = [] ∧ 7 ∉ calls r2_6.d.history ∧
    r2_6.g.uiOpen = false := by decide

/-- **TLA+ 6.** A truncated stream with input still queued leaves a turn requested. -/
theorem truncation_keeps_queued_input_requested (s : State) (hq : queued s.d ≠ []) :
    (truncateEff s).m.turnRequested = true := by
  cases h : queued s.d with
  | nil => exact absurd h hq
  | cons x xs => simp [truncateEff, h]

/-! ## R4 / TLA+ 3 — block reset after a crash that follows a finished block

The restarted instance resets and continues a response whose provider request was still open,
whatever the last record is. -/

def r4_5 : State := showPartialEff s4 .text
def r4_6 : State := completeBlockEff r4_5 .text
def r4_7 : State := showPartialEff r4_6 .text
def r4_8 : State := crashEff r4_7
def r4_9 : State := startEff r4_8
def r4_10 : State := recoverEff r4_9

theorem r4_reachable : Reachable P₀ r4_10 := by
  have r5 : Reachable P₀ r4_5 :=
    .step reach_s4 (.showPartial .text (by decide) (by decide) (by intro c h; cases h))
  have r6 : Reachable P₀ r4_6 := .step r5 (.completeBlock .text (by decide) (by decide))
  have r7 : Reachable P₀ r4_7 :=
    .step r6 (.showPartial .text (by decide) (by decide) (by intro c h; cases h))
  have r8 : Reachable P₀ r4_8 := .step r7 .crash
  have r9 : Reachable P₀ r4_9 := .step r8 (.start (by decide) (by decide))
  exact .step r9 (.recover (by decide) (by decide))

theorem r4_replayed : r4_10.m.recovered = true ∧ r4_10.g.uiOpen = false := by decide

/-! ## TLA+ 4 — no tool starts once its turn is aborted -/

/-- **TLA+ 4.** No step taken while the turn is aborted starts a tool execution. -/
theorem no_tool_starts_after_abort {P : Params} {s t : State} (st : Step P s t)
    (ha : s.m.aborted = true) : t.g.execs = s.g.execs := by
  cases st with
  | execStart _ _ hab => rw [ha] at hab; cases hab
  | _ => simp_all [enqueueEff, startEff, recoverEff, consumeEff, beginInferenceEff,
      showPartialEff, completeBlockEff, finishEff, truncateEff, cancelEff, dispatchEff,
      settleUnansweredEff, refuseEff, returnEff, toolCommitEff, abortEntryEff, zombieExitEff,
      toolWriteEff, commitResultEff, runWriteEff, abortEff, newTurnEff, beginTurnEff, failTurnEff, decideSettleEff,
      recordSettlementEff, settleAbandonedEff, toolRunWriteEff, settleEff, compactEff, enterCompactionEff, crashEff]

/-! ## R5 / TLA+ 5 — an abandoned execution's call and run state

The call-state and run-state handles of an execution still unwinding after an abort die when
its result commits, so it can only write while the call is still in the durable batch — and
the commit that removes the call from the batch erases its call state, while the settlement,
which follows every commit, erases the run state. -/

/-- **R5, general.** An unwinding execution only has a live handle while its call is pending. -/
theorem r5_handle_dies_with_its_call {P : Params} {s : State} (h : Reachable P s) :
    ∀ c ∈ s.m.zombies, c ∈ batchCalls s.d :=
  (inv_reachable h).zombiesBatch

def r5_5 : State := showPartialEff s4 (.call 7)
def r5_6 : State := completeBlockEff r5_5 (.call 7)
def r5_7 : State := finishEff r5_6
def r5_8 : State := dispatchEff r5_7
def r5_9 : State := execStartEff r5_8 7
def r5_10 : State := abortEff r5_9
def r5_11 : State := abortEntryEff r5_10 7
def r5_12 : State := commitResultEff r5_11 ⟨7, false⟩ []

theorem r5_reachable : Reachable P₀ r5_12 := by
  have r5 : Reachable P₀ r5_5 :=
    .step reach_s4 (.showPartial (.call 7) (by decide) (by decide) (by intro c h; cases h; decide))
  have r6 : Reachable P₀ r5_6 := .step r5 (.completeBlock (.call 7) (by decide) (by decide))
  have r7 : Reachable P₀ r5_7 := .step r6 (.finish (by decide))
  have r8 : Reachable P₀ r5_8 :=
    .step r7 (.dispatch (by decide) (by decide) (by decide) (by decide))
  have r9 : Reachable P₀ r5_9 :=
    .step r8 (.execStart 7 (by decide) (by decide) (by decide) (by decide) (by decide)
      (Or.inl (by decide)))
  have r10 : Reachable P₀ r5_10 := .step r9 .abort
  have r11 : Reachable P₀ r5_11 :=
    .step r10 (.abortEntry 7 (by decide) (by decide) (by decide) (by decide))
  exact .step r11 (.commitResult ⟨7, false⟩ [] (by decide) (by decide) (Or.inr (by decide)))

/-- **R5, replayed.** Once the aborted result commits, the execution still unwinding no longer
holds a handle, so the writes that used to recreate call or run state after settlement cannot
happen: `toolWrite 7` and `toolRunWrite 7` need call `7` running or unwinding with a live
handle. -/
theorem r5_replayed : r5_12.m.zombies = [] ∧ r5_12.m.running = [] ∧ r5_12.d.callKV = [] := by
  decide

/-! ## Round 4 — a live owner never strands owed work

A message sent after an abort, but before the aborted turn began, used to lose its request: the
turn cleared it on the way in, answered nothing, and the run settled onto a record the send had
rewritten — reopened as inference, with nothing in the process left to run it. A turn that fails
left the same thing behind. Now an aborted turn claims no request, a failed turn abandons its
queued input as an abort does, and `#startRun`'s `finally` starts another run for any record
the settlement reopened. `owed_work_is_scheduled` states the general property. -/

/-- **Round 4, general.** A turn that starts already aborted keeps whatever request stands. -/
theorem aborted_turn_keeps_request (s : State) (ha : s.m.aborted = true) :
    (beginTurnEff s).m.turnRequested = s.m.turnRequested := by
  simp [beginTurnEff, ha]

def r6_1 : State := enqueueEff init false 1
def r6_2 : State := startEff r6_1
def r6_3 : State := abortEff r6_2
def r6_4 : State := enqueueEff r6_3 false 2
def r6_5 : State := beginTurnEff r6_4
def r6_6 : State := newTurnEff r6_5
def r6_7 : State := consumeEff r6_6 1 [] [2] false none

theorem r6_reachable : Reachable P₀ r6_7 := by
  have r1 : Reachable P₀ r6_1 := .step .init (.enqueue false 1 (by decide))
  have r2 : Reachable P₀ r6_2 := .step r1 (.start (by decide) (by decide))
  have r3 : Reachable P₀ r6_3 := .step r2 .abort
  have r4 : Reachable P₀ r6_4 := .step r3 (.enqueue false 2 (by decide))
  have r5 : Reachable P₀ r6_5 := .step r4 (.beginTurn (by decide))
  have r6 : Reachable P₀ r6_6 := .step r5 (.newTurn (by decide) (by decide) (by decide))
  exact .step r6 (.consume 1 [] [2] false none (by decide) (by decide) (by decide) (by decide)
    (by decide) (by decide) (by intro c h; cases h))

/-- **Round 4, replayed.** Message `2` is sent after the abort and before the aborted turn
begins. The request it raised survives that turn, so the run opens a fresh one, which takes the
queue in order. -/
theorem r6_replayed : r6_5.m.turnRequested = true ∧ r6_7.d.history = [.user 1] ∧
    r6_7.d.send = [2] ∧ r6_7.m.turnRequested = true := by decide

def f1_1 : State := enqueueEff init false 1
def f1_2 : State := startEff f1_1
def f1_3 : State := beginTurnEff f1_2
def f1_4 : State := failTurnEff f1_3
def f1_5 : State := decideSettleEff f1_4
def f1_6 : State := recordSettlementEff f1_5
def f1_7 : State := settleEff f1_6

theorem f1_reachable : Reachable P₀ f1_7 := by
  have r1 : Reachable P₀ f1_1 := .step .init (.enqueue false 1 (by decide))
  have r2 : Reachable P₀ f1_2 := .step r1 (.start (by decide) (by decide))
  have r3 : Reachable P₀ f1_3 := .step r2 (.beginTurn (by decide))
  have r4 : Reachable P₀ f1_4 := .step r3 (.failTurn (by decide))
  have r5 : Reachable P₀ f1_5 :=
    .step r4 (.decideSettle (by decide) (by decide) (by decide) (by decide) (by decide)
      (Or.inr (by decide)))
  have r6 : Reachable P₀ f1_6 := .step r5 (.recordSettlement (by decide) (by decide))
  exact .step r6 (.settle (by decide) (by decide))

/-- **A failed turn, replayed.** The turn that could not take message `1` fails; the message
stays queued, the store settles, and the settlement reopens nothing, so no run retries the same
failure on its own. -/
theorem f1_replayed : f1_7.d.pending = none ∧ f1_7.d.send = [1] ∧ f1_7.m.reopened = false ∧
    f1_7.m.phase = .idle := by decide

/-! ## TLA+ 7 — a stage recorded over an interrupted response

A restarted instance used to write stages of its own before its one-time interruption check: a
requested compaction's stage, or the tools stage of the batch it resumed or dispatched. Either
replaced the inherited inference stage, so a process dying there left the next one owing the
response with nothing left to say its listener must drop the unfinished block. The check now
runs once at the start of the restarted run, before any stage write. In the model every
transition that writes a stage other than inference needs `recovered`. -/

/-- **TLA+ 7, general.** See `Correct.unrecovered_keeps_interruption_record`. -/
theorem unrecovered_keeps_inference_stage {P : Params} {s t : State} (h : Reachable P s)
    (st : Step P s t) (hr : s.m.recovered = false) (hp : s.d.pending = some .inference) :
    t.d.pending = some .inference ∨ t.m.recovered = true :=
  (unrecovered_keeps_interruption_record h st hr hp).imp_left And.left

def c1_5 : State := showPartialEff s4 .text
def c1_6 : State := crashEff c1_5
def c1_7 : State := startEff c1_6
def c1_8 : State := recoverEff c1_7
def c1_9 : State := enterCompactionEff c1_8
def c1_10 : State := crashEff c1_9

theorem c1_reachable : Reachable P₀ c1_10 := by
  have r5 : Reachable P₀ c1_5 :=
    .step reach_s4 (.showPartial .text (by decide) (by decide) (by intro c h; cases h))
  have r6 : Reachable P₀ c1_6 := .step r5 .crash
  have r7 : Reachable P₀ c1_7 := .step r6 (.start (by decide) (by decide))
  have r8 : Reachable P₀ c1_8 := .step r7 (.recover (by decide) (by decide))
  have r9 : Reachable P₀ c1_9 :=
    .step r8 (.enterCompaction (by decide) (by decide) (by decide) (by decide) (by decide))
  exact .step r9 .crash

/-- **TLA+ 7, replayed.** The first restart resets the block before its compaction records its
stage; when it dies during the compaction, the next process inherits the compaction stage and a
listener that is no longer showing anything unfinished. -/
theorem c1_replayed : c1_8.g.uiOpen = false ∧ c1_10.m.inherited = some .compaction ∧
    c1_10.g.uiOpen = false := by decide

def c2_5 : State := showPartialEff s4 (.call 7)
def c2_6 : State := completeBlockEff c2_5 (.call 7)
def c2_7 : State := showPartialEff c2_6 .text
def c2_8 : State := crashEff c2_7
def c2_9 : State := startEff c2_8
def c2_10 : State := recoverEff c2_9
def c2_11 : State := dispatchEff c2_10
def c2_12 : State := crashEff c2_11

theorem c2_reachable : Reachable P₀ c2_12 := by
  have r5 : Reachable P₀ c2_5 :=
    .step reach_s4 (.showPartial (.call 7) (by decide) (by decide) (by intro c h; cases h; decide))
  have r6 : Reachable P₀ c2_6 := .step r5 (.completeBlock (.call 7) (by decide) (by decide))
  have r7 : Reachable P₀ c2_7 :=
    .step r6 (.showPartial .text (by decide) (by decide) (by intro c h; cases h))
  have r8 : Reachable P₀ c2_8 := .step r7 .crash
  have r9 : Reachable P₀ c2_9 := .step r8 (.start (by decide) (by decide))
  have r10 : Reachable P₀ c2_10 := .step r9 (.recover (by decide) (by decide))
  have r11 : Reachable P₀ c2_11 :=
    .step r10 (.dispatch (by decide) (by decide) (by decide) (by decide))
  exact .step r11 .crash

/-- **TLA+ 7 through a tool batch, replayed.** The response died after its tool call, in its next
block. The restart resets that block before it dispatches the owed call; when it dies with the
tools stage recorded, the next process inherits that stage and nothing is left showing. -/
theorem c2_replayed : c2_10.g.uiOpen = false ∧ c2_12.m.inherited = some .tools ∧
    c2_12.g.uiOpen = false := by decide

end AgentBaseVerification.Findings
