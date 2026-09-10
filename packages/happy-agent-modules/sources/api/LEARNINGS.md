# API module learnings

## Cloud is authentication and organizations only

Cloud previously exposed encryption setup, account enrollment, profiles, social state, and device
management. The API now exposes only WorkOS authentication and organizations. Retired routes return
not found; desktop bootstrap and the journal carry only the authentication snapshot, and Cloud
errors include only that snapshot. Keep the separate local profile and Happy integration surfaces
independent of Cloud account state.

## Input requests and generated calls retain distinct identities

Send accepts the published tool-request block schema, with at most one request among the text
and image blocks. Pending responses, bootstrap, acceptance, and history retain that block exactly.
Acceptance is still carried by the run event, not an extra user-message update.

Release 0.4.45 expressed "at most one request" as one array with `contains`, `minContains: 0`,
and `maxContains: 1`. TypeBox's value check refuses any `contains` array with zero matches
before it reads `minContains`, so every plain text or image `content` array was rejected with a
400 and images stopped working. Only text-only sends, which omit `content`, survived. The send
content schema is now a union of two arrays: text and image blocks alone, or text, image, and
exactly one request. Any schema test for an "at most one" rule must cover the zero case.

A requested call has no inference-start event. Publish its completed acceptance-time assistant
row on tool start and its updated row on completion, using History's call-owned message identity.
Never project it under a synthetic run-level assistant ID: that makes live clients disagree with
reload and leaves the real call without a creation event.

## Protocol revisions identify new capabilities without removing older requests

Unnamed bot creation was added without a distinct advertised revision, leaving clients
unable to know whether omitting a name was supported. The daemon now advertises protocol
24 for that capability. Older name-bearing requests remain valid; clients that omit the
name require protocol 24 or newer. Protocol 22 onward remains additive, so a client must
not reject an otherwise compatible daemon merely because its revision differs. A product
that requires a newer capability may require that capability's protocol and explain the
needed upgrade. The daemon's product version remains display and diagnostic information.

## Local signals and HTTP share one drain boundary

Draining only the agent runtime leaves API mutations admitted and can falsely report that an
installation is safe to maintain. Local OS control now calls the API module's public `beginDrain`
and reads its bounded `drainProgress`, the same operations used by authenticated HTTP. This keeps
the read-only transition, event identity, admitted-mutation count, and agent/reviewer completion
barrier identical without creating an unauthenticated HTTP route. Draining remains separate from
shutdown and does not claim that terminals or background processes have exited.

## Composer mode

- A null `mode.serviceTier` must reach Agent Base as an explicit `null`, never as an omission and
  never as a sentinel tier string. Agent Base persists the last tier and reads an omitted message
  option as "keep the previous tier", so omission leaves a stale tier in force — including the
  retired `"default"` sentinel written by earlier releases, which Codex rejects on every turn and
  which nothing else ever clears. The same rule applies to every sibling send path that stamps a
  mode on a message: the tier the mode claims is the tier the message must carry.

## System bot identity

- Every public bot projection includes the database-backed `systemKey`: a stable snake_case key for
  a built-in bot and `null` for an ordinary bot. The one shared projection feeds reads, mutations,
  conflicts, bootstrap, and events, so this discriminator must stay there rather than being added
  route by route. Client schemas keep the field optional only for older compatible daemons and
  tolerate unknown keys so newer built-ins retain ordinary bot behavior in older UIs.
