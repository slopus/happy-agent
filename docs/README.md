# Happy Agent and Happy documentation

Welcome. If you are a coding agent reading this, you are almost certainly
_running inside the system these pages describe_. This folder ships with Happy Agent
itself and is exposed read-only to agents. Its purpose is simple: give you enough understanding of Happy Agent and
Happy that you can work well inside them — and, when asked, **extend them**.

## What is Happy Agent?

Happy Agent is an open-source coding-agent harness that recreates the best of Codex,
Claude Code, and Grok Build in one consistent local runtime. Each model gets its
_native_ prompts and tools — GPT models see a Codex-shaped world, Claude models
see a Claude Code-shaped world, Grok sees Grok Build — while everything around
inference is shared: one permission model, one sandbox, one persistence layer,
one terminal interface, one way to spawn and talk to agents.

Provider access requires no Happy Agent account. Happy Agent uses the credentials already managed
by the coding agents installed on the machine, and it never pools or resells provider access. An
optional team deployment authenticates members of one WorkOS organization separately from those
provider credentials. The headless daemon holds durable sessions. The Happy desktop app and other
clients attach through `@slopus/happy-agent-client`.

The deeper idea: **agents never die**. Every conversation, every subagent, is a
durable session that can always receive another message and resume with its
full context. Agents recognize each other by unguessable Agent IDs and can
message each other, schedule messages into the future, wait durably, and
delegate work into isolated Git workspaces.

## What is Happy?

