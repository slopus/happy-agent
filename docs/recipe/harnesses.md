# Harnesses: Claude Code, Codex CLI, Antigravity, OpenCode, and ACP agents

Use this recipe when the user wants a Happy agent to run on another vendor's whole agent rather
than on Happy's own loop: Claude Code itself, Codex CLI itself, Google Antigravity, OpenCode, or
any agent with an [Agent Client Protocol](https://agentclientprotocol.com) server. Accounts and
their credentials stay in [Accounts and models](accounts-and-models.md); a harness only says who
runs the agent loop on them.

## What changes for the user

Happy's own harness runs the loop with Happy's prompt, tools, and compaction. The `claude_code`
harness runs Claude Code itself on a `claude` account: its own prompt, tools, settings, skills,
sub-agents, and compaction. `codex_cli` does the same for Codex on a `codex` account.
Antigravity, OpenCode, and other ACP agents sign in themselves, so each is offered as an account
of its own, named after its harness.

Either way the conversation stays a Happy conversation. Happy's history is the record, and the
agent's own session is kept in step with it. Happy's tools (projects, sub-agents, artifacts,
messaging, and the rest) reach the agent over MCP, and Happy's permission mode is mapped onto the
agent's own (see [Permissions](#permissions)). Sending a message while the agent works steers it: Claude Code and Codex CLI take it
mid-turn; Antigravity, OpenCode, and other ACP agents are interrupted and continue from the new
message. Stop ends the agent's turn and the commands it was running.

| Harness       | Runs                               | On                               | Needs on the machine                  |
| ------------- | ---------------------------------- | -------------------------------- | ------------------------------------- |
| `happy`       | Happy's own loop                   | every provider (default)         | nothing                               |
| `claude_code` | Claude Code, through the Agent SDK | `claude` providers (default all) | nothing; Happy ships Claude Code      |
| `codex_cli`   | Codex, through `codex app-server`  | `codex` providers (default all)  | the pinned Codex, a `codex`, or `npx` |
| `antigravity` | Antigravity, through `agy acp`     | its own login                    | `agy` 1.5.5 or newer, signed in       |
| `opencode`    | OpenCode, through `opencode acp`   | its own login                    | `opencode` signed in                  |
| any, `acp`    | any ACP agent, from its `command`  | its own login                    | that agent, installed and signed in   |

## Before editing

Follow [Accounts and models](accounts-and-models.md#before-editing): the file is the user
`happy.toml`, read it with credentials redacted, back it up, and never print or copy credentials.

## Add harnesses

Accounts stay as they are. Add a `[harnesses.<id>]` table per harness; writing the table turns
it on, and `enabled = false` turns it off again. Built-in IDs need no `type`.

```toml
[providers.claude]                       # built-in; shows as "Current CLI"
enabled = true

[providers.claude_alex_acme]
type = "claude"
name = "alex acme"
oauth_token = "<from claude setup-token>"

[providers.codex]                        # built-in; shows as "Current CLI"
enabled = true

[harnesses.claude_code]                  # Claude Code on these accounts
providers = ["claude", "claude_alex_acme"]   # default: every type = "claude" provider

[harnesses.codex_cli]                    # Codex CLI on every codex account
# command = "codex"                      # optional: a codex of your choice
# args = ["app-server"]

[harnesses.antigravity]                  # shows as "Antigravity"

[harnesses.opencode]                     # shows as "OpenCode"

[harnesses.goose]                        # any ACP agent
type = "acp"
name = "Goose"
command = "goose"
args = ["acp"]
env = { GOOSE_PROVIDER = "openai" }
```

`[harnesses.happy]` exists by default. Give it `providers = [...]` to keep Happy's own loop to
those accounts, or `enabled = false` to leave only foreign agents.

Claude Code uses the account's `oauth_token`, `api_key`, `auth_token`, or `config_dir`, or the
machine's Claude Code login for the built-in `claude`. Codex CLI uses the account's `api_key`, or
the folder holding its `auth_file` (which must be named `auth.json`) as `CODEX_HOME`, or
`~/.codex` for the built-in `codex`. Antigravity and OpenCode use their own logins; set `api_key`
on their harness to use a key instead. A generic `acp` agent gets credentials only through `env`
or its own login.

Then [reload the daemon](../configuration.md#applying-configuration-changes).

## Models

Each agent decides which models exist. Each time the daemon starts, it starts every enabled
harness once per account in the background, opens an empty session without prompting it, reads
the models and efforts the agent offers, and keeps the answer. Model IDs are
`<harness type>/<the agent's own model value>`, such as `claude-code/opus`,
`codex-cli/gpt-6.1-sol`, `opencode/openai/gpt-5.5`, or `acp/goose/<model>` for a generic agent.

The picker lists each account's models from every harness on it: Happy's models and, beside them,
`Claude Code · Opus` and the rest. Until an agent has answered once, Claude Code, Codex CLI, and
Antigravity offer a short built-in list; OpenCode and generic ACP agents offer nothing. If an
agent never answers, the daemon log says why, usually a missing login or command.

The harness picks, hides, and orders from what its agent offers:

```toml
[harnesses.claude_code]
include_models = ["claude-code/opus", "claude-code/sonnet"]   # only these, in this order
exclude_models = ["claude-code/haiku"]
```

IDs the agent does not offer are ignored, and `exclude_models` wins. An account's own
`include_models` and `exclude_models` still apply to every model on it, so list Claude Code models
there too when the account already filters. Smart pools never rotate foreign agents: a Claude Code
or Codex conversation stays on the account that started it. Switching a conversation between
Happy's loop and a foreign agent starts a fresh context with a handoff.

## Sub-agents

Any Happy agent creates sub-agents with `create_agent` and subtasks with `create_subtask`, on any
harness its own harness reaches. Both take `harness`, `provider`, `model`, and `effort`; an
omitted `harness` or `provider` is the creator's own when that serves the model, or the only one
that does. Their descriptions list the models the agent can start agents on, one line per model
with its harness, accounts, and efforts, as they were when the conversation began; they never
change, so the prompt cache holds. When the list changes, the agent gets a hidden system notice
with the lines removed and added. `agent_options` lists the current models, and
`agent_options({ usage: true })` adds each account's quota: the daemon's latest reading for
Claude, Codex, and Grok accounts, and what Antigravity reports for its own.

By default Happy's own loop reaches only foreign harnesses whose models it cannot run itself,
which today is `antigravity`; Claude Code, Codex CLI, and OpenCode run models Happy already runs.
A foreign harness reaches every other foreign harness but not Happy's loop. Each harness always
reaches itself. `subagent_harnesses` replaces the default for one harness:

```toml
[harnesses.happy]
subagent_harnesses = ["antigravity", "claude_code"]   # Happy may also start Claude Code agents

[harnesses.antigravity]
subagent_harnesses = []                               # Antigravity agents start only Antigravity
```

A sub-agent on a foreign harness is an ordinary Happy agent with its own foreign session. The
foreign agent's own sub-agents (Claude Code's Task tool, Codex's agents) stay inside it; Happy
shows each as one tool call.

## Permissions

A foreign agent does not run inside Happy's sandbox. It keeps its own permission system and its
own Auto reviewer, and Happy sets the agent's mode from the conversation's permission mode. When
the agent asks before an action, the ask reaches the person as a permission question from that
harness (`permissionRequest.source = "harness"`), with Allow once, Allow for this session when
the agent offers it, and Deny. Stop withdraws an open question and cancels the agent's ask.

| Happy mode      | Claude Code             | Codex CLI                               | Antigravity    | Asks the agent makes                     |
| --------------- | ----------------------- | --------------------------------------- | -------------- | ---------------------------------------- |
| Read only       | `plan`                  | `read-only`, never asks                 | `plan`         | refused without asking anyone            |
| Workspace write | `acceptEdits`           | `workspace-write`, asks the person      | `accept-edits` | go to the person                         |
| Auto            | `auto` (its classifier) | `workspace-write`, its Guardian reviews | `auto`         | its reviewer's handoffs go to the person |
| Full access     | `bypassPermissions`     | `danger-full-access`, never asks        | `auto`         | allowed without asking                   |

Happy's own tools reach the agent as MCP tools, and the agent's permission system decides those
too. Tools Happy never reviews (reading history, listing projects, and the like) are approved in
advance on Claude Code and Codex CLI; the user's other MCP servers are not. In Workspace write,
any other Happy tool the agent asks about is allowed when Happy itself would not review that
call, and goes to the person otherwise. An agent that never asks before MCP calls, such as
Antigravity, runs every Happy tool with no question and no review by anyone, including tools that
reach the user's own MCP servers through Happy. Only Happy's own mode limits still apply, such as
MCP tools needing Auto or Full access.

What each agent's reviewer does is its own, and it is more permissive than Happy's Auto review.
Seen against the pinned releases:

- Claude Code's `auto` classifier allowed a force push, `rm` outside the project, and writes to
  `.git/hooks` without asking anyone.
- Antigravity's `auto` allowed a force push and `rm -rf` outside the project, and its sandbox
  leaves `/tmp` writable. It does hand writes outside the project to the person.
- Codex's Guardian decides alone; Happy treats its denials as final. Codex's `workspace-write`
  sandbox, used in Workspace write and Auto, also leaves `/tmp` writable and blocks the network.

Workspace write puts the most in front of the person, but it does not put everything there. The
agent still acts without asking where its own rules allow it: reading outside the project,
writing to `/tmp` where its sandbox allows that, commands it judges safe, and anything its own
settings allow. Claude Code reads the user's and the project's settings, so a repository's
`.claude/settings.json` allow rules apply. The agent's own sub-agents (Claude Code's Task tool, Codex's agents) ask on the conversation that
started them. Antigravity's sub-agents never send an ask; they stall until stopped. A Happy
sub-agent asks on its own conversation, like any other agent.

Antigravity registers only small MCP tools as functions and leaves larger ones, `create_agent`
among them, for its model to load from a schema file, which it does not reliably do; so an
Antigravity agent usually cannot start Happy sub-agents.

## Antigravity from Happy

To let a Happy agent start Antigravity sessions on the user's Google account:

1. On the machine, install Antigravity's `agy` 1.5.5 or newer. Have the user run `agy` once and
   sign in; Happy never handles the Google login.
2. Add `[harnesses.antigravity]` and [reload the daemon](../configuration.md#applying-configuration-changes).
   The `Antigravity` account appears in the picker with its models, such as
   `antigravity/gemini-3.8-flash`.
3. From any Happy session, ask for an Antigravity sub-agent or subtask. The agent calls
   Antigravity models in `create_agent`'s description (`agent_options({ usage: true })` adds
   the quota left in each window, from `agy -p /usage`, read at most every five minutes), and
   starts it with
   `model = "antigravity/gemini-3.8-flash"`.

The quota is shown to agents only; the app's usage panel does not show Antigravity yet.

## Generic ACP agents

A generic agent gets Happy's tools only if it accepts HTTP MCP servers over ACP. Its model
selector must be an ACP session config option of category `model`. Its permission requests
follow the [table above](#permissions): Read only refuses them, Full access allows them, and
otherwise they reach the person. Everything the agent does without asking follows its own
settings, so set those to match what the user expects.

## Check

1. In a temporary project (see [Testing a deployed node](README.md#testing-a-deployed-node)),
   start a session on the new harness's model and confirm its models appear in the picker.
2. Ask it to create a file with its own tools and then call a Happy tool, such as listing
   projects. Confirm both happen.
3. Send a second message while it runs a long command and confirm it steers.
4. From a Happy session, ask it to call `agent_options` and confirm the new harness's models are listed
   when Happy reaches it, then to create a sub-agent on it.
