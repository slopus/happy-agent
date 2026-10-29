# Config module learnings

## Terra uses its published Codex subscription profile

GPT-6.1 Terra initially copied historical Terra limits without published evidence. OpenAI's Codex
catalog now supplies its actual subscription profile: a 500k default window, low default effort,
and priority Fast at 1.5x speed. The native catalog and CLI fallback use those values; the normal
90% Codex compaction threshold is 450k. Codex's optional 872k maximum and the OpenAI API's larger
window do not replace the subscription default. Keep provenance beside curated model data and
check the upstream entry before adding or changing a model rather than inferring from its name.

## Selectable catalogs follow generations

Model size used to outrank generation in Claude's catalog, and GPT-5.6 remained selectable after
GPT-6 and GPT-6.1 arrived. Curated catalogs now put each vendor's newer generations first and
exclude GPT-5.6. Reported Codex CLI models follow the same rule before a person's explicit
`include_models` order is applied. Provider support and context metadata for historical GPT-5.6
conversations remain available; retirement changes current choices and defaults.

## Superseded models are opt-in, not removed

The user asked to drop GPT-6 Sol from the models Happy offers once GPT-6.1 Sol replaced it, unless
a person overrides that in their settings. Deleting the catalog row, as GPT-5.6 was retired, or
excluding it would disable the route, and conversations already on it would stop working. The
Codex row is now opt-in: it stays enabled and routable but is `hidden`, like a hidden provider, so
pickers, the default stand-in, and new-subagent choices skip it. Naming it in the account's
`include_models` offers it again; an explicit `[defaults]` model or `include_subagent_models` entry
is honored as the person's own choice. Bedrock keeps offering GPT-6 Sol because it does not serve
GPT-6.1 Sol, so opt-in applies only where the successor exists.

## Credential selectors must leave provider diagnostics before shared consumers see them

Credential-source paths, configuration keys, environment variable names, and host labels used to
survive in provider error prose even when structured diagnostics were withheld. Configuration now
captures the exact inputs consulted during concrete credential construction and protects every
production session, including smart-route candidates, naming, and other background inference.
Discovery, session construction, run, and compaction failures use that snapshot; they never infer
sources from prose or look up current configuration after a failure. This happens before history,
settlement, collaboration reports, workflow errors, or exported-bot durable reply work copies the
text, so outbound consumers do not need parallel sanitizers.

Only diagnostic text is changed. Longest-first exact matches require identifier boundaries;
ordinary assistant text, tool arguments, results, machine classifications, and retry semantics
remain untouched. Unrelated exceptions retain their identity. Changed exceptions preserve their
prototype, classification fields, own properties, and bounded causes without mutating the original.
The concrete provider also retains its identity for native account, quota, and live checks.

The snapshot also includes exact configured credential values and the default native login
directory derived from the selected home. Removing only configuration keys or a full auth-file
path left echoed values and directory-only errors exposed. These values remain private sanitizer
inputs, never structured source descriptors.

Native providers currently construct fresh sessions. A caching adapter must still be safe:
equal string sets and source descriptors preserve one decoration and its attribution; differing
snapshots combine sanitization and permanently invalidate that shared session's attribution.
The bounded union never drops old strings: overflow replaces the entire diagnostic with safe
generic text. Per-session state is weakly held and contains no provider or execution context.

## A missing or rejected sign-in is a typed failure with one short sentence

A provider with no credential used to throw `Claude authentication is unavailable for provider
"claude".`; the owner was told to retry and then ask "the person who manages this installation",
retrying always failed, and parent agents saw only that first sentence. Construction now throws
`ProviderCredentialsUnavailableError`, whose text is the one line every reader gets: "Claude Code
isn't signed in. Run claude auth login, then retry." for the vendor's own default login (likewise
`codex login`, `grok login`), and "{label} has no credentials. Check its settings, then retry." for
a configured, isolated, custom-directory, or Bedrock source. API.md allows naming the vendor's own
sign-in command in shared text; credential paths, keys, variables and hosts stay out.

History turns it into the typed `signin_missing` failure (`provider`, `product`, `command`). A 401
after a loaded token takes the same path: the observed attempt carries the selection-time
`signIn`, so the failure names the command only for a default native login. Agent Base reports an
opening failure only as text, so Configuration remembers the exact text it raised per provider —
cleared on the next successful construction, forgotten after fifteen minutes, matched only for the
selected provider or the accounts its smart alias routes to, because two default logins of one
vendor raise the same sentence. Scans and smart routing recognize the error by type.

