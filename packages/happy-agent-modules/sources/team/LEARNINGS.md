# Team — learnings

## Team users project through the existing profile interaction

The standalone profile is one installation-owned person and may initialize itself on first use.
Team mode keeps the same current-profile HTTP shape but stores one durable user row per WorkOS
identity. The combined wire `name` is split into first name and optional last name only at this
storage boundary. Startup never manufactures a user; the first non-null profile name creates it,
and only the configured WorkOS owner identity receives the owner flag.

## WorkOS organization membership grants access before onboarding

A token must have a valid signature, the configured WorkOS client and issuer, and the deployment's
exact organization claim. A matching organization member may reach the small profile-onboarding
surface before a local user exists; all other product routes require that durable user. Signature
and claim verification happen locally after the WorkOS JWKS has been retrieved and cached.

## Shared profile events are identity-only

Team profile updates are visible to every connected organization member through the server-wide
event journal. Their payload carries only the changed Happy Agent user ID, never another member's
name, email, or photo metadata.
