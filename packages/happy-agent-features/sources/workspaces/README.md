# Workspaces

Isolated places to work — checkouts, worktrees, or whatever a host makes of a project and a base
ref — that an agent can create, list, inspect, move a session into, and archive without knowing
anything about Git, paths, or the filesystem. The feature never touches a workspace itself: it
validates input, allocates durable identities, calls the host's `WorkspaceStore`, and checks that
what comes back is consistent with what it asked for. What a workspace actually is, and how
creating, transferring, or archiving one is carried out, is entirely the host's decision.

The problem this solves is durability under retry. A tool call that creates or archives a
workspace may be interrupted after the host has already acted but before the model sees the
result. The feature gives each mutating call a stable operation identity, remembers the outcome
under that identity, and replays the same result instead of creating a duplicate workspace or
re-archiving one that is already gone.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { WorkspacesFeature } from "@slopus/happy-agent-features";

const workspaces = new WorkspacesFeature({ store: hostWorkspaceStore });
const agent = await Agent.create(ctx, { ...options, features: [workspaces] });
```

`store` is the only required option. `authorization` lets one agent act on another agent's
workspaces (self access is always allowed without it); `idFactory`, `eventIdFactory`, and `clock`
let a host control identity and time generation instead of using `crypto.randomUUID()` and
`Date.now()`; `listener` receives every workspace event; `maxPageSize` and `maxOutputCharacters`
bound paging and model-facing text; `onPostCommitError` is told about a listener failure after the
durable transaction has already committed.

## Tools it provides to the model

- **`create_workspace`** — `{ projectRef?, name, baseRef? }`. Creates one workspace owned by the
  calling agent. `projectRef` and `baseRef` are opaque strings the host interprets; `name` is
  required. The feature allocates the workspace ID and the durable operation identity itself, so a
  retried call with the same tool-call scope returns the same workspace instead of creating a
  second one.
- **`list_workspaces`** — `{ projectRef?, includeArchived?, cursor?, limit? }`. Lists a page of the
  calling agent's workspaces, capped at `maxPageSize` (100 by default). `cursor` is an opaque
  decimal offset returned as `nextCursor`; passing it back continues from exactly where the last
  page ended.
- **`get_workspace`** — `{ workspaceId, detailOffset?, detailLimit? }`. Reads one workspace by ID.
  The full record is rendered as a bounded detail string and paged with `detailOffset`/
  `detailLimit` (up to 1,024 characters per page) so a small model-output budget cannot silently
  drop project, ownership, or timestamp fields; the model follows `nextDetailOffset` to read the
  rest.
- **`transfer_workspace`** — `{ targetWorkspaceId }`. Asks the host to move the current
  agent/session into an existing workspace. The result is `{ state: "scheduled", ... }` if the
  host defers the move, or `{ state: "transferred", workspace, ... }` once it has happened; the
  model is told which.
- **`archive_workspace`** — `{ workspaceId }`. Archives one workspace. Archiving is the durable
  decision recorded by the store; any worktree or folder cleanup the host performs afterward is
  its own, asynchronous concern.
- **`get_workspace_branch_metadata`** — `{ workspaceId, detailOffset?, detailLimit? }`. Reads
  host-reported Git facts (branch, head, upstream, ahead/behind, detached) for a workspace, paged
  the same way as `get_workspace`. The feature never runs Git; it only validates and pages what the
  store returns.

Governing principles across all six tools:

- All are `durable: true` and `shouldReviewInAutoMode: () => false` — Auto permission mode never
  reviews them, since they act only through the host store rather than the local sandbox.
- `create_workspace`, `transfer_workspace`, and `archive_workspace` are idempotent under retry: the
  feature derives an operation fingerprint from the normalized input, allocates or reuses a durable
  operation ID from the calling agent's own `AgentKV`, and replays a stored receipt/proof pair
  rather than re-invoking the store when the same operation ID is seen again. Reusing an operation
  ID with different input is rejected.
- Every result the store returns is re-validated against its schema and cross-checked against a
  fresh authoritative read (`store.get`) before it is trusted; a mismatch throws rather than
  passing bad state to the model.
- List and detail pages are always re-clipped to `maxOutputCharacters` before reaching the model,
  never truncated silently — `formatForModel`/`formatPageForModel`/`formatDetailPageForModel` throw
  rather than drop a record's identity fields.
- Ownership is enforced on every read and mutation: an agent acting on another agent's workspace is
  refused unless the host's `authorization` callback allows the specific action (`list`, `get`,
  `branch_metadata`, or `transfer`).

## External functions

All methods take `(ctx, agentId, ...)` and are exported on `WorkspacesFeature`, one instance per
host wiring (not per agent — `agentId` is passed explicitly on every call):

- `create(ctx, agentId, input: WorkspaceCreateInput): Promise<Workspace>` — the host-facing form of
  `create_workspace`. `input` may include `id` and `operationId` directly (useful outside a tool
  call, where there is no call-scoped `AgentKV` to allocate them from); omitting both requires the
  context to carry an `AgentKV` via `agentKV(ctx)`, or the call throws.
- `listPage(ctx, agentId, query?: WorkspacePageQuery): Promise<WorkspacePage>` and
  `list(ctx, agentId, query?): Promise<Workspace[]>` — the latter is `listPage` with just the
  `workspaces` array.
- `get(ctx, agentId, workspaceId): Promise<Workspace | undefined>` — one full, unpaged workspace
  record.
- `getPage(ctx, agentId, workspaceId, query?: WorkspaceDetailQuery): Promise<WorkspaceDetailPage>` —
  the host-facing form of `get_workspace`'s bounded detail paging; returns `{ workspace: null }` for
  an unknown ID instead of throwing.
- `transfer(ctx, agentId, input: WorkspaceTransferInput): Promise<WorkspaceTransferResult>` — also
  accepts a project-transfer shape (`{ workspaceId, targetProjectRef, operationId? }`) that
  `transfer_workspace` does not expose to the model, for hosts that move a workspace between
  projects directly.
- `archive(ctx, agentId, workspaceId, options?: WorkspaceArchiveOptions): Promise<Workspace>`.
- `branchMetadata` / `getBranchMetadata(ctx, agentId, workspaceId): Promise<WorkspaceBranchMetadata>`
  and `branchMetadataPage` / `getBranchMetadataPage(ctx, agentId, workspaceId, query?)` — the paged
  form backs `get_workspace_branch_metadata`.
- `formatForModel`, `formatPageForModel`, `formatDetailPageForModel`,
  `formatWorkspaceOperationForModel`, `formatWorkspaceForModel`,
  `formatBranchMetadataDetailPageForModel`, `formatBranchMetadataForModel` — the exact rendering
  each tool's `toLLM` uses, exposed so a host can show a model (or a person) the same text outside a
  tool call.

Every changed mutation (`create`, `transfer`, `archive`) emits a `WorkspaceEvent` —
`workspace_created`, `workspace_transferred`, `workspace_archived`, or
`workspace_transfer_scheduled` — carrying `eventId`, `at` (from `clock`), `agentId`, and the
resulting workspace (or, for a scheduled transfer, the target ID). If `listener.onEventTransactional`
is set it runs inside the same store transaction as the mutation; `listener.onEvent` runs only
after that transaction has durably committed, receiving the identical frozen event object. A
listener failure is reported to `onPostCommitError` and otherwise swallowed — it never fails the
mutation that already happened.

## Storage

The feature keeps almost nothing of its own. Workspace rows, receipts, and proofs are entirely the
host's, behind the `WorkspaceStore` contract passed as `store`: `create`, `list`, `get`, `transfer`,
`archive`, `branchMetadata`, plus `readReceipt`/`writeReceipt`, `readMutationProof`/
`writeMutationProof`, and `transaction`/`afterCommit` for atomicity and post-commit notification.
The feature validates every value the store returns against the matching TypeBox schema
(`workspaceSchema`, `workspaceOperationReceiptSchema`, `workspaceMutationProofSchema`, and so on)
and never assumes an untyped shape.

The one thing the feature persists itself is a durable operation identity, and only when a mutating
call needs one it wasn't given directly. It reads that identity from the calling agent's own
`AgentKV` (`agentKV(ctx)` from `@slopus/happy-agent-base`), under a fixed key per operation kind:

- `workspace.create.id` — the workspace ID allocated for a `create_workspace` call that supplied
  neither `id` nor `operationId`.
- `workspace.create.operation` — the operation ID for `create`.
- `workspace.transfer.operation` — the operation ID for `transfer`.
- `workspace.archive.operation` — the operation ID for `archive`.

Each key's value is a `WorkspaceOperationState`: `{ id, fingerprint }`, where `fingerprint` is a
SHA-256 hex digest of the normalized request (operation kind, agent ID, and the mutation's
identifying fields). The identity is allocated once, on first use, via `AgentKV.update`, which is
how a concurrently retried call converges on the same ID instead of racing to two. Reusing the same
key with a different fingerprint — the same call scope asked to do something else — is rejected as
an error rather than silently reused.

Receipts and immutable mutation proofs (`WorkspaceOperationReceipt`, `WorkspaceMutationProof`,
keyed by `agentId` + `operationId` in the host's own storage) are what makes replay possible: a
proof records the operation's exact before/after state and result and is written before the
receipt, so a receipt without a matching proof — or a proof with no receipt — is treated as
corruption and rejected rather than replayed. Neither is bounded or retained by this feature; a
host that wants to expire old operation records owns that policy in its store implementation.
