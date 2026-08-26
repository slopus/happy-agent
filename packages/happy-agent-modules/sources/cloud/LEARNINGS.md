# Cloud module learnings

## Authentication ownership

- Cloud is separate from the Happy mobile integration. `CloudModule` owns WorkOS authentication,
  the rotating refresh token, Happy Cloud verification, and its complete public snapshot.
- PKCE verifiers and authorization callbacks are process-local secrets. A pending-attempt marker is
  durable only so a daemon restart can settle the public state as expired.
- Redirect URIs are application-owned because multiple clients may authenticate. Bind the exact URI
  to the pending attempt and require the callback's scheme, authority, and path to match it. Allow
  HTTPS, loopback HTTP, and application-specific URI schemes; reject remote plain HTTP and builtin
  schemes that can execute or directly expose local content.

## Rotation and revocation

- Serialize start, complete, expiry, disconnect, and minting through one lock. A callback is consumed
  once, replaced attempts reject old callbacks, and completed disconnects cannot be undone by late
  work.
- WorkOS refresh tokens rotate. Persist the replacement immediately after refresh and before calling
  Happy Cloud; a transient verification failure must never strand the session on the consumed token.
- Clear credentials only when WorkOS explicitly rejects refresh with `invalid_grant`. Happy Cloud's
  current `/v0/hello` maps verifier infrastructure failures to `401`, so any hello failure is
  unavailable rather than authoritative revocation.
- A successful hello naming a different user is distinct from an unavailable or rejected hello.
  It rejects a new login before credentials are stored; during refresh it still preserves the
  rotated token and connected snapshot while withholding the access token.
- WorkOS runs with a short timeout and no automatic retries. Retrying an ambiguous rotating-token
  request can consume the same credential twice. Its response body is subject to the same total
  deadline and a byte limit, including after response headers arrive.
- WorkOS Node 10.10's `createWorkOS` public factory constructs the environment-aware base class:
  it ignores `fetchFn` and may inherit `WORKOS_API_KEY`. Use a small Node SDK subclass that clears
  the ambient key before HTTP construction and preserves the SDK's fetch override, and test the
  full refresh path with a synthetic ambient key rather than testing the wrapper in isolation.
- Activate attempts, snapshots, timers, and update notifications only after their corresponding
  database transaction commits. A callback itself becomes process-locally consumed before its
  one-time code is exchanged so a write failure cannot make that code replayable.
- WorkOS exchanges and refresh rotations are independently owned Cloud workflows. Run them on the
  module's named database context and commit credential changes immediately; an outer caller
  transaction cannot safely roll back a one-time external credential. Preflight the owner database
  before contacting WorkOS so an accidental ambient transaction is rejected before consumption.
- Treat an explicit `access_denied` callback as user rejection. OAuth service and client failures
  are temporary unavailability and must not be presented as a user denial.
- Authorization expiry is a Durable Function created in the same transaction as the pending Cloud
  state. It waits again after clock rollback, retries failed expiry persistence with a bounded
  delay, and is cancelled transactionally when the attempt settles or is replaced. Recovery expires
  it immediately because the process-local PKCE verifier no longer exists after restart.

## Secret boundaries

- Refresh tokens live only in the owner-only database. Access tokens appear only in a successful
  mint response. Neither token, PKCE verifier, callback URL, raw WorkOS error, nor hello body belongs
  in status, events, bootstrap, or logs.
- Authentication failures log only the operation, deployment, phase, bounded reason, and safe HTTP
  status. This distinguishes WorkOS exchange failures from Happy Cloud verification failures while
  keeping OAuth codes, tokens, provider errors, and response bodies out of every log.
- Database adapters may copy SQL parameters into thrown errors. Storage replaces write failures at
  the database boundary so a serialized refresh token cannot reach generic API logging.
- Durable errors use an exact private schema and public projection. API schemas are intentionally
  permissive for compatibility and must not be reused as the storage validation boundary.

## Cloud profiles

- Happy Agent's local human profile is the display-name authority. Enrollment asks only for a
  Cloud username, sends the complete local name as `firstName`, and never derives display text from
  WorkOS metadata. Happy Cloud remains authoritative for username ownership and normalization.
- Store enrollment beside the connected account as the Cloud username plus the local profile
  version last synchronized. Disconnecting or changing accounts therefore clears enrollment while
  refresh-token rotation preserves it.
- Profile reads and writes refresh a rotating WorkOS token, verify it through Cloud hello, and call
  the fixed deployment while holding Cloud's serialization lock. The access token never crosses
  the profile API.
- Validate the username and local display name before refresh, strip the local mutation echo from
  the upstream body, and parse every Cloud response with a bounded schema. A current username
  conflict is distinct; upstream profile validation after local acceptance is service-contract
  drift, not a user error.
- Persist refresh-token rotation before downstream verification. A failed profile write may change
  only that private token: defer public WorkOS metadata updates so a rejected mutation emits no
  public state event.
- Profile changes and startup reconciliation are Durable Functions. Each execution first reads the
  online profile to repair the local username or clear stale enrollment, never overwrites the local
  human profile, then pushes the latest compatible local name back with the online username.
  Transient authentication or Cloud failures retry inside the executor; account changes terminate
  stale work safely.
- CloudModule owns the successful remote profile-change signal so every caller gets the same
  behavior; the API translates it into `cloud.profile.updated` as a compact invalidation.

## Cloud friends

- Friends activate from persisted profile enrollment; there is no second feature toggle. Keep the
  socket closed while disconnected or unenrolled, wake it after enrollment commits, and clear all
  retained social profiles atomically when the account or online enrollment disappears.
- Happy Cloud's updates socket authenticates with the short-lived WorkOS bearer token but does not
  replay missed events. Send the token in the WebSocket authorization header rather than its URL,
  open the socket before snapshotting, and treat its state version as the convergence boundary.
- Persist friends, incoming requests, outgoing requests, blocked users, hydrated public profiles,
  and the private Happy Cloud state version together. Expose a separate local UUIDv7 version so
  connection changes and list replacements produce a coherent daemon resource and compact event.
- Socket frames only trigger work. Full reconciliation is a Durable Function keyed by the announced
  remote version; it fetches all three lists at one shared version, hydrates their public profiles
  under one total deadline, and commits one atomic replacement. Reconnects with an unchanged remote
  version can reuse the durable cache immediately.
- Happy Cloud broadcasts profile changes to friends, but not necessarily to pending-request or
  blocked-list peers. While the socket is open, periodically invoke the same bounded durable full
  reconciliation so those retained public profiles cannot remain stale forever.
- Happy Cloud currently supports send, approve, reject, revoke, block, and unblock. It has no direct
  remove-friend route; do not emulate one locally. Blocking is the only current upstream operation
  that removes a friendship.
- Social mutations use the same serialized refresh-and-verify boundary as profile work, then read an
  authoritative post-mutation snapshot. Missing targets, blocked requests, missing enrollment, and
  transient service failures remain distinct display-safe errors; an ambiguous successful remote
  mutation relies on the socket-triggered durable reconciliation to converge afterward.
