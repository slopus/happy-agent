# Codex provider

This package reproduces the model-facing inference behavior of vanilla Codex while Rig remains
the owner of conversation persistence, tool execution, permissions, and the agent loop. Codex
behavior is not selected by a public mode flag. It is the behavior of `CodexSession` whenever the
canonical provider is `codex`.

This document is both a maintenance contract and a parity report. It distinguishes behavior
proven by live traffic from behavior inferred from vanilla source or covered only by mocked
provider tests.

## Evidence and provenance

The implementation is checked against:

- the vanilla Codex checkout at `~/Developer/coding-assistant-sources/codex`, reviewed at commit
  `d4fcb2873bf23464cfacd804a31d46529db943b0`;
- real Codex CLI 0.145.0 SSE and WebSocket traffic under `tests/vendors/fixtures/`;
- the official GPT-6 Astra API documentation and merged Codex model metadata in
  `openai/codex#42605`;
- real multi-turn captures containing two turns, native compaction, post-compaction inference,
  a same-family Sol-to-Terra switch, and a 5.6-to-5.5 switch;
- literal prompt fragments under `sources/vendors/codex/prompts/`;
- literal TypeBox tool definitions under `sources/vendors/codex/tools/`;
- deterministic golden and provider tests under `tests/vendors/codex*.test.ts` and
  `tests/codex*.test.ts`;
- `tests/codex.live.test.ts`, which uses the credentials already managed by the local Codex
  installation.

The most relevant vanilla sources are:

- `codex-rs/core/src/client.rs` for SSE, WebSocket, request equality, incremental input,
  connection reuse, sticky turn state, and unauthorized recovery;
- `codex-rs/core/src/responses_retry.rs` for transport retries and WebSocket-to-HTTP fallback;
- `codex-rs/core/src/compact_remote_v2.rs` and `compact_remote_v2_attempt.rs` for native
  compaction;
- `codex-rs/core/src/compact.rs` and `compact_remote.rs` for local compaction and replacement
  history;
- `codex-rs/core/src/session/turn.rs` for automatic compaction and model-switch behavior;
- `codex-rs/core/src/responses_metadata.rs` for request, session, turn, and window identity;
- `codex-rs/protocol/src/openai_models.rs` and `codex-rs/models-manager/models.json` for model
  capabilities and compaction compatibility.

Live fixtures are the authority for the captured wire shape. Vanilla source is the authority for
state transitions and behavior that a short trace cannot exercise. Tests define the Rig
adaptation. When these sources differ, the difference must be documented rather than hidden by a
golden normalizer.

The OpenAI SSE and WebSocket fixtures are marked `forwarded-live-inference`: the recorder
forwarded each request to the real backend and saved the real response stream. Dynamic IDs,
credentials, paths, encrypted content, and timestamps are normalized or redacted; prompts, tool
schemas, item order, stable headers, request fields, and event structure remain real.

The Bedrock/Mantle fixtures are different. They are marked `initial-request-only`: the recorder
saved the real vanilla request and deliberately returned 401. They prove the initial request
shape, endpoint, and headers, but do not prove successful Bedrock inference, response mapping,
retry behavior, or compaction.

## Verified surface

| Behavior                                                          | Evidence                         |
| ----------------------------------------------------------------- | -------------------------------- |
| Initial SSE and WebSocket envelopes for 5.5, Sol, Terra, and Luna | Forwarded live inference         |
| Required instructions, developer context, tools, and skills       | Live goldens and request tests   |
| WebSocket warmup, suffix reuse, and `previous_response_id`        | Live multi-turn goldens          |
| SSE full-context requests                                         | Live multi-turn goldens          |
| Native compaction and Sol-to-Terra or 5.6-to-5.5 switching        | Live multi-turn goldens          |
| Ordered reasoning, custom tools, tool search, and block rollback  | Mocked provider tests            |
| Parallel 5.6 tool-call batches over SSE and WebSocket             | Live provider tests              |
| Retry, idle timeout, turn state, and WebSocket-to-SSE fallback    | Vanilla source and mocked tests  |
| Vanilla automatic compaction threshold and model-switch trigger   | Vanilla source and live traces   |
| Absence of provider-owned automatic compaction in Rig             | Provider tests                   |
| Rig hard-window safety fitting                                    | Unit tests                       |
| Bedrock/Mantle initial request                                    | Real request-only capture        |
| Successful Bedrock inference and local compaction                 | Not live-verified                |
| ChatGPT credential rotation after session creation                | Deterministic auth-recovery test |
| Image input and image-bearing tool output                         | Request serialization tests      |
| Astra Lite/full tools over SSE/WebSocket and all API efforts      | Live provider probes             |

