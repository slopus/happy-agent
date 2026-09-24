import AgentBaseVerification.Safe

set_option linter.unusedSimpArgs false

/-!
# Abort and restart reach a settled state

Existential ("can") liveness:

* `abort_reaches_idle` — from *any* reachable state, `abort` followed only by
  quiet steps (steps that start no inference, execute no tool, and accept or consume no input)
  reaches a state with no run loop. So abort needs nothing more to happen in the world to stop
  the agent: a stream is cancelled, still-running tools get aborted error results, the
  conversation is left with every call answered, and the run settles.
* `restart_can_settle` — after a crash in *any* reachable state with no queued input, the
  restored agent can resume its durable batch (re-executing only retryable calls) and settle,
  erasing the `owed` record.

These are possibility results over the model's nondeterminism (the scheduler, the provider,
tools); they do not claim that an adversarial provider or a tool that never returns cannot
delay the run forever.
-/

namespace AgentBaseVerification

inductive Star {α : Type} (R : α → α → Prop) : α → α → Prop
  | refl (a : α) : Star R a a
  | head {a b c : α} : R a b → Star R b c → Star R a c

theorem Star.trans {α : Type} {R : α → α → Prop} {a b c : α}
    (h1 : Star R a b) (h2 : Star R b c) : Star R a c := by
  induction h1 with
  | refl => exact h2
  | head r _ ih => exact .head r (ih h2)

theorem Star.single {α : Type} {R : α → α → Prop} {a b : α} (h : R a b) : Star R a b :=
  .head h (.refl b)

/-- A step that starts no inference, runs no tool, and accepts or consumes no input. -/
def Quiet (P : Params) (s t : State) : Prop :=
  Step P s t ∧ t.g.execs = s.g.execs ∧ queued t.d = queued s.d ∧
    (t.m.phase = .streaming → s.m.phase = .streaming)

theorem Star.quiet_execs {P : Params} {s t : State} (h : Star (Quiet P) s t) :
    t.g.execs = s.g.execs := by
  induction h with
  | refl => rfl
  | head q _ ih => rw [ih, q.2.1]

theorem Star.quiet_reachable {P : Params} {s t : State} (h : Star (Quiet P) s t)
    (hs : Reachable P s) : Reachable P t := by
  induction h with
  | refl => exact hs
  | head q _ ih => exact ih (.step hs q.1)

theorem Star.steps_reachable {P : Params} {s t : State} (h : Star (Step P) s t)
    (hs : Reachable P s) : Reachable P t := by
  induction h with
  | refl => exact hs
  | head q _ ih => exact ih (.step hs q)

/-! ## Auxiliary invariant -/

structure Aux (s : State) : Prop where
  toolsRecovered : s.m.phase = .tools → s.m.recovered = true
  recoveredBatch : s.m.recovered = true → s.m.phase ≠ .tools → s.d.batch = []
  unansweredInBatch : s.d.batch ≠ [] → ∀ c ∈ unanswered s.d.history, c ∈ batchCalls s.d
  toolsBatch : s.m.phase = .tools → s.d.batch ≠ []
  streamingRecovered : s.m.phase = .streaming → s.m.recovered = true

section
variable {P : Params} {s t : State}

