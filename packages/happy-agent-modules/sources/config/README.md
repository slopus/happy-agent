# Config module

`ConfigModule` is the first module loaded by a Happy Agent host. It resolves
one `.happy` root, reads the global, project, and private runtime TOML layers,
and exposes one deeply frozen snapshot.

```text
<parent>/
├── .happy/
│   └── agent/
│       ├── agent.sqlite
│       └── runtime.toml
└── Happy/
    └── Config/
        ├── happy.toml
        ├── AGENTS.md
        └── SECURITY.md
```

The project layer is `happy.toml` in the current working directory. Project
machine settings (credentials, provider
selection, daemon settings, permission mode, and observation) are filtered
before merging. Precedence is global → project → runtime.

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

When a scan first detects credentials, configuration writes `auto_enable = true` into that
provider's generated runtime table. The value remains true across later missing scans. A person may
set it to false to prevent automatic use; a provider with no `auto_enable` value receives the true
default only when credentials are newly detected. Explicit `enabled` values and API enable/disable
mutations take precedence and are persisted in the same runtime provider table.

A module that needs to reach a vendor takes this module and asks it, instead of being handed a
registry or building a second one that would sign in again. `bedrockSearchModels` answers the same
way for the models a Bedrock account serves its hosted search index from.

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

`load` takes an `inference` override for tests, which replaces both. It belongs here rather than
where the agent starts, because a scripted account has to reach every module that names one.

### The Gemini key

Gemini is the one vendor Happy Agent reaches that is not an account a chat runs on: it answers over its own
HTTP API rather than through a configured chat provider. So it has no `[providers.gemini]` entry, no
TOML section of its own, and nothing was added to the configuration schema for it. `geminiApiKey` is
a getter that reads `GEMINI_API_KEY` from the environment, trims it, and answers with nothing when
it is missing, blank, or longer than any other configured string. It is read on each call, so a key
exported after startup reaches the next request.

It lives here for the same reason the accounts do: credentials are configuration's, and the search
and Gemini modules ask this module for the key rather than reading the environment behind its back.
If a person ever wants to write the key down instead of exporting it, this getter is the one place
that has to learn a second source.

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
- `workspaceSettings` — what a workspace folder does when it says nothing itself: what to sync,
  what to protect, what to run on setup, and what archiving leaves on disk.

Unknown TOML keys are ignored and retained in each source's `unknownSettings`
list. `unknownSettingsTruncated` explicitly reports bounded metadata.
Malformed TOML, invalid known values, inconsistent provider types, oversized
files, and unbounded tables fail loading.
