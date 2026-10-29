# Agent Base learnings

## A settled prompt is not an interrupted run

A stopped turn settles like any other: its pending record is erased and no reply is recorded, so
the conversation ends with the person's prompt. Recovery read that shape alone as a cut-off run.
After a restart, the next message activated the agent, the stopped prompt was streamed again, and
the new message waited behind it.

Recovery now resumes from the transcript's shape only when an earlier process left its pending
record, or when the owner calls `start`. A new message never waits behind a prompt whose run
already settled. `create` also reads the inherited record before its first claim, as `load` does,
so an agent's own claim is never mistaken for an earlier process's unfinished work.

## Completed SQLite transactions return their connection to the upstream pool

The older libSQL client handed its connection to each transaction without taking it back,
so sequential transactions accumulated native connections and lost connection-local setup.
The core now uses libSQL client 0.18's upstream pool. A small bounded set of idle connections
is expected while the client remains open; zero connections after every transaction is not
a correctness requirement. Keep the shared database lock and ownership boundary, and use
upstream connection reuse rather than adding an application-owned pool.

The process-lifetime lock must reserve an explicit write transaction. A raw `BEGIN` issued
through the pooled client's root `execute` is rolled back as that call returns its connection,
silently releasing the owner lock. Retain the transaction handle and roll it back on release.

## An unavailable old provider must not prevent a provider switch

Checking Bedrock GPT context compatibility resolved both the old and new providers. If the old
provider was disabled or its factory could no longer resolve the route, that check threw before
the replacement message was accepted, leaving the existing conversation stuck on its old settings.

A failed compatibility lookup for the old route now means compatibility is unknown, just as when
the provider is absent from the registry. The switch uses the existing private-context reset and
`modelChanged` handoff, without replacing the agent or clearing module-owned durable history. The
new provider's lookup still fails normally: this does not enable a disabled account, choose an
unrequested fallback, or hide a broken replacement. Regression coverage includes removed and
disabled old providers, restored sessions, stable message acceptance, and later follow-up turns.

## The active flag must cover work accepted while the run settles

The run decides to settle in memory, records the settlement stage, and then deletes `owed`. A
message accepted in either gap was stranded: before the stage write, the write clobbered the
message's inference stage; after it, the settlement deleted the rewritten record. A crash, or a
drain that suppresses the in-process restart, then left the message queued behind a store that
looked settled, and owners restore only active agents. Now the stage write and a read of the
queues are one transaction, and the stage is not written while an entry is queued that no abort
or failure dropped (those keys are remembered in memory and forgotten when a turn starts that is
not already aborted; clearing them for a turn an abort in the loop hooks had already ended reopened the
store over input the abort had dropped).
The settlement transaction reads `owed` first; if it no longer holds the settlement stage, the
same commit settles the finished run and opens the next one with a fresh inference stage and
its activation. Only the owner's own record and queues are consulted, so this is not
multi-owner machinery.

## Abort keeps queued input queued, and never leaves the store active over nothing

An abort cancels the requested turn; messages already accepted stay queued for the next turn,
in memory and after a restart, and a restart does not run them on its own. That is deliberate.
What an abort must not do is leave `owed` set with no run: when it lands after the settlement
committed but before `#startRun`'s `finally`, while a message accepted in that window had made
the store active again, the `finally` now starts a run that only records the settlement stage
and settles it. An abort also never starts a tool: the batch answers calls of an aborted or
closing turn without executing them, and `#executeToolCall` checks again after its hooks.

## Owed work always has a run while its owner is live

Whenever the store says the agent is working and the owner is not draining or closing, a run
must be in flight or about to start; otherwise the agent looks busy forever and nobody is told.
Three paths broke this. A message sent after an abort but before the aborted turn began lost
its request, because the turn cleared `#turnRequested` on the way in; the settlement then
reopened the record for it with nothing left to run it. Now a turn that starts already aborted
claims no request. More generally, whenever `#settleRecord` reopens the record it says so
(`#reopenedBySettlement`), and `#startRun`'s `finally` starts another run for it. Drain and
close skip that restart and leave the store active for the next owner. A turn that fails used
to leave its queued input owed as well, and with the restart it would retry the same failure
forever. A failed turn now abandons its queued input the way a failed run or an abort does: the
input stays queued, the store settles, and nothing retries it until something asks for a turn.

