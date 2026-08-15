# Model switch

Switching between incompatible models erases the conversation: their transcripts cannot be
replayed to one another, so `@slopus/happy-agent-base` gives the new model an empty context while
the work the old one did still stands. Left alone, the new model would answer the next message as
though nothing had happened, silently repeating or undoing work it cannot see. This feature puts
one system message at the head of that fresh context saying what changed and that a conversation
it cannot see came before, so the model orients itself instead.

A compatible switch — one that keeps the history intact — needs no notice, and none is produced.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { ModelSwitchFeature } from "@slopus/happy-agent-features";

const agent = await Agent.create(ctx, {
    ...options,
    features: [new ModelSwitchFeature({ historyTool: "read_agent_history" })],
});
```

`ModelSwitchFeatureOptions` takes two optional fields, both otherwise unused:

- `historyTool` — the name of a tool the agent offers that reads its durable history. When set,
  the notice tells the new model to use it. Must be a non-empty string of at most 256 characters
  with no `\0`, `\r`, or `\n`.
- `history` — a `HistoryReader` (typically a `HistoryFeature`). When set, the notice also carries
  an overview and both ends of the erased conversation, bounded, so the new model starts by reading
  what happened rather than only being told that something did.

## Tools

This feature provides no tools of its own. It acts entirely through the `modelChanged` hook on
`AgentFeature`, producing a single system-role notice message that `@slopus/happy-agent-base`
inserts at the start of the new model's context. When `historyTool` is configured, the notice
names that tool and tells the model to call it proactively; the tool itself belongs to whichever
feature offers it (`HistoryFeature`'s `read_agent_history`), not to this one.

## External functions

`ModelSwitchFeature` is a class implementing `AgentFeature`; hosts use it only by constructing it
and passing it into `Agent.create`'s `features` array. Its hooks:

- `beforeStart(ctx, agents: AgentSystemRef): Promise<void>` — keeps a reference to the agent
  collection, which is where a model's picker label comes from when naming it in the notice.
- `modelChanged(ctx, scope: AgentFeatureScope, change: AgentBaseModelChange): Promise<SessionSystemMessage | undefined>` —
  called by the agent base whenever a consumed message changes the effective model. Returns
  `undefined` when `change.wasReset` is false (a compatible switch). Otherwise it builds and
  returns one `{ role: "system", content: [{ type: "text", text }] }` message. `change` carries
  `previousModel`, `model`, `previousProvider`, `provider`, `providers` (the `AgentProviders`
  registry), and `wasReset`.

The package also exports `createModelSwitchNotice(notice: ModelSwitchNotice): string`, the pure
function that renders the notice text from `previousModel`, `previousProvider`, `model`,
`provider`, and the optional `historyTool` and `excerpt` fields. It is exported so hosts and tests
can inspect or reuse the exact wording without going through the feature; `ModelSwitchFeature`
calls it internally to build the message it returns from `modelChanged`.

Building the notice's excerpt is the feature's other main piece of work: when `history` is
configured, `modelChanged` reads the first and last `EXCERPT_READ_PAGE_SIZE` (100) records via
`history.messages`, validates and merges the two bounded pages, and — when `history.stats` is
present and its counts are consistent with what was sampled — uses it for an exact aggregate
instead of a sampled one. A failure anywhere in this step (an unreadable history, invalid or
unstable records, an over-large merged result) is caught and simply drops the excerpt; it never
fails the switch itself, since rejecting `modelChanged` would leave the agent stuck on the old
model, which is worse than a notice with nothing quoted. The excerpt text itself keeps the
beginning and end of the conversation (4 earliest messages, 8 latest, each message capped at 1,500
characters) within a 32,000-character budget, since the middle of a long conversation rarely fits
and is rarely what matters after a switch.

## Storage

The feature persists nothing itself. It is stateless across calls except for the one in-memory
reference to `AgentSystemRef` captured in `beforeStart`, which lives only for the lifetime of the
`ModelSwitchFeature` instance and is not written to any KV.

It depends on state owned elsewhere:

- The agent's model and provider, and whether the last change was a reset, come from
  `AgentBaseModelChange`, computed and persisted by `@slopus/happy-agent-base` itself.
  `ModelSwitchFeature` only reads it.
- The optional `history` a host supplies is read through the `HistoryReader` structural interface
  (`messages`, and optionally `stats`); how or where that history is stored is entirely up to
  whatever implements it, typically `HistoryFeature`'s injected `HistoryStore`. This feature never
  writes to it.