The legacy owner-only `error.recovery` stays for older clients, reduced to one step. A default
native login says to sign in first rather than "retry first", as API.md now requires. Not signed
in and an unreadable macOS keychain still look identical here, because Claude Code's loader returns
nothing for both.

## Execution provenance belongs to one actual operation

A provider session can outlive many runs, so a session-level last-account value is not evidence
about the current failure. Config observes concrete native and scripted session entry points in
place, capturing an operation handle before inference or compaction begins. Late events use only
that handle. Naming, verification, and permission-review sessions cannot claim a foreground
operation, and compaction has a separate claim kind. Settlement, abort, overlap, expiry and bounds
invalidate the whole observation rather than retaining an earlier source as if it were terminal.

Observations retain at most 512 operations for fifteen minutes from begin, with at most 64 actual
attempts each. Snapshots are copied, bounded and frozen; no credential, provider, session, or
context enters the store. Source descriptors come from successful credential selection, not error
prose or a later configuration read. Default native Claude alone receives the copyable login
command; default native Codex and Grok name `codex login` and `grok login` in their steps only.
Configured tokens, environment overrides and custom directories get their own guidance.
Unknown native account identity stays null, and scripted providers do not manufacture native
family or account provenance.

The current attempt is captured at native `run` entry, separately from finalized observations.
This lets streaming consumers attribute the first block before completion without changing
`read()`'s terminal-only contract. A concrete terminal is finalized before a router can start its
next account. Provider-owned transport retries remain inside the same native call and observation;
their internal HTTP requests do not invent additional source snapshots.

Observation decorates a provider instance once per process. Reusing an injected provider across
runtimes leaves it bound to the first observation store; the new runtime reads its own store and
fails closed to unknown provenance. Native factories create fresh providers. Gym restarts must do
the same while preserving script progress, rather than carrying decorated provider instances into
another runtime or rebinding production observation state.

## Gateway setups are read where the native CLI keeps them

People who reach Claude or OpenAI through a gateway or proxy configure the CLI and never sign in.
Rig ignored those setups. Claude's exported `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` were
never read, because the loaders were called without an environment. `~/.claude/settings.json` was
never read either, since Claude Code runs with no setting sources. Codex ignored `config.toml` and
`OPENAI_BASE_URL`. So onboarding reported no credentials, or verified against the vendor's own
endpoint.

For an ambient Claude provider (no `credential_isolation`), Rig now applies the `env` block of
`settings.json` in the selected Claude config directory over the inherited environment. This is
the same order Claude Code uses (`Object.assign(process.env, settings.env)`). That environment
selects the credential and is handed to Claude Code, so `ANTHROPIC_BASE_URL` and headers reach
the gateway. A key or token from Claude Code's settings outranks the sign-in. A key or token
exported in the shell outranks the sign-in only when the environment also names a non-default
`ANTHROPIC_BASE_URL`. Otherwise it is used only when there is no sign-in, because people export
those variables for unrelated tooling and the key bills separately from the subscription.

An ambient Codex provider that names no `api_key`, `auth_file`, or `base_url` reuses the endpoint
Codex is configured for. That is the active profile's or the top-level `model_provider` table
(`base_url`, then `env_key`, `experimental_bearer_token`, or OpenAI auth when
`requires_openai_auth` is set), or the built-in provider's `openai_base_url`, then
`OPENAI_BASE_URL`. Only an API key is sent to such an endpoint. A ChatGPT sign-in keeps its own
backend, and a custom provider without its own key is missing rather than borrowing the sign-in.
Tables Rig cannot speak are ignored: no `base_url`, a `wire_api` other than `responses`, or a
reserved built-in name. A detected endpoint uses SSE unless the provider declares
`supports_websockets`. Codex falls back from WebSocket itself, but a verification probe makes one
attempt.

Model names are unchanged: a custom endpoint is often a pass-through proxy serving the normal
models. Claude Code's `ANTHROPIC_DEFAULT_*_MODEL` overrides only remap the family aliases. Rig
sends full model IDs, so the CLI itself would not remap them either.

## Native Codex account history uses the execution credential and a private local identity

