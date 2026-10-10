# Cloud owner learnings

Cloud owns authorization, verified tokens, organizations, endpoints, and invitations. Its public snapshot carries only the original status, environment, user, authorization, error, version, and update time. Preserve the original eight migration keys and effects; the final migration retires account features without changing local profile data or discarding a connected session.

The native HTTP boundary uses the WorkOS public-client wire format and Config-owned deployments. It has a total 15-second deadline, bounded response bodies, no automatic retries, and no ambient API key or client secret. A consumed authorization code or rotating refresh token must never be replayed after an ambiguous request.

Credential use is globally serialized. An already-dispatched exchange or refresh belongs to Cloud's lifetime, even if its caller disappears. Save each replacement refresh token before checking identity, Cloud verification, or JWT claims. A verification failure keeps that replacement and the connected public snapshot. Only WorkOS's authoritative OAuth credential rejection disconnects an existing session.

Local sign-out participates in its caller's transaction. Snapshot changes, cache invalidation, durable cancellation, and notifications become visible after commit; rollback preserves all four. Version and expected-token fences prevent a concurrent owned workflow from reviving a signed-out account. Activate the public snapshot before publishing its event.

Public mint and organization operations carry the caller's mutation echo as an immutable value
through their owned authentication workflow. A verified profile change or authoritative credential
rejection emits `cloud.updated` with that echo. Concurrent requests never share mutable request
metadata, and background refreshes carry no caller echo.

PKCE verifiers stay in memory. Invalid callbacks leave the attempt active, while a valid callback is consumed before HTTP. Durable pending state cannot restore a verifier; restart projects it as expired and the original expiry function settles it. The hourly function checkpoints its next deadline before WorkOS, so restart waits for the next scheduled attempt.

Organization credentials are ephemeral and limited to 100 entries. Concurrent callers share one refresh. A valid cached token bypasses the credential lock, including during background renewal; failed renewal preserves it until its real expiry and briefly backs off. Never evict pending work or repopulate a cache invalidated by a committed account change. One cancelled waiter cannot cancel other waiters, and work whose waiters all cancelled stops before consuming a credential.

Short-lived credentials require both total and remaining WorkOS lifetime of at most five minutes, after rotation, Cloud verification, and matching identity claims. Withholding a long token must still retain its rotated refresh token. Team creation uses one verified access token for creation and endpoint setup; an endpoint failure names the created team and never deletes or recreates it. Remote team endpoints must already equal their normalized URL: their TypeBox syntax alone does not prove the Source projection contract.
