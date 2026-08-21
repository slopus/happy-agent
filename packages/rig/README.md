# rig

rig is an opinionated coding-agent harness with strong defaults for provider-aligned
tools, prompts, subagents, managed processes, MCP, sandboxing, and local terminal
workflows.

This directory contains the published `@slopus/rig` CLI package. See the
[repository documentation](https://github.com/slopus/rig#readme) for installation,
configuration, development, and release instructions.

Packages that integrate with Rig's daemon can import its public wire contracts without
loading Rig at runtime:

```ts
import type {
    CreateSessionRequest,
    ExternalToolDefinition,
    ProtocolSession,
    RemoteTerminalSummary,
} from "@slopus/rig/types";
```

The package version helper is available from `@slopus/rig/package-version`.

## Happy Agent daemon

Rig connects to an already-running Happy Agent daemon first. In this repository it runs the local
Happy Agent sources. A published Rig installation instead downloads the latest matching macOS or
Linux release once, verifies it, and records the selected installed version under
`~/.happy/dist/config.json`.
