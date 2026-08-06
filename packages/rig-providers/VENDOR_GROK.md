# Grok provider

This package talks directly to Grok's OpenAI-compatible Responses endpoint while Rig remains
the owner of conversation persistence, tool execution, permissions, and the agent loop. The
provider reproduces the production behavior of the vanilla Grok CLI where that behavior is
observable and keeps provider-specific mechanics inside `GrokSession`.

## Evidence and provenance

The implementation is checked against:

- the open-source Grok Build checkout at `.context/grok-build-source`, pinned by
  `SOURCE_REV` to `30192d2eef5d91a8fff0e53957de5bd05b43398c`;
- the installed vanilla CLI, `grok 0.2.111 (94172f2aa4e5) [stable]`;
- real requests and SSE responses captured from that CLI in
  `tests/vendors/fixtures/grok-4-5-{low,medium,high}.sse.json`;
- a real four-turn, `/compact`, and post-compaction CLI session captured in
  `tests/vendors/fixtures/grok-4-5-compaction.sse.json`;
- the generated prompt and TypeBox tool definitions in `sources/vendors/grok/prompts/` and
  `sources/vendors/grok/tools/`;
- deterministic provider replay and behavior tests under `tests/vendors/grok*.test.ts`;
- `tests/grok.live.test.ts`, which exercises real inference, encrypted-reasoning tool
  continuation, and compaction.

Grok Build is open source. Its checkout in `.context` is the authority for structural invariants
such as compaction assembly, summary sampling, retry classification, and message semantics. The
installed CLI is a versioned Mach-O build, so the captured live wire contract remains the
authority for what version 0.2.111 actually sent. When newer source and the installed trace
differ, this document names the difference instead of presenting either one as universal.

Relevant source files include:

- `crates/common/xai-grok-compaction/src/code_compaction/{assemble,sample,summary}.rs`;
- `crates/codegen/xai-chat-state/src/compaction_utils.rs`;
- `crates/codegen/xai-grok-sampler/src/client.rs`;
- `crates/codegen/xai-grok-shell/src/session/helpers/session_compact.rs`.

`tests/vendors/captureGrokTrace.mjs` and `captureGrokCompactionTrace.mjs` run the real CLI in an
isolated temporary home, route only its Responses requests through a recording proxy, forward
them to `https://cli-chat-proxy.grok.com/v1`, and save the actual request and SSE stream. Dynamic
IDs, paths, and encrypted reasoning are normalized or redacted; prompt text, tool schemas,
message order, request options, stable headers, and event structure remain real.

## Supported production surface

The provider supports only `grok-4.5`. The model catalog is curated by Rig rather than fetched
from Grok at runtime. `GrokProvider` accepts a credential, optional endpoint, and optional model.
A model must be supplied either on the provider or on each inference run. Compaction uses the
provider model when configured and otherwise reuses the model selected by the latest run.

The default endpoint is `https://cli-chat-proxy.grok.com/v1`. A custom endpoint is useful for
tests and compatible gateways, but proxy-only authentication headers are emitted only for the
known Grok proxy boundary.

The session consumes text and image-capable Rig context and produces text, reasoning, tool calls,
usage, retry notifications, and terminal events. Rig executes every emitted tool externally and
supplies the committed result on the next run.

## Credentials and request identity

`GrokSessionCredential.tryLoad()` reads the OAuth session entry from Grok's auth store.
`GrokApiKeyCredential.tryLoad()` checks an explicit key, `XAI_API_KEY`, and then the API-key entry
in the same store. Callers choose precedence; the normal example prefers the CLI session and
falls back to an API key.

`impl/createGrokRequestHeaders.ts` reproduces the stable vanilla request identity:

- one Rig session ID is reused as the Grok agent, conversation, and session ID;
- every HTTP attempt receives a new request UUID;
- `x-grok-client-identifier` is `grok-shell`;
- `x-grok-client-version` is pinned to the captured CLI version;
- `x-grok-model-override` carries `grok-4.5`;
- ordinary turns carry `x-grok-turn-idx`;
- compaction intentionally omits the turn index;
- the default proxy additionally receives its authentication-response, headless-mode, and token
  authentication headers.

The OpenAI client supplies the selected bearer credential. Credentials and opaque encrypted
reasoning must never be written unredacted into golden fixtures.

If the proxy rejects a request with HTTP 401, a session credential first adopts a newer token
already written by Grok CLI. If the stored record instead contains OIDC refresh metadata, it
discovers the issuer's token endpoint, refreshes the access token, rebuilds the client, and
replays the request once. API-key credentials are never refreshed.

