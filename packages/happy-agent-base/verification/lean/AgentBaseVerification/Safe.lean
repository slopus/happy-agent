import AgentBaseVerification.Lemmas

set_option linter.unusedSimpArgs false

namespace AgentBaseVerification

/-- No value occurs twice. Stated with `count` so arithmetic can reason about it; `dup1_nodup`
turns it into `List.Nodup`. -/
def Dup1 (l : List Nat) : Prop := ∀ x, l.count x ≤ 1

theorem dup1_nodup {l : List Nat} (h : Dup1 l) : l.Nodup := by
  induction l with
  | nil => exact List.nodup_nil
  | cons a l ih =>
    rw [List.nodup_cons]
    have ha := h a
    simp [List.count_cons] at ha
    refine ⟨?_, ih fun x => ?_⟩
    · intro hm; have := List.count_pos_iff.2 hm; omega
    · have := h x; simp [List.count_cons] at this; omega

theorem dup1_disjoint {a b : List Nat} (h : Dup1 (a ++ b)) {x : Nat} (ha : x ∈ a) : x ∉ b := by
  intro hb
  have hx := h x
  rw [List.count_append] at hx
  have := List.count_pos_iff.2 ha
  have := List.count_pos_iff.2 hb
  omega

theorem count_zero_of_not_mem {l : List Nat} {x : Nat} (h : x ∉ l) : l.count x = 0 :=
  List.count_eq_zero.2 h

/-- The first inductive invariant of the model: identities, loss, and tool bookkeeping. -/
structure Safe (s : State) : Prop where
  /-- No message identity is queued twice, recorded twice, or both queued and recorded. -/
  msgsDup : Dup1 (msgs s.d)
  /-- Every queued or recorded message still holds its `message.<id>` identity key. -/
  msgsIds : ∀ x ∈ msgs s.d, x ∈ s.d.ids
  /-- An accepted message is queued, in the conversation, or was erased by a deliberate
  history replacement. -/
  noLoss : ∀ x ∈ s.g.accepted, x ∈ msgs s.d ∨ x ∈ s.g.released
  /-- While a run loop exists, the store says the agent is active. -/
  activeWhileRunning : s.m.phase ≠ .idle → s.d.pending ≠ none
  callsDup : Dup1 (calls s.d.history ++ partialCalls s.m.unfinished)
  callsIssued : ∀ c ∈ calls s.d.history ++ partialCalls s.m.unfinished ++ batchCalls s.d,
      c ∈ s.g.issued
  execsIssued : ∀ c ∈ s.g.execs, c ∈ s.g.issued
  /-- The unfinished block was never executed. -/
  partialNotExec : ∀ c ∈ partialCalls s.m.unfinished, c ∉ s.g.execs
  partialStreaming : s.m.unfinished ≠ none → s.m.phase = .streaming
  streamingBatch : s.m.phase = .streaming → s.d.batch = []
  batchDup : Dup1 (batchCalls s.d)
  /-- An executed call still owed a result is running, finished in memory, or its batch was
  restored from the store (so non-retryable calls are refused). -/
  execResumed : s.m.phase = .tools → ∀ c ∈ s.g.execs, (⟨c, false⟩ : Entry) ∈ s.d.batch →
      c ∈ s.m.running ∨ c ∈ s.m.finished ∨ s.m.resume = true
  /-- An executed call is either still in the durable batch or no longer owed anything. -/
  execTracked : ∀ c ∈ s.g.execs, c ∈ batchCalls s.d ∨ c ∉ unanswered s.d.history

theorem safe_init : Safe init := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;>
    simp [init, msgs, queued, freshMemory, partialCalls, batchCalls, Dup1]

section
variable {P : Params} {s t : State}

