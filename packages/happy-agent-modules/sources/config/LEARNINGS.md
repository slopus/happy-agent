# Config module learnings

## Claude Code runs in a private empty folder

Claude providers never named a working directory, so Claude Code ran wherever the daemon was
started: `/` for Happy.app launched from Finder. It read across the disk on startup and made
macOS ask whether Happy could access other apps' data, and the model was told it worked in `/`.
Configuration now owns `claudeWorkingDirectory`, `agent/claude-cwd` under the Happy home, and
hands it to every Claude provider. Rig runs every tool itself, so the folder stays empty and is
not a Git repository. The folder is created private when missing; providers are rebuilt for each
session and securing a folder on Windows starts PowerShell, so an existing folder is reused as is.

## Kimi K3 and GLM 5.3 are Bedrock Runtime routes

AWS documents Kimi K3 and GLM 5.3 on the Runtime Chat Completions API. Their curated entries
use the canonical IDs `moonshotai/kimi-k3` and `zai/glm-5.3`; the provider resolves the US or
global inference profile while preserving explicit region and endpoint overrides. A forced
Mantle override hides that route and fails visibly if requested directly. Both offer only
low, high, and max effort. Kimi defaults to its coding harness's high effort; GLM defaults
to the API's max effort. Their 1M windows compact at 850k: Kimi's published strategy triggers
at 85%, and the same threshold leaves GLM room for its documented 128k output and a summary.
They remain absent from native Codex, Claude, and Grok catalogs.

## Inference speed preserves the provider tier

Configuration supplies each account/model's complete ordered speed menu with explicit IDs and
English labels after applying eligibility. Regular carries `null`, Fast carries `priority`, and
Ultrafast carries `ultrafast`; a newly curated tier needs its own configured label. The API forwards
the menu on every provider model reference so shared definitions cannot restore an unavailable
account choice. Clients render and submit the supplied choices unchanged instead of understanding
provider tier names.

Regular, Fast, and Ultrafast are distinct choices: Regular clears the tier, Fast sends
`priority`, and Ultrafast sends `ultrafast`. Configuration accepts the Ultrafast preference;
clients must preserve it rather than converting every non-default tier to Fast. Advertise a
native model's new tier only after the pinned provider release can execute it. Successful
inference alone does not prove Ultrafast. ChatGPT can report the default tier even for
server-routed Fast requests, so report the requested route and backend label separately instead
of treating that label as proof of either Ultrafast execution or fallback.

Ultrafast is an authenticated account/model capability, not a static property of every Codex
model. Configuration keeps the model list curated and asks the native provider only for tier
metadata for those known IDs. Each concrete account has a five-minute eligibility cache, refreshed
off the inference path and invalidated by credential-file changes, account changes, failures,
disablement, or shutdown. Unknown accounts and smart aliases do not advertise Ultrafast. Regular
and Fast keep their existing behavior. Connected clients receive the existing configuration-change
event when eligibility changes; unchanged proactive refreshes do not reset their selection.
Every Ultrafast inference rechecks the local account identity, including restored saved choices,
and rejects unsupported choices visibly rather than silently executing a differently priced tier.

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

The daemon derives its public folder beside `HAPPY_HOME_DIR`; no environment variable overrides
the configuration directory. Deployment recipes and daemon tests must write the actual derived
config path.

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

The Claude provider turns effort `off` into a disabled-thinking request. Opus 5.5 and Sonnet 5.5
reject that with a 400, so their catalog entries use the ladder without `off`; offering it would
turn a picker choice into a failed turn. Their Claude Code SDK wire IDs carry the `[1m]` suffix
for the same reason Fable 5.1 does: an SDK that accepts a model without knowing its window lets
its continuation guard assume 200k. Bedrock serves Opus 5.5 on both endpoints through the same
us, eu, jp, au, and global profiles as Opus 5.

## Reseller catalogs are explicit subsets

