# Profile ownership

The existing standalone profile owns one stable private identity and one bounded photo. HTTP exposes only the documented name, email, photo placeholder, version, update time, and null user ID. First access may create an empty singleton without a change event.

Machine configuration fills missing name and email fields atomically on startup, preserving existing edits, identity, and photo. Team deployments never bootstrap a shared person. The local-profile tool appears only for an active admin root bot and rechecks that authority when it executes.

Each saved mutation advances the stored UUIDv7 high-water mark, including across restart and clock rollback. Changes and their notifications share the caller's transaction. Photo removal when already absent does not advance the version. Photos validate their declared type, orient and bound the decoded pixels, encode WebP at quality 82 within 512 pixels, and derive the hash and ThumbHash from the actual retained image.
