# Configuration

Happy Agent reads user-wide settings from `~/Happy/Config/happy.toml` on macOS and
`~/happy/config/happy.toml` on Linux. The user's global `AGENTS.md` lives beside
it. On startup, Happy Agent creates the platform-specific folder, a comprehensive
commented `happy.toml` template, and an empty `AGENTS.md` whenever they are
missing. Existing files are never replaced. Set `HAPPY_TERMINAL_CONFIGURATION_DIRECTORY`
to an absolute path to choose a different user configuration folder.

Repository settings come only from `happy.toml`. Repository values win where
both are allowed. MCP is separate: user-wide servers live in `~/Happy/Config/mcp.toml`, and a
workspace can add servers in its root `mcp.toml`. Provider configuration files are not imported.

Happy Agent keeps daemon state in `~/.happy/agent`, including its databases, logs, and runtime
configuration. A standalone deployment also keeps its private API token and socket there; team
mode deliberately creates neither. `HAPPY_HOME_DIR` moves the `.happy` root. Happy Terminal keeps
only client-specific runtime settings beneath `~/.happy/happy-terminal`; set
`HAPPY_TERMINAL_HOME` to an absolute path to move that client state.

Managed workspaces are user-facing folders rather than internal Happy Agent state. New
workspaces default to `~/Happy/Workspaces` on macOS and
`~/happy/workspaces` on Linux. Set `HAPPY_AGENT_WORKSPACES_DIRECTORY` to an absolute
path before starting the daemon to choose another location. Every workspace's
absolute path is saved in SQLite when it is created, so changing the variable
affects only new workspaces; existing ones stay where they are and do not need
to be moved.

A small project configuration might look like this:

```toml
[defaults]
permission_mode = "workspace_write"

[features]
workflows = true

[theme]
brand = "ansi:202"
accent = "cyan"
```

## Ethan mode

Ethan mode is token-max mode. Enable it when you are token rich, expect the agent to keep consuming
tokens, and want progress to continue instead of accepting any error as final. It always retries,
forever, with backoff: there is no retry limit, and errors marked fatal do not stop it. This includes
provider, authentication, billing, context, policy, compaction, and internal run-stage failures.
In short, Ethan mode survives any failure the agent loop can recover from and keeps trying until it
works.

Only a deliberate stop ends it. Explicit cancellation, provider disablement, and daemon shutdown
still stop active work.

Enable it only in the user-wide configuration, then restart the daemon:

```toml
[settings.ethan]
enabled = true
```

A repository `happy.toml` cannot enable Ethan mode.

## Tailcat exposure

Tailcat v0.4.0 gives either daemon transport an account-free, WireGuard-encrypted path across the
Internet. It remains explicit and machine-scoped:

```toml
[feature.tailcat]
enabled = true
```

The bundled Tailcat generates a fixed-region identity key on first start. The key remains at
`~/.happy/agent/tailcat/default.private.json`, so the Tailcat address is stable across restarts.
While open, the same directory contains `address` and `port`; shutdown removes those two live-state
files and keeps the key. An unexpected Tailcat exit is supervised and restarted.

Tailcat itself has no account login or client allowlist here. Happy API authentication is unchanged:
the standalone socket still requires its local bearer token and team mode still verifies WorkOS.
Anyone who knows the Tailcat address may reach that authentication boundary, so do not publish the
address unnecessarily. A project `happy.toml` cannot enable Tailcat.

## Team deployment mode

Team mode turns one Happy Agent daemon into an organization-authenticated service. It replaces the
private Unix socket and local token with a TCP HTTP listener authenticated by WorkOS access tokens.
Configure it only in the user-wide `happy.toml`:

```toml
[feature.team]
enabled = true
host = "0.0.0.0"
port = 3000
workos_organization_id = "org_01EXAMPLE"
owner_workos_user_id = "user_01EXAMPLE"
```

`workos_client_id` defaults to Happy Cloud's production WorkOS client. Set it when the deployment
uses another WorkOS project:

```toml
[feature.team]
enabled = true
host = "0.0.0.0"
port = 3000
workos_client_id = "client_01EXAMPLE"
workos_organization_id = "org_01EXAMPLE"
owner_workos_user_id = "user_01EXAMPLE"
```