## Only finished blocks survive a response, however it ends

A stream that ended without `done` returned its unfinished content, so an unfinished tool call
reached memory and was answered with a result the store had no call for. It now keeps only the
persisted blocks, emits `block_reset` for an unfinished one, and raises the turn request when
input is still queued so those messages are not stranded until some unrelated wake-up.

## A live inference identity means the response never ended

After a crash, the restart has to tell a response that was still streaming from one that had
finished. The inherited stage's `inferenceId` is that signal, so the transaction following every
response now retires it together with the token measurement (previously it survived whenever no
`afterInferenceTransact` hook was installed). A block or compaction left last under a live
identity is reset with `block_reset` and the response is continued.

The restart's `block_reset` depends on the inherited record, so it is decided before anything
can replace it. Stages written first used to hide it: a requested compaction's stage, or the
tools stage of a resumed or dispatched batch, and a process dying there left the next one owing
the response without resetting the listener's half-shown block. One guard at the start of the
restarted run now decides the reset from the inherited record alone, before the run writes any
stage: an inference stage with an open request gets it. Resetting whenever a response is owed
would be wrong the other way, since a stage can be recorded before any request opened; that
case is still left to the first loaded edge, which resets only when the conversation owes a
response.

## A continued response is continued from a durable notice, never from itself

Three paths request again from a conversation that ends with the model's own finished blocks: a
response cut off and reopened for a background notice it never answered, one resumed after a
restart, and one retried in Ethan mode. Claude on 4.6 and later models rejects that request
with "This model does not support assistant message prefill", so the turn failed instead of
continuing.

Before such a request, `#requestInference` appends a system notice, "Continue from where you
left off." (Claude Code's own resume prompt), in the inference-stage transaction that writes
the hook notifications. The condition is the provider context's last message having the
assistant role, so a trailing native compaction, which is a valid continuation, is left alone.

The notice has to be durable history. A provider adding a user turn to one request and
dropping it from the next would not work: Claude binds each thinking block to the exact
messages before it and permanently rejects a later request whose prefix changed, and reload
merges consecutive block records into one assistant message, so no provider-only projection
stays stable across requests.

## A call's store handles die when its result commits

The batch can commit an aborted result while the execution is still unwinding. The call's KV
handle used to stay live until `#executeToolCall` returned, and the run KV handle on the call
context was not bounded at all, so a tool writing through a context of its own could recreate
call or run state after settlement. Executions register their call lifetime, the batch aborts
it right after the commit that erases the call's state, and the call context's run KV handle is
bounded by the same lifetime.

## Resolving an idle agent must not start a run

After a restart every idle agent is unloaded, and `AgentSystemLocal` resolved one — for a
metadata update such as marking a chat read, an abort, a compaction, or a plain `resolve` — by
loading it and calling `start()`. `start()` always opens a loop, so the idle agent ran one empty
turn and settled it, and every settlement hook treated that as finished work: a collaborator or
subtask with no last answer reported "stopped without answering" to its creator, which woke the
creator for a real inference. Publishing a resolved agent, in or out of a transaction, now starts
it only when its store says it is `active`, the same rule startup and creation already follow.
Accepted messages, notices, and compactions start an idle agent through their own activation
path, so nothing that owes work is stranded.

## Only agents with work are restored at start

Start used to read every configuration and run every module's restoration hooks for every agent,
one transaction each. On a real home with about a thousand agents and none of them active, that
was most of the time to ready, and every restart also recorded `agent.restored` for each agent,
which the API turned into an `agent.updated` that bumped every agent's version. Start now decides
in one transaction: the agents whose `owed` record is valid, plus those a module names through
`agentsToRestoreTransact` (a wait left `waiting`, a run left open). Those are restored, and the
owing ones resumed, before ready. Every other agent is restored once per process by its first
use: a resolve, a delivery, a metadata change, an abort, a compaction, or an archival. Reading a
configuration or a relation is not a use. A created agent counts as restored.

