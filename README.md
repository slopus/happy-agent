<div align="center">

<h1>Happy Agent</h1>

<h3>The best of Pi, Codex, Claude Code, and Grok Build — unified in one coding-agent harness.</h3>

<p>Part of <a href="https://happy.engineering/">Happy</a>. Main repository: <a href="https://github.com/slopus/happy">slopus/happy</a>.</p>

<p>
  The open-source agent runtime behind the
  <a href="https://happy.engineering/">Happy</a> desktop app
  (<a href="https://github.com/slopus/happy-desktop">source</a>).
  Use model-native prompts and tools with provider access already configured on
  your machine. Happy Agent adds no account or subscription of its own, never pools or
  resells provider access, and leaves provider terms and limits in force.
</p>

<p>
  Built by the authors of the
  <a href="https://github.com/slopus/happy-desktop">Happy desktop app</a> and the
  <a href="https://github.com/slopus/happy">original Happy CLI</a>.
</p>

https://github.com/user-attachments/assets/99a7dee6-36ef-4110-95b2-e236633640a4

<p>
  <a href="#quick-start">Quick start</a> ·
  <a href="#why-happy-agent">Why Happy Agent?</a> ·
  <a href="#how-happy-agent-compares">Compare</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="DEVELOPMENT.md">Development</a>
</p>

</div>

