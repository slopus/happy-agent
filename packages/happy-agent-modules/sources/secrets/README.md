# Secrets

Host-owned secret metadata and attachment management. An agent often needs a database URL, an API
key, or some other credential to do its work, but the value itself must never enter a model's
context, a tool argument, a transcript, or anything the model can see. This module lets a model
import a complete environment bundle from a reviewed host-side `.env` path, discover that a secret
exists, read its safe description, and attach or detach it from an opaque scope the host defines —
while the value stays entirely on the host side.

The module never edits `process.env` or starts a process. Values are confined to the module's own
SQLite-backed catalog; they never enter an event, model-facing result, or tool argument. The
Compute module asks it for one selected command environment immediately before spawning that
command.

A mutation simply overwrites. Calling `register`, `update`, `attach`, or `detach` again — with the
same value or a different one — applies again and succeeds; the store carries no retry ledger, and
there is no way for a repeated call to be rejected because it "reused an identity" or "changed the
input." Metadata and attachment tools are durable. Dotenv imports are deliberately non-durable
because an external file could change between the original invocation and a restart.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { SecretsModule } from "@slopus/happy-agent-modules";

const secrets = new SecretsModule();
const agent = await Agent.create(ctx, { ...options, modules: [secrets] });
```

The constructor takes nothing. The catalog, the clock, and identity generation are the module's own,
and its bounds are fixed constants it exports so a caller can read them but not change them:

- `GLOBAL_SECRET_OWNER_ID` (`"global"`) — the stable owner used by every agent tool and by default
  command resolution, making the product catalog installation-wide.
- `SECRETS_PAGE_SIZE` (50) — how many references one page returns when the caller does not ask for
  fewer.
- `SECRETS_OUTPUT_CHARACTERS` (12,000) — the character budget every model-facing secrets result is
  trimmed to fit.

## Authorization

The Happy Agent product catalog is global to the installation. Every agent's secret tools read and
mutate the same catalog under `GLOBAL_SECRET_OWNER_ID`; an agent ID is instead the attachment scope
used by that agent's command host. Attaching a global reference to one agent does not automatically
attach it to another.

The lower-level storage methods retain an opaque owner-ID parameter so the module boundary remains
explicit. Product integrations use `GLOBAL_SECRET_OWNER_ID` there. Beyond the reviewed attachment
decision, the `availableToModel` flag that keeps host-only credentials out of agent commands, and
the reserved `github` / `project-git` IDs, there is no additional authorization policy.

```text
model ── safe references/attachments ──> SecretsModule ── host-only values ──> command host
                                          │                                      │
                                          └── no values in tools/events ──────────┘
