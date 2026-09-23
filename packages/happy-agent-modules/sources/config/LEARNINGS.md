# Config module learnings

## Idle credential maintenance excludes Claude

Refreshing only when inference needs a credential leaves idle Codex and Grok accounts unattended.
Configuration now renews enabled session logins after startup and every three hours, including
hidden accounts, without starting inference. Claude is deliberately excluded: its SDK retains
ownership of refresh. Static API keys, disabled accounts, and smart aliases are also skipped.
Refresh failures are advisory and never change account enablement; the shared provider library
owns rotation coordination and network bounds so background work cannot spend the same refresh
token concurrently with another session in this process.

## GitHub CLI discovery is request-bound

Imports previously saw only exported tokens. An explicit standalone-owner import can now read
an existing `gh` login with bounded time/output and trusted installation paths. Present environment
tokens win even when blank or invalid; discovery never switches accounts, logs diagnostics, or
persists tokens. Tokens go only to the project-scoped in-memory broker. Team and foreign creators
cannot discover the host login, and background recovery after restart never performs CLI lookup.

## Ambient Codex accounts include their selected native provider

Reusing only `~/.codex/auth.json` while ignoring `model_provider` sent a custom provider's bearer
token to OpenAI's default endpoint, where it failed as an invalid OpenAI API key. An ambient Codex
account now reads the selected provider from `$CODEX_HOME/config.toml` or `~/.codex/config.toml` and
keeps its endpoint, Responses wire protocol, and optional experimental bearer token together.
Explicit Happy credentials still win, an explicit Happy endpoint replaces native provider
selection, and credential isolation disables the native lookup. A custom host without its own
token receives ambient OpenAI authentication only when its Codex record explicitly sets
`requires_openai_auth = true`, so provider discovery cannot silently disclose a credential to an
untrusted host.

## Node display identity is not P2P identity

Reusing `p2p.name` for the daemon's display name conflates separate identities. The Happy Agent
installation's name and avatar belong to `config.node`, independently of P2P configuration,
connection-roster labels, conversation agents, and the human profile. Bootstrap already includes
config, so a separate node snapshot, version, and event are unnecessary. Use `PATCH /v0/config`
for the name and `config.updated` for name or avatar changes; keep only image bytes on a separate
endpoint. Avatar presence is represented only by `avatar: { thumbhash } | null`; a separate boolean
duplicates that fact and permits contradictory states. This is unrelated to online/away availability.

## Configuration paths follow the platform's casing

The runtime rewrite hardcoded `Happy/Config` everywhere, silently ignoring the documented
`happy/config` directory on case-sensitive Linux filesystems. Configuration now uses `Happy/Config`
on macOS and `happy/config` elsewhere, beside the private `.happy` root. Loading and startup file
creation share these paths for settings, MCP, global instructions, and security. Tests must seed
the target platform's directory; private `.happy/agent` state remains unchanged. Existing uppercase
Linux configuration is not automatically moved or used as a fallback.

The daemon derives its public folder beside `HAPPY_HOME_DIR`; it does not honor the terminal-only
`HAPPY_TERMINAL_CONFIGURATION_DIRECTORY` override. Deployment recipes and daemon tests must write
the actual derived config path instead of setting an environment variable the daemon ignores.

## Standalone profile bootstrap is machine configuration

Remote onboarding should reuse the local person's name and email through `[profile]` records in
global `happy.toml`, not an HTTP profile mutation or a skip-onboarding flag. Both fields must be
valid when configured. Project configuration cannot choose an installation's identity, and team
mode rejects a shared standalone profile. The profile module consumes these records on startup
to fill missing fields without overwriting later edits.

## Claude 1M models compact at 400k, not at Claude Code's default

Claude Code's own default compacts at the model window minus a 20k response reservation and a 13k
summary buffer, so 967k on a 1M model. Matching that was considered and rejected: the Claude Code
team recommends 400k as the compromise between task depth and context pollution, replayed sessions
show 300k to 400k halving re-read tokens at the same wall-clock time, and Opus measurably degrades
on task-related context beyond that range. Going much lower is also wrong, because each compaction
loses roughly half of the user's stated constraints. The 1M Claude entries therefore compact at
400k. Rig measures context the way Claude Code does (input plus cache read plus cache write, plus
the response), so the numbers are comparable.

