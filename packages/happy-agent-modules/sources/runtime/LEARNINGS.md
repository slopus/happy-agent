# Runtime learnings

## Module loading belongs in distributed traces

Module timing logs alone did not reveal startup and restoration in the trace viewer. The shared
module wrapper now creates spans for initialization and ordinary hooks, including after-start and
agent restoration, passing the span context into module work so child spans nest correctly. It
preserves synchronous returns, asynchronous completion, and original failures. Raw provider events
remain uninstrumented so streaming deltas cannot flood telemetry.

## Probe startup is not the database responsiveness deadline

The isolated database deadlock test previously allowed four seconds for cold TypeScript imports,
database setup, and its gated tool batch. Under CI CPU contention, startup took over six seconds
even though the database check completed in under 110 milliseconds. The probe now has a separate,
bounded fifteen-second startup allowance. Its one-second deadline after `READY` and every
concurrency assertion remain unchanged, so slow process startup cannot masquerade as a deadlock.
