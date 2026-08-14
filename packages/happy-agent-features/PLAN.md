# Happy Agent Features and Rig v2

## Goal

Replace Rig's old agent runtime with `@slopus/happy-agent-base` plus a set of
small, configurable features from `@slopus/happy-agent-features`.

Rig continues to own the application:

- daemon and process lifecycle;
- TUI, HTTP, SSE, and protocol compatibility;
- SQLite connection and migrations;
- projects, workspaces, folders, documents, and other non-agent commands;
- provider construction and the curated model catalog;
- host services such as Git, files, processes, media, and clocks.

Agent Base owns the durable agent loop, provider context, queued messages,
inference, tools, and per-agent feature KV. Everything that changes how an
agent behaves should be a feature. Rig supplies storage and external services
through narrow structural contracts.

The migration is intentionally a clean replacement. It does not migrate old
agent sessions, messages, queues, or history, and it does not preserve legacy
agent-runtime abstractions for compatibility.

## Target architecture

```text
Rig daemon
├── one application-owned SQLite database
│   ├── Rig application and protocol tables
│   ├── Agent Base records and KV
│   └── feature-owned projections through Rig persistence adapters
├── AgentSystemLocal
│   ├── configurable happy-agent-features
│   └── final Rig protocol projection feature
├── Rig host services
│   ├── project/workspace/Git operations
│   ├── applet/worklet/slot catalogs
│   ├── secrets, media, search, usage, presence, and clocks
│   └── workflow and collaboration runtimes
└── existing HTTP, SSE, TUI, and daemon surfaces
```

The SQLite database uses one connection and one transaction context so Agent
Base changes, feature state, and Rig projections can commit atomically. A
feature never opens this database itself. Rig supplies `AgentStorage`,
`AgentKV`, and structural stores backed by semantic persistence operations.

## Agent Base 0.0.6 contract

Rig v2 targets published `@slopus/happy-agent-base@0.0.6`.

Use its identity and metadata APIs directly:

- choose an agent ID at creation when Rig or Collaboration needs a stable
  external identity;
- attach descriptive and routing data to `AgentConfig.metadata`;
- choose a stable message ID for every `send` and `steer`;
- attach immutable run, session, mutation, delivery, and presentation data to
  message metadata;
- route transactional message projection from the accepted message's ID and
  metadata instead of an in-memory registration;
- use async `onEvent` for awaited live observation;
- use metadata change hooks for durable roster and presentation projection.

Agent creation and message submission use the shared host transaction:

1. Rig starts the transaction.
2. Rig passes that transaction context to Agent Base.
3. Agent Base creates the agent or accepts the message using caller-supplied
   identity and metadata.
4. Rig writes any host roster, repeat-key, or protocol projection rows in the
   same transaction.
5. Notifications and heap publication happen only after the outer transaction
   commits.

Do not add an in-memory lock or registry to compensate for an identity that
Agent Base can already persist. In-memory state may represent only live,
reconstructable stream assembly.

## Feature contract

Every feature follows [GUIDELINES.md](./GUIDELINES.md).

In particular:

- one shared feature instance serves an `AgentSystem`;
- per-agent state lives in feature `AgentKV`;
- in-progress durable state lives in `runKV`;
- collection state lives in `sharedKV` or an injected host store;
- no feature owns a database, path, file, timer, process, or network client;
- no feature imports Rig or another feature;
- cross-feature behavior is injected through a small structural interface;
- constructor options, public inputs, store results, and persisted values use
  TypeBox schemas with `Static` types;
- reads are bounded at the storage boundary;
- a mutation's complete read-decide-write sequence happens in one injected
  transaction;
- there are no feature-level in-memory locks;
- transactional and post-commit listeners receive the same stable event;
- post-commit means after the outermost host transaction;
- tools call the same public feature operations as the host;
- tool retries reuse feature-owned durable identities;
- model-facing output is bounded but complete enough to use;
- common tools are provider-neutral.

Features should resemble `GoalFeature`: a small public API, a clear storage
boundary, thin tools, transactional hooks, and no knowledge of the host.

## Protocol compatibility

Rig may replace the implementation while keeping its external API, route
shapes, toggles, and event identities intact.

The minimum useful session contract is:

- create/list/get a session;
- submit, steer, abort, and compact;
- configure model, effort, service tier, permission-mode value, and draft;
- read transcript, events, stream bootstrap, activity, partial output, and
  usage;
- preserve existing API shapes for temporarily unavailable capabilities.

For each accepted message, the TUI depends on this lifecycle:

```text
message_submitted
→ run_started
→ inference_iteration_start
→ live text/thinking/tool agent_event updates
→ durable agent_message
→ exactly one run_finished or run_error
```

