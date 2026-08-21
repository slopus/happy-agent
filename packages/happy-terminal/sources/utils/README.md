# utils

Self-contained functions that do not own a product domain or require surrounding
infrastructure. Domain modules may depend on these functions without introducing
a dependency back into another subsystem.

```text
domain module
     |
     v
small deterministic utility
     |
     +--> value
     +--> filesystem result
```

`fractionalIndexing` and `orderKeyAfter` create stable ordering keys.
`normalizeProjectCwd` canonicalizes an existing path while preserving a useful
absolute path for a future or missing directory. `parseJsonFromModelOutput`
extracts structured JSON from model text, and `raceWithAbort` applies an abort
boundary to asynchronous work. `clientChosenId` accepts an identity a client
chose for something it is creating. `TrackedTaskDrain` tracks accepted asynchronous
work, rejects new work during shutdown, and waits for the accepted work to
settle.

Tests for these public utilities live in `tests/`.
