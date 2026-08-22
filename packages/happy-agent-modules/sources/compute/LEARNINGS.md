# Compute module learnings

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
