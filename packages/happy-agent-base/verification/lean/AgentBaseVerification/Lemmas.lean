import AgentBaseVerification.Model

/-! Small facts about the derived views, used by every invariant proof. -/

namespace AgentBaseVerification

@[simp] theorem userIds_nil : userIds [] = [] := rfl
@[simp] theorem calls_nil : calls [] = [] := rfl
@[simp] theorem results_nil : results [] = [] := rfl

@[simp] theorem userIds_append (a b : List Record) : userIds (a ++ b) = userIds a ++ userIds b := by
  simp [userIds, List.filterMap_append]
@[simp] theorem calls_append (a b : List Record) : calls (a ++ b) = calls a ++ calls b := by
  simp [calls, List.filterMap_append]
@[simp] theorem results_append (a b : List Record) : results (a ++ b) = results a ++ results b := by
  simp [results, List.filterMap_append]

@[simp] theorem userIds_cons (r : Record) (h : List Record) :
    userIds (r :: h) = (match r with | .user m => [m] | _ => []) ++ userIds h := by
  cases r <;> simp [userIds, Record.userId?]
@[simp] theorem calls_cons (r : Record) (h : List Record) :
    calls (r :: h) = (match r with | .block (.call c) => [c] | _ => []) ++ calls h := by
  cases r with
  | block b => cases b <;> simp [calls, Record.callId?]
  | _ => simp [calls, Record.callId?]
@[simp] theorem results_cons (r : Record) (h : List Record) :
    results (r :: h) = (match r with | .result c => [c] | _ => []) ++ results h := by
  cases r <;> simp [results, Record.resultId?]

theorem mem_unanswered {x : Call} {h : List Record} :
    x ∈ unanswered h ↔ x ∈ calls h ∧ x ∉ results h := by
  simp [unanswered, List.mem_filter]

@[simp] theorem batchCalls_map_commit (b : List Entry) (c : Call) :
    (b.map (fun e => if e.call = c then (⟨c, true⟩ : Entry) else e)).map Entry.call = b.map Entry.call := by
  induction b with
  | nil => rfl
  | cons e b ih =>
    simp only [List.map_cons, ih]
    by_cases h : e.call = c <;> simp [h]

@[simp] theorem entry_call_comp_mk (b : Bool) :
    (Entry.call ∘ fun c : Call => (⟨c, b⟩ : Entry)) = id := rfl

@[simp] theorem entry_call_comp_commit (c : Call) :
    (Entry.call ∘ fun e : Entry => if e.call = c then (⟨c, true⟩ : Entry) else e) = Entry.call := by
  funext e
  by_cases h : e.call = c <;> simp [h]

theorem unanswered_sublist (h : List Record) : (unanswered h).Sublist (calls h) :=
  List.filter_sublist

@[simp] theorem map_entry_call (l : List Call) (b : Bool) :
    (l.map (fun c => (⟨c, b⟩ : Entry))).map Entry.call = l := by
  induction l with
  | nil => rfl
  | cons c l ih => simp [ih]

@[simp] theorem partialCalls_none : partialCalls none = [] := rfl
@[simp] theorem partialCalls_text : partialCalls (some .text) = [] := rfl
@[simp] theorem partialCalls_call (c : Call) : partialCalls (some (.call c)) = [c] := rfl
@[simp] theorem optCall_none : optCall none = [] := rfl
@[simp] theorem optCall_some (c : Call) : optCall (some c) = [c] := rfl

theorem pop_spec {st sd st' sd' : List Msg} {m : Msg} (h : pop st sd = some (m, st', sd')) :
    st ++ sd = m :: (st' ++ sd') := by
  match st, sd, h with
  | x :: r, sd, h => simp [pop] at h; obtain ⟨rfl, rfl, rfl⟩ := h; rfl
  | [], x :: r, h => simp [pop] at h; obtain ⟨rfl, rfl, rfl⟩ := h; rfl

end AgentBaseVerification
