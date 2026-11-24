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
own reviewer, and Happy sets the agent's mode from the conversation's permission mode. When the
agent asks before an action, Happy answers by mode:

| Happy mode      | Claude Code             | Codex CLI                               | Antigravity    | Asks the agent makes                                       |
| --------------- | ----------------------- | --------------------------------------- | -------------- | ---------------------------------------------------------- |
| Read only       | `plan`                  | `read-only`, never asks                 | `plan`         | refused without asking anyone                              |
| Workspace write | `acceptEdits`           | `workspace-write`, asks the person      | `accept-edits` | go to the person                                           |
| Auto            | `auto` (its classifier) | `workspace-write`, its Guardian reviews | `auto`         | Happy's Auto reviewer decides; the person only if it fails |
| Full access     | `bypassPermissions`     | `danger-full-access`, never asks        | `auto`         | allowed without asking                                     |

A question to the person comes from that harness (`permissionRequest.source = "harness"`), with
Allow once, Allow for this session when the agent offers it, and Deny. Stop withdraws an open
question and cancels the agent's ask.

In Auto, an ask goes to Happy's own Auto reviewer first, the same one that reviews Happy's own
tool calls: it reads the conversation's transcript under the same authorization rules, follows
the user's `SECURITY.md`, and can ask the parent chain. Allowed, the ask is approved once, never
for the session. Refused, it is denied: Claude Code's model is told Happy's refusal and why;
Codex and Antigravity carry no reason over their protocols and only learn the action was
refused. Refusals count toward the same limit as Happy's own (3 in a row, or 10 of the last 50,
stop the turn). Only when the reviewer decides nothing — every reviewer model unavailable, or no
answer in 120 seconds — does the ask go to the person, as it would in Workspace write; a
sub-agent then waits for an answer.

The reviewer never runs on the harness itself. It uses the account's own reviewer model when it
has one (Sonnet on a Claude account, Codex Auto Review or GPT-5.4 on a Codex account), then the
reviewer models of Happy's default model, trying each until one is available. An Antigravity
agent is therefore reviewed on Happy's default model.

Happy's own tools reach the agent as MCP tools. Tools Happy never reviews (reading history,
listing projects, and the like) are approved in advance on Claude Code and Codex CLI; the user's
other MCP servers are not. In Auto, the agent's ask about any other Happy tool is approved, and
Happy reviews the call itself when it runs, exactly as it reviews its own loop's calls: refused,
the agent gets the refusal as the tool's result. In Workspace write, a Happy tool the agent asks
about is allowed when Happy would not review that call, and goes to the person otherwise.
Antigravity asks before every MCP call in `accept-edits` and `auto`, and those asks are answered
the same way. Only Happy's own mode limits apply beyond that, such as MCP tools needing Auto or
Full access.

Happy sees only what the agent asks about. What its own rules allow alone is never reviewed, and
each agent's own reviewer is more permissive than Happy's. Seen against the pinned releases:

- Claude Code's `auto` classifier allowed a force push, `rm` outside the project, and writes to
  `.git/hooks` without asking anyone.
- Antigravity's `auto` runs most commands without asking, including some outside its sandbox;
  see [Antigravity's own permissions](#antigravitys-own-permissions).
- Codex's Guardian decides alone. Codex's `workspace-write` sandbox, used in Workspace write and
  Auto, also leaves `/tmp` writable and blocks the network.

Workspace write puts the most in front of the person, but it does not put everything there. The
agent still acts without asking where its own rules allow it: reading outside the project,
writing to `/tmp` where its sandbox allows that, commands it judges safe, and anything its own
settings allow. Claude Code reads the user's and the project's settings, so a repository's
`.claude/settings.json` allow rules apply. The agent's own sub-agents (Claude Code's Task tool,
Codex's agents) ask on the conversation that started them. A Happy sub-agent asks on its own
conversation, like any other agent.

Antigravity gives its model only about 60 KB of MCP tools and drops the rest without a way to call
them, which used to leave Happy's largest tools, `create_agent` and `create_subtask` among them,
out of reach. Happy now offers Antigravity its smallest tools directly and every other one through
a single `call_tool`, which describes a Happy tool by name and runs it. That call is handled as the
named Happy tool, under the same rules as any other.

### Antigravity's own permissions

What `agy` 1.5.15 does in each mode, probed over ACP on scratch folders. "Asks" is an ACP
permission request, which Happy answers as above; Antigravity offers only Allow and Deny, never
Allow for this session. On Deny or a cancelled ask the action fails and Antigravity ends its turn
at once, without a word to the model's reply.

| Action                                                            | `auto` (Happy Auto, Full access)                   | `accept-edits` (Workspace write) | `plan` (Read only)      |
| ----------------------------------------------------------------- | -------------------------------------------------- | -------------------------------- | ----------------------- |
| Read in the project                                               | silent                                             | not probed                       | not probed              |
| Read outside it, including a missing path under `~`               | silent                                             | asks                             | asks                    |
| Write, edit, or delete in the project                             | silent                                             | silent                           | asks to run `ls` first  |
| Write outside it with the file tool, `/tmp` and symlinks included | asks                                               | asks                             | writes a plan and stops |
| Command in the project (`ls`, `echo $HOME`)                       | silent                                             | asks                             | writes a plan and stops |
| Command writing or `rm -rf` in `/tmp`                             | silent; the sandbox leaves `/tmp` writable         | asks                             | writes a plan and stops |
| Command writing outside the project and `/tmp`                    | silent: retried outside the sandbox without asking | not probed                       | not probed              |
| `rm` of a file outside the project and `/tmp`                     | asks, to run outside the sandbox                   | not probed                       | not probed              |
| Network command (`curl`)                                          | silent                                             | not probed                       | not probed              |
| `git push --force` to a local remote                              | refused by its own policy, no ask                  | not probed                       | not probed              |
| Any MCP tool call, Happy's included                               | asks                                               | asks                             | writes a plan and stops |
| Its own sub-agent (`invoke_subagent`)                             | silent; its sub-agents never send an ask           | not probed                       | not probed              |

In `plan`, Antigravity writes an implementation plan under `~/.gemini/antigravity-cli/brain/`
and waits for its approval instead of acting; Happy's Read only answers no ask with yes, so
nothing in the plan runs.

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
follow the [table above](#permissions): Read only refuses them, Full access allows them, Auto
puts them to Happy's reviewer first, and otherwise they reach the person. Everything the agent does without asking follows its own
settings, so set those to match what the user expects.

## Check

1. In a temporary project (see [Testing a deployed node](README.md#testing-a-deployed-node)),
   start a session on the new harness's model and confirm its models appear in the picker.
2. Ask it to create a file with its own tools and then call a Happy tool, such as listing
   projects. Confirm both happen.
3. Send a second message while it runs a long command and confirm it steers.
4. From a Happy session, ask it to call `agent_options` and confirm the new harness's models are listed
   when Happy reaches it, then to create a sub-agent on it.
