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
enrollment and durably retries profile and vault reads; an unknown public identity always requires
restoration. A connected installation then creates a new authenticated encrypted vault bundle or
restores the existing one. Create and restore are Durable Functions too, but their encryption and
authentication factors stay only in process memory: the HTTP request waits through transient
network failures, while a daemon restart safely requires the factors to be entered again. The
owner-only root derives the public identity key, and a durable profile sync publishes it after keys
become ready.

Enrolled accounts with ready keys start `@slopus/murmur` against the fixed relay for the selected
deployment. Murmur owns a durable device identity in an account-scoped Cloud store, so opening the
client registers the device once and later daemon starts reuse it. Relay registration and
synchronization retry independently without changing Cloud authentication status.

Cloud is independent from `HappyModule`, which connects the daemon to the Happy mobile app.

Friends activate automatically after enrollment. The module retains one account-scoped social
snapshot, opens Happy Cloud's authenticated updates WebSocket, and uses its announced version to
drive Durable Function reconciliation of friends, requests, blocked users, and public profiles.
Reconnects and transient failures preserve the last synchronized lists as connecting state; losing
enrollment or disconnecting clears them before another account can be used.