Adding a model to its native provider must not automatically advertise it through a reseller.
Keep the Bedrock catalog limited to models AWS currently documents, and add a reseller route only
after its model ID and wire behavior are known. A native Codex model can otherwise appear usable
through Bedrock even though AWS does not serve it. The Bedrock catalog used to copy every non-Grok
native entry, so the rule held only by convention; it is now an explicit list of resold model IDs.
GPT-6.1 Sol showed why: Codex lists it, but AWS documents no GPT-6.1 model and Codex's own Bedrock
catalog omits it, so it stays off Bedrock until AWS documents its Bedrock model ID. Bedrock
still serves GPT through GPT-6 Astra, Sol, and Luna, the GPT-5.6 family, and GPT-5.4.

Sonnet 5 uses `anthropic.claude-sonnet-5` on Mantle, but AWS documents in-region
availability only in N. Virginia, GovCloud West, Stockholm, Ireland, and Melbourne.
Oregon returned model-not-found despite having the correct ID. Both ordinary and smart-route
catalogs now respect the selected transport and per-model region override; the private reviewer
catalog must not re-add a Bedrock Sonnet route configuration omitted. Runtime overrides retain
their existing inference-profile routing; catalog filtering never silently changes regions.

Sonnet 5.5 launched with Mantle only in GovCloud West and Runtime only through the global
profile, so, like Fable 5.1, it defaults to Runtime rather than to a Mantle route that would hide
it in every commercial region. The same documented-region table limits a forced Mantle route.

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

## Provider hiding is display-only

Hiding once also closed direct selection: the catalog folded `hidden` into `enabled`, and new turns
were refused. When a user hid their Codex accounts behind a pool, every session already on those
accounts stopped working. `hidden` is now display-only. `enabled` means only that the account is on
and routable; `GET /v0/config` reports `hidden` as its own field, so clients filter pickers on it.
Messages, turns, and compaction on a hidden provider are accepted, the daemon still keeps hidden
providers out of model guidance and new-subagent choices, and an unpinned default never falls back
to a hidden route. Removing an account means deleting it from the configuration; disabling it stops
routed inference too. Hiding stays file-only, with no mutation. Quota readings remain
account-specific; duplicate consumed-token attribution under both smart and concrete providers is
not implemented.

Scripted inference must replace concrete accounts, not smart routing itself. Factories receive
enabled hidden accounts as well as their visible smart routes; configuration rebuilds the real
router over the substituted concrete registry so gym tests exercise selection and cancellation.

## Voice freezes the configured default pool onto one account

Voice previously rejected smart default providers, so enabling a pool could make an otherwise
configured installation unable to start voice. Configuration now asks the router to choose one
enabled compatible account at call startup, resolves it through the regular provider registry,
and preserves the default model and effort. Live holds that concrete route and its pool/account
lifetimes, so pool or account disablement and daemon shutdown still cancel it while credential
failures never trigger account failover.
The voice transport's explicit credential selection remains independent of the text controller.
Selecting a pool as that credential is invalid, even when it has Codex compatibility. Configuration
throws a dedicated fixed-message error for that proven selection, allowing Live to explain it
without forwarding arbitrary credential-loading diagnostics or trying a different account.

## Extra skill folders are a plain list in `[skills]`

The user asked for extra skill folders and found nothing: discovery hardcoded `~/.agents/skills`
and each project's `.agents/skills`. `[skills] directories` now lists more folders in the user
`happy.toml` (resolved against home) and in a project root `happy.toml` (resolved against that
project). The two lists add together instead of the project one replacing the machine one, so the
project entry is dropped from the merged machine values and parsed separately for the skills
module. Machine folders are scanned only on the daemon's native filesystem, since they name paths
on this machine; project folders are read through the agent's compute. Configured folders rank
below the standard roots for a same-named skill.

## Smart runtime overrides preserve account routes on restart

The daemon persists smart provider enablement as a partial runtime table containing its type
and automatic enablement. Normalization previously emitted an undefined `providers` property
for that table, overwriting the valid global account list and preventing configuration loading
on the next restart or update. Omitted route fields must stay omitted so layer merging retains
lower-priority accounts. Test the actual runtime writer followed by repeated configuration loads;
valid existing runtime files must load without a migration or user configuration rewrite.