```

## Tools it provides to the model

The module offers six common (provider-neutral) tools. None can return values or reach the
value-bearing resolution methods: `resolveForHost` and `resolveForCommand` are intentionally not
tools. Metadata-only listing and reference reads do not require Auto review. Creation and update,
which accept either inline values or an absolute host `.env` path, always require Auto review. An
inline mutation stays sandboxed; only the host file read temporarily receives Full access. They do
not attach the resulting reference. Attach and detach also always require review because they grant
or revoke the current agent's later access to a credential, but those catalog-only mutations stay
in the current sandbox.

- **`list_secrets`** — lists the global catalog as bounded safe metadata. Arguments are `limit`
  (1–`SECRETS_PAGE_SIZE`) and a CUID2 `cursor`. The model sees each secret's ID, description,
  sorted environment-variable names, availability, ownership, UUIDv7 version, and timestamps. If
  detailed rendering would exceed `SECRETS_OUTPUT_CHARACTERS`, it falls back to all IDs plus the
  continuation cursor, so no actionable identity is lost.
- **`reference_secret`** — reads one safe reference by `id` and returns `{ secret: reference | null }`.
  `null` means no such secret is registered in the shared catalog.
- **`create_secret`** — creates a global secret from exactly one source: inline `environment`
  arguments or `dotenvFile`, an absolute path to a UTF-8 dotenv file no larger than 1 MiB. The ID
  is optional, and `availableToAgents` defaults to true. Inline values remain in the tool
  transcript; neither source enters the permission description, result, or model output.
- **`update_secret`** — replaces an existing global secret's complete environment from exactly one
  inline or dotenv source, with optional `description` and `availableToAgents`. Variables absent
  from the replacement are removed, while existing variable casing remains stable. Existing
  attachments are unchanged. It returns `{ secret: reference | null }`.
- **`attach_secret`** — attaches `secretId` to the exact current agent, changing what is
  _available_ without returning a value. Project and workspace grants are created through the
  client API rather than this agent-local tool.
- **`detach_secret`** — removes the exact current agent's direct grant for `secretId` and reports
  only safe identifiers plus `detached: boolean`.

Governing principles across all six: the catalog owner is `GLOBAL_SECRET_OWNER_ID`, while typed
project, workspace, and exact-agent grants control attachment availability; every list and lookup is bounded by
`SECRETS_PAGE_SIZE` and
`SECRETS_OUTPUT_CHARACTERS`; paging is a monotonically progressing integer cursor the store advances
by exactly the number of rows returned; and no schema, tool result, or formatted string produced
for the model carries a secret value — except the explicitly supported inline environment input,
which remains in the tool transcript. `secretReferenceSchema` has, by design, no value-bearing
property, so values never appear in results.

## External functions

`SecretsModule` is a class; a host or another module calls its methods directly with a `Context`
and an opaque catalog owner ID. Happy Agent integrations pass `GLOBAL_SECRET_OWNER_ID`; the agent ID
is passed separately as `scopeRef` when attaching or resolving command secrets.

- `list(ctx, actingAgentId, query?: SecretListInput): Promise<SecretPage>` — the same bounded,
  size-shrinking page logic the `list_secrets` tool uses.
- `reference(ctx, actingAgentId, secretId): Promise<SecretReference | undefined>` — one safe
  reference, or `undefined` if it does not exist.
- `register(ctx, actingAgentId, input: SecretRegistrationInput): Promise<SecretReference>` —
  registers a secret (host values plus description) and returns only its safe reference. A repeated
  call with an explicit `id` overwrites that secret's description and environment; a repeated call
  that omits `id` registers a new secret under a freshly generated one each time. The
  This is the legacy storage seam; the model-facing tool uses `createCatalogSecret`.
- `update(ctx, actingAgentId, secretId, input: SecretUpdateInput): Promise<SecretReference | undefined>`
  — patches `description`, `environment` (a `null` value removes that variable), and/or
  `availableToModel`; `undefined` if the secret does not exist. A repeated call with the same patch
  is a no-op that returns the same reference and emits no further event.
- `remove(ctx, actingAgentId, secretId): Promise<boolean>` — removes a secret and its attachments
  atomically through the store; returns whether anything changed.
- `attach(ctx, actingAgentId, scopeRef, secretId)` and the `(ctx, actingAgentId, input: SecretAttachInput)` overload — returns `Promise<SecretAttachment>`, the same operation as the tool.
- `attachWithReference(...)` — same overloads as `attach`, but returns
  `Promise<SecretAttachReferenceResult>` (`{ attachment, secret }`), which is what the tool actually
  calls so it can render both the attachment and the reference in one result.
- `detach(ctx, actingAgentId, scopeRef, secretId)` / `(ctx, actingAgentId, input)` — `Promise<boolean>`.
- `resolveForHost(ctx, actingAgentId, scopeRef, secretIds?): Promise<SecretHostEnvironment>` —
  returns real values for a trusted host operation, deliberately not wrapped as a tool or ever
  rendered to a model. `secretIds`, when given, must be a de-duplicated array of at most 256 valid
  IDs.
- `resolveForCommand(ctx, actingAgentId, scopeRef, secretIds?): Promise<SecretCommandEnvironment>`
  — the compute seam. It returns `{ environment, hiddenEnvironmentVariables }`; the host must remove
  every hidden name case-insensitively from its ambient environment before adding the resolved
  values. Explicit IDs must already be attached to the scope and still be available to the model.
  The module performs the collision-safe merge itself and validates the final bounded contract.
- `formatForModel`, `formatPageForModel`, `formatAttachmentForModel`, `formatDetachForModel` —
  render results to the exact bounded text the tools send back, available to a host building its
  own presentation on top of the same methods.

Resolution rejects a case-insensitive environment-name collision between selected secrets rather
than applying silent last-write-wins. The command host owns the final merge with its ambient
environment; the module supplies the names that must be hidden first.

For the default host shell, references come from the global catalog. Effective availability is the
union of the agent's project, exact workspace, and exact-agent grants. The model then names only
the required IDs in the shell command's `secrets` argument. Omitted or empty means no secret bundles.
Before spawning, Compute removes all environment-variable names belonging to attached bundles from
the ambient environment case-insensitively, then adds only the selected values. Selection is
reviewed but stays inside the current sandbox. The shell tool's explicit escalation argument
independently requests Full access, so credential provisioning and elevation may be used separately
or together. Input sent later to a secret-bearing background command is reviewed and continues
under the process's existing boundary.

Every mutating method (`register`, `update`, `remove`, `attach`/`attachWithReference`, `detach`)
runs inside the Agent Base transaction, emitting one `SecretEvent` (`secret_registered`, `secret_updated`,
`secret_removed`, `secret_attached`, or `secret_detached`) only when the mutation actually changed
something.

Subscribe after construction. `onEventTransactional(listener)` runs the listener inside the
committing transaction — throwing there rolls the mutation back — and `onEvent(listener)` runs it
after the outer transaction commits. Both return an unsubscribe function, and calling it more than
once does nothing further.

```ts
const unsubscribe = secrets.onEvent((ctx, event) => {
    ctx.log.info({ type: event.type }, "a secret changed");
});
```

A post-commit listener that throws is logged through `ctx.log.error` and cannot roll the committed
change back or stop the remaining listeners.

## Storage

The module keeps the catalog in its Agent Base database, and its SQLite-backed store is the only
resolution path — there is no injectable resolver. `SecretStore` is the validated structural
boundary for those database result shapes. Its shape:

- `list`, `reference`, `attachment` — bounded reads of the catalog.
- `register`, `update`, `remove`, `attach`, `detach` — mutations. Each simply applies against the
  current state and returns the outcome (`changed`/`removed`/`detached`, plus the resulting
  reference or attachment where relevant); the store does not need to remember anything about a
  call once it returns.
- `resolveForHost` — reads values (a `SecretHostEnvironment`, i.e. a map of environment-variable
  name to string value, at most 256 entries, values up to 65,536 characters) for a given scope. This
  is the only place a value leaves storage.
- Agent Base's transaction and `afterCommit` boundary — used for every mutation and for delivering
  `SecretEvent`s after the outer transaction commits.

Identities are minted by the module on every call: `crypto.randomUUID()` supplies a new `SecretId`
whenever `register` is called without an explicit `id` and a fresh ID for each emitted
`SecretEvent`, with `Date.now()` supplying its timestamp. There is no persisted call identity and nothing keyed to a
tool call's retry history: the module does not need `AgentKV` and does not read or write it.

Every value that crosses into an event or model-facing string is validated against its TypeBox
schema and deep-frozen before an event is handed to a subscriber, so nothing malformed or mutable
escapes the module's boundary. Registrations under `github` and `project-git` are rejected because
those IDs belong to managed host credentials.

The legacy `request_secret` interaction is intentionally not a secrets-catalog operation. Asking a
person to enter or update a value belongs in the User Input module/client broker. The reviewed
model-facing creation and update tools accept either inline raw values or a host dotenv path.

Specialized host integration debt remains for GitHub CLI token synchronization and the managed `project-git`
credential-proxy lease (`trustedLoopbackPorts`); those are not flat environment bundles and must be
owned by host infrastructure.