The threshold was never the source of user confusion. The terminal reported context remaining
against the full window, while Claude Code counts down to the compaction trigger, so any threshold
below the window made the display and the compaction disagree. The catalog therefore publishes
`autoCompactWindow` beside `contextWindow` on every route, including scripted ones, and the API
model definition carries it so clients count down to the point where compaction actually fires.

## Always-on thinking models do not offer the off effort

The Claude provider turns effort `off` into a disabled-thinking request. Opus 5.5 rejects that
with a 400, so its catalog entry uses the ladder without `off`; offering it would turn a picker
choice into a failed turn. Its Claude Code SDK wire ID carries the `[1m]` suffix for the same
reason Fable 5.1 does: the pinned SDK accepts the model but does not know its window, so without
the suffix its continuation guard assumes 200k. Bedrock serves it on both endpoints through the
same us, eu, jp, au, and global profiles as Opus 5.

## Reseller catalogs are explicit subsets

Adding a model to its native provider must not automatically advertise it through a reseller.
Keep the Bedrock catalog limited to models AWS currently documents, and add a reseller route only
after its model ID and wire behavior are known. A native Codex model can otherwise appear usable
through Bedrock even though AWS does not serve it.

Sonnet 5 uses `anthropic.claude-sonnet-5` on Mantle, but AWS documents in-region
availability only in N. Virginia, GovCloud West, Stockholm, Ireland, and Melbourne.
Oregon returned model-not-found despite having the correct ID. Both ordinary and smart-route
catalogs now respect the selected transport and per-model region override; the private reviewer
catalog must not re-add a Bedrock Sonnet route configuration omitted. Runtime overrides retain
their existing inference-profile routing; catalog filtering never silently changes regions.

## Tailcat exposure is an explicit machine setting

`[feature.tailcat] enabled = true` asks the Tailcat module to expose whichever API transport the
daemon attaches. A repository cannot turn it on. Configuration owns the private Tailcat home,
fixed-region identity key, live address, and live port paths under the agent home; the key survives
restarts while the address and port files exist only while the tunnel is open. Admin-bot live
mutations persist the same setting in generated `runtime.toml`, which outranks the global default.
Tailcat is a dedicated account-free transport, not a Tailscale access path. It does not remove
Happy API authentication.

The forwarded port is deterministic configuration, defaulting to the IANA-unassigned `24779`.
Only the global or generated runtime layer may override it, and zero is invalid: the module must
fail on a collision rather than silently changing the endpoint another node has stored.

## Team mode is machine-scoped and owns a separate network identity boundary

`[feature.team] enabled = true` is a global or runtime deployment choice, never a project choice.
The default remains standalone mode. A team deployment does not create or retain the private local
API bearer token. It listens on its configured TCP `host` and `port` and authenticates WorkOS
access tokens against one required WorkOS organization rather than inheriting the single-user local
credential. The WorkOS client ID is also machine-scoped: it defaults to production Happy Cloud but
remains configurable for staging and other deployments, with issuer and JWKS locations derived
from it. Team mode also requires the WorkOS owner user ID; owner status is derived from that value
when profile onboarding creates the local user.

## Managed remote connections are machine settings

The main daemon's remote roster comes from machine `[connections.<id>]` entries and active admin
bot tools. Project configuration cannot grant a remote API authority or set `[api] token`. Each
runtime connection replaces its whole global entry, so switching authentication cannot accidentally
retain an old token. A disabled runtime entry suppresses its global entry without changing remote
data. Standalone deployments may pin their socket bearer token; team deployments continue to use
WorkOS and reject a standalone token setting.

Launcher readiness requests must use the configured standalone token immediately. Creating a
random token first and rereading the file only after readiness deadlocked startup: the daemon
installed the fixed token, rejected the launcher's health requests, and was killed as unready.

## Cross-workspace work is available by default

Fresh installations enable `features.cross_workspace` by default so root agents can discover the
project catalog and message another existing agent when its unguessable Agent ID is shared. A user
who wants the narrower boundary can explicitly set `cross_workspace = false`; generated starter
configuration shows the default as `true`.

## Generated runtime configuration owns runtime state

