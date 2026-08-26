# Extending Happy Agent

This guide is written for a coding agent running inside Happy Agent that has been asked
to extend Happy Agent. Everything below describes behavior that actually ships; where
something is planned rather than implemented, it says so explicitly.

There are five extension surfaces, ordered by how much they let you change:

| Surface                                | What it adds                                                                            | Who writes it           |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------- |
| **Plugins**                            | A JavaScript or TypeScript process that contributes MCP tools and local UI applications | You, inside Happy Agent |
| **Skills**                             | Instructions a model loads on demand from a `SKILL.md` file                             | You or the user         |
| **MCP servers**                        | Tools, resources, and prompts from an external process or HTTP service                  | The user, in config     |
| **Happy Agent Connect / integrations** | External apps that read Happy Agent's live state and drive it                           | An application author   |
| **Subagents and workflows**            | Extra agents and deterministic multi-agent scripts, at runtime                          | You, per task           |

---

## Plugins

A local plugin is the general-purpose extension mechanism. It is ready-to-run
JavaScript or TypeScript that Happy Agent runs as its own sandboxed process, connected
back to the daemon over a private Unix socket. From there it can create
workspaces, send messages to agents, read provider usage, contribute MCP tools,
and contribute a small local UI application.

### What a plugin folder contains

Three files are enough. Happy Agent does not require a `package.json`.

```text
project-counter/
├── happy.plugin.json    manifest — required
├── icon.png             PNG icon — required
└── index.ts             main entry point — required
```

### The manifest

`happy.plugin.json` is validated against a strict schema and **extra fields are
rejected**:

```json
{
    "name": "Project Counter",
    "author": "Acme Tools",
    "category": "developer-tools",
    "description": "Reports how many projects Happy Agent knows about.",
    "main": "index.ts",
    "icon": "icon.png"
}
```

| Field         | Rule                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `name`        | Non-empty string. Human-readable; also used to derive the agent-facing MCP tool name.                        |
| `author`      | Required 1–80 character publisher label without leading/trailing whitespace or control/direction characters. |
| `category`    | Required catalog category; see the canonical values below.                                                   |
| `description` | Required 1–512 character explanation of what the plugin does.                                                |
| `main`        | Process entry path; optional only when skills or a system prompt provide the plugin's behavior.              |
| `icon`        | Relative path ending in `.png` (any capitalization of the extension).                                        |
| `version`     | Optional Semantic Versioning string; an omission becomes `0.0.0`.                                            |
| `apps`        | Optional list of bounded static MCP App manifests.                                                           |

`category` is exactly one of `automation`, `collaboration`, `data`,
`developer-tools`, `media`, `productivity`, `utilities`, or `other`.

Additional rules Happy Agent enforces when it reads the manifest:

- `main` and `icon` must be relative and must resolve **inside** the plugin
  folder.
- Both must resolve to ordinary files inside the plugin's real directory tree;
  final or intermediate symbolic-link escapes are rejected.
- The icon must be a fully decodable square PNG, between 1×1 and 2048×2048
  pixels and no larger than 4 MiB. A renamed JPEG, truncated PNG, SVG,
  placeholder string, or URL is rejected and the plugin does not register.

Do not invent manifest fields such as `permissions` or `contributes`; adding one
makes the manifest invalid.

### The icon

Every registered plugin must ship an original PNG icon. Happy Agent bundles a skill for
producing one, `local-plugin-icon`.
It triggers automatically when you create or edit a plugin, a `happy.plugin.json`,
or its icon. Follow it: it defines the shared visual family (Jobs-era iPhone icon
craft, one metaphor, no text or third-party marks) and the verification steps —
generate a square image, prefer 1024×1024, inspect it, save a real PNG in the
plugin folder, keep it at or below 2048×2048 and 4 MiB, and point `icon` at that
relative path.

### The entry file

Happy Agent starts `main` with the same Node executable that runs Happy Agent. Node strips
erasable TypeScript syntax without a compile step or extra flag, so TypeScript
may use top-level `await` and relative `.ts` imports. Constructs that require
JavaScript generation are not supported. Use `.mjs` or a local
`"type": "module"` package declaration for JavaScript ESM.

```ts
import { happy } from "happy-plugins";

const projects = await happy.projects.list();
console.log(`Happy Agent has ${projects.length} projects.`);

await happy.ready("Ready.");

// A service-style plugin stays alive until Happy Agent shuts it down.
await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
});
```

