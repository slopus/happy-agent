# Config module

`ConfigModule` is the first module loaded by the Happy Agent runtime. It resolves
one `.happy` root, reads the global, project, and private runtime TOML layers,
and exposes one deeply frozen snapshot.

```text
<parent>/
├── .happy/
│   ├── docs/
│   └── agent/
│       ├── agent.sqlite
│       ├── artifacts/
│       ├── tailcat/
│       └── runtime.toml
└── Happy/
    └── Config/
        ├── happy.toml
        ├── mcp.toml
        ├── AGENTS.md
        └── SECURITY.md
```

The tree above shows macOS. On Linux, the public configuration directory is `happy/config`
instead of `Happy/Config`; private `.happy/agent` paths are unchanged.

The project layer is `happy.toml` in the current working directory. Project
machine settings (credentials, provider
selection, daemon settings, permission mode, and observation) are filtered
before merging. Precedence is global → project → runtime.

MCP is deliberately separate. User-wide servers come from the global `mcp.toml`, and
`readWorkspaceMcpServers()` reads a workspace root's own `mcp.toml`. MCP entries in `happy.toml`,
runtime, Codex, Claude, or other provider configuration are ignored by the live MCP catalog.
`readMcpServers()` reads the user file fresh for online reload, and `updateMcpServer()` canonically
updates one named global server while preserving the other server records.

`runtime.toml` is generated and daemon-owned. Startup rewrites its known values canonically, and
runtime mutations replace it atomically; comments and unknown fields are intentionally not
preserved. Provider records merge field-by-field across layers, so a runtime `auto_enable` or
`enabled` value does not erase credentials, model filters, or endpoints from the global provider
record.

Missing files are valid and use bounded defaults. `happy.toml` uses the Happy Agent
spelling; resolved values use ergonomic camelCase names such as `modelId`,
`providerId`, `permissionMode`, `compactCompletedTurns`, and
`serviceTier`. The resolved snapshot includes all Happy Agent-shaped sections:
providers, MCP servers, Docker, network, observation, permissions, P2P,
presence, theme, features, workspace sync/protection, and retention
settings. Ordinary collaboration reads `settings.maxCollaborators` and
`settings.maxCollaborationDepth` from this snapshot; their persisted TOML spellings are
`max_collaborators` and `max_collaboration_depth`.

`[settings.ethan] enabled = true` enables token-max mode for a token-rich user who expects the
agent to keep consuming tokens rather than accept an error as final. Agent work always retries,
forever, including provider errors, failed compactions, and fatal internal run-stage errors. Only
explicit cancellation, provider disablement, or daemon shutdown stops active work.

`[feature.codemode] enabled` is an opt-in experimental feature flag, defaulting to `false`.
`engine` selects `"monty"` (the default continuous Python interpreter) or `"bun"` (a stateless
system Bun JavaScript/TypeScript proof of concept). When enabled, the final Code Mode module
replaces the complete model prompt and tool surface with the selected engine's single tool.
Configuration owns Monty's exact private snapshot path at
`.happy/agent/state/<agentId>/snapshot.bin` and validates the agent's cuid2 before it can become a
path segment.

Artifact content is private and lives in `.happy/agent/artifacts`: `artifactContentPath(sha256)`
names one stored file by its digest under `content/<first two hex digits>/`, and
`artifactUploadPath(uploadId)` names the file an upload's bytes arrive in under `uploads/`, and
`artifactDataPath(artifactId)` names one artifact's data store, `_data_/<artifactId>/kv.sqlite`;
its debug log, `logs.sqlite`, sits in the same directory.
Each validates its segment before it becomes part of a path.

`[telegram] api_url` points every bot exported to Telegram at a self-hosted Bot API server instead
of `https://api.telegram.org`. It is a machine setting, dropped from the project layer, because
that server receives every bot token. The exports themselves live in the database; see
[`../exportedBots/README.md`](../exportedBots/README.md). `exportedBotFilesPath(kind, account)`
names one export's private folder for files it receives,
`.happy/agent/exported-bots/<kind>/<account>`, and validates both segments.

`[feature.tailcat] enabled = true` is a machine-only opt-in. The Tailcat module opens the daemon's
active Unix-socket or team HTTP transport through bundled Tailcat v0.7.0, while the Happy API
continues to require its ordinary local bearer token or WorkOS token. `port` defaults to the fixed,
IANA-unassigned port `24779`; another nonzero TCP port may be selected in the same global section.
It is the port remote nodes dial, which the module never changes and never binds locally. The
fixed-region Tailcat identity key lives under `.happy/agent/tailcat/` and survives daemon restarts.
The live address and port files are present beside it only while the tunnel is open. A project
configuration cannot enable this Internet-reachable transport.

