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

The transcript must end with a user turn, a tool result, or that native compaction checkpoint.
Claude models from 4.6 onward reject a trailing assistant message ("This model does not support
assistant message prefill"), and the adapter does not add or drop a turn to work around it:
Opus 5.5, Sonnet 5.5, Fable 5.2, and Fable 5.1 bind each signed thinking block to the exact messages before
it, so a user turn sent with one request and missing from the next would make every later request
fail. A caller
continuing a cut-off response appends a durable system notice instead, which serializes as a
`<system-reminder>` user turn and, like any user input, ends a pending server call's turn.

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

| Model             | Preferred Mantle regions                                                  | Runtime fallback           |
| ----------------- | ------------------------------------------------------------------------- | -------------------------- |
| Claude Opus 5.5   | Model card lists Mantle; in-region availability not yet documented        | Commercial Bedrock regions |
| Claude Sonnet 5.5 | `us-gov-west-1` only; Runtime is the default                              | Commercial Bedrock regions |
| Claude Fable 5.2  | None; AWS serves it on Runtime only                                       | Commercial Bedrock regions |
| Claude Fable 5.1  | None documented; Runtime is the default                                   | Commercial Bedrock regions |
| Claude Sonnet 5   | `eu-north-1`, `eu-west-1`, `us-east-1`                                    | Commercial Bedrock regions |
| Claude Fable 5    | `us-east-1`                                                               | Commercial Bedrock regions |
| Claude Opus 4.8   | `ap-northeast-1`, `eu-north-1`, `eu-west-1`, `us-east-1`, `us-gov-west-1` | Commercial Bedrock regions |

These Mantle lists are the intersection of the AWS Mantle endpoint regions and each model's
documented in-region availability. Runtime remains the fallback because it supports geographic
and global inference profiles. A per-model `transport = "mantle"` or `transport = "runtime"`
override can force one supported surface; pairing it with `endpoint` supports a custom gateway.
A query on that endpoint, such as `https://gw.example/bedrock?route=a`, is kept apart from the path
and sent with every request, so the Runtime rewrite still applies. A name the endpoint repeats
keeps only its last value, and an endpoint `beta` replaces the `beta=true` marker Mantle requests
carry. Runtime requests never carry `beta`: the SDK removes Anthropic's marker and an endpoint's
own `beta` with it, so a gateway behind Runtime cannot receive a parameter by that name. An
endpoint with an explicit port is signed under SigV4 over the host and port the request is sent
to; the SDK alone would sign the hostname without the port.
Without an endpoint, Runtime in the China partition (`cn-north-1`, `cn-northwest-1`) is reached at
`bedrock-runtime.<region>.amazonaws.com.cn`.
Fable 5.1 defaults to Runtime because AWS documents US and global inference profiles but no
in-region Mantle route. Fable 5.2's model card lists only the `bedrock-runtime` endpoint, with
`us.anthropic.claude-fable-5-2` and `global.anthropic.claude-fable-5-2` and no in-region ID, so it
resolves like Fable 5.1 and the catalog hides a forced Mantle route. Both Fable models require the
AWS account to opt in to AWS review (`aws_review` data retention) before Bedrock serves them.
Fable 5.2's Bedrock mapping follows AWS's model card and the Fable 5.1 precedent; it shipped
without a live Bedrock request. Opus 5.5 launched on both endpoints with the same us, eu, jp, au, and
global Runtime profiles as Opus 5; its Mantle ID is the bare `anthropic.claude-opus-5-5`.
Sonnet 5.5 also defaults to Runtime. AWS documents only its global profile,
`global.anthropic.claude-sonnet-5-5`, with no geo profiles, so every region resolves to that
profile. Its only in-region Mantle route is GovCloud West; the catalog hides a forced Mantle route
anywhere else, and a GovCloud deployment selects it with `transport = "mantle"`.

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

Compaction carries the selected model's normal tool definitions, including deferred tools and
native tool search. Historical tool-search results contain references that the server validates
against that same request's tools. Sending an empty tool list makes an otherwise valid transcript
fail with `Tool reference 'web_fetch' not found in available tools`. Keep the definitions and the
opaque historical results intact; `pause_after_compaction` still stops at the native checkpoint.

### References to withdrawn tools

Keeping the caller's definitions is not enough when the tool set shrinks. An MCP server that fails
to reconnect, or a model whose tool set lacks a tool an earlier search found, removes a definition
that stored `tool_search_tool_result` blocks still reference, and every later inference and
compaction then fails with that same 400. Nothing in the transcript can recover from it.

So while serializing each request, inference and compaction alike, the adapter collects every
`tool_reference` the outgoing messages replay and compares it with the request's `tools`:

- With native tool search in the request, each missing tool is declared after the caller's tools,
  in order of first reference, as a deferred placeholder: the referenced name, the description
  `Unavailable: an earlier search found this tool, but it is no longer offered. Calls to it fail.`,
  an empty object schema, and `defer_loading: true`. The history is sent byte for byte. If the
  model calls the placeholder, the call reaches the caller as a tool it does not have, and the
  agent loop answers it with an error tool result.
- Without native tool search, `defer_loading` is not valid, so only the dangling references are
  left out of that request's copy of the result. The rest of the result keeps its position.

Neither path changes caller-owned history. Once the tool is offered again, its real definition
replaces the placeholder and the stored reference resolves normally. The placeholder is a
request-local projection of a name the caller's own history already contains, not a tool the
adapter adds to the session; it is the only way to send that history unchanged.

Both Mantle and Runtime build requests through the same `createAnthropicRequest`, so both carry
this behavior. The direct Anthropic API goes through the Claude Code SDK, which owns its own
request history.

### Server tools across client-tool results

An Anthropic `tool_use` response can contain both a client call and an unfinished native server
call. The caller executes only the client call. The following response may begin with the server
result referencing the earlier call, without repeating its native start. This is separate from
`pause_turn`.

The adapter reconstructs pending server calls from the caller's opaque native context on each
run, including after a restart. Before emitting a delayed result, it emits a response-local
continuation of that known call so callers with response-local event identities can correlate it.
The continuation is marked in opaque `vendor` metadata. Request serialization verifies its
original call and omits only the continuation copy: the original native call keeps its position,
and the real result keeps its position after the client-tool round trip. No result is invented,
no client call is re-executed, and caller-owned history is never mutated.

Some callers retain completed blocks when a failed stream is reset. Repeated identical marked
settlements are projected to one native result; conflicting results and unanchored continuation
markers fail explicitly. Unknown incoming result IDs likewise fail at the provider boundary.
Visibility/history publication settings do not remove native blocks from private model context.

Only client tool results can resume an unfinished server turn. Anthropic documents that adding
text after those results ends the turn and rejects a pending server call with the exact error
`was found without a corresponding <name>_tool_result block`. This applies to queued steering as
well as immediate interruption. Agent deliveries and system reminders also become user text on
the wire and end the native turn. See [Server tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools)
and [Troubleshooting tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/troubleshooting-tool-use).

Serialization omits an unmatched server call once subsequent user input ends its turn, and omits
an assistant message left empty by that projection. Completed client calls and their actual
results remain intact, so steering does not re-execute local work. The complete history is scanned
before projecting anything: completed native pairs, including genuine delayed settlements, retain
their positions. With only client results after a call, the existing server continuation remains
available. This also allows recovery from calls retained after an interrupted or failed stream.
Stored history is never changed, and no search result is invented.

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
`tests/anthropicBedrockCompactionTools.test.ts` exercises tool-search inference, native compaction,
and checkpoint continuation through the real SDK with scripted HTTP responses. It verifies both
session-level and selected-model tool definitions and leaves the caller's history unchanged.
`tests/anthropicBedrockToolReferences.test.ts` replays a search result that references a tool the
session no longer offers, with and without native tool search, through inference and compaction,
against a scripted endpoint that rejects dangling references the way Bedrock does.
`tests/anthropicBedrock.live.test.ts` performs a real preferred-endpoint turn and a real native
compaction followed by a checkpoint-replay turn when `RIG_LIVE_TEST=1` and a bearer token are
available.