Plugin code never opens a connection, finds credentials, or speaks Happy Agent's
protocol. The `happy` singleton reads the socket path and token that the daemon
injects and connects for you. Happy Agent registers one ESM loader hook with `--import`
to map `happy-plugins` and `happy-plugins/internal` to the SDK shipped with Happy Agent;
the plugin does not vendor a runtime SDK.

Happy Agent provides only `happy-plugins` at runtime. Bundle every other third-party
dependency into the plugin's own files; Happy Agent does not copy `node_modules` when
it installs a plugin.

### The SDK surface

All SDK methods return promises; inputs and daemon responses are validated with
TypeBox at runtime. The current surface is:

```ts
happy.projects.list();

happy.workspaces.list({ projectId? });
happy.workspaces.create({ projectId, name, baseRef? });
happy.workspaces.rename({ projectId, workspaceId, name, version });
happy.workspaces.archive({ projectId, workspaceId, version });

happy.sessions.list();
happy.sessions.create({ cwd, providerId?, modelId?, effort?, appendSystemPrompt?, workspaceId? });

happy.agents.sendMessage({ agentId, message });

happy.providers.usage();

happy.mcp.startServer({ name, tools });
happy.ready("Ready."); // Call once, after every startup contribution is registered.
happy.ui.startApplication({ id, title, entry, navigation?, resources, actions });
```

Workspace mutations are optimistic: pass the `version` from the most recently
returned workspace. Failed requests throw `HappyPluginApiError` carrying the HTTP
status.

#### Contributing MCP tools

This is the first and most useful plugin point. No MCP server package is needed —
reuse the `Type` and `defineMcpTool` exports:

```ts
import { defineMcpTool, happy, Type } from "happy-plugins";

await happy.mcp.startServer({
    name: "Catalog",
    tools: [
        defineMcpTool({
            name: "list_projects",
            description: "List every local Happy Agent project.",
            inputSchema: Type.Object({}, { additionalProperties: false }),
            async execute(_input, { signal }) {
                signal.throwIfAborted();
                const projects = await happy.projects.list();
                return { content: [{ type: "text", text: JSON.stringify(projects) }] };
            },
        }),
    ],
});
await happy.ready("Ready.");

// Keep the process alive so the server stays registered.
await new Promise<void>(() => {});
```

Happy Agent offers the tool in ordinary sessions everywhere. The agent-facing name is
stable and derived from the plugin name, server name, and tool name by the SDK's
`createHappyMcpToolName`:

```text
mcp__<plugin name>_·_<server name>__<tool name>   with every character outside
                                                  [A-Za-z0-9_-] replaced by "_"
```

For the example above with a plugin named `Project Tools`, that is
`mcp__Project_Tools___Catalog__list_projects`. Call
`createHappyMcpToolName(pluginName, serverName, toolName)` rather than
hand-writing it in a test.

Plugin tool calls use the same permission path as configured MCP servers: they
require Auto or Full access, and every Auto call is reviewed, because a plugin
may act outside Happy Agent's filesystem sandbox. Cancellation reaches the handler's
`AbortSignal`, and disconnected, replaced, restarted, or uninstalled generations
are retired immediately.

#### Contributing a local application

A plugin may register one or more static bundles plus typed actions through
`happy.ui.startApplication`. Happy Agent serves them to hosts (currently the Happy2
Electron shell) which mount them instantly. Limits enforced by the daemon: 8
applications per plugin, 32 actions and 64 resources per application, 256 KiB per
resource, 1 MiB per decoded bundle, 64 concurrent actions, a 30-second action
timeout, and 1 MiB action bodies. Supported media types are JSON, WOFF2, JPEG,
PNG, SVG, WebP, CSS, HTML, and JavaScript.

### Where things live

Plugin code and Happy Agent's bounded log stay in Happy Agent's managed home; everything the
plugin writes at runtime goes to a folder a person can open.

```text
~/.happy/agent/plugins/<folder>/                   installed code, managed by Happy Agent
├── happy.plugin.json
├── icon.png
├── index.ts
└── plugin.log                          bounded current-run output

~/Happy/Plugins/<folder>/               the plugin's writable folder (macOS)
~/happy/plugins/<folder>/               the same on Linux
└── .runtime/plugin.sock                per-plugin API socket
```

`<folder>` is derived from the source directory's base name, lowercased with
runs of unsupported characters replaced by `-`.

Overrides, all requiring absolute paths:

| Variable                      | Effect                                     |
| ----------------------------- | ------------------------------------------ |
| `HAPPY_HOME_DIR`              | Moves Happy Agent's private `.happy` root. |
| `HAPPY_PLUGINS_DIRECTORY`     | Moves the installed-plugin root.           |
| `HAPPY_PLUGIN_DATA_DIRECTORY` | Moves the writable plugin-data root.       |