All events for one request retain the same Rig run ID. Agent Base's stable
message ID and immutable message metadata are the durable correlation source.
Live deltas may be ephemeral; accepted user messages, completed assistant
messages, tool results, and terminal events are transactional.

The Rig protocol projection feature is always last in the feature array. It
must not publish uncommitted heap state or persist a terminal fallback after a
transaction rolls back.

## Feature catalog

### 1. System prompt

Status: existing foundation; retain and harden.

- Select provider/model-appropriate instructions on every inference.
- Accept configurable identity.
- Own no storage.
- Keep the implementation generic and provider-aware only through supplied
  model information, not Rig branches.

### 2. History

Status: complete, reviewed, committed, and integrated into Rig's Agent Base
protocol path.

- Record accepted user messages, completed assistant blocks, tool results, and
  inference errors.
- Keep the archive separate from the provider's compactable conversation.
- Inject a bounded `HistoryStore`.
- Expose bounded page, search, excerpt, and statistics APIs.
- Give the model a common `read_agent_history` tool.
- Deny cross-agent reads by default; Collaboration may inject authorization.
- Use feature-owned stable record IDs.
- Keep pending assistant assembly in transactional `runKV`.
- Support strict and explicitly configured best-effort persistence modes.
- Keep SQL inside Rig semantic persistence operations.
- Preserve stable cursors under retention pruning.
- Project the same durable history into Rig's transcript and SSE protocol.

History is the first end-to-end proof that Agent Base persistence, a feature
store, Rig session projection, and the TUI all work together.

### 3. Model handoff

Status: complete, reviewed, committed, and wired into Rig after History.

- Use Agent Base model-change hooks.
- Emit no notice for a compatible switch.
- For an incompatible reset, insert an honest system notice naming the change.
- Optionally include a bounded excerpt through a structural `HistoryReader`.
- Tell the model how to read the full archive when a history tool exists.
- Keep model labels and compatibility policy injectable.
- Own no storage.

### 4. Goals

Status: existing baseline; durability hardening remains.

- Create, read, update, complete, block, pause, resume, and clear a goal.
- Continue work after settlement while a goal remains active.
- Store all retry/failure/continuation state in feature KV, not maps.
- Expose the same operations to host and common tools.
- Do not depend directly on History or Tasks.

### 5. Tasks

Status: complete, reviewed, committed, and integrated with Agent Base 0.0.6.

- Durable generic task list, not a dedicated Plan mode.
- Task fields include stable ID, title, detail, status, priority,
  dependencies, ordering, and timestamps.
- Validate uniqueness, ordering, dependency integrity, and acyclicity on load.
- Expose create/get/page/update/complete/remove/reorder/reset.
- Provide common task tools with paged listing and detailed lookup.
- Allocate tool-created IDs outside the model schema and retain them in
  call-scoped KV.
- Emit stable transactional and post-commit task events.

### 6. Collaboration

Status: complete, reviewed, committed, and available from the package root;
Rig host integration remains.

- Create agents with caller-supplied IDs and Agent Base metadata.
- Keep an injected host roster containing agents, roles, groups, parentage,
  ownership, status, and display metadata.
- List and resolve agents through the feature rather than Agent Base deletion
  or a Rig-specific session manager.
- Never delete agents.
- Track directed reply obligations: who is waiting for an answer from whom.
- Own send-message, request-reply, wait, scheduling, and coordination tools.
- Treat waiting as an ordinary durable tool call.
- Create the Agent Base identity and roster row in one shared transaction.
- Use metadata change hooks to keep host projection current.
- Supply structural authorization to History and other features that may read
  related agents.

Scheduling is part of Collaboration, not a separate durable queue feature.

### 7. User input / inbox

Status: to implement.

- Inject a host-owned `UserInputStore` or broker.
- Ask, list, get, answer, cancel, and complete requests.
- Preserve a stable request identity across durable tool retries.
- Represent answer, cancellation, away, and timeout outcomes explicitly.
- Keep presence policy optional and injected.
- Use the common `request_user_input` tool.
- Do not implement permission prompts here.

### 8. Presence

Status: complete, reviewed, committed, and available from the package root.

- Separate configured presence from effective presence.
- Support built-in and custom states, temporary values, fallback, and schedules.
- Inject the store, schedule service, and clock.
- Own no timer.
- Bound and validate schedule reads and unique identities.
- Expose read/set/clear and optional model mutation tools.
- Emit stable events after the host's outermost commit.
- Integrate with User Input only through an injected policy.

### 9. Search

Status: implementation exists; output and runtime-contract hardening remain.

