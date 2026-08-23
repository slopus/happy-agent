<div align="center">

<h1>Happy Agent</h1>

<h3>The best of Pi, Codex, Claude Code, Kimi Code, and Grok Build — unified in one coding-agent harness.</h3>

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
[Claude Code](https://code.claude.com/docs/en/overview),
[Kimi Code](https://code.kimi.com), and
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
kimi login
grok login
```

Happy Agent then uses the credentials already managed by those installations. The daemon
checks local credential presence when it starts without contacting provider
servers. Restart the daemon after a new login so the provider enters the model
catalog. Once enabled, Kimi and Grok credential rotations are hot-reloaded from
their local auth stores without copying tokens into Happy Agent.

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
`~/.happy` when its daemon starts. To authenticate from the standalone terminal client,
run:

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

Pi is a wonderfully small, flexible foundation. Codex, Claude Code, Kimi Code,
and Grok Build each add excellent model-specific behavior, but they expose different
tools, permissions, session models, and integration protocols. Happy Agent brings those ideas together
without making you rebuild the setup for every model, machine, or repository.

- **Feels native to the model.** GPT receives Codex-style prompts and tools;
  Claude receives Claude Code-style prompts and tools; Kimi receives its coding
  prompt and Chat Completions contract; Grok receives the open-source Grok Build
  prompt and tool contracts.
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
| Kimi Code         | Moonshot's OpenAI-compatible Chat Completions API and credentials managed by Kimi Code                           | Adapted Kimi prompt, tool schemas, max reasoning, context compaction, token refresh, and request metadata               |
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

Kimi K3 uses Moonshot's coding endpoint and the session already managed by Kimi
Code. Happy Agent sends K3's max-reasoning contract, preserved reasoning content,
normalized function schemas and tool-call IDs, prompt-cache key, usage metadata,
and adapted Kimi coding, compaction, subagent, and per-tool contracts. Kimi's
native names and guidance are mapped onto Happy Agent's shared tool executions and
permission boundary rather than creating a provider-specific security path.
Token refresh is serialized with Kimi Code's cross-process lock and rotated
credentials are written back atomically.

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

|                        | Happy Agent                                                            | [Pi](https://github.com/earendil-works/pi)                   | [Codex](https://github.com/openai/codex)  | [Claude Code](https://code.claude.com/docs/en/overview) |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------- |
| Primary role           | Opinionated multi-model harness                                        | Minimal, highly extensible agent toolkit                     | OpenAI's native coding agent              | Anthropic's native coding agent                         |
| Model access           | Codex, Claude Code, Kimi Code, Grok Build, and optional Bedrock models | Broad multi-provider catalog                                 | OpenAI models                             | Claude models, including supported cloud platforms      |
| Authentication         | Reuses Codex, Claude Code, Kimi Code, and Grok credentials             | Pi logins or provider API keys                               | ChatGPT sign-in or API key                | Claude sign-in, API, or supported cloud provider        |
| Tool behavior          | Switches between model-native Codex, Claude, Kimi, and Grok toolsets   | Small generic core, replaceable with extensions              | Codex-native                              | Claude Code-native                                      |
| Subagents              | Built in, with provider-aligned controls and saved transcripts         | Intentionally extension-driven                               | Built-in multi-agent tools                | Built-in subagents and agent teams                      |
| Permissions            | Unified Auto, Workspace write, Read only, and Full access modes        | Intentionally extension- or container-driven                 | Native approvals and sandboxing           | Native permission modes                                 |
| MCP                    | Built-in stdio and streamable HTTP                                     | Available through extensions                                 | Built in                                  | Built in                                                |
| Long-running work      | Managed shells, workflows, persistent goals, and background subagents  | Intentionally uses external tools such as tmux or extensions | Background commands and multi-agent work  | Background commands, tasks, and agents                  |
| Headless and embedding | Text, JSON, streaming JSON, daemon protocol, and durable events        | Print, JSON, RPC, and a TypeScript SDK                       | Non-interactive mode, SDK, and app server | Print mode and Agent SDK                                |
| Best fit               | One local harness across model families and client apps                | Building a deeply customized agent                           | The first-party OpenAI experience         | The first-party Anthropic experience                    |

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

Happy Agent reads user-wide settings from `~/Happy/Config/happy.toml` on macOS and
`~/happy/config/happy.toml` on Linux. The user's global `AGENTS.md` lives beside
it. On startup, Happy Agent creates the platform-specific folder, a comprehensive
commented `happy.toml` template, and an empty `AGENTS.md` whenever they are
missing. Existing files are never replaced. Set `HAPPY_TERMINAL_CONFIGURATION_DIRECTORY`
to an absolute path to choose a different user configuration folder.

Repository settings come only from `happy.toml`. Repository values win where
both are allowed. MCP servers use these same Happy Agent-owned configuration layers;
provider configuration files are not imported.

Happy Agent keeps daemon state in `~/.happy/agent`, including its databases, token, socket, logs,
and runtime configuration. `HAPPY_HOME_DIR` moves the `.happy` root. Happy Terminal keeps only
client-specific runtime settings beneath `~/.happy/happy-terminal`; set `HAPPY_TERMINAL_HOME` to
an absolute path to move that client state.

Managed workspaces are user-facing folders rather than internal Happy Agent state. New
workspaces default to `~/Happy/Workspaces` on macOS and
`~/happy/workspaces` on Linux. Set `HAPPY_AGENT_WORKSPACES_DIRECTORY` to an absolute
path before starting the daemon to choose another location. Every workspace's
absolute path is saved in SQLite when it is created, so changing the variable
affects only new workspaces; existing ones stay where they are and do not need
to be moved.

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

### Protected paths

Add existing workspace-relative files or directories to a project's
`happy.toml` when modifying them should require Full access:

```toml
[permissions]
protected_paths = ["master-plans", ".env.production"]
```

The user-wide `happy.toml` supports the same list, and Happy Agent merges the user and
project entries. Directory entries cover their descendants. Missing entries
are ignored when the session starts; recreating the session picks up paths that
were created later.

### Managed workspace setup

A repository can prepare every managed workspace before Happy Agent starts an agent in
it. Add ordered shell commands to the repository's protected `happy.toml`:

```toml
[workspace]
setup_commands = [
  "pnpm install --frozen-lockfile",
  "pnpm build",
]
```

Happy Agent creates the Git worktree, runs each command in order from the workspace
directory with the system login shell, and marks the workspace ready only after
all commands succeed. A failed or timed-out command leaves the workspace failed,
skips the remaining commands, and prevents sessions and inference from starting
there. These commands are trusted project lifecycle code and run with full
filesystem and network access. Each command has a 30-minute limit.
The same setting can provide a user-wide default in the user `happy.toml`; a
repository list replaces that default for its workspaces.

### Managed network access

Auto and Workspace write shell commands have no general network access. To let
those commands use a specific external service, add a managed network policy to
the user `happy.toml` or the repository's root `happy.toml`. Read only
always keeps shell networking disabled, even when a policy exists. Full access
is unrestricted and ignores the managed policy. The policy is
configuration-owned: it is not exposed as a shell-tool argument, so an agent
cannot request additional domains or ports for itself.

For example, allow CodeRabbit globally over HTTPS:

```toml
[network]
allowed_domains = [
  "coderabbit.ai",
  "*.coderabbit.ai",
]
allowed_ports = [443]
```

`allowed_domains` accepts exact domain names and `*.` subdomain patterns. A
wildcard does not include the root domain, so the example lists both
`coderabbit.ai` and `*.coderabbit.ai`. `allowed_ports` applies to every allowed
domain and defaults to `[443]` when omitted. `denied_domains` uses the same
matching syntax and takes precedence over the allowlist:

```toml
[network]
allowed_domains = ["*.example.com"]
denied_domains = ["uploads.example.com"]
allowed_ports = [443, 8443]
```

Local services are configured separately by port. This example allows a
sandboxed command to reach a Portless HTTPS listener on the Happy Agent host:

```toml
[network]
allowed_loopback_ports = [8443]
```

Host-loopback forwarding targets `127.0.0.1` specifically. A service listening
only on IPv6 `::1` is not reachable through `allowed_loopback_ports`; configure
it to listen on `127.0.0.1` as well. On Linux and in Docker, the relay also
remains subject to normal OS privileges for ports below 1024.

The settings can be combined:

```toml
[network]
allowed_domains = [
  "coderabbit.ai",
  "*.coderabbit.ai",
]
denied_domains = []
allowed_ports = [443]
allowed_loopback_ports = [8443]
allow_local_binding = true
```

On macOS, `allow_local_binding = true` lets an Auto or Workspace write command
bind any local TCP or UDP port and connect to loopback listeners. It is a
single all-ports switch, matching Codex; there is no per-bind-port list. The
listener uses the host loopback interface, while external inbound and outbound
traffic remains blocked. “All ports” removes Happy Agent's policy restriction; it does
not bypass normal OS privileges or an existing listener occupying the port.

On macOS, local unix sockets are handled separately and need no configuration. An
Auto or Workspace write command may always create and connect to unix sockets
inside the working directory and its Git control directory, which is where a
development server, language server, or test harness puts its socket. That is
deliberately narrower than writable space: sockets in temporary directories and
everywhere else on the host stay unreachable, so a sandboxed command cannot
reach the Docker daemon socket, the SSH agent, or Happy Agent's own control socket. The
home folder is never granted, because host agents keep their sockets under it, so
a session in the Home project creates no sockets. Read only creates none either.
Linux and Docker commands are confined by their mount and network namespaces
instead, so a socket there follows writable space rather than this rule.

Linux and Docker commands always retain loopback binding inside their isolated
network namespace, so `allow_local_binding` does not change their sandbox.
Those listeners are reachable only by processes in the same command namespace;
they are not published to the Happy Agent host, the container network, or other
commands. Proxy-aware clients automatically bypass the managed proxy for this
namespace-local loopback traffic.

Happy Agent rereads the global and project configuration before every Auto or Workspace
write shell command. Project policy replaces global policy.
`denied_domains` is the exception: global and project denies are combined, so a
repository cannot remove a machine-wide global denial. Runtime settings and
session state cannot define network policy. Changing a network policy therefore
does not require restarting Happy Agent. An existing root project `happy.toml` is
protected from agent writes in Auto, Workspace write, and Read only modes;
explicit Full access can still modify it. If the file does not exist, it remains
absent before, during, and after restricted commands. Happy Agent never creates a
placeholder or other synthetic file at that path.

For allowed external domains, Happy Agent starts per-command HTTP CONNECT and SOCKS5
proxies, points common clients at them with standard proxy environment
variables, and closes them when the command finishes. The proxy resolves DNS
outside the sandbox with a two-second limit, treats lookup failures as policy
denials, rejects private or loopback resolutions, checks the destination domain
and port, and applies deny rules before allow rules. A blocked HTTP client still
receives a conventional `403`, but Happy Agent also attributes the blocked destination
to the owning command, stops it, and reports a clear sandbox-policy error to the
agent. Removing the managed proxy variables is not a fallback route. A command
that ignores them still cannot connect directly:

- On macOS, Seatbelt permits outbound connections only to the temporary proxy
  ports and configured loopback ports.
- On Linux, Bubblewrap removes the command's network namespace. `socat` bridges
  only the configured endpoints through temporary Unix sockets.
- Inside a Docker-backed session, the nested Bubblewrap sandbox uses the same
  Unix-socket bridge. Happy Agent keeps the sockets under an empty `.happy-terminal-network`
  runtime directory and remounts that directory read-only over the writable
  workspace in every restricted command. A neighboring command therefore
  cannot rename or replace a live socket to intercept authentication. Every
  bridge also requires a random per-command token, so finding and connecting
  to another command's socket is insufficient. Each restricted command also
  receives a private `/tmp`, hiding Happy Agent's outer process-control files and other
  commands' temporary state. Per-command directories are removed on completion;
  the empty root is harmless and is not tracked by Git. The container needs
  `bubblewrap` and `socat`, and its working directory must be a host bind mount
  so Happy Agent can share the temporary sockets without publishing a TCP proxy.

In restricted Docker sessions, `allowed_loopback_ports` refers to loopback on
the machine running Happy Agent, not an arbitrary container port. Full access remains
unrestricted and can bypass the managed proxy by design.

### P2P networking

P2P networking is opt-in and machine-wide. Configure each stable Happy Agent identity
once, then add any combination of Iroh, direct TLS, and SSH address hints:

```toml
[p2p]
enable_direct = true
enable_iroh = true
enable_ssh = true
expose_api = true

[p2p.direct]
listen = "0.0.0.0:7443"

[[p2p.peers]]
instance_id = "ck1234567890abcdefghijkl"
public_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

[p2p.peers.direct]
address = "other-terminal.example.com:7443"

[p2p.peers.iroh]
endpoint_id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

[p2p.peers.ssh]
auth = "agent"
host = "other-terminal.example.com"
host_key_sha256 = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
port = 22
username = "steve"

[p2p.iroh]
# relay_url = "https://relay.example.com"
```

Each Happy Agent installation owns a stable cuid2 instance ID and one protected
Ed25519 identity key. The same public key is the only key other parties need:
Happy Agent converts it to X25519 when encrypting, using the standard
Edwards-to-Montgomery conversion.

Every transport completes the same signed, expiring mutual hello before ping or
HTTP traffic. The signatures cover both identities, fresh challenges, the
transport kind, and its authenticated channel binding: Iroh endpoint IDs, TLS
exporter bytes, or the verified SSH host-key hash. Direct TLS additionally
requires the self-signed certificate to contain the configured stable Ed25519
key before Happy Agent reads application data.

Configure the same peer on both daemons for bidirectional Iroh or direct TLS.
SSH is intentionally initiator-only: it strictly pins the SSH host key,
authenticates with an SSH agent or an owner-only private-key file, and runs the
fixed remote command `happy-terminal p2p bridge --stdio`. Passwords and private-key
contents do not belong in the configuration. The serving daemon needs only the
initiator's `instance_id` and `public_key` entry; it does not need a reverse SSH
address. All transports for one instance share the same peer route; Happy Agent pins the
chosen transport for each ordinary or streaming response.

`expose_api` is separate from connectivity and defaults to `false`. When the
serving machine enables it, its daemon API is available through the consuming
machine's local authenticated daemon at:

```text
/p2p/peers/<instance-id>/api
```

For example, Happy can pass that URL prefix and the local daemon token to
`HappyAgentClient`; ordinary requests and long-lived event streams use the same
prefix. Tokens never cross a P2P transport. The remote daemon authenticates the
stable identity, then injects its own local token when dispatching the request.

API exposure grants substantial authority. A trusted instance can read
transcripts, send messages that run agents and tools, change project files,
install plugins, and manage workspaces as this Happy Agent user. Only configure machines
you trust to act as you. Happy Agent does not forward P2P topology routes, daemon
shutdown, the debug inspector, or one-time applet context exchanges.

When `relay_url` is absent, Iroh uses its default discovery and relay services.
The stable Happy Agent identity seed and the Iroh transport identity are stored
separately beside Happy Agent's durable database with owner-only permissions. Learned
peer pins are durable there as well. Project configuration cannot enable P2P
networking. Upstream Iroh does not currently publish a native binding for Intel
macOS; on that platform Happy Agent reports P2P as unavailable and continues running
normally.

Provider availability is machine-wide because the local daemon owns the model
catalog and authentication paths. Configure it in the user `happy.toml`:

```toml
[providers]
default_enable = false

[providers.codex]
enabled = true

[providers.claude]
enabled = true

[providers.kimi]
enabled = true

[providers.grok]
enabled = true

[providers.bedrock]
enabled = true
```

`providers.default_enable` controls provider instances that do not set their
own `enabled` value. It remains `true` when omitted for existing configurations;
setting it to `false` keeps every provider disabled unless that provider is
explicitly enabled.

These five built-in instances use the normal Codex, Claude Code, Kimi Code,
Grok, and Bedrock credential locations, so their `type` is inferred. At daemon
startup, a provider disabled here or missing local authentication remains a
disabled catalog entry with no models. Its models are omitted from both the
model picker and agent system prompts; the prompt includes only the provider's
disabled reason. This availability check reads local credential state and does
not ping provider servers.

Add any number of named instances when you need separate accounts. For custom
instances, the section suffix is the provider ID shown in the model picker and
accepted by `defaults.provider` and `HAPPY_TERMINAL_PROVIDER`. Custom instances must set
`type`; all parameters stay flat in the same section. The built-in Claude Code
provider ID is `claude`:

```toml
[providers.work_codex]
type = "codex"
enabled = true
auth_file = "/Users/me/.codex-work/auth.json"
transport = "auto"
include_models = ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra"]

[providers.personal_claude]
type = "claude"
enabled = true
oauth_token = "token-from-claude-setup-token"
exclude_models = ["anthropic/haiku-4-5"]

[providers.work_kimi]
type = "kimi"
enabled = true
auth_file = "/Users/me/.kimi-code-work/credentials/kimi-code.json"
include_models = ["moonshot/kimi-k3"]

[providers.work_grok]
type = "grok"
enabled = true
auth_file = "/Users/me/.grok-work/auth.json"
include_models = ["xai/grok-build"]

[providers.west_bedrock]
type = "bedrock"
enabled = true
region = "us-west-2"
profile = "work-bedrock"

[providers.west_bedrock.model_overrides]
"openai/gpt-5.6-sol" = { region = "us-east-1", endpoint = "https://bedrock-mantle.example/openai/v1", transport = "mantle" }
"anthropic/opus-4-8" = { endpoint = "https://bedrock-runtime.example", transport = "runtime" }
```

Every provider accepts `enabled`, `include_models`, and `exclude_models`.
Filters use exact Happy Agent model IDs; exclusions win when a model appears in both
lists. Codex instances also accept `auth_file`, `base_url`, and `transport`.
Claude Code instances accept `config_dir`, `executable`, and `oauth_token`.
Run `claude setup-token` while signed in to the additional Claude account to
create the long-lived token used by `oauth_token`. The token applies only to
that provider instance. Grok instances
accept `auth_file` and `base_url`; `HAPPY_TERMINAL_GROK_BASE_URL` is also available for
local proxy testing. Kimi instances accept `auth_file` and `base_url`;
`HAPPY_TERMINAL_KIMI_BASE_URL` is available for local proxy testing. Bedrock instances
accept `region`, `model_overrides`, `bearer_token_env_var`, `profile`,
`config_file`, and `credentials_file`. `profile` selects the standard AWS SDK
credential chain, including a profile's `credential_process`; the two file
settings optionally replace the standard AWS shared config and credentials
paths. `region` is the provider default. Each exact Happy Agent model ID under `model_overrides` may set
`region`, `endpoint`, `transport`, or any combination. Anthropic models prefer
Mantle in regions where both the endpoint and model are available in-region,
then fall back to Bedrock Runtime regional or global inference profiles. A full
`endpoint` URL overrides the endpoint selected for that model and bypasses
Happy Agent's regional availability list for the selected transport. The resolved region is still used for regional
inference-profile IDs and request metadata. Restart the local daemon after
changing providers. Repository `happy.toml` files cannot change these
machine-level choices or credential paths.

Use `/configure` for common settings. Environment variables such as `HAPPY_TERMINAL_MODEL`,
`HAPPY_TERMINAL_PROVIDER`, `HAPPY_TERMINAL_EFFORT`, and `HAPPY_TERMINAL_PERMISSION_MODE` override the corresponding
default for a newly created session.

Set `GEMINI_API_KEY` in the daemon environment to add the universal
`gemini_search`, `gemini_generate_image`, `gemini_generate_music`, and
`gemini_analyze_media` tools to every model. No other Gemini or Google credential
variable is used. These tools are additional to each provider's native tools,
including Claude's unchanged `WebSearch` tool. Restart the local daemon after
adding or changing the key.

<details>
<summary><strong>Docker-backed sessions</strong></summary>

Connect Happy Agent to a running container:

```sh
happy-terminal --docker-container my-development-container --docker-workdir /workspace
```

Or create a session container from an image already present in Docker:

```sh
happy-terminal --docker-image my-project-dev:local \
  --docker-workdir /workspace \
  --docker-env NODE_ENV=development \
  --docker-mount .:/workspace
```

The same options work with `happy-terminal exec`. `--docker-socket`, `--docker-name`, and
repeated `--docker-env` or `--docker-mount` options provide additional control.
Use `--local` to ignore a configured Docker default for one new session.

Machine-wide Docker defaults belong in the user `happy.toml`:

```toml
[docker]
image = "my-project-dev:local"
workdir = "/workspace"
env = { NODE_ENV = "development" }
mounts = [
  { source = ".", target = "/workspace" },
  { source = "/Users/me/.cache/my-project", target = "/cache", read_only = true },
]
```

Relative mount sources resolve from the host directory where Happy Agent starts. Use
absolute paths for home-directory mounts; `~` is not expanded. Repository
`happy.toml` files cannot select Docker images, sockets, environment variables, or
host mounts.

Image-backed containers are created on the first message and keep a stable,
session-derived name so their files survive daemon restarts. Happy Agent never pulls an
image implicitly and leaves managed containers in place for you to remove with
Docker. Images and connected containers need `/bin/sh`, `readlink`, and common
POSIX file utilities. Restricted permission modes also need `bubblewrap` and
`socat` in the container. Happy Agent configures image-backed containers for Bubblewrap
automatically; start a container that Happy Agent will connect to with
`--security-opt seccomp=unconfined` so restricted shell commands can create their
nested filesystem, process, and network boundary. Docker commonly blocks a
second procfs mount even with nested user namespaces, so Happy Agent gives restricted
commands an empty private `/proc` instead of exposing the container's parent
process table. Restricted commands also receive a private `/tmp`; temporary
files belonging to the parent container or another command are not visible.
Tools that require the parent `/proc` or shared `/tmp` should run in an
appropriately isolated Full access container.

</details>

<details>
<summary><strong>MCP servers</strong></summary>

Happy Agent supports local stdio servers and streamable HTTP:

```toml
[mcp_servers.docs]
command = "docs-mcp-server"
args = ["--stdio"]
tool_timeout_sec = 30

[mcp_servers.issues]
url = "https://example.com/mcp"
bearer_token_env_var = "ISSUES_MCP_TOKEN"
```

MCP tools, resources, resource templates, prompts, pagination, form elicitation,
bearer tokens, and OAuth client credentials are supported. Live tool discovery
lets a session use tools added after startup.

Only configure servers you trust. Stdio servers run as local processes, receive
the daemon environment, and are not restricted by the session filesystem
sandbox.

</details>

<details>
<summary><strong>Kimi Code</strong></summary>

Install Kimi Code, complete its device-code login, then choose Kimi K3:

```sh
kimi login
export HAPPY_TERMINAL_PROVIDER="kimi"
export HAPPY_TERMINAL_MODEL="moonshot/kimi-k3"
happy-terminal
```

By default Happy Agent reads
`$KIMI_CODE_HOME/credentials/kimi-code.json`, or
`~/.kimi-code/credentials/kimi-code.json` when `KIMI_CODE_HOME` is unset. A
named Kimi provider may instead set `auth_file`. Happy Agent refreshes expired access
tokens through Kimi Code's OAuth flow, coordinates refreshes with Kimi Code's
cross-process lock, and atomically writes rotated credentials back to the same
file.

The built-in endpoint is `https://api.kimi.com/coding/v1`. Happy Agent calls its
OpenAI-compatible `/chat/completions` API with wire model `k3`, Kimi's
1,048,576-token context, max reasoning, native reasoning continuation,
normalized schemas and tool-call IDs, prompt caching, and streamed usage.
Kimi receives adapted upstream coding, compaction, subagent, and tool guidance;
all execution still runs through Happy Agent's provider-neutral permissions and
sandbox. Happy Agent keeps planning in the normal agent workflow and uses its existing
background work surfaces rather than reproducing Kimi Code's dedicated Plan,
Cron, or AgentSwarm modes.

</details>

<details>
<summary><strong>Grok Build</strong></summary>

Install and sign in through the first-party Grok CLI, then choose Grok Build:

```sh
grok login
export HAPPY_TERMINAL_PROVIDER="grok"
export HAPPY_TERMINAL_MODEL="xai/grok-build"
happy-terminal
```

By default Happy Agent reads `$GROK_HOME/auth.json`, or `~/.grok/auth.json` when
`GROK_HOME` is unset. It reads Grok's current OIDC scope, refreshes sessions
five minutes before expiry, and atomically writes refreshed access and refresh
tokens back to the same file.
An explicit API key or `XAI_API_KEY` can also authenticate the provider, subject
to xAI's model availability for that credential.

The built-in endpoint is `https://cli-chat-proxy.grok.com/v1`. Grok Build uses
the OpenAI-compatible `/responses` API with its upstream 500,000-token context,
sampling defaults, encrypted reasoning continuation, and `x-grok-*` request
headers. Happy Agent adapts Grok's open-source prompt and primary tool definitions to
its shared execution and permission layer; it does not reproduce Grok's TUI,
schedulers, or dedicated Plan mode.

</details>

<details>
<summary><strong>Amazon Bedrock</strong></summary>

Bedrock becomes available through either an `AWS_BEARER_TOKEN_BEDROCK` value or
the standard AWS credential chain. For a process-backed AWS profile, configure
the process in `~/.aws/config` using the normal AWS format:

```ini
[profile work-bedrock]
credential_process = /usr/local/bin/your-credential-helper --format aws
region = us-east-1
```

Then select that profile in the machine-wide `happy.toml`:

```toml
[providers.bedrock]
enabled = true
profile = "work-bedrock"
```

The helper must print the AWS credential-process Version 1 JSON shape. Happy Agent
keeps the refreshable AWS provider rather than storing the returned access key,
so expiring credentials are renewed by the AWS SDK. To use a Bedrock bearer
token instead:

```sh
export AWS_BEARER_TOKEN_BEDROCK="your Bedrock API key"
export AWS_REGION="us-east-1"
export HAPPY_TERMINAL_PROVIDER="bedrock"
happy-terminal
```

To use Bedrock exclusively, disable the native authentication paths in the
machine-wide config and select a Bedrock default:

```toml
[defaults]
provider = "bedrock"
model = "openai/gpt-5.6-sol"

[providers]
default_enable = false

[providers.bedrock]
enabled = true
```

Happy Agent uses `AWS_REGION`, then `AWS_DEFAULT_REGION`, and otherwise defaults to
`us-east-1`. With no explicit Bedrock authentication setting, Happy Agent checks the
bearer token first and then the ambient AWS chain (`AWS_PROFILE`, environment
credentials, shared files, ECS, and EC2 metadata). Optional `config_file` and
`credentials_file` settings select nonstandard shared files; when `profile` is
omitted with either file, Happy Agent uses the `default` profile. Restart an
already-running daemon after changing these settings or variables.
The available model list follows AWS regional availability. GPT-5.6 Sol, Terra,
and Luna use Amazon Bedrock's Responses API and its 272,000-token context limit.
Sol is available in `us-east-1` and `us-east-2`; Terra and Luna are also
available in `us-west-2`. See the current
[OpenAI Bedrock guide](https://developers.openai.com/api/docs/guides/amazon-bedrock)
and [AWS launch announcement](https://aws.amazon.com/about-aws/whats-new/2026/07/openai-gpt-sol-terra/).
Anthropic models use the native Messages API, prefer the Anthropic-compatible
Mantle endpoint where available, fall back to Bedrock Runtime, and support
Bedrock's native server-side compaction.

</details>

<details>
<summary><strong>Theme and display</strong></summary>

Happy Agent follows Codex-style terminal color semantics by default. Override individual
roles globally or per repository:

```toml
[theme]
primary = "default"
secondary = "dim"
accent = "cyan"
brand = "ansi:202"
success = "green"
warning = "yellow"
error = "red"
```

Roles accept `default`, `dim`, ANSI names such as `bright_cyan`, palette indexes
such as `ansi:202`, or true-color values such as `#D97706`. `/fast` toggles the
Codex fast service tier when the selected provider supports it; fast inference
uses twice the plan usage.

</details>

<details>
<summary><strong>Daemon crash diagnostics</strong></summary>

On Node.js runtimes that support environment redaction, Happy Agent starts its daemon
with private diagnostic reports for fatal runtime errors and uncaught
exceptions. Run `happy-terminal daemon status` to see the diagnostics directory. Happy Agent
also records the original stack in `server.log`. The diagnostics directory is
private (`0700`), uncaught-exception reports are additionally forced to `0600`,
and Happy Agent retains at most three crash reports. On older Node.js releases, Happy Agent
fails closed instead of writing credentials into a report and leaves an
explanatory `crash-reports-unavailable.txt` file in that directory.

Full heap snapshots near the memory limit are opt-in because they are large and
can contain prompts, tool results, credentials held in memory, and other
sensitive process data. Enable them only in the machine-level config and then
restart the daemon:

```toml
[settings]
daemon_heap_snapshots = true
```

Happy Agent retains at most two heap snapshots. Repository `happy.toml` files cannot
enable this setting.

</details>

<details>
<summary><strong>Workflows and app event synchronization</strong></summary>

Workflows are on by default. Disable them globally or per repository:

```toml
[features]
workflows = false
```

For client integrations, the daemon can keep an opt-in durable queue of session
and subagent lifecycle events:

```toml
[settings]
durable_global_event_queue = true
```

This setting is user-wide only. Authenticated daemon clients can read event
batches from `GET /events`, follow `GET /events/stream`, and acknowledge entries
with `POST /events/trim`. See the [event reference](EVENTS.md) for payloads and
queue behavior.

</details>

## Scope

Happy Agent aims for the best common coding-agent workflows, not exhaustive parity with
every upstream option. It intentionally keeps planning in the normal agent flow,
uses standard terminal editing instead of modal editing, follows Codex skill
semantics, and relies on the existing Codex, Claude Code, Kimi Code, and Grok
login flows.

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
remain under Apache-2.0, and adapted Kimi Code portions remain under MIT; see
the [third-party notices](THIRD-PARTY-NOTICES.md).
