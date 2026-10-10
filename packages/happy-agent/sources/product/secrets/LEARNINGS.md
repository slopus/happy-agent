# Secrets

The catalog belongs to the installation. Its storage owner is `global`; the agent that creates a
reference does not partition discovery. Grants retain their own immutable identities and typed
project, workspace, or exact-agent targets. Commands use the durable scope supplied by Compute:
project grants reach its workspaces, while workspace and agent grants remain exact.

Secret access and sandbox elevation are independent permission decisions. Attach and detach always
request Auto review while keeping the catalog mutation sandboxed. Create and update also require
review; inline values remain in the tool transcript, while an absolute dotenv source requests Full
access for that one host-file read. A replacement removes variables omitted from the source. Those
two tools remain non-durable because replay must never read a changed file.

Command resolution hides every attached variable name from the inherited environment, including
unselected and unavailable bundles. Only explicitly selected bundles supply values. Case-insensitive
collisions across selected bundles fail rather than choosing a winner. Omitted command selections
must be passed as an empty array.

All public responses, conflicts, events, and tool results contain safe metadata. A value-only
rotation still changes the durable UUIDv7 version and update timestamp. A true no-op changes
neither. SQL and dotenv errors never include stored values. Managed retirement requires the exact
owning kind and removes the record and both legacy and typed grants atomically.

The three original storage migrations retain their names and effects. Procedural version
backfills read only bounded pages of identities and participate in the same transaction as their
migration ledger. Ordinary catalog operations compose with the caller's transaction; grant tools
use the generic transactional execution hook so mutation and retained tool result commit together.
