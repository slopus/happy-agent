# Happy Agent Rust runtime

The npm command now launches one Rust executable. `infer`, `agent`, and the Unix
`supervisor` are subcommands of that executable. No Bun, Claude Code SDK,
JavaScript daemon, or extracted supervisor executable is used by this runtime.

The native executable now retains the original `start`, `run`, `status`, `drain`,
`stop`, `kill`, and `reload` commands, help text, and lowercase `-v` version flag.
The standalone daemon serves authenticated health, authentication, greeting,
drain, shutdown, and the specified unavailable-inspector response over the original
private Unix socket. Its launcher uses the same executable's `run` role. Token
reuse, local signal drain, and shutdown are exercised through real processes.
Global instruction and security documents, event pages, and resumable SSE are
available through the same API. The unchanged published client reads these
documents and follows live events in an executable integration test. Drain
waits for admitted HTTP mutations, including requests still sending their body.

This is an incomplete product migration. The remaining API namespaces, terminal
UI, agent restoration, product modules, background terminals, MCP, services, cloud,
runner, and Windows sandbox integration are still pending. Existing desktop and
terminal clients cannot yet use the complete product through this executable.
Claude Code integration is skipped.
Direct Anthropic HTTP and Anthropic on Bedrock are separate supported transports.

Rust callers inside the executable can use `happy_agent_supervisor::command()`;
it resolves `current_exe()` and appends `supervisor`. The CLI dispatches that
subcommand before starting Tokio threads. Product shell tools have not migrated,
so their policy review and supervisor invocation are a subsequent integration.

The adapters below are implemented migration code. Validation uses mock inference
over real sockets and retained response recordings; no live vendor inference or
live authentication was run. They do not yet establish native-client parity.

| Adapter                   | Exercised behavior                                                                                                                                                                                    | Remaining fidelity work                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex Responses / Lite    | SSE rollback, fragmented UTF-8, interleaved call IDs and arguments, terminal quota errors, cancellation; Lite WebSocket warmup, connection reuse, and continuation across reconstructed assistant IDs | Full request/header goldens, curated capability validation, missing previous-response recovery, model/transport switches, complete namespace/grammar/tool-search behavior, login refresh races, native compaction checkpoints |
| Generic Responses         | Minimal request envelope, usage, rollback, immutable input                                                                                                                                            | Endpoint-specific capabilities, strict/custom tool schemas, compaction request/response goldens                                                                                                                               |
| Direct Anthropic          | Signed thinking replay, cache accounting, SSE completion                                                                                                                                              | Full cache-placement goldens, compaction, server-tool result rendering and continuation, beta/capability negotiation, vendor retry schedules                                                                                  |
| Anthropic Bedrock Runtime | Fragmented AWS event-stream frames, CRC rejection, signed thinking and terminal usage                                                                                                                 | SigV4 and refreshed AWS credentials against AWS, exception-frame taxonomy, real server-tool and compaction continuation, regional routing                                                                                     |
| Bedrock Mantle / Codex    | Request routing and credential/signing code compile                                                                                                                                                   | Live inference, exact identification headers, native Responses and Anthropic goldens, expired-signature handling                                                                                                              |
| Grok                      | Retained live web/X-search response recordings, hosted calls excluded from local execution, opaque replay metadata and usage                                                                          | Native request/continuation/compaction goldens, hosted result presentation, login renewal and vendor error/retry details                                                                                                      |
| Kimi / GLM on Bedrock     | Chat Completions usage arriving after finish reason                                                                                                                                                   | Full model/tool/image goldens, namespaced and partially streamed tool identities, GLM-specific errors, summary compaction fidelity and Kimi's bounded preserved-user prefix                                                   |

The shared session `fork` operation, account discovery, quota observation, and
image generation are not migrated. Provider retry ownership and tentative block
rollback are exercised; each vendor's precise retry schedule still needs porting.
Function/custom arguments are assembled by call identity, but complete native
tool-search and grammar execution semantics remain to be migrated. Vendor tools,
prompts, skills, and historical golden fixtures remain unchanged as evidence.

```text
npm launcher -> happy-agent
                   +-- start/status/drain/stop/kill/reload -> local daemon
                   +-- run        -> authenticated API -> original installation database
                   +-- infer      -> provider session -> HTTP / WebSocket
                   +-- agent      -> SQLite stages -> provider / tool traits
                   `-- supervisor -> existing Unix OS sandbox library
