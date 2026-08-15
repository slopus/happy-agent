# Workflows

A way for the model to start and track work the host runs, not the agent. A workflow is a
named, host-defined process — a build, a deployment, a data job, anything with its own runtime,
queue, and permissions — that the model can launch, watch, pause, and read logs from without the
agent ever touching a process or a filesystem itself. The feature owns identity, idempotency,
paging, and model-facing formatting; the host owns everything about how a workflow actually runs.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { WorkflowsFeature } from "@slopus/happy-agent-features";

const workflows = new WorkflowsFeature({ store: hostWorkflowStore });
const agent = await Agent.create(ctx, { ...options, features: [workflows] });
```

`store` is the only required option. It is a `WorkflowStore` — a structural contract the host
implements over its own runner and persistence (see Storage below). Everything else is optional:
`idFactory` and `eventIdFactory` override the default `crypto.randomUUID()` identity generators,
`clock` overrides `Date.now`, `listener` receives `workflow_started` / `workflow_updated` /
`workflow_cancelled` events, `maxPageSize` and `maxLogLines` bound paging, `maxOutputCharacters`
bounds every string handed back to the model, and `onPostCommitError` observes a listener failure
after commit without turning a committed operation into a failure.

## Tools it provides to the model

Every tool is `durable: true` and answers `shouldReviewInAutoMode` with `false`: the feature
never touches a process, a file, or the network itself, so nothing it does needs Auto-mode
review. All of them are bound to one `agentId` — the agent's own ID, `scope.agent.id` — so a
model can only ever see and act on that agent's own runs.

- **`run_workflow`** — `{ workflow, input? }`. Starts a workflow by name with an optional input
  string (bounded to 20,000 characters). The tool never accepts an `operationId`; the feature
  allocates one itself in durable, call-scoped storage so a retried tool call replays instead of
  double-launching. Returns the new (or replayed) `WorkflowRun`, rendered as an identity line,
  status, and any output/error the run already carries.
- **`list_workflows`** — `{ cursor?, from?, limit?, includeTerminal? }`. Lists a bounded page of this
  agent's runs. `limit` is capped by both the configured `maxPageSize` and by how many rows can
  actually fit inside `maxOutputCharacters`; the feature shrinks the page rather than truncating a
  row, and only ever returns a page whose declared `nextCursor` both advances past the request and
  exposes at least one complete run. Each row renders as `id: workflow [status]`.
- **`workflow_status`** — `{ id }`. Reads one run by ID and reports "Workflow run was not found."
  when it does not exist for this agent, rather than an error.
- **`cancel_workflow`** — `{ id }`. Requests cancellation of one run. Idempotent the same way as
  launch: the feature allocates its own `operationId`, so calling it twice for the same run
  replays the first cancellation instead of issuing a second one.
- **`resume_workflow`** — `{ id }`. Resumes one paused or cancelled run, with the same
  self-allocated idempotency as `cancel_workflow`.
- **`wait_workflow`** — `{ id }`. Blocks, through the host's own broker, until a run reaches a
  terminal or `unavailable` status. The feature asserts the store actually returned a terminal
  status before handing it back — a store that wakes early is a contract violation, not a valid
  workflow state to show the model.
- **`workflow_logs`** — `{ id, cursor?, from?, limit? }`. Reads a bounded page of log lines (each line
  capped at 4,000 characters, at most `MAX_WORKFLOW_LOG_LINES` = 500 lines per page, and further
  capped by `maxLogLines` and by the output-character budget). Rendered as the run ID, one line
  per log line — truncated with an ellipsis if a line does not fit the remaining budget — and a
  cursor suffix when more logs remain.

All seven read/mutate tools reuse the same underlying feature methods a host would call directly
(`launchForTool`, `listPage`, `status`, `cancelForTool`, `resumeForTool`, `wait`, `logs`); the
tools differ only in which fields the model is allowed to pass — none of them expose `operationId`
or `agentId` — and in how the result is rendered to text via `formatRunForModel`,
`formatPageForModel`, and `formatLogsForModel`.

## External functions

`WorkflowsFeature` exposes these methods to hosts and other API callers, each taking `ctx` and the
target `agentId` explicitly (the tools above always pass the owning agent's own ID):

- **`launch(ctx, agentId, WorkflowLaunchInput)`** → `Promise<WorkflowRun>`. The full host-facing
  entry point: accepts an optional `operationId` for host-supplied idempotency (the tool variant
  never exposes this). Normalizes line endings in `input`, derives a canonical fingerprint of the
  request, and resolves or allocates the operation ID through call-scoped `AgentKV`. Inside one
  `store.transaction`, it replays an existing run with the same ID if the fingerprint matches
  (throwing if the same ID was reused with different input), or calls `store.launch`, builds a
  `workflow_started` event, calls the listener transactionally, and registers a post-commit
  notification via `store.afterCommit`.
- **`launchForTool(ctx, agentId, WorkflowLaunchToolInput)`** → `Promise<WorkflowRun>`. Same as
  `launch` but validates against the tool-restricted input schema (no `operationId`); this is what
  `run_workflow` calls.
- **`status(ctx, agentId, id)`** → `Promise<WorkflowRun | undefined>`. Reads one run and verifies
  both its ID and owning agent before returning a clone.
- **`list(ctx, agentId, WorkflowPageQuery)`** → `Promise<WorkflowPage>`. Clamps the requested
  limit to the feature's configured and output-budget-derived bounds, verifies exact offset
  paging in either direction, and returns the complete page with total and adjacent cursors.
- **`cancel(ctx, agentId, WorkflowMutationInput)`** →
  `Promise<WorkflowMutationResult>`. Accepts an optional host-supplied `operationId`; runs the same
  transactional replay-or-mutate-then-notify sequence as `launch`, emitting `workflow_cancelled`
  when a cancellation actually changes state.
- **`cancelForTool(ctx, agentId, WorkflowMutationToolInput)`** → `Promise<WorkflowMutationResult>`.
  Tool-restricted `cancel`, used by `cancel_workflow`.
- **`resume(ctx, agentId, WorkflowMutationInput)`** → `Promise<WorkflowMutationResult>`. Same shape
  as `cancel`, emitting `workflow_updated` on an actual state change.
- **`resumeForTool(ctx, agentId, WorkflowMutationToolInput)`** → `Promise<WorkflowMutationResult>`.
  Tool-restricted `resume`, used by `resume_workflow`.
- **`wait(ctx, agentId, id)`** → `Promise<WorkflowRun>`. Delegates to `store.wait` and asserts the
  returned run is in a terminal or `unavailable` status.
- **`logs(ctx, agentId, WorkflowLogQuery)`** → `Promise<WorkflowLogPage>`. Bounds the requested
  limit, verifies the store answered for the right run and agent, and eagerly renders the page
  through `formatLogsForModel` so a page that cannot fit the output budget fails here rather than
  at tool-call time.
- **`formatPageForModel`**, **`formatRunForModel`**, **`formatLogsForModel`** — the exact text
  rendering used by the tools, exposed so a host preview can match what the model sees.

Every method validates its `agentId` and input against the corresponding TypeBox schema, asserts
the store's response actually belongs to that agent and that run ID, and returns a
`structuredClone` so a caller can never mutate the feature's internal state through the result.

The `listener` option (`WorkflowFeatureListener`) is the only way to observe state changes:
`onEventTransactional` runs inside the same store transaction as the mutation (its context is
`txCtx`, so it can itself write durable state atomically with the run change), and `onEvent` runs
afterward, registered through `store.afterCommit`. A throwing `onEvent` is caught and handed to
`onPostCommitError`, and never propagates back into the committed operation. `WorkflowEvent` is one
of `workflow_started`, `workflow_updated`, or `workflow_cancelled`, each carrying `agentId`,
`eventId`, `at`, and the full `run`.

## Storage

The feature holds almost no state of its own; nearly everything durable belongs to the host's
`WorkflowStore` (`WorkflowStore.ts`), a structural contract with `transaction`, `afterCommit`,
`launch`, `get`, `list`, `cancel`, `resume`, `wait`, and `logs`. The host's `transaction` callback
must include both the durable run mutation and the runner's own staging boundary — the feature
never starts a process or owns a queue, and `afterCommit` is required to register its callback
synchronously (a returned promise or non-`undefined` value is a contract error).

The one thing the feature persists itself is the call-scoped identity for operation IDs it
allocates on the model's behalf, so a retried `run_workflow` / `cancel_workflow` / `resume_workflow`
tool call replays rather than repeating the action. It writes this through `agentKV(ctx)` — the
agent's own transactional key-value store from `@slopus/happy-agent-base` — using one key per
operation kind (the KV is already scoped to the calling agent):

- `workflow_launch_operation_id`
- `workflow_cancel_operation_id`
- `workflow_resume_operation_id`

Each key holds a `WorkflowCallOperation`: `{ operationId, fingerprint }`. The fingerprint is a
lowercase SHA-256 digest of a bounded canonical encoding of the agent ID, operation kind, and
request payload: the canonical input is capped at `MAX_WORKFLOW_OPERATION_CANONICAL_BYTES`
(256,000 bytes), while the digest is exactly
`MAX_WORKFLOW_OPERATION_FINGERPRINT_LENGTH` (64) characters. On a second call, the feature reads
the existing identity inside an `agentKV` transaction: a matching fingerprint returns the stored
`operationId` for replay, and a mismatched one throws. If no `agentKV` is available, the feature
allocates a fresh ID per call and relies only on an explicitly supplied host operation ID for
replay.

Every durable mutation is also bound inside the host store by a
`WorkflowOperationReceipt` and a separately retained, append-only `WorkflowMutationProof`.
Receipt and proof must both exist and agree on operation, owner, operation ID, fingerprint,
target, before/after state, and exact result before replay is accepted; partial evidence or a run
without evidence is rejected.

Every value the feature hands out — `WorkflowRun`, `WorkflowPage`, `WorkflowLogPage`,
`WorkflowMutationResult`, receipts, and proofs — is read from and written through the host's
`WorkflowStore`, validated against its TypeBox schema and checked for semantic consistency and
ownership before ever reaching the model. Field bounds enforced throughout —
`MAX_WORKFLOW_ID_LENGTH` (96), `MAX_WORKFLOW_AGENT_ID_LENGTH` (256), `MAX_WORKFLOW_NAME_LENGTH`
(96), `MAX_WORKFLOW_INPUT_LENGTH` (20,000), `MAX_WORKFLOW_ERROR_LENGTH` (4,000),
`MAX_WORKFLOW_OUTPUT_CHARACTERS` (20,000), `MAX_WORKFLOW_PAGE_SIZE` (100), `MAX_WORKFLOW_LOG_LINES`
(500), `MAX_WORKFLOW_LOG_LINE_LENGTH` (4,000) — exist so that even the smallest configured output
budget can still show one complete run identity and its pagination marker; retention of runs and
logs beyond those bounds is entirely the host store's own concern.
