# Compute module learnings

## Codex command output follows the model policy after capture

Codex command sessions request a Codex-only 1 MiB capture ceiling for each compute output stream,
using the same ceiling value as vanilla unified exec without changing the collection limits of
Claude or Grok. `exec_command` and `write_stdin` then apply the smaller of the model-requested
`max_output_tokens` and Codex's 10,000-token model policy. The default request is also 10,000
tokens. A larger request therefore cannot multiply context pressure, while output dropped during
collection or model-facing truncation continues to be disclosed. Every OpenAI model in Happy
Agent's current curated catalog publishes that token policy; this is not a provider-global
assumption for arbitrary future models, whose metadata must be checked when the catalog changes.

## File-edit presentations belong to structured tool results

Every successful built-in file mutation returns the exact bounded `file_diff` presentation in its
structured result. Exact replacements produce delete/add hunks at their actual old and new line
numbers; whole-file writes produce an add or full rewrite; patches preserve context lines and
represent moves as a delete plus an add.

The presentation keeps exact added/deleted totals even when rows are omitted. It retains at most
20 files and 500 diff rows shared across those files, truncates paths and row text to 2,000 Unicode
characters, and reports `omittedFiles` and `omittedLines`. These are product payload bounds, not UI
rendering choices.

History recognizes the validated `presentation` envelope after execution, keeps it in the
call-scoped durable run store, and records it with the transactional tool result. This makes live
and loaded API projections use one persisted value and keeps presentations intact across daemon
restarts without adding tool-name dispatch or extra runtime wiring.

## Read-log serialization follows the database lock

`FileReadLog.record` enters the Agent Database's owned-operation boundary before taking the
per-agent read-log lock. Transactional reads already hold the global database slot when they record
a file, so letting a nontransactional edit take the read-log lock before requesting that slot
creates the opposite order and can deadlock every queued database route. The database-first order
keeps the read-log update together, composes with transactional read tool results, and leaves
unrelated database work responsive. It does not open a new libSQL transaction for a
nontransactional edit, because the local libSQL client rotates its native connection after each
transaction; custom stores without the production database boundary use an Agent KV transaction as
the safe fallback.
