# Permissions

The mode an agent runs in, enforced. `@slopus/happy-agent-base` carries the permission mode —
`read_only`, `workspace_write`, `auto`, `full_access` — on every context and makes changes to it
durable, but it enforces nothing, because the base runtime cannot know what any particular tool
touches. `PermissionsModule` is what turns the mode into behavior: it decides, per tool call,
whether the call may run at all, whether it needs a review, and whether an approved call gets to
run with the sandbox lifted for its own length.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { PermissionsModule, permissionModeChangeNotice } from "@slopus/happy-agent-modules";

const permissions = new PermissionsModule(compute, auto);
const unsubscribe = permissions.onEvent(async (ctx, event) => {
    await conversations.recordAgentEvent(ctx, event.agentId, "permission_event", event);
    await events.record(ctx, { type: "permission.event", ...event });
});
permissions.provideToolGuidance(activeToolGuidance);
const agent = await Agent.create(ctx, { ...options, modules: [permissions] });

await agent.steer(
    ctx,
    { role: "user", content: [{ type: "text", text: permissionModeChangeNotice("read_only") }] },
    { permissionMode: "read_only" },
);
```

The module never owns the mode itself. The mode belongs to the agent, which carries it, persists
its changes, and hands it to every hook; changing it means steering the agent a message that says
so, which is `permissionModeChangeNotice(mode)`. That is what makes a new mode take effect exactly
where the conversation shows it did, never mid-response or mid-batch.

## Tools

This module provides no tools of its own. Instead it installs two `AgentModule` hooks that act on
every tool call any other module offers, and one hook that supplies the model's instructions:

- `instructions(ctx, scope)` returns `permissionModeGuidance(scope.agent.permissionMode, tools)`.
  It includes the mode rules, the sandbox limits, and (in Auto) the deduplicated
  `autoPermissionInstructions` declared by the active tools. Agent Base keeps its merged tool list
  private and no module in this package can answer what it holds, so every source registered
  through `provideToolGuidance(provider)` is merged, in registration order, to supply those prompt
  fields. See "The one seam that is still a host's" below.
- `beforeToolCall(ctx, scope, call)` is where every decision is made. It returns `undefined` to let
  a call run unchanged, `{ type: "run", permissionMode: "full_access" }` to let it run elevated for
  that one call, or `{ type: "answer", content: [...], isError: true }` to refuse it with an
  explanatory message the model reads as the tool's result.
- `permissionModeChanged` / `permissionModeChangedTransact` announce a mode change to every
  subscriber, end the commands still running under the wider mode by asking `ComputeModule` for
  them, report a failed cleanup when one occurs, and `afterAgentSettled` clears the per-agent
  refusal circuit once a run ends.

The decision in `beforeToolCall` is read entirely off the tool being called, never off a list of
tool names:

1. If `tool.requiresAutoOrFullAccess === true` and the mode is `read_only` or `workspace_write`,
   the call is refused without a review — there is nothing to review, since the tool cannot be
   contained by the sandbox at all.
2. Outside `auto`, nothing is reviewed and nothing is elevated; the mode simply travels on the
   context and the tools that act on the machine obey it.
3. In `auto`, `tool.shouldReviewInAutoMode(args, ctx)` decides whether this invocation needs a
   review. A predicate that throws is treated as needing one. If it doesn't, the call runs as-is.
4. If it does, `tool.describeAutoPermissionAction?.(args, ctx)` and
   `tool.shouldRunInFullAccessInAutoMode?.(args, ctx)` are read. A missing or blank action
   description is a tool-definition error and is refused without inventing a generic action. The
   request then goes to the configured `PermissionReviewer`.
5. An `allowed` decision is checked again by the independent Auto policy: critical risk is never
   allowed, and high risk requires at least medium user authorization. A policy-rejected or
   reviewer-denied decision produces a final refusal. A decision that never came back (no reviewer,
   a thrown error, or a timeout) produces an unproven refusal.

A denial and an unproven review are told to the model as different things: a denial is final and
must not be routed around, while an unproven review decided nothing. A timeout permits one retry or
asking the user how to proceed; an unavailable reviewer directs the model to work without that
permission or ask the user. `PERMISSION_REFUSALS_BEFORE_STOPPING` (3) refusals in a row, or 10
refusals within the last 50 permission decisions, end the turn by calling
`agents.abort(ctx, agentId)`. Allowed calls clear only the consecutive streak, not the bounded
long-window rate.

## External functions

- `new PermissionsModule(compute: ComputeModule, auto?: AutoModule)` — constructs the module.
  `compute` is the machine the agents work on: a committed reduction of the mode has to end the
  commands still running under the wider one, so the module asks the module that owns those
  commands (`runningCommands` / `stopCommand`) rather than being handed a way to end them; a
  failure there is reported as `permission_mode_cleanup_failed` and never undoes the change.
  `auto` is the automatic reviewer, and it is optional because an agent may be composed without
  one — with no reviewer every action that asks to be reviewed is refused as unproven, which is
  honest rather than refused as unsafe. The reviewer is read off the module at the moment of each
  review, not captured at construction. One instance serves every agent in a collection, keeping
  only bounded in-memory refusal circuits per agent.
- `onEvent(listener): PermissionUnsubscribe` — be told about every mode change and decision once it
  is durable. This is where a host makes permission history its own; the module keeps nothing of
  the sort itself. The returned function ends the subscription, and calling it more than once does
  nothing further.
- `onEventTransactional(listener): PermissionUnsubscribe` — be told about a mode change inside the
  transaction that commits it, so a listener keeping its own record commits that record with the
  change and a listener that fails rolls both back. Only a mode change commits anything; a per-call
  decision is reported through `onEvent` alone.
- `provideToolGuidance(provider): PermissionUnsubscribe` — register where the Auto guidance of the
  currently active tools comes from. Every registered source is merged, in registration order,
  under one shared bound; a fixed list is registered as a function returning it. A provider that is
  not a function is rejected.
- `PERMISSION_REVIEW_TIMEOUT_MS` (90,000), `PERMISSION_REFUSALS_BEFORE_STOPPING` (3), and
  `PERMISSION_ANNOUNCE_TIMEOUT_MS` (5,000) are the module's own bounds, exported so a reader can
  see them rather than so a host can change them. They are Happy Agent v1's values: the review budget, the
  consecutive-refusal limit, and the ceiling on how long one decision waits for its observers.
- `PermissionReviewer.review(ctx, request: PermissionReviewRequest): Promise<PermissionReviewDecision>`
  is the contract a host implements. `PermissionReviewRequest` carries `agentId`, `callId`, the
  resolved `tool`, its detached and bounded `arguments`, the `action` description, the `mode`
  (always `auto`, the only mode that reviews), `elevates` (whether an approval also lifts the
  sandbox), and an `AbortSignal` in `signal` that is aborted when the bounded review times out.
  `PermissionReviewDecision` carries `risk` and `userAuthorization` on an allowed result (they
  may also be supplied on a denial). The reviewer reports them, while the module independently
  rejects critical risk and high-risk actions without medium-or-higher authorization. Review must
  never become a question put to the person and must answer in bounded time.
- `PermissionEventListener` is `(ctx, event) => Promise<void> | void`. It may be asynchronous, and
  the module awaits it so a healthy host has durably recorded what happened before the run settles;
  a listener that throws is contained and never changes the permission decision, and the whole set
  of subscribers is bounded once by `PERMISSION_ANNOUNCE_TIMEOUT_MS` so a wedged observer cannot
  hold a decision hostage. `PermissionEvent` is a discriminated union:
  `permission_mode_changed`, `permission_mode_cleanup_failed`, `permission_action_reviewed`,
  `permission_action_denied`, `permission_action_unproven`, `permission_action_out_of_mode`, and
  `permission_turn_stopped`.
- `permissionModeGuidance(mode: AgentPermissionMode, tools?: PermissionToolGuidance[]): string`
  returns bounded instructions for a mode. It includes the sandbox limits for restricted modes and
  deduplicates every Auto tool guidance string.
- `permissionModeChangeNotice(mode: AgentPermissionMode, tools?: PermissionToolGuidance[]): string`
  returns the message to steer at the agent when changing its mode, carrying the announcement and
  the same rules paragraph.

## The one seam that is still a host's

Everything this module needs, it now asks a sibling module for — except one thing. The Auto
instructions it writes must list what each _currently active_ tool says about asking for approval,
and which tools are active at the next inference is the merged list `@slopus/happy-agent-base`
assembles from every module's `tools` hook plus the agent's own `state.tools`. That list is private
to the base package, and the base package is frozen, so no module here can answer it. Until the
base exposes it, whoever assembles the agent registers the answer through `provideToolGuidance`.

What would remove the seam: a read-only accessor on `AgentModuleScope` — the same object every
hook already receives — carrying the merged tool list the base is about to send, or just the
`autoPermissionInstructions` of that list. `instructions(ctx, scope)` would then read it off
`scope` and `provideToolGuidance` would go away entirely. Nothing else about the module changes.

## Storage

The module persists nothing. It keeps no state in `AgentKV`, `sharedKV`, `runKV`, or any
call-scoped store, and it takes no store of its own in its constructor. It holds only static tool
guidance and a private bounded refusal circuit per agent. A circuit has a consecutive count plus
the last 50 decisions; one allowed call clears only the consecutive count, and the entire circuit
is cleared when the agent's run settles (`afterAgentSettled`) or the process restarts. The mode
itself — the thing this module enforces — is not this module's to persist; it lives on the agent
(`scope.agent.permissionMode`) and its durability is `@slopus/happy-agent-base`'s responsibility,
not this module's. Anything durable about permission decisions — an audit log, a review history —
is the host's own responsibility, built on top of the events the module reports to whoever
subscribed through `onEvent` and `onEventTransactional`.
