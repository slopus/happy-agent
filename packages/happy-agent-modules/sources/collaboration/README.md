# Collaboration

Lets one agent put another to work.

```ts
const abort = new AbortModule(compute);
new CollaborationModule(config, abort);
```

The module takes the config module and abort module for transactional descendant-tree cancellation,
then reaches the rest of the runtime through the `AgentSystemRef` it is handed at `beforeStart`.
`features.cross_workspace`, enabled by default, controls whether a known Agent ID may route a
message outside direct collaboration ancestry.

## How it works

Agents are actors. Each one already has a durable inbox, a stable identity, and a parent, and all
three belong to Agent Base. So this module keeps almost nothing: no tables, no roster. Every
question it answers is asked of the agent collection, and every message it sends goes into the
recipient's real inbox. The single exception is one note in the run store, holding the last thing a
running model said so it can be reported when that run ends.

That is the whole design, and most of what this module used to contain was a second, worse copy of
things the runtime already does.

### How agents text each other

`send_agent_message` calls `AgentSystemRef.steer` in both directions. A creator's follow-up steers
its collaborator, and a collaborator's reply steers its creator, so either recipient incorporates
the message after its current response and complete tool batch. The message ID is the sender's own
durable tool-call ID, so a retried tool call delivers the same message rather than a second one —
Agent Base settles that, not this module.

The recipient's model only ever sees text, so the delivered message names its sender:

```
Message from agent a3f2:

Review the parser change.
```

That name is the address. Answering is not a separate operation: the recipient calls
`send_agent_message` back to the agent the message came from.

Every agent's own address is stated in the module's instructions. Its creator and collaborator
addresses are rebuilt every turn from `parentOf` and `childOf`:

```
Your Agent ID is b7c1.
You were created by agent a3f2. When you stop working, whatever you said last is reported to it
automatically, so finish by stating your answer. Use send_agent_message only to tell it something
before then.
Collaborators you created: b7c1, b7c2. Each reports back on its own when it finishes; nothing waits
for them.
```

That matters because the `Message from agent ...` line ages out of history on compaction, while the
relationship does not — an agent that could not name its creator would have no way to answer it.
Nothing is stored to make this work; the ancestry is read from the agent collection each turn.

### A collaborator's answer comes back on its own

Nothing waits, so a creator would otherwise depend on the model remembering to report — and a model
that has stopped working is no longer following instructions. The runtime closes that gap instead:
when a collaborator's loop settles, the module sends its creator whatever the collaborator said
last, verbatim.

```
Collaborator b7c1 finished working. Its answer follows, verbatim.

The parser change looks correct, but it drops the trailing newline case.
```

A run that said nothing still reports that it stopped. A hard stop may be settled after a restart,
when the process no longer retains the original error; reporting the stop ensures the creator never
waits for an answer that cannot arrive. A run explicitly interrupted by its creator is different:
the interrupt result already tells the creator what happened, so settlement sends no automatic
report and never relabels the child's last progress update as a finished answer.

A run that _failed_ is not silent, though. It stopped for a reason, and that reason is reported in
place of the answer:

```
Collaborator b7c1 stopped without answering. It failed with, verbatim.

You've hit your Codex usage limit on the ChatGPT Pro plan. Try again at Aug 19, 2026, 11:30 PM.
```

Nothing waits for a collaborator, so a failure that reported nothing would leave its creator
expecting an answer that can never arrive. The reason is also what decides whether to retry, to send
the work to a different model, or to give up, and the creator can discover it no other way. The
reason comes from the settlement itself: every run settles, failed ones included, and the settlement
carries the failure that ended the run — including one thrown out of the loop, which the
conversation could never record. A run that recovers and goes on to speak settles without a failure,
so it reports what it said rather than what it survived.

When settlement has no retained reason and the collaborator said nothing, the creator receives the
short terminal report `Collaborator b7c1 stopped without answering.` instead.

The message is tagged
`collaboration.kind = "subagent_report"` with the collaborator's `fromAgentId`, which is what a
presentation layer keys on to render it as a notice rather than as an agent talking. It is sent
under the settlement's own identity, so a retried report is the same message rather than a second
one.

The last thing the model said is kept in the **run store** while the run is in progress — the only
state this module keeps. That store exists only for the duration of a run and is erased by the
transaction that settles it.