| Setting                  | Default                               | Meaning                                                                                 |
| ------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------- |
| `enabled`                | `false`                               | Selects team deployment mode.                                                           |
| `host`                   | `"0.0.0.0"`                           | TCP interface for the HTTP listener.                                                    |
| `port`                   | `3000`                                | TCP port; `0` asks the operating system to choose an ephemeral port.                    |
| `workos_client_id`       | `"client_01KZD3XE9YAFAMT0P8TD4HP73E"` | WorkOS client whose issuer and JWKS authenticate access tokens.                         |
| `workos_organization_id` | required when enabled                 | Exact `org_id` claim required in every accepted token.                                  |
| `owner_workos_user_id`   | required when enabled                 | WorkOS identity whose user receives the owner flag when their profile is first created. |

The daemon verifies RS256 signatures and required WorkOS claims locally after retrieving and
caching that client's JWKS. A token must match both the configured client and organization. Every
HTTP request, including health, requires `Authorization: Bearer <workos-access-token>`.

Team mode does not seed users. A valid member of the configured WorkOS organization can read
health, onboarding, and their current profile before a local user exists. Their first profile
update must provide a non-null `name`; that update creates the durable user and derives its owner
flag from `owner_workos_user_id`. All other product routes require an onboarded user. The existing
profile wire contract remains unchanged: Happy Agent splits the first token of `name` into the
stored first name and stores the trimmed remainder as the optional last name.

Run a team deployment with `happy-agent run` under a process supervisor. Local socket-based daemon
management and the macOS menu bar integration are disabled. The listener serves plain HTTP, so put
it behind TLS-capable ingress before exposing it outside a trusted network. See
[team-mode.md](team-mode.md) for the complete deployment and onboarding behavior.

## Protected paths

Add existing workspace-relative files or directories to a project's
`happy.toml` when modifying them should require Full access:

```toml
[permissions]
protected_paths = ["master-plans", ".env.production"]
```

The user-wide `happy.toml` supports the same list, and Happy Agent merges the user and
project entries. Directory entries cover their descendants. Missing entries
are ignored when the session starts; recreating the session picks up paths that
were created later.

## Managed workspace setup

A repository can prepare every managed workspace before Happy Agent starts an agent in
it. Add ordered shell commands to the repository's protected `happy.toml`:

```toml
[workspace]
setup_commands = [
  "pnpm install --frozen-lockfile",
  "pnpm build",
]
```

Happy Agent creates the Git worktree, runs each command in order from the workspace
directory with the system login shell, and marks the workspace ready only after
all commands succeed. A failed or timed-out command leaves the workspace failed,
skips the remaining commands, and prevents sessions and inference from starting
there. These commands are trusted project lifecycle code and run with full
filesystem and network access. Each command has a 30-minute limit.
The same setting can provide a user-wide default in the user `happy.toml`; a
repository list replaces that default for its workspaces.

## Managed network access

Auto and Workspace write shell commands have no general network access. To let
those commands use a specific external service, add a managed network policy to
the user `happy.toml` or the repository's root `happy.toml`. Read only
always keeps shell networking disabled, even when a policy exists. Full access
is unrestricted and ignores the managed policy. The policy is
configuration-owned: it is not exposed as a shell-tool argument, so an agent
cannot request additional domains or ports for itself.

For example, allow CodeRabbit globally over HTTPS:

```toml
[network]
allowed_domains = [
  "coderabbit.ai",
  "*.coderabbit.ai",
]
allowed_ports = [443]
```

`allowed_domains` accepts exact domain names and `*.` subdomain patterns. A
wildcard does not include the root domain, so the example lists both
`coderabbit.ai` and `*.coderabbit.ai`. `allowed_ports` applies to every allowed
domain and defaults to `[443]` when omitted. `denied_domains` uses the same
matching syntax and takes precedence over the allowlist:

```toml
[network]
allowed_domains = ["*.example.com"]
denied_domains = ["uploads.example.com"]
allowed_ports = [443, 8443]
```

Local services are configured separately by port. This example allows a
sandboxed command to reach a Portless HTTPS listener on the Happy Agent host:

```toml
[network]
allowed_loopback_ports = [8443]
```

Host-loopback forwarding targets `127.0.0.1` specifically. A service listening
only on IPv6 `::1` is not reachable through `allowed_loopback_ports`; configure
it to listen on `127.0.0.1` as well. On Linux and in Docker, the relay also
remains subject to normal OS privileges for ports below 1024.

The settings can be combined:

