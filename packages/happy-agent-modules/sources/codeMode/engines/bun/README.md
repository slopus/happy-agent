# Bun Code Mode engine

The Bun engine is a deliberately small proof of concept. It exposes one `javascript` tool and
runs every call as `bun -e` through the agent's Compute shell. Bun accepts JavaScript and
TypeScript directly, so no separate transpiler is needed.

Every invocation is a fresh process with a 10-second wall timeout. JavaScript globals do not
persist, and a crash affects only that call. The system must provide `bun` on `PATH`. Compute owns
the working directory, environment, filesystem/network sandbox, cancellation, output capture, and
process-tree cleanup. This engine does not reuse Monty's pool, checkpoint, or filesystem bridge.
