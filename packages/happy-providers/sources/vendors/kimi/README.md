# Kimi on Bedrock

`KimiProvider` serves Kimi K3 exclusively through Bedrock Runtime's OpenAI-compatible Chat
Completions endpoint. It accepts existing Bedrock bearer-token and AWS credentials. There is no
Moonshot API account type, model discovery, Mantle route, or video input.

```text
KimiProvider -> shared Chat Completions session -> Bedrock Runtime
      |
      +-- prompts/   official Kimi Code system and compaction templates
      +-- tools/     native harness reference descriptors
      +-- impl/      bounded native compaction handoff
```

Canonical model ID: `moonshotai/kimi-k3`. US source regions use `us.moonshotai.kimi-k3`; other
regions use `global.moonshotai.kimi-k3`. Explicit US/global profile IDs are accepted. AWS controls
the availability of each profile in the selected region.

K3 always thinks, using the top-level `reasoning_effort` field (`low`, `high`, or `max`, default
`max`). Earlier Kimi models' nested `thinking` object is not its contract. Replay all assistant
reasoning and tool calls. Text and image inputs are supported; AWS does not support K3 video input.

Reference sources checked on October 6, 2026:

- [Official Kimi Code harness](https://github.com/MoonshotAI/kimi-code), commit
  `21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3`.
- System prompt: `packages/agent-core-v2/src/app/agentProfileCatalog/system.md`. The reproduced
  file retains the native rendering placeholders; production callers supply their own prompt.
- Compaction prompt: `packages/agent-core-v2/src/agent/fullCompaction/compaction-instruction.md`.
  Handoff: `packages/agent-core-v2/src/agent/contextMemory/compactionHandoff.ts`. User retention
  is 20k estimated tokens, with 2k for oldest input and 18k for newest input when elision is needed.
  The checkpoint's opaque metadata carries the continuation reminder without creating a second
  application persistence channel.
- [Kimi K3 model usage](https://github.com/MoonshotAI/Kimi-K3#6-model-usage), including effort and
  preserved reasoning requirements.
- [AWS model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k3.html).
  AWS recommends the OpenAI-compatible APIs because Converse cannot replay K3 reasoning reliably.

The assets are internal reference data, never package exports. Happy keeps its own adapted system
prompt and tools. Kimi Code's dynamic discovery, plugins, Plan mode, and native task runtime are
not part of this transport integration.
