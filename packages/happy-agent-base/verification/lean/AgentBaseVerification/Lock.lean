/-!
# Single owner per store

Code mapping: `sources/AgentSQLiteProcessLock.ts: acquireAgentSQLiteProcessLock` holds a
`BEGIN IMMEDIATE` write transaction on a sibling `.lock` SQLite file for the lifetime of the
process. The kernel releases it on graceful close (`release`), process exit, or `SIGKILL`.
`AgentSystemLocal.create` acquires it before migrating or restoring any agent, and
`AgentSystemLocal.close` releases it.

* `acquire p`      — `BEGIN IMMEDIATE` succeeds because nobody holds the lock.
* `acquireFail p`  — contention; `AgentSQLiteDatabaseLockedError` is thrown and nothing changes.
* `release p`      — `ROLLBACK` + `client.close()`.
* `kill p`         — the process dies; the kernel drops its lock.
* `write p`        — any store write; only a process holding an open `AgentSystem` issues one.
-/

namespace AgentBaseVerification.Lock

abbrev Pid := Nat

structure Sys where
  /-- Who the kernel says holds the lock. -/
  owner : Option Pid
  /-- Processes that believe they own the store (hold an open `AgentSystem`). -/
  owners : List Pid
  /-- Every store write, by writer (ghost). -/
  writes : List Pid

inductive Step : Sys → Sys → Prop
  | acquire (s : Sys) (p : Pid) :
      s.owner = none → Step s { s with owner := some p, owners := p :: s.owners }
  | acquireFail (s : Sys) (p : Pid) : s.owner ≠ none → Step s s
  | release (s : Sys) (p : Pid) :
      p ∈ s.owners →
      Step s { s with owner := none, owners := s.owners.filter (· ≠ p) }
  | kill (s : Sys) (p : Pid) :
      Step s { s with owner := if s.owner = some p then none else s.owner,
                      owners := s.owners.filter (· ≠ p) }
  | write (s : Sys) (p : Pid) :
      p ∈ s.owners → Step s { s with writes := s.writes ++ [p] }

inductive Reachable : Sys → Prop
  | init : Reachable ⟨none, [], []⟩
  | step {s t : Sys} : Reachable s → Step s t → Reachable t

/-- Everyone who believes it owns the store is the kernel's lock holder. -/
theorem owners_hold_lock {s : Sys} (h : Reachable s) : ∀ p ∈ s.owners, s.owner = some p := by
  induction h with
  | init => simp
  | step _ st ih =>
    cases st with
    | acquire p hn =>
      intro q hq
      simp at hq
      rcases hq with rfl | hq
      · rfl
      · have := ih q hq; simp [hn] at this
    | acquireFail => exact ih
    | release p hp =>
      intro q hq
      simp [List.mem_filter] at hq
      have h1 := ih q hq.1
      have h2 := ih p hp
      rw [h1] at h2; cases h2; exact absurd rfl hq.2
    | kill p =>
      intro q hq
      simp [List.mem_filter] at hq
      have h1 := ih q hq.1
      simp [h1]; exact hq.2
    | write p _ => exact ih

/-- **Mutual exclusion.** Two processes never both own one store. -/
theorem single_owner {s : Sys} (h : Reachable s) {p q : Pid}
    (hp : p ∈ s.owners) (hq : q ∈ s.owners) : p = q := by
  have a := owners_hold_lock h p hp
  have b := owners_hold_lock h q hq
  rw [a] at b; cases b; rfl

/-- **Single writer.** Every write is issued by the process the kernel says holds the lock at
that moment, so state an owner wrote is state only that owner can have written. -/
theorem writer_is_lock_holder {s t : Sys} (h : Reachable s) (st : Step s t)
    (hw : t.writes ≠ s.writes) : ∃ p, t.writes = s.writes ++ [p] ∧ s.owner = some p := by
  cases st with
  | write p hp => exact ⟨p, rfl, owners_hold_lock h p hp⟩
  | acquire => exact absurd rfl hw
  | acquireFail => exact absurd rfl hw
  | release => exact absurd rfl hw
  | kill => exact absurd rfl hw

end AgentBaseVerification.Lock
