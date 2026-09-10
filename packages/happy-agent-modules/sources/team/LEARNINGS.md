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
