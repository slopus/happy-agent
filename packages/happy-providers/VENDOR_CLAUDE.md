# Claude Agent SDK transport

This package runs Claude through `@anthropic-ai/claude-agent-sdk`, while Rig remains the
owner of conversation persistence, tool execution, permissions, and the agent loop. The
provider intentionally uses Claude Code's inference, streaming, retry, replay, and native
compaction machinery without adopting Claude Code's native tools or security model.

## Reference behavior

The implementation is checked against:

- the installed Claude Agent SDK and its public `Options`, `SessionStore`, and SDK message
  types;
- the vanilla Claude Code source at `~/Developer/coding-assistant-sources/claude-code`;
- the native CLI trace in
  `tests/vendors/fixtures/claude-multiturn.json`;
- the real Rig-provider trace in
  `tests/vendors/fixtures/claude-provider-multiturn.json`.

Relevant vanilla sources include `src/QueryEngine.ts` for SDK messages and persistence,
`src/utils/conversationRecovery.ts` for transcript recovery, `src/services/api/withRetry.ts`
for retry behavior, and `src/services/compact/compact.ts` for native summaries and
`compact_boundary`.

## Runtime construction

The public `AnthropicProvider` selects the internal `ClaudeProvider` for Claude Code, OAuth,
auth-token, and API-key credentials; that implementation constructs `ClaudeSession.ts`. Each Rig
session receives a private UUID for the SDK's resume contract; the caller's Rig session ID remains
independent. Every run reconstructs the SDK transcript from the caller-supplied `SessionContext`
through `impl/createClaudeSessionReplay.ts` when a query is first created. Compatible subsequent
turns use the same streaming SDK query and subprocess, so the HTTP connection and prompt cache
remain live. Claude's filesystem transcript is not Rig's source of truth.

`impl/toClaudeSdkOptions.ts` deliberately strips the native Claude environment:

- `tools: []` disables native tools.
- `settingSources: []`, `skills: []`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, and the related
  environment flags disable native settings, CLAUDE.md loading, bundled skills,
  attachments, and built-in agents.
- `extraArgs["disable-slash-commands"]` disables ordinary slash commands. It is omitted
  only for a native `/compact` request.
- `permissionMode: "dontAsk"` prevents Claude Code from owning permission interaction.
- Native compaction alone uses `maxTurns: 1` and a closed prompt stream because `/compact`
  is a terminal SDK command; ordinary turns use the persistent prompt queue.

These settings are invariants. Enabling native tools or native permissions would bypass
Rig's shared `AgentContext` and permission boundary.

## System prompt and skills

The complete model-specific runtime prompts live in `rig-execution`. The provider receives
the already assembled instructions through `SessionContext`; prompt files in this package
are test assets, not runtime prompt sources.

`impl/toClaudeSdkOptions.ts` supplies the session instructions assembled by the executor, and
nothing else. Skill metadata is ordinary caller-supplied prompt content that arrives that way,
so the provider composes nothing of its own.

Session `system` messages are not prompt content. Anthropic exposes no system role once a
conversation is under way, so `impl/createClaudeSessionReplay.ts` projects each one onto a user
turn wrapped in `<system-reminder>`, in the position the caller chose. This matches how Claude
Code delivers out-of-band notices, and it keeps a mid-conversation notice from rewriting the
cached prompt prefix.

The SDK adds its own small SDK identity and billing blocks on the final Anthropic request.
The Rig prompt remains a distinct complete system block; the provider golden fixture
captures the resulting full wire request.

Rig supplies skill name, description, source, and location as prompt metadata. It does not
enable Claude Code's expanded native skill runtime. Loading skill contents remains a Rig
agent-loop concern.

## MCP tools and schemas

The provider has no default tool catalog. The Rig agent owns Claude definitions one tool
per file under `packages/rig/sources/agent/tools/claude/`, converts them to `SessionTool`,
and supplies the exact set for each run. The same caller-owned set remains stable across
compatible model switches.

Independent model-specific golden definitions remain one tool per file under
`sources/vendors/claude/tools/`. They are test and trace-capture assets, not runtime
fallbacks. The parity tests compare their complete tool names and model-facing argument
shapes with the executable Rig tools, and compare changed contracts exactly.

`impl/toClaudeSdkOptions.ts` creates an in-process MCP server named `rig`. Its `tools/list`
handler returns each `SessionTool` description and TypeBox schema directly as MCP
`inputSchema`; there is no TypeBox-to-Zod rewrite. This preserves constraints such as
integer bounds, unions, descriptions, required fields, and `additionalProperties`.