```toml
[network]
allowed_domains = [
  "coderabbit.ai",
  "*.coderabbit.ai",
]
denied_domains = []
allowed_ports = [443]
allowed_loopback_ports = [8443]
allow_local_binding = true
```

On macOS, `allow_local_binding = true` lets an Auto or Workspace write command
bind any local TCP or UDP port and connect to loopback listeners. It is a
single all-ports switch, matching Codex; there is no per-bind-port list. The
listener uses the host loopback interface, while external inbound and outbound
traffic remains blocked. “All ports” removes Happy Agent's policy restriction; it does
not bypass normal OS privileges or an existing listener occupying the port.

On macOS, local unix sockets are handled separately and need no configuration. An
Auto or Workspace write command may always create and connect to unix sockets
inside the working directory and its Git control directory, which is where a
development server, language server, or test harness puts its socket. That is
deliberately narrower than writable space: sockets in temporary directories and
everywhere else on the host stay unreachable, so a sandboxed command cannot
reach the Docker daemon socket, the SSH agent, or Happy Agent's own control socket. The
home folder is never granted, because host agents keep their sockets under it, so
a session in the Home project creates no sockets. Read only creates none either.
Linux and Docker commands are confined by their mount and network namespaces
instead, so a socket there follows writable space rather than this rule.

Linux and Docker commands always retain loopback binding inside their isolated
network namespace, so `allow_local_binding` does not change their sandbox.
Those listeners are reachable only by processes in the same command namespace;
they are not published to the Happy Agent host, the container network, or other
commands. Proxy-aware clients automatically bypass the managed proxy for this
namespace-local loopback traffic.

Happy Agent rereads the global and project configuration before every Auto or Workspace
write shell command. Project policy replaces global policy.
`denied_domains` is the exception: global and project denies are combined, so a
repository cannot remove a machine-wide global denial. Runtime settings and
session state cannot define network policy. Changing a network policy therefore
does not require restarting Happy Agent. An existing root project `happy.toml` is
protected from agent writes in Auto, Workspace write, and Read only modes;
explicit Full access can still modify it. If the file does not exist, it remains
absent before, during, and after restricted commands. Happy Agent never creates a
placeholder or other synthetic file at that path.

For allowed external domains, Happy Agent starts per-command HTTP CONNECT and SOCKS5
proxies, points common clients at them with standard proxy environment
variables, and closes them when the command finishes. The proxy resolves DNS
outside the sandbox with a two-second limit, treats lookup failures as policy
denials, rejects private or loopback resolutions, checks the destination domain
and port, and applies deny rules before allow rules. A blocked HTTP client still
receives a conventional `403`, but Happy Agent also attributes the blocked destination
to the owning command, stops it, and reports a clear sandbox-policy error to the
agent. Removing the managed proxy variables is not a fallback route. A command
that ignores them still cannot connect directly:

- On macOS, Seatbelt permits outbound connections only to the temporary proxy
  ports and configured loopback ports.
- On Linux, Bubblewrap removes the command's network namespace. `socat` bridges
  only the configured endpoints through temporary Unix sockets.
- Inside a Docker-backed session, the nested Bubblewrap sandbox uses the same
  Unix-socket bridge. Happy Agent keeps the sockets under an empty `.happy-terminal-network`
  runtime directory and remounts that directory read-only over the writable
  workspace in every restricted command. A neighboring command therefore
  cannot rename or replace a live socket to intercept authentication. Every
  bridge also requires a random per-command token, so finding and connecting
  to another command's socket is insufficient. Each restricted command also
  receives a private `/tmp`, hiding Happy Agent's outer process-control files and other
  commands' temporary state. Per-command directories are removed on completion;
  the empty root is harmless and is not tracked by Git. The container needs
  `bubblewrap` and `socat`, and its working directory must be a host bind mount
  so Happy Agent can share the temporary sockets without publishing a TCP proxy.

In restricted Docker sessions, `allowed_loopback_ports` refers to loopback on
the machine running Happy Agent, not an arbitrary container port. Full access remains
unrestricted and can bypass the managed proxy by design.

## Providers

Provider availability is machine-wide because the local daemon owns the model
catalog and authentication paths. Configure it in the user `happy.toml`:

```toml
[providers]
default_enable = false

[providers.codex]
enabled = true

[providers.claude]
enabled = true

[providers.grok]
enabled = true

[providers.bedrock]
enabled = true
```

