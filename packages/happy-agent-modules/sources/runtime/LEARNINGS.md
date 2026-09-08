# Runtime learnings

## Probe startup is not the database responsiveness deadline

The isolated database deadlock test previously allowed four seconds for cold TypeScript imports,
database setup, and its gated tool batch. Under CI CPU contention, startup took over six seconds
even though the database check completed in under 110 milliseconds. The probe now has a separate,
bounded fifteen-second startup allowance. Its one-second deadline after `READY` and every
concurrency assertion remain unchanged, so slow process startup cannot masquerade as a deadlock.
