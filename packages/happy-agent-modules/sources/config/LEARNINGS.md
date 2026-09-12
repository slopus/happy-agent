# Config module learnings

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