`providers.default_enable` controls provider instances that do not set their
own `enabled` value. It remains `true` when omitted for existing configurations;
setting it to `false` keeps every provider disabled unless that provider is
explicitly enabled.

These four built-in instances use the normal Codex, Claude Code, Grok, and
Bedrock credential locations, so their `type` is inferred. At daemon
startup, a provider disabled here or missing local authentication remains a
disabled catalog entry with no models. Its models are omitted from both the
model picker and agent system prompts; the prompt includes only the provider's
disabled reason. This availability check reads local credential state and does
not ping provider servers.

Add any number of named instances when you need separate accounts. For custom
instances, the section suffix is the provider ID shown in the model picker and
accepted by `defaults.provider` and `HAPPY_TERMINAL_PROVIDER`. Custom instances must set
`type`; all parameters stay flat in the same section. The built-in Claude Code
provider ID is `claude`:

```toml
[providers.work_codex]
type = "codex"
enabled = true
auth_file = "/Users/me/.codex-work/auth.json"
transport = "auto"
include_models = ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra"]
include_subagent_models = ["openai/gpt-5.6-terra"]

[providers.personal_claude]
type = "claude"
enabled = true
oauth_token = "token-from-claude-setup-token"
exclude_models = ["anthropic/haiku-4-5"]

[providers.work_grok]
type = "grok"
enabled = true
auth_file = "/Users/me/.grok-work/auth.json"
include_models = ["xai/grok-build"]

[providers.west_bedrock]
type = "bedrock"
enabled = true
region = "us-west-2"
profile = "work-bedrock"

[providers.west_bedrock.model_overrides]
"openai/gpt-5.6-sol" = { region = "us-east-1", endpoint = "https://bedrock-mantle.example/openai/v1", transport = "mantle" }
"anthropic/opus-4-8" = { endpoint = "https://bedrock-runtime.example", transport = "runtime" }
```

Every provider accepts `enabled`, `include_models`, `exclude_models`,
`include_subagent_models`, and `exclude_subagent_models`. Filters use exact Happy Agent model IDs;
exclusions win when a model appears in both matching lists. `include_models` and `exclude_models`
control ordinary availability everywhere, including the model picker. The subagent-specific pair
only narrows which otherwise available model/provider routes agents may choose when creating new
subagents, including through workflows; it does not remove those models from ordinary sessions.
Omitting both subagent fields allows every ordinarily available model. Codex instances also accept
`auth_file`, `base_url`, and `transport`.
Claude Code instances accept `config_dir`, `executable`, and `oauth_token`.
Run `claude setup-token` while signed in to the additional Claude account to
create the long-lived token used by `oauth_token`. The token applies only to
that provider instance. Grok instances
accept `auth_file` and `base_url`. Bedrock instances
accept `region`, `model_overrides`, `bearer_token_env_var`, `profile`,
`config_file`, and `credentials_file`. `profile` selects the standard AWS SDK
credential chain, including a profile's `credential_process`; the two file
settings optionally replace the standard AWS shared config and credentials
paths. `region` is the provider default. Each exact Happy Agent model ID under `model_overrides` may set
`region`, `endpoint`, `transport`, or any combination. Anthropic models prefer
Mantle in regions where both the endpoint and model are available in-region,
then fall back to Bedrock Runtime regional or global inference profiles. A full
`endpoint` URL overrides the endpoint selected for that model and bypasses
Happy Agent's regional availability list for the selected transport. The resolved region is still used for regional
inference-profile IDs and request metadata. Restart the local daemon after
changing providers. Repository `happy.toml` files cannot change these
machine-level choices or credential paths.

Use `/configure` for common settings. Environment variables such as `HAPPY_TERMINAL_MODEL`,
`HAPPY_TERMINAL_PROVIDER`, `HAPPY_TERMINAL_EFFORT`, and `HAPPY_TERMINAL_PERMISSION_MODE` override the corresponding
default for a newly created session.

A Gemini API key adds the universal `gemini_search`, `gemini_generate_image`,
`gemini_generate_music`, and `gemini_analyze_media` tools to every model. Set
it in the user `happy.toml`, or set `GEMINI_API_KEY` in the daemon environment;
the configured key wins when both are present:

```toml
[gemini]
api_key = "your-gemini-api-key"
```

