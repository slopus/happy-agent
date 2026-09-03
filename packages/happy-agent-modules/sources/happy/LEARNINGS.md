# Happy module learnings

## Pairing and public state

- Resolve the Happy CLI home and server URL through `ConfigModule` even before credentials exist. Reading `process.env` directly bypasses daemon-owned environment overrides and can accidentally inspect another installation during hermetic tests.
- Create the server authorization request before publishing QR data. If that initial request fails, keep the prior integration snapshot unchanged and return `happy_unavailable`; a client must never render a QR code that the server did not accept.
- Persist the resolved Happy server in owner-only settings before saving newly authorized credentials. Credentials are scoped to the server that issued them, and the pairing must reconnect to that same server after a restart.
- Publish complete, versioned integration snapshots and deduplicate identical content. Pairing owns its authorization and failure transitions, while the machine connection owns connecting, connected, disconnected, and rejected-credential transitions.
- Persist the integration version high-water mark before publishing a replacement. UUIDv7 comparison is the client reconciliation rule, so ordering must survive daemon restart and system-clock rollback.
- Pairing secrets are process-local, expire after two minutes, and are erased when the attempt settles, is cancelled, is replaced, or the daemon stops. Bound every authorization poll by the remaining lifetime and reject even a valid response that arrives after expiry. Persist credentials only after decrypting and validating the authorized bundle.
- Bound authorization response bytes and every credential-bearing string before validation or decryption. The server is an external input boundary, and a small successful pairing payload must never permit unbounded buffering.
- Serialize pairing, cancel, unlink, re-pair, activation, and credential invalidation. Generation-check work that can finish after cancellation so an obsolete authorization can never restore credentials or publish a later state.
- Coalesce the entire start operation, including configured credential refresh, rather than only QR creation. Attach a rejection observer as soon as a pairing promise crosses into module ownership; cancellation can invalidate it before the lifecycle queue installs the normal settlement handler.
- Happy is optional onboarding-adjacent state. Desktop bootstrap returns it beside onboarding for a polished first-run flow, but it is not an onboarding step and never blocks completion.

## Credential ownership and reconnects

- Check the disable flag before credential adoption. Disabled mode may inspect an already daemon-owned credential to report `configured`, but must not read or copy the external Happy login or create a machine identity.
- Remember a bounded fingerprint of credentials rejected by Happy or explicitly unlinked. Suppress only that exact daemon/external credential across restart, accept a genuinely changed external login, and clear rejection history after successful pairing. Fingerprints are metadata; never persist another copy of the token or encryption key.
- Unlinking owns only this daemon's credential copy and live clients. It must not edit the external Happy CLI installation, and repeated unlink or cancel requests must be no-ops without duplicate events.
- A Socket.IO connection error is not proof that credentials are bad. Abandon that socket and repeat authenticated HTTP machine registration; only an HTTP 401 or 403 invalidates credentials, while other failures remain retryable.
- Explicit retry must reload credentials and retry machine-identity creation instead of reusing a cached configuration that already lacks an identity.

## Session state

- The phone composer has no tier selector and stamps `serviceTier: null` on every message's mode,
  so its sends must carry an explicit `null` service tier option. Omitting the option tells Agent
  Base to keep the previously persisted tier, which contradicts the stamped mode and leaves a stale
  tier — such as the retired `"default"` sentinel Codex rejects — in force forever.
- Account quota and per-turn token usage are different projections. The native Happy app reads plan limits from each session's encrypted `agentState.usageLimits`, so Happy Agent maps the selected provider's latest account snapshot into the legacy open-window shape and republishes attached sessions whenever that snapshot changes. Fable's separate allowance uses Claude's native `seven_day_fable` id so current and older apps can render it without a new machine-metadata contract.

## Tests

- AgentGym must enforce its isolated `HAPPY_HOME_DIR` after merging caller-supplied environment values. A default placed before that merge can be overridden accidentally, causing an API test to import the developer's real Happy credentials and register persistent machines against the production backend. The harness prevents the connection rather than relying on remote teardown.
- Build package `dist` output before running AgentGym because the harness imports package exports, not sibling TypeScript source. A stale build can make a correct source change appear absent at the public boundary.
- Exercise the independent Happy protocol fixture through `HappyAgentClient`: successful authorization and current-agent attachment, concurrent start joining, lifecycle controls, restart ordering, rejection suppression and changed-login recovery, socket-auth revalidation, server affinity, expiry, and disabled isolation are release-risk behavior rather than optional unit coverage.
