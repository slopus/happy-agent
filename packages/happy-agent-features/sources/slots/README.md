# Slots

A host-owned catalog of persistent content that agents place into Happy's fixed UI regions:
`status-line`, `above-composer`, `title`, and `sidebar`. An agent that wants to keep something
visible in the interface — a status summary, a call-to-action button, a running title — creates a
slot entry instead of repeating it every turn in chat. The entry survives independently of the
conversation and is rendered by the host, not by replaying model output.

Each slot name only accepts certain scopes: `sidebar` is `everywhere` only; `title` is `project` or
`workspace`; `status-line` and `above-composer` accept `everywhere`, `project`, `workspace`, or
`session`. This matrix (`allowedSlotScopes`) is enforced on every create, update, and reorder.

Storage, target existence, and live projection all belong to the host: the feature validates,
serializes mutations, and keeps them retry-safe, but it never persists anything on its own beyond
the durable identities it needs for that safety.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { SlotsFeature } from "@slopus/happy-agent-features";

const slots = new SlotsFeature({
    store: hostSlotStore,
    scopeResolver: (ctx, agentId, reference) => hostResolvesScopeTarget(ctx, reference),
    publisher: (ctx, event) => hostProjectsSlotEvent(ctx, event),
    readAuthorization: (ctx, requesterAgentId, ownerAgentId, operation) =>
        hostAllowsCrossAgentRead(ctx, requesterAgentId, ownerAgentId, operation),
});
const agent = await Agent.create(ctx, { ...options, features: [slots] });
```

`store`, `scopeResolver`, and `publisher` are required. `readAuthorization` is optional; without it,
an agent may only read its own entries. `idFactory`, `eventIdFactory`, `clock`, `listener`,
`maxEntries`, `maxPageSize`, `maxOutputCharacters`, and `onPostCommitError` are all optional and
default to a random UUID factory, `Date.now`, no listener, `MAX_SLOT_ENTRIES` (500), 50, and 12,000
respectively.

## Tools it provides to the model

Every tool is `durable: true` and never reviewed in Auto (`shouldReviewInAutoMode: () => false`),
since a slot mutation only ever touches host-owned state the feature already validates.

- **`create_slot`** — creates one entry. Arguments: `slot`, `content` (`{ type: "text", markdown }`
  or `{ type: "button", label, action }`), `description`, `purpose`, and a scope discriminated union
  (`scope: "everywhere"`, or `"project"`/`"workspace"`/`"session"` with the matching `*Id`). The
  feature assigns the entry ID; the model never supplies one. Returns the created `entry`.
- **`list_slots`** — reads one bounded page. Arguments mirror `slotPageQuerySchema`: an optional
  `slot` filter, an optional `scope` (with its target ID when scoped), an optional integer `cursor`,
  and an optional `limit` (up to `MAX_SLOT_PAGE_SIZE`, 100). Returns entry rows and, when more
  remain, `nextCursor`.
- **`get_slot`** — reads one entry by `id`, plus `detailOffset`/`detailLimit` to page through its
  full content, action, description, and purpose as a character stream when the entry doesn't fit
  in one response. Returns `{ entry: null }` for an unknown ID rather than an error.
- **`update_slot`** — changes `slot`, `content`, `description`, and/or `purpose` on an existing
  entry by `id` (at least one field required). Scope, target, and author stay fixed. Returns the
  updated `entry`.
- **`reorder_slots`** — takes `entryIds`, an array that must name every current entry exactly once,
  and sets that as the catalog order. Returns the first bounded page of the reordered catalog; the
  rest stays reachable through `list_slots`.
- **`remove_slot`** — removes one entry by `id`. Returns `{ removed: boolean }`; removing an
  already-absent entry is a no-op, not an error.

Governing principles:

- **Ownership.** `update`, `reorder`, and `remove` only act on entries the calling agent authored
  (`authorAgentId`); the feature refuses cross-agent mutation outright.
- **Durability and idempotency.** Every mutating tool is durable: on retry, the feature looks up a
  durable operation identity first and, if a receipt already exists for it, replays the original
  result instead of mutating twice. `create_slot` similarly reuses a durable entry ID when replayed
  with the same input, so a retried tool call cannot create a duplicate entry.
- **Bounds and paging.** The catalog is capped at `maxEntries` (default `MAX_SLOT_ENTRIES`, 500).
  Every list and reorder response is a bounded page with a numeric, forward-progressing cursor;
  `get_slot` exposes large entry detail through its own character-offset cursor
  (`MAX_SLOT_DETAIL_PAGE_SIZE`). All model-facing text is fit under `maxOutputCharacters`, shrinking
  from a detailed rendering to a compact identity-only rendering, and finally to a smaller page,
  before ever truncating an entry's ID or its continuation cursor.
- **What the model sees back.** Formatted output is prose, not raw JSON: entry rows show ID, slot,
  scope, and (when there's room) content, description, purpose, and author; mutation results carry a
  short label (`"Slot entry created."`, `"Slot entry updated."`, etc.) ahead of the same rendering.

## External functions

All of these live on the `SlotsFeature` instance and take the same `(ctx, agentId, ...)` shape the
tools use internally; the tools are thin wrappers around them.

- `listPage(ctx, agentId, query?): Promise<SlotPage>` — the bounded page behind `list_slots`,
  shrinking its page size until the rendering fits `maxOutputCharacters`.
- `list(ctx, agentId, query?): Promise<readonly SlotEntry[]>` — convenience wrapper returning just
  `listPage(...).entries`.
- `get(ctx, agentId, id): Promise<SlotEntry | undefined>` — one complete entry, or `undefined` if it
  doesn't exist. Enforces read authorization and scope validity.
- `getPage(ctx, agentId, id, query?): Promise<SlotDetailPage>` — the cursor-paged detail behind
  `get_slot`.
- `create(ctx, agentId, input, options?): Promise<SlotEntry>` — creates an entry. `options.operationId`
  lets a host supply its own durable operation identity instead of the feature's default.
- `update(ctx, agentId, id, changes, options?): Promise<SlotEntry>` — applies partial changes.
- `reorder(ctx, agentId, entryIds, options?): Promise<readonly SlotEntry[]>` — sets the full order
  and returns every entry, unpaged.
- `reorderPage(ctx, agentId, entryIds, options?): Promise<SlotPage>` — `reorder` plus the bounded
  first-page view used by `reorder_slots`.
- `remove(ctx, agentId, id, options?): Promise<boolean>` — removes an entry; returns whether
  anything was actually removed.
- `formatForModel`, `formatOperationForModel`, `formatDetailPageForModel`, `formatPageForModel`,
  `formatReorderPageForModel` — the same bounded, prose-rendering logic the tools use, exposed so a
  host can reuse identical text.
- `tools(ctx, scope): readonly AnyAgentTool[]` — the `AgentFeature` hook that supplies the six tools
  above, bound to the owning agent's ID.

Every create, update, reorder, and remove that actually changes state produces one `SlotEvent`
(`slot_entry_created`, `slot_entry_updated`, `slot_entries_reordered`, or `slot_entry_removed`),
delivered as a deeply frozen, immutable object through two channels: `listener.onEventTransactional`
runs inside the same transaction as the mutation, and `listener.onEvent` plus the `publisher` run
after the host's outermost commit. A failure in either post-commit channel is contained through
`onPostCommitError` rather than surfacing as a tool failure, since durable state has already
settled by that point. No-op mutations (a replayed request, or a change that leaves the entry
unchanged) produce no event.

## Storage

The feature holds essentially no state of its own. Everything durable lives in one of two places:

- **The injected `SlotStore` (fully host-owned).** This is not a Rig KV; it's a structural
  contract (`SlotStore` / `slotStoreSchema`) the host implements over its own database:
  - `transaction` / `afterCommit` — wraps the read-decide-write cycle of every mutation and
    registers post-commit callbacks synchronously.
  - `list(ctx, agentId, query)` / `get(ctx, agentId, id)` — reads, returning a `SlotPage` (or a
    plain `SlotList` for simple adapters).
  - `create` / `update` / `reorder` / `remove` — each takes a `{ operationId, fingerprint }`
    mutation request and returns an operation-tagged `SlotStoreMutationResult`.
  - `readReceipt(ctx, agentId, operationId)` / `writeReceipt(ctx, agentId, receipt)` — the durable
    `SlotOperationReceipt` (`{ agentId, operation, operationId, fingerprint, result }`) a host must
    persist and return unchanged, which is what makes retried mutations idempotent.
  - `readMutationProof` / `writeMutationProof` — an append-only, host-persisted
    `SlotRemoveProof` (`{ agentId, operation: "remove", operationId, fingerprint, entryId, before,
    removed }`) captured from the transaction that actually performed a remove, kept separate from
    the receipt so the authoritative before-state and outcome survive even if the receipt path is
    replayed later.

  Every value coming back from the store is validated against the corresponding TypeBox schema
  (`slotEntrySchema`, `slotPageSchema`, `slotStoreMutationResultSchema`,
  `slotOperationReceiptSchema`, `slotMutationProofSchema`) before the feature trusts it, and pages
  are checked for duplicate IDs, non-progressing cursors, and out-of-bound sizes.

- **`AgentKV` (via `agentKV(ctx)`), scoped to the acting agent.** Used only to allocate durable
  identities when the caller doesn't supply its own `operationId`, so that retrying the same tool
  call reuses the same identity instead of minting a new one:
  - Key `"create_slot_id:<fingerprint>"` (built by `durableStateKey(CREATE_ID_KEY, fingerprint)`) —
    stores `{ id, fingerprint }` (`SlotOperationState`), the entry ID chosen for a given create
    request.
  - Key `"<operation>_slot_operation:<fingerprint>"` for `create`, `update`, `reorder`, and
    `remove` (`CREATE_OPERATION_KEY`, `UPDATE_OPERATION_KEY`, `REORDER_OPERATION_KEY`,
    `REMOVE_OPERATION_KEY`) — stores `{ id, fingerprint }`, the operation ID for that mutation.

  The fingerprint is a 64-character lowercase hex SHA-256 digest of the canonicalized request
  (`fingerprint()`/`slotOperationFingerprintSchema`), bounded to 1,000,000 canonical bytes and depth
  8 before hashing. If a stored identity's fingerprint doesn't match the current request, the
  mutation is rejected rather than silently reused, so an operation ID can never be replayed against
  different input.

Every persisted `SlotEntry` (`id`, `slot`, `content`, `authorAgentId`, `description`, `purpose`,
`createdAt`, `updatedAt`, `ordering`, plus its scope discriminator and target ID) and every
retained catalog is bounded: at most `MAX_SLOT_ENTRIES` (500) entries, IDs and scope target IDs up
to 192 characters, markdown content up to 12,000 characters, descriptions and purposes up to 2,000
characters, and orderings that must be unique, contiguous, and start at zero. The feature revalidates
these invariants on every read, not just on write, so a host store that returns corrupted or
inconsistent data is caught rather than passed through to the model.
