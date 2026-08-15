# Applets

A catalog of small host-managed programs an agent can build and hand back to its host. The model
imports a source it produced (or was given), the feature validates and versions it against a
host-owned catalog, and the host is the one that actually stores, serves, and renders it. The
feature never touches a filesystem or a database itself: it coordinates three host contracts — a
catalog, a source importer, and an asset reader — and makes their combination replay-safe,
bounded, and observable.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { AppletFeature } from "@slopus/happy-agent-features";

const applets = new AppletFeature({ catalog, importer, assetReader, listener });
const agent = await Agent.create(ctx, { ...options, features: [applets] });
```

`catalog` (`AppletCatalog`), `importer` (`SourceImporter`), and `assetReader` (`AssetReader`) are
structural contracts declared in `AppletStore.ts`; the host implements them over its own database
and storage. `listener` is optional and receives `AppletEvent`s. Other options — `authorFactory`,
`idFactory`, `eventIdFactory`, `clock`, the `max*` bounds, and `onPostCommitError` — have defaults
and let a host override identity resolution, output limits, and post-commit error reporting.

## Tools it provides to the model

`AppletFeature.tools` returns eight tools, all marked `durable: true` and
`shouldReviewInAutoMode: () => false`:

- **`create_applet`** / **`import_applet`** — aliases of the same operation (`appletToolImportInputSchema`:
  `name`, `description`, `purpose`, `path`, optional `iconPath`, `allowedScopes`,
  `sourceDescription`). `path` and `iconPath` are opaque host references the feature never
  resolves; the source importer decides what they mean. Fails if an applet with that `name`
  already exists. Returns the new `Applet` at version 1.
- **`update_applet`** — imports a new source version for an existing applet and optionally revises
  its metadata (`name`, `path`, `changeDescription`, and optional `allowedScopes`, `description`,
  `purpose`, `sourceDescription`, `iconPath`). Returns the updated `Applet`.
- **`revert_applet`** — sets the current version pointer back to an already-stored `version`
  (`name`, `version`). It does not re-import anything; it only changes which existing version is
  current. Returns the `Applet` at its (possibly unchanged) current version.
- **`remove_applet`** — deletes an applet from the catalog by `name`. Returns `true` if something
  was removed, `false` if it was already absent.
- **`get_applet`** — reads one applet's metadata, current version, and full version list by
  `name`. Returns `{ applet }`, `applet` being `undefined` if not found.
- **`list_applets`** — reads a bounded page of applets (`limit`, `cursor`), returning
  `{ applets, limit, hasMore, nextCursor? }`. The model is told to follow `nextCursor`.
- **`read_applet_asset`** — reads one bounded source asset through the host reader (`name`, `path`,
  optional `version`, defaulting to the current version). Returns the asset as UTF-8 or base64
  text, or `undefined`/`null` if not found.

Principles that govern every tool:

- **Idempotency.** Every mutating call (`create`, `update`, `revert`, `remove`) is wrapped by the
  feature's own operation identity and receipt machinery (see Storage below), so a retried tool
  call with the same arguments replays the durable result instead of re-running the mutation, and
  a retried call with different arguments is rejected outright.
- **Bounds.** List pages, output text, source imports, and asset reads are all capped
  (`MAX_APPLET_LIST_SIZE`, `maxOutputCharacters`, `maxSourceFiles`/`maxSourceBytes`/
  `maxSourceFileBytes`, `maxAssetBytes`). If a page or asset cannot fit the configured character
  budget, `listPage` narrows the page size until it does rather than truncating an applet identity
  mid-row.
- **What the model sees.** Every tool has a `toLLM` formatter that turns the structured result into
  a short text line built from `formatOperationForModel`, `formatAppletForModel`,
  `formatPageForModel`, `formatRemovalForModel`, or `formatAssetForModel`. These formatters never
  hide an applet's name, version, or a list cursor behind truncation; they throw instead if the
  identity itself cannot fit the output budget, and only truncate trailing description or asset
  content.
- **Permissions.** None of the eight tools request Auto-mode review; applet operations act only
  through the host-supplied catalog/importer/reader, not the local filesystem or shell sandbox.
- **Paging.** `list_applets` cursors are opaque to the feature (host-owned), but the feature still
  verifies that a non-terminal page always advances the cursor and that a terminal page carries no
  cursor.

## External functions

These are `AppletFeature`'s public methods, usable directly by a host or exposed through an API.
Tool-facing variants take an `agentId` and end in `ForAgent`; they resolve the author identity
through `authorFactory` and reuse the same underlying method.

- `import(ctx, input: AppletImportInput): Promise<Applet>` / `create` (alias) — creates a new
  applet. `input.operationId` may be supplied for host-driven idempotency; tools omit it and let
  the feature allocate one. Emits an `applet_imported` event.
- `importForAgent(ctx, agentId, input: AppletToolImportInput)` / `createForAgent` (alias) — the
  tool-facing form; resolves `authorSessionId` from `agentId` via `authorFactory`.
- `update(ctx, name, input: AppletUpdateInput): Promise<Applet>` — imports a new version and
  applies any supplied metadata changes. Emits `applet_updated`.
- `updateForAgent(ctx, agentId, name, input: AppletToolUpdateInput)` — tool-facing form.
- `revert(ctx, name, input: AppletRevertInput): Promise<Applet>` — moves the current-version
  pointer to an existing `input.version`. Emits `applet_reverted` (with `previousVersion`) only if
  the pointer actually changed.
- `revertForAgent(ctx, agentId, name, input: AppletToolRevertInput)` — tool-facing form.
- `remove(ctx, name, requestedOperationId?): Promise<boolean>` — removes the applet. Emits
  `applet_removed` only if something existed to remove.
- `removeForAgent(ctx, agentId, name)` — tool-facing form.
- `get(ctx, name): Promise<Applet | undefined>` — reads one applet by name.
- `list(ctx, query?: AppletListQuery): Promise<readonly Applet[])` — the applets from one page.
- `listPage(ctx, query?: AppletListQuery): Promise<AppletListPage>` — the full page, including
  `hasMore`/`nextCursor`.
- `current(ctx, agentId, name): Promise<AppletVersion | undefined>` — the authoritative current
  version row, cross-checked against `catalog.current` and the applet's own version list.
- `readAsset(ctx, input: AppletAssetReadInput): Promise<AppletAsset | undefined>` — reads one
  bounded asset, defaulting to the applet's current version.
- `formatForModel`, `formatPageForModel`, `formatAppletForModel`, `formatOperationForModel`,
  `formatRemovalForModel`, `formatAssetForModel` — the same text formatters the tools use,
  available to a host that wants identical output outside a tool call.

Every mutating method (`import`/`create`, `update`, `revert`, `remove`) runs inside
`catalog.transaction` and, on success, calls the listener's `onEventTransactional` inside that same
transaction, then `onEvent` after the outer commit through `catalog.afterCommit`. A source-staging
failure or a transactional listener throw rolls the staged import back via `catalog.onRollback`
before the transaction rolls back; a post-commit staging failure rolls the stage back and reports
the failure through `onPostCommitError` instead of failing the (already-committed) mutation.

## Storage

The feature keeps almost no state of its own; nearly everything durable lives in the host's
`AppletCatalog`:

- **The applet row** (`Applet`, from `Applet.ts`): `name`, `description`, `purpose`,
  `authorSessionId`, `allowedScopes`, optional `sourceDescription`/`iconThumbhash`/`iconUrl`,
  `currentVersion`, `versions` (an `AppletVersion[]` — `version`, `changeDescription`, `createdAt`,
  `operationId` — capped at `MAX_APPLET_VERSIONS` = 100), `createdAt`, `updatedAt`. Owned and
  persisted entirely by `catalog.get`/`list`/`create`/`update`/`revert`/`remove`.
- **Mutation receipts** (`AppletCatalogMutationReceipt`, keyed by `operationId` via
  `catalog.readReceipt`/`writeReceipt`): `operation`, `name`, `operationId`, `fingerprint`,
  `beforeExists`, `beforeCurrentVersion`, and the full `result` envelope. This is the replay record
  a repeated call with the same `operationId` reads back instead of re-mutating the catalog.
- **Mutation proofs** (`AppletCatalogMutationProof`, keyed by `operationId` via
  `catalog.readMutationProof`/`writeMutationProof`): an append-only, host-owned duplicate of the
  same fields as the receipt. The feature cross-checks proof against receipt on every replay and
  rejects a mismatch, so a tampered or partially-written receipt cannot silently short-circuit a
  mutation.
- **Operation identities** (`AppletOperationReceipt` — `{ id, fingerprint }`), stored in the
  agent's call-scoped `AgentKV` (from `@slopus/happy-agent-base`, resolved via `agentKV(ctx)`)
  under one of the fixed keys `"import"`, `"update"`, `"revert"`, `"remove"`. When a tool omits
  `operationId`, the feature allocates one through `idFactory` and stores it under that key inside
  the current call's KV transaction; a second execute against the same call scope with the same
  argument fingerprint reuses that identity, and one with a different fingerprint throws. If no
  `AgentKV` is attached to the context, the feature falls back to allocating a fresh operation ID
  every call (no replay protection).
- **Staged source files**: held by the host's `SourceImporter` between `stage` and `commit`/
  `rollback`; the feature never persists file bytes itself. `stage` is bounded by `maxSourceFiles`,
  `maxSourceBytes`, and `maxSourceFileBytes` (each capped by `MAX_APPLET_SOURCE_FILES` = 10,000,
  `MAX_APPLET_SOURCE_BYTES` = 50 MiB, `MAX_APPLET_SOURCE_FILE_BYTES` = 10 MiB).
- **Assets**: read on demand through `AssetReader.readAsset`, bounded by `maxAssetBytes` (capped at
  `MAX_APPLET_ASSET_BYTES` = 2 MiB); nothing about an asset is retained by the feature after the
  call returns.

Validation is layered: every value crossing a host boundary — the catalog's applet rows, pages,
mutation results, receipts, and proofs, plus the importer's stage result and the asset reader's
asset — is checked against its TypeBox schema and then against feature-owned structural invariants
(`assertApplet`, `assertAppletPage`, `assertAppletMutation`, `assertAppletMutationReceipt`,
`assertAppletMutationProof`, `assertSourceStage`, `assertAppletAsset`) before the feature trusts it:
contiguous, uniquely-numbered versions starting at 1, timestamps that stay inside the applet's
lifetime and only move forward, a `currentVersion` that names a real version, and mutation results
whose `name`/`targetVersion`/`currentVersion` agree with the applet they claim to describe. Retention
of receipts, proofs, and versions beyond `MAX_APPLET_VERSIONS` is entirely the host catalog's
policy; the feature enforces only the upper bound on how many versions and list items it will
accept in a single response.
