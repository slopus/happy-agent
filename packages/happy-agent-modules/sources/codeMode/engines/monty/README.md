# Monty Code Mode engine

This folder is the complete Monty-backed implementation of Code Mode. It owns the replacement
prompt, Python schemas and tool, Monty subprocess pool, snapshot and replay journal, clock and empty
environment callbacks, and the permission-aware filesystem bridge. Nothing above the engine
boundary needs to understand Monty sessions or Python results.

The engine owns one bounded `@pydantic/monty` subprocess pool for the application lifetime. Each
`python` call checks out a fresh session, restores that agent's opaque Monty dump, runs one bounded
program, dumps the resulting idle interpreter, and closes the session. Before the tool result
commits, the engine atomically writes a versioned checkpoint containing the new dump and a bounded
journal of exact results keyed by Base's stable call IDs. Calls for one agent are serialized through
that write-and-commit boundary; different agents remain isolated.

State is written to `.happy/agent/state/<agentId>/snapshot.bin` using a private same-directory
temporary file, file sync, atomic rename, and directory sync. A corrupt or Monty-incompatible
checkpoint is preserved once as `snapshot.invalid.bin` and that agent starts fresh. Read failures,
worker crashes, and cancellation retain the last known good bytes. Ordinary Python exceptions
still capture mutations made before the exception.

The interpreter receives no mounts, inputs, external lookup, functions, or loose host objects. Its
OS callback supplies the current date and time, an intentionally empty environment, and the agent's
`ComputeModule` filesystem. `pathlib.Path` and `open()` resolve relative paths from the agent
working directory, and every operation carries the current tool-call permission boundary. Dynamic
Python paths never auto-elevate the whole interpreter. Network, shell, environment values, skills,
and other integrations remain unavailable.

Empty-directory removal is unavailable until Compute has a race-safe `rmdir` primitive. Monty's JS
bridge returns `iterdir()`, `resolve()`, and `absolute()` path results as strings, so Python should
wrap one in `Path(...)` before applying another path operation.
