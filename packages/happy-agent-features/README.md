# @slopus/happy-agent-features

Ready-made features for agents built on [`@slopus/happy-agent-base`](../happy-agent-base).

A feature is one independent capability: tools, instructions, and hooks that the agent merges
into the loop. Each feature here is self-contained, holds its state in the store the agent lends
it, and knows nothing about the others.

`@slopus/happy-agent-base` provides only the durable runtime and extension primitives. Concrete
capabilities and their documentation live here.

## Goal

Long-running work. The model starts a goal with `create_goal`, reads it with `get_goal`, and ends
it with `update_goal` by declaring it complete or blocked. When the agent would settle back to
idle with a goal still active, the feature sends it a message asking it to carry on, so the loop
starts another turn instead of stopping.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { GoalFeature } from "@slopus/happy-agent-features";

const agent = await Agent.create(ctx, { ...options, features: [new GoalFeature()] });
```

One instance serves every agent in a collection. Each agent's goal lives in that agent's own
feature store, so it follows the conversation and survives a restart. Pausing, resuming, and
clearing a goal belong to the person who set it: `readGoal`, `writeGoal`, and `clearGoal` are
exported for the host that offers those controls.

## System prompt

The instructions a model is written for. Every model is told how to behave in its own words, so
the prompt follows the model rather than the agent: the feature reads the selection from the scope
it is handed and returns that model's prompt, and an agent that switches models mid-conversation
is given the new one on the very next inference.

```ts
const agent = await Agent.create(ctx, { ...options, features: [new SystemPromptFeature()] });
```

A model with a prompt of its own gets that one; anything else falls back to the family its ID
names, and only then to the kind of provider serving it — a Claude model served through Bedrock is
still a Claude model. A model belonging to no known family gets the simple prompt, so there is
always a prompt. Pass `identity` to name the agent something other than Rig; it replaces the
`{{identity}}` and `{{name}}` markers the prompts carry.

## History

The agent's own record of what happened, which it can read back. It is not the model's context:
the context is what the provider is replaying right now and is compacted, reset, and thrown away
as the conversation moves, while the history is what was said and done, kept whether or not any
model can still see it.

```ts
const history = new HistoryFeature({ store });
const agent = await Agent.create(ctx, { ...options, features: [history] });
```

The feature records accepted user messages, each completed response, each tool result, and each
failed inference transactionally as the agent works. Strict archive failure propagation is the
default: the Agent Base transaction rolls back with the archive. Hosts that intentionally treat
history as advisory may pass `failureMode: "best-effort"` to contain archive failures. Hosts can
still use `record` for externally-authored messages. Reading is the `read_agent_history` tool for
the model and `read` for everyone else, over the same paging, searching, and size bounding.

The store is the host's: implement `HistoryStore` over a database, an archive, or an existing
transcript, and the feature keeps only in-flight assistant blocks in the supplied transactional
Agent KV. `HistoryStore.read` receives every page/search query, so the host enforces the hard
record bound before returning anything. Rig's archive additionally applies configurable bounded
retention while preserving the original positions of surviving records. `HistoryReader` is the
read-only structural contract used by model handoff and other consumers; it does not require the
concrete feature.

## Model switch

Switching between incompatible models erases the conversation: their transcripts cannot be
replayed to one another, so the new model starts with an empty context while the work the old one
did still stands. This feature puts one system message at the head of that fresh context saying
what changed and that a conversation it cannot see came before, so the model orients itself
instead of answering as though nothing happened.

```ts
const agent = await Agent.create(ctx, {
    ...options,
    features: [new ModelSwitchFeature({ historyTool: "read_agent_history" })],
});
```

Name `historyTool` when the agent has a tool that reads its durable history, and the notice tells
the new model to go and read what it can no longer see. Pass `history` — a `HistoryFeature` — and
the notice also carries an overview and both ends of the erased conversation, bounded, so the new
model starts by reading what happened rather than only being told that something did. A compatible
switch keeps the history and produces no notice.

## Compute

A machine to work on, as ten tools over one compute: `read_file`, `write_file`, `edit_file`,
`list_directory`, `find_files`, `search_files`, `run_command`, `read_command_output`,
`send_command_input`, and `stop_command`. They are common Rig tools rather than any vendor's, so
every model receives exactly these, under these names, with these arguments.

```ts
const compute = new ComputeFeature({ compute: hostCompute });
const agent = await Agent.create(ctx, { ...options, features: [compute] });
```

Two behaviours are worth knowing before using it. Reading a file is what earns the right to change
it: each agent's reads live in that agent's own store, and a write or an edit to a file it never
read — or read before somebody else changed it — is refused rather than quietly discarding that
work. And a command that outlives its wait is not killed: it goes on running with an ID the model
comes back to, which is what lets a dev server started in one turn still be serving in the next.
Every read of such a command returns only what arrived since the last one.

The compute is the host's, and the feature never disposes of it. Commands left running belong to
the compute, and disposing that compute is what ends them. For the person watching, the feature
exposes `runningCommands`, `readCommand` — which looks without taking output the model has not been
given yet — and `stopCommand`.

What the feature asks of a compute is declared here as a structural interface rather than imported,
so this package does not depend on `@slopus/happy-agent-compute`: a real compute satisfies it with
nothing to adapt, and so does anything else answering the same calls.

## Permissions

The mode an agent runs in, enforced. `@slopus/happy-agent-base` carries the mode — `read_only`,
`workspace_write`, `auto`, `full_access` — on every context and makes its changes durable, but it
enforces nothing, because it cannot know what a tool touches. This feature is what turns the mode
into behaviour.

```ts
const permissions = new PermissionsFeature({ reviewer });
const agent = await Agent.create(ctx, { ...options, features: [permissions] });
await agent.steer(
    ctx,
    { role: "user", content: [{ type: "text", text: permissionModeChangeNotice("read_only") }] },
    { permissionMode: "read_only" },
);
```

Every tool call is decided from what the tool itself declares. A tool that says it cannot be
contained by the sandbox is unavailable in Read only and Workspace write, and is refused without a
review, since there is nothing to review. Outside Auto nothing is reviewed and nothing is elevated:
the mode simply travels on the context and the tools that act on the machine obey it. In Auto, a
call the tool says needs reviewing goes to the reviewer, and an allowed call runs under Full access
only when the tool says that invocation cannot be carried out inside the sandbox — for that one
call, never for the agent.

The two refusals are different on purpose. A denial is a decision, and the model is told it is
final and must not be routed around. A reviewer that is absent, fails, or takes too long has
decided nothing, so the action is refused as unproven and the model is told to say what it needs
rather than to try again another way. Refusal after refusal ends the turn: once the person is out
of the loop, nothing else will stop it.

The feature decides; it never runs anything and it never owns the mode. Its decision comes back to
the agent as `beforeToolCall`'s answer — run the call, run it under Full access for its length, or
answer the model with a refusal — and the agent is what carries it out. The mode itself belongs to
the agent, so changing it means steering a message that carries it: the change takes effect exactly
where the conversation shows it did, never in the middle of a response or a running tool batch, and
`permissionModeChangeNotice` is the text to send with it. The listener is told about every change
and every decision, transactionally for the change and afterwards for the rest.
