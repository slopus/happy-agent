# Agent Base Nice-to-Haves

This file records optional `@slopus/happy-agent-base` improvements that would
make features smaller, clearer, or harder to misuse. None of these are blockers
for Rig v2, and feature work must continue against the published Agent Base
API.

Do not use this list to add a compatibility layer inside a feature. Implement
the feature cleanly with current public primitives, then keep the possible Base
improvement here for a separate task.

## Host-level outer commit callbacks

Features with application projections currently inject a store-specific
`afterCommit(ctx, callback)` contract. A first-class outermost-commit callback
on Agent Storage or Context would give every feature one standard way to:

- publish the same event only after the outer host transaction commits;
- receive a stable post-commit context instead of retaining a transaction
  context;
- discard callbacks automatically on rollback;
- contain and report post-commit observer failures consistently.

This would remove repeated host adapter contracts from Tasks, Presence,
History, Collaboration, and future catalog features.

## Transaction result with post-commit publication

A small Base helper could combine:

1. transactional state mutation;
2. a durable, TypeBox-validated event result;
3. optional transactional observation;
4. post-commit delivery with a fresh context.

Features would still own their schemas and behavior. The helper would only
standardize the lifecycle and make premature publication difficult.

## Message acceptance result

Caller-supplied message IDs and metadata in 0.0.6 provide the durable identity
Rig needs. An acceptance result could make idempotent routing even clearer:

```ts
type AgentMessageAcceptance = {
    id: string;
    delivery: "send" | "steer";
    accepted: "created" | "existing";
};
```

Returning this from `send` and `steer` would let a host answer retries without
consulting private queue records or inferring whether an identical message was
newly inserted.

## Public bounded message lookup

A bounded lookup by caller-supplied message ID could help protocol hosts
reconstruct receipts after restart:

```ts
agent.message(ctx, messageId);
```

The result should expose only the persisted envelope identity, delivery kind,
and immutable metadata—not the provider's private context representation. This
would simplify crash reconstruction without encouraging full queue listing.

## Stable run and inference identities in hooks

Message IDs identify accepted work, but protocol projections also assemble
multiple inference attempts and tool batches. Base-provided stable identifiers
on loop, turn, inference, and settlement hook payloads would reduce feature
bookkeeping and make event correlation more explicit.

These identities should be persisted by Base and remain stable across process
restart. They should not impose Rig's run protocol on other hosts.

## Namespaced metadata helpers

Agent and message metadata intentionally allow feature-owned JSON fields. Small
helpers for a feature-owned namespace could prevent collisions and centralize
validation:

```ts
readFeatureMetadata(schema, metadata, "collaboration");
writeFeatureMetadata(metadata, "collaboration", value);
```

The underlying metadata should remain an ordinary persisted JSON object.

## Typed feature configuration access

`AgentConfig.features[name]` is correctly opaque to Agent Base. A scope helper
that accepts a feature-owned TypeBox schema could remove repeated read/check
boilerplate while preserving that opacity:

```ts
scope.config(featureName, schema);
```

It should validate on every ownership boundary and return an immutable cloned
value.

## Durable tool operation identity helper

Tools can already keep retry identity in call-scoped `agentKV(ctx)`. A tiny Base
helper could standardize the common allocate-once pattern:

```ts
durableOperationId(ctx, "task-create", idFactory);
```

The helper must use the call's durable KV, never heap state or a provider call
ID. It would reduce repeated identity plumbing across Tasks, User Input,
Collaboration, Applets, Worklets, Workflows, and Image Generation.

## Agent creation staging

Caller-supplied IDs and a shared transaction make agent creation and a host
roster atomic at the durable storage layer. An optional creation lifecycle that
separates durable installation from starting the live loop could make the
boundary easier to reason about:

1. persist configuration, metadata, parentage, and initial context;
2. let the host finish its shared transaction;
3. publish/start the agent after commit.

This would be a clarity improvement for hosts with substantial roster
projection. It must not require agent deletion or introduce a second agent
state machine.

## Feature lifecycle observation

Optional agent-created, restored, metadata-changed, and archived observations
could simplify Collaboration roster reconciliation. Creation/restoration hooks
should carry stable agent ID and immutable metadata and follow the same
transaction/post-commit rules as other durable changes.

Agent listing remains a Collaboration feature responsibility, and agents are
not deleted in the Rig v2 design.

## Shared bounded-output utilities

Many features need deterministic character, item, and page bounds for
model-facing text. A small Base utility package could standardize truncation
markers and UTF-safe limits without deciding feature content or store paging.

This is lower priority than transactional helpers because it affects
consistency and ergonomics rather than correctness.
