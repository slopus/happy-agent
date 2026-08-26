# Happy Agent architecture

This document describes how Happy Agent is put together: the processes it runs, the
protocol between them, how inference and tools work, what is stored on disk, and
which package owns what. It is written for coding agents running inside Happy Agent and
for developers changing it.

It describes the behavior that is actually implemented. Where Happy Agent's stated
direction runs ahead of what ships today, that is called out explicitly in
[Where the product runs ahead of the code](#where-the-product-runs-ahead-of-the-code).

## 1. The core idea

Happy Agent is one local harness that recreates several first-party coding agents on
top of a single runtime. GPT models receive Codex-shaped prompts and tools,
Claude models receive Claude Code-shaped prompts and tools, and Grok receives the
Grok Build prompt and tool contracts. Everything around inference — sessions,
permissions, sandboxing, persistence, subagents, MCP, the terminal — is shared.

Two consequences shape the whole system:

- **There is no Happy Agent account.** Happy Agent authenticates as the user's existing
  installations do: it reads the credentials that Codex, Claude Code, and the
  Grok CLI already manage on the machine, plus a Bedrock bearer token from the
  environment when configured. The daemon only checks whether a credential is
  present locally, and never asks a provider server which models exist.
- **Provider differences are confined to inference and the tool surface.** They
  are not allowed to create a second security path, a second session model, or a
  second persistence path. Every provider is routed through the same
  `AgentContext`, `PermissionContext`, filesystem boundary, and shell sandbox.

Happy Terminal uses `@earendil-works/pi-tui` for terminal rendering. Happy Agent's
inference is implemented by the separately published, Node-only
`@slopus/happy-providers` library.

## 2. Process architecture

Happy Agent is the long-lived headless daemon. Clients connect to it through the public API.
Happy Terminal is the official TUI client, available through the `happy` CLI, its own
`happy-terminal` command, Happy Desktop, or an embedded Node.js host. A standalone
Happy Terminal installation also locates and starts a compatible Happy Agent release.

```text
   happy / happy-terminal / embedded host  (Happy Terminal, one per window)
            |
            |  HTTP + SSE over a unix socket, bearer token
            v
   happy-agent run  (the daemon: sessions, agents, tools, SQLite)
            |
            +-- provider inference  (happy-agent-base -> happy-providers -> vendor APIs)
            +-- sandboxed shell, filesystem, Docker, MCP, background terminals
            +-- sessions.sqlite
```

### The daemon

The daemon:

- creates its private runtime directory at `~/.happy/agent` (or beneath
  `HAPPY_HOME_DIR`), holding `server.sock`, `token`, `daemon.pid`, `daemon.log`,
  the SQLite stores, and `observation/agent.log`;
- listens on the unix socket only, with the socket `chmod`ed to `0600`, and
  authorizes every request against the token file;
- serves the protocol HTTP routes and WebSocket terminals;
- streams events as `text/event-stream`;
- owns the SQLite database and the domain modules for sessions, projects, Git,
  the model catalog, file search, MCP, Happy sync, and scheduling.

The daemon holds the agent loop, tool execution, and the sandbox. The terminal UI
holds no agent logic; if it dies, the session keeps running.

### The terminal UI

The standalone Happy Terminal CLI parses the command line and picks a mode: interactive app, headless
`exec`, monitor, daemon control (`happy-terminal daemon start|stop|kill|status|reload`), or offline
installation inspection (`happy-terminal inspect [--json]`). The daemon itself is the
standalone `happy-agent` CLI. Development builds use this checkout, while published Happy Terminal
installations select and verify a compatible Happy Agent release. Graceful stop waits for
the daemon PID to exit; `kill` uses the persisted PID when a daemon cannot shut down cleanly.

Inspection is the exception to the daemon-starting path below. It reads installation, CLI version,
and protocol compatibility facts without starting or contacting the daemon. A clean or
upgradeable inspection exits 0; incompatible, damaged, busy, or unreadable data exits 2 after
printing the same complete human or JSON result.

Before doing anything else, an interactive or headless run finds a running
daemon, checks that its identity matches the current build, and spawns one when
it does not. When the running daemon is older than the current build, the CLI
asks before restarting it. The client talks HTTP over the unix socket.

The interactive interface is built on Pi TUI. Its layout rules are strict: the
logical transcript is append-only, live above-composer status is compact and
never pulls history downward, and a resize is a full-frame redraw rather than a
partial reflow.

### The protocol between them

The protocol covers sessions, projects, the timeline, global security, project
files, and a version handshake. Its shape is deliberately two mechanisms:

- **Request/response** carries entities: sessions, projects, workspaces, models,
  transcripts, usage, secrets, subagents, MCP status.
- **An event stream** carries light, ordered updates. Cursors are monotonic
  UUIDv7 values, so events always sort. Three queues serve it: a live queue with
  bounded replay for local clients, an in-memory queue, and a persistent queue
  that writes durable entries and publishes only after the transaction commits.
  A client that reconnects presents its last cursor and either resumes or is
  told a gap occurred and it should re-fetch.

`@slopus/happy-agent-client` is the typed client for this protocol. It exposes
the documented request, SSE, and resource contracts over a caller-supplied
Fetch implementation, so Node, browser, and Unix-socket hosts share one API
surface without carrying daemon code.

### Remote terminals

Separately from the agent protocol, Happy Agent can remote a real terminal. Both ends run
libghostty: the daemon holds the canonical emulator and the client holds a
replica, and the ordered terminal bytes themselves are the delta — there is no
diffing step. Snapshot first, deltas afterwards. Reconnection, packet loss, and
state recovery are part of the protocol rather than session-ending failures.

## 3. Sessions

A session is one conversation with an agent, and it is the unit of durability.
The essentials:

- `InMemorySession` is the model. It runs turns, streams output, handles
  permissions, aborts, rewinds, goals, subagents, and metadata.
- `SessionEventLog` is the per-session append-only event history, plus the
  derived indexes a session needs to answer questions quickly (message identity,
  permission reviews, shell command state, provider quotas, retention window).
- Two stores implement the same `SessionStore` interface:
  `PersistentSessionStore` (the daemon's durable store, which also implements
  `InMemorySessionPersistence`) and `InMemorySessionStore` (a private in-memory
  SQLite database used by tests and the gym, so they exercise the real
  persistence contract without leaving state behind).
- **Database first, memory second.** Every change writes through persistence and
  only then updates in-memory state. This is not optional.

Because sessions live in the daemon and are persisted as they go, they survive a
closed terminal and a daemon restart. `happy-terminal resume`, `happy-terminal fork`,
`happy-terminal exec --resume`, and `--last` all reopen a stored session; headless runs are
ordinary persisted sessions.

Subagents are sessions too, with their transcripts saved and readable from the
parent.

## 4. Inference

### The layers

```text
happy-agent-base          the durable turn: inference, tools, compaction
        |
happy-agent-modules       reusable tools, hooks, and product capabilities
        |
happy-providers            the network: transports, framing, retries, errors, credentials
        |
vendor APIs              Codex, Claude Agent SDK, xAI Responses, Bedrock
```

### The turn

The agent loop runs one turn: build the provider prompt and message list, stream
inference, then execute every tool the model called — in parallel — and write all
tool results. Only after every tool call is closed may compaction run. Two
invariants hold throughout and are relied on by the provider layer:

- Nothing runs in parallel with an inference on the same session — not a second
  inference, not a compaction.
- No tool call is ever left open across an inference boundary.

The conversation Happy Agent keeps is richer than what goes to the model.
`isExcludedFromModelContext` separates the durable transcript from the model
context, so Happy Agent can show a user things the provider never sees. Opaque provider
data — `vendor`, `responseItems`, `encryptedReasoning` — is persisted verbatim and
passed back unchanged, which is what makes reasoning and parallel tool calls
replay correctly.

### Context and instructions

The system prompt is assembled per model family — Claude, Codex, Grok — and
extended by Happy Agent with the environment description, project instructions, and the
content of the project's `AGENTS.md` files. Happy Agent discovers those files,
fingerprints them, and re-delivers their content to the model when they change.

### Compaction

Compaction is a message, not a side effect. Happy Agent decides _when_; the provider
decides _how_.

- The auto-compact threshold compares an estimate of the current context against
  provider-reported usage, using the model's `autoCompactWindow` from the
  catalog.
- Happy Agent refuses to compact a conversation with unanswered tool calls — in either
  the summarized prefix or the retained tail — because that would hand the
  provider a broken history.
- Compaction is requested from the provider session itself, which uses the
  vendor's **native** compaction wherever one exists and the vendor's own
  compaction prompt where it does not. Happy Agent never substitutes a generic summary.
- The result is a `CompactionMessage` in the transcript recording the IDs of the
  messages it replaces, the provider-shaped replacement context, and before/after
  statistics. The "after" size starts as a local estimate and is rewritten as
  exact from the provider-reported usage of the first inference that follows.

`/compact` forces the same path immediately.

## 5. Providers

`@slopus/happy-providers` is the only place that talks to a vendor.

### The interface

```text
BaseProvider -> .session(id, options) -> BaseSession -> .run(request) -> SessionStream
                                                     -> .compact(options)
                                                     -> .destroy()
```

Happy Agent installs this package as a normal npm runtime dependency. The package is kept in the same
workspace for development, but it is built, versioned, tagged, and published independently rather
than compiled into the Happy Agent bundle.

Providers are **stateful**: a session is created once and used for many turns, so
connection reuse, prompt caching, sticky turn state, and native compaction are
possible. `run` is exclusive, and the caller supplies the complete durable
transcript on each turn while the session retains provider-native continuation
state.

Exported provider classes: `AnthropicProvider`, `CodexProvider`, `GrokProvider`, and
`ResponsesProvider`. `AnthropicProvider` selects its Claude Agent SDK or Bedrock Messages
implementation from the credential. Each provider follows the same fixed shape: a provider, a
session, credentials, native prompts, native tool definitions, and error parsing.

### Fidelity

The package's entire purpose is that a Happy Agent request looks like the native
client's request, in this priority order: prompt-cache prefix stability, system
prompts, tool definitions, message ordering. The caller supplies prompt and tool
_content_; the package must reproduce the _envelope_ — field names and nesting,
ordering, cache-control placement, headers, framing. The native prompts and tool
definitions of each vendor are kept verbatim; they are internal and never
exported, kept so golden-trace tests can reproduce real requests and so a reader
can check what the native client actually does.

Caller history is immutable here. A provider may make an ephemeral projection
while serializing one request (dropping reasoning blocks a vendor would reject),
but it must never return a rewritten history.

### Provider keys and configuration

Canonical provider keys are `codex` (OpenAI/GPT), `claude` (Anthropic),
`grok` (xAI), and `bedrock`. These are the `type` values in configuration and the
built-in instance IDs. SDK or transport names never leak into a provider key.

Configured provider entries are turned into executor provider definitions —
`codexExecution`, `claudeExecution`, `grokExecution`,
`configuredBedrockExecution` — and Happy Agent reports which configured providers lack
local credentials. Users can declare any number
of named instances (`[providers.work_codex]`) for separate accounts; a custom
instance must state its `type`, and the section suffix becomes the provider ID.

### Model catalogs

Catalogs are hardcoded in Happy Agent: model ID, display name, thinking levels, default
thinking level, context window, and auto-compact window. The catalog a user sees
combines that curated list with configuration and local credential presence. The
daemon never
discovers or fetches models from a provider API — startup must not wait on the
network — and a provider that is disabled or unauthenticated stays in the catalog
as a disabled entry with no models and a human-readable reason.

### Retries and errors

Retry semantics belong to the provider, never the outer loop. Everything
retryable is retried inside `happy-providers` and surfaced as `retrying` events; an
error that reaches the agent loop is terminal by definition and is displayed, not
replayed. Errors are parsed into a typed `SessionProviderError`
(`authentication`, `out_of_tokens`, `rate_limit`, `server_overloaded`,
`internal_server_error`, `unclassified`), and recorded real failure responses are
replayed through the real transport to keep the parsers honest.

### Usage and accounts

`SessionCacheUsage` reports `input` (always uncached), `output`, `cacheRead`,
`cacheWrite`, and `totalTokens`, normalized so each prompt token is counted once.
Quota observation is best-effort, bounded, and cached, and surfaces through
`/usage` and the `get_provider_usage` tool.

Automatic routing across multiple accounts of the same vendor is a direction, not
a feature. Today the pieces that exist are multiple configured provider
instances, model/provider compatibility checks, and usage reporting; account
selection is still the user's or the caller's choice.

## 6. Tools

### Vendor tools versus common tools

- **Vendor tools** are the provider's own surface — native names, argument
  schemas, and model guidance — one set each for Claude, Codex, and Grok. A
  Bedrock provider picks the Claude or Codex surface based on the model ID
  prefix.
- **Common tools** belong to Happy Agent itself and are identical for every model:
  scheduling (`wait`, `wait_until`, `schedule_message`), agent-tree usage,
  provider usage, plugin tools, and user-input cancellation. They are assembled
  in exactly one place, so a model added later picks them up with no
  per-provider work.
- Collaboration tools (subagents, workflows, messaging) are selected the same
  way, in the vendor's shape.
- Optional universal tools are additive: the Gemini tools when a Gemini API key
  is configured, and image generation behind a vendor-shaped surface.

Both entry points are routed from the same place. A model's tools are never
assembled by branching on a provider key or a tool-name list elsewhere.

Different names, one implementation: Claude's `Bash` and Codex's `exec_command`
run the same sandboxed shell, and Claude's `Read`/`Write` and Codex's
`apply_patch` cross the same filesystem boundary.

### Permissions

There is one permission model for every provider. The modes are **Read only**,
**Workspace write** (the default for new sessions), **Auto**, and
**Full access**; see [permissions-and-sandbox.md](permissions-and-sandbox.md).

Every tool definition owns its Auto behavior. `shouldReviewInAutoMode` is
required; `shouldRunInFullAccessInAutoMode` is defined only for reviewed actions
that genuinely must cross the sandbox; `requiresAutoOrFullAccess` marks tools such
as MCP whose external boundary Happy Agent cannot enforce locally. Review is automatic and
never becomes a question to the user: it ends in allow or deny, it covers only the
proposed action, and it never becomes a durable command policy. A denial that was
never actually made — a timeout, an unavailable reviewer — must tell the agent the
action is _unproven_ rather than unsafe, and a turn that keeps being refused has
to stop itself.

Escalation syntax is provider-shaped but requests the same runtime behavior:
Codex `exec_command` uses `sandbox_permissions: "require_escalated"` with a
`justification`, Claude `Bash` uses `dangerouslyDisableSandbox: true`, Grok
`run_terminal_command` uses `sandbox_permissions` with a `description`. In Auto,
an allowed escalation scopes only that one tool execution to full access and
restores Auto immediately afterwards. In Read only or Workspace write, the field
cannot bypass the selected mode.

Restricted shell commands use macOS Seatbelt or Linux Bubblewrap; managed network
access, when configured, goes through per-command HTTP CONNECT and SOCKS5 proxies
that are torn down with the command. Docker-backed sessions nest the same
Bubblewrap sandbox inside the container. Full details are in
[permissions-and-sandbox.md](permissions-and-sandbox.md).

## 7. Persistence

Everything durable is one asynchronous SQLite database under `~/.happy/agent` by default.
`HAPPY_HOME_DIR` moves the `.happy` root.

### Rules

One persistence layer owns every read and every mutation. No SQL — raw or
through the query builder — exists anywhere else. Reads are operations prefixed
with `query`. Every operation takes the transaction first and awaits one when it
needs it, which is a no-op inside an existing transaction, so each operation is
a complete consistency boundary that still composes. Each connection serializes
access through `asyncLock`; transaction-scoped work reuses its transaction
without reacquiring the lock. A database failure is fatal by policy: Happy Agent is
local, and continuing after one is not an option.

### What is stored

The schema holds projects, project workspaces and avatar
assets, sessions, session events, session messages, session context messages,
session turns, queued runs, durable user inputs, durable waits, scheduled
messages, secret registrations and their environment variables,
project secret attachments, Happy sync sessions and outbox, and the durable
global-event stream with its cursor state. It also holds local Happy Cloud enrollment and consent
records plus caller-encrypted profile and bounded mobile-session ciphertext.

Secrets are stored as plaintext JSON in this database. The file is mode `0600`
and its directory `0700`, which is access control, not encryption: replaced values
may persist in SQLite pages and the WAL.

Non-database daemon state under `~/.happy/agent` includes runtime settings, Happy credentials,
logs, the socket, and the authentication token. Happy Terminal keeps its client-specific runtime
settings under `~/.happy/happy-terminal`. User
configuration is separate, in `~/Happy/Config/happy.toml` (macOS) or
`~/happy/config/happy.toml` (Linux), with repository settings in `happy.toml`.

### Migrations

Happy Agent applies an ordered list of migration functions inside one immediate
transaction, advancing `PRAGMA user_version` after each one and stamping
`PRAGMA application_id`.

- **Migrations are immutable.** Once a migration exists, its contents and version
  never change, because a released Happy Agent may already have applied it. Every
  subsequent schema change is a new file.
- **Generations reset.** A database whose `application_id` does not match the
  current Happy Agent generation is dropped and rebuilt from the initial migration, which
  therefore contains the complete current schema with no backfill path. That is
  the early-stage policy: discard the old schema rather than carry compatibility
  code forward.
- A database from a _newer_ schema version than the running Happy Agent is an error, not
  a downgrade.

## 8. Package layout

`packages/` in a pnpm TypeScript workspace. Source lives in `sources/`, with
`sources/main.ts` for an executable and `sources/index.ts` for a library.

| Package                        | What it is                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/happy-agent`         | `@slopus/happy-agent` — the headless daemon executable and lifecycle used by every client.                                                                                 |
| `packages/happy-terminal`      | `@slopus/happy-terminal` — the reusable TUI, standalone `happy-terminal` command, Happy Agent launcher, and Node.js embedding API.                                         |
| `packages/happy-agent-base`    | `@slopus/happy-agent-base` — the minimal durable agent loop, provider routing, persistence, and feature hooks.                                                             |
| `packages/happy-agent-modules` | `@slopus/happy-agent-modules` — reusable agent tools, hooks, and product capabilities composed by Happy Agent.                                                             |
| `packages/happy-providers`     | `@slopus/happy-providers` — the separately published, Node-only vendor library: stateful sessions, transports, retries, error parsing, credentials, and native compaction. |
| `packages/happy-agent-client`  | `@slopus/happy-agent-client` — the typed request and SSE client for the public Happy Agent API.                                                                            |
| `packages/ghostty-wasm`        | `@slopus/ghostty-wasm` — the Ghostty terminal emulator compiled to WebAssembly, usable from Node and the browser.                                                          |
| `packages/ghostty-web`         | `@slopus/ghostty-web` — the client/server protocol for remoting a Ghostty-backed terminal: snapshot, VT replay, semantic-grid recovery, flow control, paged scrollback.    |
| `packages/happy-plugins`       | The typed API available to TypeScript plugins running inside Happy, plus the development runner.                                                                           |
| `packages/gym`                 | Private host-side end-to-end harness: PTY integration, fixtures, and the Docker image definition.                                                                          |
| `packages/gym-tests`           | Private black-box terminal scenarios exercising Happy Terminal and Happy Agent together in fresh containers.                                                               |

Inside a package, code is organized by domain module (`git`, `fs`, `sandbox`,
`docker`, `secrets`, `session`, `server`, `persistence`, …). A module's top level
holds what a reader needs; secondary helpers go in `impl/` with entity-then-
operation names; tests live in a nearby `tests/` directory rather than beside the
source; every directory carries a `README.md`. `happy-providers` is the deliberate
exception to one-function-per-file: it keeps larger files so a whole network path
stays readable in one place.

## 9. Testing

- Unit and integration tests run with Vitest next to the code they cover.
- Golden-trace tests in `happy-providers` compare reconstructed requests against
  real captured vendor traffic; recorded-response tests replay real HTTP failures
  through the real transport. Both are deterministic and need no credentials.
- Live tests are named `*.live.test.ts` and gated behind `HAPPY_TERMINAL_LIVE_TEST=1`.
- The **gym** (`pnpm test:gym`) runs the built CLI and daemon through a real PTY
  in a fresh Docker container. Only inference is mocked; the filesystem, shell,
  processes, daemon, tools, and terminal rendering are real, with `libghostty-vt`
  providing user-visible screen and scroll state. Use it for anything spanning
  terminal input or rendering, inference, tools, processes, filesystem effects,
  interruption, or concurrency.

For a bug fix, add the smallest deterministic test that reproduces the failure at
the layer where the broken contract is observable, keep that test unchanged while
fixing production code, and only then add lower-level tests.

## 10. Where the product runs ahead of the code

Some of Happy Agent's stated direction is ahead of what ships today. Where that gap
matters in practice, it is worth naming:

- **Pi as a tool surface.** A Pi `bash` tool is sometimes described alongside the
  Codex, Claude, and Grok surfaces. The implemented vendor tool surfaces are
  Claude, Codex, and Grok; Pi appears as the TUI library
  (`@earendil-works/pi-tui`), not as a provider or toolset.
- **Account routing** is not implemented. Multiple accounts can be configured as
  separate provider instances and chosen explicitly; automatic round-robin,
  weighted, or usage-aware routing between compatible accounts does not exist
  yet.
- **`fork` on `BaseSession`** is part of the provider contract but is not yet
  implemented, so there is currently no supported way to branch a provider
  session — including the compact-on-a-fork flow that motivates it.
  ivates it.
