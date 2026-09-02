# Cloud

`CloudModule` is Happy Agent's local Happy Cloud token broker. It owns the WorkOS public-client
PKCE flow, stores the rotating refresh token in the owner-only main database, verifies every minted
access token through Happy Cloud's `/v0/hello`, and publishes token-free versioned status snapshots.
Authorization expiry is carried by Durable Functions, so the pending-state transition and its
expiry intent commit together and unfinished expiry work survives daemon restarts.

Enrollment uses the local Happy Agent profile as the display-name authority and asks only for a
Cloud username. Authentication commits `checking` state and a Durable Function determines whether
the account is already enrolled. A username mutation durably records `enrolling` and returns its
optimistic profile immediately; the worker retries Happy Cloud until it reaches `enrolled` or a
definitive username conflict returns the account to `required`. Daemon restarts recover unfinished
enrollment, and later local profile-name changes use separate durable synchronization.

Each account also owns an independent Cloud encryption root. Key discovery starts only after
enrollment and durably compares the identity stored with the vault against any retained local root;
an unknown vault identity always requires restoration. A connected installation then creates a new
authenticated encrypted vault bundle or restores the existing one. Create and restore are Durable
Functions too, but their encryption and authentication factors stay only in process memory: the
HTTP request waits through transient network failures, while a daemon restart safely requires the
factors to be entered again. The owner-only root derives the public identity key, which is stored
with the encrypted vault blob rather than in profiles or social records. The daemon durably keeps
that root together with the non-password H1 generated secret and exposes both only through the
on-demand owner backup endpoint.

The random root seeds a privacy-kit-compatible HMAC-SHA-512 key tree under the `Happy Agent Cloud`
usage. Cloud keeps this tree in memory while account services are live and derives the Murmur
Ed25519 identity at `murmur / identity / #ed25519` with Noble. The raw root is never used directly
as an Ed25519 seed, and closing the live service destroys the retained tree state.

An account whose remote vault cannot be restored may explicitly reset it with the exact
`YES DELETE MY VAULT` confirmation. Reset is accepted only from `restore_required`, durably
publishes `resetting`, deletes the complete Happy Cloud vault without a vault authentication hash,
and then publishes `create_required`. Temporary failures resume after daemon restart. Any retained
local root and H1 backup survive, so recreating the vault preserves the existing identity.

Enrolled accounts with ready keys start `@slopus/murmur` against the fixed relay for the selected
deployment. Murmur owns a durable device identity in an account-scoped Cloud store, so opening the
client registers the device once and later daemon starts reuse it. A WorkOS-authenticated session
issuer negotiates Murmur's WebSocket transport; the Cloudflare relay does not expose the standalone
HTTP control routes. Relay registration and synchronization retry independently without changing
Cloud authentication status.

Each installation encrypts bounded owner-local metadata with the key-tree derivation at
`murmur / device-metadata / #aes256`, authenticated to the account and exact device public keys.
The device API decrypts valid entries independently, reports invalid or foreign metadata as null,
and returns Murmur's relay-owned last-access time. An owner may idempotently remove a sibling from
that roster; removing the current device is rejected so only durable Cloud disconnect can couple
self-unregistration with deletion of local secrets.

Disconnecting commits signed-out Cloud and empty social state together with a durable local
teardown. It moves the rotating refresh token into the private teardown record, closes the live
Murmur client, and uses a negotiated session to remove this installation's device from the relay.
The unregister budget is three attempts and survives daemon restarts. Success or exhaustion then
atomically deletes the token, root, H1 backup, vault identity, and complete account-scoped Murmur
store; exhaustion logs that the relay may retain an orphan rather than blocking disconnect forever.
Another Cloud authorization cannot begin until cleanup finishes. A retained identity recognized as
using the obsolete direct-root derivation, or an old teardown record without a session credential,
skips relay removal and deletes its unusable local state. Erasing the whole local instance without
invoking disconnect cannot contact the relay, so its roster device remains until a restored sibling
device removes it.

The opt-in `pnpm --filter @slopus/happy-agent-modules test:live:workos-staging` suite creates
temporary staging WorkOS users and exercises real Happy Cloud and Murmur deployments. Put
`{ "workosApiKey": "..." }` in the repository's ignored `.context/workos-staging.json`, or set
`HAPPY_AGENT_WORKOS_STAGING_CREDENTIALS_FILE` to another JSON file path. The key itself must never be
placed in an environment variable. The suite covers binary account-storage round trips and
conditional writes, self-removal, sibling removal of an orphaned installation, lost-key vault
reset, and a four-device Murmur group spanning two WorkOS users with messages sent in both
directions to every other active device.

Cloud is independent from `HappyModule`, which connects the daemon to the Happy mobile app.

The module exposes the account-scoped Happy Cloud binary store directly through `readValue` and
`writeValue`. Reads return the opaque bytes with their SHA-256 and Cloud UUIDv7 version, or
`undefined` when the key is absent. Writes are unconditional by default and may instead require an
empty key or the exact current SHA-256. A lost conditional write raises `CloudStorageConflictError`
with the metadata Happy Cloud observed. Keys follow Cloud's well-formed 1,024-byte UTF-8 bound,
values are bounded to 100 MiB at the client boundary, and every response must carry matching ETag
and version metadata. Storage operations use the same rotating WorkOS credential boundary as the
rest of Cloud and are never retried after an ambiguous write.

Standalone deployments also expose the connected WorkOS user's Happy Cloud organizations through
the same serialized refresh-and-verify boundary. Listing returns only the bounded organization ID
and name. Creation makes the connected user an administrator, while deletion relies on Happy Cloud
to require that active administrator role. Organization changes are remote control-plane
operations: they are not persisted locally, emit no organization event, and are never replayed
after an ambiguous response. The API rejects this surface before authentication refresh or body
parsing in team mode because that deployment's organization is externally owned configuration.

Friends activate automatically after enrollment. The module retains one account-scoped social
snapshot, opens Happy Cloud's authenticated updates WebSocket, and uses its announced version to
drive Durable Function reconciliation of friends, requests, blocked users, and public profiles.
Reconnects and transient failures preserve the last synchronized lists as connecting state; losing
enrollment or disconnecting clears them before another account can be used.