## System prompt and user-message shape

Rig does not silently inject Grok defaults in `GrokProvider`. The caller supplies the complete
session instructions and tools. To reproduce vanilla Grok 4.5, use
`grok_4_5_system_prompt` and `grok_4_5_tools`, both exported by this package.

`impl/toGrokResponseInput.ts` emits the root instructions as the first Responses `system`
message. That is the only `system` message on the request. Grok has no system role once a
conversation is under way, so each additional Rig `system` message becomes a user turn wrapped
in `<system-reminder>`, in the position the caller chose, matching how vanilla Grok delivers
project instructions and other out-of-band notices. User messages are forwarded as supplied.
The vanilla prompt expects actual user queries inside `<user_query>` tags, so the outer runtime
is responsible for that presentation.

The prompt and every built-in tool definition are literal captured assets, formatted as normal
TypeScript rather than embedded request JSON. `tests/vendors/generateGrokGoldenAssets.mjs`
regenerates them from the live fixtures. Prompt strings are split over readable source lines
without changing their newlines, and every tool schema uses TypeBox.

There are 26 captured Grok 4.5 tools. They live one tool per file under
`sources/vendors/grok/tools/` and are assembled by `tools/index.ts`. They are model-facing
definitions only: supplying them does not grant Grok permission to execute them.

## Tool definitions and execution

`impl/toGrokToolDefinitions.ts` maps each `SessionTool` to a Responses API function definition
with its name, description, and JSON Schema. TypeBox constraints, required properties, unions,
descriptions, and `additionalProperties` survive conversion. The `spawn_subagent` description is
adjusted when `web_search` is absent so the prompt does not advertise an unavailable tool.

Rig's shared agent loop owns execution and permissions. The Grok-specific names and schemas shape
model calls, but they do not create a Grok-specific security path. In particular,
`run_terminal_command`'s `sandbox_permissions: "require_escalated"` field is only a request for
Rig's shared permission review and temporary elevation.

Most calls use Responses `function_call` and `function_call_output`. The continuation mapper also
supports `custom_tool_call` and client-executed `tool_search_call`. `GrokToolVendor` metadata
records which wire representation must be reconstructed. Without that metadata, an ordinary
function call is the safe default.

## Hosted search

Grok performs web and X search on its own backend. Nothing runs locally and no result is ever sent
back to it: the model issues the search, reads it, and answers with citations inside a single
response. Rig's own web search cannot see X at all, so this is the only way a Grok session gets
live posts.

A hosted tool is declared by type alone — `{"type": "web_search"}` and `{"type": "x_search"}` —
because the backend owns its schema. `sources/vendors/grok/tools/hosted_web_search.ts` and
`hosted_x_search.ts` are those declarations, exported together as `grok_hosted_tools`, and
`impl/toGrokToolDefinitions.ts` emits any `type: "cloud"` tool in that shape. They are kept apart
from `grok_4_5_tools`, which remains a literal capture of what CLI 0.2.111 sent, including the
older client-executed `web_search` function.

Consistent with the rest of this provider, nothing is injected silently. A caller opts in through
`GrokProviderOptions.hostedTools`, which `GrokConnection` sends alongside the tools Rig executes.

That opt-in is where Rig's boundary lives, because there is nowhere else for it to live. Every
other network tool in Rig is a `ToolDefinition` with a schema, a handler, and a permission policy,
so Rig decides at call time whether it may run. A hosted tool has none of that: it is declared in
the request and executed during the response, and by the time Rig sees anything the search has
already happened. Declaring it is the decision.

Rig therefore gates the grant rather than the call. An agent holds a hosted search only because a
reviewed spawn granted it one, or because the user named it in `providers.grok.hosted_search`, and
`grokExecution` declares exactly what that agent was granted and nothing else. The rules guarding a
grant are in `rig/sources/session/hostedCapabilityGrants.ts`: an agent that cannot reach outside
Rig's sandbox itself cannot grant one, an agent that already holds one cannot pass it on, and an
agent holding one cannot spawn at all. What an agent ends up declaring is resolved in
`rig/sources/runtime/resolveHostedCapabilities.ts`.

X search reaches the client as ordinary `custom_tool_call` items named `x_keyword_search` or
`x_semantic_search`; web search has its own `web_search_call` item. Neither may be mistaken for a
call Rig must answer, so `mapOpenAIResponseStream` reports them as `server_tool_call_start`,
`server_tool_call_delta`, and `server_tool_call_end`, keeps them out of the run's tool calls, and
leaves the terminal state `normal` rather than `tool_call`.

