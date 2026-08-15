# Image generation

Turning a text prompt into a generated image, durably and idempotently, without the feature ever
touching a filesystem, provider SDK, or media store itself. A model calling `generate_image` twice
with the same input — a retried tool call, a resumed turn, a call replayed after a restart — must
get back the exact same result rather than a second image and a second bill. This feature is the
provider-neutral layer that makes that guarantee: it normalizes the request, gives it a durable
operation identity, and hands the actual work to two host-owned contracts, an `ImageGenerator` that
produces bytes and an `AssetStore` that stages, commits, and catalogs them.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { ImageGenerationFeature } from "@slopus/happy-agent-features";

const imageGeneration = new ImageGenerationFeature({
    generator: hostGenerator, // { generate(ctx, request) => Promise<GeneratedImage> }
    store: hostAssetStore, // AssetStore: transaction/stage/commit/rollback/create/status/...
    // idFactory, eventIdFactory, clock, listener, maxOutputBytes, maxOutputCharacters,
    // onPostCommitError are all optional
});
const agent = await Agent.create(ctx, { ...options, features: [imageGeneration] });
```

One `ImageGenerationFeature` instance serves every agent that includes it; ownership of a given
operation or asset is carried in the `agentId` on every call, not in a separate instance per agent.

## Tools it provides to the model

`generate_image` (`tools/generate_image.ts`) is the one tool the feature exposes, added by
`ImageGenerationFeature#tools`. Its arguments are `imageGenerationToolInputSchema`:

- `prompt` — a non-empty string, at most 8,000 characters. The model cannot supply an operation
  identity through this tool; that is reserved for host callers of `generate`.
- `options` — optional, provider-neutral hints: `size`, `width`, `height`, `aspectRatio`,
  `quality` (`"draft" | "standard" | "high"`), `style`, `seed`. A host may ignore any of them.

The tool is `durable: true` and `shouldReviewInAutoMode: () => false` — Permissions never reviews
it, and the Agent Base gives it a stable operation identity from call-scoped Agent KV so a retried
or resumed tool call replays instead of generating again. Execution calls
`feature.generate(ctx, agentId, input)`; the result the model sees comes from
`feature.formatForModel(status)`, which renders bounded, path-free text: for a completed
generation, the operation ID, asset ID, media type, and host-owned locator, followed by as much of
the prompt, options, and byte size as fits the character budget (default from
`maxOutputCharacters`, at least 256, at most `MAX_IMAGE_OUTPUT_CHARACTERS`); for a pending or
failed generation, the status and, on failure, the bounded error string. The model is never shown
image bytes, a filesystem path, or an unbounded locator — `imageAssetLocatorSchema` caps a locator
at 80 characters specifically so it still fits inside the tool result.

## External functions

`ImageGenerationFeature` (`ImageGenerationFeature.ts`) exposes these methods to hosts and API
callers, all taking a `Context` first:

- `generate(ctx, agentId, input: ImageGenerationInput): Promise<ImageGenerationStatus>` — the
  same operation the tool calls, but a host may pass its own `operationId`. It normalizes the
  prompt (trims it, re-validates), computes a SHA-256 `fingerprint` over the canonicalized
  `{ agentId, prompt, options }`, and resolves an operation ID: the caller's, if given, or the one
  already durably assigned for that call. If a receipt and immutable proof already exist for that
  operation, it replays them — after checking the replayed request matches the identity being
  asked for — instead of calling the generator again. Otherwise it calls the `ImageGenerator`,
  stages the bytes through the `AssetStore`, and inside one store transaction re-checks for a race,
  writes the immutable proof, writes the receipt, and calls `store.create` to commit the asset to
  the catalog. If a losing race is detected the newly staged bytes are rolled back instead of kept.
- `status(ctx, agentId, operationId): Promise<ImageGenerationStatus | undefined>` — reads one
  operation's current status; unknown returns `undefined`.
- `read(ctx, agentId, assetId): Promise<ImageAsset | undefined>` — reads bounded metadata for one
  generated asset (media type, byte length, locator, dimensions, metadata); never image bytes.
