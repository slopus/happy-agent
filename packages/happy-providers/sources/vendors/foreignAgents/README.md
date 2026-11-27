# Foreign agents

The other vendors' agents Happy can drive as a whole, one per harness type. Each is data around
the shared session in [`protocol/acp`](../../protocol/acp/README.md): how to reach the agent, the
models assumed before it has been asked, how its model selector becomes Happy models, how a Happy
model, effort and permission mode become its own options, and how credentials reach it.

| Type          | Reached through                                                      | Happy tools reach it through                         |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| `claude-code` | Claude Agent SDK ([`claudeAgent`](../claudeAgent/README.md))         | SDK `mcpServers` (HTTP)                              |
| `codex-cli`   | `codex app-server` ([`codexAppServer`](../codexAppServer/README.md)) | `mcp_servers` thread config (HTTP)                   |
| `antigravity` | ACP, `agy acp` (1.5.15 or newer), as Happy's custom agent            | ACP `mcpServers` (HTTP), named in its agent file     |
| `opencode`    | ACP, `opencode acp`                                                  | ACP `mcpServers` (HTTP)                              |
| `acp`         | ACP, to the configured `command`                                     | ACP `mcpServers` (HTTP), when the agent accepts them |

Claude Code and Codex have typed APIs, so they use first-party drivers that present themselves
as an ACP connection and take steering mid-turn. ACP is for agents without such an API.

Model IDs are `<type>/<the agent's model value>`, or `acp/<harness>/<model>` for a configured ACP
agent. Their family is `foreign`, so they receive no
Happy vendor tools: a foreign agent already has its own filesystem and shell. Antigravity is the
exception: Happy removes its own tools, so Happy hands an `antigravity/` model a Claude-shaped
shell and file array. The models a type
lists here are only assumed until the agent reports its own through `modelsFromSelector`; OpenCode
and the generic `acp` agent assume none. Codex CLI runs the pinned `@openai/codex` this package
depends on, else a `codex` on PATH, else the pinned release through `npx`.

Antigravity is started by `antigravityHappyOnly` as `agy acp --agent happy-<random> --add-dir
<folder> --log-file <folder>/agy.log`, after checking that `agy --version` is at least 1.5.15.
Each connection gets a private temporary folder holding a custom agent file,
`.agents/agents/<name>/agent.md`, written just before each session opens: `mainAgent: true`,
`inheritMcp: false`, `tools: [search_web]` (agy's only tool left), and `mcpServers` naming
Happy's bridge with the session's URL and bearer header, and `excludeDefaultComponents: true`.
agy refuses an ACP-passed MCP server its agent file does not name, expands no variables there, and
accepts only the list form. `excludeDefaultComponents` keeps out every prompt section agy would
add (artifacts, its MCP server list and the instruction to read schema files, guidelines,
communication style, messaging, user information listing the workspace folders, which included
the private folder holding the bridge token, user rules and workspace skills), about 1.7k tokens
a turn, so the file's body is agy's whole system prompt. Its one rule worth keeping is folded into
that body: never bypass access controls or the sandbox. Happy's own instructions and a guide to
its tools (`acpToolGuide`) are appended through ACP `_meta.antigravity.systemPrompt.append` on
every new, resumed and loaded session, so the first prompt no longer carries them. agy reads the file when a session opens; one it cannot load makes it
log `Agent "<name>" not found, falling back to default` and continue with all of its own tools,
so after every open the log is read and such a session is stopped. Anything agy asks about other
than a Happy tool call is refused without asking anyone. The file, which holds the token, is
deleted when the process exits; the log stays. A configured `command` runs as it is, with agy's
own tools. `connectReadOnly` starts the same agent with `tools: []`, not even web search, and a
prompt saying it only reads, for Happy's permission reviewer; it refuses a configured `command`,
which Happy cannot hold to that.

agy 1.5.15 loads MCP tools lazily: its default prompt lists only their names under
`<mcp_servers>` and tells the model to read schema files with tools it no longer has, which is why
that section is excluded and Happy's tool guide describes the tools instead. Every call goes
through agy's own `call_mcp_tool`, which asks first with `{ ServerName, ToolName, Arguments }` titled
`MCP Tool <name>`; 1.5.18 also sends `name: "call_mcp_tool"`, the same input again as `args`, and
`sessionUpdate`. happy-providers 0.0.66 (Happy Agent 2026.11.11-preview.2) is the first to
recognize agy's `call_mcp_tool` ask. 0.0.65, which stable 2026.11.10 and 2026.11.11-preview.1
ship, skipped an ask only for `happy/bridgedCall` metadata, which agy never sends, so there every
Happy tool call agy made reached the person in Auto and Workspace write. 1.5.10 declared tools
directly as `mcp_happy_<tool>` up to about 60 KB and dropped the rest; both forms are recognized,
by the operation's `name` alone and never by its title or by input that merely looks like a Happy
call. Its profile sets `toolDeclarationBudget`, so the bridge declares the up-front tools first
and always offers `call_tool`, which describes any Happy tool and runs those left out. agy's monitors (`agy_tool_safety`, a Flash-Lite call, and a blocking
`severe_internal_risks_agy`) still see each call and could only block it, never allow anything
Happy refuses. agy runs in its `default` mode for every Happy mode. It titles its own record of an
MCP call `MCP Tool <name>` (1.5.15) or `Run mcp_happy_<tool>` (1.5.10).

## Files

- `ForeignAgent.ts` — the contract each agent fills in, and shared helpers.
- `foreignAgents.ts` — every built-in agent, by harness type, and the agent behind a harness.
- `claudeCodeAgent.ts`, `codexCliAgent.ts`, `antigravityAgent.ts`, `opencodeAgent.ts`,
  `acpGenericAgent.ts` — one each.
- `antigravityHappyOnly.ts` — Antigravity's per-session agent file, launch flags, and the checks
  that keep agy's own tools out.
