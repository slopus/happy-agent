/-!
# The AgentBase state machine

A model of one agent (`sources/AgentBase.ts`) over its own store. Every transition that writes
the store is one committed transaction (or one root statement) of the real code, applied
atomically; `Tx.lean` proves that is what a transaction looks like from the disk. A crash can
therefore only fall *between* model transitions.

State is split three ways:

* `Durable` — what the store holds and a crash keeps (`AgentPersistence` records and keys).
* `Memory`  — what the live `AgentBase` instance holds and a crash loses.
* `Ghost`   — what the outside world has observed (accepted deliveries, tool side effects, what a
              listener was shown). It exists only to state theorems; no transition reads it
              except to extend it.

Abstractions (see README for the full list): message and call identities are natural numbers;
content, providers, settings, metadata, hooks' own writes and compaction summaries are not
modelled; module hooks are folded into the transaction of the transition that calls them.

The model follows the code after the fixes for the findings listed in the README: the
settlement keeps a record rewritten by late work, a stream ending without `done` keeps only
finished blocks and still requests a turn for queued input, a restart resets a response whose
provider request was still open, no tool starts once its turn is aborted, and committing a
call's result revokes its call-state handle.
-/

namespace AgentBaseVerification

abbrev Msg := Nat
abbrev Call := Nat

/-- `AgentBasePendingStage` (`sources/AgentBasePending.ts`). -/
inductive Stage
  | inference | tools | compaction | settlement
  deriving DecidableEq, Repr

/-- A *completed* assistant block as appended by `AgentBase.#collect`'s `persist`. -/
inductive Block
  | text
  | call (c : Call)
  deriving DecidableEq, Repr

/-- `AgentRecord` (`sources/AgentPersistence.ts`). -/
inductive Record
  | user (m : Msg)
  | block (b : Block)
  | result (c : Call)
  | system
  | compaction
  deriving DecidableEq, Repr

/-- One `tool.<index>.<id>` entry of the durable batch. `committed` is the `committed` result a
tool stored with `call.commit` (or a staged error from `#settleUnansweredCalls`). -/
structure Entry where
  call : Call
  committed : Bool
  deriving DecidableEq, Repr

/-- Everything the store holds. -/
structure Durable where
  /-- `message.<id>` identity keys (`#enqueueIndependently`, `#deleteRecordIdentities`). -/
  ids : List Msg
  /-- `steering.*` queue, in key order. -/
  steer : List Msg
  /-- `send.*` queue, in key order. -/
  send : List Msg
  /-- The main context store. -/
  history : List Record
  /-- `tool.*` entries: the dispatched batch still owed results. -/
  batch : List Entry
  /-- Calls with state under `kv.<agent>.call.<id>.*` / `toolResult.<id>`. -/
  callKV : List Call
  /-- Whether `kv.<agent>.run.*` holds anything. -/
  runKV : Bool
  /-- The `owed` record: `some` is the whole of the active flag. -/
  pending : Option Stage
  /-- The `owed` record carries an `inferenceId`: a provider request opened and has not been
  closed by the transaction that follows its response. -/
  requestOpen : Bool
  deriving DecidableEq, Repr

