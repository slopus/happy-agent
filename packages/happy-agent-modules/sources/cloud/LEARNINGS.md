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
- An authorization timer can fire early after clock rollback, and its expiry write can fail. Rearm
  early timers for the true deadline and retry failed expiry persistence with a bounded delay so a
  process-local attempt cannot remain authorizing forever.

## Secret boundaries

- Refresh tokens live only in the owner-only database. Access tokens appear only in a successful
  mint response. Neither token, PKCE verifier, callback URL, raw WorkOS error, nor hello body belongs
  in status, events, bootstrap, or logs.
- Database adapters may copy SQL parameters into thrown errors. Storage replaces write failures at
  the database boundary so a serialized refresh token cannot reach generic API logging.
- Durable errors use an exact private schema and public projection. API schemas are intentionally
  permissive for compatibility and must not be reused as the storage validation boundary.
