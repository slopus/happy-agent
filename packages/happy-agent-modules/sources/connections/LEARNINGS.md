# Remote connection learnings

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
