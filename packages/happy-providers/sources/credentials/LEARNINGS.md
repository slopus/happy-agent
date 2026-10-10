# Native credential learnings

Grok's stored API key precedes its stored OAuth session. The first native loader
selected the session first and could charge a different account. Discovery now
uses the shipped credential order; a deterministic two-record fixture verifies
the actual authorization header.

Codex ChatGPT logins refresh the way Codex itself recovers. The first native port
refreshed under an in-memory mutex only, compared parsed JSON instead of the file's
bytes, staged with a name the original never used, ignored the endpoint and client
overrides, and spent a refresh inside the retry budget. Now an unauthorized request
re-reads the file once and then refreshes once, each replayed outside the budget.
Every refresh takes the cross-process lock beside the file's resolved path, so
instances and aliases share one rotation; re-reads under the lock and adopts a token
already rotated on disk; refuses another account's login and never recreates a
deleted file; checks the stored login and the token response against captured
schemas; and writes only if the file's bytes are unchanged after the exchange,
through the original's `<file>.<pid>.<uuid>.tmp` staging with owner-only access.
