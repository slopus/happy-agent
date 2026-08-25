# Murmur

Murmur owns Happy Agent's opt-in contact sharing: one installation identity, mutual contacts,
incoming requests, outgoing requests, short-lived invitations, and relay connection state.
`ApiModule` calls it sharing and is the only public serialization boundary.

```ts
const murmur = new MurmurModule(profileModule);
await murmur.open(ctx);

// Only an explicit public enrollment call creates the identity.
const sharing = await murmur.enroll(ctx);
```

The constructor takes only the profile module. The managed relay is an internal product detail;
there is no configuration toggle or configurable relay. A historical `[sharing]` section has no
authority and cannot enroll an installation. `open(ctx)` creates only the stable unenrolled
high-water row unless durable public state already says the installation enrolled earlier.

Enrollment ensures the singleton local profile, opens a local Murmur client without waiting for
the relay, binds its identity, durably advances public state, and publishes the resulting version.
Repeating enrollment is a read-only no-op. An enrolled installation reopens automatically on
restart and always moves through `connecting` with a newer durable version.

## Public-state discipline

The module snapshot intentionally retains private Murmur fields for its direct API dependency:
profile and session IDs, carried-profile fields, and internal session handles. `ApiModule` makes
the explicit public projection and validates it with `@slopus/happy-agent-client` schemas. Private
IDs, photo storage metadata, session IDs, and invitation capabilities never enter a sharing
snapshot or event.

Outgoing request IDs are random 32-byte base64url values minted separately from both the
invitation and Murmur session ID. A SHA-256 digest, never the invitation capability itself, records
which pending outgoing request already redeemed an invitation so duplicate submissions are
durable no-ops.

Every actual public change first commits migration `003-murmur-public-state`'s singleton row. It
stores the complete authoritative sharing projection, bounded outgoing-ID mappings, private
recovery intents, local-profile publication high water, and UUIDv7 `version`/`updatedAt`
high-water values.
API reads and error bodies use this row even if the live Murmur client is temporarily unreadable.
Versions remain strictly increasing across same-millisecond changes, restarts, and clock rollback.
Reads and private intent writes never advance them. Only after a public commit does
`murmur_changed` publish the exact resulting version. API mutations therefore return the same
snapshot version their event names, while bursts of peer-driven relay callbacks may coalesce.

## Operations

- `snapshot(ctx)` always returns an unenrolled or enrolled snapshot.
- `enroll(ctx)` explicitly opts in and is idempotent.
- `createInvitation(ctx)` uploads a five-minute, single-use capability without changing public
  state.
- `requestContact`, `acceptContact`, `rejectContact`, and `removeContact` enforce public bounds,
  conflicts, missing-target errors, and documented no-ops before changing durable state. Contacts,
  incoming requests, and outgoing requests are each capped at Murmur 0.4.5's complete-scan limit
  of 256, so no accepted public entry can be hidden beyond the dependency's read window.
- Accept, reject, and remove operate on local durable Murmur state while offline.
- `reset(ctx)` remains enrolled, clears relationships and request mappings, binds a new identity to
  the same profile, and advances the public version. It first opens the replacement against a
  transactional in-memory store, then calls Murmur 0.4.5's authenticated identity-wide invitation
  revocation against a bounded clone of the old store. Only confirmed revocation permits the
  atomic durable swap. Replacement staging or revocation failure discards temporary clients,
  reopens the unchanged old identity, returns `unavailable`, mints no version, and emits no event
  for that attempt. Its private intent remains durable for a later reset call or startup retry.
- `close(ctx)` drains the client and store without changing enrollment.

Local profile changes retain their latest ProfileModule version as private scheduling high water
and call Murmur 0.4.5's `updateContactProfile`. Murmur atomically retains the carried profile and
one authenticated outbox per active contact, so publication converges after disconnection or
restart. Remote `onContactUpdated` lifecycle callbacks trigger a fresh authoritative Murmur read;
the resulting contact profile commits into the sharing projection, advances its UUIDv7, and emits
a mutationless `sharing.updated` through ApiModule. No Happy-specific session, packet protocol, or
peer-profile overlay exists.

`MurmurOperationError` is the module seam for expected domain failures. The API maps it to the
stable sharing error codes and always includes the current authoritative snapshot.

## Connection and lifetime

The client store and relay loop use a named lifetime derived from the first database context, not
the API request that happened to open them. Relay loss changes connection state to `disconnected`,
backs off from one second to one minute, and retries. Relay availability is never required to
enroll or perform local relationship decisions. Reset deliberately requires connectivity to a
compatible managed relay so invitation revocation can be confirmed before the old identity moves.

`openClient` is the protected test seam for the one network-aware dependency. Product code uses
the managed relay; tests substitute a facade without adding a host object or configuration input.

## Storage

- `001-murmur-binding` owns the singleton profile/identity binding.
- `002-murmur-store` owns Murmur's cryptographic key-value state through `SqliteMurmurStore`.
- `003-murmur-public-state` owns the authoritative projection, recovery intents, and public high
  water.

Reset opens the replacement client before touching durable state, then replaces the key-value
store, identity binding, and public projection in one database transaction. Before that swap,
revocation runs on a bounded copy because Murmur intentionally records a failed revocation for
retry in whichever store it operates on. Discarding the copy on failure keeps the real old store
and its invitations unchanged. Existing migrations are immutable.

## Profile transaction blocker

The profile module publishes `profile_changed` only after its profile write transaction has
committed. Its public seam exposes no in-transaction participant or durable outbox hook, so Murmur
cannot atomically advance Sharing's local-profile version in the same commit. The current flow is
crash-safe and convergent: Murmur durably advances after the profile commit, and startup always
advances Sharing and publishes the latest stored profile. A process crash in that narrow gap can
delay the Sharing version/event until restart. Exact cross-module atomicity requires ProfileModule
to expose an in-transaction change hook or persist a shared outbox intent before commit.

## Deliberate exclusions

There is no folder sharing, likes or approval system, onboarding state machine, model-facing tool,
configuration toggle, or configurable relay. Those are outside the public Sharing API.
