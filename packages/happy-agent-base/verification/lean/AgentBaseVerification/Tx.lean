/-!
# Transactions

A model of one agent store's transaction boundary, independent of what the store holds.

Code mapping:

* `begin`      — `AgentPersistence.transaction` / `inTx` opening the one outer transaction
                 (`sources/inTx.ts: inTx`, `sources/AgentDatabaseConnection.ts`).
* `exec`       — one statement (`writeValue`, `deleteValue`, `append`, `clearRecords`, …) run on
                 the transaction's context.
* `nest`       — `inTx` called with a context that already carries a transaction: the work is
                 appended to the same transaction instead of opening another one
                 (`inTx.ts`: "Nested calls reuse the current transaction").
* `later`      — `afterCommit(txCtx, …)`: a callback staged on the transaction.
* `commit`     — the transaction body resolved; staged callbacks drain after the commit.
* `rollback`   — the body threw (for example a `…Transact` hook failed).
* `crash`      — the process died; the database discards the open transaction.
* `rootWrite`  — a statement outside any transaction. The connection's root-operation FIFO never
                 runs it while a transaction is open (`AgentDatabaseConnection.ts`), so it is
                 enabled only when no transaction is open.

`cache` models the in-memory mirror that `AgentBase.#recordTransaction` keeps of the pending
record: code updates it eagerly inside the transaction and restores it when the transaction
rolls back. A crash loses memory and the next process reloads it from disk.

The main model (`Model.lean`) treats every committed transaction as one atomic step. The
theorems here are what justify that: a transaction is observed on disk either not at all or
completely, and post-commit work runs only for transactions that committed.
-/

namespace AgentBaseVerification.Tx

/-- Apply a transaction's statements in order. -/
def applyAll {σ : Type} : List (σ → σ) → σ → σ
  | [], s => s
  | op :: ops, s => applyAll ops (op s)

theorem applyAll_append {σ : Type} (a b : List (σ → σ)) (s : σ) :
    applyAll (a ++ b) s = applyAll b (applyAll a s) := by
  induction a generalizing s with
  | nil => rfl
  | cons op ops ih => exact ih (op s)

/-- One open transaction. `base` is the disk when it began (a ghost for the proofs). -/
structure Open (σ : Type) where
  base : σ
  ops : List (σ → σ)
  done : Nat
  staged : List Nat

/-- The working copy the transaction's own reads observe. -/
def Open.work {σ : Type} (o : Open σ) : σ := applyAll (o.ops.take o.done) o.base

structure Sys (σ : Type) where
  disk : σ
  tx : Option (Open σ)
  cache : σ
  /-- Post-commit callbacks that actually ran, in order. -/
  published : List Nat
  /-- Every callback staged by a transaction that committed (ghost). -/
  committedHooks : List Nat

inductive Step {σ : Type} : Sys σ → Sys σ → Prop
  | begin (s : Sys σ) (ops : List (σ → σ)) :
      s.tx = none →
      Step s { s with tx := some ⟨s.disk, ops, 0, []⟩ }
  | exec (s : Sys σ) (o : Open σ) :
      s.tx = some o → o.done < o.ops.length →
      Step s { s with tx := some { o with done := o.done + 1 },
                      cache := applyAll (o.ops.take (o.done + 1)) o.base }
  | nest (s : Sys σ) (o : Open σ) (more : List (σ → σ)) :
      s.tx = some o →
      Step s { s with tx := some { o with ops := o.ops ++ more } }
  | later (s : Sys σ) (o : Open σ) (h : Nat) :
      s.tx = some o →
      Step s { s with tx := some { o with staged := o.staged ++ [h] } }
  | commit (s : Sys σ) (o : Open σ) :
      s.tx = some o → o.done = o.ops.length →
      Step s { disk := applyAll o.ops o.base, tx := none, cache := applyAll o.ops o.base,
               published := s.published ++ o.staged,
               committedHooks := s.committedHooks ++ o.staged }
  | rollback (s : Sys σ) (o : Open σ) :
      s.tx = some o →
      Step s { s with tx := none, cache := o.base }
  | crash (s : Sys σ) :
      Step s { s with tx := none, cache := s.disk }
  | rootWrite (s : Sys σ) (op : σ → σ) :
      s.tx = none →
      Step s { s with disk := op s.disk, cache := op s.disk }

inductive Reachable {σ : Type} (init : σ) : Sys σ → Prop
  | init : Reachable init ⟨init, none, init, [], []⟩
  | step {s t : Sys σ} : Reachable init s → Step s t → Reachable init t

/-- The invariant every reachable transaction system satisfies. -/
structure Inv {σ : Type} (s : Sys σ) : Prop where
  /-- While a transaction is open, the disk still holds exactly what it held when it began. -/
  diskFrozen : ∀ o, s.tx = some o → s.disk = o.base
  /-- While open, the in-memory mirror follows the transaction's working copy. -/
  cacheWork : ∀ o, s.tx = some o → s.cache = o.work
  /-- With no transaction open, the in-memory mirror equals the disk. -/
  cacheDisk : s.tx = none → s.cache = s.disk
  /-- A transaction never runs more statements than it has. -/
  doneLe : ∀ o, s.tx = some o → o.done ≤ o.ops.length
  /-- Post-commit work ran exactly for the callbacks of committed transactions. -/
  publishedCommitted : s.published = s.committedHooks

