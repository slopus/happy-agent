# @slopus/rig-providers

Low-level inference integration with every model vendor Rig supports.

This package owns the network: connections, transports, framing, stream decoding, retries, error
parsing, and credentials. It deliberately reproduces each vendor's real client behavior rather
than normalizing vendors into a lowest common denominator. Everything above inference — the agent
loop, tool execution, permissions, and conversation persistence — lives outside this package.

Its purpose is to make the network layer reliable and predictable, so that what reaches a vendor is
always exactly what should have been sent. Mistakes at this layer rarely raise an error; they show
up as quietly worse model output, which is why the behavior here is pinned to real captured
traffic.

This document describes the external protocol so a caller never needs to read the implementation.
[AGENTS.md](AGENTS.md) states the requirements that bind changes to this package.

## The shape of the interface

Three abstractions, in `sources/core/`:

```
BaseProvider  →  .session(id, options)  →  BaseSession  →  .run(request) → SessionStream
                                                        →  .compact(options)
                                                        →  .fork()
                                                        →  .destroy()
```

Providers are **stateful**. A session is created once, used for many turns, and destroyed. This is
what makes connection reuse, prompt caching, sticky turn state, and native compaction possible, so
sessions are not interchangeable with one-shot request helpers.

### One inference at a time

`run` is exclusive: a session never has two inferences in flight at once, and callers must not
start a second `run` before the previous stream reaches its terminal `done` event. The
implementation depends on this — one connection, one sticky turn state, one cache prefix.

To branch, use `fork` rather than a second concurrent `run`. `fork` copies the session's entire
internal state, including its session ID, so the fork is a continuation of the same conversation
rather than a new one, and the two sides can then run independently without observing each other's
turns.

Keeping the ID means the fork inherits the parent's warm cache. The motivating case is compacting
ahead of the context limit: compaction runs on a fork while the original stays live, and when it
finishes the caller switches to the fork and appends the messages that were not compacted — no
pause, no cold prefix.

> `fork` is a required part of this contract but is **not yet implemented** on `BaseSession`.
> Until it lands, there is no supported way to branch a session.

## Creating a provider

Each vendor exports its own provider class and options. A credential is always required; a model
may be fixed at construction or supplied per run.

```ts
import { CodexProvider, CodexSessionCredential } from "@slopus/rig-providers";

const credential = await CodexSessionCredential.tryLoad();
if (credential === null) throw new Error("No local Codex credential.");

const provider = new CodexProvider({ credential, transport: "websocket" });
```

Available providers: `CodexProvider`, `ClaudeProvider`, `GrokProvider`,
`AnthropicBedrockProvider`, and `ResponsesProvider`.

The interface above these providers is intentionally small, but not so small that vendor-specific
behavior becomes unreachable. Vendor options stay on the vendor's own options type — for example
`transport` and `parallelToolCalls` on Codex, or `region` on Bedrock.

## Credentials

The caller chooses the credential. There are three ways to get one, and this package supports all
three: pass a token directly, load one from the native client's on-disk location, or discover
whatever is available on the machine. Users sign in through Codex, Claude Code, or Grok rather than
through Rig.

Every credential class exposes a `tryLoad(options)` that returns `null` when nothing usable is
present, and accepts explicit values as an alternative to disk.

```ts
import { tryLoadCredentials } from "@slopus/rig-providers";

const credentials = await tryLoadCredentials(); // every credential found on this machine
```

Session credentials refresh themselves. A provider renews an expiring token before a request and
again after an upstream rejection, and persists the result where the native client keeps it.

## Creating a session

`SessionOptions` is the immutable, model-visible configuration plus the initial history:

```ts
const session = await provider.session("session-1", {
    context: {
        instructions: "…the system prompt…",
        messages: [],
    },
    tools: [
        /* SessionTool[] */
    ],
    modelConfigurations: {
        /* per-model overrides when a session can switch models */
    },
});
```

`modelConfigurations` is needed only when a session may switch between models whose instructions
or tools differ.

