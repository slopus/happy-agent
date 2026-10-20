# Third-party notices

## Happy

Happy Agent's Happy authentication, encrypted session transport, and session-envelope
mapping are adapted from [Happy](https://github.com/slopus/happy).

Copyright (c) 2026 Happy Coder Contributors

Happy is licensed under the MIT License. The integration is modified to use
Happy Agent's daemon, durable sessions, and shared permission model.

## OpenAI Codex

Happy Agent's macOS Seatbelt base policy and Linux Bubblewrap policy are adapted from
[OpenAI Codex](https://github.com/openai/codex).

Copyright 2025 OpenAI

OpenAI Codex is licensed under the Apache License, Version 2.0. The policies
are modified to preserve Happy Agent's workspace metadata and daemon control paths
while using Happy Agent's shared permission modes. A copy of the license is distributed
in the published package as `LICENSE-CODEX`.

## Kimi Code

Happy Agent's Kimi provider contains prompt text and model-facing tool descriptions
adapted from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code).

Copyright (c) 2026 Moonshot AI

Kimi Code is licensed under the MIT License. The provider is modified to use
Happy Agent's shared tools, permissions, and sessions instead of the Kimi Code CLI, and intentionally omits upstream-only Plan, Cron, and AgentSwarm surfaces.
A copy of the license is distributed in the published package as
`LICENSE-KIMI-CODE`.

## Grok Build

Happy Agent's Grok provider contains prompt text and model-facing tool descriptions
adapted from [xai-org/grok-build](https://github.com/xai-org/grok-build).

Copyright 2023-2026 SpaceXAI

Grok Build is licensed under the Apache License, Version 2.0. The provider is
modified to run through Happy Agent's shared tools, permissions, and sessions
instead of the Grok Build terminal client. A copy of the license is distributed in the
published package as `LICENSE-GROK-BUILD`.

## Beautiful Mermaid, elkjs, and entities

The diagram renderer the daemon serves to artifact pages at `/api/v1/diagrams.js`
(`packages/happy-agent-modules/sources/artifactData/impl/artifactDiagramsScript.ts`) is an
unmodified bundle of [Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid) 1.1.3 and
its dependencies [elkjs](https://github.com/kieler/elkjs) 0.11.1 and
[entities](https://github.com/fb55/entities) 7.0.1.

Beautiful Mermaid is Copyright (c) 2026 Craft Docs and licensed under the MIT License. elkjs is
Copyright (c) Kiel University and others and licensed under the Eclipse Public License 2.0, whose
source is available at its repository above. entities is Copyright (c) Felix Böhm and licensed
under the BSD 2-Clause License.
