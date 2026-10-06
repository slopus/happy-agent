# Chat Completions protocol

Kimi K3 and GLM 5.3 on Bedrock Runtime share this OpenAI-compatible wire protocol. Vendor
providers select model IDs, reasoning parameters, and their documented compaction contracts.
Callers supply instructions, tools, and immutable history.

```text
KimiProvider / GlmProvider
        |
ChatCompletionsSession --- vendor compaction prompt + replacement context
        |
createChatCompletionsRequest
        |
ChatCompletionsConnection --- OpenAI SSE + bearer token or Bedrock SigV4
        |
mapChatCompletionsStream --- ordered blocks, parallel tool IDs, usage, completion
```

Both models always reason and accept `low`, `high`, and `max` effort. Their default is `max`.
Assistant `reasoning_content` is replayed alongside text and tool calls. Namespace names are
encoded as `namespace__name` and mapped back on the response. Deferred tools are sent eagerly;
neither provider advertises native tool discovery or server tools.

Each inference attempt has a rollback boundary. Connection failures, throttling, retryable HTTP
failures, empty output, and prematurely closed streams may retry within the provider budget.
Authentication and invalid requests remain terminal. Cancellation closes the response stream,
and session destruction cancels ongoing inference. The OpenAI SDK's automatic retries are disabled.

Compaction is an explicit summary inference with the vendor's instructions, no tools, and the
original system prompt. Kimi retains a bounded selection of user messages and its native
continuation reminder; GLM uses Claude Code's summary formatter and continuation text. Both return
a replacement context for the caller to adopt and preserve input history unchanged.

Tests exercise the complete SDK request/stream path through mocked HTTP responses. Live tests
are opt-in; deterministic tests do not establish live account eligibility or golden-trace fidelity.