The plugin process runs with its writable folder as the working directory, under
Happy Agent's existing command sandbox confined to that folder. Happy Agent injects:

| Variable                   | Meaning                                        |
| -------------------------- | ---------------------------------------------- |
| `HAPPY_PLUGIN_DIRECTORY`   | Absolute path to the plugin's writable folder. |
| `HAPPY_PLUGIN_SOCKET_PATH` | Private Unix socket used by the SDK.           |
| `HAPPY_PLUGIN_TOKEN`       | Per-process bearer token used by the SDK.      |

Write state in `HAPPY_PLUGIN_DIRECTORY` and nowhere else.

### Installing, listing, logging, uninstalling

Four agent tools drive the lifecycle:

| Tool               | Arguments                                      | What it does                                                                                                              |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `plugin_install`   | `path` — folder containing `happy.plugin.json` | Copies and validates the ready-to-run folder, then starts the plugin before returning.                                    |
| `plugin_list`      | none                                           | Returns every installed plugin with `status`, `directory`, `dataDirectory`, `logAvailable`, plus registration `failures`. |
| `plugin_logs`      | `name` — plugin name or folder name            | Returns the newest bounded log or startup diagnostic with `status`, `source` (`current_run` or `error`), and `truncated`. |
| `plugin_uninstall` | `name`                                         | Stops the plugin, removes its installed code, and keeps its writable folder.                                              |

Plugins live outside the workspace, so all four are reviewed in Auto mode;
`plugin_install` and `plugin_uninstall` additionally run with a temporary Full
access override because they must write outside the sandbox. A denial is a real
answer: do not retry the same action by another route.

Installation is staged. The plugin is copied into a hidden folder and its
manifest, icon, and main entry point are validated there. An invalid plugin is
never installed and never replaces a working one. `.git`, `.runtime`,
`node_modules`, and `plugin.log` are excluded from the copy, and the copy is
bounded to 2,000 files and 32 MiB. Happy Agent provides `happy-plugins` at runtime; all
other third-party dependencies must be bundled into the plugin's own files.

Every change publishes a live `plugins_changed` event carrying the whole current
set, so clients never poll and never wait for a daemon restart. The daemon also loads every installed plugin at startup. A
plugin's authoritative state is one of `running`, `stopped`, or `failed`.

For the user, `/plugins` shows the installed set and `/plugins <name>` prints
that plugin's current log.

### Minimal walkthrough

Building a plugin from inside Happy Agent, end to end:

1. Create the folder — `.context/project-counter/` is a good scratch location, or
   somewhere the user names.
2. Write `happy.plugin.json` with the six fields this process plugin needs:
   `name`, `author`, `category`, `description`, `main`, and `icon`.
3. Write `index.ts` against the `happy` singleton.
4. Generate `icon.png` using the bundled `local-plugin-icon` skill; verify it is
   a fully decodable square PNG no larger than 2048×2048 pixels or 4 MiB.
5. Type-check and test the plugin, then call `plugin_install` with the absolute
   path to the folder. Happy Agent validates, copies, and starts it without compiling.
6. Call `plugin_list` to confirm `status: "running"`, and `plugin_logs` if it is
   `failed` or `stopped` — startup diagnostics come back through the same tool.
7. If it contributes MCP tools, they become available to sessions under the
   `mcp__…` name above.

To iterate without installing, the SDK ships a runner that starts a source plugin
against an in-memory fake host, prints every request and registration, lists MCP
tools, and can call one. It needs Node 22.6 or newer and no Docker:

```sh
pnpm happy-plugin dev ./index.ts \
  --seed ./happy.plugin.dev.json \
  --list-tools \
  --call "Project tools/list_projects" \
  --arguments '{}'
```

`createHappyPluginTestHost()` exposes the same host programmatically for tests,
including `host.mcp.*`, `host.ui.*`, and a real `HAPPY_PLUGIN_DIRECTORY`.

For end-to-end coverage, write a gym test instead of mocking the daemon: drive a
real plugin through its sandbox socket, and assert that a source plugin's MCP
tool reaches an active session.

### Trust

Happy Agent does not implement a permission model for plugins. Plugin code is relatively
trusted and is not restricted by per-capability checks. What _is_ enforced is the
process sandbox, the writable-folder confinement, the authenticated socket, and
the ordinary MCP review path for tools a plugin contributes to a session.

---

## Skills

