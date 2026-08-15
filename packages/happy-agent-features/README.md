# @slopus/happy-agent-features

Ready-made capabilities for agents built on
[`@slopus/happy-agent-base`](../happy-agent-base).

Agent Base owns the minimal durable inference and tool loop. This package supplies the product
features a host composes into that loop: tools, instructions, lifecycle hooks, persistence
contracts, public host APIs, and transactional/post-commit events.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { HistoryFeature, SystemPromptFeature } from "@slopus/happy-agent-features";

const history = new HistoryFeature({ store: historyStore });
const systemPrompt = new SystemPromptFeature();

const agent = await Agent.create(ctx, {
    ...options,
    features: [history, systemPrompt],
});
```

One feature instance normally serves every agent in a collection. Agent-specific state is keyed
by the calling agent and lives in the supplied host store or Agent KV, not in mutable
feature-instance maps. A host can also call a feature's public methods directly without creating
an agent.

## Feature catalog

- [Applets](sources/applets/README.md) — import, version, inspect, and remove host-managed applets.
- [Collaboration](sources/collaboration/README.md) — create collaborators, exchange durable
  messages, wait for replies, and schedule delivery.
- [Compute](sources/compute/README.md) — provider-neutral filesystem and shell tools over a
  host-supplied machine.
- [Goal](sources/goal/README.md) — durable long-running objectives, continuation, failure
  blocking, and external wake scheduling.
- [History](sources/history/README.md) — transactional conversation archival and bounded history
  reading.
- [Image generation](sources/imageGeneration/README.md) — host-routed image generation with
  durable request and artifact evidence.
- [Model switch](sources/modelSwitch/README.md) — truthful handoff when incompatible model
  histories cannot be replayed.
- [Permissions](sources/permissions/README.md) — one permission model for review, temporary
  elevation, refusal, and mode changes.
- [Presence](sources/presence/README.md) — durable agent presence, availability, and status
  events.
- [Projects](sources/projects/README.md) — repositories registered on demand, with bounded
  settings and durable rename and archival.
- [Search](sources/search/README.md) — bounded common web fetch plus explicit vendor search
  wrappers.
- [Secrets](sources/secrets/README.md) — safe secret metadata, keyed replay fingerprints,
  attachments, and a host-only resolver.
- [Slots](sources/slots/README.md) — durable named values with ordering and bounded paging.
- [System prompt](sources/systemPrompt/README.md) — model-aware native prompt selection and
  identity substitution.
- [Tasks](sources/tasks/README.md) — durable task creation, dependency tracking, updates, and
  completion.
- [Usage](sources/usage/README.md) — bounded provider and agent-tree usage observation.
- [Workflows](sources/workflows/README.md) — launch, inspect, cancel, resume, wait for, and read
  logs from host-owned workflows.
- [Workspaces](sources/workspaces/README.md) — create, inspect, transfer, and archive isolated
  workspaces through a host manager.

Each feature document describes:

- the exact tools exposed to the model and their permission/durability behavior;
- the public methods available to hosts;
- the storage, receipt, proof, paging, output, and event contracts the host must implement.

## Design rules

- Runtime validation uses TypeBox schemas, with TypeScript types derived through `Static`.
- Mutating tools are durable wherever their effect can be replayed safely. A reused operation
  identity with different input is rejected.
- Host stores remain authoritative. Feature code validates every host response before returning
  a clone or formatting it for the model.
- Transactional listeners run with the mutation. Post-commit listeners run only after durable
  commit, and their failures cannot turn a committed operation into a failed tool call.
- Model-facing lists, logs, summaries, and artifacts have explicit item and character bounds.
- Provider-specific behavior stays in its own complete tool definition; common tools are shared
  without capability detection or provider-key branching.
- `@slopus/happy-agent-base` is consumed as-is. Features do not change or extend its core.
