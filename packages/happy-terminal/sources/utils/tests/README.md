# utils tests

Focused tests for the self-contained utilities one directory above.

```text
test input --> utility --> deterministic value
```

Filesystem-backed cases use temporary directories and clean them after each
test. No test here requires the daemon, a session, or a database.
`TrackedTaskDrain.test.ts` covers shutdown and asynchronous-work draining.