## Models and configuration

Rig has no Codex default model. A model must be supplied when the provider is created or when
inference runs. The reviewed model-property catalog is curated in source and is never discovered
from the provider during startup. `CodexSession` does not reject an unknown model string: with an
explicit configuration and reasoning effort it falls back to the ordinary non-Lite request
shape, a 272,000-token compaction window, and no known compaction hash.

The reviewed model contracts are:

- `gpt-5.5`: ordinary Responses request shape, compaction hash `2911`, default medium effort;
- `gpt-6-astra`: Responses Lite by default and ordinary Responses for parallel tool calls,
  compaction hash `3000`, default low effort, and API efforts low through max;
- `gpt-5.6-sol`: Responses Lite shape, compaction hash `3000`, default low effort;
- `gpt-5.6-terra`: Responses Lite shape, compaction hash `3000`, default medium effort;
- `gpt-5.6-luna`: Responses Lite shape, compaction hash `3000`, default medium effort;
- Bedrock model names use the `openai.` prefix and currently inherit the 5.5-style request and
  compaction contract.

Astra's active Codex context is 272,000 tokens and its automatic compaction threshold is 244,800.
Codex metadata also advertises an opt-in 872,000-token ceiling; Rig does not currently expose that
separate extended-context setting. The public Astra API supports `low`, `medium`, `high`, `xhigh`,
and `max`. Codex also advertises an `ultra` UI preset that adds automatic delegation, but `ultra`
is not a public Astra API reasoning effort and is not part of the shared provider contract.

Sol and Terra share a prompt/tool configuration and can switch without the caller supplying a
second configuration. Luna and 5.5 have distinct configurations. A switch to either therefore
requires an explicit `modelConfigurations` entry at session creation.

Vanilla compares compaction hashes before a model switch. A hash change causes pre-turn
compaction with the previous model, with the target model as the fallback when the first
compaction request is rejected as an unsupported model. Rig deliberately does not perform this
step inside `CodexSession.run()`. The outer session manager must explicitly compact and install
the replacement context before an incompatible model switch. All reviewed models have a
272,000-token context window, so vanilla's separate smaller-window downshift rule does not
currently distinguish them.

## Prompt layers

The root `SessionContext.instructions` field is required. It represents the root Codex
instructions, not a message in ordinary session history.

Additional context messages with `role: "system"` are a separate layer. They are serialized as
Responses `developer` messages and keep their order. They must not be concatenated into
`instructions` because vanilla treats root instructions and context messages differently.

The captured 5.5 request keeps root instructions in the Responses `instructions` field. The
captured 5.6 Responses Lite request moves the root instructions into the first developer message
and omits the top-level field. For 5.6 WebSocket, warmup sends that developer instruction together
with `additional_tools`; incremental inference then omits the already established instruction.

The transport itself does not choose a different personality or permission prompt. Differences
between the captured SSE and WebSocket prompt envelopes came from the CLI configuration used for
those captures, such as installed plugin and collaboration blocks. Golden helpers therefore
retain the exact captured variants without teaching the provider that SSE and WebSocket require
different semantics.

Prompt fragments have meaningful names and live as TypeScript string constants under
`sources/vendors/codex/prompts/`. Source formatting may split a string across readable lines, but
the resulting value, including every newline, must equal the captured prompt.

## Skills

Skills are not a session concept. A caller that wants them composes the catalog into its own
developer context like any other prompt content; the provider neither discovers skills nor reads
them during inference.

Codex's own rendering is kept in `impl/withCodexSkills.ts` and `impl/createCodexSkillsPrompt.ts`
so reproduction tests can rebuild a captured request exactly. Descriptions are capped there at
1,024 characters, matching vanilla's bounded metadata presentation, and the trailing skill
instructions differ between 5.5 and the 5.6 Responses Lite family.