Classification rests on two facts true only of a hosted call. The request must have declared hosted
tools, carried by `hostedToolNames`: nothing runs upstream that was never enabled. That alone keeps
compaction out of this path, so a compaction sample that calls a tool is still counted as one and
resampled. Beyond that, Grok marks its own search calls with the reserved `xs_` call-id prefix,
which stays correct even if a client tool happens to share a backend sub-call's name; absent that
marker, a name the client never declared is the fallback, so a sub-call named in some way we have
not captured is still not mistaken for work Rig owes an answer. Function calls never qualify,
because an undeclared function name is a model mistake the model needs to hear about. A mapper
given no `hostedToolNames` treats every tool call as client-executed, so Codex and Bedrock behavior
is unchanged.

Hosted calls are settled against the terminal response the way ordinary tool calls already are. One
that streamed a start but never its completion is closed using the terminal payload's arguments,
and one that appears only in that payload still reports both a start and an end, so the durable
record of a search never depends on which streamed events happened to arrive.

Results live in the encrypted reasoning items that follow each call, so replay needs no special
case: the opaque `responseItems` return verbatim and nothing fabricates a tool output to pair with
them. `tests/vendors/grokHostedSearchGolden.test.ts` pins this against captured CLI 0.2.118
traffic in `grok-4-5-x-search.sse.json` and `grok-4-5-web-search.sse.json`, and
`tests/grok.live.test.ts` covers it against the real backend.

## Inference request

`impl/createGrokOpenAIRequest.ts` sends:

- `model: "grok-4.5"`;
- the complete rebuilt input transcript;
- `stream: true`;
- `store: false`;
- `include: ["reasoning.encrypted_content"]`;
- `reasoning.summary: "concise"`;
- the requested `low`, `medium`, or `high` reasoning effort;
- the supplied Rig tool definitions.

Ordinary inference does not set `temperature` or `top_p`. The low, medium, and high fixtures prove
the request body, system prompt, selected tool schemas, stable headers, encrypted reasoning, and
normal completion against real CLI traffic.

The session tracks a logical user-turn index. A tool call and its externally supplied tool result
remain part of the same turn and reuse the same header value. The index increments only when the
rebuilt context introduces another real user query.

## Streaming and durable continuation

`impl/mapGrokResponseStream.ts` maps Responses SSE events into Rig events:

- reasoning text becomes `reasoning_delta`;
- completed opaque reasoning becomes `encrypted_reasoning`;
- assistant text becomes `text_delta`;
- function, custom, and client tool-search calls become typed tool-call events;
- completed native output items become one `response_items` event for durable exact replay;
- usage becomes `token_usage`;
- terminal responses become `normal`, `tool_call`, `length`, or a typed error.

A stream that closes without a terminal Responses event is a transport failure, not a successful
partial answer. `response.incomplete` with `max_output_tokens` yields a `length` terminal state.
API `response.failed` events surface their provider message.

The outer runtime must persist the assistant text, tool calls, tool results, opaque
`responseItems`, encrypted reasoning, and vendor metadata before the next run. On replay,
`toGrokResponseInput.ts` restores opaque response items when present. Otherwise it reconstructs
the encrypted reasoning item before its tool calls, then the corresponding outputs and any later
assistant text. This ordering is required for Grok to accept and continue an encrypted-reasoning
tool turn.

Run output is enclosed in a commit block. A successful response closes the block before its
terminal event. Cancellation or failure resets the block and emits an explicit terminal event, so
partial text, reasoning, and tool calls cannot be mistaken for committed transcript state.
`GrokSession` also retains the complete successful assistant response internally so an immediate
`compact()` includes it even before the outer runtime begins another run.

Malformed opaque response items, encrypted reasoning, or tool-search payloads are ignored rather
than submitted as corrupt API input. They should still be treated as persistence corruption by
the outer system; dropping them may reduce continuation fidelity.

## Provider-owned retries

Retries are owned by `GrokSession`, not by the outer agent loop. Ordinary inference retries only
retryable transport failures before response content begins. It never replays a completed tool,
command, or other session mutation.

The captured production policy is represented by `impl/grokRetry.ts`:

- retryable HTTP statuses are 429, 500, 502, 503, 504, and 520;
- common DNS, connection, socket, timeout, and premature-stream failures are retryable;
- aborts and `x-should-retry: false` are terminal;
- `retry-after-ms` and `retry-after` are honored;
- otherwise delay starts at two seconds, doubles to a 30-second cap, and adds jitter;
- retries use the shared inference budget, defaulting to ten retries after the initial request;
- the first ordinary transport retry rebuilds the connection pool with HTTP/2 disabled;
- a 413, or a 400/500 containing `Could not process image`, removes image blocks while preserving
  text and message order, then replays once.