theorem msgsDup_step (hs : Safe s) (st : Step P s t) : Dup1 (msgs t.d) := by
  have h := hs.msgsDup
  cases st with
  | enqueue b m hm =>
    have hm0 : (msgs s.d).count m = 0 :=
      count_zero_of_not_mem fun hx => hm (hs.msgsIds m hx)
    intro x
    have hx := h x
    cases b <;> simp only [enqueueEff, msgs, queued, List.count_append, List.count_cons,
      List.count_nil, ite_true, ite_false, Bool.false_eq_true] at hx hm0 ⊢ <;>
      (by_cases hxm : m = x <;> simp [hxm] at hx hm0 ⊢ <;> omega)
  | consume m st' sd' reset c? _ _ _ _ _ hpop _ =>
    have hq := pop_spec hpop
    intro x
    have hx := h x
    simp only [msgs, queued, hq] at hx
    cases reset <;> cases c? <;>
      simp [consumeEff, msgs, queued, optCall, List.count_append, List.count_cons] at hx ⊢ <;>
      (by_cases hxm : m = x <;> simp [hxm] at hx ⊢ <;> omega)
  | compact =>
    intro x
    have hx := h x
    simp [compactEff, enterCompactionEff, msgs, queued, List.count_append] at hx ⊢
    omega
  | truncate => exact h
  | completeBlock p => cases p <;> simpa [completeBlockEff, msgs, queued, toBlock] using h
  | commitResult e rest => simpa [commitResultEff, msgs, queued] using h
  | _ => exact h

theorem msgsIds_step (hs : Safe s) (st : Step P s t) : ∀ x ∈ msgs t.d, x ∈ t.d.ids := by
  have h := hs.msgsIds
  cases st with
  | enqueue b m hm =>
    intro x hx
    cases b <;> simp [enqueueEff, msgs, queued] at hx ⊢ <;> grind [msgs, queued]
  | consume m st' sd' reset c? _ _ _ _ _ hpop _ =>
    have hq := pop_spec hpop
    have hd := hs.msgsDup
    simp only [msgs, queued, hq] at h hd
    have hdis : ∀ y, y ∈ m :: (st' ++ sd') → y ∉ userIds s.d.history :=
      fun y hy => dup1_disjoint hd hy
    simp only [List.mem_append, List.mem_cons] at h hdis
    intro x hx
    cases reset <;> cases c? <;> simp [consumeEff, msgs, queued, optCall] at hx ⊢ <;> grind
  | compact =>
    have hd := hs.msgsDup
    intro x hx
    simp [compactEff, enterCompactionEff, msgs, queued] at hx ⊢
    have hq : x ∈ queued s.d := by simp [queued, hx]
    exact ⟨h x (by simp [msgs, hq]), dup1_disjoint hd hq⟩
  | truncate => exact h
  | completeBlock p => cases p <;> simpa [completeBlockEff, msgs, queued, toBlock] using h
  | commitResult e rest => simpa [commitResultEff, msgs, queued] using h
  | _ => exact h

theorem noLoss_step (hs : Safe s) (st : Step P s t) :
    ∀ x ∈ t.g.accepted, x ∈ msgs t.d ∨ x ∈ t.g.released := by
  have h := hs.noLoss
  cases st with
  | enqueue b m hm =>
    intro x hx
    simp [enqueueEff] at hx
    rcases hx with hx | rfl
    · rcases h x hx with h1 | h1
      · left; cases b <;> simp [enqueueEff, msgs, queued] at h1 ⊢ <;> grind
      · right; exact h1
    · left; cases b <;> simp [enqueueEff, msgs, queued]
  | consume m st' sd' reset c? _ _ _ _ _ hpop _ =>
    have hq := pop_spec hpop
    intro x hx
    rcases h x hx with h1 | h1
    · simp only [msgs, queued, hq] at h1
      cases reset <;> cases c? <;> simp [consumeEff, msgs, queued, optCall] at h1 ⊢ <;> grind
    · cases reset <;> cases c? <;> simp [consumeEff, h1]
  | compact =>
    intro x hx
    rcases h x hx with h1 | h1
    · simp [msgs] at h1
      rcases h1 with h1 | h1
      · left; simpa [compactEff, enterCompactionEff, msgs, queued] using h1
      · right; simp [compactEff, enterCompactionEff, h1]
    · right; simp [compactEff, enterCompactionEff, h1]
  | truncate => exact h
  | completeBlock p => cases p <;> simpa [completeBlockEff, msgs, queued, toBlock] using h
  | commitResult e rest => simpa [commitResultEff, msgs, queued] using h
  | _ => exact h