theorem inv_reachable {σ : Type} {init : σ} {s : Sys σ} (h : Reachable init s) : Inv s := by
  induction h with
  | init => exact ⟨by simp, by simp, by simp, by simp, rfl⟩
  | step _ st ih =>
    cases st with
    | begin ops hn =>
      refine ⟨?_, ?_, ?_, ?_, ih.publishedCommitted⟩
      · intro o ho; simp at ho; subst ho; rfl
      · intro o ho; simp at ho; subst ho; simp [Open.work, applyAll, ih.cacheDisk hn]
      · simp
      · intro o ho; simp at ho; subst ho; simp
    | exec o ho hlt =>
      refine ⟨?_, ?_, ?_, ?_, ih.publishedCommitted⟩
      · intro o' h'; simp at h'; subst h'; exact ih.diskFrozen o ho
      · intro o' h'; simp at h'; subst h'; rfl
      · simp
      · intro o' h'; simp at h'; subst h'; simp; omega
    | nest o more ho =>
      refine ⟨?_, ?_, ?_, ?_, ih.publishedCommitted⟩
      · intro o' h'; simp at h'; subst h'; exact ih.diskFrozen o ho
      · intro o' h'; simp at h'; subst h'
        have hd := ih.doneLe o ho
        simp [Open.work, List.take_append_of_le_length hd, ih.cacheWork o ho]
      · simp
      · intro o' h'; simp at h'; subst h'; have := ih.doneLe o ho; simp; omega
    | later o hk ho =>
      refine ⟨?_, ?_, ?_, ?_, ih.publishedCommitted⟩
      · intro o' h'; simp at h'; subst h'; exact ih.diskFrozen o ho
      · intro o' h'; simp at h'; subst h'; exact ih.cacheWork o ho
      · simp
      · intro o' h'; simp at h'; subst h'; exact ih.doneLe o ho
    | commit o ho hd =>
      refine ⟨by simp, by simp, by simp, by simp, ?_⟩
      simp [ih.publishedCommitted]
    | rollback o ho =>
      refine ⟨by simp, by simp, ?_, by simp, ih.publishedCommitted⟩
      intro _; exact (ih.diskFrozen o ho).symm
    | crash =>
      exact ⟨by simp, by simp, by simp, by simp, ih.publishedCommitted⟩
    | rootWrite op hn =>
      refine ⟨?_, ?_, by simp, ?_, ih.publishedCommitted⟩
      · intro o h'; simp [hn] at h'
      · intro o h'; simp [hn] at h'
      · intro o h'; simp [hn] at h'

/-- **Atomicity.** From any reachable state with an open transaction, every step leaves the disk
either exactly as it was before the transaction began, or exactly as the complete transaction
makes it. In particular a crash or rollback in the middle leaves the "before" state. -/
theorem atomic {σ : Type} {init : σ} {s t : Sys σ} {o : Open σ}
    (hr : Reachable init s) (ho : s.tx = some o) (st : Step s t) :
    t.disk = o.base ∨ t.disk = applyAll o.ops o.base := by
  have inv := inv_reachable hr
  have frozen := inv.diskFrozen o ho
  cases st with
  | begin _ hn => simp [ho] at hn
  | exec => left; exact frozen
  | nest => left; exact frozen
  | later => left; exact frozen
  | commit o' ho' _ =>
    right; rw [ho] at ho'; cases ho'; rfl
  | rollback => left; exact frozen
  | crash => left; exact frozen
  | rootWrite _ hn => simp [ho] at hn

/-- A crash in the middle of a transaction leaves the disk exactly as it was before it began. -/
theorem crash_mid_transaction {σ : Type} {init : σ} {s : Sys σ} {o : Open σ}
    (hr : Reachable init s) (ho : s.tx = some o) :
    ({ s with tx := none, cache := s.disk } : Sys σ).disk = o.base :=
  (inv_reachable hr).diskFrozen o ho

/-- A transaction that committed installed all of its statements, in order, over the disk it
began from. -/
theorem commit_complete {σ : Type} {s t : Sys σ} {o : Open σ}
    (ho : s.tx = some o) (st : Step s t) (hnone : t.tx = none) (hchg : t.disk ≠ s.disk)
    (hinv : Inv s) : t.disk = applyAll o.ops o.base := by
  have frozen := hinv.diskFrozen o ho
  cases st with
  | begin _ hn => simp [ho] at hn
  | exec => simp at hnone
  | nest => simp at hnone
  | later => simp at hnone
  | commit o' ho' _ => rw [ho] at ho'; cases ho'; rfl
  | rollback => exact absurd rfl hchg
  | crash => exact absurd rfl hchg
  | rootWrite _ hn => simp [ho] at hn

/-- Rollback and crash never run post-commit work; only a commit publishes its staged callbacks. -/
theorem no_publish_without_commit {σ : Type} {s t : Sys σ} (st : Step s t)
    (hpub : t.published ≠ s.published) :
    ∃ o, s.tx = some o ∧ o.done = o.ops.length ∧ t.published = s.published ++ o.staged := by
  cases st with
  | commit o ho hd => exact ⟨o, ho, hd, rfl⟩
  | begin => exact absurd rfl hpub
  | exec => exact absurd rfl hpub
  | nest => exact absurd rfl hpub
  | later => exact absurd rfl hpub
  | rollback => exact absurd rfl hpub
  | crash => exact absurd rfl hpub
  | rootWrite => exact absurd rfl hpub

/-- Nesting composes: work handed to `inTx` inside an open transaction commits exactly as if it
had been part of the outer transaction's statements from the start. -/
theorem nest_composes {σ : Type} (outer inner : List (σ → σ)) (base : σ) :
    applyAll (outer ++ inner) base = applyAll inner (applyAll outer base) :=
  applyAll_append outer inner base

end AgentBaseVerification.Tx