Every retry emits a `retrying` event. Once ordinary user-visible content, reasoning, encrypted
reasoning, or tool-call output begins, a later transport failure is terminal.

Compaction is a special read-only inference. It can retry its inference transport after partial
summary output because no summary is committed until an entire attempt is accepted. When that
happens, Rig clears all text, reasoning, usage, and tool-call state from the interrupted sample
before consuming the replacement stream. Samples must never be concatenated. Compaction also has
a separate bounded resampling loop for invalid model output, described below.

## Compaction request

Grok CLI compaction is model-generated local compaction, not an opaque server compaction endpoint.
The real `/compact` trace shows a normal unnumbered Responses request containing the complete
pre-compaction conversation plus one final synthetic user message:
`grok_compaction_prompt`.

`GrokSession.compact()` snapshots the active context and builds that temporary request without
mutating the session. The compaction request uses the same model, complete system prompt, all
configured tools, and entire prior transcript. It additionally sets `temperature: 1` and
`tool_choice: "auto"`, matching the live CLI trace. It requests concise encrypted reasoning just
like ordinary inference and omits `x-grok-turn-idx`.

Optional `SessionCompactionOptions.instructions` are inserted into the captured compaction prompt
as user-provided retention context. They do not create a new persistent reminder or message. The
provider works only with the context it was given; there is no callback for regenerated skills,
fresh reminders, or other external context.

The summary prompt requires a single `<summary>...</summary>` block with nine named sections,
including all user messages, current work, pending tasks, and an optional next step. It explicitly
forbids tool use and instructs successive compactions to carry forward still-relevant information
from an earlier continuation summary.

## Compaction validation and resampling

One compaction attempt consumes text deltas as the raw summary and records encrypted reasoning and
usage. Tool calls make the attempt invalid. A summary shorter than 500 characters after cleanup is
considered degenerate.

The provider makes at most three summary-validation attempts. Invalid short summaries and
tool-calling attempts are resampled after a bounded, abortable delay. Each validation attempt may
internally replace a retryable interrupted transport stream, but only the final independent
sample is validated. If all three fail, `compact()` returns `failed` with kind `invalid_summary`
or `tool_call`. Deterministic inference failures such as authentication, configuration,
serialization, idle-timeout, max-token truncation, invalid-request, and context-overflow errors
return `inference_error` immediately. Transient compaction failures, including HTTP 408, 429, and
5xx responses, consume another independent validation attempt before returning
`inference_error`. Cancellation returns `cancelled`.

Failed and cancelled compactions preserve the exact original context as the active session
context. The synthetic summary request and any partial model output never leak into later
inference.

A non-degenerate summary that reaches `response.incomplete` because of the output-token limit is
accepted. This matches the practical invariant that usable compaction text is better than
discarding a long summary solely because the terminal event reports truncation.

## Compaction commit and preserved messages

After a valid summary, `formatGrokCompactionSummary.ts` removes leading scratch analysis, converts
the outer summary block to a readable `Summary:` section, collapses excessive blank lines, and
neutralizes embedded summary and analysis control tokens. The raw summary is used to construct
the continuation, while the cleaned form is exposed as `SessionCompaction.summary`.

The live four-turn trace establishes that every pre-compaction turn is supplied to the summary
inference, but only selected original messages survive beside the generated continuation:

1. the first `<user_info>` message, if present;
2. every project-instructions `<system-reminder>` mentioning `AGENTS.md` or project instructions;
3. only the latest real `<user_query>`, rewrapped in canonical tags;
4. a synthetic user continuation containing the generated summary;
5. the latest non-project state `<system-reminder>`, if one already existed.

Earlier ordinary user queries, assistant messages, tool calls, tool results, and reasoning are
discarded from the replacement context because their relevant state must be represented by the
summary. The latest real user query is preserved independently to keep the active task anchored.
Existing state reminders are repositioned after the continuation; the provider does not generate
or refresh them.

This paragraph is specifically the observed CLI 0.2.111 completed-turn contract. The pinned
open-source assembler has since generalized the canonical order to
`[system, user info, project instructions, latest real query, recent assistant/tool tail, summary,
state reminder]`. Its `extract_messages_since_last_real_user` retains assistant messages after the
last real user query and replaces tool-result bodies with `Tool call omitted...` so an in-flight
tool sequence is not orphaned. Rig does not currently reproduce that newer mid-turn tail: its
structural compaction matches the captured 0.2.111 trace and should be invoked at a completed
outer-loop boundary. Supporting mid-tool-loop compaction requires an explicit context-tail
contract and a new live trace before changing this ordering.