Treating `runtime.toml` as user-authored and placing daemon mutations in a sidecar state file was
wrong. The daemon always generates `runtime.toml`, rewrites known values canonically, and persists
runtime settings there atomically. Comments and unknown fields do not need preservation.

Provider runtime state uses `auto_enable` for automatic scan enablement and `enabled` for an
explicit override. Provider tables merge field-by-field across configuration layers so writing
those runtime fields cannot erase credentials, endpoints, or model filters configured globally.

## Scripted providers own their complete catalog

A test-supplied inference override replaces both accounts and their model catalogs. Runtime state
may persist a scripted provider's compatibility protocol (for example, `gym` as `codex`), but that
must not add the protocol's curated production models to the scripted provider after a restart.
For every provider ID represented by scripted models, expose exactly those scripted routes. A
test fixture that disables providers globally must explicitly enable every scripted provider it
needs. Test infrastructure must not change the production meaning of the global provider default.

## Gemini has a config key without a provider entry

Requiring `GEMINI_API_KEY` in the daemon environment was the only way to enable the Gemini media
and search tools, which made the key awkward to keep with the rest of the machine's settings. The
user `happy.toml` now accepts `[gemini] api_key`, and `ConfigModule.geminiApiKey` prefers that
configured value over the environment variable. Gemini stays out of `[providers.*]` because it
powers tools rather than chat models, and the section is a machine setting: a project `happy.toml`
cannot set it, since a repository must not choose which account this installation bills against.

## MCP has dedicated global and workspace sources

Combining MCP records into `happy.toml` made MCP look configured while provider and runtime wiring
could disagree about discovery. MCP now comes from dedicated files: `~/Happy/Config/mcp.toml` for
the user's catalog and root `mcp.toml` for a workspace catalog. Runtime, Codex, Claude, and other
provider MCP settings do not enter the Happy MCP catalog. The config module owns parsing, bounded
validation, the global path, and atomic global one-server updates, while the MCP module owns live
clients, workspace demand, sharing, and reconciliation.

## Smart routing is a virtual provider with concrete accounting

A smart provider keeps the agent's configured provider identity stable while delegating each
exact-model session to one compatible concrete account. The random starting choice and failed
accounts are held per agent; authentication and account-token exhaustion advance the route, while
other failures remain terminal. Candidate validation is deliberately silent, Bedrock routing fails
closed across unknown or different regions, and usage remains attributed to concrete providers.

## Subagent filters do not change ordinary availability

Provider-level `include_subagent_models` and `exclude_subagent_models` use exact model IDs and the
same exclusion precedence as the ordinary model filters, but they are a separate delegation policy.
They must leave the model catalog and picker unchanged. Collaboration asks configuration about each
provider/model route when describing and validating new subagents, including workflow-created ones.

## Provider hiding is file configuration, not an API field

Treating `hidden` as account disablement was wrong: it disables direct selection only. An enabled
hidden account remains usable behind a smart provider, and continues account-quota polling and
explicit verification. `hidden = true` belongs in the machine provider table, not in a new API field
or mutation. The public catalog keeps its provider/model references with direct availability false,
and new turns, subagents, and direct internal inference cannot select that ID. Smart routing uses
the independent account-enabled gate, including cancellation when the account is disabled.
Scans and runtime enable overrides never unhide it. Removing hiding and restarting restores direct
selection subject to the saved enablement preference. Quota readings remain account-specific;
duplicate consumed-token attribution under both smart and concrete providers is not implemented.

Scripted inference must replace concrete accounts, not smart routing itself. Factories receive
enabled hidden accounts as well as their visible smart routes; configuration rebuilds the real
router over the substituted concrete registry so gym tests exercise selection and cancellation.

## Extra skill folders are a plain list in `[skills]`

The user asked for extra skill folders and found nothing: discovery hardcoded `~/.agents/skills`
and each project's `.agents/skills`. `[skills] directories` now lists more folders in the user
`happy.toml` (resolved against home) and in a project root `happy.toml` (resolved against that
project). The two lists add together instead of the project one replacing the machine one, so the
project entry is dropped from the merged machine values and parsed separately for the skills
module. Machine folders are scanned only on the daemon's native filesystem, since they name paths
on this machine; project folders are read through the agent's compute. Configured folders rank
below the standard roots for a same-named skill.
