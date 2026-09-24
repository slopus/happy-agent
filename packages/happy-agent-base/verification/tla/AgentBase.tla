------------------------------ MODULE AgentBase ------------------------------
(***************************************************************************)
(* A model of one AgentBase (packages/happy-agent-base/sources/AgentBase.ts) *)
(* running over its durable store, with process crashes injected between    *)
(* any two atomic steps and user aborts at any time.                       *)
(*                                                                         *)
(* Granularity. One TLA+ step is one database transaction, one             *)
(* non-transactional durable write, or one in-memory step of the run loop   *)
(* between two awaits that matter for durability. A crash can happen       *)
(* between any two steps. The store is transactional, so a crash never     *)
(* exposes half a transaction; plan 08 says a database failure terminates  *)
(* the system, so a failing transaction is modelled as a crash.            *)
(*                                                                         *)
(* State is split into three records:                                      *)
(*   d  - the durable store (survives a crash)                             *)
(*   v  - the memory of the live process (lost on a crash)                 *)
(*   g  - ghost/history variables used only by properties and bounds       *)
(*                                                                         *)
(* See README.md for the list of abstractions.                             *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    Msgs,            \* message identities a caller may offer (cuid2 ids)
    NumCalls,        \* tool calls the model may emit over the whole run
    MaxOffers,       \* how many times each identity may be offered (>1 = duplicate delivery)
    MaxCrashes,      \* process crashes injected
    MaxAborts,       \* user aborts injected
    MaxCompactions,  \* compaction requests injected
    MaxBlocks,       \* completed blocks per provider response
    ForeignCtxTools, \* TRUE: a tool may keep writing through a context it did not get from Base
    EndStates        \* provider outcomes allowed, a subset of {"normal","error","tool_call","eof"}

Calls == 1..NumCalls
Stages == {"none", "inference", "tools", "compaction", "settlement"}
Kinds == {"durable", "plain"}
NoCall == 0
RecTypes == {"user", "text", "call", "tool", "sys", "compaction"}
Rec(t, x) == [t |-> t, x |-> x]
Keys == 1..(Cardinality(Msgs) * MaxOffers)
Entry == [m : Msgs, k : Keys]

Range(s) == {s[i] : i \in DOMAIN s}
Remove(s, e) == SelectSeq(s, LAMBDA x : x # e)
Sorted(S) == CHOOSE f \in [1..Cardinality(S) -> S] :
                 \A i, j \in 1..Cardinality(S) : i < j => f[i] < f[j]

(* ----------------------------- history views ----------------------------- *)
CallsIn(h)    == {h[i].x : i \in {j \in DOMAIN h : h[j].t = "call"}}
ResultsIn(h)  == {h[i].x : i \in {j \in DOMAIN h : h[j].t = "tool"}}
Unanswered(h) == CallsIn(h) \ ResultsIn(h)                  \* AgentBase.#unansweredCalls
UserIdsIn(h)  == {h[i].x : i \in {j \in DOMAIN h : h[j].t = "user"}}
LastType(h)   == IF h = <<>> THEN "none" ELSE h[Len(h)].t

VARIABLES d, v, g
vars == <<d, v, g>>

DInit == [ q       |-> <<>>,                      \* "steering."/"send." queue keys, FIFO
           ids     |-> {},                        \* "message.<id>" identity keys
           hist    |-> <<>>,                      \* main context store (AgentRecord[])
           pending |-> "none",                    \* AGENT_BASE_PENDING_KEY ("owed")
           tools   |-> [c \in Calls |-> "absent"], \* "tool.<i>.<id>": pending | staged(committed)
           claim   |-> {},                        \* "toolResult.<id>" first-writer-wins claims
           callKV  |-> {},                        \* "kv.<agent>.call.<id>.*" call-bound KV
           runKV   |-> FALSE,                     \* "kv.<agent>.run.*" run store non-empty
           kind    |-> [c \in Calls |-> "plain"], \* durable flag of the tool a call names
           reqOpen |-> FALSE                      \* the pending record carries a live inferenceId
         ]

VInit == [ up        |-> TRUE,
           pc        |-> "idle",   \* "idle" <=> #runPromise === undefined
           mq        |-> <<>>,     \* #steering/#sends in memory
           turnReq   |-> FALSE,    \* #turnRequested
           aborted   |-> FALSE,    \* current abort scope signalled
           abortedRun|-> FALSE,    \* an abort hit this run (drops a pending compaction)
           needInf   |-> FALSE,    \* needsInference in #runInferenceAttempt
           inherited |-> "none",   \* #inherited.stage read at load
           inheritedReq |-> FALSE, \* #inherited.inferenceId !== undefined
           abortDropped |-> FALSE, \* #abortDroppedTurn
           settleAfterAbort |-> FALSE, \* #settleAfterAbort
           abandoned |-> {},       \* #abandonedQueueKeys: queue keys an abort gave up on
           reopened  |-> FALSE,    \* #reopenedBySettlement
           intChecked|-> FALSE,    \* #interruptionChecked
           recChecked|-> FALSE,    \* #recoveryChecked
           lastRec   |-> "none",   \* #lastRecordType
           batch     |-> <<>>,     \* the tool batch being run
           resume    |-> FALSE,    \* runToolBatch(resume)
           res       |-> [c \in Calls |-> "none"], \* results[] proposed per call
           cidx      |-> 0,        \* committed prefix of the batch
           execRet   |-> "loop",   \* where control returns after the batch
           compRet   |-> "loop",   \* where control returns after compaction
           compCont  |-> FALSE,    \* compaction continueWithInference
           suNext    |-> "loop",   \* where control returns after #settleUnansweredCalls
           comp      |-> FALSE,    \* #compaction requested
           blocked   |-> FALSE,    \* #durableWorkBlocked
           exec      |-> [c \in Calls |-> "idle"], \* live executions (incl. unwinding ones)
           resp      |-> <<>>,     \* tool calls of the response being streamed
           blocks    |-> 0         \* completed blocks of that response
         ]

GInit == [ nextKey   |-> 1,
           nextCall  |-> 1,
           offers    |-> [m \in Msgs |-> 0],
           created   |-> [m \in Msgs |-> 0],   \* acceptances answered "created"
           consumed  |-> [m \in Msgs |-> 0],   \* times the message entered the conversation
           released  |-> [m \in Msgs |-> 0],   \* identities released by history replacement
           execs     |-> [c \in Calls |-> 0],  \* executions actually started per call
           crashes   |-> 0,
           aborts    |-> 0,
           compactions |-> 0,
           partial   |-> FALSE,  \* a listener was shown the start of an unfinished block
           stale     |-> FALSE,  \* ... and the process that showed it died
           startAfterAbort |-> FALSE \* a tool execution began after its turn was aborted
         ]

Init == d = DInit /\ v = VInit /\ g = GInit

At(p) == v.up /\ v.pc = p
Goto(p) == [v EXCEPT !.pc = p]

(***************************************************************************)
(* Environment                                                             *)
(***************************************************************************)

(* AgentBase.#offer -> #enqueueIndependently: one transaction writes the     *)
(* identity key (absent-only), the queue key, and #claimPendingWork, which   *)
(* makes the record say "inference" whatever it said before (it skips the    *)
(* write only when this instance already wrote that very "inference"         *)
(* record, which leaves the same durable result). Its afterCommit            *)
(* publishes the entry, raises #turnRequested and calls #startRun (a no-op   *)
(* while a run is in flight). AgentDatabaseConnection.transaction holds the  *)
(* root FIFO through commit AND that publication, so no other database step  *)
(* can fall between them; a crash between them loses only memory, which a  *)
(* crash loses anyway. Hence one atomic step. The loop's in-memory decisions *)
(* (e.g. "nothing requested, settle") can still interleave with it.         *)
Offer(m) ==
    /\ v.up
    /\ g.offers[m] < MaxOffers
    /\ IF m \in d.ids
       THEN \* accepted: "existing" -- a durable no-op
            /\ g' = [g EXCEPT !.offers[m] = @ + 1]
            /\ UNCHANGED <<d, v>>
       ELSE LET e == [m |-> m, k |-> g.nextKey] IN
            /\ d' = [d EXCEPT !.ids = @ \cup {m}, !.q = Append(@, e),
                              !.pending = "inference"]
            /\ v' = [v EXCEPT !.mq = Append(@, e), !.turnReq = TRUE,
                              !.pc = IF @ = "idle" THEN "start" ELSE @]
            /\ g' = [g EXCEPT !.offers[m] = @ + 1, !.created[m] = @ + 1,
                              !.nextKey = @ + 1]

(* AgentBase.abort -> #signalAbort: only while a run is in flight; drops the *)
(* turn request, marks the queued input known in memory as abandoned        *)
(* (#abandonQueuedInput), and signals the current abort scope.              *)
Abort ==
    /\ v.up /\ v.pc # "idle"
    /\ g.aborts < MaxAborts
    /\ v' = [v EXCEPT !.aborted = TRUE, !.abortedRun = TRUE, !.turnReq = FALSE,
                      !.abortDropped = TRUE,
                      !.abandoned = @ \cup {v.mq[i].k : i \in DOMAIN v.mq}]
    /\ g' = [g EXCEPT !.aborts = @ + 1]
    /\ UNCHANGED d

(* AgentBase.compact -> #ensureCompaction. *)
RequestCompaction ==
    /\ v.up /\ ~v.comp
    /\ g.compactions < MaxCompactions
    /\ v' = [v EXCEPT !.comp = TRUE, !.turnReq = TRUE,
                      !.pc = IF @ = "idle" THEN "start" ELSE @]
    /\ g' = [g EXCEPT !.compactions = @ + 1]
    /\ UNCHANGED d

(* SIGKILL, power loss, or a database failure (plan 08: fatal). Memory is   *)
(* gone; the kernel releases the SQLite process lock.                       *)
Crash ==
    /\ v.up
    /\ g.crashes < MaxCrashes
    /\ v' = [VInit EXCEPT !.up = FALSE]
    /\ g' = [g EXCEPT !.crashes = @ + 1, !.stale = @ \/ g.partial, !.partial = FALSE]
    /\ UNCHANGED d

(* A new process takes the lock (AgentSystemLocal.create) and #start calls  *)
(* AgentBase.load for every identity; only active ones are started          *)
(* (#instantiate onlyIfActive, AgentBase.loadActive).                        *)
Restart ==
    /\ ~v.up
    /\ v' = [VInit EXCEPT !.inherited = d.pending, !.inheritedReq = d.reqOpen,
                          !.pc = IF d.pending # "none" THEN "start" ELSE "idle"]
    /\ UNCHANGED <<d, g>>

(***************************************************************************)
(* The run loop: #runTurns / #runLoops / #runTurn / #runInferenceAttempt   *)
(***************************************************************************)

(* #runTurns: a stored "settlement" stage with a complete conversation      *)
(* settles directly; otherwise open a loop. A run started only to settle    *)
(* what an abort left owed (#settleAfterAbort) records the settlement stage *)
(* first, or leaves an open tool exchange recorded for its resume.          *)
Start ==
    /\ At("start")
    \* #resetInterruptedResponse, before any stage write of this run: an
    \* inherited "inference" stage with an open request is reset now; any
    \* other stage than "inference" has nothing to reset; an "inference"
    \* stage without an open request is left to the loaded-edge check.
    /\ LET open == v.inherited = "inference" /\ v.inheritedReq
           done == v.intChecked \/ open \/ v.inherited # "inference" IN
       /\ g' = IF ~v.intChecked /\ open THEN [g EXCEPT !.stale = FALSE] ELSE g
       /\ v' = [v EXCEPT !.abortDropped = FALSE, !.settleAfterAbort = FALSE,
                !.intChecked = done,
                !.pc = IF v.settleAfterAbort
                       THEN IF Unanswered(d.hist) = {} THEN "settleStage" ELSE "finally"
                       ELSE IF d.pending = "settlement" /\ Unanswered(d.hist) = {}
                       THEN "settleTx"
                       ELSE "loopOpen"]
    /\ UNCHANGED d

(* #runLoops: open the abort scope, then #enterStage("inference").          *)
LoopOpen ==
    /\ At("loopOpen")
    /\ d' = [d EXCEPT !.pending = "inference"]
    /\ v' = [v EXCEPT !.aborted = FALSE, !.pc = "turn"]
    /\ UNCHANGED g

(* #runTurn: unless the turn's abort scope is already aborted, clear        *)
(* #turnRequested and #abandonedQueueKeys; then #ensureLoaded ->            *)
(* #loadHistory.                                                            *)
(* Memory is rebuilt from the store: queues, last record type, and the tool *)
(* batch -- the durable "tool." entries, or, if there are none, the          *)
(* unanswered calls of the conversation as an undispatched batch.           *)
Turn ==
    /\ At("turn")
    /\ LET stored == {c \in Calls : d.tools[c] # "absent"}
           owed   == Unanswered(d.hist)
           b      == IF stored # {} THEN Sorted(stored) ELSE Sorted(owed)
       IN v' = [v EXCEPT !.mq = d.q,
                         \* a turn whose scope is already aborted claims no request
                         \* and keeps what the abort abandoned
                         !.turnReq = IF v.aborted THEN @ ELSE FALSE,
                         !.abandoned = IF v.aborted THEN @ ELSE {},
                         !.lastRec = LastType(d.hist),
                         !.batch = b, !.resume = (stored # {}),
                         !.res = [c \in Calls |-> "none"], !.cidx = 0,
                         !.blocked = FALSE, !.pc = "resumeTools"]
    /\ UNCHANGED <<d, g>>

(* #runInferenceAttempt, first part: resume an interrupted batch.           *)
ResumeTools ==
    /\ At("resumeTools")
    /\ IF v.batch = <<>>
       THEN /\ v' = [v EXCEPT !.needInf = FALSE, !.pc = "recovery"]
            /\ UNCHANGED d
       ELSE IF v.aborted /\ \E c \in Calls : v.exec[c] = "running"
       THEN \* race([#settled(), abortPromise]) === ABORTED -> "complete". With no
            \* execution unwinding in this process #settled() is already resolved
            \* and, listed first, wins the race even against an aborted scope: the
            \* batch then runs, and CallStart answers every call as aborted.
            /\ v' = [v EXCEPT !.batch = <<>>, !.pc = "endTurn"]
            /\ UNCHANGED d
       ELSE IF ~v.resume
       THEN \* undispatched: #dispatchToolBatch(resume=false) commits the batch first
            /\ d' = [d EXCEPT !.tools = [c \in Calls |->
                                  IF c \in Range(v.batch) THEN "pending" ELSE @[c]],
                              !.pending = "tools"]
            /\ v' = [v EXCEPT !.execRet = "postResume", !.pc = "exec"]
       ELSE \* resumed: #enterStage("tools")
            /\ d' = [d EXCEPT !.pending = "tools"]
            /\ v' = [v EXCEPT !.execRet = "postResume", !.pc = "exec"]
    /\ UNCHANGED g

PostResume ==
    /\ At("postResume")
    /\ v' = [v EXCEPT !.needInf = TRUE, !.pc = "recovery"]
    /\ UNCHANGED <<d, g>>

(* #runCompaction guard: run a requested compaction, continuing inference  *)
(* when one is owed.                                                        *)
CompactCheck ==
    /\ At("compactCheck")
    /\ v' = IF v.comp THEN [v EXCEPT !.compCont = v.needInf, !.pc = "compStage"]
                      ELSE Goto(v.compRet)
    /\ UNCHANGED <<d, g>>

(* #compactHistoryAttempt: #enterStage("compaction").                      *)
CompStage ==
    /\ At("compStage")
    /\ d' = [d EXCEPT !.pending = "compaction"]
    /\ v' = Goto("compRun")
    /\ UNCHANGED g

(* Provider compaction completed: one transaction deletes the identities   *)
(* of consumed user records, clears history, appends the replacement, and  *)
(* when continuing records the owed inference.                              *)
CompSucceed ==
    /\ At("compRun")
    /\ d' = [d EXCEPT !.ids = @ \ UserIdsIn(d.hist),
                      !.hist = <<Rec("compaction", NoCall)>>,
                      !.pending = IF v.compCont THEN "inference" ELSE @,
                      !.reqOpen = @ \/ v.compCont]
    /\ g' = [g EXCEPT !.released = [m \in Msgs |->
                         IF m \in UserIdsIn(d.hist) THEN @[m] + 1 ELSE @[m]]]
    /\ v' = [v EXCEPT !.comp = FALSE, !.lastRec = "compaction", !.pc = v.compRet]

(* Provider failure or cancellation: #preserveCompactionContinuation.       *)
CompFail ==
    /\ At("compRun")
    /\ d' = [d EXCEPT !.pending = IF v.compCont /\ ~v.aborted THEN "inference" ELSE @,
                      !.reqOpen = @ \/ (v.compCont /\ ~v.aborted)]
    /\ v' = [v EXCEPT !.comp = FALSE, !.pc = v.compRet]
    /\ UNCHANGED g

(* #resumesInterruptedRun, checked once per instance. A block_reset tells  *)
(* listeners to drop a block a dead process started showing. A completed   *)
(* block or compaction left last under a live inference identity belongs   *)
(* to a response that never ended, so it is reset and continued. The check *)
(* runs before the first requested compaction, whose stage record would     *)
(* otherwise replace the inherited "inference" the reset depends on; the    *)
(* compaction then continues whatever response is owed.                     *)
Recovery ==
    /\ At("recovery")
    /\ IF ~v.recChecked
       THEN LET requestOpen == v.inherited = "inference" /\ v.inheritedReq
                owed == \/ v.lastRec \in {"user", "tool", "sys"}
                        \/ (v.lastRec \in {"compaction", "text", "call"} /\ requestOpen)
            IN /\ v' = [v EXCEPT !.recChecked = TRUE, !.needInf = @ \/ owed,
                                 !.intChecked = TRUE,
                                 !.compRet = "loop", !.pc = "compactCheck"]
               /\ g' = IF owed /\ ~v.intChecked /\ v.inherited = "inference"
                       THEN [g EXCEPT !.stale = FALSE] ELSE g
       ELSE /\ v' = [v EXCEPT !.compRet = "loop", !.pc = "compactCheck"]
            /\ UNCHANGED g
    /\ UNCHANGED d

(* Top of the while loop: abort check, then compaction.                     *)
LoopTop ==
    /\ At("loop")
    /\ v' = IF v.aborted THEN Goto("endTurn")
            ELSE [v EXCEPT !.compRet = "consume", !.pc = "compactCheck"]
    /\ UNCHANGED <<d, g>>

(* #consumeQueue: filter memory by the durable keys, then one transaction  *)
(* moves the head entry into the conversation and records "inference".      *)
Consume ==
    /\ At("consume")
    /\ LET live == SelectSeq(v.mq, LAMBDA e : e \in Range(d.q)) IN
       IF live # <<>>
       THEN LET e == Head(live) IN
            /\ d' = [d EXCEPT !.q = Remove(@, e), !.hist = Append(@, Rec("user", e.m)),
                              !.pending = "inference"]
            /\ v' = [v EXCEPT !.mq = Tail(live),
                              !.turnReq = IF Tail(live) = <<>> /\ ~v.comp THEN FALSE ELSE @,
                              !.pc = "infer"]
            /\ g' = [g EXCEPT !.consumed[e.m] = @ + 1]
       ELSE /\ v' = [v EXCEPT !.mq = live, !.pc = IF v.needInf THEN "infer" ELSE "endTurn"]
            /\ UNCHANGED <<d, g>>

(* #requestInference: #enterStage("inference") then open the stream. A     *)
(* cancellation that arrived first returns undefined and cycles.            *)
Infer ==
    /\ At("infer")
    /\ IF v.aborted
       THEN /\ v' = Goto("loop") /\ UNCHANGED d
       ELSE \* the stage carries the new inference identity
            /\ d' = [d EXCEPT !.pending = "inference", !.reqOpen = TRUE]
            /\ v' = [v EXCEPT !.resp = <<>>, !.blocks = 0, !.pc = "stream"]
    /\ UNCHANGED g

(* #collect: a listener sees a block begin; nothing durable yet.            *)
BlockBegin ==
    /\ At("stream") /\ ~v.aborted /\ ~g.partial /\ v.blocks < MaxBlocks
    /\ g' = [g EXCEPT !.partial = TRUE]
    /\ UNCHANGED <<d, v>>

(* #collect persist(): a finished text block is appended durably.           *)
BlockText ==
    /\ At("stream") /\ ~v.aborted /\ g.partial
    /\ d' = [d EXCEPT !.hist = Append(@, Rec("text", NoCall))]
    /\ v' = [v EXCEPT !.blocks = @ + 1]
    /\ g' = [g EXCEPT !.partial = FALSE]

(* #collect toolcall_end: a finished tool-call block is appended durably.   *)
BlockCall(k) ==
    /\ At("stream") /\ ~v.aborted /\ g.partial /\ g.nextCall <= NumCalls
    /\ LET c == g.nextCall IN
       /\ d' = [d EXCEPT !.hist = Append(@, Rec("call", c)), !.kind[c] = k]
       /\ v' = [v EXCEPT !.resp = Append(@, c), !.blocks = @ + 1]
       /\ g' = [g EXCEPT !.partial = FALSE, !.nextCall = @ + 1]

(* The response ends: done(normal|error|tool_call), a stream that ended    *)
(* without done, or a cancellation. The afterInference transaction          *)
(* (#recordContextTokens / #enterStage) retires the inference identity.     *)
(* A stream that ended without done keeps its queued input requested        *)
(* (#requestInference after #collect).                                      *)
StreamEnd(st) ==
    /\ At("stream")
    /\ IF v.aborted THEN st = "cancelled" ELSE st # "cancelled"
    /\ st = "tool_call" => v.resp # <<>>
    /\ g' = [g EXCEPT !.partial = FALSE]
    /\ d' = [d EXCEPT !.reqOpen = FALSE]
    /\ v' = [v EXCEPT
               !.needInf = FALSE,
               \* #clearTurnRequestIfNoPendingInput, then the stream-ended-early re-raise
               !.turnReq = IF st = "eof" /\ v.mq # <<>> THEN TRUE
                           ELSE IF v.mq = <<>> /\ ~v.comp THEN FALSE ELSE @,
               !.suNext = IF st \in {"normal", "error"} THEN "loop" ELSE "endTurn",
               !.pc = IF st = "tool_call" THEN "dispatch" ELSE "su"]

(* #settleUnansweredCalls, first transaction: stage error results in the   *)
(* durable batch; a call already dispatched belongs to the resume instead. *)
SettleUnanswered ==
    /\ At("su")
    /\ LET owed == Unanswered(d.hist) IN
       IF owed = {}
       THEN /\ v' = Goto(v.suNext) /\ UNCHANGED d
       ELSE IF \E c \in owed : d.tools[c] # "absent"
       THEN /\ v' = [v EXCEPT !.blocked = TRUE, !.pc = "endTurn"] /\ UNCHANGED d
       ELSE /\ d' = [d EXCEPT !.tools = [c \in Calls |-> IF c \in owed THEN "staged" ELSE @[c]],
                              !.pending = "tools"]
            /\ v' = Goto("su2")
    /\ UNCHANGED g

(* #settleUnansweredCalls, second transaction: append the staged results.  *)
SettleUnanswered2 ==
    /\ At("su2")
    /\ LET owed == {c \in Calls : d.tools[c] = "staged"} IN
       d' = [d EXCEPT !.hist = @ \o [i \in 1..Cardinality(owed) |-> Rec("tool", Sorted(owed)[i])],
                      !.tools = [c \in Calls |-> IF c \in owed THEN "absent" ELSE @[c]],
                      !.callKV = @ \ owed, !.claim = @ \ owed,
                      !.pending = "inference"]
    /\ v' = Goto(v.suNext)
    /\ UNCHANGED g

(* #dispatchToolBatch(resume=false): the batch and the "tools" stage commit *)
(* together before any call executes.                                       *)
Dispatch ==
    /\ At("dispatch")
    /\ d' = [d EXCEPT !.tools = [c \in Calls |-> IF c \in Range(v.resp) THEN "pending" ELSE @[c]],
                      !.pending = "tools"]
    /\ v' = [v EXCEPT !.batch = v.resp, !.resume = FALSE, !.res = [c \in Calls |-> "none"],
                      !.cidx = 0, !.execRet = "afterTools", !.pc = "exec"]
    /\ UNCHANGED g

InBatch(c) == At("exec") /\ c \in Range(v.batch) /\ v.res[c] = "none"

(* Per call in the batch (Promise.all over entries). A staged result is    *)
(* reused; a resumed non-durable call fails without running; otherwise the  *)
(* tool is executed (#executeToolCall).                                     *)
CallStart(c) ==
    /\ InBatch(c) /\ v.exec[c] = "idle"
    /\ IF d.tools[c] = "staged"
       THEN /\ v' = [v EXCEPT !.res[c] = "ok"] /\ UNCHANGED g
       ELSE IF v.resume /\ d.kind[c] = "plain"
       THEN /\ v' = [v EXCEPT !.res[c] = "err"] /\ UNCHANGED g
       ELSE IF v.aborted
       THEN \* cancelled before it started: answered as aborted, never executed
            /\ v' = [v EXCEPT !.res[c] = "err"] /\ UNCHANGED g
       ELSE /\ v' = [v EXCEPT !.exec[c] = "running"]
            /\ g' = [g EXCEPT !.execs[c] = @ + 1,
                              !.startAfterAbort = @ \/ v.aborted]
    /\ UNCHANGED d

(* The tool returns normally. *)
CallReturn(c) ==
    /\ InBatch(c) /\ v.exec[c] = "running"
    /\ v' = [v EXCEPT !.res[c] = "ok", !.exec[c] = "done"]
    /\ UNCHANGED <<d, g>>

(* call.commit(ctx, result): claim toolResult.<id>, stage the result in the *)
(* tool entry, clear the call KV -- one transaction.                        *)
CallCommit(c) ==
    /\ InBatch(c) /\ v.exec[c] = "running" /\ ~v.aborted
    /\ d.tools[c] = "pending"
    /\ d' = [d EXCEPT !.claim = @ \cup {c}, !.tools[c] = "staged", !.callKV = @ \ {c}]
    /\ v' = [v EXCEPT !.res[c] = "ok", !.exec[c] = "done"]
    /\ UNCHANGED g

(* A running tool writes its call-bound KV (durable tools keep retry state  *)
(* there) or the run KV. Through its own context this needs a live         *)
(* lifetime; through a foreign context only the handle's own bound applies: *)
(* both the call KV and the call's run KV handle are bounded by the call's   *)
(* lifetime (#callLifetimes), which ends when its result or commit()        *)
(* commits -- i.e. once its batch entry is no longer "pending".             *)
OwnCtxLive(c) ==
    v.pc = "exec" /\ c \in Range(v.batch) /\ v.res[c] = "none" /\ ~v.aborted
CallWriteKV(c) ==
    /\ v.up /\ v.exec[c] = "running" /\ c \notin d.callKV
    /\ \/ OwnCtxLive(c)
       \/ ForeignCtxTools /\ d.tools[c] = "pending"
    /\ d' = [d EXCEPT !.callKV = @ \cup {c}]
    /\ UNCHANGED <<v, g>>
CallWriteRunKV(c) ==
    /\ v.up /\ v.exec[c] = "running" /\ ~d.runKV
    /\ \/ OwnCtxLive(c)
       \/ ForeignCtxTools /\ d.tools[c] = "pending"
    /\ d' = [d EXCEPT !.runKV = TRUE]
    /\ UNCHANGED <<v, g>>

(* Promise.race(execution, abortPromise, closingTools) === ABORTED: the     *)
(* call gets an aborted error result; the execution unwinds in the          *)
(* background (#settleLater).                                               *)
CallAborted(c) ==
    /\ InBatch(c) /\ v.exec[c] = "running" /\ v.aborted
    /\ v' = [v EXCEPT !.res[c] = "err"]
    /\ UNCHANGED <<d, g>>

(* An abandoned execution finally returns. *)
CallUnwind(c) ==
    /\ v.up /\ v.exec[c] = "running" /\ v.res[c] # "none"
    /\ v' = [v EXCEPT !.exec[c] = "done"]
    /\ UNCHANGED <<d, g>>

(* commitReady(): results land strictly in call order, each in one          *)
(* transaction: first-writer-wins claim, append the tool record, delete the *)
(* tool entry and the claim, run afterToolCallTransact, clear the call KV.  *)
CommitNext ==
    /\ At("exec") /\ v.cidx < Len(v.batch)
    /\ LET c == v.batch[v.cidx + 1] IN
       /\ v.res[c] # "none"
       /\ d' = [d EXCEPT !.hist = Append(@, Rec("tool", c)), !.tools[c] = "absent",
                         !.claim = @ \ {c}, !.callKV = @ \ {c}]
       /\ v' = [v EXCEPT !.cidx = @ + 1]
    /\ UNCHANGED g

(* After the last result: recordPending("inference") -- a separate write.   *)
BatchDone ==
    /\ At("exec") /\ v.cidx = Len(v.batch)
    /\ d' = [d EXCEPT !.pending = "inference"]
    /\ v' = [v EXCEPT !.batch = <<>>, !.pc = v.execRet]
    /\ UNCHANGED g

(* Back in #runInferenceAttempt after a dispatched batch: needsInference.   *)
AfterTools ==
    /\ At("afterTools")
    /\ v' = [v EXCEPT !.needInf = TRUE, !.pc = "loop"]
    /\ UNCHANGED <<d, g>>

(* #runTurn tail and #runLoops condition. *)
EndTurn ==
    /\ At("endTurn")
    /\ v' = IF v.blocked THEN Goto("finally")          \* "blocked": leave the record
            ELSE IF v.turnReq THEN [v EXCEPT !.aborted = FALSE, !.pc = "turn"] \* "continue"
            ELSE Goto("loopEnd")                          \* "stop"
    /\ UNCHANGED <<d, g>>

LoopEnd ==
    /\ At("loopEnd")
    /\ v' = IF v.turnReq THEN Goto("loopOpen")
            ELSE IF Unanswered(d.hist) # {} THEN Goto("finally") \* #hasOpenToolCalls
            ELSE Goto("settleStage")
    /\ UNCHANGED <<d, g>>

(* #runTurns: #enterSettlementStage. One transaction reads the steering and *)
(* send queues; if any queued key is not one an abort abandoned, input was  *)
(* accepted since the settle decision and already recorded the inference it *)
(* owes, so nothing is written. Otherwise it records "settlement".          *)
SettleStage ==
    /\ At("settleStage")
    /\ IF \E i \in DOMAIN d.q : d.q[i].k \notin v.abandoned
       THEN UNCHANGED d   \* input accepted since the decision: keep what it owes
       ELSE d' = [d EXCEPT !.pending = "settlement"]
    /\ v' = Goto("settleTx")
    /\ UNCHANGED g

(* #settleRecord: read owed, #clearPending + afterAgentSettledTransact +    *)
(* #clearRunStore; work accepted since the settlement stage was recorded   *)
(* rewrote owed, and reopens as a fresh inference stage in the same commit. *)
SettleTx ==
    /\ At("settleTx")
    /\ d' = [d EXCEPT !.pending = IF d.pending = "settlement" THEN "none" ELSE "inference",
                      !.runKV = FALSE, !.reqOpen = FALSE]
    /\ v' = [v EXCEPT !.reopened = (d.pending # "settlement"), !.pc = "finally"]
    /\ UNCHANGED g

(* #startRun .finally: restart for a request that arrived while settling;   *)
(* otherwise, when an abort dropped the turn of work recorded as owed, run  *)
(* once more only to settle it. After an aborted run the requested          *)
(* compaction is rejected (abort()). Otherwise, when the settlement         *)
(* reopened the record for input nobody dropped, run a turn for it.         *)
Finally ==
    /\ At("finally")
    /\ LET settleOwed == ~v.turnReq /\ v.abortDropped /\ d.pending # "none"
           reopenRun  == ~v.turnReq /\ ~settleOwed /\ v.reopened IN
       v' = [v EXCEPT !.comp = IF v.abortedRun THEN FALSE ELSE @,
                      !.abortedRun = FALSE, !.aborted = FALSE,
                      !.settleAfterAbort = settleOwed, !.reopened = FALSE,
                      !.turnReq = @ \/ reopenRun,
                      !.pc = IF v.turnReq \/ settleOwed \/ reopenRun THEN "start" ELSE "idle"]
    /\ UNCHANGED <<d, g>>

(***************************************************************************)
Loop ==
    \/ Start \/ LoopOpen \/ Turn \/ ResumeTools \/ PostResume \/ CompactCheck
    \/ CompStage \/ CompSucceed \/ CompFail \/ Recovery \/ LoopTop \/ Consume
    \/ Infer \/ BlockBegin \/ BlockText \/ \E k \in Kinds : BlockCall(k)
    \/ \E st \in EndStates \cup {"cancelled"} : StreamEnd(st)
    \/ SettleUnanswered \/ SettleUnanswered2 \/ Dispatch
    \/ \E c \in Calls : CallStart(c) \/ CallReturn(c) \/ CallCommit(c) \/ CallAborted(c)
    \/ CommitNext \/ BatchDone \/ AfterTools \/ EndTurn \/ LoopEnd
    \/ SettleStage \/ SettleTx \/ Finally

Background == \E c \in Calls : CallUnwind(c) \/ CallWriteKV(c) \/ CallWriteRunKV(c)

Env == (\E m \in Msgs : Offer(m)) \/ Abort \/ RequestCompaction \/ Crash \/ Restart

Next == Loop \/ Background \/ Env

(* The loop, restart and tool unwinding make progress; the environment      *)
(* (offers, aborts, crashes, compaction requests) may stop at any time.    *)
Fairness ==
    /\ WF_vars(Loop)
    /\ WF_vars(Restart)
    /\ \A c \in Calls : WF_vars(CallUnwind(c))

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)
InQ(m) == Cardinality({i \in DOMAIN d.q : d.q[i].m = m})

TypeOK ==
    /\ d.pending \in Stages
    /\ d.ids \subseteq Msgs
    /\ \A i \in DOMAIN d.q : d.q[i] \in Entry
    /\ \A i \in DOMAIN d.hist : d.hist[i].t \in RecTypes
    /\ d.tools \in [Calls -> {"absent", "pending", "staged"}]
    /\ d.claim \subseteq Calls /\ d.callKV \subseteq Calls /\ d.runKV \in BOOLEAN
    /\ d.reqOpen \in BOOLEAN
    /\ v.up \in BOOLEAN /\ v.turnReq \in BOOLEAN /\ v.aborted \in BOOLEAN
    /\ v.res \in [Calls -> {"none", "ok", "err"}]
    /\ v.exec \in [Calls -> {"idle", "running", "done"}]

(* Every accepted ("created") message is, at every instant, either still  *)
(* queued or has entered the conversation -- exactly once per acceptance.  *)
AcceptedExactlyOnce ==
    \A m \in Msgs : g.consumed[m] + InQ(m) = g.created[m]

(* An identity is accepted again only after history replacement released it. *)
IdentityDedup ==
    \A m \in Msgs : g.created[m] <= 1 + g.released[m]

(* The durable identity key exists exactly while the message is queued or   *)
(* in the current conversation.                                              *)
IdentityTracksMessage ==
    \A m \in Msgs : (m \in d.ids) <=> (InQ(m) > 0 \/ m \in UserIdsIn(d.hist))

(* The conversation never holds a result without its earlier call, two     *)
(* results for one call, or one call twice.                                  *)
HistoryWellFormed ==
    \A i, j \in DOMAIN d.hist :
        /\ (d.hist[i].t = "tool" /\ d.hist[j].t = "tool" /\ i # j) => d.hist[i].x # d.hist[j].x
        /\ (d.hist[i].t = "call" /\ d.hist[j].t = "call" /\ i # j) => d.hist[i].x # d.hist[j].x
        /\ (d.hist[j].t = "tool") =>
              \E k \in DOMAIN d.hist : k < j /\ d.hist[k].t = "call" /\ d.hist[k].x = d.hist[j].x

(* A queued message is never appended between a call and its result: once  *)
(* a call is unanswered, only results, calls or text follow it.             *)
NoMessageInsideToolExchange ==
    \A i, j \in DOMAIN d.hist :
        (i < j /\ d.hist[i].t = "call" /\ d.hist[i].x \in Unanswered(d.hist))
            => d.hist[j].t \in {"call", "text", "tool"}

(* Once a result is in history, the batch entry, claim and call KV are gone *)
(* in that same transaction.                                                 *)
ToolStateClearedWithResult ==
    \A c \in ResultsIn(d.hist) :
        d.tools[c] = "absent" /\ c \notin d.claim /\ c \notin d.callKV

(* A settled agent keeps no pending tool state, claim, call KV or run KV.   *)
SettledCallStateClean ==
    d.pending = "none" =>
        /\ \A c \in Calls : d.tools[c] = "absent"
        /\ d.claim = {} /\ d.callKV = {}

SettledRunKVClean == d.pending = "none" => ~d.runKV

SettledIsClean == SettledCallStateClean /\ SettledRunKVClean

(* Batch entries exist only for calls that are in history and unanswered.   *)
ToolEntriesMatchHistory ==
    \A c \in Calls : d.tools[c] # "absent" => c \in Unanswered(d.hist)

(* A non-durable tool is never executed twice (in particular not after a    *)
(* crash).                                                                   *)
NonDurableAtMostOnce ==
    \A c \in Calls : d.kind[c] = "plain" => g.execs[c] <= 1

(* A call is executed at most once per process incarnation plus one.        *)
DurableBounded ==
    \A c \in Calls : g.execs[c] <= 1 + g.crashes

(* When a process dies, the store says "active" whenever work is left: a   *)
(* queued message, a dispatched batch, or an unanswered call.               *)
WorkImpliesActive ==
    (\/ d.q # <<>> /\ g.aborts = 0   \* an abort deliberately leaves queued input unowed
     \/ \E c \in Calls : d.tools[c] # "absent"
     \/ Unanswered(d.hist) # {})
    => d.pending # "none"
DurableWorkImpliesActiveAtCrash == ~v.up => WorkImpliesActive
(* The same, whenever the live process has nothing running.                 *)
WorkImpliesActiveWhenIdle == (v.up /\ v.pc = "idle") => WorkImpliesActive

(* Plan 20: a block begun by a dead process is reset before the agent       *)
(* settles or shows a new block.                                            *)
StaleBlockResetBeforeNewOutput == g.stale => (~g.partial /\ ~(v.up /\ v.pc = "idle"))

(* Plan 20: abort as fast as possible -- no tool execution starts after the  *)
(* turn was aborted.                                                         *)
NoToolStartAfterAbort == ~g.startAfterAbort

(* Messages are interchangeable model values; used only for safety checking. *)
MsgSymmetry == Permutations(Msgs)

(* ------------------------------ liveness -------------------------------- *)
(* The run always stops (settled or deliberately left for a resume).         *)
EventuallyQuiescent == <>[](v.up /\ v.pc = "idle")
(* Every accepted message eventually enters the conversation.                *)
EventuallyAllConsumed == <>[](d.q = <<>>)
(* Refined for aborts (intended): only an abort may leave accepted input     *)
(* queued, and then the store is settled rather than active over nothing.   *)
EventuallyConsumedUnlessAborted == <>[](d.q = <<>> \/ (g.aborts > 0 /\ d.pending = "none"))
(* The store eventually says "settled".                                     *)
EventuallySettled == <>[](d.pending = "none")
(* An abort always ends the aborted work (a new scope or idle).             *)
AbortTerminates == [](v.aborted => <>(~v.aborted \/ ~v.up))
=============================================================================