theorem aux_step (hs : Safe s) (ha : Aux s) (st : Step P s t) : Aux t := by
  obtain ⟨h1, h2, h3, h4, h5⟩ := ha
  refine ⟨?_, ?_, ?_, ?_, ?_⟩
  · cases st with
    | recover => intro _; rfl
    | dispatch _ hr => intro _; exact hr
    | settleUnanswered _ hr => intro _; exact hr
    | crash => intro hph; simp [crashEff, freshMemory] at hph
    | commitResult e rest hph => intro _; exact h1 hph
    | _ => first | exact h1 | (simp_all [enqueueEff, startEff, consumeEff, beginInferenceEff,
        showPartialEff, completeBlockEff, finishEff, truncateEff, cancelEff, execStartEff,
        refuseEff, returnEff, toolCommitEff, abortEntryEff, zombieExitEff, toolWriteEff,
        runWriteEff, abortEff, newTurnEff, beginTurnEff, failTurnEff, decideSettleEff, recordSettlementEff, settleAbandonedEff, toolRunWriteEff, settleEff, compactEff, enterCompactionEff])
  · cases st with
    | recover =>
      intro _ hph
      by_cases hb : s.d.batch = [] <;> simp [recoverEff, hb] at hph ⊢
    | commitResult e rest hph hb =>
      intro _ hph'
      by_cases hr : rest = [] <;> simp [commitResultEff, hr] at hph' ⊢
    | dispatch => intro _ hph; simp [dispatchEff] at hph
    | settleUnanswered => intro _ hph; simp [settleUnansweredEff] at hph
    | crash => intro hr; simp [crashEff, freshMemory] at hr
    | start hph => intro hr _; exact h2 hr (by rw [hph]; simp)
    | finish hph => intro _ _; exact hs.streamingBatch hph
    | truncate hph => intro _ _; exact hs.streamingBatch hph
    | cancel hph => intro _ _; exact hs.streamingBatch hph
    | beginInference _ _ _ hb => intro _ _; exact hb
    | consume _ _ _ _ _ _ _ _ hb => intro _ _; exact hb
    | compact _ _ _ hb => intro _ _; exact hb
    | toolCommit c hph => intro _ hph'; simp [toolCommitEff, hph] at hph'
    | _ => first | exact h2 | (simp_all [enqueueEff, showPartialEff, completeBlockEff,
        execStartEff, refuseEff, returnEff, abortEntryEff, zombieExitEff, toolWriteEff,
        runWriteEff, abortEff, newTurnEff, beginTurnEff, failTurnEff, decideSettleEff, recordSettlementEff, settleAbandonedEff, toolRunWriteEff, settleEff])
  · cases st with
    | dispatch => intro _ x hx; simpa [dispatchEff, batchCalls] using hx
    | settleUnanswered =>
      intro _ x hx; simpa [settleUnansweredEff, batchCalls] using hx
    | commitResult e rest _ hb _ =>
      intro hne x hx
      simp [commitResultEff, mem_unanswered_result] at hx
      have := h3 (by simp [hb]) x hx.1
      simp [batchCalls, hb] at this
      rcases this with h | h
      · exact absurd h hx.2
      · simp [commitResultEff, batchCalls]; exact h
    | completeBlock p hph => intro hne; simp [completeBlockEff, hs.streamingBatch hph] at hne
    | consume _ _ _ _ _ _ _ _ hb => intro hne; simp [consumeEff, hb] at hne
    | compact _ _ _ hb => intro hne; simp [compactEff, enterCompactionEff, hb] at hne
    | toolCommit c =>
      intro hne x hx
      simpa [toolCommitEff, batchCalls] using h3 (by simpa [toolCommitEff] using hne) x hx
    | _ => first | exact h3 | (simp_all [enqueueEff, startEff, recoverEff, beginInferenceEff,
        showPartialEff, finishEff, truncateEff, cancelEff, execStartEff, refuseEff, returnEff,
        abortEntryEff, zombieExitEff, toolWriteEff, runWriteEff, abortEff, newTurnEff, beginTurnEff, failTurnEff,
        decideSettleEff, recordSettlementEff, settleAbandonedEff, toolRunWriteEff, settleEff, crashEff, freshMemory])
  · cases st with
    | recover =>
      intro hph
      by_cases hb : s.d.batch = [] <;> simp [recoverEff, hb] at hph ⊢
    | dispatch _ _ _ hu =>
      intro _; simp [dispatchEff]; exact hu
    | settleUnanswered _ _ _ hu =>
      intro _; simp [settleUnansweredEff]; simpa using hu
    | commitResult e rest hph hb =>
      intro hph'
      by_cases hr : rest = [] <;> simp [commitResultEff, hr] at hph' ⊢
    | toolCommit c hph =>
      intro _
      have := h4 hph
      simpa [toolCommitEff] using this
    | _ => first | exact h4 | (simp_all [enqueueEff, startEff, consumeEff, beginInferenceEff,
        showPartialEff, completeBlockEff, finishEff, truncateEff, cancelEff, execStartEff,
        refuseEff, returnEff, abortEntryEff, zombieExitEff, toolWriteEff, runWriteEff, abortEff,
        newTurnEff, decideSettleEff, recordSettlementEff, settleAbandonedEff, toolRunWriteEff, settleEff, compactEff, enterCompactionEff, crashEff, freshMemory])
  · cases st with
    | beginInference _ hr => intro _; exact hr
    | _ => first | exact h5 | (simp_all [enqueueEff, startEff, recoverEff, consumeEff,
        showPartialEff, completeBlockEff, finishEff, truncateEff, cancelEff, dispatchEff,
        settleUnansweredEff, execStartEff, refuseEff, returnEff, toolCommitEff, abortEntryEff,
        zombieExitEff, toolWriteEff, commitResultEff, runWriteEff, abortEff, newTurnEff, beginTurnEff, failTurnEff,
        decideSettleEff, recordSettlementEff, settleAbandonedEff, toolRunWriteEff, settleEff, compactEff, enterCompactionEff, crashEff, freshMemory]) | (intro h; simp [commitResultEff] at h; split at h <;> simp at h)