**You supply the prompts and tools.** This package does not hand you any. Each vendor's `prompts/`,
`tools/`, and `skills/` directories hold the native client's originals, but they are internal —
kept so tests can reproduce real requests and so the vendor's behavior can be read and verified.
Callers almost always need slightly different definitions, so these are for comparison, not reuse.

Skills in particular are not a provider concept: a skill is just tool definitions plus system
prompt text, composed into `instructions` and `tools` like any other content.

## Running inference

`run` takes the complete rebuilt conversation for the turn and returns an async iterable of
events. The caller owns history; the session does not accumulate it silently.

```ts
for await (const event of session.run({ context: { messages }, model, effort, abort })) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
}
```

`SessionRunRequest` fields: `context.messages` (required), plus optional `model`, `effort`
(`off` … `max`), `serviceTier`, and `abort`.

### Messages

`SessionMessage` is a union covering `system`, `user`, `assistant`, `tool`, `agent`, and
`compaction` roles. Three details matter for fidelity:

- **A `system` message is a positional notice, not prompt content.** Codex sends it natively as a
  `developer` message. Claude, Bedrock, and Grok have no conversational system role, so they
  project it onto a user turn wrapped in `<system-reminder>` at the same position. No provider
  folds it into the system prompt, where it would rewrite the cached prefix.
- **Multimodal content** goes in `input`, an ordered array of text and image parts. When present,
  providers use it instead of `content`.
- **Opaque provider data** rides along in `vendor`, `responseItems`, and `encryptedReasoning`.
  These exist so reasoning, parallel tool calls, and native checkpoints replay exactly. Persist
  them unchanged and pass them back; never flatten, reorder, or synthesize them.

### Tools

Tools are `SessionTool` values with TypeBox `parameters`. Mapping to each vendor's wire format is
the provider's job.

```ts
import { Type } from "@sinclair/typebox";

const tool = {
    name: "read_file",
    type: "local", // "local" runs on the client, "cloud" on the provider backend
    description: "Read a file.",
    parameters: Type.Object({ path: Type.String() }),
} satisfies SessionTool;
```

### Events

`SessionStream` yields `SessionEvent`s. The content events are `text_delta`, `reasoning_delta`,
`encrypted_reasoning`, `response_items`, `tool_call_start` / `tool_call_delta` / `tool_call_end`,
and `server_tool_call_delta`. Structural events are `block_start`, `block_stop`, and
`block_reset` — where `block_reset` signals a rollback, discarding output already emitted for the
current block. `retrying` reports a provider-owned retry attempt, and `token_usage` carries a
`SessionCacheUsage`.

Exactly one terminal `done` event ends every stream:

| `state`     | Meaning                                           |
| ----------- | ------------------------------------------------- |
| `normal`    | The turn finished.                                |
| `tool_call` | The model is waiting on tool results.             |
| `length`    | The response hit the output limit.                |
| `cancelled` | The caller aborted.                               |
| `error`     | Carries `kind`, `message`, and a `providerError`. |

Use `isSessionDoneEvent` and `isSessionErrorDone` to narrow, and `committedSessionEvents` to drop
events invalidated by a rollback.

### Errors

Errors are parsed, never passed through raw. `SessionErrorKind` gives a coarse category
(`internal_error`, `context_overflow`, `billing_error`, `unknown`), and `SessionProviderError`
gives the typed detail callers act on:

```ts
type SessionProviderError =
    | { type: "authentication"; diagnostics?: SessionProviderErrorDiagnostics }
    | {
          type: "out_of_tokens";
          resetAt?: number;
          diagnostics?: SessionProviderErrorDiagnostics;
      }
    | { type: "rate_limit"; resetAt?: number; diagnostics?: SessionProviderErrorDiagnostics }
    | { type: "server_overloaded"; diagnostics?: SessionProviderErrorDiagnostics }
    | { type: "internal_server_error"; diagnostics?: SessionProviderErrorDiagnostics }
    | { type: "empty_response"; diagnostics?: SessionProviderErrorDiagnostics }
    | { type: "unclassified"; diagnostics?: SessionProviderErrorDiagnostics };
```

