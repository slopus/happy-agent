# @slopus/happy-providers

One small, stateful session interface for talking to coding-agent model backends. You work with a
session — create it, run turns, compact, destroy — while the library absorbs the low-level vendor
machinery underneath: wire protocols and transports, request framing, streaming, headers,
credentials, and each vendor's own quirks. Swap the provider and the session works the same.

What you get:

🔌 **Managed connections** — a session keeps its transport open and warm across turns, so you
never think about keep-alive, reconnects, or which wire protocol a vendor speaks this week.

🚨 **Typed errors** — failures are parsed into meaningful, typed cases with human-readable
messages wherever we can classify them; only genuinely unknown failures fall back to an
unclassified error, and even those arrive readable.

🔑 **Coding-assistant credentials and tokens** — reuse the credentials your local Codex, Claude
Code, or AWS installation already manages, pass an API key or bearer token directly, or discover
every account on the machine and let the user pick.

🧪 **Tested against the real thing** — golden traces are captured from the actual Codex, Claude
Code, and Grok clients talking to their real backends, and the test suite verifies our requests
match what the native clients send.

🔁 **Retries handled for you** — each provider retries its own failures the way its native client
does, reporting every retry to you as it happens and rewinding any half-streamed output cleanly.
If an error ever reaches you, it's terminal.

⚡ **Prompt-cache continuity** — cache prefixes stay byte-stable across turns, so continuing a
conversation costs what a continuation should cost.

🗜️ **Native compaction** — the vendor's own compaction protocol produces the replacement
context. It is never automatic: you decide when to compact and when to adopt the result.

🛠️ **Tools stay yours** — the library streams tool calls to you and carries your results back,
but it never executes anything. Permissions and policy live in your application, where they
belong.

Supported providers:

- **Anthropic** — one provider that selects the Claude Code SDK or Anthropic Messages on Bedrock
  from the credential you give it
- **OpenAI Codex** — Responses, Responses Lite, and OpenAI on Bedrock
- **OpenAI API** — any generic Responses-compatible endpoint with your own key
- **Grok Build** — xAI's Responses-compatible protocol