theorem aux_reachable (h : Reachable P s) : Aux s := by
  induction h with
  | init => exact ⟨by simp [init, freshMemory], by simp [init], by simp [init],
      by simp [init, freshMemory], by simp [init, freshMemory]⟩
  | step hr st ih => exact aux_step (safe_reachable hr) ih st

/-- After the last result of a batch commits, nothing is owed. -/
theorem last_commit_clears {u : State} (ha : Aux u) {e : Entry} (hb : u.d.batch = [e]) :
    unanswered (u.d.history ++ [Record.result e.call]) = [] := by
  apply List.eq_nil_iff_forall_not_mem.2
  intro x hx
  rw [mem_unanswered_result] at hx
  have := ha.unansweredInBatch (by simp [hb]) x hx.1
  simp [batchCalls, hb] at this
  exact hx.2 this

theorem entry_eta (e : Entry) (h : e.committed = false) : e = ⟨e.call, false⟩ := by
  cases e; simp_all

/-! ## Abort -/

/-- The target of both drains: the run is back at a boundary between inferences with nothing
owed. -/
def Drained (v : State) : Prop :=
  v.m.phase = .ready ∧ v.d.batch = [] ∧ unanswered v.d.history = [] ∧ v.m.recovered = true

/-- An aborted tool batch drains without running anything: every uncommitted call receives
an aborted error result and every result commits in batch order. -/
theorem abort_drain : ∀ (n : Nat) (u : State), Reachable P u → u.m.phase = .tools →
    u.m.aborted = true → u.d.batch.length = n →
    ∃ v, Star (Quiet P) u v ∧ Drained v ∧ v.m.aborted = true ∧
      v.m.turnRequested = u.m.turnRequested := by
  intro n
  induction n with
  | zero =>
    intro u hu hph _ hn
    exact absurd (List.eq_nil_of_length_eq_zero hn) ((aux_reachable hu).toolsBatch hph)
  | succ k ih =>
    have finishHead : ∀ w : State, Reachable P w → w.m.phase = .tools → w.m.aborted = true →
        ∀ e rest, w.d.batch = e :: rest → rest.length = k →
        (e.committed = true ∨ e.call ∈ w.m.finished) →
        ∃ v, Star (Quiet P) w v ∧ Drained v ∧ v.m.aborted = true ∧
          v.m.turnRequested = w.m.turnRequested := by
      intro w hw hph hab e rest hb hlen hok
      have hs := safe_reachable hw
      have ha := aux_reachable hw
      have st : Step P w (commitResultEff w e rest) := .commitResult e rest hph hb hok
      have q : Quiet P w (commitResultEff w e rest) :=
        ⟨st, rfl, rfl, by intro h; by_cases hr : rest = [] <;> simp [commitResultEff, hr] at h⟩
      by_cases hr : rest = []
      · subst hr
        refine ⟨_, Star.single q, ⟨?_, ?_, ?_, ?_⟩, ?_, rfl⟩
        · simp [commitResultEff]
        · simp [commitResultEff]
        · simpa [commitResultEff] using last_commit_clears ha hb
        · simpa [commitResultEff] using ha.toolsRecovered hph
        · simpa [commitResultEff] using hab
      · obtain ⟨v, hv, hd, hvab, hvt⟩ := ih (commitResultEff w e rest) (.step hw st)
          (by simp [commitResultEff, hr]) (by simpa [commitResultEff] using hab)
          (by simpa [commitResultEff] using hlen)
        exact ⟨v, .head q hv, hd, hvab, hvt⟩
    intro u hu hph hab hn
    obtain ⟨e, rest, hb⟩ : ∃ e rest, u.d.batch = e :: rest := by
      cases hbb : u.d.batch with
      | nil => simp [hbb] at hn
      | cons e rest => exact ⟨e, rest, rfl⟩
    have hlen : rest.length = k := by simp [hb] at hn; exact hn
    by_cases hok : e.committed = true ∨ e.call ∈ u.m.finished
    · exact finishHead u hu hph hab e rest hb hlen hok
    · simp only [not_or, Bool.not_eq_true] at hok
      have he := entry_eta e hok.1
      have hm : (⟨e.call, false⟩ : Entry) ∈ u.d.batch := by rw [hb, ← he]; simp
      have st : Step P u (abortEntryEff u e.call) := .abortEntry e.call hph hab hm hok.2
      have q : Quiet P u (abortEntryEff u e.call) :=
        ⟨st, rfl, rfl, by intro h; simp [abortEntryEff, hph] at h⟩
      obtain ⟨v, hv, hd, hvab, hvt⟩ := finishHead _ (.step hu st)
        (by simpa [abortEntryEff] using hph)
        (by simpa [abortEntryEff] using hab) e rest (by simpa [abortEntryEff] using hb) hlen
        (Or.inr (by simp [abortEntryEff]))
      exact ⟨v, .head q hv, hd, hvab, by simpa [abortEntryEff] using hvt⟩