A skill is a set of instructions delivered through a `SKILL.md` file. It changes
what a model knows how to do without changing any code. Happy Agent follows Codex
behavior and scope here deliberately; it does not implement Claude Code's
expanded skill runtime, and it does not interpret Claude or Pi skill trees.

### Where skills are discovered

Happy Agent searches these roots, in this order:

1. **Builtin** — skills shipped inside Happy Agent (currently `local-plugin-icon`).
   Read-only; never write here.
2. **User** — `~/.codex/skills` and `~/.agents/skills`.
3. **Project** — `.agents/skills` in every directory from the project root down
   to the working directory.

Within each root, discovery walks directories recursively looking for a
`SKILL.md`; finding one stops descent into that subtree. Entries starting with
`.` and `node_modules` are skipped. Later roots win on name collision, so a
project skill overrides a user skill of the same name, which overrides a builtin.

### `SKILL.md` format

YAML frontmatter followed by markdown instructions:

```markdown
---
name: release-notes
description: Use when the user asks to draft release notes from merged pull requests.
---

# Release notes

1. Collect merged PRs since the last tag.
2. Group them by area.
   ...
```

Only three frontmatter keys are read:
`name` (string), `description` (string), and `disable-model-invocation`
(boolean). The first two are what matter — `disable-model-invocation` is parsed
but nothing currently consumes it. Any other key is ignored.

Validation, when a skill file is loaded:

- `name` defaults to the containing folder's name when frontmatter omits it, and
  must match `^[a-z0-9-]+$`, be at most 64 characters, and not start or end with
  `-` or contain `--`.
- `description` is required (there is no fallback), is trimmed, and must be
  1–1024 characters.
- A file failing either check is silently skipped, so a skill that does not
  appear almost always has an invalid name or a missing description.

### When a skill triggers

Happy Agent injects the catalog — name, description, and location — into the system
prompt. The model uses a skill when the user names it or the task clearly matches
its description, reads the complete file before acting, and resolves relative
paths in the skill against the directory containing that `SKILL.md`.

Skill files are **instruction resources only**. Frontmatter that requests hooks,
shell execution, model switching, or permission changes is ignored by design; do
not add such fields expecting them to work.

## MCP servers

MCP is how Happy Agent consumes tools it did not write. Servers are configured in TOML,
not installed.

### Configuration

MCP uses dedicated files rather than the ordinary `happy.toml` layers:

| Scope       | File                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `global`    | `mcp.toml` in Happy Agent's config directory — `~/Happy/Config` on macOS or `~/happy/config` on Linux |
| `workspace` | `mcp.toml` at the workspace root                                                                      |

The user-wide entry wins when both catalogs use the same server name. Workspace catalogs activate
on demand while they have an unarchived session. Identical normalized configurations share one
connection/process across workspaces, and the final owner releasing a server closes it.

A local stdio server:

```toml
[mcp_servers.docs]
command = "docs-mcp-server"
args = ["--stdio"]
env = { API_TOKEN = "token" }
cwd = "/absolute/working/directory"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 30
enabled_tools = ["search"]
disabled_tools = []
```

A streamable HTTP server:

```toml
[mcp_servers.issues]
url = "https://example.com/mcp"
transport = "http"
http_headers = { "X-Client" = "Happy Agent" }
bearer_token_env_var = "ISSUES_MCP_TOKEN"
oauth_client_id_env_var = "MCP_CLIENT_ID"
oauth_client_secret_env_var = "MCP_CLIENT_SECRET"
oauth_scopes = ["tools:read"]
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 30
enabled_tools = ["search"]
disabled_tools = []
```

Exactly one of `command` and `url` must be present. `transport` is only accepted
as `"http"`; a `command` entry is stdio implicitly. Unknown keys in an
`[mcp_servers.*]` table are a configuration error, so do not guess names.

MCP tools, resources, resource templates, prompts, pagination, form elicitation,
bearer tokens, and OAuth client credentials are supported, and live tool
discovery lets a session use tools added after startup.

### Boundary rules

These are product rules, enforced on the tool definitions themselves:

- Every MCP tool sets `requiresAutoOrFullAccess: true`, because the server can
  act outside Happy Agent's local sandbox. MCP is unavailable in Read only and Workspace
  write.
- Every direct and dynamic MCP tool invocation is reviewed in Auto
  (`shouldReviewInAutoMode: () => true`), and the approval text discloses the
  external boundary.
- Happy Agent-owned protocol operations that are intrinsically read-only skip review:
  `list_mcp_tools`, `list_mcp_resources`, `list_mcp_resource_templates`,
  `read_mcp_resource`, and `list_mcp_prompts`. The operations that reach the
  server to do something — `call_mcp_tool` and `get_mcp_prompt` — are reviewed.
