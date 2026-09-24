import AgentBaseVerification.Safe

set_option linter.unusedSimpArgs false

/-!
# The properties master plan 20 asks for

The model satisfies the remaining properties of master plan 20: the `owed` record is present
whenever there is work to do (except the input an abort deliberately left queued), no pending
tool or run state survives a settled agent, every tool result follows its call exactly once,
and a restart never leaves a listener showing an unfinished block.
-/

namespace AgentBaseVerification

/-- The second inductive invariant of the model. -/
structure Inv (s : State) : Prop where
  /-- **The active flag covers all work.** When the store says the agent is settled, every
  queued message is one an abort left queued, no batch or call is owed, and no tool or run
  state is left behind. -/
  idleClean : s.d.pending = none →
      (∀ x ∈ queued s.d, x ∈ s.g.abandoned) ∧ s.d.batch = [] ∧ unanswered s.d.history = [] ∧
        s.d.callKV = [] ∧ s.d.runKV = false
  settlingClean : s.m.phase = .settling → s.d.batch = [] ∧ unanswered s.d.history = []
  /-- Until late work rewrites it, the settlement stage covers only abandoned input. -/
  settlingQueued : s.m.phase = .settling → s.d.pending = some .settlement →
      ∀ x ∈ queued s.d, x ∈ s.g.abandoned
  /-- What the instance remembers as dropped was abandoned. -/
  droppedAbandoned : ∀ x ∈ s.m.dropped, x ∈ s.g.abandoned
  abortQueued : s.m.aborted = true → s.m.turnRequested = false →
      ∀ x ∈ queued s.d, x ∈ s.m.dropped
  /-- While settling with no turn requested, the queue holds only dropped input. -/
  settlingDropped : s.m.phase = .settling → s.m.turnRequested = false →
      ∀ x ∈ queued s.d, x ∈ s.m.dropped
  droppedQueued : s.m.abortDropped = true → s.m.turnRequested = false → s.m.phase = .idle →
      ∀ x ∈ queued s.d, x ∈ s.m.dropped
  callKVBatch : ∀ c ∈ s.d.callKV, c ∈ batchCalls s.d
  /-- An execution still unwinding after an abort holds a live handle only while its call is
  still in the batch. -/
  zombiesBatch : ∀ c ∈ s.m.zombies, c ∈ batchCalls s.d
  runningBatch : ∀ c ∈ s.m.running, c ∈ batchCalls s.d
  runningOpen : ∀ e ∈ s.d.batch, e.call ∈ s.m.running → e.committed = false ∧ e.call ∉ s.m.finished
  runningTools : s.m.phase ≠ .tools → s.m.running = []
  /-- Every tool result in the conversation answers a call that is in the conversation. -/
  resultsHaveCalls : ∀ c ∈ results s.d.history, c ∈ calls s.d.history
  batchUnanswered : ∀ c ∈ batchCalls s.d, c ∈ unanswered s.d.history
  unansweredInBatch : s.d.batch ≠ [] → ∀ c ∈ unanswered s.d.history, c ∈ batchCalls s.d
  /-- No call is answered twice. -/
  resultsDup : Dup1 (results s.d.history)
  streamingInference : s.m.phase = .streaming → s.d.pending = some .inference
  streamingRecovered : s.m.phase = .streaming → s.m.recovered = true
  unrecoveredPhase : s.m.recovered = false → s.m.phase = .idle ∨ s.m.phase = .ready
  streamingOpen : s.m.phase = .streaming → s.d.requestOpen = true
  /-- A listener is only ever shown an unfinished block while it is actually streaming, or
  before the restarted instance has emitted its `block_reset`. -/
  uiOpen : s.g.uiOpen = true →
      (s.m.phase = .streaming ∧ s.m.unfinished ≠ none) ∨
        (s.m.recovered = false ∧ s.m.inherited = some .inference ∧
          s.d.pending = some .inference ∧ s.d.requestOpen = true)
  /-- A live instance with no run has nothing half-done: runs end only by settling. -/
  idleRecoveredClean : s.m.phase = .idle → s.m.recovered = true →
      s.d.batch = [] ∧ unanswered s.d.history = []
  /-- **Owed work is never stranded by a live owner.** Whenever the store says the agent is
  working and this instance has no run, `#startRun`'s `finally` still has a reason to start
  one: a requested turn, a turn an abort dropped (the settle-only run), or a record the
  settlement reopened. -/
  idleWorkScheduled : s.m.phase = .idle → s.m.recovered = true → s.d.pending ≠ none →
      s.m.turnRequested = true ∨ s.m.abortDropped = true ∨ s.m.reopened = true

theorem inv_init : Inv init := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_,
    ?_, ?_⟩ <;>
    simp [init, queued, freshMemory, batchCalls, unanswered, calls, results, Dup1]

