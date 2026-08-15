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
    ProtocolSession,
    RemoteTerminalSummary,
} from "@slopus/rig/types";
```

The package version helper is available from `@slopus/rig/package-version`.
