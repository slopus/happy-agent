# Team — learnings

## Sender profiles are notifications at consumption, not message prefixes

The model could not see which team member was speaking even though messages retained their
authenticated user IDs. Team now inserts a separate system notification before each actual
sender transition, including transitions inside queued and steering batches. It includes the
Happy user ID, full name, and nullable email, explicitly as descriptive data rather than authority.
WorkOS IDs, ownership, and photos stay out of model context. User content and public history are
unchanged; only positively human-authored messages select a sender, never client metadata or
agent-generated messages. Missing or unresolved human authorship clears the previous profile.

The current identity lives in agent KV; the last announced text lives in history KV. Notifications
and these writes commit together through Base's transactional notification hook. This prevents
partial delivery and redundant notices after retries or restart, restores the profile after history
replacement, and refreshes name/email changes before inference without waking an idle agent.
Photo-only or version-only updates do not repeat unchanged profile text.
Standalone Team instances expose no startup hook: the runtime installs the standalone Profile
module instead, so a disabled Team must not advertise agent runtime behavior.

## Public user lookup is bounded display information

Message authors use installation-local Happy IDs, not WorkOS IDs. Batch lookup accepts at most
100 IDs, preserves first-requested order, omits unknown and duplicate IDs, and reads only matching
rows in the caller's transaction. An empty batch never lists the directory. The authenticated team
API returns names and photo placeholders with profile versions, but excludes email, WorkOS
identity, and owner flags. Profile invalidations let clients refresh these display records.

## Team users project through the existing profile interaction

The standalone profile is one installation-owned person and may initialize itself on first use.
Team mode keeps the same current-profile HTTP shape but stores one durable user row per WorkOS
identity. The combined wire `name` is split into first name and optional last name only at this
storage boundary. Startup never manufactures a user; the first non-null profile name creates it,
and only the configured WorkOS owner identity receives the owner flag.

## Enterprise JWT authentication is a second team method, not a separate mode

Enterprises need to sign members in through their own identity provider. Team mode now selects
one method: WorkOS, or JWTs issued by a deployer's web app and verified locally with a JWKS URL,
a PEM public key, or a shared secret from the environment. Key sources pin their algorithm family
so a public key can never be used as an HMAC secret, and `none` is never accepted. The user ID
comes from a configured claim.

Identities are the pair of method and user ID, because a deployer's user IDs can look like WorkOS
IDs. Users were rebuilt around that pair in a new migration. The photo table is renamed first, so
dropping the old users table cannot cascade into copied photos. Everything else — onboarding,
owner flag, drafts, sender notifications — is shared by both methods.

Clients discover sign-in through the unauthenticated `GET /v0/authentication` and the
`authentication` field on every `401`. The first design had the deployer's page redirect the JWT
itself back in a URL fragment, like the old OAuth implicit flow. That exposes the token to any app
that claims the redirect scheme and cannot be refreshed, so it was replaced before any daemon
shipped it: the advertised `oauth` method is the standard authorization code flow with PKCE, plus
an optional refresh endpoint that may live on another origin.

The daemon is treated as untrusted with sign-in credentials. It only advertises endpoints from
machine configuration and verifies access tokens; the app talks to the authorization server
directly, so codes, PKCE verifiers, and refresh tokens never reach the daemon. The client refreshes
only at the refresh URL recorded at sign-in, never one a daemon advertises later. Discovery ignores
query strings, so it cannot be used to reflect attacker-chosen redirects. A per-deployment audience
stops a daemon from replaying a member's token elsewhere; a shared secret lets the daemon mint
tokens, so asymmetric keys are the recommendation.

## The daemon owns its JWKS download

Deployers should not have to paste public keys into configuration or restart the daemon to rotate
them. `jose`'s remote key set fetched only lazily, on its own fixed cache schedule. `RefreshingJwks`
now downloads the key set when the agent system starts and on a configurable interval, from a
named daemon-owned context that shutdown stops. A token with an unknown key triggers one
rate-limited download, so rotations apply at once without letting junk tokens hammer the issuer.
A failed download keeps the last good set and retries after a minute; a successful one replaces
the set, so removing a key from the JWKS revokes it. Downloads are bounded in time, size, and key
count, and never follow redirects.

## WorkOS organization membership grants access before onboarding

A token must have a valid signature, the configured WorkOS client and issuer, and the deployment's
exact organization claim. A matching organization member may reach the small profile-onboarding
surface before a local user exists; all other product routes require that durable user. Signature
and claim verification happen locally after the WorkOS JWKS has been retrieved and cached.

Installation onboarding and user onboarding are separate internal states, presented through one
client-facing flow. A shared installation completion marker does not complete a member whose
local profile is absent. Personal readiness comes from that member's saved profile; neither the
owner's profile nor a Happy Cloud identity substitutes for it. Once installation setup is complete,
saving the member's profile is enough for the combined onboarding state to become complete.

## Shared profile events are identity-only

Team profile updates are visible to every connected organization member through the server-wide
event journal. Their payload carries only the changed Happy Agent user ID, never another member's
name, email, or photo metadata.

## Composer drafts belong to their author

Keeping private drafts inside the API prevented a member's Happy connection from sharing the same
storage. Team now owns drafts keyed by agent and user; the API and each personal Happy connection
use that seam. Draft updates publish only after commit and must be delivered only to the author.
The storage move copies existing rows atomically so unsent text and clear timestamps survive.