- Inject a provider-neutral search backend with search and fetch.
- Provide common `web_search` and `web_fetch` tools.
- Bound queries, results, bodies, and timeouts at the backend contract.
- Use an optional injected cache factory only when needed.
- Own no filesystem index, browser, or network client.
- Filesystem search remains unavailable until a host path/compute boundary is
  deliberately provided.

### 10. Image generation

Status: implementation exists; isolated review and host integration remain.

- Inject an image generator and asset store.
- Provide a common `generate_image` tool and host API.
- Return opaque asset IDs and protocol-safe metadata.
- Let Rig choose media directories and HTTP serving.
- Own no path or file writes.

### 11. Secrets

Status: implementation exists; isolated review and host integration remain.

- Inject a secret registry/resolver.
- List safe metadata, register, update, remove, attach, and detach references.
- Never reveal raw values to the model.
- Keep scopes generic and opaque to avoid Rig project/folder imports.
- Defer command environment injection until compute exists.

### 12. Slots

Status: implementation exists; isolated review and host integration remain.

- Inject a host-owned slot store and scope resolver.
- Create, list, update, reorder, and remove slot entries.
- Keep slot content and action schemas generic.
- Refer to applet actions by opaque IDs rather than importing Applets.
- Let Rig own validation against UI and application resources.

### 13. Applets

Status: complete, reviewed, committed, and available from the package root;
Rig host integration remains.

- Inject an applet catalog, source importer, and asset reader.
- Import/create, list, read, update/version, revert, remove, and read assets.
- Own no directory such as `~/Happy/Applets`.
- Let Rig supply source paths, filesystem operations, database records, and
  HTTP serving.
- Keep Slot linkage opaque.

### 14. Worklets

Status: to implement.

- Inject a worklet catalog and runtime.
- Install/import, list, version, update, revert, remove, inspect status, read
  bounded logs, and invoke exposed operations.
- Own no Node process, permission policy, build, path, or data directory.
- Let Rig host runtime lifecycle and tools.
- Defer Applet/Slot UI linkage to host integration.

### 15. Workflows

Status: complete, reviewed, committed, and available from the package root.

- Inject a workflow runner and run store.
- Launch, list, read status, wait, resume, cancel, and read bounded logs.
- Provide common workflow tools.
- Own no queue, Python runtime, filesystem, permission system, or subagent
  implementation.
- Initially report unavailable where the Rig runner still depends on removed
  legacy agent machinery.
- Record cross-feature gaps in `debt/` rather than importing Collaboration.

### 16. Usage

Status: complete, reviewed, committed, and available from the package root.
Rig host integration remains.

- Observe Agent Base inference completion and record provider/model/effort/tier,
  tokens, and time through an injected `UsageStore`.
- Expose per-agent and aggregate bounded reads.
- Keep accounting optional and non-fatal.
- Keep provider quota network loading in Rig.
- Project usage to existing protocol shapes.

### 17. Projects

Status: to implement as an agent-facing facade over Rig-owned operations.

- Inject a project store/operations service.
- List, get, create, rename, archive, and read/update bounded settings.
- Give agents opaque project references and useful descriptive context.
- Keep Git, filesystem, database, and path policy in Rig.

### 18. Workspaces

Status: implementation exists; output paging and runtime-contract review
remain.

- Inject a workspace store/operations service.
- Create, list, get, transfer, archive, and read branch metadata.
- Accept an opaque project reference without importing ProjectsFeature.
- Keep worktrees, Git, paths, and compute in Rig.

## Rig-owned storage adapters

Projects, workspaces, applets, worklets, slots, secrets, generated media, and
similar records remain application-owned. The corresponding features do not
move those tables into Agent Base KV. They define structural contracts; Rig
implements them over its existing repositories and the shared database.

Rig persistence rules:

- migrations remain immutable once released;
- new schema changes get new migrations;
- SQL stays under `packages/rig/sources/persistence`;
- feature adapters translate structural calls to semantic persistence
  operations;
- adapters reuse the current `SessionDatabase` and transaction context;
- store reads filter and page in SQL before deserializing;
- post-commit publication uses the host transaction boundary;
- one feature must not silently create a second SQLite client for the same
  operation.

## Explicit exclusions

Do not implement or integrate these during this migration:

- compute;
- permission enforcement or permission review;
- autoreview;
- provider-specific tool surfaces;
- legacy durable run queue;
- external skills;
- external tools;
- agent deletion;
- Murmur;
- P2P;
- Happy sync;
- Happy Cloud;
- old-session or old-message migration.

Keep external API shapes and toggles where clients require them, but return a
clear unavailable/no-op result until a feature exists. Unsupported behavior
must not fall back to the old agent runtime.

Compute and permission implementations that already exist in the feature
package are not part of Rig v2 wiring in this phase.

## Old runtime removal