Happy Agent is an open-source coding-agent harness built on top of
[Pi](https://github.com/earendil-works/pi)'s foundations. It recreates the best
parts of [Codex](https://github.com/openai/codex),
[Claude Code](https://code.claude.com/docs/en/overview), and
[Grok Build](https://github.com/xai-org/grok-build) in one consistent local
runtime: the right prompts and tools for each model, useful defaults, safe
execution, durable sessions, subagents, MCP, and one stable API for every client.

Happy Agent is the headless daemon: it owns agents, tools, permissions, durable
state, and the public API. The [Happy desktop app](https://happy.engineering/)
runs on it and connects through `@slopus/happy-agent-client`.

**Most people should install the desktop app** from
[happy.engineering](https://happy.engineering/). Open it and setup runs itself:
Happy starts its own agent runtime and picks up the Claude, Codex, and Grok
sign-ins already on your machine. The rest of this README is for developers who
want to run Happy Agent directly or build on it.

## Quick start

### Step 1: Install Happy Agent

Download the Happy Agent release for your platform from
[GitHub Releases](https://github.com/slopus/happy-agent/releases), verify its checksum, and start
the daemon:

```sh
happy-agent start
happy-agent status
```

The `happy` command in your terminal belongs to the original Happy CLI, not to
Happy Agent or the desktop app.

### Step 2: Sign in to the agents you want to use

Happy Agent does not have another account to create. Run the coding agents you want and
complete their normal sign-in:

```sh
codex
claude
grok login
```

Happy Agent then uses the credentials already managed by those installations. The daemon
checks local credential presence when it starts without contacting provider
servers. Restart the daemon after a new login so the provider enters the model
catalog. Once enabled, Grok credential rotations are hot-reloaded from its
local auth store without copying tokens into Happy Agent.

### Step 3: Connect a client

Open the Happy desktop app, or build your own client on `@slopus/happy-agent-client`. Every
client speaks the same [Happy Agent API](packages/happy-agent/API.md) over the daemon's private
socket.

### Optional: Connect the Happy mobile app

Happy synchronization is enabled by default in the Happy Agent daemon. Disable it machine-wide in
`~/Happy/Config/happy.toml` on macOS or `~/happy/config/happy.toml` on Linux,
then restart the daemon:

```toml
[settings]
happy_integration = false
```

Repository `happy.toml` files cannot enable or disable this machine-level
integration. When enabled, Happy Agent automatically imports newer credentials from
the original Happy CLI's `~/.happy` when its daemon starts. Desktop and other API clients can read the
current integration status, subscribe to connection updates, and start pairing
through the daemon API; the start response includes opaque `happy://` data to
render as a QR code. Clients can also cancel pairing, unlink this daemon, or
deliberately re-pair it. Happy is available alongside onboarding in desktop
bootstrap, but remains optional and never blocks onboarding completion. In the
desktop app, pair from Settings → Mobile Access, then scan the QR code with Happy for
[iOS](https://apps.apple.com/us/app/happy-claude-code-client/id6748571505) or
[Android](https://play.google.com/store/apps/details?id=com.ex3ndr.happy).
Every primary Happy Agent session you open is then synchronized live with the mobile app.
Mobile messages enter the same session and permission boundary as every other client's
messages; there is no separate local/remote control mode.
The mobile app can also send encrypted image attachments, stop the active turn, and
select any provider-qualified Happy Agent model and supported reasoning level.

## Why Happy Agent?

Pi is a wonderfully small, flexible foundation. Codex, Claude Code, and Grok
Build each add excellent model-specific behavior, but they expose different
tools, permissions, session models, and integration protocols. Happy Agent brings those ideas together
without making you rebuild the setup for every model, machine, or repository.

- **Feels native to the model.** GPT receives Codex-style prompts and tools;
  Claude receives Claude Code-style prompts and tools; Grok receives the
  open-source Grok Build prompt and tool contracts.
- **One dependable workflow.** Sessions, permissions, MCP, Docker, background
  commands, reviews, goals, and headless execution work through one interface.
- **Thoughtful defaults.** A fresh install is useful immediately, while global
  and project-local configuration remain available when you need them.
- **Ready for other clients.** A local daemon, persisted sessions, and a durable
  event stream let desktop, mobile, and web clients build on the same runtime.
  The [remote terminal API](REMOTE_TERMINALS.md) adds Ghostty-backed PTYs with
  WebSocket VT replay, semantic-grid recovery, credit-based flow control, and paged scrollback
  through the [hybrid client/server protocol](packages/ghostty-web/README.md).
- **Open and local.** Happy Agent is MIT licensed, runs beside your code, and keeps its
  execution boundaries visible.

## How it works

Happy Agent separates inference transport from agent behavior. That lets it share one
runtime without flattening the important differences between models.

| Path              | What Happy Agent uses                                                                                            | What Happy Agent controls                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Pi foundation     | Pi's inference adapters                                                                                          | The shared permissions, sessions, processes, persistence, and client protocol                                           |
| Codex             | Pi's Codex transport, with [OpenAI's source](https://github.com/openai/codex) as the behavioral reference        | Reimplemented Codex prompts, tool contracts, reasoning controls, collaboration, approvals, review, and transcript rules |
| Claude Code       | Anthropic's official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) for direct inference | Reimplemented Claude-facing prompts, tools, tasks, subagents, permissions, and session behavior                         |
| Grok Build        | xAI's OpenAI-compatible Responses API and the credentials managed by the Grok CLI                                | Adapted [Grok Build](https://github.com/xai-org/grok-build) prompt, tools, token refresh, and request metadata          |
| Other model paths | Pi inference adapters and selected generic Pi tool definitions                                                   | A useful fallback experience without pretending those models are Codex or Claude Code                                   |
| External clients  | Happy Agent's local daemon, durable event stream, and protocol                                                   | One stable API for desktop, headless, mobile, web, or other interfaces                                                  |

The Codex integration is implemented inside Happy Agent rather than wrapping the Codex
CLI. Happy Agent follows the open-source client closely so prompts, tools, permissions,
and interaction patterns behave as Codex models expect while still participating
in Happy Agent's shared runtime.

Claude takes a different route. Happy Agent calls the official Claude Agent SDK directly
for inference, but disables its built-in tools, skills, slash commands, and
filesystem settings. Happy Agent then supplies its own implementations of those surfaces.
This keeps Claude's native inference path while giving Happy Agent one place to control
tools, permissions, persistence, subagents, and client events.

Grok Build uses xAI's Responses API at the same first-party proxy as the
open-source CLI. Happy Agent reads Grok's scoped auth store on every request, prefers an
active interactive session over `XAI_API_KEY`, proactively refreshes expiring
OIDC credentials, persists rotated refresh tokens, and sends Grok's native
request identity headers. Its curated model catalog is built into Happy Agent, just like
the catalogs for every other provider, so daemon startup never waits on model
discovery. `grok-build` keeps its always-on reasoning behavior, while models
without effort support receive no effort override. A failed inference request
is not replayed.

That separation is what makes Happy Agent flexible: transports can stay provider-native
while the surrounding harness remains consistent and independently evolvable.
Anthropic's [current Claude plan policy](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
explicitly includes third-party apps authenticated through the Agent SDK: their
usage continues to draw from the user's subscription limits. Happy Agent follows that
local SDK path. It does not host a Claude login, relay credentials through a Happy Agent
service, pool access, or bypass Anthropic's terms and limits.

## How Happy Agent compares

Happy Agent is a unifying harness, not a replacement for every surface offered by Pi,
Codex, or Claude Code. This table focuses on the local coding-agent experience.

|                        | Happy Agent                                                           | [Pi](https://github.com/earendil-works/pi)                   | [Codex](https://github.com/openai/codex)  | [Claude Code](https://code.claude.com/docs/en/overview) |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------- |
| Primary role           | Opinionated multi-model harness                                       | Minimal, highly extensible agent toolkit                     | OpenAI's native coding agent              | Anthropic's native coding agent                         |
| Model access           | Codex, Claude Code, Grok Build, and optional Bedrock models           | Broad multi-provider catalog                                 | OpenAI models                             | Claude models, including supported cloud platforms      |
| Authentication         | Reuses Codex, Claude Code, and Grok credentials                       | Pi logins or provider API keys                               | ChatGPT sign-in or API key                | Claude sign-in, API, or supported cloud provider        |
| Tool behavior          | Switches between model-native Codex, Claude, and Grok toolsets        | Small generic core, replaceable with extensions              | Codex-native                              | Claude Code-native                                      |
| Subagents              | Built in, with provider-aligned controls and saved transcripts        | Intentionally extension-driven                               | Built-in multi-agent tools                | Built-in subagents and agent teams                      |
| Permissions            | Unified Auto, Workspace write, Read only, and Full access modes       | Intentionally extension- or container-driven                 | Native approvals and sandboxing           | Native permission modes                                 |
| MCP                    | Built-in stdio and streamable HTTP                                    | Available through extensions                                 | Built in                                  | Built in                                                |
| Long-running work      | Managed shells, workflows, persistent goals, and background subagents | Intentionally uses external tools such as tmux or extensions | Background commands and multi-agent work  | Background commands, tasks, and agents                  |
| Headless and embedding | Daemon protocol, typed client, and durable events                     | Print, JSON, RPC, and a TypeScript SDK                       | Non-interactive mode, SDK, and app server | Print mode and Agent SDK                                |
| Best fit               | One local harness across model families and client apps               | Building a deeply customized agent                           | The first-party OpenAI experience         | The first-party Anthropic experience                    |

Happy Agent deliberately keeps Pi's strong foundations and extensibility, then chooses a
cohesive built-in experience where Pi prefers a minimal core. From Codex and
Claude Code it adopts widely useful workflows, not every product-specific edge
case.

## Sessions and automation

### Secrets

Register named bundles of environment variables and attach them to the current session or
project. Session attachments apply only to that
session. Project attachments apply to current and future sessions opened in the
same project. When both sources attach a bundle, detaching one source leaves the
other attachment intact.

Shell commands receive no secret values by default. Set the command's optional
`secrets` argument to a list of the attached bundle IDs that command needs. One
or several bundles can be selected; an empty list selects none. Happy Agent rejects IDs
that are not attached to the current session or project.

Registrations, including their values, are persisted as plaintext JSON in Happy Agent's
SQLite database. The database file is restricted to mode `0600` and its parent
directory is created with mode `0700`. This is not encryption or secure
deletion: SQLite pages and WAL files may retain replaced or removed values.

Happy Agent-generated prompts, list responses, attachment events, command metadata, and
permission summaries contain bundle IDs and environment-variable names, never
values. Command output is not redacted: a command that prints a value can send
it to the model and place it in the transcript, saved session, or events. Commands can also save values to files.

Per-command injection is not a process-isolation boundary. Processes running as
the same operating-system user or inside the same container must be mutually
trusted because they may be able to inspect one another's environments.

### Saved sessions

Sessions live in the daemon and are persisted as they go, so they survive a disconnected
client and a daemon restart. The model and provider can be changed between responses.
Automatic compaction keeps long conversations useful, and `/compact` is available whenever you
want to compact immediately.

### Daemon logs

The raw process log is `~/.happy/agent/daemon.log`; it captures stdout, stderr, dependency
failures, and fatal Node errors, and rotates to `daemon.previous.log` at 10 MiB. Structured runtime
records are written to `~/.happy/agent/observation/agent.log`, including every named shutdown step,
its duration, failures, and a warning when a step is still running after one second.
`HAPPY_HOME_DIR` moves the whole `.happy` root, including both logs and `daemon.pid`.

### Persistent goals and code review

`/goal <objective>` starts work that can continue across multiple agent turns.
Use `/goal` to check it, `/goal pause`, `/goal resume`, or `/goal clear` to manage
it. Goals survive daemon restarts and resumed sessions.

`/review` asks the agent to review staged, unstaged, and untracked changes and
instructs it not to modify files.
Add a focus when useful, for example `/review focus on concurrency`.

## Permissions

New sessions start in **Workspace write** mode. A client can change the current session's
mode:

| Mode                | Behavior                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Auto**            | Runs routine workspace work immediately and reviews risky actions automatically, asking when needed            |
| **Workspace write** | Allows edits in the working directory and temporary paths while blocking shell network access and other writes |
| **Read only**       | Keeps files read only while allowing Codex-style host reads on macOS and Linux                                 |
| **Full access**     | Allows unrestricted filesystem, shell, and network access                                                      |

Restricted local shell commands use macOS Seatbelt or Linux Bubblewrap. Both
platforms keep the host readable so tools such as Git, language managers, and
AWS can load normal user configuration, while writes remain limited by the
selected mode and shell network access stays blocked. An AWS command can read
the configured profile in Workspace write, for example, but needs an approved
Full access execution to contact AWS. Install `bubblewrap` on Linux before
using a restricted permission mode. Managed network access on Linux also
requires `socat`.

Auto mode evaluates the current action against the user's request. It does not
build a permanent command allowlist. Sensitive escalation requests receive a
one-call review and fail closed when the review is unavailable or malformed.
When a review allows one command to run outside the sandbox, that command's
history explicitly says `Approved automatically: temporary Full access.` This
applies only to that tool call; the session returns to Auto immediately
afterward. Removing proxy environment variables does not itself escape
Seatbelt or Bubblewrap, but an approved temporary Full access command has
unrestricted network access by design.

Set the default globally or for a repository:

```toml
[defaults]
permission_mode = "workspace_write"
```

## Configuration

Happy Agent reads user-wide settings from `~/Happy/Config/happy.toml` on macOS
and `~/happy/config/happy.toml` on Linux, and repository settings from the
repository's root `happy.toml`. Repository values win where both are allowed.
MCP servers are configured separately in `mcp.toml` files.

A small project configuration might look like this:

```toml
[defaults]
permission_mode = "workspace_write"

[features]
workflows = true

[theme]
brand = "ansi:202"
accent = "cyan"
```

The complete reference lives in
[docs/configuration.md](docs/configuration.md). It covers file locations and
environment variables, protected paths, managed workspace setup, managed
network access, providers — Codex, Claude Code, Grok Build, and Amazon
Bedrock — Docker-backed sessions, MCP servers, theme and display, heap
snapshots, and workflows. The same reference ships inside Happy
Agent's bundled documentation, so agents can read it at runtime.

## Scope

Happy Agent aims for the best common coding-agent workflows, not exhaustive parity with
every upstream option. It intentionally keeps planning in the normal agent flow,
follows Codex skill semantics, and relies on the existing Codex, Claude Code, and Grok login
flows.

Happy Agent provides the harness and its durable API; interfaces belong to the clients built on
it.

It does not add a separate Plan mode, Vim mode, notebook editor, durable command
allow/deny history, dedicated IDE integration, or a separate Happy Agent account. These
boundaries keep the harness understandable and the defaults strong.

## Development and contributing

Want to work on Happy Agent itself? See [DEVELOPMENT.md](DEVELOPMENT.md) for repository
setup, tests, architecture notes, and the release process.

## License

Happy Agent is available under the [MIT License](LICENSE). Adapted Grok Build portions
remain under Apache-2.0; see
the [third-party notices](THIRD-PARTY-NOTICES.md).
