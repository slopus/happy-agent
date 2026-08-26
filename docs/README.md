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

Happy Agent adds no account of its own. It uses the credentials already managed by the
coding agents installed on the machine, and it never pools or resells provider
access. The headless daemon holds durable sessions. Happy Terminal is the reusable Pi TUI client,
used by the `happy` CLI, its standalone `happy-terminal` command, embedded Node.js
applications, and Happy Desktop. Other clients attach through `@slopus/happy-agent-client`.

The deeper idea: **agents never die**. Every conversation, every subagent, is a
durable session that can always receive another message and resume with its
full context. Agents recognize each other by unguessable Agent IDs and can
message each other, schedule messages into the future, wait durably, and
delegate work into isolated Git workspaces.

## What is Happy?

Happy is a family of two products, built by the same authors as Happy Agent, that put
people in touch with their coding agents:

- **Happy** is end-to-end encrypted remote access to your agents. A mobile and
  web client lets you watch and steer agents running on your own machine from
  anywhere; the relay in between carries only ciphertext and can read nothing.
- **Happy 2** is its desktop collaborative sibling: a self-hosted, Slack-like
  workspace where people and coding agents build together — conversations,
  files, documents, workspaces, and agents in one web and desktop app, started
  with a single `npx happy2` command, with all state kept locally under
  `.happy2`. It runs its agents on Happy Agent: a private Happy Agent runtime, each agent
  conversation bound to a sandboxed container, Happy Agent sessions, terminals, and
  tools surfaced in its UI.

When you are driven through either of them rather than a terminal,
[happy.md](happy.md) explains what changes for you.

## The map

Read these in whatever order your task demands; each page stands alone.

| Page                                                       | What it tells you                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                         | How Happy Agent is put together: daemon and TUI, the protocol between them, sessions and durability, providers and model catalogs, inference and compaction, persistence, and how the codebase is organized into packages.        |
| [workspaces.md](workspaces.md)                             | What a workspace is (a Git worktree on its own branch), how to create, delegate into, and archive one, where they live on disk, and when making one is actually the right call.                                                   |
| [agents-and-collaboration.md](agents-and-collaboration.md) | Subagents, follow-up messages, the `agent_me` / `agent_info` / `agent_send` handshake, scheduling, durable waits, presence, and the concurrency model.                                                                            |
| [permissions-and-sandbox.md](permissions-and-sandbox.md)   | The four permission modes, the single cross-provider sandbox, how Auto review works, escalation syntax per provider, and why a denied action must never be retried by another route.                                              |
| [extending.md](extending.md)                               | How to extend Happy Agent from inside: plugins (TypeScript processes with MCP tools and UI), skills, MCP servers, Happy Agent Connect integrations, and subagents as a runtime extension mechanism.                               |
| [DESIGN.md](DESIGN.md)                                     | The Happy design system for web pages and interfaces: variables, surfaces, layout grid, typography, controls, states, and a copyable baseline. Read it for temporary pages or whenever the user asks for Happy's visual language. |
| [happy.md](happy.md)                                       | The Happy family: encrypted remote access to agents with Happy, the collaborative desktop workspace of Happy 2, how each connects to Happy Agent, and what an agent should know when driven through them.                         |

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

- **One permission model everywhere.** No provider, tool name, or clever
  command phrasing widens what you may do. Escalation is per-action, reviewed,
  and scoped to that one execution.
- **Durability is the default.** Sessions, transcripts, scheduled messages,
  and waits survive daemon restarts. Design your work around resuming, not
  around finishing in one breath.
- **A denial is an answer.** When a permission review refuses an action, do
  not pursue the same outcome by another route; take a materially safer
  alternative or stop and explain.