## Tools

Tools are supplied when the session is created. The provider must not install a hidden,
model-specific tool list. Golden tests assemble the captured vanilla lists from the public
one-file-per-tool definitions.

Every captured tool is defined one tool per TypeScript file, with a constant whose name matches
the file. Parameters are TypeBox schemas and are converted to JSON Schema only at the request
boundary. A description and parameter schema are optional because some provider-native tools do
not use them.

Ordinary tools become Responses function definitions. A tool with a Lark grammar becomes a
custom tool definition. Namespaced tools become Codex namespace definitions while preserving
their individual function or custom-tool definitions.

`tool_search` remains a normal `SessionTool` in Rig. Its Codex-specific wire representation is
selected by discriminated vendor metadata:

```ts
vendor: {
    provider: "codex",
    type: "tool_search",
    execution: "client",
}
```

This produces a native `tool_search` definition. The provider must not infer native tool behavior
from the tool name. The same rule applies when replaying calls: persisted Codex vendor metadata
distinguishes `function_call`, `custom_tool_call`, and client `tool_search_call`.

The cloud `web_search` tool is the other provider-native definition. Its external access and
search content types are part of the Codex request shape. Tool definitions remain model-facing
capability declarations only; Rig's shared agent loop owns execution and permissions.

## Common request fields

Normal Codex requests use:

- the explicitly selected model;
- `stream: true` and `store: false`;
- `tool_choice: "auto"`;
- low text verbosity;
- requested or model-default reasoning effort;
- encrypted reasoning inclusion whenever reasoning is enabled;
- `prompt_cache_key` equal to the stable Rig session ID;
- Codex client metadata for installation, session, thread, turn, request kind, and compaction
  window.

The prompt cache key is stable session identity. It is not derived from a reset counter or from
the physical WebSocket. There is no session reset API.

For 5.5, tools are top-level request definitions and parallel tool calls are enabled. For 5.6
Responses Lite, tools arrive through a developer `additional_tools` item, the top-level `tools`
field is omitted, parallel tool calls are disabled in the captured request, and reasoning uses
`context: "all_turns"`.

`CodexProviderOptions.parallelToolCalls` is an explicit Rig adaptation. Leaving it undefined
preserves the captured model-specific contracts and keeps the golden fixtures authoritative.
Setting it to `true` makes 5.6 use the ordinary Responses envelope with top-level instructions and
tools, omits the Responses Lite SSE header or WebSocket metadata marker, and enables parallel tool
calls. The real service rejects `parallel_tool_calls: true` when the Lite marker is present, so
changing the field without changing the envelope is invalid. Rig's production Codex executor opts
into the standard envelope; live tests verify two calls in one response over both transports.

Bedrock/Mantle uses SSE and a 5.5-style envelope. Adjacent developer messages are merged before
submission. The selected model uses the `openai.` Bedrock name, and Mantle-specific client headers
are added without changing Rig's provider key from `codex`.

## Request identity and headers

One installation ID is shared with the system Codex installation. Rig reads or creates
`$CODEX_HOME/installation_id` using an inter-process lock and atomic replacement so concurrent
processes converge on one durable value.

The session and thread IDs are the stable Rig session ID. The turn ID changes when the logical
user turn changes. Tool results and retries belonging to the same user turn retain that turn ID.
The compaction window ID changes after successful compaction.

`x-codex-turn-state` is a server-issued sticky-routing value. It is accepted from the response
header or stream metadata and replayed only within the same logical user turn. It must be cleared
before a later user turn, even when the physical WebSocket is retained.

The golden fixtures contain this captured user agent:

```text
codex_exec/0.145.0 (Mac OS 26.5.2; arm64) unknown (codex_exec; 0.145.0)
```

Rig likewise builds it dynamically from the installed Codex version, OS, architecture, and
terminal. Golden tests may inject the captured value so host identity does not make request-shape
tests nondeterministic.

## SSE

SSE sends the complete rebuilt request context on every attempt. It has no
`previous_response_id` optimization. The physical HTTP connection may be pooled by the SDK, but
there is no model-context state bound to that connection.

The server may return `x-codex-turn-state` on the HTTP response. Rig retains it only for requests
in the same user turn. A new user turn gets a fresh turn identity and no inherited sticky token.

