# Tool discovery

Tool discovery activates the provider-owned search support exposed by Agent Base and Happy
Providers. It does not execute a search in the module. Its special tool is a native server tool,
so the selected provider owns the call, result, replay, and any local BM25 settlement it needs.

The provider/model selection is deliberately closed:

- Claude models use Claude Code's built-in `ToolSearch`.
- Codex GPT-5.6 models use provider-owned client BM25 through `tool_search`.
- Bedrock, Grok, Gym, unknown models, and future unverified routes receive no search descriptor.
  Providers therefore expose every deferred client tool eagerly on those routes. Bedrock's hosted
  search remains disabled because the released Anthropic adapter does not include caller-supplied
  BM25 keywords in its search documents.

The discovery call is retained only in Agent Base's private provider context. It is absent from
ordinary history and live user-facing events. The actual tool it discovers remains an ordinary
visible, durable tool call.

Each owning tool definition declares its policy directly. Most executable tools set `defer: true`;
compute and structured user-input tools explicitly stay eager. The owner gives each deferred tool
specific BM25 search terms and contributes a concise shared capability; Agent Base de-duplicates
capabilities into the system prompt, and Providers index the extra search terms alongside tool
names, descriptions, schemas, and namespaces.