section
variable {P : Params} {s t : State}

macro "fx_simp" : tactic => `(tactic| (simp_all [enqueueEff, startEff, recoverEff, consumeEff,
  beginInferenceEff, showPartialEff, completeBlockEff, finishEff, truncateEff, cancelEff,
  dispatchEff, settleUnansweredEff, execStartEff, refuseEff, returnEff, toolCommitEff,
  abortEntryEff, zombieExitEff, toolWriteEff, commitResultEff, runWriteEff, abortEff, newTurnEff, beginTurnEff, failTurnEff,
  decideSettleEff, recordSettlementEff, settleAbandonedEff, toolRunWriteEff, settleEff, compactEff, enterCompactionEff, crashEff, freshMemory, queued,
  batchCalls, toBlock] <;> (try (split <;> simp_all))))

macro "fx_try" h:ident : tactic => `(tactic| first | exact $h | (fx_simp; done) | (fx_simp; grind))

theorem settlingClean_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    t.m.phase = .settling → t.d.batch = [] ∧ unanswered t.d.history = [] := by
  have h := hi.settlingClean
  cases st with
  | decideSettle _ _ hb hu => intro _; exact ⟨hb, hu⟩
  | settleAbandoned _ _ _ _ _ hb hu => intro _; exact ⟨hb, hu⟩
  | _ => fx_try h

theorem zombiesBatch_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    ∀ c ∈ t.m.zombies, c ∈ batchCalls t.d := by
  have h := hi.zombiesBatch
  cases st with
  | abortEntry c =>
    intro x hx
    by_cases hr : c ∈ s.m.running
    · simp [abortEntryEff, hr] at hx
      rcases hx with hx | rfl
      · exact h x hx
      · exact hi.runningBatch x hr
    · simp [abortEntryEff, hr] at hx; exact h x hx
  | commitResult e rest _ hb _ =>
    intro x hx
    simp [commitResultEff] at hx
    have hxb := h x hx.1
    simp [batchCalls, hb] at hxb
    rcases hxb with rfl | ⟨e', he', rfl⟩
    · exact absurd rfl hx.2
    · simp [commitResultEff, batchCalls]; exact ⟨e', he', rfl⟩
  | dispatch _ _ hb =>
    intro x hx; have := h x hx; simp [batchCalls, hb] at this
  | settleUnanswered _ _ hb =>
    intro x hx; have := h x hx; simp [batchCalls, hb] at this
  | toolCommit c =>
    intro x hx; simpa [toolCommitEff, batchCalls] using h x hx
  | zombieExit c =>
    intro x hx; simp [zombieExitEff] at hx; exact h x hx.1
  | _ => fx_try h

theorem droppedAbandoned_step (hi : Inv s) (st : Step P s t) :
    ∀ x ∈ t.m.dropped, x ∈ t.g.abandoned := by
  have h := hi.droppedAbandoned
  cases st with
  | abort =>
    intro x hx
    simp [abortEff] at hx ⊢
    rcases hx with hx | hx
    · exact Or.inl (h x hx)
    · exact Or.inr hx
  | _ => fx_try h

/-- The queue of an instance whose abort dropped the pending turn holds only input it
remembers as dropped, as long as nothing asked for a turn since. -/
theorem abortQueued_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    t.m.aborted = true → t.m.turnRequested = false → ∀ x ∈ queued t.d, x ∈ t.m.dropped := by
  have h := hi.abortQueued
  cases st with
  | abort => intro _ _ x hx; simp [abortEff, queued] at hx ⊢; right; simpa [queued] using hx
  | truncate =>
    intro ha htr x hx
    have hq : queued s.d = [] := by
      cases hq : queued s.d with
      | nil => rfl
      | cons y ys => simp [truncateEff, hq] at htr
    simp [queued] at hq
    simp [truncateEff, queued, hq] at hx
  | _ => fx_try h

theorem settlingDropped_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    t.m.phase = .settling → t.m.turnRequested = false → ∀ x ∈ queued t.d, x ∈ t.m.dropped := by
  have h := hi.settlingDropped
  cases st with
  | decideSettle _ _ _ _ htr hgo =>
    intro _ _ x hx
    have hx' : x ∈ queued s.d := by simpa [decideSettleEff, queued] using hx
    rcases hgo with ha | hq
    · simpa [decideSettleEff] using hi.abortQueued ha htr x hx'
    · simpa [decideSettleEff] using hq x hx'
  | settleAbandoned hph _ hd htr =>
    intro _ _ x hx
    have hx' : x ∈ queued s.d := by simpa [settleAbandonedEff, queued] using hx
    simpa [settleAbandonedEff] using hi.droppedQueued hd htr hph x hx'
  | abort => intro _ _ x hx; simp [abortEff, queued] at hx ⊢; right; simpa [queued] using hx
  | _ => fx_try h

