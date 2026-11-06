# Chat Completions protocol

Kimi K3 and GLM 5.3 on Bedrock Runtime, and every configured OpenAI-compatible endpoint, share
this wire protocol. Vendor providers select model IDs, reasoning parameters, and their documented
compaction contracts. Callers supply instructions, tools, and immutable history.

```text
KimiProvider / GlmProvider / OpenAICompatibleProvider
        |
ChatCompletionsSession --- vendor compaction prompt + replacement context
        |
createChatCompletionsRequest
        |
ChatCompletionsConnection --- OpenAI SDK request + Bedrock SigV4/bearer, or a plain API key
        |
readServerSentEvents --- owned SSE decoding of the response body
        |
mapChatCompletionsStream --- ordered blocks, parallel tool IDs, usage, completion
```

Both models always reason and accept `low`, `high`, and `max` effort. Their default is `max`.
Assistant `reasoning_content` is replayed alongside text and tool calls. Namespace names are
encoded as `namespace__name` and mapped back on the response. Deferred tools are sent eagerly;
neither provider advertises native tool discovery or server tools.

Bedrock rejects regex look-around in Kimi and GLM tool and structured-output schemas, so both
providers set `stripSchemaPatterns`: every `pattern` and `patternProperties` is replaced with a
readable description on the wire, while the caller's schema keeps its patterns for local
validation. OpenAI-compatible endpoints receive the caller's schemas unchanged.

Each inference attempt has a rollback boundary. Connection failures, throttling, retryable HTTP
failures, empty output, and prematurely closed streams may retry within the provider budget.
Authentication and invalid requests remain terminal. Cancellation closes the response stream,
and session destruction cancels ongoing inference. The OpenAI SDK's automatic retries are disabled.

Compaction is an explicit summary inference with the vendor's instructions, no tools, and the
original system prompt. Kimi retains a bounded selection of user messages and its native
continuation reminder; GLM uses Claude Code's summary formatter and continuation text. Both return
a replacement context for the caller to adopt and preserve input history unchanged.

The session names its vendor in every error and retry message; Bedrock is the default. Streamed
reasoning is read from `reasoning_content` or OpenRouter's `reasoning`. Replay of assistant
reasoning is a session option: Kimi and GLM always send `reasoning_content`, while generic
endpoints send `reasoning`, `reasoning_content`, or nothing, as configured.

The SDK sends the request and raises HTTP errors, but the response body is decoded by
`readServerSentEvents`, not the SDK's stream. On Bun for Windows the SDK's async-iterator read was
reported to drop intermediate events from fast gateway answers; the SDK also discards a final event
that a gateway closes without a blank line. The owned decoder reads with `getReader()`, accepts LF,
CRLF, and CR framing split anywhere across reads, comments, multi-line `data:`, and a missing final
blank line. Gateway chunks may omit `choices`, `delta`, or `finish_reason`. An `error` object in the
stream is raised as the SDK's `APIError`, and anything after `[DONE]` is ignored.

Tests exercise the complete SDK request/stream path through mocked HTTP responses. Live tests
are opt-in; deterministic tests do not establish live account eligibility or golden-trace fidelity.