If you only remember one thing, make it the last section of this document:
[a session is a stateful, managed endpoint](#the-most-important-part-sessions-are-stateful-and-managed).
It keeps connections and caches warm, it retries failures on its own, and it never executes tools
for you.

This package owns the provider boundary and nothing more. There is deliberately no agent loop, no
tool executor, no permission system, and no conversation database — those belong to your
application.

## Installing

This is an ESM-only server-side library for Node 22.19 and newer or Bun 1.4 and newer. It needs
real process, filesystem, and networking APIs, so it won't run in browsers, bundlers targeting the
browser, edge runtimes, or React Native. The package manifest sets `browser` to `false` on purpose.

```sh
pnpm add @slopus/happy-providers @steve.kite/stdlib
```

If your application defines tools, add TypeBox as a direct dependency too — tool parameters are
TypeBox schemas:

```sh
pnpm add @sinclair/typebox
```

## Quick start

Here's the whole flow in one small program. It signs in with the credentials your local Codex
installation already manages, opens a session, and has a two-turn conversation. Notice that the
message history lives in _your_ array — the session keeps the connection and continuation state
warm, but you own the transcript.

```ts
import {
    CodexProvider,
    CodexSessionCredential,
    SessionAssistantMessageAccumulator,
    type SessionAssistantMessage,
    type SessionMessage,
} from "@slopus/happy-providers";
import { createRootContext, withLifetime } from "@steve.kite/stdlib";

const ctx = createRootContext().named("provider-session");
const credential = await CodexSessionCredential.tryLoad();
if (credential === null) {
    throw new Error("Sign in with Codex before starting a session.");
}

const provider = new CodexProvider({
    credential,
    model: "gpt-5.6-sol",
    transport: "auto",
});
const instructions = "You are a concise coding assistant.";
const session = await provider.session("conversation-1", {
    instructions,
    tools: [],
});

const messages: SessionMessage[] = [];

async function ask(content: string): Promise<string> {
    messages.push({ role: "user", content: [{ type: "text", text: content }] });

    let response = "";
    const assistant = new SessionAssistantMessageAccumulator();
    for await (const event of session.run(ctx, { context: { instructions, messages } })) {
        assistant.add(event);
        if (event.type === "text_delta") response += event.delta;
        if (event.type === "done" && event.state === "error") {
            throw new Error(event.message);
        }
    }

    const message = assistant.message();
    if (message === undefined) throw new Error("The provider returned no assistant message.");
    messages.push(message);
    return response;
}

try {
    console.log(await ask("What makes a provider session stateful?"));
    console.log(await ask("Summarize that in one sentence."));
} finally {
    await session.destroy();
}
```

A production caller reconstructs and persists the assistant message from the ordered block events.
`SessionAssistantMessageAccumulator` does that directly, including retry rewinds. Its result
contains the text, reasoning, tool calls, provider-owned tool results, and opaque replay metadata
needed for the next turn.
[EXAMPLES.md](EXAMPLES.md) walks through a complete event collector and a tool-call continuation.

## Providers and credentials

| Provider            | Talks to                                               | Credential options                                                                |
| ------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `AnthropicProvider` | Claude Code SDK or Anthropic Messages on Bedrock       | Claude Code, OAuth, auth token, API key, Bedrock bearer token, or AWS credentials |
| `CodexProvider`     | OpenAI Responses, Responses Lite, or OpenAI on Bedrock | Codex session, OpenAI API key, Bedrock bearer token, or AWS credentials           |
| `GrokProvider`      | Grok Responses-compatible protocol                     | Grok session or xAI API key                                                       |
| `ResponsesProvider` | Any generic Responses-compatible endpoint              | Explicit endpoint and API key                                                     |

You always choose the credential; the library never picks an account for you. Each vendor
credential class has a `tryLoad()` that accepts explicit values or reads the native client's
on-disk credentials. When you want to offer the user a choice of accounts, `tryLoadCredentials()`
discovers everything available on the machine.

For Anthropic there is deliberately no second provider choice. Construct `AnthropicProvider`
with whichever credential the user selected. `ClaudeCodeCredential`, `ClaudeOAuthCredential`,
`ClaudeAuthTokenCredential`, and `ClaudeApiKeyCredential` select the persistent Claude Agent SDK
implementation. `BedrockBearerTokenCredential` and `BedrockAwsCredential` select Anthropic
Messages on Bedrock. The AWS credential uses the standard Node credential chain, including shared
profiles with `credential_process`, and SigV4-signs requests. The provider's canonical `name`
remains `"claude"` on either transport.

Credentials are reusable: load one once and share it across every session you open — sessions
don't take ownership of it, and there is no need to reload it per conversation. Token refreshing
is handled for you.

Model catalogs are curated in source. The library never fetches a model list during startup or
session creation.

## Configuring a session

`provider.session(id, options)` takes the immutable, model-visible configuration — the things the
model will actually see:

```ts
const session = await provider.session("stable-application-id", {
    instructions: "Your complete system instructions.",
    tools,
    inferenceMaxRetries: 3,
    modelConfigurations: {
        // Optional complete instruction/tool overrides for models selected on later runs.
    },
});
```

You supply the instructions and tools yourself. The vendor prompts and tool descriptors you'll
find reproduced in this source tree are reference data for protocol tests, and they are
intentionally not exported.

Each `run()` takes a stdlib context first, then the complete transcript plus anything you want to
vary per turn: model, reasoning effort, priority service tier, and structured output schema.
Cancellation travels through `ctx.lifetime`; use `withLifetime` to attach an operation signal:

```ts
const stream = session.run(withLifetime(ctx, abortController.signal), {
    context: { instructions, messages },
    model: "gpt-5.6-sol",
    effort: "high",
});
```

### Session IDs

Session IDs should be globally unique. The library treats the ID as an opaque string you own: it
does not generate, validate, or persist one for you. Generate an ID when a logical conversation is
created, store it with that conversation, and don't reuse it for anything else.

CUID2 is a good default, though UUIDs or any other collision-resistant identifier work too:

```sh
pnpm add @paralleldrive/cuid2
```

```ts
import { createId } from "@paralleldrive/cuid2";

const sessionId = createId();
const session = await provider.session(sessionId, {
    instructions,
    tools,
});
```

Why global uniqueness? It keeps independent conversations, processes, machines, logs, and
provider-side continuation state from accidentally sharing an identity. Keep the ID stable while
continuing the same conversation; mint a new one for a new conversation or an independent branch.

## Messages and events

`SessionMessage` covers user, assistant, tool-result, system-notice, agent, and compaction
messages. User, system, assistant, and tool-result content is always an ordered block array.

Some fields exist purely so the provider can continue a conversation faithfully, and their
contents are intentionally opaque. Whenever these appear, store them byte-for-byte and send them
back unchanged:

- reasoning block `reasoning` payloads;
- tool-call and tool-result block `vendor` metadata;
- compaction `encryptedContent` and `vendor` metadata.

`SessionStream` is an `AsyncIterable<SessionEvent>`. You'll see text and reasoning deltas,
tool-call boundaries, provider-owned tool results, token usage, retry notices, and block rollback
boundaries. Content-block start order is the exact order of `SessionAssistantMessage.content`;
indexes are neither exposed nor needed. Every started stream ends with exactly one `done` event.
Use `SessionAssistantMessageAccumulator` to build the message while streaming, or
`assistantMessageFromEvents()` after collecting a run. Both discard output invalidated by
`block_reset` correctly.

## Tools: you run them, not the library

The library serializes your tool definitions, sends them to the model, and streams tool calls back
to you. Executing the call is entirely your application's job. That separation is deliberate: tool
execution is where permissions, sandboxing, and product policy live, and none of that belongs in a
network layer.

Tool parameters use TypeBox schemas:

```ts
import { Type } from "@sinclair/typebox";
import type { SessionTool } from "@slopus/happy-providers";

const readFile = {
    name: "read_file",
    description: "Read a UTF-8 text file.",
    parameters: Type.Object({ path: Type.String() }),
} satisfies SessionTool;
```

The one exception is provider-owned tools — "server tools" the vendor executes inside its own
backend, like web search. You define one on the same `SessionTool` shape by setting `server` to
the vendor's exact native descriptor:

```ts
const webSearch = {
    name: "web_search",
    server: { type: "web_search" },
} satisfies SessionTool;
```

The presence of `server` is what marks ownership: the provider passes the descriptor through to
the wire verbatim instead of deriving a native tool type from the name, and the call settles
inside the provider's own response. Never execute a server-tool call yourself or send a tool
result for it.

Deferred loading follows the same ownership rule. Set `defer: true` on tools that may be
discovered, and select the provider/model's native server tool-search descriptor alongside them.
That provider owns the complete search call and result. A provider/model tool array with no native
search descriptor sends every deferred tool eagerly. `searchKeywords` adds caller-selected terms
to provider-owned local search indexes (and to Claude's searchable MCP description).

## Compaction

When a transcript gets long, `compact()` asks the provider to produce a shorter replacement
context using its native compaction protocol. Compaction is explicit — the library never compacts
behind your back:

```ts
const compacted = await session.compact(withLifetime(ctx, abortController.signal), {
    context: { instructions, messages },
    instructions: "Preserve decisions, unfinished work, and exact identifiers.",
});

if (compacted.status === "completed") {
    messages.splice(0, messages.length, ...compacted.context.messages);
}
```

On success, adopt and persist the complete returned `context` as your new transcript. On
cancellation or failure, keep the original — nothing was changed out from under you.

The `context` is the complete caller-selected input to compact: root instructions and messages
travel together exactly as they do for inference. The separate `instructions` field tells the
provider what the compacted replacement should retain. Compaction does not accept a caller token
count; providers report their own usage.

## The most important part: sessions are stateful and managed

Everything above is mechanics. This is the mental model.

A session is not a thin request wrapper. It is a long-lived, **managed endpoint** for one
conversation:

```text
provider.session(id, options)
            |
            v
      BaseSession
       |  |  |
       |  |  +-- destroy()          release session resources
       |  +----- compact()          update provider-native compacted state
       +-------- run()              stream one inference turn
```

Create one session per conversation and keep using it across turns. Behind the scenes it holds the
state that makes continuations fast and correct: open connections, warm cache prefixes, turn
identifiers, active model state, and the context adopted by native compaction. Throwing a session
away between turns throws that warmth away with it.

The division of labor is strict, and it's worth internalizing:

- **The session keeps the connection.** Transport choice, keep-alive, reconnection, and
  prompt-cache continuity are its problem, not yours.
- **The session retries for itself.** You never replay a failed `run()`. Details below.
- **The session never calls tools.** It streams tool calls out to you and carries your results
  back. Execution — and everything execution implies, like permissions — stays in your
  application.
- **You keep the transcript.** Pass the complete message history to every `run()`, persist the
  opaque provider fields unchanged, and adopt the replacement context a successful `compact()`
  returns. Because history is yours, you can restore a conversation in a brand-new process without
  the session ever becoming a hidden database.

Because history is yours, tracking it accurately is also on you. All the warmth above assumes
each `run()` receives the previous turn's history plus the new messages — append-only, with the
earlier messages byte-for-byte identical. Rewrite, reorder, or drop something earlier in the
transcript and some providers will nuke the prompt cache and continuation state on the spot. You
_can_ replace the history wholesale, but the price is the session: its warm provider-side state
no longer matches, so treat it as starting a conversation cold. The one sanctioned replacement is
the context a successful `compact()` returns — that's the provider itself handing you the new
history its state expects.

### One thing at a time

A session accepts one active operation at a time. Don't overlap two `run()` calls, a `run()` and a
`compact()`, or two `compact()` calls. Sessions do not queue or lock for you — you serialize.

A `run()` counts as active until you have consumed its iterator all the way through the terminal
`done` event. If you abort a run, keep draining the iterator until it finishes before starting the
next operation.

```ts
// Correct: turns on one session are sequential.
for await (const event of session.run(ctx, { context: { instructions, messages } })) {
    // Consume every event.
}

const compacted = await session.compact(ctx, { context: { instructions, messages } });
```

Independent sessions run concurrently just fine — use one session per conversation or branch:

```ts
const first = await provider.session("conversation-1", firstOptions);
const second = await provider.session("conversation-2", secondOptions);

const runFirst = async () => {
    for await (const event of first.run(ctx, {
        context: { instructions: firstInstructions, messages: firstMessages },
    })) {
        // Consume the first conversation's events.
    }
};
const runSecond = async () => {
    for await (const event of second.run(ctx, {
        context: { instructions: secondInstructions, messages: secondMessages },
    })) {
        // Consume the second conversation's events.
    }
};

await Promise.all([runFirst(), runSecond()]);
```

The same rule covers switching models or reasoning effort: finish the current operation, then pick
the new `model` or `effort` on the next `run()`. You may execute client-owned tool calls in
parallel once the provider stream finishes, but append every tool result to your transcript before
the next inference begins.

### Branching

`BaseSession` does not currently expose `fork()`. Don't branch by running the same session twice
or by creating two session objects with the same ID.

To branch today, copy your transcript and open a new session with its own ID. Include all opaque
reasoning, tool metadata, and compaction messages in the copy:

```ts
const branchMessages = structuredClone(messages);
const branch = await provider.session("conversation-1-branch-1", {
    instructions,
    tools,
    modelConfigurations,
});

for await (const event of branch.run(ctx, {
    context: { instructions, messages: branchMessages },
    model,
    effort,
})) {
    // Consume the branch independently from the original session.
}
```

This preserves the logical conversation — the history was always yours — but it starts cold on the
provider side: no shared connection, warm cache, response chain, or other transport state. A true
session fork would need to clone that internal state safely; until the API provides one, separate
sessions are the supported branching boundary.

### Retries happen inside the session

Retries belong to the provider. Each one knows which of its failures are safe to retry and how
long to wait, based on its native protocol. Retries are never silent, though: every attempt is
reported to you as a `retrying` event with the attempt number and the reason, so your UI can show
what's happening — the provider just performs the retry itself. **Never replay a failed `run()`
yourself**: by the time a `done` event with `state: "error"` reaches you, the failure was either
not retryable or the provider already exhausted its retry budget. What surfaces to you is
terminal — show it to the user, don't resubmit it.

There's a subtlety: a retry can happen _after_ the model has already streamed text, reasoning, or
a tool call. Model backends can't resume a generation mid-stream — Anthropic in particular has no
way to pick up where a broken stream left off — so when a stream dies halfway through a message
or a tool call, the retry has to regenerate that output from scratch, and the half-streamed part
must be thrown away. Session events use blocks so the provider can rewind that tentative output
without duplicating it:

```text
block_start -> text/tool deltas -> block_reset -> retrying
                 discarded

block_start -> replacement deltas -> block_stop -> done
                   committed
```

- `block_start` begins tentative output for an attempt.
- `block_reset` retracts everything since the matching `block_start`.
- `retrying` reports the next provider-owned retry and its reason.
- `block_stop` commits the current block; its output is now safe to persist as the response.

`block_reset` may also precede cancellation or a terminal error when no retry follows. It rewinds
stream output only — it never asks you to delete durable conversation history, restore an older
session, or resubmit the request. Token-usage events from a failed attempt may stay committed for
accounting even though the generated content was rewound.

Collecting a stream after the fact? Capture everything, then let `committedSessionEvents()` strip
out the rewound output:

```ts
import { committedSessionEvents, type SessionEvent } from "@slopus/happy-providers";

const streamed: SessionEvent[] = [];
for await (const event of session.run(ctx, { context: { instructions, messages } })) {
    streamed.push(event);
}

const committed = committedSessionEvents(streamed);
```

Rendering live? Keep events after `block_start` in a tentative buffer. Show them provisionally if
you like, clear that presentation on `block_reset`, and move them into durable history only on
`block_stop`. Events outside a block — `retrying`, usage, the terminal `done` — are never part of
the rewound content.

The default budget is ten retries after the initial request, so at most eleven attempts. You can
set a provider-wide budget or override it per session; zero disables provider-owned retries for
that session:

```ts
const provider = new CodexProvider({
    credential,
    inferenceMaxRetries: 4,
});

const oneShotSession = await provider.session(createId(), {
    instructions,
    tools,
    inferenceMaxRetries: 0,
});
```

Retry budgets are capped at 100. Retry classification, delay schedules, connection recovery, and
credential refresh all stay provider-owned. When something does fail terminally, the error event
carries a human-readable message and, when recognized, a typed `SessionProviderError` with bounded
diagnostics.

## Package surface

The root export contains the stable shared types, provider classes, credential classes, usage and
quota helpers, and provider-specific option types. Internal request builders, transports, native
prompts, native tool catalogs, and trace fixtures are not exported.

More reference documentation:

- [EXAMPLES.md](EXAMPLES.md) — multi-turn collection, tools, compaction, and provider setup
- [VENDOR_CODEX.md](VENDOR_CODEX.md)
- [VENDOR_CLAUDE.md](VENDOR_CLAUDE.md)
- [VENDOR_GROK.md](VENDOR_GROK.md)
- [VENDOR_ANTHROPIC_BEDROCK.md](VENDOR_ANTHROPIC_BEDROCK.md)

## Provider settings

Every option each provider constructor accepts, and how the defaults are chosen.

### Shared by every provider

- `inferenceMaxRetries` — maximum provider-owned retries. Defaults to `10` (up to eleven total
  attempts), capped at `100`. `0` disables provider-owned retries. A session can override this
  with its own `inferenceMaxRetries` in `provider.session(id, options)`.
- `resolveInferenceMaxRetries` — a callback that resolves the current retry limit on every run,
  so long-lived sessions follow runtime configuration changes instead of the value captured at
  construction.
- `waitForInferenceRetry` — a test seam that replaces the provider's retry backoff wait. Leave it
  unset in production.

### `CodexProvider` (OpenAI Codex)

- `credential` _(required)_ — a Codex session, an OpenAI API key, a Bedrock bearer token, or AWS
  credentials. The credential also picks the default endpoint: a Codex session talks to
  `https://chatgpt.com/backend-api`, an API key to `https://api.openai.com/v1`, and either Bedrock
  credential to the Bedrock Mantle endpoint for the resolved region. AWS credentials use SigV4
  and remain refreshable through the credential provider chain.
- `endpoint` — overrides that default endpoint.
- `model` — the session's default model, resolved against the curated catalog. On Bedrock the
  catalog maps it to the corresponding Bedrock model ID.
- `parallelToolCalls` — enables multi-call tool batches. Because batches are unavailable under
  Responses Lite, setting this to `true` also forces standard Responses for v2 models (see below).
- `region` — the Bedrock region. Resolution order: this option, then `AWS_REGION`, then
  `AWS_DEFAULT_REGION`, then `us-east-1`.
- `streamIdleTimeoutMs` — how long a connected stream may sit idle before it is treated as dead.
  Defaults to `300000` (five minutes), matching upstream Codex.
- `transport` — `"websocket"`, `"sse"`, or `"auto"` (the default). `auto` starts on WebSocket and,
  if the WebSocket transport turns out to be unavailable or fails with a retryable stream error,
  falls back to SSE for the rest of the session. Bedrock always uses SSE regardless of this
  option.
- `userAgent` — overrides the native Codex user agent. Meant only for replaying a captured native
  request.

**How the Codex API version is chosen.** There are two request shapes: standard Responses ("v1")
and Responses Lite ("v2"). The choice is made per model from the curated catalog — each model
carries a flag saying whether it is a Responses Lite model. A v2 model gets a Responses Lite
request (marked with the `x-openai-internal-codex-responses-lite: true` header), exactly as the
native Codex CLI sends it. There are two exceptions: setting `parallelToolCalls: true` forces
standard Responses even for a v2 model, since Lite cannot carry multi-call batches, and v1 models
always use standard Responses.

### `AnthropicProvider`

`credential` is required and selects the implementation. There is no transport flag and no
separate Bedrock provider class in the public API:

- A `ClaudeCodeCredential`, `ClaudeOAuthCredential`, `ClaudeAuthTokenCredential`, or
  `ClaudeApiKeyCredential` uses the Anthropic Agent SDK. This branch accepts `env`, `model`,
  `onAccountUsage`, `pathToClaudeCodeExecutable`, `query`, and `userAgent`.
- A `BedrockBearerTokenCredential` or `BedrockAwsCredential` uses Anthropic Messages on Amazon
  Bedrock. This branch accepts `client`, `endpoint`, `model`, `region` (default `us-east-1`),
  `transport` (`"mantle"` by default, or `"runtime"`), and `userAgent`.

The exported `AnthropicProviderOptions` union describes both credential-specific option shapes. A
credential selected dynamically may remain typed as the complete `AnthropicCredential` union;
the common `{ credential, model, userAgent }` constructor shape accepts it directly. `query` and
`client` are advanced injection seams for tests; production callers normally leave them unset.

`BedrockAwsCredential.tryLoad()` uses the standard AWS Node credential chain. Pass `profile` to
select a shared-config profile explicitly; otherwise `AWS_PROFILE`, environment credentials,
shared files, web identity, and instance/container credentials follow normal AWS precedence. A
profile containing `credential_process` is executed by the AWS SDK, and expiring credentials are
refreshed by the same provider:

```ini
[profile work-bedrock]
credential_process = /usr/local/bin/aws-credential-helper work
```

```ts
const credential = await BedrockAwsCredential.tryLoad({ profile: "work-bedrock" });
```

### `GrokProvider` (Grok Build)

- `credential` _(required)_ — a Grok session or an xAI API key.
- `endpoint` — defaults to `https://cli-chat-proxy.grok.com/v1`, the endpoint grok-build uses.
- `model` — the session's default model, resolved against the curated catalog.
- `userAgent` — identifies your application upstream instead of reproducing the grok-build user
  agent.

### `ResponsesProvider` (OpenAI API)

- `apiKey` _(required)_ — sent as a bearer token.
- `endpoint` _(required)_ — the base URL of the Responses-compatible endpoint.
- `model` — the session's default model, passed through as-is; there is no catalog for generic
  endpoints.
- `headers` — extra headers added to every request.
- `fetch` — a custom `fetch` implementation, for proxying or tests.
- `nativeCompaction` — whether the endpoint implements the native compaction protocol. Defaults
  to `true`; set it to `false` for endpoints that don't, so `compact()` fails cleanly instead of
  sending a request the endpoint cannot answer.
- `capabilities` — which optional Responses features the endpoint supports: `encryptedReasoning`,
  `parallelToolCalls`, `reasoning`, and `textVerbosity`. Defaults to the minimal set (all off), so
  any Responses-compatible endpoint works out of the box; turn on what your endpoint actually
  implements.

## Session types in detail

A complete tour of the objects you exchange with a session, shown as their real TypeScript
definitions. Everything here is exported from the package root.

### `BaseSession`

What `provider.session(id, options)` returns:

```ts
abstract class BaseSession {
    readonly id: string;

    abstract run(ctx: Context, request: SessionRunRequest): SessionStream;
    abstract compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction>;
    abstract destroy(): void | Promise<void>;
}
```

`run()` streams one inference turn, `compact()` asks the provider for a shorter replacement
context, and `destroy()` releases connections and other session resources — always call it when
the conversation is over.

### `SessionOptions`

The immutable, model-visible configuration a session is created with:

```ts
interface SessionOptions {
    readonly instructions: string;
    readonly tools?: readonly SessionTool[];
    /** Retry budget for this session alone, overriding the provider's. Zero disables retries. */
    readonly inferenceMaxRetries?: number;
    /** Alternate model-visible configurations for sessions that switch models. */
    readonly modelConfigurations?: Readonly<Record<string, SessionModelConfiguration>>;
}

interface SessionModelConfiguration {
    readonly instructions: string;
    readonly tools?: readonly SessionTool[];
}
```

There are no initial messages here on purpose — history always arrives with each `run()`.

### `SessionRunRequest`

What one `run()` takes:

```ts
interface SessionRunRequest {
    /** Complete rebuilt conversation context for this inference turn. */
    context: SessionContext;
    model?: string;
    effort?: SessionReasoningEffort;
    serviceTier?: SessionServiceTier;
    structuredOutput?: SessionStructuredOutput;
}

type SessionReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type SessionServiceTier = "priority";

interface SessionStructuredOutput {
    name: string;
    schema: TSchema; // a TypeBox schema
}
```

Providers map `effort` onto whatever their protocol supports, and `serviceTier: "priority"`
requests priority processing where the vendor offers it.

### `SessionMessage` — the transcript

The transcript you own is an array of six message shapes, discriminated by `role`:

```ts
type SessionMessage =
    | SessionSystemMessage
    | SessionUserMessage
    | SessionAgentMessage
    | SessionAssistantMessage
    | SessionToolResultMessage
    | SessionCompactionMessage;
```

A user turn contains ordered multimodal blocks:

```ts
interface SessionUserMessage {
    readonly role: "user";
    readonly content: readonly SessionInputBlock[];
}

type SessionInputBlock = SessionTextBlock | SessionImageBlock;

interface SessionTextBlock {
    readonly type: "text";
    readonly text: string;
}

interface SessionImageBlock {
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
}
```

A model turn is one ordered block array. Do not flatten or reorder it: provider replay state lives
on the block it belongs to, so text, reasoning, client tool calls, and provider-owned tool results
retain their original sequence:

```ts
interface SessionAssistantMessage {
    readonly role: "assistant";
    readonly content: readonly SessionAssistantBlock[];
}

type SessionAssistantBlock =
    | SessionTextBlock
    | SessionReasoningBlock
    | SessionToolCallBlock
    | SessionToolResultBlock;

interface SessionReasoningBlock {
    readonly type: "reasoning";
    /** Human-readable reasoning, when exposed. */
    readonly text?: string;
    /** Opaque signed or encrypted replay state, when required. */
    readonly reasoning?: string;
}

interface SessionToolCallBlock {
    readonly type: "tool_call";
    /** Stable correlation identity. Providers expose their native ID; callers may replace it. */
    readonly callId: string;
    readonly name: string;
    readonly namespace?: string;
    /** The raw argument JSON exactly as the model produced it. */
    readonly arguments: string;
    /** The provider stopped before this call became executable — do not run it. */
    readonly incomplete?: boolean;
    /** Optional opaque replay data unrelated to the call's correlation identity. */
    readonly vendor?: unknown;
}
```

Providers expose their native `callId` on stream events so starts, deltas, ends, and server-tool
results can be correlated. A caller may replace that ID before storing the context, provided it
uses the replacement consistently on the tool-call block and its result. Providers replay the
context's ID directly and do not retain a second identity in `vendor`.

Your answer to a tool call is tied back by that same `callId`:

```ts
interface SessionToolResultMessage {
    readonly role: "tool";
    readonly callId: string;
    readonly content: readonly SessionOutputBlock[];
    /** Whether the caller reported that the tool invocation failed. */
    readonly isError?: boolean;
    /** Optional opaque result metadata; never a duplicate provider call identity. */
    readonly vendor?: any;
}
```

The remaining three shapes — a system notice, an opaque Codex agent-to-agent message, and the
checkpoint a native compaction produced (it sits where the compacted history used to be; never
edit it):

```ts
interface SessionSystemMessage {
    readonly role: "system";
    readonly content: readonly SessionTextBlock[];
}

interface SessionAgentMessage {
    readonly role: "agent";
    readonly author: string;
    readonly recipient: string;
    readonly header: string;
    readonly encryptedContent: string;
    /** Whether this message establishes the boundary for a new inference turn. */
    readonly agentMessageTriggerTurn?: boolean;
}

interface SessionCompactionMessage {
    readonly role: "compaction";
    /** Provider-returned summary text, including null when the provider returned no text. */
    readonly content: string | null;
    /** Provider-returned encrypted compaction payload, including null when absent. */
    readonly encryptedContent: string | null;
    /** Additional opaque provider metadata required to replay the checkpoint natively. */
    readonly vendor?: any;
}
```

`SessionAgentMessage` is specifically Codex cross-agent replay state. It represents encrypted
messages exchanged by Codex collaborators and preserves their author, recipient, display header,
and turn boundary. Persist and replay values emitted by Codex; do not construct it as a generic
application message. Non-Codex providers ignore it.

### `SessionTool`

A tool definition, as covered in the [Tools section](#tools-you-run-them-not-the-library):

```ts
interface SessionTool {
    readonly name: string;
    readonly namespace?: string;
    /** Description of the containing namespace, when this tool is namespaced. */
    readonly namespaceDescription?: string;
    /**
     * Exact native descriptor for a call the provider owns and settles inside its response.
     * Absence means the caller owns execution.
     */
    readonly server?: { readonly type: string; readonly [key: string]: unknown };
    readonly description?: string;
    readonly parameters?: TSchema; // a TypeBox schema
    /** Provider-neutral request to expose this tool through native tool discovery. */
    readonly defer?: boolean;
    /** Extra terms for provider-owned local discovery indexes. */
    readonly searchKeywords?: readonly string[];
    /** OpenAI-style Lark grammar; ignored by providers that do not support grammar tools. */
    readonly grammar?: SessionToolLarkGrammar;
}

interface SessionToolLarkGrammar {
    readonly type: "lark";
    readonly grammar: string;
}
```

### `SessionEvent` — the stream

`run()` yields a `SessionStream = AsyncIterable<SessionEvent>`. The full union:

```ts
type SessionEvent =
    // Attempt blocks bracket tentative output so provider-owned retries can rewind it.
    | { type: "block_start" }
    | { type: "block_stop" }
    | { type: "block_reset" }
    // Text and reasoning blocks are sequential. Start order is message-content order.
    | { type: "text_start" }
    | { type: "text_delta"; delta: string }
    | { type: "text_end" }
    | { type: "reasoning_start" }
    | { type: "reasoning_delta"; delta: string }
    | { type: "reasoning_end"; reasoning?: string }
    // Tool calls. `server: true` marks a provider-owned call the client never executes.
    | {
          type: "toolcall_start";
          callId: string;
          name: string;
          namespace?: string;
          server?: true;
          vendor?: any;
      }
    | { type: "toolcall_delta"; callId: string; delta: string }
    | { type: "toolcall_end"; callId: string; arguments: string; incomplete?: boolean }
    // Server-tool results settle inside the same response, streamed beside the call.
    | { type: "toolcall_result_start"; callId: string; vendor?: any }
    | { type: "toolcall_result_delta"; callId: string; delta: string }
    | {
          type: "toolcall_result_end";
          callId: string;
          content: readonly SessionOutputBlock[];
          isError?: boolean;
          incomplete?: boolean;
      }
    // Progress.
    | { type: "retrying"; attempt: number; reason: string }
    | { type: "token_usage"; usage: SessionUsage }
    // Exactly one done event ends every started stream.
    | { type: "done"; state: "cancelled" }
    | { type: "done"; state: "normal"; tokens: SessionTokens; endTurn?: boolean }
    | { type: "done"; state: "tool_call"; tokens: SessionTokens }
    | { type: "done"; state: "length"; tokens: SessionTokens }
    | {
          type: "done";
          state: "error";
          kind: SessionErrorKind;
          message: string;
          providerError?: SessionProviderError;
      };

type SessionErrorKind = "internal_error" | "context_overflow" | "billing_error" | "unknown";

interface SessionTokens {
    /** Full input context size, including cached input. */
    readonly input: number;
    readonly output: number;
}

type SessionStream = AsyncIterable<SessionEvent>;
```

The `done` states: `"normal"` means the model finished its answer (`endTurn` marks an explicit
end of turn), `"tool_call"` means it stopped to wait for your tool results, `"length"` means the
response hit a length limit, `"cancelled"` means the run was aborted, and `"error"` is terminal.
Ordinary tools never emit `toolcall_result_*` events — you answer those with a `role: "tool"`
message; only server tools stream their results here.

No content index is exposed. A `text_start`, `reasoning_start`, `toolcall_start`, or
`toolcall_result_start` appends that block to the assistant message. Text and reasoning are
sequential; parallel tool calls are updated by `callId`. The corresponding end event closes the
block and supplies final opaque state or normalized content when needed.

The exported accumulator implements those rules and the outer retry rollback boundaries:

```ts
const assistant = new SessionAssistantMessageAccumulator();

for await (const event of session.run(ctx, { context: { instructions, messages } })) {
    assistant.add(event);
}

const message = assistant.message();
if (message !== undefined) messages.push(message);
```

If you already collected the complete run, `assistantMessageFromEvents(events)` returns the same
result. There is no terminal `assistant_message` event and no provider-specific `response_items`
event; the ordered lifecycle is the message.

The helpers `isSessionDoneEvent()` and `isSessionErrorDone()` narrow events, and
`committedSessionEvents()` filters a collected stream down to what survived block rewinds.

### `SessionUsage`

Token accounting for one attempt:

```ts
interface SessionUsage {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly totalTokens: number;
}
```

The fields are normalized the same way for every provider: `input` is the complete input context,
including cached tokens; `cacheRead` and `cacheWrite` describe subsets of that input; and
`totalTokens` is `input + output`. Cache reads are the payoff of prompt-cache continuity — a
healthy continuation shows much of its input also reported as `cacheRead`.

**Getting the last turn's context size.** The size of the context the model actually saw on a
turn is `input`; cache columns are already included:

```ts
let lastUsage: SessionUsage | undefined;
for await (const event of session.run(ctx, { context: { instructions, messages } })) {
    if (event.type === "token_usage") lastUsage = event.usage;
}

const contextSize = lastUsage?.input ?? 0;
```

Keep the _last_ `token_usage` event of the run — a retried run reports usage per attempt, and the
final event describes the attempt that produced the committed response. This is the right value
for a context-window meter in your UI. Compaction itself does not accept a caller-supplied token
count; its returned usage comes from the provider.

### `SessionCompaction`

What `compact(ctx, options)` takes and resolves to:

```ts
interface SessionCompactionOptions {
    /** Model selected by the caller for this compaction. */
    readonly model?: string;
    /** Provider-native instructions describing what the compaction should retain. */
    readonly instructions?: string;
    /** Complete context to compact, including its root instructions and messages. */
    readonly context: SessionContext;
}

type SessionCompaction =
    | CompletedSessionCompaction
    | CancelledSessionCompaction
    | FailedSessionCompaction;

interface CompletedSessionCompaction {
    readonly status: "completed";
    /** Plain-text summary produced by providers without native compaction. */
    readonly summary?: string;
    /** Opaque checkpoint produced by provider-native compaction. */
    readonly compaction?: SessionCompactionMessage;
    /** Opaque reasoning item emitted while producing the summary, when supported. */
    readonly encryptedReasoning?: string;
    /** Original messages intentionally retained alongside the summary. */
    readonly preservedMessages: readonly SessionMessage[];
    readonly usage: SessionUsage;
    /** Complete replacement context — adopt this as your new transcript. */
    readonly context: SessionContext;
}

interface CancelledSessionCompaction {
    readonly status: "cancelled";
    /** Original context left active because compaction did not complete. */
    readonly context: SessionContext;
}

interface FailedSessionCompaction {
    readonly status: "failed";
    readonly kind: "inference_error" | "invalid_summary" | "tool_call";
    readonly message: string;
}

interface SessionContext {
    readonly instructions: string;
    readonly messages: readonly SessionMessage[];
}
```

On `"cancelled"` and `"failed"` nothing changed. Cancellation echoes the selected context;
failure only describes the error because the caller already owns the unchanged input context.

### `SessionProviderError`

The typed classification attached to a terminal error `done` event when the failure was
recognized. It is defined as a TypeBox schema (exported as `sessionProviderErrorSchema` for
runtime validation); the derived type:

```ts
type SessionProviderError =
    | { type: "authentication"; diagnostics?: SessionProviderErrorDiagnostics }
    | { type: "out_of_tokens"; resetAt?: number; diagnostics?: SessionProviderErrorDiagnostics }
    | { type: "rate_limit"; resetAt?: number; diagnostics?: SessionProviderErrorDiagnostics }
    | { type: "server_overloaded"; diagnostics?: SessionProviderErrorDiagnostics }
    | { type: "internal_server_error"; diagnostics?: SessionProviderErrorDiagnostics }
    | { type: "empty_response"; diagnostics?: SessionProviderErrorDiagnostics }
    | { type: "unclassified"; diagnostics?: SessionProviderErrorDiagnostics };

interface SessionProviderErrorDiagnostics {
    attempts?: number;
    code?: string;
    errorType?: string;
    requestId?: string;
    responseId?: string;
    retryDirective?: boolean;
    status?: number; // HTTP status
    upstreamMessage?: string; // truncated, bounded
}
```

What each case means: `authentication` — the credential was rejected; `out_of_tokens` — the
account's quota is exhausted, with `resetAt` saying when it returns when known; `rate_limit` —
too many requests, `resetAt` again when known; `server_overloaded` — the backend is shedding
load; `internal_server_error` — the backend failed; `empty_response` — the provider returned
nothing usable; `unclassified` — we don't know how to recover from this, and the human-readable
message on the `done` event is the best available explanation.

Diagnostics are bounded and sized for logs — never a raw upstream dump.

## License

MIT — see [LICENSE](LICENSE).
