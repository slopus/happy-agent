<div align="center">

<h1>Happy Agent</h1>

<h3>The best of Pi, Codex, Claude Code, and Grok Build — unified in one coding-agent harness.</h3>

<p>
  Use model-native prompts and tools with provider access already configured on
  your machine. Happy Agent adds no account or subscription of its own, never pools or
  resells provider access, and leaves provider terms and limits in force. 
  
  Built by the authors of
  <a href="https://github.com/slopus/happy">Happy</a> and
  <a href="https://github.com/slopus/happy2">Happy 2</a>.
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
execution, durable sessions, subagents, MCP, and a friendly terminal interface.

Happy Agent is the headless daemon: it owns agents, tools, permissions, durable
state, and the public API. Happy Terminal is its official TUI. The `happy` CLI
integrates that TUI, Happy Desktop can host it, and any Node.js application can
embed the same `@slopus/happy-terminal` package.

## Quick start

### Step 1: Choose a client

Use `happy` when Happy CLI is installed:

```sh
happy
```

Or install Happy Terminal directly:

```sh
npm install -g @slopus/happy-terminal
happy-terminal
```

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

### Step 3: Start building

```sh
cd your-project
happy-terminal
```

Ask for what you want in plain English. Happy Agent can inspect the repository, edit
files, run commands, delegate work, and verify the result. Use `/model` at any
time to choose an available model.

### Optional: Connect Happy mobile

Happy synchronization is enabled by default in the Happy Agent daemon. Disable it machine-wide in
`~/Happy/Config/happy.toml` on macOS or `~/happy/config/happy.toml` on Linux,
then restart the daemon:

```toml
[settings]
happy_integration = false
```

Repository `happy.toml` files cannot enable or disable this machine-level
integration. When enabled, Happy Agent automatically imports newer credentials from
`~/.happy` when its daemon starts. Desktop and other API clients can read the
current integration status, subscribe to connection updates, and start pairing
through the daemon API; the start response includes opaque `happy://` data to
render as a QR code. Clients can also cancel pairing, unlink this daemon, or
deliberately re-pair it. Happy is available alongside onboarding in desktop
bootstrap, but remains optional and never blocks onboarding completion. To
authenticate from the standalone terminal client, run:

```sh
happy-terminal happy auth
```

Scan the QR code with Happy. Terminals with Kitty or iTerm2 image support show
a PNG QR code; other terminals get Happy's compact text QR. Every primary Happy Agent
session you open is then synchronized live with Happy. Mobile messages enter
the same session and permission boundary as terminal messages; there is no
separate local/remote control mode.
Happy can also send encrypted image attachments, stop the active turn, and
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
  event stream let terminal, mobile, and web clients build on the same runtime.
  The [remote terminal API](REMOTE_TERMINALS.md) adds Ghostty-backed PTYs with
  WebSocket VT replay, semantic-grid recovery, credit-based flow control, and paged scrollback
  through the [hybrid client/server protocol](packages/ghostty-web/README.md).
- **Open and local.** Happy Agent is MIT licensed, runs beside your code, and keeps its
  execution boundaries visible.

The official terminal client, package, and canonical standalone command share one name:
**Happy Terminal**. Happy CLI exposes the TUI through `happy`.

## Embed in another Node.js project

Install Happy Terminal as an application dependency:

```sh
pnpm add @slopus/happy-terminal
```

Then run it inline on the host process's terminal:

```ts
import { runHappyTerminal } from "@slopus/happy-terminal";

await runHappyTerminal({ cwd: process.cwd() });
```

The promise resolves when the person exits Happy Terminal. The terminal is restored and the host
Node.js process keeps running. Startup failures reject the promise, while `onError` can receive
non-fatal background failures.

## How it works

Happy Agent separates inference transport from agent behavior. That lets it share one
runtime without flattening the important differences between models.