Vanilla source distinguishes synthetic messages through typed metadata. Rig's generic
`SessionMessage` currently has no equivalent synthetic-reason discriminator, so the provider uses
structural text predicates: `<user_info>`, `<user_query>`, the continuation preamble, and
`<system-reminder>` prefixes. Project instructions are identified by an `AGENTS.md` or
`project instructions` marker. This is necessarily less precise than Grok's typed source model;
outer runtimes should use the canonical wrappers and avoid placing those reserved prefixes in
ordinary user text.

`preservedMessages` contains only the retained original user-info, project-instruction, and latest
query messages. It does not contain the generated continuation or repositioned state reminder.

The completed `SessionCompaction` contains:

- `status: "completed"`;
- the cleaned plain-text `summary`;
- opaque `encryptedReasoning` from the summary inference when emitted;
- the original `preservedMessages`;
- summary-inference `usage` when emitted;
- `context`, the complete replacement context already installed in the session.

The compaction call's opaque encrypted reasoning item is returned for observability and durable
state, but it is not an encrypted summary and is not inserted into the replacement context. The
continuation summary is plain text. Callers must replace their old model context with
`result.context`; appending it to old history defeats compaction and duplicates the conversation.

After commit, the replacement messages become the session's new initial messages. The first
post-compaction run appends only the caller's rebuilt suffix, and the compaction instruction itself
is absent. The golden trace verifies that no pre-compaction assistant messages remain and that the
follow-up model still recovers facts from all four summarized turns.

## Trace and test coverage

`tests/vendors/grokSseGolden.test.ts` replays all three reasoning-effort fixtures through the real
provider and compares the normalized request body, tool definitions, headers, response mapping,
and completion.

`tests/vendors/grokCompactionGolden.test.ts` proves the vanilla CLI version, real `/compact`
request, 26-tool request, unnumbered compaction header, exact prompt, four-turn summary input,
latest-query preservation, continuation shape, reminder position, and post-compaction request.

`tests/vendors/grokContinuationGolden.test.ts` covers encrypted reasoning, function/custom/search
tool representations, tool outputs, assistant continuation, reasoning effort, usage, incomplete
responses, typed failures, and missing terminal events.

`tests/vendors/grokCompactionBehavior.test.ts` covers invalid summaries, tool calls during
compaction, three-attempt failure, resampling, custom retention instructions, abort safety,
summary cleanup, existing-reminder repositioning, and turn-index behavior.

`tests/vendors/grokRetry.test.ts` covers the retry classification and delay contract.
`tests/grokImages.test.ts` covers native image-error recovery, and
`tests/grokCredential.test.ts` covers OIDC refresh after an unauthorized response.
`tests/grok.live.test.ts` separately verifies real tool-less inference, encrypted-reasoning tool
continuation, and structural compaction against Grok 4.5.

## Intentional limitations

- Rig owns transcript persistence, tool execution, and permissions; Grok CLI local session files,
  native tools, and its permission UI are not authoritative.
- Only Grok 4.5 is supported. Models are not discovered from Grok during startup.
- The complete vanilla prompt and tools are exported assets, not hidden defaults. Hosted search is
  likewise opt-in through `hostedTools`; a session that asks for nothing gets nothing.
- Hosted search other than web and X search is unobserved. Grok reports code interpreter, file
  search, MCP, document search, and image generation in its usage details, but Rig declares only
  the two it has captured.
- The outer runtime must wrap real queries and supply runtime reminders; the provider does not
  synthesize fresh context during compaction.
- OAuth recovery updates the active Rig session in memory. Grok CLI remains the owner of its auth
  store, so Rig does not overwrite that external file with refreshed credentials.
- Compaction is a provider-owned summarization inference because that is how the observed vanilla
  CLI implements `/compact`; it is not a generic outer-loop summarizer.
- Mid-tool-loop compaction's recent-message tail from the current open-source assembler is not yet
  implemented; invoke structural compaction at a completed outer-loop boundary.
- Synthetic message classification is wrapper-based because Rig does not expose Grok's typed
  synthetic-reason metadata.
- Exact behavior is pinned to CLI 0.2.111. A CLI upgrade requires new live captures and regenerated
  prompt/tool assets before changing the production contract.
- Unobserved Grok UI, memory, scheduler, subagent, telemetry, upload, or experimental features are
  outside this provider contract.
