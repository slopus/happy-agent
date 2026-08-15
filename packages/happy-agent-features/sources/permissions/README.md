# Permissions

The mode an agent runs in, enforced. `@slopus/happy-agent-base` carries the permission mode —
`read_only`, `workspace_write`, `auto`, `full_access` — on every context and makes changes to it
durable, but it enforces nothing, because the base runtime cannot know what any particular tool
touches. `PermissionsFeature` is what turns the mode into behavior: it decides, per tool call,
whether the call may run at all, whether it needs a review, and whether an approved call gets to
run with the sandbox lifted for its own length.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { PermissionsFeature, permissionModeChangeNotice } from "@slopus/happy-agent-features";

const permissions = new PermissionsFeature({ reviewer, listener, reviewTimeoutMs: 120_000 });
const agent = await Agent.create(ctx, { ...options, features: [permissions] });

await agent.steer(
    ctx,
    { role: "user", content: [{ type: "text", text: permissionModeChangeNotice("read_only") }] },
    { permissionMode: "read_only" },
);
```

The feature never owns the mode itself. The mode belongs to the agent, which carries it, persists
its changes, and hands it to every hook; changing it means steering the agent a message that says
so, which is `permissionModeChangeNotice(mode)`. That is what makes a new mode take effect exactly
where the conversation shows it did, never mid-response or mid-batch.

## Tools

This feature provides no tools of its own. Instead it installs two `AgentFeature` hooks that act on
every tool call any other feature offers, and one hook that supplies the model's instructions:

- `instructions(ctx, scope)` returns `permissionModeGuidance(scope.agent.permissionMode)`, one
  paragraph telling the model what mode it is working in and what that mode actually permits.
- `beforeToolCall(ctx, scope, call)` is where every decision is made. It returns `undefined` to let
  a call run unchanged, `{ type: "run", permissionMode: "full_access" }` to let it run elevated for
  that one call, or `{ type: "answer", content: [...], isError: true }` to refuse it with an
  explanatory message the model reads as the tool's result.
- `permissionModeChanged` / `permissionModeChangedTransact` announce a mode change to the listener,
  and `afterAgentSettled` clears the per-agent refusal count once a run ends.

The decision in `beforeToolCall` is read entirely off the tool being called, never off a list of
tool names:

1. If `tool.requiresAutoOrFullAccess === true` and the mode is `read_only` or `workspace_write`,
   the call is refused without a review — there is nothing to review, since the tool cannot be
   contained by the sandbox at all.
2. Outside `auto`, nothing is reviewed and nothing is elevated; the mode simply travels on the
   context and the tools that act on the machine obey it.
3. In `auto`, `tool.shouldReviewInAutoMode(args, ctx)` decides whether this invocation needs a
   review. A predicate that throws is treated as needing one. If it doesn't, the call runs as-is.
4. If it does, `tool.describeAutoPermissionAction?.(args, ctx)` (falling back to a generic
   description of the call) and `tool.shouldRunInFullAccessInAutoMode?.(args, ctx)` are read, and
   the request goes to the configured `PermissionReviewer`.
5. An `allowed` decision lets the call run, elevated to `full_access` for that one call only when
   the tool said this invocation cannot be carried out inside the sandbox. A `denied` decision, or
   one that never came back (no reviewer, a thrown error, or a timeout), produces a refusal.

A denial and an unproven review are told to the model as different things: a denial is final and
must not be routed around, while an unproven review decided nothing and the model is told to say
what it needs rather than retry. Refusals in a row (`refusalsBeforeStopping`, default 3) end the
turn by calling `agents.abort(ctx, agentId)`, because nothing outside the agent can otherwise break
a refusal loop once the person is no longer in it.

## External functions

- `new PermissionsFeature(options: PermissionsFeatureOptions)` — constructs the feature.
  `options.reviewer?: PermissionReviewer` decides Auto reviews; without one, every action that asks
  for review is refused as unproven. `options.listener?: PermissionFeatureListener` is told about
  every mode change and decision. `options.reviewTimeoutMs?: number` bounds how long a review may
  take (default 120,000ms) before it counts as unanswered. `options.refusalsBeforeStopping?: number`
  sets how many refusals in a row end a turn (default 3). One instance serves every agent in a
  collection, keeping only an in-memory count of refusals per agent ID.
- `PermissionReviewer.review(ctx, request: PermissionReviewRequest): Promise<PermissionReviewDecision>`
  is the contract a host implements. `PermissionReviewRequest` carries `agentId`, `callId`, the
  resolved `tool`, its validated `arguments`, the `action` description, the `mode` (always `auto`,
  the only mode that reviews), and `elevates` (whether an approval also lifts the sandbox).
  `PermissionReviewDecision` is `{ outcome: "allowed", reason? }` or `{ outcome: "denied", reason }`.
  Review must never become a question put to the person and must answer in bounded time.
- `PermissionFeatureListener` has two optional callbacks that both see every `PermissionEvent`, but
  at different points: `onEventTransactional(ctx, event)` runs inside the transaction that commits a
  mode change, before it commits, so a listener's own record of the change is committed with it (and
  its failure rolls both back). `onEvent(ctx, event)` runs once a change is durable, and it is the
  only callback called for per-call decisions, which commit nothing. `PermissionEvent` is a
  discriminated union: `permission_mode_changed`, `permission_action_reviewed`,
  `permission_action_denied`, `permission_action_unproven`, `permission_action_out_of_mode`, and
  `permission_turn_stopped`.
- `permissionModeGuidance(mode: AgentPermissionMode): string` returns the instructions paragraph for
  a given mode; it is what `instructions()` uses, and it is exported so a host can reuse the same
  wording elsewhere.
- `permissionModeChangeNotice(mode: AgentPermissionMode): string` returns the message to steer at
  the agent when changing its mode, carrying both the announcement and the same rules paragraph.

## Storage

The feature persists nothing. It keeps no state in `AgentKV`, `sharedKV`, `runKV`, or any
call-scoped store, and it takes no store of its own in its constructor. All the state it holds is a
private in-memory `Map<agentId, number>` of consecutive refusals per agent, which exists only for
the lifetime of the process and is cleared whenever a refusal streak resets, an agent's run settles
(`afterAgentSettled`), or the process restarts. The mode itself — the thing this feature enforces —
is not this feature's to persist; it lives on the agent (`scope.agent.permissionMode`) and its
durability is `@slopus/happy-agent-base`'s responsibility, not this feature's. Anything durable
about permission decisions — an audit log, a review history — is the host's own responsibility,
built on top of the events the feature reports through `PermissionFeatureListener`.