/-- From a drained run, decide to settle, record the settlement stage, and settle. With nothing
queued the store ends settled. -/
theorem settle_from_drained {u : State} (hd : Drained u) (htr : u.m.turnRequested = false)
    (hgo : u.m.aborted = true ∨ queued u.d = []) :
    ∃ v, Star (Quiet P) u v ∧ v.m.phase = .idle ∧ (queued u.d = [] → v.d.pending = none) := by
  obtain ⟨hph, hb, hun, hr⟩ := hd
  let u1 := decideSettleEff u
  let u2 := recordSettlementEff u1
  have st1 : Step P u u1 := .decideSettle hph hr hb hun htr
    (hgo.imp_right fun hq x hx => by rw [hq] at hx; cases hx)
  have q1 : Quiet P u u1 := ⟨st1, rfl, rfl, by simp [u1, decideSettleEff]⟩
  have st2 : Step P u1 u2 := .recordSettlement (by simp [u1, decideSettleEff])
    (by simp [u1, decideSettleEff])
  have q2 : Quiet P u1 u2 := ⟨st2, rfl, rfl, by simp [u2, u1, recordSettlementEff, decideSettleEff]⟩
  have st3 : Step P u2 (settleEff u2) :=
    .settle (by simp [u2, u1, recordSettlementEff, decideSettleEff])
      (by simp [u2, recordSettlementEff])
  have q3 : Quiet P u2 (settleEff u2) := ⟨st3, rfl, rfl, by simp [settleEff]⟩
  refine ⟨_, .head q1 (.head q2 (Star.single q3)), by simp [settleEff], ?_⟩
  intro hq
  simp [queued] at hq
  simp [settleEff, u2, u1, recordSettlementEff, decideSettleEff, queued, hq]

theorem aborted_ready_to_idle {u : State} (hu : Reachable P u) (hph : u.m.phase = .ready)
    (hr : u.m.recovered = true) (hab : u.m.aborted = true) (htr : u.m.turnRequested = false) :
    ∃ v, Star (Quiet P) u v ∧ v.m.phase = .idle := by
  have ha := aux_reachable hu
  have hb := ha.recoveredBatch hr (by rw [hph]; simp)
  by_cases hun : unanswered u.d.history = []
  · obtain ⟨v, hv, hvi, _⟩ := settle_from_drained (P := P)
      (u := u) ⟨hph, hb, hun, hr⟩ htr (Or.inl hab)
    exact ⟨v, hv, hvi⟩
  · have st : Step P u (settleUnansweredEff u) := .settleUnanswered hph hr hb hun
    have q : Quiet P u (settleUnansweredEff u) := ⟨st, rfl, rfl, by simp [settleUnansweredEff]⟩
    obtain ⟨w, hw, hd, hwab, hwt⟩ := abort_drain _ _ (.step hu st) (by simp [settleUnansweredEff])
      (by simpa [settleUnansweredEff] using hab) rfl
    obtain ⟨v, hv, hvi, _⟩ := settle_from_drained (P := P) hd
      (by simpa [settleUnansweredEff, htr] using hwt) (Or.inl hwab)
    exact ⟨v, .head q (hw.trans hv), hvi⟩

