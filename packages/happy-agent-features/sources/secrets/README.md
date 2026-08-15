# Secrets

Host-owned secret metadata and attachment management. An agent often needs a database URL, an API
key, or some other credential to do its work, but the value itself must never enter a model's
context, a tool argument, a transcript, or anything the model can see. This feature lets a model
discover that a secret exists, read its safe description, and attach or detach it from an opaque
scope the host defines — while the value stays entirely on the host side, reachable only through a
method the feature deliberately does not expose as a tool.

The feature never stores a secret value itself, never opens a database, never edits
`process.env`, and never decides how a host applies a resolved value to a process or a command. All
of that is the host's job. The feature only keeps the catalog of safe references and attachments
consistent, durable, and correctly replayed under retry.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { SecretsFeature } from "@slopus/happy-agent-features";

const secrets = new SecretsFeature({
    store: hostSecretStore,
    fingerprintProvider: hostKeyedFingerprintProvider,
});
const agent = await Agent.create(ctx, { ...options, features: [secrets] });
```

`store` and `fingerprintProvider` are required. `store` is a `SecretStore` the host implements
over its own database or vault; `fingerprintProvider` is the host-owned keyed digest boundary
described below. Everything else — `idFactory`, `mutationIdFactory`,
`eventIdFactory`, `clock`, `listener`, `authorize`, `onPostCommitError`, `maxPageSize`, and
`maxOutputCharacters` — has a working default and only needs to be supplied when the host wants to
control identity generation, subscribe to events, enforce scope-level authorization, or tighten the
bounds on list pages and model-facing text.

## Tools it provides to the model

The feature offers four tools, all common (provider-neutral) and all `durable: true`, so a retried
tool call replays its exact original result rather than re-running the mutation. None of them can
reach the raw host resolver: `resolveForHost` is intentionally not a tool. Every tool sets
`shouldReviewInAutoMode: () => false`, since none of them can leak a value or touch anything outside
the secret catalog.

- **`list_secrets`** — lists a bounded page of safe metadata. Arguments: `limit` (1–`maxPageSize`,
  defaults to `maxPageSize`), `cursor` (an integer offset into the host's filtered result set), and
  `scopeRef` (restrict the page to secrets attached to one opaque scope). The model sees each
  secret's `id`, `description`, sorted-and-deduplicated `environmentVariables` names, `revision`,
  and, when the host set it, `availableToModel` and `kind`. If a page's rendered text would exceed
  `maxOutputCharacters`, the feature retries with a smaller `limit` before giving up, so the model
  never receives a page it cannot read in full; a truncated `next=<cursor>` line is appended only
  when a further page still fits.
- **`reference_secret`** — reads one safe reference by `id` and returns `{ secret: reference | null }`.
  `null` means no such secret is registered; the tool never distinguishes "does not exist" from "you
  are not authorized" beyond what `authorize` decides.
- **`attach_secret`** — attaches a registered secret to a `scopeRef`, changing what is *available*,
  never returning a value. Arguments are `scopeRef` and `secretId`. On success the model is told
  which secret was attached to which scope and shown that secret's reference; the host resolves the
  actual value later, out of the model's sight, using `resolveForHost` against the same scope.
- **`detach_secret`** — detaches a `{ scopeRef, secretId }` pair and reports only `detached: boolean`
  plus the two identifiers, never a value.

Governing principles across all four: durability comes from an `operationId`/keyed-fingerprint
pair allocated once per logical call and replayed verbatim on retry (see Storage); permissions are
enforced only by the optional host `authorize` callback plus whatever the host's own `SecretStore`
does, since the feature has no notion of ownership itself; every list and lookup is bounded by
`maxPageSize` and `maxOutputCharacters`; paging is a monotonically progressing integer cursor the
store must advance by exactly the number of rows returned; and no schema, tool result, or formatted
string produced for the model carries a secret value — `secretReferenceSchema` has, by design, no
value-bearing property.

## External functions

`SecretsFeature` is a class; a host or another feature calls its methods directly with a `Context`
and the acting agent's ID, the same way the tools do internally.

- `list(ctx, actingAgentId, query?: SecretListInput): Promise<SecretPage>` — the same bounded,
  size-shrinking page logic the `list_secrets` tool uses.
- `reference(ctx, actingAgentId, secretId): Promise<SecretReference | undefined>` — one safe
  reference, or `undefined` if it does not exist.
- `register(ctx, actingAgentId, input: SecretRegistrationInput, options?): Promise<SecretReference>`
  — registers a secret (host values plus description) and returns only its safe reference. Not
  exposed as a tool: registration is a host operation.
- `update(ctx, actingAgentId, secretId, input: SecretUpdateInput, options?): Promise<SecretReference | undefined>`
  — patches `description` and/or `environment` (a `null` value removes that variable); `undefined`
  if the secret does not exist.
- `remove(ctx, actingAgentId, secretId, options?): Promise<boolean>` — removes a secret and its
  attachments atomically through the store; returns whether anything changed.
- `attach(ctx, actingAgentId, scopeRef, secretId, options?)` and the `(ctx, actingAgentId, input: SecretAttachInput, options?)` overload — returns `Promise<SecretAttachment>`, the same operation as the tool.
- `attachWithReference(...)` — same overloads as `attach`, but returns
  `Promise<SecretAttachReferenceResult>` (`{ attachment, secret }`), which is what the tool actually
  calls so it can render both the attachment and the reference in one durable receipt.
- `detach(ctx, actingAgentId, scopeRef, secretId, options?)` / `(ctx, actingAgentId, input, options?)`
  — `Promise<boolean>`.
- `resolveForHost(ctx, actingAgentId, scopeRef, secretIds?): Promise<SecretHostEnvironment>` — the
  one method that returns real values, deliberately not wrapped as a tool or ever rendered to a
  model. `secretIds`, when given, must be a de-duplicated array of at most 256 valid IDs.
- `formatForModel`, `formatPageForModel`, `formatAttachmentForModel`, `formatDetachForModel` —
  render results to the exact bounded text the tools send back, available to a host building its
  own presentation on top of the same methods.

Every mutating method (`register`, `update`, `remove`, `attach`/`attachWithReference`, `detach`)
takes optional `SecretMutationOptions` (`operationId`) and runs inside `store.transaction`, emitting
one `SecretEvent` (`secret_registered`, `secret_updated`, `secret_removed`, `secret_attached`, or
`secret_detached`) only when the mutation actually changed something. A `SecretFeatureListener`
passed as `listener` gets `onEventTransactional` inside that same transaction and `onEvent` after it
commits (via `store.afterCommit`); `onPostCommitError` is invoked, best-effort, if `onEvent` throws.

## Storage

The feature keeps almost nothing itself. All catalog state — registrations, attachments, receipts,
and mutation proofs — lives in the host's own `SecretStore` (`sources/secrets/SecretStore.ts`),
which the host implements and passes in as `store`. Its shape:

- `list`, `reference`, `attachment` — bounded reads of the catalog.
- `register`, `update`, `remove`, `attach`, `detach` — mutations, each taking a
  `SecretMutationRequest` (`{ operationId, fingerprint }`) so the store can recognize and replay a
  retried call.
- `readReceipt` / `writeReceipt` — a `SecretOperationReceipt` per `operationId`, keyed by
  `(agentId, operationId)`, holding the exact safe mutation result that must be replayed verbatim on
  retry. The feature enforces that a second `writeReceipt` for the same key is byte-identical.
- `readMutationProof` / `writeMutationProof` — an append-only, immutable proof (`SecretRemoveProof`,
  `SecretDetachProof`, or `SecretAttachProof`) recording the before-state and outcome of a
  destructive or no-op `remove`/`detach`/`attach`, kept separately from the (rewritable) receipt.
- `resolveForHost` — the resolver the host implements to actually produce values (a
  `SecretHostEnvironment`, i.e. a map of environment-variable name to string value, at most 256
  entries, values up to 65,536 characters) for a given scope. This is the only place a value ever
  appears.
- `transaction` / `afterCommit` — the host's own transactional and post-commit hooks, used for every
  mutation and for delivering `SecretEvent`s.

The required `fingerprintProvider` is deliberately separate from the store. Its
`fingerprint(ctx, input)` receives one validated, normalized `SecretFingerprintInput` and returns
an exact 64-character lowercase keyed digest. Register and update inputs include raw values so
value-only changes produce different identities, but that input is never persisted, emitted,
formatted, or exposed to a tool. The host must canonicalize it and use a collision-resistant key
that remains stable across restarts; HMAC-SHA256 is the intended implementation. An unkeyed hash
would turn the fingerprint into an offline oracle for low-entropy secret values.

The one thing the feature itself persists is durable call identity, and only when the ambient
`Context` carries an `AgentKV` (`agentKV(ctx)` from `@slopus/happy-agent-base`) — i.e. inside a
durable tool call. It stores a `SecretOperationState` (`{ id, fingerprint }`) under call-scoped keys
so that re-entering the same logical call after a retry reuses the same identity instead of minting
a new one:

- `register_secret_id:<fingerprint>` — the generated `SecretId` for a registration that omitted one,
  reused on retry as long as the host-keyed request fingerprint matches.
- `operation:<key>:<fingerprint>` — the generated `SecretOperationId` for each mutation, where `key`
  is `register`, `update:<secretId>`, `remove:<secretId>`, `attach:<scopeRef>:<secretId>`, or
  `detach:<scopeRef>:<secretId>`.
- `event:<kind>:<operationId>` — the generated event ID for the `SecretEvent` a mutation emits.

If a key is reused with a different fingerprint, the feature throws rather than silently minting a
second identity for what looks like the same call. When no `AgentKV` is available (a direct,
non-durable call to a method like `register`), identities are generated fresh each time via
`idFactory`/`mutationIdFactory`/`eventIdFactory` (default: `crypto.randomUUID()`) and a `clock`
(default: `Date.now()`) for event timestamps. Every value that crosses into a receipt, proof, event,
or model-facing string is validated against its TypeBox schema and deep-frozen before an event is
handed to a listener, so nothing malformed or mutable escapes the feature's boundary.
