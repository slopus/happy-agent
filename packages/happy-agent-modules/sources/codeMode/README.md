# Code Mode

Code Mode is an opt-in replacement surface for the ordinary Happy agent. Enable it globally or in
a project:

```toml
[feature.codemode]
enabled = true
engine = "monty"
```

The runtime always installs `CodeModeModule` last. When disabled, it contributes no hooks. When
enabled, it selects one engine and exposes that engine's complete provider-facing instructions,
tools, turn settlement, and lifecycle through the normal module hook chain.

```text
ordinary instructions + tools
              │
              v
       CodeModeModule (last)
              │
              v
       selected CodeModeEngine
              │
              v
replacement instructions + tools
```

`CodeModeModule` owns only feature enablement, the one engine-selection seam, startup ordering, and
shutdown. It does not own an interpreter, tool schema, checkpoint format, execution policy, or
engine prompt. Those belong to the selected implementation under `engines/`.

The default [Monty engine](engines/monty/README.md) provides one continuous sandboxed Python tool.
Set `engine = "bun"` to use the [system Bun proof of concept](engines/bun/README.md), which provides
one stateless JavaScript/TypeScript tool. Adding another implementation means adding another engine
folder that implements `CodeModeEngine`, then extending the single selection seam; ordinary runtime
module composition and hook wiring stay unchanged. Code Mode remains separate from Workflows.