`tailcatExposurePaths(name)` names the files of one additional Tailcat exposure in the same
private folder: `<name>.private.json` for its own stable identity key, and `<name>.address` and
`<name>.port` while it is open. `default` belongs to `[feature.tailcat]` and is refused.

`[feature.mobile_connector]` has `enabled`, default `true`, and `port`, default `24781`. Like
Tailcat it is machine-only, so a project's `happy.toml` cannot open, move, or close the phone
connection socket, and port zero is invalid.

`[feature.team] enabled` selects the opt-in team deployment mode and defaults to `false`. It is a
machine setting, so a project's checked-in `happy.toml` cannot enable it. Team mode has no private
local API socket or bearer-token file. Instead, it exposes the WorkOS-authenticated API over TCP.
`host` and `port` select the listener and default to `0.0.0.0` and `3000`.
Port `0` asks the operating system to select an ephemeral port.
`workos_client_id` defaults to the production Happy Cloud WorkOS client and may select another
WorkOS project; the expected issuer and JWKS URL are derived from it. An enabled team deployment
also requires `workos_organization_id` and `owner_workos_user_id`. Access tokens must carry that
organization, and the matching owner identity receives the owner flag when their profile first
creates a user.

`[observation]` decides what the agent records about itself, and is read only
from the global and runtime layers. A checked-in project file that turned
tracing on and named its own endpoint would send this machine's traces
wherever the repository asked, so the section is dropped from that layer along
with the other machine settings. See
[`../observation/README.md`](../observation/README.md).

Not everything in the snapshot comes from a file. `version` is the version this
build reports as itself: nobody edits it, no `.happy` folder owns it, and it is
handed to `ConfigModule.load` by whoever starts the agent, defaulting to
`"development"`. It lives here because everything that has to say what this agent
is — a span, a log line, the client header sent to a server — already reads the
configuration and would otherwise be handed the version separately.

## The accounts

Configuration is not only what the files say. This module owns the accounts too: `providers` is one
registry holding every configured provider, each constructing its client on first use. Providers
start behind a disabled gate; `ProviderScanModule` opens the gates after bounded local credential
discovery or an explicit user enable. `models` is the live curated catalog filtered by those gates,
while `offeredModels` is the stable complete set the agent systems can accept after a later enable.
Happy Agent never asks a vendor which models exist — the list is source, and a configured provider
entry decides which of them its own key serves.

## Harnesses

`[harnesses]` says who runs the agent loop on those accounts (`impl/harnesses.ts`). `happy` is
Happy's own loop and lists the curated models. `claude_code` and `codex_cli` run Claude Code or
Codex itself on the `claude` or `codex` accounts they accept, and add those agents' models to the
same accounts. Agents with their own login (`antigravity`, `opencode`, `acp`) become provider
entries under their harness ID while the layers merge, so the registry, enablement, names, and
catalog treat them as accounts. `impl/createForeignAgentProvider.ts` turns each harness × account
pair into a route; the registry sends a model with a foreign prefix to that route's agent. Foreign
agents are the one exception to the curated list: each reports its own models when the daemon
starts (`impl/foreignAgentModels.ts`), cached per route, with the built-in list until it answers.

`harnessAllowsSubagents` decides which harnesses an agent on one harness may start sub-agents on:
its own; else the creator's `subagent_harnesses`; else, for `happy`, only `antigravity` (models
Happy cannot run itself); else, for a foreign harness, every harness but `happy`. Collaboration's
`agent_options` tool and the `harness` input of `create_agent` and `create_subtask` read it.
`harnessUsage` reads Antigravity's quota from `agy -p /usage` (`impl/harnessUsage.ts`), at most
every five minutes per account, for `agent_options({ usage: true })` to show.

After startup, configuration renews enabled Codex and Grok session logins in the background,
then repeats three hours after each completed pass. Hidden enabled accounts are included;
disabled accounts, static API keys, smart routing aliases, Bedrock, and Claude are skipped.
The loop uses the same configured provider construction as inference, starts no inference
session, and stops with `closeProviders()`. Failures are logged without credential diagnostics
and do not disable an account or affect a running turn. The provider library shares refreshes
with inference recovery and bounds each exchange. An exchange already rotating a token may
finish saving it after shutdown cancels the maintenance observer.