theorem aborted_tools_to_idle {u : State} (hu : Reachable P u) (hph : u.m.phase = .tools)
    (hab : u.m.aborted = true) (htr : u.m.turnRequested = false) :
    ∃ v, Star (Quiet P) u v ∧ v.m.phase = .idle := by
  obtain ⟨w, hw, hd, hwab, hwt⟩ := abort_drain _ _ hu hph hab rfl
  obtain ⟨v, hv, hvi, _⟩ := settle_from_drained (P := P) hd (by rw [hwt]; exact htr) (Or.inl hwab)
  exact ⟨v, hw.trans hv, hvi⟩

theorem aborted_to_idle {u : State} (hu : Reachable P u) (hab : u.m.aborted = true)
    (htr : u.m.turnRequested = false) :
    ∃ v, Star (Quiet P) u v ∧ v.m.phase = .idle := by
  have ha := aux_reachable hu
  cases hph : u.m.phase with
  | idle => exact ⟨u, .refl u, hph⟩
  | settling =>
    cases hsr : u.m.stageRecorded with
    | true =>
      have st : Step P u (settleEff u) := .settle hph hsr
      exact ⟨_, Star.single ⟨st, rfl, rfl, by simp [settleEff]⟩, by simp [settleEff]⟩
    | false =>
      have st1 : Step P u (recordSettlementEff u) := .recordSettlement hph hsr
      have st2 : Step P (recordSettlementEff u) (settleEff (recordSettlementEff u)) :=
        .settle (by simp [recordSettlementEff, hph]) (by simp [recordSettlementEff])
      exact ⟨_, .head ⟨st1, rfl, rfl, by simp [recordSettlementEff, hph]⟩
        (Star.single ⟨st2, rfl, rfl, by simp [settleEff]⟩), by simp [settleEff]⟩
  | tools => exact aborted_tools_to_idle hu hph hab htr
  | streaming =>
    have st : Step P u (cancelEff u) := .cancel hph hab
    have q : Quiet P u (cancelEff u) := ⟨st, rfl, rfl, by simp [cancelEff]⟩
    obtain ⟨v, hv, hvi⟩ := aborted_ready_to_idle (.step hu st) (by simp [cancelEff])
      (by simpa [cancelEff] using ha.streamingRecovered hph) (by simpa [cancelEff] using hab)
      (by simpa [cancelEff] using htr)
    exact ⟨v, .head q hv, hvi⟩
  | ready =>
    cases hr : u.m.recovered with
    | true => exact aborted_ready_to_idle hu hph hr hab htr
    | false =>
      have st : Step P u (recoverEff u) := .recover hph hr
      have q : Quiet P u (recoverEff u) :=
        ⟨st, rfl, rfl, by intro h; by_cases hb : u.d.batch = [] <;> simp [recoverEff, hb] at h⟩
      by_cases hb : u.d.batch = []
      · obtain ⟨v, hv, hvi⟩ := aborted_ready_to_idle (.step hu st) (by simp [recoverEff, hb])
          (by simp [recoverEff]) (by simpa [recoverEff] using hab) (by simpa [recoverEff] using htr)
        exact ⟨v, .head q hv, hvi⟩
      · obtain ⟨v, hv, hvi⟩ := aborted_tools_to_idle (.step hu st) (by simp [recoverEff, hb])
          (by simpa [recoverEff] using hab) (by simpa [recoverEff] using htr)
        exact ⟨v, .head q hv, hvi⟩

/-- **Abort drives the agent to idle.** From any reachable state, `abort` followed only by quiet
steps reaches a state with no run loop. Along the way no inference is started, no tool is
executed (`execs` is unchanged), and no input is accepted or consumed. -/
theorem abort_reaches_idle (h : Reachable P s) :
    ∃ t, Star (Quiet P) s t ∧ t.m.phase = .idle ∧ t.g.execs = s.g.execs := by
  have st : Step P s (abortEff s) := .abort
  have q : Quiet P s (abortEff s) := ⟨st, rfl, rfl, fun h => h⟩
  obtain ⟨v, hv, hvi⟩ := aborted_to_idle (.step h st) (by simp [abortEff]) (by simp [abortEff])
  exact ⟨v, .head q hv, hvi, (Star.head q hv).quiet_execs⟩

theorem Star.quiet_steps {u v : State} (h : Star (Quiet P) u v) : Star (Step P) u v := by
  induction h with
  | refl => exact .refl _
  | head q _ ih => exact .head q.1 ih

/-! ## Restart -/