Diagnostics retain only bounded, non-secret fields: status, provider code and type, request and
response IDs, upstream message, total attempts, and the provider's retry directive. Raw response
bodies and arbitrary headers are never retained.

Retries happen inside the provider and are surfaced as `retrying` events. Callers must not
re-issue a request themselves.

Every provider uses the same configurable inference retry budget. The default is ten retries
after the initial request (up to eleven total attempts), and callers may supply a live
`resolveInferenceMaxRetries` resolver so long-lived sessions follow runtime setting changes.
Retryability and delay schedules remain provider-owned.

An explicitly reported completion with zero output tokens is retried and, if its retry budget is
exhausted, surfaces as `empty_response`. The reported usage is authoritative even when the
attempt streamed content; `block_reset` rolls back those deltas and tool-call events before the
retry, while the attempt's token usage remains reported for accounting. Missing usage is not
interpreted as zero.

This makes a surfaced error **terminal**: anything retryable was already retried internally, so an
error reaching you has either exhausted its retries or was never retryable. Do not retry it —
display it. Every error carries a message fit to show a person, and `unclassified` specifically
means the failure could not be identified well enough to recover from.

### Usage

`SessionCacheUsage` reports `input`, `output`, `cacheRead`, `cacheWrite`, and `totalTokens`.
`input` is always **uncached** prompt tokens: vendors that fold cached tokens into their input
count have them subtracted, so `input + cacheRead + cacheWrite` counts each prompt token exactly
once. `EMPTY_SESSION_CACHE_USAGE` is the zero value.

## Compaction

Native compaction is used wherever the vendor provides it; this package never writes its own.
Compaction is also never automatic here — outer code decides when to compact.

```ts
const result = await session.compact({ instructions, context, inputTokens, signal });
```

The result is `completed`, `cancelled`, or `failed`. A completed compaction returns the
replacement `context` to adopt. Native compaction messages retain independent nullable `content`
and `encryptedContent` fields exactly as returned; non-native providers may instead return a
plain-text `summary`. The result also includes any `preservedMessages` and the provider-reported
`usage` spent producing the compaction.

## Models and quota

Model catalogs are curated in source and never discovered from a provider API at runtime. Use
`areProviderModelsCompatible` and `PROVIDER_MODEL_COMPATIBILITY_MATRIX` to check whether two
models can share a session.

Quota is optional and best-effort: `fetchClaudeProviderQuota`, `fetchCodexProviderQuota`, and
`createProviderQuotaCache` report five-hour and weekly windows, and `unavailableProviderQuota`
covers the case where a vendor reports nothing.

## Testing

There are three tiers.

**Deterministic tests**, including golden tests and recorded-response tests, run in the normal
suite and need no credentials:

```sh
pnpm --filter @slopus/rig-providers test
```

Golden tests compare reconstructed requests against real captured vendor traffic in
`tests/vendors/fixtures/`. Recorded-response tests replay real HTTP failures — rate limits,
exhausted tokens, overloaded backends, expired credentials — through the provider's own transport
and assert on the parsed `SessionProviderError` and the resulting retry behavior, so error parsing
is checked against traffic vendors actually sent.

**Live tests** reach real backends using local credentials, are named `*.live.test.ts`, and run
only on demand:

```sh
RIG_LIVE_TEST=1 pnpm --filter @slopus/rig-providers exec vitest run --config vitest.live.config.ts
```

Traces are captured by running the real vendor binaries behind an HTTP proxy with the existing
scripts in `tests/vendors/capture*.mjs`. See [AGENTS.md](AGENTS.md) for the rules that govern
capture and reproduction.

## Vendor documentation

- [VENDOR_CODEX.md](VENDOR_CODEX.md) — transports, compaction, and the parity report
- [VENDOR_CLAUDE.md](VENDOR_CLAUDE.md) — Claude Code SDK transport
- [VENDOR_GROK.md](VENDOR_GROK.md) — Grok sessions and compaction
- [VENDOR_ANTHROPIC_BEDROCK.md](VENDOR_ANTHROPIC_BEDROCK.md) — Bedrock Mantle and Runtime
- [EXAMPLES.md](EXAMPLES.md) — short end-to-end session examples
