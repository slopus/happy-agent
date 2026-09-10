# Cloud

`CloudModule` owns only WorkOS authentication and Happy Cloud organization (team) management.
It is independent from `HappyModule`, which connects the daemon to the Happy mobile app.

Authentication uses the WorkOS public-client PKCE flow for Happy's fixed production or staging
deployment. The exact application redirect URI is bound to the process-local authorization
attempt. Only the pending marker and its authorization-expiry Durable Function are persisted;
a restart expires the attempt because its PKCE verifier is gone.

The module stores the rotating refresh token in the owner-only main database. Minting serializes
refreshes, commits the replacement token immediately, and then verifies the access token through
Happy Cloud's `/v0/hello` before returning it. An unavailable verifier preserves the connected
session; only WorkOS's definitive refresh rejection clears it. Status, bootstrap, and update
events contain the token-free Cloud snapshot: status, environment, user, authorization, error,
version, and update time.

Disconnect is a local transaction that removes the session and refresh token, cancels pending
authorization expiry, and publishes the disconnected snapshot after commit. It composes with the
caller's transaction, requires no network or background cleanup, and permits immediate subsequent
authorization. A clean sign-out is idempotent. Cloud has no other Durable Functions or background
connections. Historical database migrations remain immutable; the final scope-reduction migration
removes retired account data while retaining connected WorkOS sessions and version high-water marks.

Standalone deployments expose `listOrganizations`, `createOrganization`, and `deleteOrganization`
through the same serialized refresh-and-verify boundary. Public organization objects contain only
bounded IDs and names. Changes are remote operations with no local mirror or organization event,
and ambiguous writes are not retried. The API rejects organization routes in team mode before
body parsing or authentication refresh because its organization is deployment-owned configuration.

`HappyTeamsModule` uses the internal `listTeams`, `createTeam`, and `setTeamEndpoint` projection,
which additionally carries the organization's advertised endpoint. Endpoints accept normalized
HTTP, HTTPS, Tailcat, WS, or WSS URLs. Creation validates the endpoint first and uses one minted
credential for both remote writes. If endpoint configuration fails after creation, the error
names the created team so the caller can finish setup without creating a duplicate.

`ConnectionsModule` uses `mintForOrganization` for organization-scoped WorkOS credentials.
`getWorkOSState` returns only the freshly verified WorkOS user ID and the connected deployment's
client ID; authorization of that agent-facing lookup belongs to its consumer. Cloud exposes no
team quota or inferred capacity; the team list is the available team data.

`HappyTeamsModule` also uses `inviteTeamMember` to send one email-addressed member invitation through
`POST /v0/organizations/:id/invitations`. This stays an internal module operation, not a new public
Happy Agent route. Cloud validates the inputs before minting, uses the existing serialized credential
rotation, and never retries the remote mutation. The result carries a recipient-sensitive acceptance
link; neither that link nor invitation state is added to status, bootstrap, or Cloud events.

The opt-in `pnpm --filter @slopus/happy-agent-modules test:live:workos-staging` suite creates a
temporary staging WorkOS user and exercises verified token minting, organization management,
team endpoints, organization-scoped minting, and local sign-out. Use the registered
`workosstaging` secret for live execution. Its existing credential-file input is an ignored JSON
file selected by `HAPPY_AGENT_WORKOS_STAGING_CREDENTIALS_FILE` (default
`.context/workos-staging.json`), containing `workosApiKey`; credentials must never be committed.
