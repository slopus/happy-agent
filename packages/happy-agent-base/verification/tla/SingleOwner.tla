----------------------------- MODULE SingleOwner -----------------------------
(***************************************************************************)
(* Single owner per store (master plan 20): exactly one AgentSystem        *)
(* connects to a store, and exactly one live AgentBase per agent within it. *)
(*                                                                         *)
(* Part 1 - the store. Code:                                               *)
(*   AgentSQLiteProcessLock.ts  acquireAgentSQLiteProcessLock: BEGIN        *)
(*       IMMEDIATE with busy_timeout 0 on "<db>.lock"; SQLITE_BUSY -> fail. *)
(*       Kernel/SQLite release it on close, exit or SIGKILL.               *)
(*   openAgentSQLiteDatabase.ts  the lock is taken BEFORE the real client  *)
(*       is created and released AFTER client.close().                    *)
(*   AgentDatabaseConnection.ts  every root statement/transaction enters    *)
(*       one FIFO; close() refuses new admissions and runs after all       *)
(*       admitted work (#enqueue).                                          *)
(*   AgentSystemLocal.#shutdown closes every agent, then releases the lock. *)
(*                                                                         *)
(* Part 2 - live instances inside one owner. Code:                          *)
(*   AgentSystemLocal.#resolve: per-agent asyncLock; re-check #agents;      *)
(*       AgentBase.load reads the store; re-check #agents; #publish.        *)
(*   AgentSystemLocal.#transactionAgent: inside a caller's transaction, no  *)
(*       per-agent lock; check #agents; load through the transaction;       *)
(*       publish in afterCommit (#publish throws on a second instance, but  *)
(*       stdlib drains the remaining afterCommit callbacks anyway).         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Procs,             \* processes (or AgentSystems) opening the same database path
    MaxOps,            \* database operations each owner may admit
    ResolveGapAllowsTx \* TRUE: another caller's transaction may run between a
                       \* resolver's last read and its synchronous #publish

None == "none"

VARIABLES
    lock,       \* holder of the kernel-backed lock on "<db>.lock"
    st,         \* per process: "down" | "open" | "closing" | "closed" | "crashed"
    inflight,   \* per process: admitted database operations not yet run
    ops,        \* per process: operations admitted so far (bound)
    badWrite,   \* ghost: a statement executed by a process not holding the lock
    \* part 2, one agent inside the owning process
    agents,     \* published live instances in #agents: subset of {"Y", "X"}
    started,    \* instances whose run loop was started
    y,          \* #resolve progress: "idle" | "locked" | "loaded" | "done"
    x,          \* #transactionAgent progress: "idle" | "inTx" | "committed" | "done"
    dbBusy      \* the root FIFO is held by the caller's transaction

vars == <<lock, st, inflight, ops, badWrite, agents, started, y, x, dbBusy>>

Init ==
    /\ lock = None
    /\ st = [p \in Procs |-> "down"]
    /\ inflight = [p \in Procs |-> 0]
    /\ ops = [p \in Procs |-> 0]
    /\ badWrite = FALSE
    /\ agents = {} /\ started = {} /\ y = "idle" /\ x = "idle" /\ dbBusy = FALSE

part2 == <<agents, started, y, x, dbBusy>>

(* ---------------------------- part 1: the store --------------------------- *)
Acquire(p) ==
    /\ st[p] \in {"down", "closed", "crashed"}
    /\ IF lock = None
       THEN lock' = p /\ st' = [st EXCEPT ![p] = "open"]
       ELSE UNCHANGED <<lock, st>>          \* AgentSQLiteDatabaseLockedError
    /\ UNCHANGED <<inflight, ops, badWrite, part2>>

Admit(p) ==   \* AgentDatabaseConnection.#admit
    /\ st[p] = "open" /\ ops[p] < MaxOps
    /\ inflight' = [inflight EXCEPT ![p] = @ + 1]
    /\ ops' = [ops EXCEPT ![p] = @ + 1]
    /\ UNCHANGED <<lock, st, badWrite, part2>>

Execute(p) == \* the FIFO runs an admitted statement or transaction
    /\ st[p] \in {"open", "closing"} /\ inflight[p] > 0
    /\ inflight' = [inflight EXCEPT ![p] = @ - 1]
    /\ badWrite' = (badWrite \/ lock # p)
    /\ UNCHANGED <<lock, st, ops, part2>>

BeginClose(p) == \* AgentSystemLocal.close -> connection.close(): refuse admissions
    /\ st[p] = "open"
    /\ st' = [st EXCEPT ![p] = "closing"]
    /\ UNCHANGED <<lock, inflight, ops, badWrite, part2>>

FinishClose(p) == \* the close job reaches the head of the FIFO: client.close, lock release
    /\ st[p] = "closing" /\ inflight[p] = 0
    /\ st' = [st EXCEPT ![p] = "closed"]
    /\ lock' = None
    /\ UNCHANGED <<inflight, ops, badWrite, part2>>

Crash(p) == \* SIGKILL: the kernel releases the lock; nothing of p runs again
    /\ st[p] \in {"open", "closing"}
    /\ st' = [st EXCEPT ![p] = "crashed"]
    /\ inflight' = [inflight EXCEPT ![p] = 0]
    /\ lock' = IF lock = p THEN None ELSE lock
    /\ UNCHANGED <<ops, badWrite, part2>>

(* -------------------- part 2: one live AgentBase per agent ---------------- *)
(* #resolve (no transaction): takes the per-agent lock and re-checks #agents. *)
YLock ==
    /\ y = "idle" /\ ~dbBusy
    /\ y' = IF agents # {} THEN "done" ELSE "locked"
    /\ UNCHANGED <<lock, st, inflight, ops, badWrite, agents, started, x, dbBusy>>
YLoad == \* AgentBase.load -> #loadPendingState reads through the root FIFO
    /\ y = "locked" /\ ~dbBusy
    /\ y' = "loaded"
    /\ UNCHANGED <<lock, st, inflight, ops, badWrite, agents, started, x, dbBusy>>
YPublish == \* re-check #agents, then #publish(agent, start = true)
    /\ y = "loaded"
    /\ ~ResolveGapAllowsTx => x \notin {"inTx"}
    /\ IF agents # {} THEN agents' = agents /\ started' = started
       ELSE agents' = {"Y"} /\ started' = started \cup {"Y"}
    /\ y' = "done"
    /\ UNCHANGED <<lock, st, inflight, ops, badWrite, x, dbBusy>>

(* #transactionAgent inside a caller's transaction (send/steer routed through *)
(* AgentSystem inside ctx.inTx).                                              *)
XBegin == \* the caller's transaction acquires the FIFO
    /\ x = "idle" /\ ~dbBusy
    /\ ~ResolveGapAllowsTx => y # "loaded"   \* the resolver's gap is microtask-only
    /\ dbBusy' = TRUE
    /\ x' = IF agents # {} THEN "done" ELSE "inTx"   \* `concurrent` check
    /\ UNCHANGED <<lock, st, inflight, ops, badWrite, agents, started, y>>
XCommit == \* commit; afterCommit: #publish (throws if another is live), then the
           \* message's #activateCommittedMessages starts the provisional run anyway
    /\ x = "inTx"
    /\ dbBusy' = FALSE
    /\ agents' = IF agents = {} THEN {"X"} ELSE agents
    /\ started' = started \cup {"X"}
    /\ x' = "done"
    /\ UNCHANGED <<lock, st, inflight, ops, badWrite, y>>
XEndIdle == \* a transaction that found a live instance just releases the FIFO
    /\ x = "done" /\ dbBusy
    /\ dbBusy' = FALSE
    /\ UNCHANGED <<lock, st, inflight, ops, badWrite, agents, started, y, x>>

Next ==
    \/ \E p \in Procs : Acquire(p) \/ Admit(p) \/ Execute(p) \/ BeginClose(p)
                        \/ FinishClose(p) \/ Crash(p)
    \/ YLock \/ YLoad \/ YPublish \/ XBegin \/ XCommit \/ XEndIdle

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ lock \in Procs \cup {None}
    /\ st \in [Procs -> {"down", "open", "closing", "closed", "crashed"}]

(* At most one process can use the database at a time. *)
OneOwner == Cardinality({p \in Procs : st[p] \in {"open", "closing"}}) <= 1
(* Every executed statement ran while its process held the lock: in           *)
(* particular nothing admitted before close runs after the lock is released. *)
NoWriteWithoutLock == ~badWrite
(* Exactly one live, running AgentBase per agent within the owner.           *)
OneLiveInstance == Cardinality(started) <= 1
=============================================================================