The SDK receives:

- `allowedTools` containing `mcp__rig__<name>`;
- `CLAUDE_AGENT_SDK_MCP_NO_PREFIX=1`, so the model sees Rig-compatible unprefixed names;
- `tools: []`, so no native tool definitions are mixed into the request.

The MCP call handler waits on `ClaudeToolBridge`. Rig returns the emitted call to its own
agent loop, executes it through the shared permission boundary, and supplies the committed
result to that pending MCP call on the next run. The bridge keeps resolver and early-answer
maps keyed by tool-call ID, so either side may arrive first and every parallel call settles
exactly once. The SDK query stays alive throughout.

## Streaming and external tools

`ClaudeSession.ts` maps Claude streaming blocks into Rig events:

- text and thinking deltas become `text_delta` and `reasoning_delta`;
- signatures become `encrypted_reasoning`;
- tool-use starts, JSON deltas, and block stops become
  `tool_call_start`/`tool_call_delta`/`tool_call_end`;
- usage becomes `token_usage`;
- the terminal state is `tool_call`, `normal`, or `error`.

Rig persists the assistant tool call, executes it, and invokes the session again with the
corresponding tool-result message. On a live query, `ClaudeToolBridge` resolves Claude's
pending MCP request with text and image content and the same SDK process continues.
Reconstructed sessions retain `sourceToolAssistantUUID`, which lets vanilla Claude
associate results with their tool-use assistant.
Rig also preserves the tool result's `isError` bit through both the live MCP response and
the reconstructed Claude `tool_result.is_error` block.

Vanilla `conversationRecovery.ts` behavior is used only when a session must be reconstructed,
such as after a model or compaction configuration change. Normal tool continuation does not
interrupt or replay the query.

Multiple parallel tool results are grouped into one Claude user replay entry containing every
`tool_result` block and linked to the originating assistant. The next explicit Rig prompt
starts the next user turn.

## Multi-turn replay, images, and model switching

For a first one-message turn, the SDK receives a fresh `sessionId`. For reconstructed
history, `impl/createClaudeSessionReplay.ts` supplies an in-memory `SessionStore` and
`resume` ID. Stable UUIDs preserve parent ordering across a replay without writing a
Claude transcript to disk.

User messages and tool results may contain ordered text and base64 image blocks. Replay
maps them to Claude-native `text` and `image` content blocks. Assistant history includes
every faithfully representable signed thinking block, followed by text and tool-use blocks.
Each assistant content block is stored as a separate transcript entry with one shared API
message ID and an unbroken parent chain, matching Claude Code's native transcript shape.
This preserves thinking and parallel tool-use siblings when the SDK reconstructs a request.

The caller-owned Rig history remains authoritative and is never rewritten by replay. The
in-memory `SessionStore` ignores transcript entries appended by the SDK; it only observes a
native compaction summary as the explicit result of `compact()`. Claude's SDK may project
completed-turn thinking out of the outgoing API request when required by the active model or
trajectory. That request-time projection does not change Rig's supplied session context.

A run-level model overrides the active model and is retained for later turns and
compaction. Replay serializes historical assistant entries with the currently selected
model because the SDK entry type requires a model; the actual next request uses the
selected model. The real provider trace switches from Opus to Sonnet and verifies the
selected prompt and stable caller-owned tools on the wire.

## Retries

Vanilla Claude Code retries retryable transport and API failures before producing a final
result. Its default is ten retries and it emits SDK `system/api_retry` messages containing
the attempt, maximum, delay, category, and HTTP status.

Rig sets `CLAUDE_CODE_MAX_RETRIES` from the shared inference retry budget, whose default is ten,
overriding inherited values so provider behavior is stable and follows live configuration.
`impl/toClaudeRetryEvent.ts` converts each native
retry notification into a Rig `retrying` event. Those retries remain inside Claude Code, avoiding
duplicate tool or session effects.

Claude Code can instead terminate with a synthetic server error when a stream breaks after output
has begun. Rig recognizes that specific incomplete-response result, rolls the open event block
back, recreates the private SDK query, and retries against the same caller-owned context. Recreated
queries receive only the retries left in the shared budget, so this recovery cannot exceed the
configured limit or commit partial text and tool-call events twice.