Gemini powers these tools rather than chat models, so it has no `[providers.*]`
entry. No other Gemini or Google credential variable is used. Repository
`happy.toml` files cannot set the key. These tools are additional to each
provider's native tools, including Claude's unchanged `WebSearch` tool. Restart
the local daemon after adding or changing the key.

## Docker-backed sessions

Connect Happy Agent to a running container:

```sh
happy-terminal --docker-container my-development-container --docker-workdir /workspace
```

Or create a session container from an image already present in Docker:

```sh
happy-terminal --docker-image my-project-dev:local \
  --docker-workdir /workspace \
  --docker-env NODE_ENV=development \
  --docker-mount .:/workspace
```

The same options work with `happy-terminal exec`. `--docker-socket`, `--docker-name`, and
repeated `--docker-env` or `--docker-mount` options provide additional control.
Use `--local` to ignore a configured Docker default for one new session.

Machine-wide Docker defaults belong in the user `happy.toml`:

```toml
[docker]
image = "my-project-dev:local"
workdir = "/workspace"
env = { NODE_ENV = "development" }
mounts = [
  { source = ".", target = "/workspace" },
  { source = "/Users/me/.cache/my-project", target = "/cache", read_only = true },
]
```

Relative mount sources resolve from the host directory where Happy Agent starts. Use
absolute paths for home-directory mounts; `~` is not expanded. Repository
`happy.toml` files cannot select Docker images, sockets, environment variables, or
host mounts.

Image-backed containers are created on the first message and keep a stable,
session-derived name so their files survive daemon restarts. Happy Agent never pulls an
image implicitly and leaves managed containers in place for you to remove with
Docker. Images and connected containers need `/bin/sh`, `readlink`, and common
POSIX file utilities. Restricted permission modes also need `bubblewrap` and
`socat` in the container. Happy Agent configures image-backed containers for Bubblewrap
automatically; start a container that Happy Agent will connect to with
`--security-opt seccomp=unconfined` so restricted shell commands can create their
nested filesystem, process, and network boundary. Docker commonly blocks a
second procfs mount even with nested user namespaces, so Happy Agent gives restricted
commands an empty private `/proc` instead of exposing the container's parent
process table. Restricted commands also receive a private `/tmp`; temporary
files belonging to the parent container or another command are not visible.
Tools that require the parent `/proc` or shared `/tmp` should run in an
appropriately isolated Full access container.

## MCP servers

Happy Agent supports local stdio servers and streamable HTTP:

```toml
[mcp_servers.docs]
command = "docs-mcp-server"
args = ["--stdio"]
tool_timeout_sec = 30

[mcp_servers.issues]
url = "https://example.com/mcp"
bearer_token_env_var = "ISSUES_MCP_TOKEN"
```

MCP tools, resources, resource templates, prompts, pagination, form elicitation,
bearer tokens, and OAuth client credentials are supported. Live tool discovery
lets a session use tools added after startup.

Put user-wide servers in `~/Happy/Config/mcp.toml`, or workspace servers in a root
`mcp.toml`. Matching configurations share one live process across workspaces. Reload reconciles
the current workspace by default and the user-wide catalog when called with `global = true`.

Only configure servers you trust. Stdio servers run as local processes, receive
the daemon environment, and are not restricted by the session filesystem
sandbox.

## Grok Build

Install and sign in through the first-party Grok CLI, then choose Grok Build:

```sh
grok login
export HAPPY_TERMINAL_PROVIDER="grok"
export HAPPY_TERMINAL_MODEL="xai/grok-build"
happy-terminal
```

By default Happy Agent reads `$GROK_HOME/auth.json`, or `~/.grok/auth.json` when
`GROK_HOME` is unset. It reads Grok's current OIDC scope, refreshes sessions
five minutes before expiry, and atomically writes refreshed access and refresh
tokens back to the same file.
An explicit API key or `XAI_API_KEY` can also authenticate the provider, subject
to xAI's model availability for that credential.

The built-in endpoint is `https://cli-chat-proxy.grok.com/v1`. Grok Build uses
the OpenAI-compatible `/responses` API with its upstream 500,000-token context,
sampling defaults, encrypted reasoning continuation, and `x-grok-*` request
headers. Happy Agent adapts Grok's open-source prompt and primary tool definitions to
its shared execution and permission layer; it does not reproduce Grok's TUI,
schedulers, or dedicated Plan mode.

## Amazon Bedrock