Native accounts previously always appeared unknown, so signing into another account behind the same
provider profile produced no account-change history. Config now copies the known principal from the
actual `CodexSessionCredential` at operation entry, before awaiting storage. That same credential
supplies Codex's HTTP and WebSocket account header; its recovery refuses a different known account.
The public snapshot contains only a random installation-local ID. A private, transactional table
maps exact Codex principals to those IDs across profiles, agents, token refresh and restarts. It
retains at most 4,096 identities without eviction: existing IDs remain stable when full, and unseen
accounts become unknown. Unknown, invalid, storage-free, API-key and Claude identities remain
unknown; neither aliases nor a later login-file read establish identity.
If local identity storage fails before compaction dispatch, the observer releases that operation's
claim immediately. Direct factory callers have no daemon settlement hook to clear a stale claim.

Native token refresh also replaces the concrete session's credential. Selection-time redaction
alone missed an upstream error echoing that new token. The existing bounded diagnostic sanitizer
now includes the actual session's current principal and access token when projecting diagnostic
errors, retries and exceptions, including compaction. These private inputs never update the frozen
execution account and never filter ordinary model output or tool payloads.

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

## OpenAI-compatible endpoints are configuration

Every OpenAI-speaking vendor used to need a new provider type. `type = "openai_compatible"` now
covers them with one table: `base_url`, a key through `api_key_env` (or `api_key`), and the exact
`models` list. The model list is never discovered. After startup the daemon reads the vendor's
`/models` in the background, only to fill in each listed model's name, context window, image
input, and efforts. It caches the result under `agent/openai-compatible/<id>/models.json`, and
`model_overrides` wins field by field. Until that answer arrives, the defaults are a 128k window,
text-only input, and no effort sent. `request` passes vendor extras such as OpenRouter's
`reasoning = { enabled = true }` through verbatim. Protocol-owned fields are refused.

A gateway model ID is not a native model: `openai/...` on OpenRouter is not Codex, and Chat
Completions cannot carry Codex's grammar tools. The `openai_compatible` provider kind therefore
outranks the model ID. These models get Claude Code's lean prompt, its function tools with a
text-only reader, and its compaction contract, which is GLM's surface. A model switch on them
always starts a fresh context.

Only chat models belong here. The user ruled out decision models, such as GPT-6 Luna Decisions,
which answer typed questions but cannot hold a conversation. They are not configured and there
is no tool for them. Prices from `/models` are not used either, because API.md keeps run cost
provider-reported and never derived from a local table.

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

## Git authentication belongs to Git

Configuration no longer discovers GitHub CLI logins or interprets GitHub token environment
variables. Clones and foreground Git use the authentication configured on the machine running
Git. Generic user-managed secrets remain available through explicit command selection.

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

The advertised port is deterministic configuration, defaulting to the IANA-unassigned `24779`.
Only the global or generated runtime layer may override it, and zero is invalid: the module must
never change the endpoint another node has stored. It binds no local port for it, so a collision
with another program cannot happen.

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
could disagree about discovery. MCP now comes from dedicated files: user-wide `mcp.toml` in
`~/Happy/Config` on macOS or `~/happy/config` on Linux and Windows, and root `mcp.toml` for a
workspace catalog. Runtime, Codex, Claude, and other
provider MCP settings do not enter the Happy MCP catalog. The config module owns parsing, bounded
validation, the global path, and atomic global one-server updates, while the MCP module owns live
clients, workspace demand, sharing, and reconciliation.

## Smart routing is a virtual provider with concrete accounting

A smart provider keeps the agent's configured provider identity stable while delegating each
exact-model session to one compatible concrete account. The random starting choice and failed
accounts are held per agent; authentication and account-token exhaustion advance the route, while
other failures remain terminal. Candidate validation is deliberately silent, Bedrock routing fails
closed across unknown or different regions, and usage remains attributed to concrete providers.

Failed accounts used to remain excluded for the agent's entire lifetime, so even a new human
submission after credential recovery returned the cached failure without inference. A committed
message with explicit human provenance now clears that turn's exclusions and terminal failure,
while retaining the most recently selected account rather than choosing randomly again. After
exhaustion, that is the last account attempted. Session recreation, automatic continuation, unmarked
user-role messages, and duplicate delivery of the same accepted message do not reset failures.
Candidate attempts remain bounded, and routing still cannot replay after visible output.