In `auto` transport mode, SSE becomes the persistent fallback when WebSocket is unavailable and
the shared retry budget still has room for the fallback attempt. A zero retry budget therefore
disables fallback. Once activated, later runs in the same Rig session continue with SSE.

## WebSocket

WebSocket optimization has two independent pieces:

1. a physical connection that may live across logical turns;
2. an in-memory response chain consisting of the last full request, server output items, and
   `previous_response_id`.

The first request sends a `response.create` warmup with `generate: false` and waits for
`response.completed`. For a 5.6 Responses Lite model, warmup establishes the instruction and
`additional_tools` prefix. The following inference request can then send only the remaining
input with the warmup response ID.

The previous response snapshot is consumed when Rig constructs an incremental request, matching
Codex's `LastResponse::take()` behavior. It is not retained until that request succeeds, so any
retry after an error necessarily rebuilds and sends complete durable context.

For later requests, vanilla compares every context-bearing request property other than `input`,
stream delivery options, and client metadata. It then checks that:

```text
previous request input + previous response output items
```

is a prefix of the new rebuilt input. If both checks pass, only the suffix is sent with
`previous_response_id`. If any property or prefix differs, the same physical socket may be used,
but the complete request is sent without `previous_response_id`.

The physical socket, prior full request, `previous_response_id`, sticky turn state, and the
dedicated `LastResponse` snapshot used by WebSocket prefix comparison are memory only. Vanilla
also commits completed response items to conversation history and the rollout, but those durable
items support full-context replay; they do not restore the in-memory response chain optimization.
After process restart, reconnection, terminal stream failure, or abort, Rig must reconstruct a
complete request from the caller-provided context. The durable transcript is the authority.

An idle Responses socket can close without an active stream observing it. Rig checks the cached
socket before the next send, and also binds the OpenAI SDK's synchronously emitted send error to
the active provider stream. When either path proves the request was not sent, an established
session silently opens a fresh socket and replays the complete durable context once without
consuming an inference retry. Failures before the socket is warmed, repeated pre-send failures,
and any failure after a request may have been sent stay on the normal rollback and retry path. The
SDK error must never escape as an unhandled process rejection.

If the backend rejects a cached ID with `previous_response_not_found`, Rig discards that response
chain and retries once with the complete durable context. The failed request has produced no
response content or tool effects, so this replay is safe and does not consume a transport retry.

Rig ignores only `internal_chat_message_metadata_passthrough` during prefix comparison.
Response-item IDs remain significant, so changing an otherwise equal opaque item's ID forces a
full request without `previous_response_id`.

## Streaming and response-item lifecycle

Responses output is indexed. Reasoning, commentary text, function calls, custom calls, native
tool-search calls, and final text may occupy separate output items. Their `output_index` order is
the durable order; code must not assume a single reasoning item followed by one tool and one text
message.

Rig maps the provider stream into:

- reasoning and text deltas;
- encrypted reasoning;
- tool-call start, delta, and end events;
- token usage;
- a terminal normal, tool-call, length, cancelled, or error event.

Completed opaque output items are retained in their original order. The outer runtime must
persist assistant text, tool calls, tool results, tool-call vendor metadata, encrypted reasoning,
and opaque `responseItems`. The next full-context request uses opaque items when available and
reconstructs function, custom, or tool-search items only when they are absent.

`block_start`, `block_stop`, and `block_reset` are Rig's rollback adapter, not native Responses
events. A run starts one tentative block. Successful inference ends it. A retry, fallback,
failure, or cancellation resets it so already emitted deltas can be removed before a replacement
attempt. A block has no declared type and does not constrain the provider's output-item
interleaving.

## Retries and fallback

Codex owns inference retries. The outer agent loop must not replay a provider request.

The shared inference retry budget defaults to ten retries after the initial request and is capped
at 100. It can change live through Rig's provider-neutral inference setting. The idle timeout is
five minutes. Retry precedence is deliberate: an exhausted account is terminal before anything
else is considered; explicit fatal provider codes are terminal even when `x-should-retry` says
`true`; `invalid_prompt`, `invalid_request_error`, `model_not_found`, and `permission_error` are
retryable even when that header says `false`; for every other code, `x-should-retry` is
authoritative. Without a directive, 408, 409, 429, 5xx responses, and common DNS, connection,
socket, and timeout failures are retryable. Abort is always terminal. Bounded `retry-after-ms` or
`retry-after` directives take precedence over exponential backoff starting at 200 milliseconds
with jitter.