Happy is the open-source desktop app for coding agents, built by the same authors as Happy Agent
and running on it ([happy.engineering](https://happy.engineering/),
[source](https://github.com/slopus/happy-desktop)):

- **Happy** (the desktop app) runs Claude, Codex, and Grok in one harness, keeps sessions alive
  and shareable, and puts conversations beside the files, diffs, terminals, and previews the work
  touches. It starts its own Happy Agent runtime and talks to it through
  `@slopus/happy-agent-client`.
- **Happy for iOS and Android** is the companion: pair it with the desktop app to follow, steer,
  and approve agents from anywhere. The relay in between carries only ciphertext and can read
  nothing. The apps send product analytics, never your content, unless you turn it off
  ([details](happy.md#what-the-relay-sees-only-ciphertext-actually-means)).
- **The original Happy CLI** ([source](https://github.com/slopus/happy)) is in maintenance mode.
  Its `happy` command wraps Claude Code and Codex for the mobile app; it is not Happy Agent.

When you are driven through either of them rather than a terminal,
[happy.md](happy.md) explains what changes for you.

## Recipes

Operational recipes live in [`recipe/`](recipe/). Before starting a task, Happy checks
this directory and reads any relevant recipe in full.

Recipes are executed automatically by default within the user's authorized task, reusing known
settings and asking only for missing material choices, access, or interactive login.

| Recipe                                                                      | When to use it                                                                              | What it covers                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Set up WSL projects](recipe/setup-wsl-agent.md)                            | Add Linux projects to Happy Desktop on Windows 11.                                          | A separate WSL Agent through the existing remote connection, Windows-owned bots, Linux credentials, startup, and end-to-end checks.                                                                                                                                                                               |
| [Connect two Happy Agents over one WebSocket](recipe/peer-messaging.md)     | Send messages between known agents without exposing a desktop port.                         | One outbound connection, shared authentication, bilateral Happy setup, ping/pong health, reconnects, diagnostics, and a verified round trip.                                                                                                                                                                      |
| [Drive Happy Agent over its REST API](recipe/happy-rest-api.md)             | Set up, use, or debug Happy from a script or a shell-only agent.                            | A curl cookbook: the socket and token, remote and team daemons, configuration and models, skills and secrets, finding and messaging agents, steering, stopping, and answering questions, bots, tasks, projects, workspaces, artifacts, Surfaces, debugging, and pitfalls.                                         |
| [Start with one project](recipe/first-project.md)                           | Ask Happy to set up your first project.                                                     | Opt-in recent Claude/Codex project discovery, choose one existing or new project, preserve local work, and agree one small first change.                                                                                                                                                                          |
| [Set up or repair Mobile Access](recipe/mobile-access.md)                   | Link a phone, unlink or switch its account, or diagnose Desktop/terminal remote access.     | The shared local setup flow, existing V2 accounts, CLI readiness, unlinking and account switches, safe troubleshooting, and preservation of the shared Happy home.                                                                                                                                                |
| [Deploy a standalone remote agent](recipe/deploy-standalone-remote.md)      | Set up a new personal, non-team remote.                                                     | Automatic setup, config-based profile bootstrap, provider credentials and Claude Keychain extraction, connectivity, optional GitHub auth, Git identity, and verification.                                                                                                                                         |
| [Create and deploy a Happy team](recipe/deploy-happy-team.md)               | Set up a named shared team and invite its members.                                          | Happy Social sign-in and email binding, team creation, team-mode deployment, verified local WorkOS connection, and email invitations after verification.                                                                                                                                                          |
| [Add a dedicated runner](recipe/add-runner.md)                              | Separate a remote node's compute from its data and credentials. Strongly recommended.       | A runner token in the node's configuration, a runner service user, the Tailcat endpoint, a systemd unit, Git identity, optional containers, and verification.                                                                                                                                                     |
| [Harden a node with separate Linux users](recipe/harden-node.md)            | Keep agent work from reading a node's configuration, database, and credentials.             | A service user and a workload user, folder ownership, a minimal sudoers rule, the systemd unit, `[execution]` in `happy.toml`, per-bot users, the AppArmor prerequisite, and verification.                                                                                                                        |
| [Set up enterprise JWT sign-in](recipe/enterprise-jwt-authentication.md)    | Let a team sign in with its own identity provider.                                          | The OAuth code flow with PKCE and optional refresh, an untrusted daemon that only verifies tokens, authorization server setup, daemon configuration, and verification.                                                                                                                                            |
| [Accounts, models, effort, and service tier](recipe/accounts-and-models.md) | Add or pool accounts, limit models, set defaults, or move sessions to another provider.     | Per-vendor accounts, round-robin pools and hiding, model and subagent filters, default model, effort, and service tier, session switching, and validation.                                                                                                                                                        |
| [Harnesses](recipe/harnesses.md)                                            | Run Happy agents on Claude Code, Codex CLI, Antigravity, OpenCode, or any ACP agent itself. | Harness tables over existing accounts, credentials, models each agent reports and how to pick and order them, sub-agents, generic ACP agents, and checks.                                                                                                                                                         |
| [Export a bot to Telegram](recipe/exported-bot-telegram.md)                 | Let people talk to a bot from Telegram, or change who may.                                  | A dedicated bot rather than Happy, a @BotFather token, access requests Happy approves or denies, a guest and subtask per allowed person, photos both ways, live changes without a reload, and verification.                                                                                                       |
| [Export a bot to any chat service](recipe/exported-bot-bridge.md)           | Let people talk to a bot from Slack or any other service through a bridge.                  | A dedicated bot, a token written to a private file, a reference bridge, the WebSocket protocol, durable replies, files exchanged as local paths, access requests, guests, token rotation, and verification.                                                                                                       |
| [Restrict a bot with bot settings](recipe/bot-settings.md)                  | Limit a bot's secrets, keep it to its own agents, or run it in Docker.                      | Admin-only `get_bot_settings` and `update_bot_settings`, the `previous` handshake, what each setting enforces for the bot and every agent under it, how reach combines with `features.cross_workspace`, when a compute change applies, and the limits that remain.                                                |
| [Upgrade Happy Agent](recipe/upgrade-happy-agent.md)                        | Upgrade an existing installation without repeating onboarding.                              | Release checks, token-free signal drain, graceful shutdown, private backups, binary replacement, preserved configuration and identity, verification, and recovery.                                                                                                                                                |
| [Build a live, shared HTML artifact](recipe/artifact-apps.md)               | Make an `html` artifact remember data, update in realtime, or serve several people.         | The `/api/v1/client.js` SDK, agent data tools, one shared key-value store per artifact, viewer identity and profiles, UUIDv7 versions, offline-safe writes, limits, gotchas, a complete example, and debugging with `happy-agent artifact dev`, fake users, network faults, Playwright, and `read_artifact_logs`. |

## The map

Read these in whatever order your task demands; each page stands alone.

| Page                                                       | What it tells you                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                         | How Happy Agent is put together: the daemon and its clients, the protocol between them, sessions and durability, providers and model catalogs, inference and compaction, persistence, and how the codebase is organized into packages.      |
| [workspaces.md](workspaces.md)                             | What a workspace is (a Git worktree on its own branch), how to create, delegate into, and archive one, where they live on disk, and when making one is actually the right call.                                                             |
| [agents-and-collaboration.md](agents-and-collaboration.md) | Subagents, follow-up messages, the `agent_me` / `agent_info` / `agent_send` handshake, scheduling, durable waits, presence, and the concurrency model.                                                                                      |
| [permissions-and-sandbox.md](permissions-and-sandbox.md)   | The four permission modes, the single cross-provider sandbox, how Auto review works, escalation syntax per provider, and why a denied action must never be retried by another route.                                                        |
| [configuration.md](configuration.md)                       | The complete `happy.toml` reference: file locations, protected paths, workspace setup commands, managed network access, provider instances, Docker-backed sessions, terminal theme, Happy Desktop colors, diagnostics, and feature toggles. |
| [team-mode.md](team-mode.md)                               | How to install the release binary, bootstrap and register a Tailcat endpoint, run the multi-user service under systemd, authenticate one WorkOS organization, and onboard its users.                                                        |
| [happy-teams.md](happy-teams.md)                           | Happy Social prerequisites, team administration, the setup sequence, local connections, and email invitations.                                                                                                                              |
| [tailcat.md](tailcat.md)                                   | How to open the bundled account-free Tailcat transport, control it through an admin bot, obtain its stable endpoint, connect standalone or team clients, pair phones directly, and preserve Happy Agent authentication.                     |
| [MCP.md](MCP.md)                                           | How to configure user-wide and workspace local stdio or remote HTTP MCP servers, reconcile them online, filter tools, and troubleshoot failed connections.                                                                                  |
| [extending.md](extending.md)                               | How to extend Happy Agent from inside: plugins (TypeScript processes with MCP tools and UI), skills, MCP servers, Happy Agent Connect integrations, and subagents as a runtime extension mechanism.                                         |
| [exported-bot-protocol.md](exported-bot-protocol.md)       | The WebSocket protocol a bridge speaks to serve an exported bot: its token, frames, durable replies, files exchanged as local paths, access requests, close codes, and security.                                                            |
| [DESIGN.md](DESIGN.md)                                     | The Happy design system for web pages and interfaces: variables, surfaces, layout grid, typography, controls, states, and a copyable baseline. Read it for temporary pages or whenever the user asks for Happy's visual language.           |
| [happy.md](happy.md)                                       | The Happy family: encrypted remote access to agents with Happy, the collaborative desktop workspace of Happy 2, how each connects to Happy Agent, and what an agent should know when driven through them.                                   |

Installed releases also include `API.md` beside these pages. It is the authoritative Happy Agent
HTTP, event-stream, WebSocket, and tunnel contract; in this source checkout it lives at
[`packages/happy-agent/API.md`](../packages/happy-agent/API.md).

## If you want to extend yourself

That is an explicitly supported goal. The short version:

1. **Write a plugin** — TypeScript, one `happy.plugin.json` manifest, a
   generated icon, installed with `plugin_install`. A plugin runs as its own
   sandboxed process, talks to Happy Agent over an authenticated socket through the
   `happy-plugins` SDK, and can create workspaces, message agents, expose MCP
   tools to every model, and contribute a local UI. Start with
   [extending.md](extending.md).
2. **Write a skill** — a `SKILL.md` file with instructions a model loads on
   demand. No process, no manifest beyond frontmatter.
3. **Spawn agents** — delegate bounded work to subagents on any available
   model, or create a workspace and delegate a whole task into it. See
   [agents-and-collaboration.md](agents-and-collaboration.md).
4. **Change Happy Agent itself** — Happy Agent is developed with Happy Agent. When you have the Happy Agent
   source checked out, follow the contributor instructions that ship with the
   repository before touching anything.

## Ground rules worth internalizing

- **Test deployed nodes in fresh temporary projects.** On both team and standalone nodes,
  never reuse existing projects for test commands or inference smoke tests. Create a temporary
  project, run the checks there, then archive it. Always check whether the user has already
  archived it and stop if they have; never restore or replace it automatically. Follow
  [Testing a deployed node](recipe/README.md#testing-a-deployed-node) for the full lifecycle.
- **One permission model everywhere.** No provider, tool name, or clever
  command phrasing widens what you may do. Escalation is per-action, reviewed,
  and scoped to that one execution.
- **Durability is the default.** Sessions, transcripts, scheduled messages,
  and waits survive daemon restarts. Design your work around resuming, not
  around finishing in one breath.
- **A denial is an answer.** When a permission review refuses an action, do
  not pursue the same outcome by another route; take a materially safer
  alternative or stop and explain.
