# Foreign agents

The other vendors' agents Happy can drive as a whole, one per harness type. Each is data around
the shared session in [`protocol/acp`](../../protocol/acp/README.md): how to reach the agent, the
models assumed before it has been asked, how its model selector becomes Happy models, how a Happy
model, effort and permission mode become its own options, and how credentials reach it.

| Type          | Reached through                                                      | Happy tools reach it through                         |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| `claude-code` | Claude Agent SDK ([`claudeAgent`](../claudeAgent/README.md))         | SDK `mcpServers` (HTTP)                              |
| `codex-cli`   | `codex app-server` ([`codexAppServer`](../codexAppServer/README.md)) | `mcp_servers` thread config (HTTP)                   |
| `antigravity` | ACP, `agy acp` (1.5.5 or newer)                                      | ACP `mcpServers` (HTTP)                              |
| `opencode`    | ACP, `opencode acp`                                                  | ACP `mcpServers` (HTTP)                              |
| `acp`         | ACP, to the configured `command`                                     | ACP `mcpServers` (HTTP), when the agent accepts them |

Claude Code and Codex have typed APIs, so they use first-party drivers that present themselves
as an ACP connection and take steering mid-turn. ACP is for agents without such an API.

Model IDs are `<type>/<the agent's model value>`, or `acp/<harness>/<model>` for a configured ACP
agent. Their family is `foreign`, so they receive no
Happy vendor tools: a foreign agent already has its own filesystem and shell. The models a type
lists here are only assumed until the agent reports its own through `modelsFromSelector`; OpenCode
and the generic `acp` agent assume none. Codex CLI runs the pinned `@openai/codex` this package
depends on, else a `codex` on PATH, else the pinned release through `npx`.

Antigravity is started as `agy acp`, without `--dangerously-skip-permissions`, after checking
that `agy --version` is at least 1.5.5. It takes HTTP `mcpServers` over ACP although it does not
advertise `mcpCapabilities`, so its initialize answer is read as accepting them. Its model
selector lists base names (`gemini-3.8-flash`) with a separate `thought_level` option, and its
modes are `plan`, `accept-edits`, and `auto`. It never asks before an MCP call, and it registers
only small MCP tools as functions: larger ones, `create_agent` among them, are left for its model
to load from a schema file, which it does not reliably do.

## Files

- `ForeignAgent.ts` — the contract each agent fills in, and shared helpers.
- `foreignAgents.ts` — every built-in agent, by harness type, and the agent behind a harness.
- `claudeCodeAgent.ts`, `codexCliAgent.ts`, `antigravityAgent.ts`, `opencodeAgent.ts`,
  `acpGenericAgent.ts` — one each.