Set `hidden = true` in a machine's `[providers.<id>]` table to keep a provider out of model
pickers. The default is `false`. Hiding is display-only: `isProviderEnabled` and every catalog
`enabled` value ignore it and describe only whether the account is on and routable, and
`isProviderHidden` answers the flag separately for the public config's `hidden` field. `models`
therefore still contains hidden routes, so existing sessions keep running turns and compaction on
them. `visibleModels` is the picker view: phone model lists and the model guidance in the system
prompt read it, and `isSubagentModelAllowed` rejects hidden providers for new subagents. When the
default model has no explicit provider, or no default matches, visible routes win, so a hidden
account never becomes the default by accident. Smart routing, account-quota polling, and explicit
verification are unchanged. Hiding is file-only configuration and takes effect on daemon restart;
there is no API mutation for it.

A curated model can be hidden the same way. An opt-in row, today GPT-6 Sol on Codex now that
GPT-6.1 Sol replaces it, is served but hidden on each account whose `include_models` does not name
it; a smart route is hidden unless the pool or one of its members names it. The catalog reports
`hidden` beside `enabled`, and `isModelHidden` answers it per route. Like a hidden provider, a
hidden model stays in `models` for existing sessions, never stands in as the default unless
`[defaults]` names it, and is left out of `visibleModels` and new-subagent choices unless
`include_subagent_models` names it. Bedrock keeps offering GPT-6 Sol because it does not serve
GPT-6.1 Sol.

A provider may independently narrow delegation with `include_subagent_models` and
`exclude_subagent_models`. These use the same exact model IDs and exclusion precedence as
`include_models` and `exclude_models`, but they do not change the ordinary catalog or model picker.
Collaboration applies them when it builds the model-facing creation tool and again when it validates
every new collaborator, including one started by a workflow.

When a scan first detects credentials, configuration writes `auto_enable = true` into that
provider's generated runtime table. The value remains true across later missing scans. A person may
set it to false to prevent automatic use; a provider with no `auto_enable` value receives the true
default only when credentials are newly detected. Explicit `enabled` values and API enable/disable
mutations take precedence and are persisted in the same runtime provider table.

A module that needs to reach a vendor takes this module and asks it, instead of being handed a
registry or building a second one that would sign in again. `bedrockSearchModels` answers the same
way for the models a Bedrock account serves its hosted search index from.

Execution history can identify a known native Codex account using the credential held by the actual
session. A private bounded table in `agent.sqlite` maps that principal to a random installation-local
ID shared across profiles and agents. History receives only the local ID, without a label. Tokens,
credential paths and raw principals never enter the public snapshot. The mapping survives normal
restarts and private database backups; no API, model tool or history export enumerates it. See
[`persistence/README.md`](persistence/README.md) for storage and failure behavior. Claude and API-key
accounts remain unknown because the pinned providers expose no equivalent request identity.

Every session resolved from the shared registry combines its caller's lifetime with the daemon's
provider lifetime and its provider's resettable enablement lifetime. Disabling a provider aborts
all of that provider's live inference and compaction immediately. Enabling it replaces the aborted
gate, including for sessions that were already cached. `closeProviders()` aborts the daemon-wide
lifetime before runtime shutdown starts draining agents. The decoration is provider-neutral and
preserves each concrete provider and session identity, including vendor-specific capabilities such
as image generation and Claude executable metadata.

A Bedrock account may name an AWS `profile`, including one backed by the standard
`credential_process` setting in the AWS shared config. Optional `config_file` and
`credentials_file` values select nonstandard AWS shared files. The account keeps the refreshable
AWS credential provider, so process credentials are renewed without storing returned keys in Happy Agent.
When no authentication source is named, Bedrock tries its bearer-token environment variable first
and then the ambient AWS credential chain.

Without `credential_isolation`, a Claude or Codex account also reuses a gateway set up for its
CLI. For Claude, the `env` block of `settings.json` in the Claude config directory is applied over
the daemon's environment, as Claude Code applies it. The result selects the key or token and
reaches Claude Code, including `ANTHROPIC_BASE_URL`. A Codex account that names no key, auth file,
or base URL calls the endpoint `config.toml` selects (the active `model_provider` table or
`openai_base_url`) or `OPENAI_BASE_URL`, using that endpoint's API key. A ChatGPT sign-in always
stays on its own backend. Model names are unchanged.

Kimi K3 (`moonshotai/kimi-k3`) and GLM 5.3 (`zai/glm-5.3`) are available only through Bedrock
Runtime. Both use the Runtime Chat Completions API and the account's existing AWS or bearer
credentials. The provider resolves the US or global inference profile for the selected region;
AWS account eligibility and regional availability still apply. A per-model `transport = "mantle"`
override is rejected. Both expose low, high, and max reasoning effort and a 1M context window.
Kimi defaults to high effort and uses Kimi Code's prompt and tools, including image reads.
GLM defaults to max effort and uses the published Claude Code coding harness with text-only reads.

