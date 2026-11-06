# Shared utilities

Self-contained algorithms used across feature boundaries. `orderKeyBetween` is the existing
workspace catalog's decimal fractional-key implementation, shared with Surfaces without making
one feature import another feature's internals. Between two keys it takes the shortest key near
their middle; at an open end it steps one unit past the neighbour at a power-of-two width, so
lists that keep taking work first or last stay short. `orderKeyJustBefore` steps below a row in
the same way while staying after a fixed one, for work that keeps arriving right after it.
`renumberLongOrderKeys` is the migration step that gives stored lists whose keys already grew
past half their bound fresh keys in the same order.

Monotonic UUIDv7 creation is shared here as well, so modules generate resource versions without
importing the event journal's implementation.

`apiResourceVersion` projects a module's numeric record version into the deterministic UUIDv7
that the API exposes. It lives here so a feature can report another resource's public version,
as Surface references do, without importing the API module's projection code.

`searchWords` splits and folds query words the way the SQLite FTS5 unicode61 tokenizer with
`remove_diacritics 2` does, builds prefix match expressions, finds a match's line and snippet, and
ranks short in-memory lists with BM25, so every search provider agrees on what a word is.
`SearchHit` is the shape a provider returns before fusion assigns its rank. `htmlSearchText`
reads HTML as the text a reader sees, for every provider that indexes HTML.