theorem droppedQueued_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    t.m.abortDropped = true → t.m.turnRequested = false → t.m.phase = .idle →
      ∀ x ∈ queued t.d, x ∈ t.m.dropped := by
  have h := hi.droppedQueued
  cases st with
  | abort => intro _ _ _ x hx; simp [abortEff, queued] at hx ⊢; right; simpa [queued] using hx
  | settle hph =>
    intro _ htr _ x hx
    simpa [settleEff] using hi.settlingDropped hph (by simpa [settleEff] using htr) x
      (by simpa [settleEff, queued] using hx)
  | _ => fx_try h

theorem settlingQueued_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    t.m.phase = .settling → t.d.pending = some .settlement →
      ∀ x ∈ queued t.d, x ∈ t.g.abandoned := by
  have h := hi.settlingQueued
  cases st with
  | decideSettle _ _ _ _ htr hgo =>
    intro _ _ x hx
    have hx' : x ∈ queued s.d := by simpa [decideSettleEff, queued] using hx
    rcases hgo with ha | hq
    · simpa [decideSettleEff] using hi.droppedAbandoned x (hi.abortQueued ha htr x hx')
    · simpa [decideSettleEff] using hi.droppedAbandoned x (hq x hx')
  | settleAbandoned hph _ hd htr =>
    intro _ _ x hx
    have hx' : x ∈ queued s.d := by simpa [settleAbandonedEff, queued] using hx
    simpa [settleAbandonedEff] using hi.droppedAbandoned x (hi.droppedQueued hd htr hph x hx')
  | recordSettlement hph =>
    intro _ hp x hx
    have hx' : x ∈ queued s.d := by simpa [recordSettlementEff, queued] using hx
    by_cases hall : ∀ y ∈ queued s.d, y ∈ s.m.dropped
    · simpa [recordSettlementEff] using hi.droppedAbandoned x (hall x hx')
    · have hp' : s.d.pending = some .settlement := by
        simpa [recordSettlementEff, hall] using hp
      simpa [recordSettlementEff] using h hph hp' x hx'
  | abort =>
    intro hph hp x hx
    simp [abortEff, queued] at hx ⊢
    right; simpa [queued] using hx
  | _ => fx_try h

theorem runningTools_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    t.m.phase ≠ .tools → t.m.running = [] := by
  have h := hi.runningTools
  cases st with
  | commitResult e rest hph hb _ =>
    intro hph'
    have hr : rest = [] := by
      by_cases hr : rest = [] <;> simp_all [commitResultEff]
    apply List.eq_nil_iff_forall_not_mem.2
    intro c hc
    have hcb := hi.runningBatch c hc
    have ho := hi.runningOpen
    simp [batchCalls, hb, hr] at hcb
    rcases hcb with rfl
    have := ho e (by simp [hb]) hc
    rcases (by assumption : e.committed = true ∨ e.call ∈ s.m.finished) with h1 | h1
    · rw [this.1] at h1; cases h1
    · exact this.2 h1
  | _ => fx_try h

theorem runningBatch_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    ∀ c ∈ t.m.running, c ∈ batchCalls t.d := by
  have h := hi.runningBatch
  cases st with
  | execStart c _ _ hm _ _ _ =>
    intro x hx
    simp [execStartEff] at hx
    rcases hx with hx | rfl
    · exact h x hx
    · exact List.mem_map.2 ⟨_, hm, rfl⟩
  | commitResult e rest hph hb hok =>
    intro x hx
    have hxb := h x hx
    simp [batchCalls, hb] at hxb
    rcases hxb with rfl | ⟨e', he', rfl⟩
    · have := hi.runningOpen e (by simp [hb]) hx
      rcases hok with h1 | h1
      · rw [this.1] at h1; cases h1
      · exact absurd h1 this.2
    · simp [commitResultEff, batchCalls]; exact ⟨e', he', rfl⟩
  | toolCommit c => intro x hx; simp [toolCommitEff] at hx; simpa [toolCommitEff, batchCalls] using h x hx.1
  | toolReturn c => intro x hx; simp [returnEff] at hx; exact h x hx.1
  | abortEntry c => intro x hx; simp [abortEntryEff] at hx; exact h x hx.1
  | _ => fx_try h

theorem runningOpen_step (hs : Safe s) (hi : Inv s) (st : Step P s t) :
    ∀ e ∈ t.d.batch, e.call ∈ t.m.running → e.committed = false ∧ e.call ∉ t.m.finished := by
  have h := hi.runningOpen
  cases st with
  | execStart c _ _ hm hnr hnf _ =>
    intro e he hr
    simp [execStartEff] at he hr ⊢
    rcases hr with hr | hr
    · exact h e he hr
    · -- `e` and `⟨c, false⟩` are entries of the batch with the same call, hence equal.
      have hd := hs.batchDup c
      by_cases hee : e = ⟨c, false⟩
      · subst hee; exact ⟨rfl, hnf⟩
      · exfalso
        have h1 : c ∈ (s.d.batch.erase e).map Entry.call :=
          List.mem_map.2 ⟨⟨c, false⟩, (List.mem_erase_of_ne (Ne.symm hee)).2 hm, rfl⟩
        have h2 := List.count_pos_iff.2 h1
        have hperm := List.perm_cons_erase he
        have hc := (hperm.map Entry.call).count_eq c
        simp [batchCalls, List.count_cons, hr] at hd hc
        omega
  | refuse c _ _ _ _ hnr _ =>
    intro e he hr
    have := h e he hr
    simp [refuseEff] at hr ⊢
    refine ⟨this.1, this.2, ?_⟩
    intro hc; rw [← hc] at hnr; exact hnr hr
  | toolReturn c =>
    intro e he hr
    simp [returnEff] at hr ⊢
    have := h e he hr.1
    exact ⟨this.1, this.2, hr.2⟩
  | toolCommit c =>
    intro e he hr
    simp [toolCommitEff] at he hr ⊢
    obtain ⟨e0, he0, hee⟩ := he
    by_cases hh : e0.call = c
    · simp [hh] at hee; subst hee; simp at hr
    · simp [hh] at hee; subst hee
      have := h e0 he0 hr.1
      exact ⟨this.1, this.2, hr.2⟩
  | abortEntry c =>
    intro e he hr
    simp [abortEntryEff] at hr ⊢
    have := h e he hr.1
    exact ⟨this.1, this.2, hr.2⟩
  | commitResult e rest _ hb _ =>
    intro e' he' hr
    have := h e' (by simp [hb, show e' ∈ rest from he']) hr
    simp [commitResultEff] at hr ⊢
    exact ⟨this.1, fun h1 => (this.2 h1).elim⟩
  | _ => fx_try h

theorem callKVBatch_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    ∀ c ∈ t.d.callKV, c ∈ batchCalls t.d := by
  have h := hi.callKVBatch
  cases st with
  | toolWrite c hc =>
    intro x hx
    simp [toolWriteEff] at hx
    rcases hx with rfl | hx
    · rcases hc with hc | hc
      · exact hi.runningBatch x hc
      · exact hi.zombiesBatch x hc
    · exact h x hx
  | commitResult e rest _ hb _ =>
    intro x hx
    simp [commitResultEff] at hx
    have hxb := h x hx.1
    simp [batchCalls, hb] at hxb
    rcases hxb with rfl | ⟨e', he', rfl⟩
    · exact absurd rfl hx.2
    · simp [commitResultEff, batchCalls]; exact ⟨e', he', rfl⟩
  | toolCommit c =>
    intro x hx; simp [toolCommitEff] at hx; simpa [toolCommitEff, batchCalls] using h x hx.1
  | dispatch _ _ hb =>
    intro x hx; have := h x hx; simp [batchCalls, hb] at this
  | settleUnanswered _ _ hb =>
    intro x hx; have := h x hx; simp [batchCalls, hb] at this
  | _ => fx_try h

theorem batchUnanswered_step (hs : Safe s) (hi : Inv s) (st : Step P s t) :
    ∀ c ∈ batchCalls t.d, c ∈ unanswered t.d.history := by
  have h := hi.batchUnanswered
  cases st with
  | dispatch => intro x hx; simpa [dispatchEff, batchCalls] using hx
  | settleUnanswered =>
    intro x hx; simpa [settleUnansweredEff, batchCalls] using hx
  | commitResult e rest _ hb _ =>
    intro x hx
    have hne : x ≠ e.call := by
      intro hxe
      have hd := hs.batchDup e.call
      have hin : e.call ∈ rest.map Entry.call := by
        simp [commitResultEff, batchCalls] at hx; rw [← hxe]; simpa [batchCalls] using hx
      have := List.count_pos_iff.2 hin
      simp only [batchCalls, hb, List.map_cons, List.count_cons, beq_self_eq_true, ite_true] at hd
      omega
    have hx' : x ∈ batchCalls s.d := by
      simp [commitResultEff, batchCalls] at hx; simp [batchCalls, hb]; exact Or.inr hx
    simp [commitResultEff, mem_unanswered_result]
    exact ⟨h x hx', hne⟩
  | completeBlock p hph =>
    intro x hx
    simp [completeBlockEff, batchCalls, hs.streamingBatch hph] at hx
  | consume _ _ _ _ _ _ _ _ hb =>
    intro x hx; simp [consumeEff, batchCalls, hb] at hx
  | compact _ _ _ hb =>
    intro x hx; simp [compactEff, enterCompactionEff, batchCalls, hb] at hx
  | toolCommit c => simpa [toolCommitEff, batchCalls] using h
  | _ => fx_try h

theorem unansweredInBatch_step (hs : Safe s) (hi : Inv s) (st : Step P s t) :
    t.d.batch ≠ [] → ∀ c ∈ unanswered t.d.history, c ∈ batchCalls t.d := by
  have h := hi.unansweredInBatch
  cases st with
  | dispatch => intro _ x hx; simpa [dispatchEff, batchCalls] using hx
  | settleUnanswered =>
    intro _ x hx; simp [settleUnansweredEff, batchCalls]; exact hx
  | commitResult e rest _ hb _ =>
    intro hne x hx
    simp [commitResultEff, mem_unanswered_result] at hx
    have := h (by simp [hb]) x hx.1
    simp [batchCalls, hb] at this
    rcases this with h1 | h1
    · exact absurd h1 hx.2
    · simp [commitResultEff, batchCalls]; exact h1
  | completeBlock p hph =>
    intro hne; simp [completeBlockEff, hs.streamingBatch hph] at hne
  | consume _ _ _ _ _ _ _ _ hb =>
    intro hne; simp [consumeEff, hb] at hne
  | compact _ _ _ hb =>
    intro hne; simp [compactEff, enterCompactionEff, hb] at hne
  | toolCommit c =>
    intro hne x hx
    simpa [toolCommitEff, batchCalls] using h (by simpa [toolCommitEff] using hne) x hx
  | _ => fx_try h

theorem resultsHaveCalls_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    ∀ c ∈ results t.d.history, c ∈ calls t.d.history := by
  have h := hi.resultsHaveCalls
  cases st with
  | commitResult e rest _ hb _ =>
    intro x hx
    simp [commitResultEff] at hx ⊢
    rcases hx with hx | rfl
    · exact h x hx
    · have := hi.batchUnanswered e.call (by simp [batchCalls, hb])
      exact (mem_unanswered.1 this).1
  | consume m _ _ reset c? _ _ _ _ hu =>
    intro x hx
    cases reset <;> cases c? <;> simp [consumeEff] at hx ⊢ <;> grind
  | completeBlock p =>
    intro x hx
    cases p <;> simp [completeBlockEff, toBlock] at hx ⊢ <;> grind
  | compact => intro x hx; simp [compactEff, enterCompactionEff] at hx
  | _ => fx_try h

theorem resultsDup_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    Dup1 (results t.d.history) := by
  have h := hi.resultsDup
  cases st with
  | commitResult e rest _ hb _ =>
    have hu := hi.batchUnanswered e.call (by simp [batchCalls, hb])
    have h0 : (results s.d.history).count e.call = 0 :=
      count_zero_of_not_mem (mem_unanswered.1 hu).2
    intro x
    have := h x
    simp [commitResultEff, List.count_append, List.count_cons] at this ⊢
    by_cases hx : e.call = x
    · subst hx; simp [h0]
    · simp [hx]; exact this
  | consume m _ _ reset c? =>
    intro x; have := h x
    cases reset <;> cases c? <;> simp [consumeEff, List.count_append] at this ⊢ <;> omega
  | completeBlock p =>
    intro x; have := h x
    cases p <;> simp [completeBlockEff, toBlock, List.count_append] at this ⊢ <;> omega
  | compact => intro x; simp [compactEff, enterCompactionEff]
  | _ => fx_try h

theorem streamingInference_step (hi : Inv s) (st : Step P s t) :
    t.m.phase = .streaming → t.d.pending = some .inference := by
  have h := hi.streamingInference
  cases st <;> fx_try h

theorem streamingRecovered_step (hi : Inv s) (st : Step P s t) :
    t.m.phase = .streaming → t.m.recovered = true := by
  have h := hi.streamingRecovered
  cases st <;> fx_try h

theorem unrecoveredPhase_step (hi : Inv s) (st : Step P s t) :
    t.m.recovered = false → t.m.phase = .idle ∨ t.m.phase = .ready := by
  have h := hi.unrecoveredPhase
  cases st <;> fx_try h

theorem streamingOpen_step (hi : Inv s) (st : Step P s t) :
    t.m.phase = .streaming → t.d.requestOpen = true := by
  have h := hi.streamingOpen
  cases st <;> fx_try h

theorem uiOpen_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    t.g.uiOpen = true →
      (t.m.phase = .streaming ∧ t.m.unfinished ≠ none) ∨
        (t.m.recovered = false ∧ t.m.inherited = some .inference ∧
          t.d.pending = some .inference ∧ t.d.requestOpen = true) := by
  have h := hi.uiOpen
  cases st with
  | showPartial p hph =>
    intro _; left; simp [showPartialEff, hph]
  | recover hph hrec =>
    intro hu
    have hu0 : s.g.uiOpen = true := by
      cases hh : s.g.uiOpen with
      | true => rfl
      | false => simp [recoverEff, hh] at hu
    rcases h hu0 with h1 | h1
    · rw [h1.1] at hph; cases hph
    · simp [recoverEff, h1.2.1, h1.2.2.2] at hu
  | crash =>
    intro hu
    right
    simp [crashEff, freshMemory]
    rcases h hu with h1 | h1
    · exact ⟨hi.streamingInference h1.1, hi.streamingOpen h1.1⟩
    · exact h1.2.2
  | start hph =>
    intro hu
    rcases h hu with h1 | h1
    · rw [h1.1] at hph; cases hph
    · right; simp [startEff, h1.1, h1.2.1, h1.2.2.2]
  | enqueue =>
    intro hu
    rcases h hu with h1 | h1
    · left; simpa [enqueueEff] using h1
    · right; simp [enqueueEff, h1.1, h1.2.1, h1.2.2.2]
  | settleAbandoned hph hrec =>
    intro hu
    rcases h hu with h1 | h1
    · rw [h1.1] at hph; cases hph
    · rw [h1.1] at hrec; cases hrec
  | consume _ _ _ _ _ hph hrec =>
    intro hu
    rcases h hu with h1 | h1
    · rw [h1.1] at hph; cases hph
    · rw [h1.1] at hrec; cases hrec
  | beginInference hph hrec =>
    intro hu
    rcases h hu with h1 | h1
    · rw [h1.1] at hph; cases hph
    · rw [h1.1] at hrec; cases hrec
  | dispatch hph hrec =>
    intro hu
    rcases h hu with h1 | h1
    · rw [h1.1] at hph; cases hph
    · rw [h1.1] at hrec; cases hrec
  | settleUnanswered hph hrec =>
    intro hu
    rcases h hu with h1 | h1
    · rw [h1.1] at hph; cases hph
    · rw [h1.1] at hrec; cases hrec
  | decideSettle hph hrec =>
    intro hu
    rcases h hu with h1 | h1
    · rw [h1.1] at hph; cases hph
    · rw [h1.1] at hrec; cases hrec
  | compact hph hrec =>
    intro hu
    rcases h hu with h1 | h1
    · rw [h1.1] at hph; cases hph
    · rw [h1.1] at hrec; cases hrec
  | recordSettlement hph =>
    intro hu
    rcases h hu with h1 | h1
    · rw [h1.1] at hph; cases hph
    · rcases hi.unrecoveredPhase h1.1 with h2 | h2 <;> rw [h2] at hph <;> cases hph
  | settle hph =>
    intro hu
    rcases h hu with h1 | h1
    · rw [h1.1] at hph; cases hph
    · rcases hi.unrecoveredPhase h1.1 with h2 | h2 <;> rw [h2] at hph <;> cases hph
  | commitResult e rest hph =>
    intro hu
    rcases h hu with h1 | h1
    · rw [h1.1] at hph; cases hph
    · rcases hi.unrecoveredPhase h1.1 with h2 | h2 <;> rw [h2] at hph <;> cases hph
  | _ => fx_try h

theorem idleClean_step (hs : Safe s) (hi : Inv s) (st : Step P s t) :
    t.d.pending = none →
      (∀ x ∈ queued t.d, x ∈ t.g.abandoned) ∧ t.d.batch = [] ∧ unanswered t.d.history = [] ∧
        t.d.callKV = [] ∧ t.d.runKV = false := by
  have h := hi.idleClean
  cases st with
  | settle hph =>
    intro hp
    have hps : s.d.pending = some .settlement := by
      by_cases hps : s.d.pending = some .settlement
      · exact hps
      · simp [settleEff, hps] at hp
    obtain ⟨hb, hu⟩ := hi.settlingClean hph
    have hkv : s.d.callKV = [] := by
      apply List.eq_nil_iff_forall_not_mem.2
      intro c hc
      have := hi.callKVBatch c hc
      simp [batchCalls, hb] at this
    refine ⟨?_, ?_⟩
    · intro x hx; exact hi.settlingQueued hph hps x (by simpa [settleEff, queued] using hx)
    · simp [settleEff, hb, hu, hkv]
  | toolWrite c hc =>
    intro hp
    exfalso
    rcases hc with hc | hc
    · have hph : s.m.phase = .tools := by
        by_cases hph : s.m.phase = .tools
        · exact hph
        · rw [hi.runningTools hph] at hc; cases hc
      exact hs.activeWhileRunning (by rw [hph]; simp) hp
    · have hb := (h (by simpa [toolWriteEff] using hp)).2.1
      have := hi.zombiesBatch c hc
      simp [batchCalls, hb] at this
  | abort =>
    intro hp
    obtain ⟨hq, hrest⟩ := h (by simpa [abortEff] using hp)
    refine ⟨?_, by simpa [abortEff] using hrest⟩
    intro x hx; simp [abortEff, queued] at hx ⊢; right; simpa [queued] using hx
  | runWrite hph => intro hp; exact absurd hp (hs.activeWhileRunning hph)
  | toolRunWrite c hc =>
    intro hp
    exfalso
    rcases hc with hc | hc
    · have hph : s.m.phase = .tools := by
        by_cases hph : s.m.phase = .tools
        · exact hph
        · rw [hi.runningTools hph] at hc; cases hc
      exact hs.activeWhileRunning (by rw [hph]; simp) hp
    · have hb := (h (by simpa [toolRunWriteEff] using hp)).2.1
      have := hi.zombiesBatch c hc
      simp [batchCalls, hb] at this
  | completeBlock p hph =>
    intro hp; exact absurd hp (hs.activeWhileRunning (by rw [hph]; simp))
  | commitResult e rest hph =>
    intro hp
    exfalso
    by_cases hr : rest = []
    · simp [commitResultEff, hr] at hp
    · simp [commitResultEff, hr] at hp
      exact hs.activeWhileRunning (by rw [hph]; simp) hp
  | _ => fx_try h

theorem idleRecoveredClean_step (_hs : Safe s) (hi : Inv s) (st : Step P s t) :
    t.m.phase = .idle → t.m.recovered = true → t.d.batch = [] ∧ unanswered t.d.history = [] := by
  have h := hi.idleRecoveredClean
  cases st with
  | settle hph => intro _ _; simpa [settleEff] using hi.settlingClean hph
  | _ => fx_try h

theorem idleWorkScheduled_step (hi : Inv s) (st : Step P s t) :
    t.m.phase = .idle → t.m.recovered = true → t.d.pending ≠ none →
      t.m.turnRequested = true ∨ t.m.abortDropped = true ∨ t.m.reopened = true := by
  have h := hi.idleWorkScheduled
  cases st with
  | settle =>
    intro _ _ hp
    right; right
    by_cases hps : s.d.pending = some .settlement
    · simp [settleEff, hps] at hp
    · simp [settleEff, hps]
  | _ => fx_try h

theorem inv_step (hs : Safe s) (hi : Inv s) (st : Step P s t) : Inv t :=
  ⟨idleClean_step hs hi st, settlingClean_step hs hi st, settlingQueued_step hs hi st,
   droppedAbandoned_step hi st, abortQueued_step hs hi st, settlingDropped_step hs hi st, droppedQueued_step hs hi st, callKVBatch_step hs hi st,
   zombiesBatch_step hs hi st, runningBatch_step hs hi st, runningOpen_step hs hi st,
   runningTools_step hs hi st, resultsHaveCalls_step hs hi st,
   batchUnanswered_step hs hi st, unansweredInBatch_step hs hi st, resultsDup_step hs hi st,
   streamingInference_step hi st, streamingRecovered_step hi st, unrecoveredPhase_step hi st,
   streamingOpen_step hi st, uiOpen_step hs hi st, idleRecoveredClean_step hs hi st,
   idleWorkScheduled_step hi st⟩

/-- **Global inductive invariant.** -/
theorem inv_reachable (h : Reachable P s) : Inv s := by
  induction h with
  | init => exact inv_init
  | step hr st ih => exact inv_step (safe_reachable hr) ih st

/-- **The persisted active flag covers all work.** A store without an `owed` record has no
batch or unanswered call, no call-scoped tool state, and no run state, and every message still
queued in it was queued when an abort dropped the turn it had asked for. An owner that restores
only active agents strands nothing it was asked to run. -/
theorem settled_means_no_work (h : Reachable P s) (hp : s.d.pending = none) :
    (∀ x ∈ queued s.d, x ∈ s.g.abandoned) ∧ s.d.batch = [] ∧ unanswered s.d.history = [] ∧
      s.d.callKV = [] ∧ s.d.runKV = false :=
  (inv_reachable h).idleClean hp

/-- Without an abort, a settled store has nothing queued. -/
theorem settled_without_abort_has_empty_queue (h : Reachable P s) (hp : s.d.pending = none)
    (ha : s.g.abandoned = []) : s.d.steer = [] ∧ s.d.send = [] := by
  have hq := (settled_means_no_work h hp).1
  rw [ha] at hq
  have : queued s.d = [] := List.eq_nil_iff_forall_not_mem.2 fun x hx => by simpa using hq x hx
  simpa [queued] using this

/-- **No pending tool state survives a settled turn**: call-scoped state only exists for calls
still in the durable batch. -/
theorem call_state_only_for_pending_calls (h : Reachable P s) :
    ∀ c ∈ s.d.callKV, c ∈ batchCalls s.d :=
  (inv_reachable h).callKVBatch

/-- **Every tool result follows its call, exactly once.** In particular no stream that ends
early leaves a result behind for a call the store never recorded. -/
theorem results_answer_calls_once (h : Reachable P s) :
    (∀ c ∈ results s.d.history, c ∈ calls s.d.history) ∧ (results s.d.history).Nodup :=
  ⟨(inv_reachable h).resultsHaveCalls, dup1_nodup (inv_reachable h).resultsDup⟩

/-- **Block reset**: once a restarted instance has taken up the store, and whenever nothing is
streaming, no listener is left showing an unfinished block. -/
theorem no_dangling_block_after_restart (h : Reachable P s)
    (hr : s.m.recovered = true) (hph : s.m.phase ≠ .streaming) : s.g.uiOpen = false := by
  cases hu : s.g.uiOpen with
  | false => rfl
  | true =>
    rcases (inv_reachable h).uiOpen hu with h1 | h1
    · exact absurd h1.1 hph
    · rw [hr] at h1; cases h1.1

/-- **A live owner never strands owed work.** Whenever the store says the agent is working and
this instance, having taken up the store, has no run in flight, a run is scheduled: the step
that starts one — a turn, or the settle-only run after an abort — is enabled. `start` is only
enabled where the code starts a run, so the store can never end at pending work with nothing
running in this process. -/
theorem owed_work_is_scheduled (h : Reachable P s) (hph : s.m.phase = .idle)
    (hr : s.m.recovered = true) (hp : s.d.pending ≠ none) :
    ∃ t, Step P s t ∧ t.m.phase ≠ .idle := by
  have hi := inv_reachable h
  obtain ⟨hb, hu⟩ := hi.idleRecoveredClean hph hr
  by_cases htr : s.m.turnRequested = true
  · exact ⟨_, .start hph (Or.inl htr), by simp [startEff]⟩
  rcases hi.idleWorkScheduled hph hr hp with h1 | h1 | h1
  · exact absurd h1 htr
  · exact ⟨_, .settleAbandoned hph hr h1 (by simpa using htr) hp hb hu,
      by simp [settleAbandonedEff]⟩
  · exact ⟨_, .start hph (Or.inr (Or.inl h1)), by simp [startEff]⟩

/-- **The interruption record survives until the restart has read it.** While the instance has
not made its one-time interruption check (`recover`), no transition — every one is covered —
replaces an inference stage with another stage or retires its open request. So whatever runs
first on a restarted instance, and wherever it crashes, the next instance inherits the record
that decides the `block_reset`. -/
theorem unrecovered_keeps_interruption_record (h : Reachable P s) (st : Step P s t)
    (hr : s.m.recovered = false) (hp : s.d.pending = some .inference) :
    (t.d.pending = some .inference ∧ t.d.requestOpen = s.d.requestOpen) ∨
      t.m.recovered = true := by
  have hi := inv_reachable h
  have notStreaming : s.m.phase ≠ .streaming := fun hph => by
    rw [hi.streamingRecovered hph] at hr; cases hr
  cases st with
  | recover => right; simp [recoverEff]
  | consume _ _ _ _ _ _ hrec => rw [hr] at hrec; cases hrec
  | beginInference _ hrec => rw [hr] at hrec; cases hrec
  | dispatch _ hrec => rw [hr] at hrec; cases hrec
  | settleUnanswered _ hrec => rw [hr] at hrec; cases hrec
  | decideSettle _ hrec => rw [hr] at hrec; cases hrec
  | settleAbandoned _ hrec => rw [hr] at hrec; cases hrec
  | enterCompaction _ hrec => rw [hr] at hrec; cases hrec
  | compact _ hrec => rw [hr] at hrec; cases hrec
  | finish hph => exact absurd hph notStreaming
  | truncate hph => exact absurd hph notStreaming
  | cancel hph => exact absurd hph notStreaming
  | recordSettlement hph =>
    rcases hi.unrecoveredPhase hr with h1 | h1 <;> rw [h1] at hph <;> cases hph
  | settle hph =>
    rcases hi.unrecoveredPhase hr with h1 | h1 <;> rw [h1] at hph <;> cases hph
  | commitResult _ _ hph =>
    rcases hi.unrecoveredPhase hr with h1 | h1 <;> rw [h1] at hph <;> cases hph
  | toolCommit _ hph =>
    rcases hi.unrecoveredPhase hr with h1 | h1 <;> rw [h1] at hph <;> cases hph
  | _ => left; simp_all [enqueueEff, startEff, showPartialEff, completeBlockEff, execStartEff,
      refuseEff, returnEff, abortEntryEff, zombieExitEff, toolWriteEff, toolRunWriteEff,
      runWriteEff, abortEff, newTurnEff, beginTurnEff, failTurnEff, crashEff]

end

end AgentBaseVerification
