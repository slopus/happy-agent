# Model switch

Switching between incompatible models or changing the request's opaque profile erases the private
model conversation. `@slopus/happy-agent-base` gives the active model an empty context while the
work already done still stands. Left alone, the model would answer the next message as though
nothing had happened, silently repeating or undoing work it cannot see. This module puts one
system message at the head of that fresh context saying what changed and that a conversation it
cannot see came before, so the model orients itself instead.

A compatible switch — one that keeps the history intact — needs no notice, and none is produced.
Neither does a new agent's first message. An agent that never had a model never held a conversation
either, so its opening selection settles the model rather than replacing one; the base still reports
that as a reset because it discards the empty context, but there is no erased work to inherit.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { HistoryModule, ModelSwitchModule } from "@slopus/happy-agent-modules";

const history = new HistoryModule();
const agent = await Agent.create(ctx, {
    ...options,
    modules: [history, new ModelSwitchModule(history)],
});
```

The constructor takes one optional argument: the `HistoryModule` instance, the same one passed to
`modules`. This is a direct reference to the class, not a duck-typed reader and not a tool name
configured separately: `ModelSwitchModule` calls `history.readExcerpt` itself, and always knows
`HistoryModule`'s one tool is `read_agent_history` because that name is fixed.

Model switching itself never requires a history to behave correctly. Without one, the notice still
tells the new model plainly that an invisible conversation came before and that it must not repeat
or undo work that may already be done — which is honest and sufficient on its own, and is why
`history` is optional rather than required. When it is supplied, the notice additionally carries an
overview and both ends of the erased conversation, bounded, plus a pointer at `read_agent_history`
for anything the excerpt does not cover — so the new model starts by reading what happened rather
than only being told that something did.

## Tools

This module provides no tools of its own. It acts entirely through the existing `modelChanged` hook on
`AgentModule`, producing a single system-role notice message that `@slopus/happy-agent-base`
also invokes for profile resets. It produces a single system-role notice message that Base inserts
at the start of the fresh context. When `history` is supplied, the notice names
`read_agent_history` and tells the model to call it proactively; that tool itself belongs to
`HistoryModule`, not to this one, and the history module must be in the `modules` array itself for
the tool to actually be available to the model.

## External functions

`ModelSwitchModule` is a class implementing `AgentModule`; it is used only by constructing it
and passing it into `Agent.create`'s `modules` array. Its hooks:

- `beforeStart(ctx, agents: AgentSystemRef): Promise<void>` — keeps a reference to the agent
  collection, which is where a model's picker label comes from when naming it in the notice.
- `modelChanged(ctx, scope: AgentModuleScope, change: AgentBaseModelChange): Promise<SessionSystemMessage | undefined>` —
  called by the agent base whenever a consumed message changes the effective model or its opaque
  profile resets the context. A profile reset is the reset case where the previous and current
  model/provider values are equal. Returns
  `undefined` when `change.wasReset` is false (a compatible switch) and when `change.previousModel`
  is `undefined` (a new agent settling its first selection). Otherwise it builds and
  returns one `{ role: "system", content: [{ type: "text", text }] }` message. `change` carries
  `previousModel`, `model`, `previousProvider`, `provider`, `providers` (the `AgentProviders`
  registry), and `wasReset`; no profile value is exposed or placed in model input.

The package also exports `createModelSwitchNotice(notice: ModelSwitchNotice): string`, the pure
function that renders the notice text from `previousModel`, `previousProvider`, `model`,
`provider`, and the optional `historyTool` and `excerpt` fields. It is exported so callers and
tests can inspect or reuse the exact wording without going through the module; `ModelSwitchModule`
calls it internally to build the message it returns from `modelChanged`.

The excerpt itself is the history module's work, not this one's: `modelChanged` calls
`history.readExcerpt(ctx, agentId, 32_000)` and passes what comes back straight to the notice.
Reading both ends of the archive, merging and deduplicating the pages, and preferring exact totals
over sampled ones all belong to whoever owns the records. A failure here is caught, logged as a
warning, and simply drops the excerpt; it never fails the switch itself, since rejecting
`modelChanged` would leave the agent stuck on the old model, which is worse than a notice with
nothing quoted. An empty archive drops it too — there is nothing to quote. What the excerpt keeps
is the beginning and end of the conversation (4 earliest messages, 8 latest, each capped at 1,500
characters) within the 32,000-character budget, since the middle of a long conversation rarely
fits and is rarely what matters after a switch.

## Storage

The module persists nothing itself. It is stateless across calls except for the one in-memory
reference to `AgentSystemRef` captured in `beforeStart`, which lives only for the lifetime of the
`ModelSwitchModule` instance and is not written to any KV.

It depends on state owned elsewhere:

- The agent's model and provider, and whether the last change was a model/profile reset, come from
  `AgentBaseModelChange`, computed and persisted by `@slopus/happy-agent-base` itself.
  `ModelSwitchModule` only reads it.
- The optional `history` is the same `HistoryModule` instance that owns and persists the archive
  itself; `ModelSwitchModule` holds a direct reference to it and only ever reads from it, through
  `history.readExcerpt`, never writing to it.