- Server-supplied annotations such as `readOnlyHint` are untrusted metadata. They
  are never authorization evidence and never a reason to skip review.
- A workspace's root `mcp.toml` is protected project configuration, so changing it through an
  agent file tool is reviewed and requires the protected-path elevation.
- Stdio servers run as local processes with the daemon environment and are **not**
  restricted by the session filesystem sandbox. Only configure servers you trust.

Plugin-contributed MCP servers travel the same composite provider path as
configured ones, so tool assembly, `AgentContext`, and `PermissionContext`
behavior stay shared.

---

## Happy Agent client and integrations

External applications drive the daemon through `@slopus/happy-agent-client`.
The host supplies a Fetch implementation and bearer token; the client exposes
the typed `/v0` request and SSE contracts without reading credentials or daemon
state directly. See `packages/happy-agent/API.md` for the complete public
surface.

### Other integration surfaces

- **Project and workspace files** — `GET`/`PUT` `/projects/{id}/file` and
  `/projects/{id}/workspaces/{id}/file`, with SHA-256 optimistic concurrency, a
  32 MB limit, and Happy Agent's workspace boundary applied.
- **HTTP proxy** — `CONNECT /projects/{id}/proxy` (and the workspace-scoped form)
  tunnels ordinary HTTP through the authenticated daemon connection.
- **Happy mobile synchronization** — a first-class daemon feature, gated by both
  the embedder's `happyIntegration` option and the user-wide
  `[settings] happy_integration` config value, both fail-closed.
- **Remote terminals** — Happy Agent's own libghostty-based terminal protocol. It is
  deliberately unspecified for outside consumers right now: it exists to work
  inside Happy and Happy Agent.

### Planned, not implemented

Do not write code against these yet; they are directions rather than features:

- **Electron-isolated plugin UI.** Instant mounting under a proper Electron
  isolation mechanism is the goal; the current implementation serves bounded
  static bundles and typed actions and leaves mounting to the host.
- **A published terminal protocol specification.** The protocol may be improved
  and specified later; today it is proprietary.
- **A wider plugin API.** The SDK surface grows as plugins ask for it. Extend it
  deliberately rather than reaching around it.

Happy Agent deliberately has **no** plugin marketplace, no plugin identifier scheme, no
plugin permission model, and no separate Happy Agent login flow. These are settled
non-goals, not gaps to fill.

---

## Subagents and workflows

The lightest extension mechanism is runtime, not installed: spawn a subagent with
its own model and effort, or run a deterministic multi-agent workflow. Nothing is
compiled and nothing persists — it is how you extend a single task rather than
the product.

Use it when work is bounded and parallelizable (research, review, verification),
or when a job is genuinely a pipeline over many items. Every subagent needs an
explicit model and effort; nothing is inherited.

Full guidance — when to delegate, choosing models and effort, background agents,
agent-to-agent messaging, and workflow scripting — is in
[`agents-and-collaboration.md`](agents-and-collaboration.md).

---

## Rules that apply to every extension

- **One permission model.** Codex, Claude, Pi, Grok, MCP, and plugin tools all
  execute through the same `AgentContext`, filesystem boundary, shell sandbox,
  and `PermissionContext`. Provider differences belong in tool names, argument
  schemas, and result formatting — never in a separate security path.
- **Each tool owns its Auto behavior.** `shouldReviewInAutoMode` is required.
  Define `shouldRunInFullAccessInAutoMode` only when a reviewed action must cross
  the sandbox; review alone must not imply elevation. Never dispatch permission
  behavior from a tool-name list, prefix, or provider key.
- **Common tools are assembled once.** A capability that belongs to Happy Agent rather
  than a vendor goes through the shared common-tool entry point so any future
  model picks it up without per-provider work.
- **TypeBox for all runtime validation.** Derive TypeScript types with `Static`;
  do not hand-write parallel interfaces or ad hoc type predicates.
- **Early-stage compatibility.** Change schemas and behavior directly instead of
  adding aliases or migration branches — but never edit an existing database
  migration.
- **Use `pnpm`.** Never `npm`, `npx`, or `yarn`.
- **Test at the boundary.** For anything spanning terminal input or rendering,
  inference, tools, processes, filesystem effects, or permissions, write a gym
  test, and reproduce a bug in the gym before changing production code.
- **User-facing text is human-readable English.** Convert identifiers, enum
  values, and file names into clear display text before rendering them.
