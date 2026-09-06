# API module learnings

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
