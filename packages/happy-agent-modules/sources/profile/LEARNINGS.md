# Profile — learnings

## Remote bootstrap uses config records, not a profile API

Requiring a fresh profile-creation step on a personal remote duplicated information already known
locally. The profile module now takes config and bots as dependencies. On startup, machine
`[profile]` name/email records fill only missing fields in the remote's own singleton, atomically
with the caller's transaction and notifications after commit. Existing identity, photo, and edited
fields survive restarts. This satisfies profile onboarding without bypassing its requirements or
using HTTP to initialize the profile. Team deployments never bootstrap a shared profile.

`get_local_profile` reads only name/email for deployment, without materializing an empty singleton.
Only an active admin bot running as a root agent receives it, and execution rechecks that authority
so archival or demotion revokes even an already-selected tool. Missing fields remain explicit nulls.

## Photo processing follows the runtime

Profile photos keep one contract across runtimes: oriented, bounded WebP bytes and a ThumbHash.
Node implements it with Sharp; the standalone Bun executable implements it with `Bun.Image`.
Because Bun does not expose decoded pixels, only its own bounded, non-palette PNG thumbnail is
decoded to RGBA for ThumbHash generation; uploaded image bytes never enter that narrow decoder.