```

Build and verify from the repository root:

```sh
pnpm build
pnpm check
pnpm test
pnpm --filter @slopus/happy-agent build:native --debug-host
pnpm --filter @slopus/happy-agent exec node bin/happy-agent.cjs --help
```

The development build uses the host toolchain. Release builds use native runners
with Linux musl, Apple Darwin, or Windows MSVC targets. Linux packages must pass
an ELF interpreter check before packaging. macOS links Apple system libraries;
it is a single executable, not a fully static operating-system image. Windows
uses a static CRT and system DLLs. The Windows sandbox implementation has not
been integrated; its supervisor command fails explicitly. Cross-compilation and
platform signing are configured in CI. Only the Linux x64 build has been
verified locally for this migration slice; the other four builds have not run.

`infer --config provider.json` reads one JSON request from stdin and prints ordered
stream events as JSON lines. The provider configuration selects the protocol,
credentials, model, endpoint, transport, retry budget, effort capabilities, and
Bedrock region. Use an environment reference for API keys:

```json
{
    "kind": "responses",
    "credential": { "type": "environment", "variable": "OPENAI_API_KEY" },
    "model": "gpt-5.5",
    "endpoint": "https://api.openai.com/v1",
    "responsesFeatures": true,
    "parallelToolCalls": true
}
```

```sh
printf '%s\n' '{"request":{"context":{"instructions":"Be concise.","messages":[{"role":"user","content":[{"type":"text","text":"Hello"}]}]}}}' |
    happy-agent infer --config provider.json
```

`kind` supports `codex`, `responses`, `grok`, `claude`, `kimi`, and `glm`.
`claude` uses Anthropic Messages directly; it never launches Claude Code.
Credentials support environment variables, explicit bearer tokens, native Codex
or Grok auth files, and the AWS SDK default credential chain, including profiles,
SSO, credential processes, and expiring credentials. Codex refreshes a rejected
stored login within its provider retry budget. Grok login refresh maintenance is
not yet migrated. `bedrock` selects `mantle` or `runtime`; Kimi/GLM require Bedrock.

`agent --config agent.json --store conversation.rust.sqlite` reads control JSON
lines. Its configuration contains `id`, `instructions`, `provider` (the object
above), and optional `permissionMode`, `metadata`, and `parentId`.

```json
{"type":"send","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},"options":{"id":"my-delivery-id"}}
{"type":"steer","message":{"role":"user","content":[{"type":"text","text":"Use a short answer"}]}}
{"type":"status"}
{"type":"abort"}
{"type":"compact"}
{"type":"drain"}
```

The agent command currently supplies an empty tool array. Rust applications can
extend the base through its `Tool` and `SessionFactory` traits. An unavailable
model-requested tool receives an error result and closes through the same durable
batch lifecycle. The CLI does not imply that product shell or filesystem tools
have already migrated.

The base currently exposes one agent worker and tool-owned permission traits.
The product's module hooks, multi-agent registry/routing, full filesystem and
shell permission boundary and background compaction via session forks still need
integration. The bounded public API journal is implemented; agent history and
module events still need to be connected to it. The retained TypeScript chaos, formal
verification, and gym suites have not been ported or run against this runtime;
the Rust tests exercise the explicitly migrated stages and restart cases.

Message admission, profile changes, inference blocks, tool dispatch/results,
and settlement use transactional SQLite operations. Only completed blocks enter
history. Interrupted non-durable tools receive an error result; durable tools
may resume using their persisted invocation ID. Each tool result commits at most
once, together with its call-scoped state; tool state expires at that commit.
Queued input remains queued after abort or terminal failure until another message
requests work. Follow-ups remain usable after settlement. Drain retains the next
stage for restart. An exclusive SQLite lock prevents a second process from
opening the same store. The internal JSON diagnostic worker still uses its isolated
migration schema and refuses old TypeScript databases. The product daemon opens the
original `agent.sqlite`, retains the original base and installation tables and
immutable migration ledger, and uses the canonical `agent.sqlite.lock` and matching-token
`agent.lock` ownership boundaries. Populated-installation tests verify epoch,
records, KV, unrelated tables, and migration retention across kill and restart.
Resuming that installation's agents and remaining feature state is still pending.

The JSON command/event surface is an internal migration interface. It is not the
Happy Agent desktop API and does not change `API.md` or its protocol versions.

Native package generation uses `package-native.mjs platform --version <version>
--target <platform> --binary <file>` and `package-native.mjs root --version
<version>`. The root npm package contains only a launcher and exact optional
platform-package versions. Each platform package contains exactly one native
executable. These commands produce reviewable tarballs; they do not publish.

Validate a packed installation with `verify-native-package.mjs <root.tgz>
<host-platform.tgz>`. It unpacks both packages into an isolated npm-style layout,
checks that the platform package contains one executable, and runs the launcher's
command and exit-code forwarding through that installed native package.