A virtual smart provider uses `type = "smart"`, `strategy = "round_robin"`, and an ordered
`providers` array. For each exact model, the first valid concrete member establishes the provider
kind; missing providers, nested smart providers, other kinds, unsupported models, and incompatible
Bedrock regions are silently omitted. Each agent starts at a random point in the remaining list,
stays on that account across turns and provider-session recreation, and moves forward only after a
typed authentication or account-token-exhaustion failure. A failure after visible model output is
not replayed elsewhere, because doing so could duplicate output or provider-side effects. Usage is
not duplicated: vendor quotas belong to concrete accounts, while durable token records follow the
selected provider identity.

```toml
[providers.smart]
type = "smart"
strategy = "round_robin"
providers = ["codex-work", "codex-personal"]
enabled = true
```

`load` takes an `inference` override for tests, which replaces both. It belongs here rather than
where the agent starts, because a scripted account has to reach every module that names one.

### The Gemini key

Gemini is the one vendor Happy Agent reaches that is not an account a chat runs on: it answers over its own
HTTP API rather than through a configured chat provider. So it has no `[providers.gemini]` entry;
instead the user `happy.toml` carries a small `[gemini]` table whose `api_key` is the key itself.
`geminiApiKey` is a getter that answers with that configured key first, falls back to
`GEMINI_API_KEY` from the environment, trims either, and answers with nothing when the result is
missing, blank, or longer than any other configured string. The environment is read on each call,
so a key exported after startup reaches the next request; the section is a machine setting, so a
project `happy.toml` cannot set it.

It lives here for the same reason the accounts do: credentials are configuration's, and the search
and Gemini modules ask this module for the key rather than reading the file or the environment
behind its back.

### Extra skill folders

Skill discovery always scans `~/.agents/skills` and each project's `.agents/skills`. The
`[skills]` table adds folders to that: `directories` is a list of paths, each a container of skill
directories with a `SKILL.md`, exactly like the standard roots. Absolute paths are preferred, since
they mean the same thing regardless of what a relative entry would be resolved against. In the
user `happy.toml` (or the generated `runtime.toml`, which adds to it) a `~`-relative or bare
relative entry is resolved against the home folder, and `globalSkillDirectories` answers with the
resolved list. In a project's root `happy.toml` a relative entry is resolved against that project
root, which suits only folders inside the repository itself. The two lists add rather than
override: the project list is deliberately dropped from the merged machine configuration, and
`projectSkillDirectories(source)` parses one project file's list for the skills module, which reads
that file through the agent's compute so a remote or container project is read on its own machine.
A skill in a configured folder ranks below a same-named skill in the standard roots.

`addRuntimeSkillDirectory` and `removeRuntimeSkillDirectory` change the `runtime.toml` list live,
under the runtime lock. `userSkillDirectories` and `runtimeSkillDirectories` report each layer
separately, and `globalSkillDirectories` merges them again every time it is read.

## What else this module answers

The same reasoning applies to anything else whose location or policy the configuration already
settles. A module asks for the answer instead of being handed the path it would have read:

- `readGlobalInstructions(ctx, maxBytes)` — the person's own instructions, the ones that apply to
  every project, read fresh from `paths.instructionsPath` and bounded to `maxBytes`. A file that is
  not there is an absent document rather than a failure.
- `readGlobalSecurity(ctx, maxBytes)` / `readProjectSecurity(ctx, maxBytes)` — the two security
  policies an automatic permission review judges against, read fresh from `paths.securityPath` and
  from `AGENTS_SECURITY.md` at the root of `paths.publicHome`, each bounded to `maxBytes`. Reading
  on every call is what makes a policy edited mid-session take effect on the next decision. A file
  that is not there is an absent policy; any other read failure is raised, so a caller can refuse
  to judge against a policy it could only read half of.
- `workspacesHome` — the folder managed workspaces are created under, `HAPPY_AGENT_WORKSPACES_DIRECTORY`
  when it names an absolute path and `~/Happy/Workspaces` (`~/happy/workspaces` off macOS)
  otherwise.
- `execution` — the Linux users agent work runs as, from `[execution]` in machine `happy.toml`:
  the default `user`, the `executable` sudo starts as each user's runner (the running binary
  unless set), and `bots`, each bot ID's own user. Undefined when work runs as the daemon's user.
  User names are strict Linux names and never `root`, and the table is refused beside
  `[runners]` and on Windows.
- `workspaceSettings` — what a workspace folder does when it says nothing itself: what to sync,
  what to protect, what to run on setup, and what archiving leaves on disk.

Unknown TOML keys are ignored and retained in each source's `unknownSettings`
list. `unknownSettingsTruncated` explicitly reports bounded metadata.
Malformed TOML, invalid known values, inconsistent provider types, oversized
files, and unbounded tables fail loading.
