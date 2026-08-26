# Cloud

`CloudModule` is Happy Agent's local Happy Cloud token broker. It owns the WorkOS public-client
PKCE flow, stores the rotating refresh token in the owner-only main database, verifies every minted
access token through Happy Cloud's `/v0/hello`, and publishes token-free versioned status snapshots.
Authorization expiry is carried by Durable Functions, so the pending-state transition and its
expiry intent commit together and unfinished expiry work survives daemon restarts.

Cloud is independent from `HappyModule`, which connects the daemon to the Happy mobile app.