Restoration runs under the identity lock, or inside the caller's transaction when the use is
transactional. An agent counts as restored only after that transaction commits, so a rollback
restores it again on its next use, while a second use inside the same transaction does not. The
database's FIFO holds through `afterCommit`, so the next transaction already sees the commit.
Uses inside one transaction take no identity lock, so two of them can run side by side; a
done-marker set after the hooks let both pass its check and restore and build the agent twice.
The transaction now keeps the restoration, and the load, as a promise from the moment the first
use begins it, and every other use waits for that one. An archival in the same transaction waits
for a load already running, so it closes that object instead of the load staging it afterwards
and publishing an agent whose identity was deleted.

Start loads an owing agent outside any transaction and without the identity lock a transaction
would take, so a restoration observer, or any message, can deliver to that agent in a
transaction while start is loading it; the transaction then publishes and starts its own
instance. Start therefore loads its instance unpublished and discards it when one is already
live, instead of failing with "already has a live instance".

The lazy-versus-eager comparison in `AgentSystemLocalRestore.test.ts` replays each left-behind
state through each first use and a fixed-seed random history, and requires the same answers,
durable state, and hook log as restoring every agent at start.

## Open: persistence failures are still survivable

Master plan 08 says a database failure terminates the system, but `#enterStage` without a hook,
`#enterSettlementStage`, `#settleRecord`, `#recordContextTokens`, and `#appendFailure` still
swallow write failures, and
`AgentSettlementFailure.test.ts` specifies that a run settles even when its failure note cannot
be written. Making these fatal needs a way to tell database failures from hook and provider
failures and a termination path owned by the agent system; that design has not been decided.

## A store written by a newer build is refused before anything migrates

The desktop app can put an older daemon on data a newer one wrote, for example after a switch
from the preview channel to stable or after a release is pulled. The old prefix check treated
the newer migrations as a corrupt ledger and threw a generic error. The daemon exited 1 and its
supervisor restarted it forever. It also checked one module at a time, so modules listed earlier
had already been migrated before a later module's newer data was found. `migrate` now reads every
ledger first. Applied keys past the end of a known module's list throw
`AgentStorageNewerDataError` before anything is applied, and the host turns that into a clean
refusal. A module this build does not have never triggers it, because its tables are additive
data this build never reads. An incompatible change therefore needs a migration in the module
that owns the data, even an empty one. `beforeMigrate` runs after the checks and before the
first pending migration, so a host can record the oldest build able to read the store before
that stops being true.

## PGlite receives its options in one object

`openAgentPGliteDatabase` called `new PGlite(dataDir, options)`. PGlite reads a non-string first
argument as the options object, so without a data directory every option was dropped without a
word. The opener now passes one options object. The PGlite test backend relies on this: each test
database loads a copy of one initialized data directory instead of running `initdb`. The seeded
restoration test opens sixty databases, and booting them took about three quarters of its time.
That had kept it just above CI's sixty-second limit on PGlite since it was written. It now takes
about twelve seconds locally.

## A module may erase an agent, but never wait for it

Admins asked to delete agents for good, conversations included, from a tool. `delete` waits for the
agent's loop to close, which deadlocks when a module or tool inside a loop asks. `erase` on
`AgentSystemRef` commits the deletion in one transaction and leaves the close to run after it, and
refuses the ref's own agent and its ancestors, so the code asking is never waiting on itself.
Modules drop what they keep about the agent in `agentErasedTransact`, in the same transaction.

## Verification

`verification/lean/` (Lean 4) and `verification/tla/` (TLA+) model this state machine. Keep
their transition tables in step with changes to the loop, the settlement, the tool batch, and
recovery.
