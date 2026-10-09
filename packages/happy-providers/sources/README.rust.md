# Rust providers

`lib.rs` exports caller-owned messages, events, provider configuration, credentials,
and the exclusive `Session` trait. `HttpSession` owns its client, connection, cache
continuation, retry budget, and cancellation boundary. The agent loop executes tools.

```text
configuration / credential -> HttpSession -> protocol request
                                             -> SSE / WebSocket / AWS framing
                                             -> ordered event stream
```

Protocol serializers live in `protocol/`. The retained TypeScript vendor
descriptors, prompts, skills, Claude Code sources, and golden captures are
reference material. The Rust runtime neither evaluates TypeScript nor launches
the Claude Code SDK. Native compaction prompts are currently compiled as literal
assets from those retained prompt definitions.

Rust tests live under `tests/*.rs` and use real local HTTP servers. The historical
TypeScript suite and captures remain unchanged for subsequent fidelity work;
passing the Rust tests does not certify every historic golden request.