An exhausted account is recognized by body rather than by status, because 429 also carries
ordinary throttling that waiting does fix. A 429 whose error body is `usage_limit_reached` or
`usage_not_included`, and any rejection carrying the `insufficient_quota` code, is terminal on its
first attempt and surfaces as `out_of_tokens`. Vanilla behaves the same way: it sets
`retry_429: false` and turns those bodies into `UsageLimitReached` and `UsageNotIncluded`. The
message names the plan and the reset time the way the native client does; the reset time comes
from the body's `resets_at`, then the `x-codex-primary-reset-at` header, then `retry-after`. Every
other 429 stays retryable, including a Bedrock `ThrottlingException`, which reaches
`CodexSession` through the same Responses path and is a genuinely transient rate limit.

Codex may retry a retryable mid-stream failure after output begins. Rig emits `block_reset`
before the retry and rebuilds the complete provider request, allowing the outer runtime to erase
the tentative attempt before replacement output arrives. Provider inference retries do not
execute tools; the outer agent loop never replays a tool, command, or session mutation.

WebSocket capability failures, including an upgrade-required handshake, can fall back directly
to SSE only while the shared retry budget has room for that attempt. WebSocket and SSE attempts
share one total retry budget. Attempt numbers reported to the caller remain monotonic across the
transport boundary.

ChatGPT credentials have a separate 401 path. Rig first reloads a matching `auth.json`, rebuilds
the client, and retries. If that credential is also rejected, Rig refreshes the token through the
Codex OAuth endpoint, atomically persists the result, rebuilds the client, and retries once more.

## Native compaction

OpenAI Codex compaction is a provider-native Responses operation. It is client-triggered rather
than silently scheduled by the server. The client decides when to compact, sends a normal
Responses stream request with a final `compaction_trigger` input item, and requires exactly one
native compaction output item followed by `response.completed`.

Manual compaction is a standalone turn with request kind `compaction`, trigger `manual`, reason
`user_requested`, implementation `responses_compaction_v2`, phase `standalone_turn`, and strategy
`memento`.

Codex compaction has fixed provider-native or local-checkpoint semantics.
`SessionCompactionOptions.instructions` currently has no effect in `CodexSession`; it is not
appended to the native trigger or the Bedrock checkpoint prompt.

Vanilla Codex automatically triggers compaction before inference when the active context reaches
90% of the model window or a model switch changes the compaction compatibility hash. Rig keeps
that policy outside the provider. `CodexSession.run()` never estimates the compaction threshold,
compares compaction hashes, or sends a `compaction_trigger`. The outer session manager decides
when to call `compact()`, persists the returned replacement context, and supplies that context to
the next run.

After successful remote compaction, Rig keeps up to approximately 64,000 tokens of recent real
user messages and appends the opaque compaction item. It does not manufacture a summary message
from that opaque value. Initial instructions and developer context are reintroduced by normal
request construction. The compaction window advances and the WebSocket response chain is
cleared.

Vanilla remote-v2 rewrites trailing function, custom, and tool-search output payloads when needed
to make room for compaction. Rig adds a unit-tested safety layer around that behavior: it
estimates the complete JSON request, removes older paired tool envelopes and history, truncates
the newest user message only as a last resort, and progressively tightens the fit after a server
context-window rejection. Those extra fitting stages are Rig adaptations rather than an exact
copy of vanilla. Remote compaction has the smaller vanilla retry cap of two.

Bedrock/Mantle has no proven native compaction response in the captured surface. Rig uses
vanilla's local checkpoint prompt through an ordinary Responses request with tools disabled. It
keeps up to approximately 20,000 tokens of recent real user messages and installs the returned
summary as a synthetic user checkpoint. This path is covered by deterministic tests, not by a
successful live Bedrock trace.

## Persistence boundaries

The caller supplies a full rebuilt `SessionContext` on every run. `CodexSession` compares that
context to its current in-memory state to find an append-only suffix, but the optimization is
never the persistence authority.