- `remove(ctx, agentId, assetId): Promise<boolean>` — removes one asset the agent owns, inside the
  store's transaction, checking that removal is exactly what the before/after state shows before
  reporting success.
- `formatForModel(status, maxCharacters?)` — the same bounded rendering the tool uses, exposed so a
  host presenting a status to a person or another surface gets identical, size-bounded text.

Every mutating call ends by handing an `ImageGenerationEvent` to the optional `listener` passed at
construction (`imageGenerationListenerSchema`): `onEventTransactional(ctx, event)` runs inside the
same store transaction as the write, and `onEvent(ctx, event)` runs after the store's `afterCommit`
fires, once the staged bytes have actually been committed. Events are
`{ type: "image_generation_changed", eventId, at, agentId, operationId, fingerprint, operation }`
for a create/replay, or `{ type: "image_removed", eventId, at, agentId, assetId }` for a removal.
A listener error after commit is reported to the optional `onPostCommitError(ctx, event, error)`
callback rather than thrown, since durable state has already settled by then. `generate_image` is
the tool surface for these same operations; `generate`/`status`/`read`/`remove` are the same
capability opened up for hosts that need it outside a model turn.

## Storage

The feature keeps almost no state of its own; durability is split between call-scoped Agent KV and
the host-owned `AssetStore`.

- **Call-scoped Agent KV** — when `generate` is invoked without a caller-supplied `operationId`,
  the feature reads and writes one key, `"generation"` (`IMAGE_OPERATION_KV_KEY`), through
  `agentKV(ctx)`. Its value is `{ operationId, fingerprint }`
  (`durableOperationStateSchema`). This is what makes the `generate_image` tool call itself
  idempotent under retry: the operation ID assigned to a given tool call is fixed the first time
  and reused on replay, and a reuse of that call slot with a different fingerprint (different
  prompt or options) is rejected rather than silently generating something new. If no Agent KV is
  bound to the context, a fresh operation ID is minted every call instead — that path is only
  reachable through the direct `generate` API, not through the tool.
- **Host `AssetStore`** — everything else lives here, behind the structural `assetStoreSchema`
  contract (`AssetStore.ts`), so this package never imports a concrete store implementation:
  - `stage` / `commit` / `rollback` — external staging of the generated bytes outside the
    transaction, keyed by an opaque `stageId`. `commit` only ever runs from the store's own
    `afterCommit` hook, after the create transaction that references the stage has actually
    committed; `rollback` runs on a losing race, a validation failure, or an outer rollback.
  - `create` / `status` / `read` / `remove` — the mutable catalog: `create` turns a committed
    stage into an `ImageAsset` and returns the authoritative `ImageGenerationStatus`; `status` and
    `read` look it up by `{ agentId, operationId }` or `{ agentId, assetId }`; `remove` deletes an
    asset.
  - `readReceipt` / `writeReceipt` — the mutable, retry-facing `ImageGenerationReceipt`
    (`{ agentId, operationId, fingerprint, prompt, options?, result }`), read back and compared
    byte-for-byte after every write to confirm the store actually persisted it.
  - `readGenerationProof` / `writeGenerationProof` — an independent, append-only
    `ImageGenerationProof` with the same shape as the receipt. Hosts must retain the proof even
    after the mutable receipt or asset rows are removed, and must refuse to let it be overwritten
    with different content — the feature enforces this by comparing any existing proof to the one
    it is about to write and throwing rather than replacing it. A receipt with no matching proof,
    or a proof with no matching receipt, is treated as a corrupt store and `generate` throws.

All values crossing this contract are TypeBox-validated and size-bounded before use: prompts and
options up to 8,000 characters each, generated bytes up to 50 MB, metadata up to 32 flat primitive
properties of at most 1,024 characters each, and every identity (`agentId`, `operationId`,
`assetId`, `stageId`) capped at 48 characters so a completed-generation result always fits inside
the model's output budget. The feature also re-reads every value a store call claims to have
written and rejects the result if the store mutated a detached snapshot it was handed, so a
misbehaving store implementation fails loudly instead of corrupting replay.