Every other terminal result — a spent account, a rejected credential, an unrecognized failure from
the Claude Code CLI — retries under the separate `inferenceFatalRetries` budget, which defaults to
zero so each is normally reported the moment it happens. Fatal failures spend their own counter, so
the mid-response server-error recovery above cannot starve them and the other way around: once that
recovery's own budget is exhausted, its failure ends the run rather than rolling into the fatal
budget, because it is transient by nature and already had its dedicated retry. Context overflow is
never retried, because only a smaller context can fix it and the caller owns compaction. Because the
CLI's own error paths already emit `block_reset` before the terminal result, a fatal retry replays
through the same clean rollback boundary as the mid-response case, so no output is committed twice.

## Native compaction

`ClaudeSession.compact()` appends either `/compact` or `/compact <retention instructions>`
to the reconstructed context and temporarily enables slash-command handling. This invokes
Claude Code's native compactor, not a Rig-authored summarization request.

The SDK persists the native `isCompactSummary` entry into the in-memory `SessionStore` and
emits `compact_boundary`. The provider requires both successful boundary completion and a
non-empty persisted summary. It then returns replacement Rig context containing the
initial messages plus Claude's native summary. A failed native status, missing summary,
tool call, or cancellation leaves the original context active.

For this local slash command, the SDK's terminal `result.usage` is zero even though the
compaction made a real inference request. The same result's `modelUsage` map carries the exact
input, output, cache-read, and cache-creation counts from that request. Its keys may use the
resolved model name instead of the requested alias, so the provider aggregates every entry into
the completed compaction usage.

The provider fixture covers custom retention instructions and post-compaction continuation.
`tests/claude.live.test.ts` separately covers real native compaction without custom
instructions.

## Credentials and lifecycle

Before spawning Claude, `impl/toClaudeSdkOptions.ts` removes
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN` from the inherited
environment and sets exactly the selected credential. This prevents a stale host
credential from taking precedence.

The provider also removes `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` and the inherited Bedrock,
Foundry, and Vertex backend selectors. This prevents host configuration from silently
changing the selected Claude transport.

`claudeSdkPrivacyEnvironment.ts` carries the original Rig privacy environment and the
package-level compaction constraint. It disables Anthropic and standard OpenTelemetry
exporters, prompt/tool-content logging, enhanced telemetry, Perfetto tracing, error and
feedback reporting, surveys, updater and plugin-updater traffic, and nonessential Claude
traffic. The complete environment is applied both to the SDK subprocess and to
`settings.env`; inherited values cannot re-enable these paths.

`DISABLE_AUTO_COMPACT=1` prevents Claude Code from compacting autonomously. Rig deliberately
does not set `DISABLE_COMPACT`, so an outer-loop request can still invoke native manual
`/compact`.

Rig abort signals immediately stop the active turn, close the prompt queue, MCP bridge, SDK
query, and subprocess, and rotate the private SDK session ID. The next prompt therefore starts
a fresh Claude SDK session instead of resuming a query that may still be waiting for tool
results. The listener is removed on normal completion, error, synchronous query-construction
failure, or cancellation. The same resources are also closed by `destroy()`, or when model,
effort, tools, prompt, or compaction mode changes.

## Trace and test coverage

`tests/vendors/captureClaudeTrace.mjs` captures vanilla CLI behavior with real inference,
native tools and skills, model switching, and native `/compact`. It is a reference for
Claude Code behavior, not a Rig-provider replay.

`tests/vendors/captureClaudeProviderTrace.ts` runs the real `ClaudeSession` through a local
forwarding proxy and records actual Anthropic requests and SSE responses. Its scenario
covers a Rig MCP tool call, external tool result, another turn, model switch, native
compaction with retention instructions, and post-compaction continuation.

`tests/vendors/claudeGolden.test.ts` replays the provider fixture through the real SDK and
compares every normalized request body exactly. Dynamic IDs, paths, timestamps, signatures,
and the SDK current-date reminder are normalized. `tests/claudeSession.test.ts` covers
message mapping, retry events, credential isolation, abort cleanup, images, models, and
plain/custom compaction. `tests/claude.live.test.ts` verifies real inference, complete
system prompts and schemas, model switching, both compaction forms, and continuation.

## Intentional limitations

- Rig owns persistence; native Claude transcript files are not authoritative.
- Rig owns all tool execution and permissions; the SDK MCP handler only waits for the
  result committed by Rig.
- Claude Code settings, CLAUDE.md, attachments, native agents, and native skills remain
  disabled.
- Each Rig run returns one terminal outer-loop state. A compatible sequence of runs shares
  one live Claude SDK query and subprocess.
- The provider does not reproduce every Claude Code UI, hook, plugin, IDE, or local-command
  feature.
- Provider model catalogs are curated elsewhere in Rig; the SDK is not used for model
  discovery.
