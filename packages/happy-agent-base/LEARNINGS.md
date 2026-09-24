# Agent Base learnings

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

## A call's store handles die when its result commits

The batch can commit an aborted result while the execution is still unwinding. The call's KV
handle used to stay live until `#executeToolCall` returned, and the run KV handle on the call
context was not bounded at all, so a tool writing through a context of its own could recreate
call or run state after settlement. Executions register their call lifetime, the batch aborts
it right after the commit that erases the call's state, and the call context's run KV handle is
bounded by the same lifetime.

## Open: persistence failures are still survivable

Master plan 08 says a database failure terminates the system, but `#enterStage` without a hook,
`#enterSettlementStage`, `#settleRecord`, `#recordContextTokens`, and `#appendFailure` still
swallow write failures, and
`AgentSettlementFailure.test.ts` specifies that a run settles even when its failure note cannot
be written. Making these fatal needs a way to tell database failures from hook and provider
failures and a termination path owned by the agent system; that design has not been decided.

## Verification

`verification/lean/` (Lean 4) and `verification/tla/` (TLA+) model this state machine. Keep
their transition tables in step with changes to the loop, the settlement, the tool batch, and
recovery.
