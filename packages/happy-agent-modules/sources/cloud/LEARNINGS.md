# Cloud module learnings

## Scope and ownership

- Cloud's former account-feature bundle obscured its authentication boundary. Cloud now owns only
  WorkOS authorization, verified token minting, organizations, and team endpoints. It is independent
  from the local human profile and from the Happy mobile integration. The public snapshot contains
  only status, environment, user, authorization, error, version, and update time.
- Existing migration keys, ordering, and SQL are immutable. Scope reduction appends one migration
  that removes retired account data without discarding a connected WorkOS session or its durable
  version high-water mark. Do not reinterpret old state through runtime repair.

## Authorization lifecycle

- PKCE verifiers and callback URLs are process-local secrets. A durable pending marker exists only
  so restart can settle the public attempt as expired. Authorization expiry is Cloud's sole Durable
  Function, committed with the pending state and cancelled transactionally when the attempt settles.
  It waits again after clock rollback and retries failed expiry persistence with a bounded delay.
- Redirect URIs are application-owned. Bind the exact URI to the attempt and require the callback's
  scheme, authority, and path to match. Permit HTTPS, loopback HTTP, and application-specific schemes;
  reject remote plain HTTP and built-in schemes that execute or expose local content.
- Serialize authorization, expiry, sign-out, and credential use through one lock. Invalid callbacks
  leave the valid attempt active. Consume a valid callback process-locally before exchanging its
  one-time code so a persistence failure cannot replay it. Only explicit `access_denied` means user
  rejection; OAuth service or client failures mean temporary unavailability.
- Activate snapshots, attempts, and notifications only after commit. Sign-out is entirely local:
  it composes with the caller's transaction, cancels authorization expiry, clears the stored session,
  and publishes after commit. Rollback preserves both credentials and the public snapshot. No remote
  action or background cleanup can delay the next authorization.

## Rotation and verification

- Refresh tokens rotate. Persist the replacement immediately after refresh and before `/v0/hello`.
  Clear credentials only on WorkOS `invalid_grant`; hello failures are unavailable, because even its
  `401` may indicate verifier infrastructure trouble rather than revoked credentials.
- Hello projects only its required message and user ID and tolerates additive metadata. A different
  verified user rejects a new login before storage. During refresh, an identity mismatch preserves
  the rotated token and connected snapshot but never releases the access token.
- WorkOS requests have a short timeout, a body-size limit, and no automatic retries. The body shares
  the total deadline after headers arrive. Replaying an ambiguous exchange or refresh can consume a
  one-time credential twice.
- WorkOS Node 10.10's public factory ignores the fetch override and may inherit `WORKOS_API_KEY`.
  Use the small SDK subclass that clears the ambient key before HTTP construction and preserves the
  override; test the actual refresh path with a synthetic ambient key.
- Exchanges and rotations are independently owned Cloud workflows on the module's named database
  context. Preflight that database before contacting WorkOS and immediately commit credential
  changes; a caller transaction cannot safely roll back a consumed external credential.

## Secret boundaries

- Refresh tokens stay in the owner-only database. Access tokens appear only in successful mint
  responses or internal credential consumers. Neither token, verifier, callback URL, raw WorkOS
  error, nor hello body belongs in status, events, bootstrap, or logs.
- Log only the operation, deployment, phase, bounded reason, and safe HTTP status. Database adapters
  can copy SQL parameters into errors, so replace persistence failures at the database boundary.
  Durable state uses an exact private TypeBox schema, not permissive public API schemas.

## Organizations and teams

- Organization operations use the connected human identity and the same serialized refresh and
  verification boundary. Project only bounded IDs and names publicly. Remote mutations have no
  local mirror or organization event; never retry an ambiguous create, delete, or endpoint write.
  Preserve upstream administrator rejection as a display-safe forbidden result.
- Internal team projections additionally validate nullable endpoints. Team creation validates its
  required endpoint before writing and uses one credential for both writes. Those writes are not
  atomic: a partial failure must name the created team and direct the caller to update it.
- Organization-scoped minting preserves the connected human identity. Cancelled checks waiting for
  the credential lock stop before consuming a token; an exchange already in flight completes its
  credential-persistence boundary. Roster and health tools never return credentials.
- WorkOS state lookup returns the verified user ID and actual connected deployment's client ID,
  never tokens. Agent-facing authorization belongs to the consuming module. Do not invent a team
  quota when Happy Cloud provides only the team list.
- Reject every organization route in team mode before parsing bodies, refreshing credentials, or
  contacting Happy Cloud. Keep this deployment policy at the API seam, outside CloudModule.