Delete obsolete runtime code only after its callers use Agent Base/features.

### Phase A: establish the new core

- Open Agent Base on Rig's shared SQLite database.
- Create agents with stable IDs and metadata.
- Send messages with stable IDs and metadata.
- Stream inference and project durable message history.
- Replace session message/steer/abort/compact entry points with the new host
  facade.

### Phase B: replace old session behavior

- Introduce the smallest Rig session facade required by routes and clients.
- Route feature APIs through shared feature instances.
- Keep non-agent repositories from `PersistentSessionStore`.
- Remove `InMemorySession`, `InMemorySessionPersistence`, queued-run state, old
  session manager, and old subagent implementation.
- Preserve protocol transcript/event tables only as Rig projections.

### Phase C: remove execution packages

- Move stable protocol DTOs still imported from `rig-execution` into Rig-owned
  protocol types or `happy-providers`.
- Replace the dynamic Executor model listing with the curated Agent Base model
  catalog.
- Reduce `RemoteAgent` to a protocol client.
- Remove old executor, runtime, loop, compaction, vendor tool, prompt, context,
  permission-review, debug-provider, image, and search adapters.
- Delete `packages/rig-execution`.
- Remove obsolete package scripts, dependencies, and tests.

### Phase D: remove skipped integrations

- Delete external-skills and external-tools code and protocol fields.
- Delete the legacy durable run queue.
- Remove Murmur, P2P, Happy sync, and Happy Cloud runtime integrations from the
  v2 path.
- Keep feature-hosted scheduling state only through Collaboration.

## Implementation order

Features can be built concurrently when their files and host adapters do not
overlap. The dependency-oriented order is:

1. shared guidelines and Agent Base 0.0.6 host identity;
2. History plus protocol streaming;
3. Model handoff;
4. Goal durability;
5. Tasks;
6. Collaboration;
7. User Input;
8. Presence;
9. Search;
10. Image Generation;
11. Secrets;
12. Slots;
13. Applets;
14. Worklets;
15. Workflows;
16. Usage;
17. Projects;
18. Workspaces;
19. old runtime and package deletion.

Cross-feature dependencies do not block an individual feature. Inject a
structural boundary, implement the independent portion, and record missing
composition in `debt/`.

## Review and commit workflow

Each feature is one independently reviewable unit:

1. A Luna Max implementation agent reads `GUIDELINES.md` completely.
2. It changes only the feature, focused tests, and its narrow Rig adapter.
3. It runs focused typecheck and tests.
4. A distinct Luna Max agent reviews architecture, transactions, bounds,
   replay, runtime schemas, host leakage, model-facing output, and tests.
5. The implementation agent fixes concrete Luna findings and reruns focused
   validation.
6. A distinct Sol High agent performs the final release review.
7. The implementation agent fixes any final concrete blockers.
8. Sol High re-reviews until there are no release-blocking findings.
9. The finished feature is committed in one coherent green commit and pushed
   to `rig-v2`.

Do not use CodeRabbit unless Steve explicitly requests it. Do not stage or edit
master plans as part of feature commits. Do not combine unrelated feature
changes in one commit.

## Definition of done for a feature

A feature is finished when:

- its public API and tools share one implementation;
- every option is configurable and runtime-validated;
- it owns no external storage or resource;
- all state is in supplied KV or an injected host store;
- no authoritative in-memory state or feature lock exists;
- all reads and model output are bounded;
- durable tool replay is idempotent;
- outer rollback publishes nothing;
- post-commit delivery uses a stable non-transaction context;
- persisted state is fully validated;
- cross-agent access is denied unless Collaboration authorizes it;
- the package exports the feature and its public schemas/contracts;
- focused tests cover restart, malformed state, rollback, replay, bounds, and
  listener behavior;
- the Rig adapter, when present, uses semantic persistence operations;
- a separate Luna Max review and final Sol High review have no blocking
  findings;
- the feature has its own green commit.

## Migration definition of done

Rig v2 is complete when:

- app and daemon start with Agent Base 0.0.6;
- Agent Base and Rig use the same SQLite database and transaction scope;
- accepted messages, history, live inference, and terminal events appear in
  the existing TUI and protocol;
- agent and message IDs/metadata survive process restart without heap-only
  routing;
- every supported agent capability is a configurable feature;
- Rig owns only application infrastructure, protocols, persistence adapters,
  and external host services;
- unsupported capabilities fail clearly without invoking the legacy runtime;
- `InMemorySession`, executor/runtime agent code, external-skills/tools, the
  legacy durable run queue, and `rig-execution` are gone;
- no old agent session migration or compatibility branch remains;
- package checks, focused integration tests, and the required gym protocol
  scenarios pass.