An exhausted pool used to report whichever account it tried last. With one account signed out and
the other spent, the same chat said "no account, resets in 5 days" on one turn and "isn't signed
in" on the next, depending only on rotation order, and the first hid the fix that works now. When
every account has failed and any of them rejected its sign-in, the route now reports that sign-in
failure and names its account (`failedAccount`), so History describes that account's attempt. A
pool ending on a sign-in is not spent; only an all-spent pool waits for a reset.

A client could not tell which account of a pool was broken: `GET /v0/config` gave a smart
provider only its members' type. Kirill approved three additive API fields. `smartProviderPool`
gives each smart entry its `pool`, with the strategy and the routable members in configured order,
hidden and disabled ones included. The router keeps each set-aside account's failure, so
`routeFailedAccounts` lists them in configured order for a spent pool's `members`, leaving out
accounts turned off since. Every concrete account's sign-in evidence also reaches
`onProviderSignIn`: a missing credential at construction, a typed authentication failure, or a
completed or usage-spent response. ProviderUsage turns that into the account's `signIn`.

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

## Voice freezes its configured controller onto one account

Voice previously rejected smart default providers, so enabling a pool could make an otherwise
configured installation unable to start voice. Configuration now asks the router to choose one
enabled compatible account at call startup and resolves it through the regular provider registry.
The model comes from the `[voice]` settings, defaulting to GPT-6.1 Sol at low effort (or the
model's default when it lacks low) on the configured default account or pool. An incompatible or
disabled default stays selected and fails with a setup explanation; voice never searches for another
account offering its model. Runtime voice changes are validated against the machine file plus the
proposed runtime values, excluding removed overrides, before they are written to
generated `runtime.toml`, which overrides the machine file; projects never set voice. The provider
must offer the model and effort; an unusable selection gives a readable setup explanation, also
reported as `effectiveController.notice`, instead of changing accounts or substituting another
model. Fast mode becomes the priority tier only when that model's route offers it. Live holds that concrete route and its pool/account
lifetimes, so pool or account disablement and daemon shutdown still cancel it while credential
failures never trigger account failover.
A random choice once froze a call onto a pool member whose sign-in could no longer be renewed.
Because that call can never fail over, the choice now takes the voice credential's account when the
pool includes it, and otherwise skips accounts that recently failed: configuration observes every
concrete provider run and remembers, per account for fifteen minutes, a terminal typed
`authentication` or `out_of_tokens` failure, cleared by the next completed response, beside the
existing missing-credential memory. Failed accounts are chosen only when every enabled account has
failed. Ordinary smart routing does not consult this memory; it fails over within the turn.
The voice transport's explicit credential selection remains independent of the text controller.
Selecting a pool as that credential is invalid, even when it has Codex compatibility. Configuration
throws a dedicated fixed-message error for that proven selection, allowing Live to explain it
without forwarding arbitrary credential-loading diagnostics or trying a different account.
Every controller field accepts a null reset through the public patch, including fast mode. Resetting
a field reveals its machine-file value or default and validates that resulting selection, so a
model change can remove an incompatible runtime effort without resurrecting it during validation.

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

## The Telegram Bot API server is a machine setting

Telegram exports started as `[channels.telegram.<bot>]` tables holding the token and allowlist.
People wanted the Chief of Staff to create and change them on the fly instead, so they moved to
the exported bots module's database table and need no reload. Only `[telegram] api_url` remains in
configuration, for a self-hosted Bot API server. It is dropped from the project layer and is not
something a tool can set, because whichever server it names receives every bot token.

## Workload users are machine settings validated strictly

`[execution]` names the Linux users agent work runs as, and each name ends up in a sudo command
line that a sudoers rule allows. It is read only from machine `happy.toml` and dropped from the
project layer, because a repository must never choose the account its own code runs as. Names
must match `^[a-z_][a-z0-9_-]{0,31}$` and must not be `root`; the executable must be an absolute
path; per-bot keys must be bot IDs. The table is refused beside `[runners]`, where nothing runs on
this machine to separate, and on Windows, which has no sudo. Changing it takes a restart.

## Friendly account names do not change identity

Every provider accepts optional `name`. Built-in Claude, Codex, and Grok slots default to Current
CLI; custom accounts without a name use a readable ID. Names are trimmed and validated, then
displayed verbatim. Configuration owns the defaults. Names never change credentials, provider
types, enabled or hidden flags, pool membership, defaults, or routing. Email shortening belongs
only to recipe guidance when choosing a name, never to a runtime formatter.