Bedrock becomes available through either an `AWS_BEARER_TOKEN_BEDROCK` value or
the standard AWS credential chain. For a process-backed AWS profile, configure
the process in `~/.aws/config` using the normal AWS format:

```ini
[profile work-bedrock]
credential_process = /usr/local/bin/your-credential-helper --format aws
region = us-east-1
```

Then select that profile in the machine-wide `happy.toml`:

```toml
[providers.bedrock]
enabled = true
profile = "work-bedrock"
```

The helper must print the AWS credential-process Version 1 JSON shape. Happy Agent
keeps the refreshable AWS provider rather than storing the returned access key,
so expiring credentials are renewed by the AWS SDK. To use a Bedrock bearer
token instead:

```sh
export AWS_BEARER_TOKEN_BEDROCK="your Bedrock API key"
export AWS_REGION="us-east-1"
export HAPPY_TERMINAL_PROVIDER="bedrock"
happy-terminal
```

To use Bedrock exclusively, disable the native authentication paths in the
machine-wide config and select a Bedrock default:

```toml
[defaults]
provider = "bedrock"
model = "openai/gpt-5.6-sol"

[providers]
default_enable = false

[providers.bedrock]
enabled = true
```

Happy Agent uses `AWS_REGION`, then `AWS_DEFAULT_REGION`, and otherwise defaults to
`us-east-1`. With no explicit Bedrock authentication setting, Happy Agent checks the
bearer token first and then the ambient AWS chain (`AWS_PROFILE`, environment
credentials, shared files, ECS, and EC2 metadata). Optional `config_file` and
`credentials_file` settings select nonstandard shared files; when `profile` is
omitted with either file, Happy Agent uses the `default` profile. Restart an
already-running daemon after changing these settings or variables.
The available model list follows AWS regional availability. GPT-5.6 Sol, Terra,
and Luna use Amazon Bedrock's Responses API and its 272,000-token context limit.
Sol is available in `us-east-1` and `us-east-2`; Terra and Luna are also
available in `us-west-2`. See the current
[OpenAI Bedrock guide](https://developers.openai.com/api/docs/guides/amazon-bedrock)
and [AWS launch announcement](https://aws.amazon.com/about-aws/whats-new/2026/07/openai-gpt-sol-terra/).
Anthropic models use the native Messages API, prefer the Anthropic-compatible
Mantle endpoint where available, fall back to Bedrock Runtime, and support
Bedrock's native server-side compaction.

## Theme and display

Happy Agent follows Codex-style terminal color semantics by default. Override individual
roles globally or per repository:

```toml
[theme]
primary = "default"
secondary = "dim"
accent = "cyan"
brand = "ansi:202"
success = "green"
warning = "yellow"
error = "red"
```

Roles accept `default`, `dim`, ANSI names such as `bright_cyan`, palette indexes
such as `ansi:202`, or true-color values such as `#D97706`. `/fast` toggles the
Codex fast service tier when the selected provider supports it; fast inference
uses twice the plan usage.

## Daemon crash diagnostics

On Node.js runtimes that support environment redaction, Happy Agent starts its daemon
with private diagnostic reports for fatal runtime errors and uncaught
exceptions. Run `happy-terminal daemon status` to see the diagnostics directory. Happy Agent
also records the original stack in `server.log`. The diagnostics directory is
private (`0700`), uncaught-exception reports are additionally forced to `0600`,
and Happy Agent retains at most three crash reports. On older Node.js releases, Happy Agent
fails closed instead of writing credentials into a report and leaves an
explanatory `crash-reports-unavailable.txt` file in that directory.

Full heap snapshots near the memory limit are opt-in because they are large and
can contain prompts, tool results, credentials held in memory, and other
sensitive process data. Enable them only in the machine-level config and then
restart the daemon:

```toml
[settings]
daemon_heap_snapshots = true
```

Happy Agent retains at most two heap snapshots. Repository `happy.toml` files cannot
enable this setting.

## Workflows and app event synchronization

Workflows are on by default. Disable them globally or per repository:

```toml
[features]
workflows = false
```

For client integrations, the daemon can keep an opt-in durable queue of session
and subagent lifecycle events:

```toml
[settings]
durable_global_event_queue = true
```

This setting is user-wide only. Authenticated daemon clients can read event
batches from `GET /events`, follow `GET /events/stream`, and acknowledge entries
with `POST /events/trim`. See the [event reference](../EVENTS.md) for payloads and
queue behavior.