/-- A resumed (or freshly dispatched) batch runs to completion without an abort: stored results
are appended as they are, retryable calls execute again, and non-retryable calls restored from
the store are refused with an error result instead of running. -/
theorem run_drain : ∀ (n : Nat) (u : State), Reachable P u → u.m.phase = .tools →
    u.m.aborted = false → u.m.running = [] → u.m.finished = [] → u.d.batch.length = n →
    ∃ v, Star (Step P) u v ∧ Drained v ∧ v.m.aborted = false ∧ queued v.d = queued u.d ∧
      v.m.turnRequested = u.m.turnRequested := by
  intro n
  induction n with
  | zero =>
    intro u hu hph _ _ _ hn
    exact absurd (List.eq_nil_of_length_eq_zero hn) ((aux_reachable hu).toolsBatch hph)
  | succ k ih =>
    have finishHead : ∀ w : State, Reachable P w → w.m.phase = .tools →
        w.m.aborted = false → w.m.running = [] →
        ∀ e rest, w.d.batch = e :: rest → rest.length = k →
        (∀ x ∈ w.m.finished, x = e.call) →
        (e.committed = true ∨ e.call ∈ w.m.finished) →
        ∃ v, Star (Step P) w v ∧ Drained v ∧ v.m.aborted = false ∧
          queued v.d = queued w.d ∧ v.m.turnRequested = w.m.turnRequested := by
      intro w hw hph hab hrun e rest hb hlen hfin hok
      have hs := safe_reachable hw
      have ha := aux_reachable hw
      have st : Step P w (commitResultEff w e rest) := .commitResult e rest hph hb hok
      have hfin' : w.m.finished.filter (· ≠ e.call) = [] := by
        apply List.filter_eq_nil_iff.2
        intro x hx; simp [hfin x hx]
      by_cases hr : rest = []
      · subst hr
        refine ⟨_, Star.single st, ⟨?_, ?_, ?_, ?_⟩, ?_, rfl, rfl⟩
        · simp [commitResultEff]
        · simp [commitResultEff]
        · simpa [commitResultEff] using last_commit_clears ha hb
        · simpa [commitResultEff] using ha.toolsRecovered hph
        · simpa [commitResultEff] using hab
      · obtain ⟨v, hv, hd, hvab, hvq, hvt⟩ := ih (commitResultEff w e rest) (.step hw st)
          (by simp [commitResultEff, hr]) (by simpa [commitResultEff] using hab)
          (by simpa [commitResultEff] using hrun) (by simpa [commitResultEff] using hfin')
          (by simpa [commitResultEff] using hlen)
        exact ⟨v, .head st hv, hd, hvab, hvq, hvt⟩
    intro u hu hph hab hrun hfin hn
    obtain ⟨e, rest, hb⟩ : ∃ e rest, u.d.batch = e :: rest := by
      cases hbb : u.d.batch with
      | nil => simp [hbb] at hn
      | cons e rest => exact ⟨e, rest, rfl⟩
    have hlen : rest.length = k := by simp [hb] at hn; exact hn
    cases hc : e.committed with
    | true =>
      exact finishHead u hu hph hab hrun e rest hb hlen (by simp [hfin]) (Or.inl hc)
    | false =>
      have he := entry_eta e hc
      have hm : (⟨e.call, false⟩ : Entry) ∈ u.d.batch := by rw [hb, ← he]; simp
      by_cases hrefuse : u.m.resume = true ∧ P.retryable e.call = false
      · have st : Step P u (refuseEff u e.call) :=
          .refuse e.call hph hrefuse.1 hrefuse.2 hm (by simp [hrun]) (by simp [hfin])
        obtain ⟨v, hv, hd⟩ := finishHead _ (.step hu st) (by simpa [refuseEff] using hph)
          (by simpa [refuseEff] using hab) (by simpa [refuseEff] using hrun) e rest
          (by simpa [refuseEff] using hb) hlen (by simp [refuseEff, hfin])
          (Or.inr (by simp [refuseEff]))
        exact ⟨v, .head st hv, hd⟩
      · have hgo : u.m.resume = false ∨ P.retryable e.call = true := by
          cases h1 : u.m.resume with
          | false => exact Or.inl rfl
          | true =>
            cases h2 : P.retryable e.call with
            | false => exact absurd ⟨h1, h2⟩ hrefuse
            | true => exact Or.inr rfl
        have st1 : Step P u (execStartEff u e.call) :=
          .execStart e.call hph hab hm (by simp [hrun]) (by simp [hfin]) hgo
        have st2 : Step P (execStartEff u e.call) (returnEff (execStartEff u e.call) e.call) :=
          .toolReturn e.call (by simp [execStartEff])
        obtain ⟨v, hv, hd⟩ := finishHead _ (.step (.step hu st1) st2)
          (by simpa [returnEff, execStartEff] using hph)
          (by simpa [returnEff, execStartEff] using hab)
          (by simp [returnEff, execStartEff, hrun]) e rest
          (by simpa [returnEff, execStartEff] using hb) hlen
          (by simp [returnEff, execStartEff, hfin]) (Or.inr (by simp [returnEff, execStartEff]))
        exact ⟨v, .head st1 (.head st2 hv), hd⟩

/-- **Restart from any reachable persisted state can settle.** After a crash anywhere — mid
stream, mid batch, mid settlement — with no queued input, the restored agent can load, resume
its durable batch (re-executing only retryable calls), answer any call the crash left
unanswered, and settle, leaving no `owed` record. -/
theorem restart_can_settle (h : Reachable P s) (hq : queued s.d = []) :
    ∃ t, Star (Step P) (crashEff s) t ∧ t.m.phase = .idle ∧ t.d.pending = none := by
  have r0 : Reachable P (crashEff s) := .step h .crash
  have st1 : Step P (crashEff s) (startEff (crashEff s)) := .start rfl (by simp [crashEff, freshMemory])
  have st2 : Step P (startEff (crashEff s)) (recoverEff (startEff (crashEff s))) :=
    .recover rfl rfl
  let c2 := recoverEff (startEff (crashEff s))
  have r2 : Reachable P c2 := .step (.step r0 st1) st2
  have finish : ∀ v, Star (Step P) c2 v → Drained v → queued v.d = [] →
      v.m.turnRequested = false →
      ∃ t, Star (Step P) (crashEff s) t ∧ t.m.phase = .idle ∧ t.d.pending = none := by
    intro v hv hd hvq hvt
    obtain ⟨t, ht, hti, htp⟩ := settle_from_drained (P := P) hd hvt (Or.inr hvq)
    exact ⟨t, .head st1 (.head st2 (hv.trans ht.quiet_steps)), hti, htp hvq⟩
  by_cases hb : s.d.batch = []
  · by_cases hun : unanswered s.d.history = []
    · exact finish c2 (.refl _)
        ⟨by simp [c2, recoverEff, startEff, crashEff, hb],
         by simpa [c2, recoverEff, startEff, crashEff] using hb,
         by simpa [c2, recoverEff, startEff, crashEff] using hun,
         by simp [c2, recoverEff]⟩
        (by simpa [c2, queued, recoverEff, startEff, crashEff] using hq)
        (by simp [c2, recoverEff, startEff, crashEff, freshMemory])
    · have st3 : Step P c2 (dispatchEff c2) :=
        .dispatch (by simp [c2, recoverEff, startEff, crashEff, hb]) (by simp [c2, recoverEff])
          (by simpa [c2, recoverEff, startEff, crashEff] using hb)
          (by simpa [c2, recoverEff, startEff, crashEff] using hun)
      obtain ⟨v, hv, hd, _, hvq, hvt⟩ := run_drain _ _ (.step r2 st3) (by simp [dispatchEff])
        (by simp [dispatchEff, c2, recoverEff, startEff])
        (by simp [dispatchEff]) (by simp [dispatchEff]) rfl
      exact finish v (.head st3 hv) hd
        (by rw [hvq]; simpa [dispatchEff, c2, queued, recoverEff, startEff, crashEff] using hq)
        (by rw [hvt]; simp [dispatchEff, c2, recoverEff, startEff, crashEff, freshMemory])
  · obtain ⟨v, hv, hd, _, hvq, hvt⟩ := run_drain _ _ r2
      (by simp [c2, recoverEff, startEff, crashEff, hb])
      (by simp [c2, recoverEff, startEff]) (by simp [c2, recoverEff])
      (by simp [c2, recoverEff]) rfl
    exact finish v hv hd
      (by rw [hvq]; simpa [c2, queued, recoverEff, startEff, crashEff] using hq)
      (by rw [hvt]; simp [c2, recoverEff, startEff, crashEff, freshMemory])

end

end AgentBaseVerification