/-- Generic per-case attempt: unfold whichever effect produced the new state and close with the
old invariant. -/
macro "step_simp" : tactic => `(tactic| (simp_all [enqueueEff, startEff, recoverEff, consumeEff, beginInferenceEff, showPartialEff, completeBlockEff, finishEff, truncateEff, cancelEff, dispatchEff, settleUnansweredEff, execStartEff, refuseEff, returnEff, toolCommitEff, abortEntryEff, zombieExitEff, toolWriteEff, commitResultEff, runWriteEff, abortEff, newTurnEff, beginTurnEff, failTurnEff, decideSettleEff, recordSettlementEff, settleAbandonedEff, toolRunWriteEff, settleEff, compactEff, enterCompactionEff, crashEff, freshMemory, msgs, queued, batchCalls, toBlock] <;> (try (split <;> simp_all))))

theorem activeWhileRunning_step (hs : Safe s) (st : Step P s t) :
    t.m.phase ≠ .idle → t.d.pending ≠ none := by
  have h := hs.activeWhileRunning
  cases st
  all_goals first
    | exact h
    | (intro hp; step_simp)
    | (intro hp; step_simp; done)

theorem callsIssued_step (hs : Safe s) (st : Step P s t) :
    ∀ c ∈ calls t.d.history ++ partialCalls t.m.unfinished ++ batchCalls t.d, c ∈ t.g.issued := by
  have h0 := hs.callsIssued
  have h := hs.callsIssued
  simp only [List.mem_append] at h
  cases st with
  | consume m st' sd' reset c? _ _ _ hb _ _ _ =>
    intro c hc
    cases reset <;> cases c? <;> simp [consumeEff, batchCalls, hb] at hc ⊢ <;> grind
  | completeBlock p _ hp =>
    intro c hc
    cases p <;> simp [completeBlockEff, toBlock, hp, batchCalls] at hc h ⊢ <;> grind
  | dispatch _ _ hb _ =>
    intro c hc
    simp [dispatchEff, batchCalls, hb, mem_unanswered] at hc h ⊢ <;> grind
  | settleUnanswered _ _ hb _ =>
    intro c hc
    simp [settleUnansweredEff, batchCalls, hb, mem_unanswered] at hc h ⊢ <;> grind
  | _ => first | exact h0 | (step_simp; done) | (step_simp; grind)
  all_goals first
    | exact h
    | (step_simp; done)
    | (step_simp; grind)

theorem execsIssued_step (hs : Safe s) (st : Step P s t) :
    ∀ c ∈ t.g.execs, c ∈ t.g.issued := by
  have h := hs.execsIssued
  cases st with
  | execStart c _ _ hmem _ _ _ =>
    intro x hx
    simp [execStartEff] at hx ⊢
    rcases hx with hx | rfl
    · exact h x hx
    · exact hs.callsIssued x (List.mem_append_right _ (List.mem_map.2 ⟨_, hmem, rfl⟩))
  | _ => first | exact h | (step_simp; done) | (step_simp; grind)

theorem partialNotExec_step (hs : Safe s) (st : Step P s t) :
    ∀ c ∈ partialCalls t.m.unfinished, c ∉ t.g.execs := by
  have h := hs.partialNotExec
  cases st with
  | showPartial p _ hn hfresh =>
    intro x hx hex
    cases p with
    | text => simp [showPartialEff] at hx
    | call c =>
      simp [showPartialEff] at hx hex
      subst hx
      exact hfresh x rfl (hs.execsIssued x hex)
  | execStart c hph _ _ _ _ _ =>
    have hu : s.m.unfinished = none := by
      cases hu : s.m.unfinished with
      | none => rfl
      | some p =>
        have := hs.partialStreaming (by simp [hu])
        rw [hph] at this; cases this
    intro x hx
    have hx' : x ∈ partialCalls s.m.unfinished := hx
    simp [hu] at hx'
  | _ => first | exact h | (step_simp; done) | (step_simp; grind)

theorem partialStreaming_step (hs : Safe s) (st : Step P s t) :
    t.m.unfinished ≠ none → t.m.phase = .streaming := by
  have h := hs.partialStreaming
  cases st
  all_goals first
    | exact h
    | (step_simp; done)
    | (step_simp; grind)

theorem streamingBatch_step (hs : Safe s) (st : Step P s t) :
    t.m.phase = .streaming → t.d.batch = [] := by
  have h := hs.streamingBatch
  cases st
  all_goals first
    | exact h
    | (step_simp; done)
    | (step_simp; grind)

theorem partial_none_of_not_streaming (hs : Safe s) (h : s.m.phase ≠ .streaming) :
    s.m.unfinished = none := by
  cases hu : s.m.unfinished with
  | none => rfl
  | some p => exact absurd (hs.partialStreaming (by simp [hu])) h

theorem fresh_not_in_pool (hs : Safe s) {c : Call} (hc : c ∉ s.g.issued) :
    (calls s.d.history ++ partialCalls s.m.unfinished).count c = 0 :=
  count_zero_of_not_mem fun hm => hc (hs.callsIssued c (List.mem_append_left _ hm))

theorem callsDup_step (hs : Safe s) (st : Step P s t) :
    Dup1 (calls t.d.history ++ partialCalls t.m.unfinished) := by
  have h := hs.callsDup
  cases st with
  | consume m st' sd' reset c? hph _ _ _ _ _ hfresh =>
    have hu := partial_none_of_not_streaming hs (by simp [hph])
    intro x
    have hxo := h x
    cases c? with
    | none =>
      cases reset <;> simp [consumeEff, hu, List.count_append] at hxo ⊢ <;> omega
    | some c =>
      have h0 := fresh_not_in_pool hs (hfresh c rfl)
      cases reset <;> simp [consumeEff, hu, List.count_append, List.count_cons] at hxo h0 ⊢ <;>
        (by_cases hxc : c = x <;> simp [hxc] at hxo h0 ⊢ <;> omega)
  | showPartial p _ hn hfresh =>
    intro x
    have hxo := h x
    cases p with
    | text => simpa [showPartialEff, hn] using hxo
    | call c =>
      have h0 := fresh_not_in_pool hs (hfresh c rfl)
      simp [showPartialEff, hn, List.count_append, List.count_cons] at hxo h0 ⊢
      by_cases hxc : c = x <;> simp [hxc] at hxo h0 ⊢ <;> omega
  | completeBlock p _ hp =>
    intro x
    have hxo := h x
    cases p <;> simp [completeBlockEff, hp, toBlock, List.count_append, List.count_cons] at hxo ⊢ <;> omega
  | finish =>
    intro x; have hxo := h x
    simp [finishEff, List.count_append] at hxo ⊢; omega
  | cancel =>
    intro x; have hxo := h x
    simp [cancelEff, List.count_append] at hxo ⊢; omega
  | truncate =>
    intro x; have hxo := h x
    simp [truncateEff, List.count_append] at hxo ⊢; omega
  | start =>
    intro x; have hxo := h x
    simp [startEff, List.count_append] at hxo ⊢; omega
  | crash =>
    intro x; have hxo := h x
    simp [crashEff, freshMemory, List.count_append] at hxo ⊢; omega
  | settleUnanswered =>
    intro x; have hxo := h x
    simp [settleUnansweredEff, List.count_append] at hxo ⊢; omega
  | compact =>
    intro x; have hxo := h x
    simp [compactEff, enterCompactionEff, List.count_append] at hxo ⊢; omega
  | commitResult e rest =>
    intro x; have hxo := h x
    simpa [commitResultEff] using hxo
  | beginInference hph =>
    have hu := partial_none_of_not_streaming hs (by simp [hph])
    simpa [beginInferenceEff, hu] using h
  | _ => exact h

theorem batchDup_step (hs : Safe s) (st : Step P s t) : Dup1 (batchCalls t.d) := by
  have h := hs.batchDup
  have hc := hs.callsDup
  cases st with
  | dispatch =>
    intro x
    have h1 := List.Sublist.count_le x (unanswered_sublist s.d.history)
    have h2 := hc x
    simp [dispatchEff, batchCalls, List.count_append] at h1 h2 ⊢
    omega
  | settleUnanswered =>
    intro x
    have h1 := List.Sublist.count_le x (unanswered_sublist s.d.history)
    have h2 := hc x
    simp [settleUnansweredEff, batchCalls, List.count_append] at h1 h2 ⊢
    omega
  | toolCommit c =>
    simpa [toolCommitEff, batchCalls] using h
  | commitResult e rest _ hb _ =>
    intro x
    have h1 := h x
    simp [batchCalls, hb, List.count_cons] at h1
    simp [commitResultEff, batchCalls]
    omega
  | _ => exact h

theorem mem_unanswered_result {x c : Call} {h : List Record} :
    x ∈ unanswered (h ++ [Record.result c]) ↔ x ∈ unanswered h ∧ x ≠ c := by
  simp [mem_unanswered]; constructor <;> intro hh <;> simp_all

theorem execTracked_step (hs : Safe s) (st : Step P s t) :
    ∀ c ∈ t.g.execs, c ∈ batchCalls t.d ∨ c ∉ unanswered t.d.history := by
  have h := hs.execTracked
  cases st with
  | execStart c _ _ hmem _ _ _ =>
    intro x hx
    simp [execStartEff] at hx
    rcases hx with hx | rfl
    · exact h x hx
    · left; exact List.mem_map.2 ⟨_, hmem, rfl⟩
  | commitResult e rest _ hb _ =>
    intro x hx
    rcases h x hx with h1 | h1
    · simp [batchCalls, hb] at h1
      rcases h1 with rfl | h1
      · right; simp [commitResultEff, mem_unanswered_result]
      · left; simp [commitResultEff, batchCalls]; exact h1
    · right
      simp [commitResultEff, mem_unanswered_result] at h1 ⊢
      intro hu; exact absurd hu h1
  | completeBlock p _ hp =>
    intro x hx
    rcases h x hx with h1 | h1
    · left; exact h1
    · right
      have hne : ∀ c, p = .call c → x ≠ c := by
        intro c hpc hxc; subst hpc; subst hxc
        exact hs.partialNotExec x (by simp [hp]) hx
      cases p with
      | text => simpa [completeBlockEff, toBlock, mem_unanswered] using h1
      | call c =>
        have := hne c rfl
        simp [completeBlockEff, toBlock, mem_unanswered] at h1 ⊢
        grind
  | consume m st' sd' reset c? hph _ _ hb hu _ hfresh =>
    intro x hx
    right
    have hxe : ∀ c, c? = some c → x ≠ c := by
      intro c hc hxc; subst hxc
      exact hfresh x hc (hs.execsIssued x hx)
    have hux : x ∉ unanswered s.d.history := by simp [hu]
    rw [mem_unanswered] at hux
    cases reset <;> cases c? <;> simp [consumeEff, mem_unanswered] at hxe ⊢ <;> grind
  | truncate hph =>
    intro x hx
    rcases h x hx with h1 | h1
    · left; exact h1
    · right
      simpa [truncateEff] using h1
  | dispatch _ _ hb _ =>
    intro x hx
    by_cases hu : x ∈ unanswered s.d.history
    · left; simp [dispatchEff, batchCalls, hu]
    · right; simp [dispatchEff, hu]
  | settleUnanswered =>
    intro x hx
    by_cases hu : x ∈ unanswered s.d.history
    · left; simpa [settleUnansweredEff, batchCalls] using hu
    · right; simp [settleUnansweredEff, hu]
  | toolCommit c =>
    simpa [toolCommitEff, batchCalls] using h
  | compact =>
    intro x _; right; simp [compactEff, enterCompactionEff, mem_unanswered]
  | start => simpa [startEff] using h
  | crash => simpa [crashEff] using h
  | _ => exact h

theorem execResumed_step (hs : Safe s) (st : Step P s t) :
    t.m.phase = .tools → ∀ c ∈ t.g.execs, (⟨c, false⟩ : Entry) ∈ t.d.batch →
      c ∈ t.m.running ∨ c ∈ t.m.finished ∨ t.m.resume = true := by
  have h := hs.execResumed
  cases st with
  | recover =>
    intro hph x _ _
    right; right
    simp [recoverEff] at hph ⊢
    exact hph
  | dispatch _ _ hb _ =>
    intro _ x hx hm
    exfalso
    simp [dispatchEff] at hm
    rcases hs.execTracked x hx with h1 | h1
    · simp [batchCalls, hb] at h1
    · exact h1 hm
  | settleUnanswered =>
    intro _ x _ hm
    simp [settleUnansweredEff] at hm
  | execStart c hph =>
    intro _ x hx hm
    simp [execStartEff] at hx ⊢
    rcases hx with hx | rfl
    · rcases h hph x hx hm with h1 | h1 | h1
      · left; left; exact h1
      · right; left; exact h1
      · right; right; exact h1
    · left; right; rfl
  | refuse c hph =>
    intro _ x hx hm
    rcases h hph x hx hm with h1 | h1 | h1
    · left; exact h1
    · right; left; simp [refuseEff, h1]
    · right; right; exact h1
  | toolReturn c =>
    intro hph x hx hm
    by_cases hxc : x = c
    · right; left; simp [returnEff, hxc]
    · rcases h hph x hx hm with h1 | h1 | h1
      · left; simp [returnEff, hxc, h1]
      · right; left; simp [returnEff, h1]
      · right; right; exact h1
  | toolCommit c =>
    intro hph x hx hm
    simp [toolCommitEff] at hm
    obtain ⟨e, he, hee⟩ := hm
    have hxc : x ≠ c := by
      intro hxc; subst hxc
      by_cases hh : e.call = x
      · simp [hh] at hee
      · simp [hh] at hee; subst hee; simp at hh
    have hm' : (⟨x, false⟩ : Entry) ∈ s.d.batch := by
      by_cases hh : e.call = c
      · simp [hh] at hee
      · simp [hh] at hee; rw [← hee]; exact he
    rcases h hph x hx hm' with h1 | h1 | h1
    · left; simp [toolCommitEff, hxc, h1]
    · right; left; simp [toolCommitEff, h1]
    · right; right; exact h1
  | abortEntry c hph =>
    intro _ x hx hm
    by_cases hxc : x = c
    · right; left; simp [abortEntryEff, hxc]
    · rcases h hph x hx hm with h1 | h1 | h1
      · left; simp [abortEntryEff, hxc, h1]
      · right; left; simp [abortEntryEff, h1]
      · right; right; exact h1
  | commitResult e rest hph hb _ =>
    intro hph' x hx hm
    have hr : rest ≠ [] := by
      intro hr; simp [commitResultEff, hr] at hph'
    simp [commitResultEff] at hm
    have hxe : x ≠ e.call := by
      intro hxe
      have hd := hs.batchDup e.call
      have hin : e.call ∈ rest.map Entry.call := hxe ▸ List.mem_map.2 ⟨_, hm, rfl⟩
      have hpos := List.count_pos_iff.2 hin
      simp only [batchCalls, hb, List.map_cons, List.count_cons, beq_self_eq_true, ite_true] at hd
      omega
    have hm' : (⟨x, false⟩ : Entry) ∈ s.d.batch := by simp [hb, hm]
    rcases h hph x hx hm' with h1 | h1 | h1
    · left; exact h1
    · right; left; simp [commitResultEff, h1, hxe]
    · right; right; exact h1
  | _ => first | exact h | (intro hph; step_simp; done) | (intro hph; simp_all [startEff, crashEff, freshMemory, beginInferenceEff, showPartialEff, completeBlockEff, finishEff, truncateEff, cancelEff, consumeEff, decideSettleEff, recordSettlementEff, settleAbandonedEff, toolRunWriteEff, settleEff, compactEff, enterCompactionEff])

theorem safe_step (hs : Safe s) (st : Step P s t) : Safe t :=
  ⟨msgsDup_step hs st, msgsIds_step hs st, noLoss_step hs st, activeWhileRunning_step hs st,
   callsDup_step hs st, callsIssued_step hs st, execsIssued_step hs st, partialNotExec_step hs st,
   partialStreaming_step hs st, streamingBatch_step hs st, batchDup_step hs st,
   execResumed_step hs st, execTracked_step hs st⟩

end

/-! ## Theorems -/

section
variable {P : Params} {s : State}

/-- **Global inductive invariant.** Every state reachable by any finite trace — any
interleaving of callers, run-loop steps, tool executions, aborts, crashes and restarts —
satisfies `Safe`. -/
theorem safe_reachable (h : Reachable P s) : Safe s := by
  induction h with
  | init => exact safe_init
  | step _ st ih => exact safe_step ih st

/-- No message identity is ever queued twice, answered twice, or both queued and in the
conversation — across any number of crashes and restarts. -/
theorem no_duplicate_messages (h : Reachable P s) : (msgs s.d).Nodup :=
  dup1_nodup (safe_reachable h).msgsDup

/-- **No accepted message is lost.** Every delivery answered `"created"` is still queued or in
the conversation, unless a deliberate history replacement (compaction or model/profile reset)
erased it — and never by a crash. -/
theorem accepted_never_lost (h : Reachable P s) :
    ∀ x ∈ s.g.accepted, x ∈ queued s.d ∨ x ∈ userIds s.d.history ∨ x ∈ s.g.released := by
  intro x hx
  rcases (safe_reachable h).noLoss x hx with h1 | h1
  · simp [msgs] at h1; rcases h1 with h1 | h1
    · exact Or.inl h1
    · exact Or.inr (Or.inl h1)
  · exact Or.inr (Or.inr h1)

/-- A repeated delivery of a message that is queued or in the conversation hits its identity
key. `Step.enqueue` requires the identity to be absent, so such a delivery can only take
`Step.enqueueDup`, which leaves the whole state unchanged (the answer is `"existing"`). -/
theorem redelivery_is_ignored (h : Reachable P s) {x : Msg} (hx : x ∈ msgs s.d) :
    x ∈ s.d.ids :=
  (safe_reachable h).msgsIds x hx

/-- While a run loop exists, the store says the agent is active. -/
theorem active_while_running (h : Reachable P s) : s.m.phase ≠ .idle → s.d.pending ≠ none :=
  (safe_reachable h).activeWhileRunning

/-- **Non-retryable tools never run twice**, in particular never again after a crash: every
execution of a call whose tool is neither `durable` nor `reloadable` happens at most once in
the whole history of the store. -/
theorem non_retryable_executes_at_most_once (h : Reachable P s) {c : Call}
    (hc : P.retryable c = false) : s.g.execs.count c ≤ 1 := by
  induction h with
  | init => simp [init]
  | @step s t hr st ih =>
    have hs := safe_reachable hr
    cases st with
    | execStart x hph _ hm hnr hnf hres =>
      simp only [execStartEff, List.count_append, List.count_cons, List.count_nil]
      by_cases hxc : x = c
      · subst hxc
        have h0 : s.g.execs.count x = 0 := by
          apply count_zero_of_not_mem
          intro hx
          rcases hs.execResumed hph x hx hm with h1 | h1 | h1
          · exact hnr h1
          · exact hnf h1
          · rcases hres with h2 | h2
            · rw [h1] at h2; cases h2
            · rw [hc] at h2; cases h2
        simp [h0]
      · simp [hxc]; exact ih
    | _ => first | exact ih | (simp_all [enqueueEff, startEff, recoverEff, consumeEff, beginInferenceEff, showPartialEff, completeBlockEff, finishEff, truncateEff, cancelEff, dispatchEff, settleUnansweredEff, refuseEff, returnEff, toolCommitEff, abortEntryEff, zombieExitEff, toolWriteEff, commitResultEff, runWriteEff, abortEff, newTurnEff, beginTurnEff, failTurnEff, decideSettleEff, recordSettlementEff, settleAbandonedEff, toolRunWriteEff, settleEff, compactEff, enterCompactionEff, crashEff])

/-- The block being streamed is never in the store: history holds only completed blocks. -/
theorem unfinished_block_not_persisted (h : Reachable P s) {c : Call}
    (hu : s.m.unfinished = some (.call c)) : c ∉ calls s.d.history := by
  have hd := (safe_reachable h).callsDup c
  intro hc
  have := List.count_pos_iff.2 hc
  simp [hu, List.count_append] at hd
  omega

/-- A crash changes nothing durable: an interrupted stream, tool, or run loses only memory. -/
theorem crash_keeps_store (s : State) : (crashEff s).d = s.d := rfl

/-- Restart after a crash: the reloaded instance reads exactly the stored `owed` record and
starts idle, and the resulting state is again consistent. -/
theorem restart_consistent (h : Reachable P s) :
    (crashEff s).m.inherited = s.d.pending ∧ (crashEff s).m.phase = .idle ∧
      Safe (crashEff s) :=
  ⟨rfl, rfl, safe_reachable (Reachable.step h Step.crash)⟩

end

end AgentBaseVerification