Reading it and delivering the report both happen inside that settling transaction, which is what
makes the report reliable. The report uses `steer`, so an active creator receives it after its
current response and tool batch instead of waiting until the creator would otherwise stop.
`steer` composes with an outer storage transaction: the queue entry is written in it, an idle
creator is loaded to receive it, and the run that reads it starts only once the transaction
commits. So the collaborator has stopped and its creator has been told, or neither is true. If the
delivery fails, the settlement rolls back with it and the run stays recorded as unfinished, so the
report is made again the next time it settles rather than being lost.

### Messages are asynchronous, always

Nothing here waits. There is no `wait_for_reply`, no reply obligation, and no record that an answer
is owed. A message is delivered and the sending agent carries on with its turn. Messages in either
direction steer an active recipient after its current response and complete tool batch.

This is what makes the module small. A synchronous request/response would need the answer to reach
an agent that is parked inside its own tool call — which its own run loop cannot deliver, because
that loop is busy running the tool that is waiting. Every mechanism that used to exist here
(obligations, a doorbell, a message log, retention) existed to work around that one problem.

### Who can reach whom

Direct ancestry, read from `parentOf`, is always allowed. An agent may message the collaborators it
created and the agent that created it in both directions, which is what makes an answer an ordinary
message.

When `features.cross_workspace` is enabled, an agent may also message any existing agent whose
unguessable Agent ID has been shared with it. Agent Base resolves that ID from its own durable
collection, so this needs no second roster and works for roots in different workspaces. The prompt
states the current agent's own ID and explains the routing rule. Unknown IDs are refused. This
broader access applies only to messaging; interruption remains direct-ancestry-only.

### What a collaborator runs on

Chosen once, on the message that starts it working, and never again.

`create_agent` creates the agent and sends its opening task in one call, because that first message
is the only place a model, effort, provider, and service tier can be expressed — `AgentCreateOptions`
carries no selection. Every later message carries none of them, so an agent that can talk to a
collaborator cannot turn it into a different model, make it think harder, or widen its permissions.

The requested selection is validated against the live `AgentSystemRef.models` filtered by each
provider's `include_subagent_models` and `exclude_subagent_models` before anything is created, so a
model the collection does not offer to subagents is refused rather than reaching a provider. The
same filtered list is rendered in the model-facing tool description. When the call omits
`provider`, the tool uses its creator's current provider if that provider serves the requested
model; otherwise an unambiguous model route is still accepted and an ambiguous one is refused.
Direct workflow creation passes through the same validation.

`max_collaborators` in `[settings]` controls how many collaborators created through `create_agent`
one root agent tree retains across all branches and defaults to five. Collaborators are durable and
reusable, so completed agents still count and accept later work through `send_agent_message`.
Parallel tool calls share one reservation path and cannot race past the configured limit.
Workflows call the module operation directly instead of going through the tool and remain under the
workflow system's separate call limit. Workflow metadata is an explicit tree boundary, so those
agents do not consume their owning agent's tool budget; if a workflow agent itself calls
`create_agent`, it receives a fresh tool budget rooted at that workflow agent.

`max_collaboration_depth` in `[settings]` controls `create_agent` ancestry and defaults to three
agents including the root: root, child, and grandchild. Direct workflow creation is excluded
because workflows enforce their own limits.

A collaborator inherits its creator's environment and module configuration, and the `title` the
call gave it is written to the agent's **real** `AgentMetadata` — not to a record of this module's
own — so whatever shows a person their agents names it the same way it names every other.

## Tools

| Tool                 | Effect                                                       |
| -------------------- | ------------------------------------------------------------ |
| `create_agent`       | Creates a capped collaborator and delivers its opening task. |
| `send_agent_message` | Delivers one message to an allowed agent by Agent ID.        |
| `interrupt_agent`    | Aborts a collaborator subtree and hard-kills its processes.  |

`interrupt_agent` is reviewed in Auto mode; the other two are not. Before process trees receive
their immediate hard kill, Compute stores a one-shot notice for each affected process owner and
prepends it to that agent's next inference. The tool never waits for any run to settle.

## Host operations

None. Listing an agent's collaborators is `AgentSystem.childOf` plus `config(id).metadata.title`,
which callers do directly.

## Migrations

The module declares four, and none of them creates anything. `001-collaboration`,
`002-drop-collaboration-receipts`, and `003-collaboration-run-state` are the released keys, kept as
markers with empty bodies, and `004-collaboration-storage-removed` drops the tables they used to
install. They exist because Agent Base requires a database's applied migrations to remain a prefix
of the module's declared list: removing a released key would stop every agent whose database
remembers it from starting at all. The list can only shrink, and only once no such database is
left.
