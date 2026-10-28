# Workflow learnings

## Daemon restart recovery

Agent Base restores active workflow collaborators before module `afterStart` runs. Workflow
startup must restore every durable running script and reattach each unanswered external call to
its persisted collaborator ID. Marking the run paused or creating a replacement agent loses the
live restoration edge and pays for the same call twice.

Register the recovered call's in-memory waiter before rereading its durable result. The restored
agent may settle while workflow startup is still rebuilding the script; the post-registration
read and settlement callback together cover both sides of that race without polling.

## Execution budgets belong to Python segments, not whole workflows

The harness owns Monty's pool; Compute does not own these subprocesses. Workflows dump and close
their session before awaiting an external function, then restore it into another checkout. Neither
external-call waiting nor earlier segments consumes the next segment's execution allowance. The
30-second sandbox execution budget and 31-second native request watchdog are not limits on the
whole workflow. Do not add a cumulative worker CPU limit as a substitute for parent-death cleanup:
the same native interpreter also serves Code Mode, whose OS callbacks can span many requests in
one Python call. Cancellation is checked before executing Python and after external awaits;
in-flight requests settle under their existing execution/request budgets.

macOS and Linux worker cleanup watches the native pool's IPC input from a separate native thread,
so losing the harness closes the pipe and ends busy Python without changing execution allowances
or checkout reuse. The module-owned worker must be built before source execution and is embedded
into standalone Agent binaries. No background agent-call waiting is turned into a wall deadline.

## Agents a run starts answer the mutation of the run that launched it

A workflow's agents were created through Collaboration, which read the owner's current run when
each agent started. The owner may have settled and started another run by then, so a later agent
answered that run's `mutationId`. The launch now records the launching run's mutation, from
History's `runMutationId`, and passes it to every `createAgent` call, `null` when there was none,
so a restored run keeps it too.

## A run's agents run in the owner's permission mode

Workflow agents always started in Auto, because a run's context names no agent. The launch now
records the owner's persistent mode, read from the module scope `run_workflow` is built with
rather than the call's context, which an Auto review elevates to read a script off disk. Every
agent the run starts uses it, including after a restart; `resume_workflow` records the owner's
mode at the time of the resume.