Persist these values durably:

- root instructions and ordered system, user, assistant, tool-result, and compaction messages;
- assistant text and tool calls;
- tool-call and tool-result `vendor` metadata;
- encrypted reasoning and ordered opaque `responseItems`;
- committed compaction replacement context.

Keep these values ephemeral:

- the physical WebSocket and HTTP connection pool;
- `previous_response_id`;
- the previous full request and response items used for prefix comparison;
- `x-codex-turn-state`;
- in-flight retry and tentative block state.

The installation ID is the intentional exception: it is durable machine identity, not
conversation state.

## Intentional Rig differences

- Rig uses one provider-neutral permission model. Codex tool schemas may request review or
  elevation, but no Codex-specific execution path may bypass `AgentContext` or
  `PermissionContext`.
- Rig's public session API requires full context while hiding the WebSocket suffix optimization.
  Vanilla owns its transcript internally; Rig's outer runtime owns the transcript.
- Rig has no Codex mode type, reset method, provider default model, or runtime model discovery.
- Rig never initiates compaction from `run()`. Threshold tracking, compaction-hash decisions, and
  persistence of replacement context belong to the outer session manager.
- Rig does not reproduce Codex UI, rollout tracing, hooks, telemetry, memory, shell snapshots,
  or native tool execution.
- Codex owns its native retry and fallback policy, including rollback-backed retry after visible
  output; the outer agent loop never retries inference itself.
- Rig emits rollback blocks around attempts; vanilla exposes Responses item lifecycle events.
- Rig sends a reduced core subset of vanilla's optional turn metadata. Subagent lineage,
  workspace telemetry, sandbox telemetry, and trace-only fields are not inference requirements.

## Remaining validation and hardening

The July 22, 2026 source and trace review's image serialization, ChatGPT 401 recovery,
response-item identity, mid-stream retry, captured-asset export, and dynamic user-agent findings
are covered by deterministic tests.

The Bedrock/Mantle fixtures remain request-only evidence. A successful response capture is not
available, so successful inference and local compaction are not claimed as live-verified. This
is the largest unverified surface in the vendor: whether Mantle accepts replayed encrypted
reasoning items across turns decides every multi-turn Bedrock conversation, and nothing in the
suite can currently catch it. A real multi-turn capture is the highest-value trace to collect.

A July 24, 2026 review of that path found and fixed three defects, each now covered by a test:

- a non-default `service_tier` reached Mantle, which serves GPT models on the implicit default
  tier only, so vanilla clears the tier for Bedrock models entirely;
- every Mantle rejection surfaced as `401 status code (no body)`, because AWS reports failures
  as a top-level `message` while the OpenAI SDK reads only a nested `error`;
- an expired AWS signature gave no indication that a credential had gone stale.

The same review found no cache-prefix instability on the Bedrock path: the prompt cache key is
the session id on every transport, the Bedrock request transform is pure, tool serialization is
ordered and deterministic, and forced SSE replay means turns only append.

Additional lower-risk observations:

- very high configured retry attempts can produce a JavaScript timer delay beyond Node's
  supported timer range;
- the idle-timeout wrapper relies on the underlying SSE or WebSocket transport reacting to
  abort;
- fitting extremely large compaction histories repeatedly serializes the request and can become
  expensive;

These observations must not be normalized away in golden tests.

## Updating the contract

When vanilla Codex changes:

1. Record the vanilla commit and installed CLI version.
2. Capture real SSE and WebSocket inference for 5.5, Sol, Terra, and Luna.
3. Capture two turns, native compaction, post-compaction continuation, a same-family switch, and
   a 5.6-to-5.5 switch.
4. Treat a request-only proxy rejection as request-shape evidence, never as live inference.
5. Regenerate prompt fragments and one-file-per-tool TypeBox definitions from the real captures.
6. Compare stable headers, request fields, item order, and incremental WebSocket input exactly.
7. Keep dynamic IDs, credentials, timestamps, encrypted reasoning, and host paths normalized.
8. Run all Codex golden, retry, response-item, compaction, credential, and live tests.

See `EXAMPLES.md` for short construction examples that use the captured instructions, system
messages, skills, and tool sets without adding hidden provider defaults.
