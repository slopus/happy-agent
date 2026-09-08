# Anthropic Bedrock transport

The public `AnthropicProvider` selects its internal Bedrock implementation whenever it receives a
`BedrockBearerTokenCredential` or `BedrockAwsCredential`. That implementation sends Anthropic
Messages API requests directly to Amazon Bedrock through `@anthropic-ai/bedrock-sdk`. It supports
the Anthropic-compatible Mantle endpoint and Bedrock Runtime, preferring Mantle when the selected
model is available in-region. Its caller supplies the complete system instructions and tool
definitions; the provider does not launch Claude Code or adopt its tool execution and permission
runtime.

## Request contract

The provider follows Claude Code's foreground inference shape:

- 64,000 maximum output tokens;
- adaptive thinking, with the requested effort in `output_config`;
- the one-million-context and interleaved-thinking betas;
- ephemeral prompt-cache breakpoints on the system prompt and latest message;
- the caller's complete rebuilt transcript, including signed thinking, tool calls, tool results,
  and images.

An inference request that replays a native compaction checkpoint additionally enables the
`compact-2026-01-12` beta and declares a `compact_20260112` edit, because the API rejects
compaction blocks whose strategy is undeclared and offers no way to declare it with compaction
disabled. The replay edit's trigger sits beyond the 1M context window so the provider never
compacts mid-run; only `compact()` sends the edit with a real trigger and
`pause_after_compaction` to ask the provider for a new checkpoint.

On Mantle, the SDK sends the normal Anthropic request to `/v1/messages`, retains the direct model
ID, and puts betas in the `anthropic-beta` header. On Runtime, it adds
`anthropic_version: "bedrock-2023-05-31"`, moves betas to `anthropic_beta`, removes `model` and
`stream` from the body, and calls
`/model/<regional-inference-profile>/invoke-with-response-stream`. Logical Rig model IDs are
resolved to direct Mantle IDs or the appropriate Runtime regional inference profile. Logical IDs
outside the curated catalog are rejected locally; callers can pass a Bedrock model or
inference-profile ID directly when intentionally using an unlisted model.

Rig's Bedrock executor owns an ordered model/transport/region table. The first matching transport
wins:

| Model            | Preferred Mantle regions                                                  | Runtime fallback           |
| ---------------- | ------------------------------------------------------------------------- | -------------------------- |
| Claude Fable 5.1 | None documented; Runtime is the default                                   | Commercial Bedrock regions |
| Claude Sonnet 5  | `eu-north-1`, `eu-west-1`, `us-east-1`                                    | Commercial Bedrock regions |
| Claude Fable 5   | `us-east-1`                                                               | Commercial Bedrock regions |
| Claude Opus 4.8  | `ap-northeast-1`, `eu-north-1`, `eu-west-1`, `us-east-1`, `us-gov-west-1` | Commercial Bedrock regions |

These Mantle lists are the intersection of the AWS Mantle endpoint regions and each model's
documented in-region availability. Runtime remains the fallback because it supports geographic
and global inference profiles. A per-model `transport = "mantle"` or `transport = "runtime"`
override can force one supported surface; pairing it with `endpoint` supports a custom gateway.
Fable 5.1 defaults to Runtime because AWS documents US and global inference profiles but no
in-region Mantle route.

## Runtime ownership

Rig remains responsible for persistence, local tool execution, permissions, and the outer agent
loop. Only local tools are accepted. The provider maps Anthropic text, thinking, signed reasoning,
tool-use JSON, cache usage, and stop reasons into normal `SessionEvent` values.
It also emits opaque ordered response items so interleaved thinking, text, and tool-use blocks can
be persisted and replayed without reordering.

The SDK's hidden retries are disabled. The provider performs Claude-compatible retryable
connection, 408, 409, 429, and 5xx retries itself and emits `retrying` events. Failures the
server delivers on an open stream carry no HTTP status and are mapped onto the status they are
documented to be equivalent to, then follow the same policy. There are two such shapes: an
Anthropic SSE `error` event, which the SDK throws as an APIError without a status — `api_error`
maps to 500, `overloaded_error` to 529 — and an AWS Bedrock Runtime eventstream exception, which
the SDK's smithy layer throws as an AWS ServiceException — `InternalServerException` maps to 500,
`ThrottlingException` to 429, and so on. After stream content has begun, only dropped connections
and retryable mid-stream failures are replayed, through the `block_reset` rollback so no visible
output is duplicated; a stream that produced compaction output is never replayed because
compaction is stateful on the server.

`compact()` always uses Bedrock's native server-side compaction with the `compact-2026-01-12`
beta and `compact_20260112` context-management edit. It pauses at the native compaction boundary,
aggregates per-iteration usage, and retains both `content` and `encrypted_content` exactly as the
provider returned them, including null values. A missing compaction block fails the operation;
Rig never sends a separate summarization request.

## Credentials

Load `BedrockBearerTokenCredential`, normally from `AWS_BEARER_TOKEN_BEDROCK`, or load
`BedrockAwsCredential` from the standard AWS Node credential chain. Named and default shared
profiles support `credential_process`; the AWS SDK validates the process result, memoizes it, and
refreshes expiring credentials. AWS credentials SigV4-sign both Mantle and Runtime requests and
cannot be displaced by an ambient Bedrock bearer token. The provider accepts an explicit region
and otherwise defaults to `us-east-1`; environment resolution belongs to the
executor/configuration layer.

## Verification

`tests/bedrockAwsCredential.test.ts` executes a real fixture `credential_process` and verifies the
resulting OpenAI Mantle, Anthropic Mantle, and Anthropic Runtime SigV4 request headers.
`tests/anthropicBedrockProvider.test.ts` exercises regional routing, signed-thinking replay,
provider-owned retry, native compaction, Mantle and Runtime wire shapes, exact current Rig prompt
and tools, and the captured Claude golden response stream.
`tests/anthropicBedrock.live.test.ts` performs a real preferred-endpoint turn and a real native
compaction followed by a checkpoint-replay turn when `RIG_LIVE_TEST=1` and a bearer token are
available.