| Path              | What Happy Agent uses                                                                                            | What Happy Agent controls                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Pi foundation     | Pi's inference adapters and terminal UI library                                                                  | The shared terminal, permissions, sessions, processes, persistence, and client protocol                                 |
| Codex             | Pi's Codex transport, with [OpenAI's source](https://github.com/openai/codex) as the behavioral reference        | Reimplemented Codex prompts, tool contracts, reasoning controls, collaboration, approvals, review, and transcript rules |
| Claude Code       | Anthropic's official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) for direct inference | Reimplemented Claude-facing prompts, tools, tasks, subagents, permissions, and session behavior                         |
| Grok Build        | xAI's OpenAI-compatible Responses API and the credentials managed by the Grok CLI                                | Adapted [Grok Build](https://github.com/xai-org/grok-build) prompt, tools, token refresh, and request metadata          |
| Other model paths | Pi inference adapters and selected generic Pi tool definitions                                                   | A useful fallback experience without pretending those models are Codex or Claude Code                                   |
| External clients  | Happy Agent's local daemon, durable event stream, and protocol                                                   | One stable API for terminal, headless, mobile, web, or other interfaces                                                 |

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
| Headless and embedding | Text, JSON, streaming JSON, daemon protocol, and durable events       | Print, JSON, RPC, and a TypeScript SDK                       | Non-interactive mode, SDK, and app server | Print mode and Agent SDK                                |
| Best fit               | One local harness across model families and client apps               | Building a deeply customized agent                           | The first-party OpenAI experience         | The first-party Anthropic experience                    |

Happy Agent deliberately keeps Pi's strong foundations and extensibility, then chooses a
cohesive built-in experience where Pi prefers a minimal core. From Codex and
Claude Code it adopts widely useful workflows, not every product-specific edge
case.

## Everyday commands

Type `/` in the terminal to see the commands available in the current session.

| Command        | What it does                                           |
| -------------- | ------------------------------------------------------ |
| `/model`       | Choose the model and reasoning level                   |
| `/permissions` | Choose filesystem, shell, and network access           |
| `/agents`      | See delegated work and open a child transcript         |
| `/tasks`       | See the current Claude-style task list                 |
| `/goal`        | Start or manage a persistent long-running goal         |
| `/review`      | Review staged, unstaged, and untracked changes         |
| `/mcp`         | Check MCP servers, capabilities, and connection errors |
| `/workflows`   | Open the live workflow monitor                         |
| `/ps`          | List managed background terminals                      |
| `/compact`     | Summarize older messages and free context space        |
| `/usage`       | Show provider-reported token usage                     |
| `/configure`   | Change app settings                                    |

Press Escape while the session is idle to rewind to an earlier message. Happy Agent puts
that prompt back in the composer without changing files in the working directory.

## Sessions and automation

### Headless execution

Use `happy-terminal exec` when you want an agent result without opening the terminal UI:

```sh
happy-terminal exec "Review the current changes"
printf 'Run the tests and fix failures' | happy-terminal exec
```

Use `--json` for one machine-readable result or `--stream-json` for newline-
delimited session events followed by the final result:

```sh
happy-terminal exec --json "Summarize this repository"
happy-terminal exec --stream-json "Run the test suite"
```

Add `--debug` to an interactive or headless invocation to capture every request
as ordered JSON files under `.happy/happy-terminal/debug` in the project. Each request gets
a time-sortable directory containing normalized inference inputs, every
streamed provider event and final response, agent events and messages, tool
arguments and results, and run completion or failure details:

```sh
happy-terminal --debug
happy-terminal exec --debug "Diagnose the failing test"
```

The debug directory contains its own Git ignore rule. Its files use private
permissions, but can still contain complete prompts, source excerpts, command
output, and model reasoning; treat them as sensitive when sharing.

Daemon logs are separate from request debug traces. `happy-terminal daemon status` prints both paths. The raw
process log is `~/.happy/agent/daemon.log`; it captures stdout, stderr, dependency failures, and
fatal Node errors, and rotates to `daemon.previous.log` at 10 MiB. Structured runtime records are
written to `~/.happy/agent/observation/agent.log`, including every named shutdown step, its
duration, failures, and a warning when a step is still running after one second. `HAPPY_HOME_DIR`
moves the whole `.happy` root, including both logs and `daemon.pid`.

Headless runs are normal persisted sessions. Continue or branch from them later:

```sh
happy-terminal exec --last "Continue with the next issue"
happy-terminal exec --resume SESSION_ID "Try the alternative approach"
happy-terminal exec --last --fork "Explore a separate solution"
```

### Secrets

Use `/secrets` to register named bundles of environment variables and attach
them to the current session or project. Session attachments apply only to that
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
it to the model and place it in the transcript, saved session, events, or debug
records. Commands can also save values to files.

Per-command injection is not a process-isolation boundary. Processes running as
the same operating-system user or inside the same container must be mutually
trusted because they may be able to inspect one another's environments.

### Saved sessions

Use the picker to resume or fork work in the current directory. Add `--all` to
include sessions from other directories.

```sh
happy-terminal resume
happy-terminal resume --last
happy-terminal resume --all
happy-terminal fork --last
happy-terminal fork SESSION_ID
```

The model and provider can be changed between responses. Automatic compaction
keeps long conversations useful, and `/compact` is available whenever you want
to compact immediately.

### Persistent goals and code review

`/goal <objective>` starts work that can continue across multiple agent turns.
Use `/goal` to check it, `/goal pause`, `/goal resume`, or `/goal clear` to manage
it. Goals survive daemon restarts and resumed sessions.

`/review` asks the agent to review staged, unstaged, and untracked changes and
instructs it not to modify files.
Add a focus when useful, for example `/review focus on concurrency`.

## Permissions

New sessions start in **Workspace write** mode. Change the current session with
`/permissions`:

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

`HAPPY_TERMINAL_PERMISSION_MODE` can override the default for a new terminal session with
`auto`, `workspace_write`, `read_only`, or `full_access`.

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
Bedrock — Docker-backed sessions, MCP servers, theme and display, daemon
crash diagnostics, and workflows. The same reference ships inside Happy
Agent's bundled documentation, so agents can read it at runtime.

## Scope

Happy Agent aims for the best common coding-agent workflows, not exhaustive parity with
every upstream option. It intentionally keeps planning in the normal agent flow,
uses standard terminal editing instead of modal editing, follows Codex skill
semantics, and relies on the existing Codex, Claude Code, and Grok login
flows.

Happy Agent also draws a clear boundary around the terminal UI. The terminal is for a
focused, linear agent workflow. Features that need a richer interaction model—
such as drag-and-drop, multiple independently scrolling panes, or complex visual
workspaces—belong in a dedicated UI built on Happy Agent's durable API. Happy Agent provides the
harness; it does not squeeze desktop-app interactions into a terminal.

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
