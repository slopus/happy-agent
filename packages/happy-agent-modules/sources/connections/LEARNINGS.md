# Remote connection learnings

## Upstream responses own their caching policy

The remote HTTP proxy replaced every upstream cache policy with no-store, defeating browser
caching even when a remote image explicitly allowed it. Forward upstream end-to-end headers
unchanged, including cache directives, validators, freshness metadata, and Vary. Once an upstream
response arrives, remove the local API's default Cache-Control before forwarding it so an absent
upstream policy also stays absent. Locally generated failures retain the API's no-store policy;
hop-by-hop headers are still stripped.

## Display order is required, durable public state

Sorting connections by ID prevented user reordering and inserted new connections into the middle
of the roster. Every connection now has a required fractional `orderKey`, backfilled by a new
migration for existing snapshots. New and re-enabled connections append after the surviving
user-chosen order. Renames and credential changes retain keys. Reordering uses the roster version
for concurrency, changes only the moved key, and publishes the complete snapshot after commit
without touching transports. A conflict returns the persisted roster, never a reconciliation
version that the rejected operation would roll back.

## Display names do not own transport lifetimes

Renaming a remote used to close its HTTP pool, active requests, and outbound Tailcat process.
Both live settings updates and durable reconciliation now exclude only the display name when
comparing connection settings. Renames persist and publish the versioned public roster while
keeping the existing pool and carrier alive. Endpoint or authentication changes and removal still
close the old connection. Each configured remote retains its own on-demand Tailcat process; this
does not introduce a shared multi-destination carrier. Tailcat replaces a failed carrier for
subsequent requests without changing the roster or replaying interrupted HTTP requests.

## Managed nodes use Tailcat and application tokens

The former invitation and emoji-verification design is not the managed-secondary workflow.
Tailcat carries encrypted bytes; team deployments authenticate WorkOS organization tokens and
standalone secondaries authenticate a fixed machine-configured bearer token. Admin bots configure
the main daemon's roster, and clients instantiate a separate client/reducer through its proxy.
Remote agent ancestry and event journals are never merged into local ones.

## Team access preserves the requesting identity

A standalone main mints a WorkOS token for its connected Cloud user and the configured destination
organization. A team main forwards its authenticated caller's token, never an owner's cached token.
The destination still verifies membership and requires its own profile onboarding.

## Endpoint health is an admin capability

Endpoint health inspection belongs to the same active-admin-bot tool surface as connection
administration. It must check authority again when executed, use the configured transport and
authentication, bound the check, and return only readiness and safe diagnostics—not credentials or
raw remote response bodies.

## Roster updates carry the complete public snapshot

An empty invalidation would force every client to fetch a list that is already bounded to 100
entries. Connection updates instead carry the complete public roster and its persisted UUIDv7
version. Reads expose that same version so delayed snapshots and duplicate events cannot replace
newer client state. Only public changes advance the version; rotating private credentials or
transport addresses does not. Reconciliation restores the projection from machine configuration
after interruption or offline edits, and notifications are published only after the snapshot commits.