/-- Where the live run loop is. -/
inductive Phase
  /-- No run loop (`#runPromise === undefined`). -/
  | idle
  /-- The loop is at a boundary between inferences (`#runInferenceAttempt`'s `while`). -/
  | ready
  /-- A provider response is streaming (`#collect`). -/
  | streaming
  /-- A tool batch is in flight (`#dispatchToolBatch`). -/
  | tools
  /-- `#runLoops` returned `"settling"`; `#settleDurably` has not committed yet. -/
  | settling
  deriving DecidableEq, Repr

/-- A block the listener has seen start (`text_start`, `toolcall_start`, …) but not finish. -/
inductive Partial
  | text
  | call (c : Call)
  deriving DecidableEq, Repr

structure Memory where
  phase : Phase
  /-- The unfinished block of the streaming response. -/
  unfinished : Option Partial
  /-- Executions this process started whose result has not been produced. -/
  running : List Call
  /-- Results produced in memory, waiting for their ordered commit (`results[]` in the batch). -/
  finished : List Call
  /-- Aborted executions still unwinding whose call-KV handle is still usable: the batch has
  answered them in memory but not yet committed that answer. -/
  zombies : List Call
  turnRequested : Bool
  /-- The current turn's abort scope has been signalled. -/
  aborted : Bool
  /-- `#abortDroppedTurn`: an abort dropped a turn request since the current run began. -/
  abortDropped : Bool
  /-- `#abandonedQueueKeys`: queued input whose turn an abort or a failure dropped since the
  turn began. -/
  dropped : List Msg
  /-- The settle decision has been recorded (or declined) as the settlement stage. -/
  stageRecorded : Bool
  /-- `#reopenedBySettlement`: the last settlement found the record rewritten by late work and
  reopened it, so `#startRun`'s `finally` owes that work another run. -/
  reopened : Bool
  /-- The current batch was restored from the store (`#runToolBatch(…, resume = true)`). -/
  resume : Bool
  /-- `#recoveryChecked`: this instance has looked at what an earlier process left. -/
  recovered : Bool
  /-- `#inherited`: the `owed` record this instance read when it loaded. -/
  inherited : Option Stage
  deriving DecidableEq, Repr

structure Ghost where
  /-- Deliveries answered `accepted: "created"`. -/
  accepted : List Msg
  /-- Identities released by a history replacement (compaction or model/profile reset). -/
  released : List Msg
  /-- Every Base call ID ever generated. -/
  issued : List Call
  /-- Every tool execution ever started — an external side effect. -/
  execs : List Call
  /-- A listener was shown the start of a block and neither its end, a `done`, nor a
  `block_reset`. -/
  uiOpen : Bool
  /-- Messages that were queued when an abort or a failed turn dropped the turn they had
  requested. -/
  abandoned : List Msg
  deriving DecidableEq, Repr

structure State where
  d : Durable
  m : Memory
  g : Ghost
  deriving DecidableEq, Repr

/-- Model parameters: which tools may run again after a crash (`durable || reloadable`,
`AgentBase.#isRetryable`). -/
structure Params where
  retryable : Call → Bool

/-! ## Derived views -/

def Record.userId? : Record → Option Msg
  | .user m => some m
  | _ => none

def Record.callId? : Record → Option Call
  | .block (.call c) => some c
  | _ => none

def Record.resultId? : Record → Option Call
  | .result c => some c
  | _ => none

def userIds (h : List Record) : List Msg := h.filterMap Record.userId?
def calls (h : List Record) : List Call := h.filterMap Record.callId?
def results (h : List Record) : List Call := h.filterMap Record.resultId?

/-- Calls in the conversation without a result (`AgentBase.#unansweredCalls`). -/
def unanswered (h : List Record) : List Call :=
  (calls h).filter fun c => decide (c ∉ results h)

def queued (d : Durable) : List Msg := d.steer ++ d.send
def msgs (d : Durable) : List Msg := queued d ++ userIds d.history
def batchCalls (d : Durable) : List Call := d.batch.map Entry.call

def partialCalls : Option Partial → List Call
  | some (.call c) => [c]
  | _ => []

def optCall : Option Call → List Call
  | some c => [c]
  | none => []

def toBlock : Partial → Block
  | .text => .text
  | .call c => .call c

/-- `#lastRecordType` is a consumed message, a tool result, or a system note. -/
def lastOwesAnswer (h : List Record) : Bool :=
  match h.getLast? with
  | some (.user _) => true
  | some (.result _) => true
  | some .system => true
  | _ => false

/-- Take the next queued message: steering always outranks sends (`#runInferenceAttempt`). -/
def pop : List Msg → List Msg → Option (Msg × List Msg × List Msg)
  | m :: r, sd => some (m, r, sd)
  | [], m :: r => some (m, [], r)
  | [], [] => none

/-- The memory of a freshly loaded instance: `AgentBase.load` reads only the `owed` record. -/
def freshMemory (inherited : Option Stage) (recovered : Bool) : Memory :=
  { phase := .idle, unfinished := none, running := [], finished := [], zombies := [],
    turnRequested := false, aborted := false, abortDropped := false, dropped := [],
    stageRecorded := false, reopened := false, resume := false, recovered := recovered,
    inherited := inherited }

def init : State :=
  { d := { ids := [], steer := [], send := [], history := [], batch := [], callKV := [],
           runKV := false, pending := none, requestOpen := false },
    m := freshMemory none true,
    g := { accepted := [], released := [], issued := [], execs := [], uiOpen := false,
           abandoned := [] } }

/-! ## Transition effects -/

section Effects
variable (s : State)

/-- `#enqueueIndependently` + `#claimPendingWork`: identity key, queue entry, and the `owed`
record (overwritten to the inference stage) in one transaction; the in-memory request after
commit. -/
def enqueueEff (toSteer : Bool) (msg : Msg) : State :=
  { s with
    d := { s.d with ids := msg :: s.d.ids,
                    steer := if toSteer then s.d.steer ++ [msg] else s.d.steer,
                    send := if toSteer then s.d.send else s.d.send ++ [msg],
                    pending := some .inference },
    m := { s.m with turnRequested := true },
    g := { s.g with accepted := s.g.accepted ++ [msg] } }

/-- `#startRun` → `#runTurns` (which clears `#abortDroppedTurn`) → `#runLoops`' first
`#enterStage(ctx, "inference")`. The `finally` that starts it has consumed
`#reopenedBySettlement`. -/
def startEff : State :=
  { s with d := { s.d with pending := some .inference },
           m := { s.m with phase := .ready, unfinished := none, running := [],
                           finished := [], aborted := false, abortDropped := false,
                           reopened := false, resume := false } }

/-- The restart's one-time interruption check and the resume of a durable batch left by an
earlier process. The check is `#resetInterruptedResponse` at the start of the restarted run,
before any stage write (`block_reset` for an inherited inference stage with an open request),
completed by `#resumesInterruptedRun` at the first loaded edge (the same reset when no request
was open but the conversation owes an answer, and the decision to continue the response).
Every transition that writes another stage needs `recovered`, so none precedes the check. -/
def recoverEff : State :=
  let reset := decide (s.m.inherited = some .inference) &&
    (lastOwesAnswer s.d.history || s.d.requestOpen)
  { s with
    m := { s.m with recovered := true,
                    phase := if s.d.batch = [] then .ready else .tools,
                    resume := !(s.d.batch = []),
                    running := [], finished := [] },
    g := { s.g with uiOpen := if reset then false else s.g.uiOpen } }

/-- `#consumeQueue`: queue entry deleted, user record (and the Base-generated input-tool call)
appended, `owed` set to inference — one transaction. A model/profile `reset` also erases the old
history and releases its message identities in that transaction. -/
def consumeEff (msg : Msg) (st sd : List Msg) (reset : Bool) (call? : Option Call) : State :=
  let base := if reset then [] else s.d.history
  { s with
    d := { s.d with
           steer := st, send := sd,
           history := base ++ [Record.user msg] ++ (optCall call?).map (fun c => Record.block (.call c)),
           ids := if reset then s.d.ids.filter (fun x => decide (x ∉ userIds s.d.history))
                  else s.d.ids,
           pending := some .inference },
    m := { s.m with turnRequested := if st ++ sd = [] then false else s.m.turnRequested },
    g := { s.g with released := s.g.released ++ (if reset then userIds s.d.history else []),
                    issued := s.g.issued ++ optCall call? } }

/-- `#requestInference`: the inference stage is recorded with a fresh `inferenceId` and the
provider stream opens. -/
def beginInferenceEff : State :=
  { s with d := { s.d with pending := some .inference, requestOpen := true },
           m := { s.m with phase := .streaming, unfinished := none } }

/-- `#collect` emitting `text_start`/`reasoning_start`/`toolcall_start` (a fresh Base ID). -/
def showPartialEff (p : Partial) : State :=
  { s with m := { s.m with unfinished := some p },
           g := { s.g with uiOpen := true, issued := s.g.issued ++ partialCalls (some p) } }

/-- `#collect`'s `persist` on `*_end`: exactly one finished block is appended. -/
def completeBlockEff (p : Partial) : State :=
  { s with d := { s.d with history := s.d.history ++ [Record.block (toBlock p)] },
           m := { s.m with unfinished := none },
           g := { s.g with uiOpen := false } }

/-- A `done` event: the unfinished remainder is dropped and the listener told the response
ended. The transaction after the response (`#recordContextTokens` or `afterInference`'s
`#enterStage`) retires the `inferenceId`. -/
def finishEff : State :=
  { s with d := { s.d with requestOpen := false },
           m := { s.m with phase := .ready, unfinished := none },
           g := { s.g with uiOpen := false } }

/-- The stream ended without `done`: `#collect` keeps only the persisted blocks and emits
`block_reset` for an unfinished one; `#requestInference` raises the turn request when input is
still queued. -/
def truncateEff : State :=
  { s with d := { s.d with requestOpen := false },
           m := { s.m with phase := .ready, unfinished := none,
                           turnRequested := s.m.turnRequested || !(queued s.d).isEmpty },
           g := { s.g with uiOpen := false } }

/-- An abort reaching `#collect`: finished blocks stay, the rest is dropped, `done: cancelled`. -/
def cancelEff : State :=
  { s with d := { s.d with requestOpen := false },
           m := { s.m with phase := .ready, unfinished := none },
           g := { s.g with uiOpen := false } }

/-- `#dispatchToolBatch(resume = false)`: all owed calls and the tools stage in one transaction. -/
def dispatchEff : State :=
  { s with d := { s.d with batch := (unanswered s.d.history).map (fun c => ⟨c, false⟩),
                           pending := some .tools },
           m := { s.m with phase := .tools, resume := false, running := [], finished := [] } }

/-- `#settleUnansweredCalls`' first transaction: every call the conversation still owes is
staged with a committed error result; its second transaction is `commitResultEff` per entry. -/
def settleUnansweredEff : State :=
  { s with d := { s.d with batch := (unanswered s.d.history).map (fun c => ⟨c, true⟩),
                           pending := some .tools },
           m := { s.m with phase := .tools, resume := false, running := [], finished := [] } }

/-- `#executeToolCall` starts executing a call. -/
def execStartEff (c : Call) : State :=
  { s with m := { s.m with running := s.m.running ++ [c] },
           g := { s.g with execs := s.g.execs ++ [c] } }

/-- A resumed call whose tool is not retryable becomes an error result without running. -/
def refuseEff (c : Call) : State :=
  { s with m := { s.m with finished := s.m.finished ++ [c] } }

/-- The execution returned (or threw): its result waits in memory for the ordered commit. -/
def returnEff (c : Call) : State :=
  { s with m := { s.m with running := s.m.running.filter (· ≠ c),
                           finished := s.m.finished ++ [c] } }

/-- `call.commit(ctx, result)`: the result is stored on the entry and call KV cleared in one
transaction; the call-bound handle is revoked after commit. -/
def toolCommitEff (c : Call) : State :=
  { s with d := { s.d with batch := s.d.batch.map (fun e => if e.call = c then ⟨c, true⟩ else e),
                           callKV := s.d.callKV.filter (· ≠ c) },
           m := { s.m with running := s.m.running.filter (· ≠ c),
                           finished := s.m.finished ++ [c] } }

/-- The batch's `Promise.race` sees the abort: the call gets an aborted error result. The
execution itself keeps unwinding (`#settleLater`) with its call-KV handle still usable until
that result commits. -/
def abortEntryEff (c : Call) : State :=
  { s with m := { s.m with
      running := s.m.running.filter (· ≠ c),
      finished := s.m.finished ++ [c],
      zombies := if c ∈ s.m.running then s.m.zombies ++ [c] else s.m.zombies } }

/-- An abandoned execution finally returns and its handle is revoked. -/
def zombieExitEff (c : Call) : State :=
  { s with m := { s.m with zombies := s.m.zombies.filter (· ≠ c) } }

/-- A running tool writes its own durable state under its call-bound KV. -/
def toolWriteEff (c : Call) : State :=
  { s with d := { s.d with callKV := c :: s.d.callKV } }

/-- `#dispatchToolBatch`'s `commitReady`: the first uncommitted result in batch order is
appended, its entry, result claim, and call KV erased, in one transaction; after the last one,
the stage returns to inference. After commit the call's handle is revoked (`#callLifetimes`),
so an execution still unwinding can no longer write its call state. -/
def commitResultEff (e : Entry) (rest : List Entry) : State :=
  { s with
    d := { s.d with history := s.d.history ++ [Record.result e.call],
                    batch := rest,
                    callKV := s.d.callKV.filter (· ≠ e.call),
                    pending := if rest = [] then some .inference else s.d.pending },
    m := { s.m with finished := s.m.finished.filter (· ≠ e.call),
                    zombies := s.m.zombies.filter (· ≠ e.call),
                    phase := if rest = [] then .ready else .tools } }

/-- Hooks write the run store (`agentRunKV`). -/
def runWriteEff : State := { s with d := { s.d with runKV := true } }

/-- A running tool writes the run store through its call context, whose handle is bounded by
the call's lifetime like its call KV. -/
def toolRunWriteEff : State := { s with d := { s.d with runKV := true } }

/-- `AgentBase.abort` → `#signalAbort`: the turn request is dropped and the messages queued
behind it stay queued (`#abandonQueuedInput`). -/
def abortEff : State :=
  { s with m := { s.m with aborted := true, turnRequested := false, abortDropped := true,
                           dropped := s.m.dropped ++ queued s.d },
           g := { s.g with abandoned := s.g.abandoned ++ queued s.d } }

/-- `#runTurn` returns `"continue"` after an aborted turn because input arrived meanwhile:
`#runLoops` opens a fresh abort scope. -/
def newTurnEff : State := { s with m := { s.m with aborted := false } }

/-- `#runTurn` starts: a turn whose scope is not aborted claims the turn request and answers the
queue again, so the input earlier aborts or failures dropped is forgotten; a turn that starts
already aborted answers nothing and claims nothing: it keeps the dropped input, and a request
raised after the abort survives it. -/
def beginTurnEff : State :=
  { s with m := { s.m with dropped := if s.m.aborted then s.m.dropped else [],
                           turnRequested := if s.m.aborted then s.m.turnRequested else false } }

/-- A turn fails (`#runInference`'s `catch`, or a run failure): the failure answers the turn,
so the queued input it was asked to take stays queued without a request
(`#abandonQueuedInput`), exactly as after an abort. -/
def failTurnEff : State :=
  { s with m := { s.m with turnRequested := false, dropped := s.m.dropped ++ queued s.d },
           g := { s.g with abandoned := s.g.abandoned ++ queued s.d } }

/-- `#runLoops` returns `"settling"`: the loop has decided in memory. Nothing durable changes
yet, so input can still be accepted before the stage is recorded. -/
def decideSettleEff : State :=
  { s with m := { s.m with phase := .settling, stageRecorded := false } }

/-- `#enterSettlementStage`: one transaction records the settlement stage, unless input that
was not dropped by an abort is queued — such input rewrote the record as the inference it owes
and must not be overwritten. -/
def recordSettlementEff : State :=
  { s with d := { s.d with pending := if ∀ x ∈ queued s.d, x ∈ s.m.dropped then some .settlement
                                      else s.d.pending },
           m := { s.m with stageRecorded := true } }

/-- `#startRun`'s `finally` after an abort dropped the turn of work that recorded itself after
the settlement: a run that only settles (`#runTurns` with `#settleAfterAbort`), recording the
settlement stage through `recordSettlement` like any other. -/
def settleAbandonedEff : State :=
  { s with m := { s.m with phase := .settling, stageRecorded := false, abortDropped := false,
                           reopened := false } }

/-- `#settleRecord`: `#clearPending` + `afterAgentSettledTransact` + `#clearRunStore` in one
transaction. When accepted work rewrote the settlement stage since the settle decision, the
same transaction opens the next run's inference stage instead of leaving the store settled, and
the instance remembers that it owes that stage a run (`#reopenedBySettlement`). -/
def settleEff : State :=
  { s with
    d := { s.d with pending := if s.d.pending = some .settlement then none else some .inference,
                    runKV := false },
    m := { s.m with phase := .idle, aborted := false,
                    reopened := decide (s.d.pending ≠ some .settlement) } }

/-- `#compactHistoryAttempt` begins: `#enterStage(ctx, "compaction")` replaces the record. It
runs only after the restart's one-time interruption check (`recover`), whose `block_reset` is
decided from the inherited record. -/
def enterCompactionEff : State :=
  { s with d := { s.d with pending := some .compaction } }

/-- `#compactHistoryAttempt` (completed): old records and their message identities erased and
the replacement written in one transaction. -/
def compactEff : State :=
  { s with
    d := { s.d with history := [Record.compaction],
                    ids := s.d.ids.filter (fun x => decide (x ∉ userIds s.d.history)),
                    pending := some .inference },
    g := { s.g with released := s.g.released ++ userIds s.d.history } }

/-- The process dies. The store keeps every committed transaction and nothing else; the next
instance is loaded with `AgentBase.load`, which reads only the `owed` record. -/
def crashEff : State := { s with m := freshMemory s.d.pending false }

end Effects

/-! ## The transition relation -/

inductive Step (P : Params) : State → State → Prop
  /-- A new identity is accepted (`steer`/`send`, answer `"created"`). -/
  | enqueue {s : State} (toSteer : Bool) (msg : Msg) :
      msg ∉ s.d.ids → Step P s (enqueueEff s toSteer msg)
  /-- A known identity is offered again: an ignored uniqueness conflict (`"existing"`). -/
  | enqueueDup {s : State} (msg : Msg) : msg ∈ s.d.ids → Step P s s
  /-- A run starts only where the code starts one: a caller or `#startRun`'s `finally` for a
  requested turn or a reopened record, or an owner starting a restored instance. -/
  | start {s : State} : s.m.phase = .idle →
      (s.m.turnRequested = true ∨ s.m.reopened = true ∨ s.m.recovered = false) →
      Step P s (startEff s)
  | recover {s : State} : s.m.phase = .ready → s.m.recovered = false → Step P s (recoverEff s)
  | consume {s : State} (msg : Msg) (st sd : List Msg) (reset : Bool) (call? : Option Call) :
      s.m.phase = .ready → s.m.recovered = true → s.m.aborted = false →
      s.d.batch = [] → unanswered s.d.history = [] →
      pop s.d.steer s.d.send = some (msg, st, sd) →
      (∀ c, call? = some c → c ∉ s.g.issued) →
      Step P s (consumeEff s msg st sd reset call?)
  | beginInference {s : State} :
      s.m.phase = .ready → s.m.recovered = true → s.m.aborted = false →
      s.d.batch = [] → unanswered s.d.history = [] →
      Step P s (beginInferenceEff s)
  | showPartial {s : State} (p : Partial) :
      s.m.phase = .streaming → s.m.unfinished = none →
      (∀ c, p = .call c → c ∉ s.g.issued) →
      Step P s (showPartialEff s p)
  | completeBlock {s : State} (p : Partial) :
      s.m.phase = .streaming → s.m.unfinished = some p → Step P s (completeBlockEff s p)
  | finish {s : State} : s.m.phase = .streaming → Step P s (finishEff s)
  | truncate {s : State} : s.m.phase = .streaming → Step P s (truncateEff s)
  | cancel {s : State} : s.m.phase = .streaming → s.m.aborted = true → Step P s (cancelEff s)
  | dispatch {s : State} :
      s.m.phase = .ready → s.m.recovered = true → s.d.batch = [] →
      unanswered s.d.history ≠ [] → Step P s (dispatchEff s)
  | settleUnanswered {s : State} :
      s.m.phase = .ready → s.m.recovered = true → s.d.batch = [] →
      unanswered s.d.history ≠ [] → Step P s (settleUnansweredEff s)
  | execStart {s : State} (c : Call) :
      s.m.phase = .tools → s.m.aborted = false → ⟨c, false⟩ ∈ s.d.batch →
      c ∉ s.m.running → c ∉ s.m.finished →
      (s.m.resume = false ∨ P.retryable c = true) →
      Step P s (execStartEff s c)
  | refuse {s : State} (c : Call) :
      s.m.phase = .tools → s.m.resume = true → P.retryable c = false →
      ⟨c, false⟩ ∈ s.d.batch → c ∉ s.m.running → c ∉ s.m.finished →
      Step P s (refuseEff s c)
  | toolReturn {s : State} (c : Call) : c ∈ s.m.running → Step P s (returnEff s c)
  | toolCommit {s : State} (c : Call) :
      s.m.phase = .tools → c ∈ s.m.running → Step P s (toolCommitEff s c)
  | abortEntry {s : State} (c : Call) :
      s.m.phase = .tools → s.m.aborted = true → ⟨c, false⟩ ∈ s.d.batch → c ∉ s.m.finished →
      Step P s (abortEntryEff s c)
  | zombieExit {s : State} (c : Call) : c ∈ s.m.zombies → Step P s (zombieExitEff s c)
  | toolWrite {s : State} (c : Call) :
      c ∈ s.m.running ∨ c ∈ s.m.zombies → Step P s (toolWriteEff s c)
  | toolRunWrite {s : State} (c : Call) :
      c ∈ s.m.running ∨ c ∈ s.m.zombies → Step P s (toolRunWriteEff s)
  | commitResult {s : State} (e : Entry) (rest : List Entry) :
      s.m.phase = .tools → s.d.batch = e :: rest → (e.committed = true ∨ e.call ∈ s.m.finished) →
      Step P s (commitResultEff s e rest)
  | runWrite {s : State} : s.m.phase ≠ .idle → Step P s (runWriteEff s)
  /-- `abort` may land at any time. On an agent with no run the code's abort is a no-op, so
  this over-approximates; it is what covers an abort arriving after the settlement committed
  but before `#startRun`'s `finally` ran. -/
  | abort {s : State} : Step P s (abortEff s)
  | newTurn {s : State} :
      s.m.phase = .ready → s.m.aborted = true → s.m.turnRequested = true →
      Step P s (newTurnEff s)
  /-- Any number of times while the loop is between inferences: the code does it once per turn,
  after the loop hooks, so an abort may land before it. -/
  | beginTurn {s : State} : s.m.phase = .ready → Step P s (beginTurnEff s)
  | failTurn {s : State} : s.m.phase = .ready → Step P s (failTurnEff s)
  /-- The loop settles once nothing is requested: after an abort, or with every queued message
  answered or dropped by an abort or a failure. -/
  | decideSettle {s : State} :
      s.m.phase = .ready → s.m.recovered = true → s.d.batch = [] →
      unanswered s.d.history = [] → s.m.turnRequested = false →
      (s.m.aborted = true ∨ ∀ x ∈ queued s.d, x ∈ s.m.dropped) →
      Step P s (decideSettleEff s)
  | settleAbandoned {s : State} :
      s.m.phase = .idle → s.m.recovered = true → s.m.abortDropped = true →
      s.m.turnRequested = false → s.d.pending ≠ none → s.d.batch = [] →
      unanswered s.d.history = [] →
      Step P s (settleAbandonedEff s)
  | recordSettlement {s : State} :
      s.m.phase = .settling → s.m.stageRecorded = false → Step P s (recordSettlementEff s)
  | settle {s : State} :
      s.m.phase = .settling → s.m.stageRecorded = true → Step P s (settleEff s)
  | enterCompaction {s : State} :
      s.m.phase = .ready → s.m.recovered = true → s.m.aborted = false →
      s.d.batch = [] → unanswered s.d.history = [] →
      Step P s (enterCompactionEff s)
  | compact {s : State} :
      s.m.phase = .ready → s.m.recovered = true → s.m.aborted = false →
      s.d.batch = [] → unanswered s.d.history = [] →
      Step P s (compactEff s)
  | crash {s : State} : Step P s (crashEff s)

inductive Reachable (P : Params) : State → Prop
  | init : Reachable P init
  | step {s t : State} : Reachable P s → Step P s t → Reachable P t

end AgentBaseVerification
