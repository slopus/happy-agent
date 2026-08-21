# MCP

MCP servers exposed to an agent through a host-owned boundary. `McpModule` does not create an SDK
client, open a socket, spawn a process, resolve a path, load credentials, or own a live client.
The host supplies those narrow protocol operations through `McpHost`; the module owns a bounded
per-agent server index in the database carried by the current context.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { McpModule } from "@slopus/happy-agent-modules";

const mcp = new McpModule({
    host: rigMcpHost,
    userInput: rigUserInput,
});
const agent = await Agent.create(ctx, { ...options, modules: [mcp] });
```

One module instance serves every agent. The host receives the calling agent ID and context on
every operation, so trust, credentials, connection lifetimes, and per-agent routing remain host
decisions rather than heap state inside the module.

## Tools

- **`list_mcp_servers`** — lists configured servers and their current status (`connected`,
  `blocked`, `disabled`, or `failed`) with a bounded cursor page.
- **`mcp__<server>__<tool>`** — direct tools discovered from each connected server. The name uses
  the existing normalization rule, and the server's JSON Schema is retained as the model-facing
  parameter schema.
- **`list_mcp_tools`** and **`call_mcp_tool`** — discover or invoke a live server-side tool by
  server/name, including tools added after startup.
- **`list_mcp_resources`**, **`list_mcp_resource_templates`**, and **`read_mcp_resource`** —
  discover and read server resources with bounded pages and bounded text/image output.
- **`list_mcp_prompts`** and **`get_mcp_prompt`** — preserve the existing protocol surface for
  reusable prompts. Loading prompt content is reviewed in Auto mode because it can contain
  instructions from outside Happy Agent's local sandbox.

Every MCP tool declares `requiresAutoOrFullAccess: true`. Direct and dynamic calls, plus prompt
loading, always request Auto review; server-provided annotations such as `readOnlyHint` never
change that decision. Intrinsically read-only catalog and resource operations explicitly skip
review while retaining the external-boundary declaration. The module declares these properties
on tools and never performs permission review or elevation itself.

The host's server summaries may carry `enabledTools` and `disabledTools` policy lists. Before a
dynamic or direct call is dispatched, the module rejects a tool absent from an enabled list or
present in a disabled list with a policy error. Hosts that omit both optional lists retain the
default of allowing the live server to decide.

If normalized direct tool names collide, only the contributing server or servers are quarantined:
their status becomes `failed`, their tool count becomes zero, and the collision is included in the
server error message returned by `list_mcp_servers`. Unrelated connected servers keep their tools.

## Blocked on Agent Base

Per-server MCP call serialization is not available in this module. Agent Base's tool contract has
no lock declaration, and the module contract forbids module-level in-memory locks, so per-server
serialization cannot be expressed without a change to the frozen base.

Tool results are translated to provider-neutral text/image blocks with the existing 512 KiB text,
four-image, five-MiB-image, 128-block, and bounded structured-JSON rules. Application results whose
`isError` is exactly `true` remain MCP errors. Elicitation requests are converted to the host's
ordinary user-input callback; without that optional callback they are declined, matching the
existing safe behavior.

## Host boundary

`McpHost` is structural and TypeBox-validated. It supplies:

- `listServers(ctx, agentId, permissionMode, query)`
- `listTools(ctx, agentId, { server, cursor?, limit? })`
- `callTool(ctx, agentId, { server, name, arguments? }, { onElicitation })`
- `listResources`, `listResourceTemplates`, `readResource`
- `listPrompts`, `getPrompt`

Each list operation is paged at the host boundary. Pages are validated for identity, requested
limit, duplicate records, and non-advancing cursors before the module returns them. Server summaries
may include the configured `enabledTools` and `disabledTools` lists used for pre-dispatch policy
enforcement. Hosts may instead provide the optional `getToolPolicy(ctx, agentId, server)` callback
returning the same bounded policy object; when absent, the module falls back to the summary fields.
Model-facing
formatters retain every actionable server/tool/URI identity before optional descriptions, and throw
if the configured output budget cannot fit a complete identity and continuation.

`fingerprintMcpServer` hashes the durable configured-server record (including workspace scope for a
project entry), not a live transport. `createMcpTrustUserInputRequest` and
`createProjectMcpSecurityNotice` retain the existing trust wording, while the trust store's file
location and persistence remain in Happy Agent.

## External functions

The module exposes `listServerPage`/`listServers`, `listToolPage`/`listTools`,
`listResourcePage`/`listResources`, `listResourceTemplatePage`, `listPromptPage`, `callTool`,
`readResource`, and `getPrompt`. The `format*ForModel` methods are the same renderers used by the
tools, so hosts can present an identical bounded view outside inference.
