# Configuration

Happy Agent reads user-wide settings from `~/Happy/Config/happy.toml` on macOS and
`~/happy/config/happy.toml` on Linux. The user's global `AGENTS.md` lives beside
it. On startup, Happy Agent creates the platform-specific folder, a comprehensive
commented `happy.toml` template, and an empty `AGENTS.md` whenever they are
missing. Existing files are never replaced. The daemon derives this public configuration folder
beside its private Happy root. `HAPPY_HOME_DIR` relocates that root and the adjacent public folder.

If an older Linux build created `~/Happy/Config`, copy its configuration files to
`~/happy/config` before upgrading and restarting. The uppercase directory is no longer read;
private `.happy/agent` state does not move.

Repository settings come only from `happy.toml`. Repository values win where
both are allowed. MCP is separate: user-wide servers live in `~/Happy/Config/mcp.toml` on macOS
or `~/happy/config/mcp.toml` on Linux, and a project workspace, bot folder, or task folder can
add servers in its root `mcp.toml`. Provider configuration files are not imported.

Happy Agent keeps daemon state in `~/.happy/agent`, including its databases, logs, and runtime
configuration. A standalone deployment also keeps its private API token and socket there; team
mode deliberately creates neither. `HAPPY_HOME_DIR` moves the `.happy` root.

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

## Applying configuration changes

Some settings apply without a restart. Network policy is reread before every sandboxed command,
and MCP servers are reloaded online with `reload_mcp_servers` (see [MCP](MCP.md)). The daemon
reads everything else in the user `happy.toml` only at startup. That includes providers and
their accounts, `hidden`, smart providers, the `[gemini]` key, the Telegram Bot API server,
Ethan mode, heap snapshots, the Tailcat port, runners, and the Linux users work runs as. Reload the
daemon after changing any of these:

```sh
happy-agent reload
```

Reload is graceful. It drains the daemon first: new mutations are rejected and running turns are
never cancelled. An inference already in flight finishes, and a tool batch already running
finishes and commits, but no further inference starts. Tool calls that have not started and
queued messages stay durable for the new daemon. The old daemon then shuts down. That stops
terminal processes and background shell commands, and disconnects clients.
Reload then starts a fresh daemon, which inherits the environment of the shell that ran the
command. `happy-agent status` reports whether the new daemon is running. A team or
other supervised deployment restarts through its supervisor instead, such as
`systemctl restart`.

An agent reloads the daemon it runs on only with `happy-agent reload --detach`, run from the
selected executable `~/.happy/dist/version/<selectedVersion>/happy-agent` (`selectedVersion` is in
`~/.happy/dist/config.json`) and with host access. It returns at once; the reload starts after the
command exits and logs to `~/.happy/agent/reload.log`. First validate `happy.toml`, because a daemon
cannot start with a file it cannot parse, and tell the user which running work will be interrupted.
Make it the turn's final tool call and never poll or wait on it. A foreground reload from a session
dies with its daemon, so `happy-agent reload` without `--detach` refuses it. Switch Agent versions
with Happy Desktop's version picker, which restarts the daemon itself.

## Standalone profile bootstrap

For an unattended personal deployment, put the existing local name and email in the **remote
machine's global** `happy.toml` before starting it:

```toml
[profile]
name = "Ada Lovelace"
email = "ada@example.com"
```

Both valid, nonempty fields are required when this section is present. Startup fills only missing
profile fields, creates a fresh installation-owned identity when needed, and preserves later
profile edits on restart. This satisfies the profile requirement without manual profile creation;
it is not a blanket onboarding bypass. Provider credentials and project setup still matter.

An active root admin bot can use `get_local_profile` to read the local name and email directly
from storage, with `null` for missing values. Deployment copies those values into config records,
not through a profile API call. The tool does not expose private profile identity or photo data.
Repository configuration cannot supply this section, and team deployments reject it because their
profiles belong to individual authenticated users. See the [deployment recipe](recipe/deploy-standalone-remote.md).

## Ethan mode

Ethan mode is token-max mode. Enable it when you are token rich, expect the agent to keep consuming
tokens, and want progress to continue instead of accepting any error as final. It always retries,
forever, with backoff: there is no retry limit, and errors marked fatal do not stop it. This includes
provider, authentication, billing, context, policy, compaction, and internal run-stage failures.
In short, Ethan mode survives any failure the agent loop can recover from and keeps trying until it
works.

Only a deliberate stop ends it. Explicit cancellation, provider disablement, and daemon shutdown
still stop active work.

Enable it only in the user-wide configuration, then [reload the daemon](#applying-configuration-changes):

```toml
[settings.ethan]
enabled = true
```

A repository `happy.toml` cannot enable Ethan mode.

## Tailcat exposure

Tailcat v0.7.0 gives either daemon transport an account-free, WireGuard-encrypted path across the
Internet. It remains explicit and machine-scoped:

```toml
[feature.tailcat]
enabled = true
port = 24779
```

The bundled Tailcat generates a fixed-region identity key on first start. The key remains at
`~/.happy/agent/tailcat/default.private.json`, so the Tailcat address is stable across restarts.
While open, the same directory contains `address` and `port`; shutdown removes those two live-state
files and keeps the key. An unexpected Tailcat exit is supervised and restarted.

The port defaults to the fixed, IANA-unassigned port `24779`. Set `port` to another nonzero TCP
port in the same machine-wide section when needed. It is the port Happy Agent reports for remote
endpoints and never changes on its own. Happy Agent binds no local port for Tailcat, so another
local process using the same number does not conflict.

Tailcat itself has no account login or client allowlist here. Happy API authentication is unchanged:
the standalone socket still requires its local bearer token and team mode still verifies WorkOS.
Anyone who knows the Tailcat address may reach that authentication boundary, so do not publish the
address unnecessarily. A project `happy.toml` cannot enable Tailcat. An active admin bot can use
`set_tailcat_enabled` to persist and immediately apply a runtime override, and
`get_tailcat_status` to read the live address and port. See [tailcat.md](tailcat.md) for the
complete Tailcat setup and client commands.

## Exported bots

Exporting a bot lets people reach it from a chat service. There are two kinds: `telegram`, built
in, and `bridge`, which a bridge program serves for any other service over the
[bridge protocol](exported-bot-protocol.md). A bot can be exported at most once of each kind.

Export a bot of its own, not Happy. Exports are not configuration: an active admin
bot, normally Happy, creates and changes them for that bot with
`set_telegram_exported_bot` or `set_bridge_exported_bot`, removes them with
`remove_exported_bot`, and reads them with `get_exported_bot_status`, and Happy Agent keeps them
in its database. Every change applies immediately, without a reload. The
[Telegram](recipe/exported-bot-telegram.md) and [bridge](recipe/exported-bot-bridge.md) recipes
are the walkthroughs.

Each allowed person, named by their ID on the service, becomes a guest: a user Happy knows by the
name the service gives, who can never sign in. Every guest gets their own subtask under the bot,
and the bot's reply to each message goes back to their private chat. A guest's messages are their
own requests, never the owner's or a team member's instructions, including in Auto permission
review, and they always run in Auto; the bot still works for them with whatever it can reach, so
allow only people trusted with the bot. A Telegram user is one guest on every bot exported to
Telegram; a bridge's users are guests of that one export. Someone not on the allowlist is asked
about by default (`unknownSenders = "ask"`): their first message is held, they get one fixed
notice, and Happy is told who is asking, never what they wrote. It lets them in with
`approve_exported_bot_user`, which delivers the held message, or turns them away with
`deny_exported_bot_user`, once the user decides. With `unknownSenders = "ignore"`, strangers are
dropped silently. Messages from other bots and from groups are always ignored.

Only one program may read a Telegram bot's messages, so each Happy bot needs its own Telegram bot,
and its token must not be used by a webhook or another program. A bridge token is written to a
file for its bridge and stored only as a digest; whoever holds it can speak as any allowed guest.

The one setting is the Bot API server, for a self-hosted `telegram-bot-api` server:

```toml
[telegram]
api_url = "http://127.0.0.1:8081"
```

It defaults to `https://api.telegram.org`. It is a machine setting, because that server receives
every bot token: a project `happy.toml` cannot set it, and it applies after a reload.

## Runners

A runner is a separate machine that does a node's work, strongly recommended for every remote
node. The daemon keeps the database, provider credentials, API token, and inference; the runner
holds the project folders and runs agent file tools and commands, Git, workspace checkouts and
setup, terminals, file browsing, previews, and MCP stdio servers. It reaches the daemon over one
connection it dials, so it needs no inbound port. [Add a dedicated runner](recipe/add-runner.md)
walks through deploying one.

Runners are machine configuration in the node's `happy.toml`; project configuration cannot
declare them:

```toml
[runners]
default = "build-box"

[runners.build-box]
name = "Build box"
token = "REPLACE_WITH_FRESH_43_CHARACTER_BASE64URL_TOKEN"
```

Each `[runners.<id>]` names one runner, at most 32, with an ID matching `[a-z][a-z0-9_-]{0,63}`.
Its token uses the API token format and must differ from `[api] token`, every connection token,
and every other runner's token. `default` picks the runner for new projects that name none, the
home project, and bot folders; it is optional with exactly one runner. Restart the daemon after
changing runners. Removing an entry revokes that runner, which then stops everything it held.

The runner itself is `happy-agent runner`, given the daemon's endpoint and its token:

```sh
HAPPY_RUNNER_ENDPOINT=tailcat:<address>:<port> happy-agent runner
```

The endpoint is `tailcat:<address>[:<port>]` for a node's [Tailcat exposure](#tailcat-exposure),
`https://host` or `http://host:port` over a private network, or `unix:/path` to a local socket;
`--endpoint` sets it too. The token comes from `~/.happy-runner/token`, `--token-file <path>`, or
`HAPPY_RUNNER_TOKEN` — never an argument. `--home <directory>` moves where the home project and
bot folders live. The runner removes both variables from its environment once read, and agent
commands cannot read its private directory.

Once any runner is configured, the daemon runs nothing on its own machine. Projects registered
there earlier stay listed so they can be archived, and their work fails with
`local_execution_disabled`. Work on a folder whose runner is away fails with `runner_unavailable`;
nothing falls back to the daemon. A runner project can run its workspaces in containers on the
runner by setting `defaultWorkspaceCompute` to `{ "type": "docker", "image": "..." }`; the runner
needs Docker. Attached secrets are not available on runners yet.

## Work as separate Linux users

On Linux and macOS, the daemon can run this machine's work as other Linux users, so the account
that holds the configuration, database, and provider credentials never runs what agents do.
[Harden a node with separate Linux users](recipe/harden-node.md) walks through the accounts, the
sudo rule, and the checks.

```toml
[execution]
user = "happy-work"
# executable = "/usr/local/bin/happy-agent"

[execution.bots.k3x9q2w7e5r1t8y4u6i0o3pa]
user = "happy-guest"
```

`user` is the workload user. For it, and for each bot user, the daemon starts a runner with
`sudo -n -u <user> -- <executable> runner --stdio` and speaks the [runner](#runners) protocol over
its standard input and output. Agent file tools and commands, Git, workspace checkouts and setup,
terminals, file browsing, previews, MCP stdio servers, and the automatic permission reviewer's
reads all run there, in the normal sandbox; nothing of this machine's work runs in the daemon
process. The home project is the workload user's home, and new bot, task, project, and workspace
folders are placed under it as on a runner; `HAPPY_AGENT_WORKSPACES_DIRECTORY` and
`HAPPY_AGENT_PROJECTS_DIRECTORY` no longer move them. Folders already created elsewhere keep their
paths.

`[execution.bots.<botId>]` gives one bot, named by the bot ID `list_bots` reports, a user of its
own: every agent the bot governs runs its files and commands as that user. Stdio MCP servers stay
with the workload user and are not offered to such a bot; product work on its folder, such as
terminals and Git checkouts, also stays with the workload user. A bot ID that names no bot is
logged and ignored.

`executable` defaults to the daemon's own executable and must be an absolute path that the
workload users can run, matching the sudoers rule exactly. User names are a lowercase letter or
`_`, then up to 31 lowercase letters, digits, `_`, or `-`; `root` is refused, and so is the user
the daemon runs as. The daemon starts the runner with only `PATH` in its environment.

A runner that cannot start — no sudo rule, an unknown user, a missing executable — fails closed:
the daemon still starts and logs the reason, and every piece of work that needs that user fails
with it, through the API as `503 runner_unavailable`. Nothing falls back to the daemon's own user.
A runner that stops after it was connected is started again, and machines it held are rebuilt in
the same folders, as after a runner restart.

It is machine configuration only: a project `happy.toml` cannot set it. It cannot be combined with
`[runners]`, since nothing runs on this machine once runners are configured; give each runner its
own unprivileged user on its own machine instead. Restart the daemon after changing it. As on
runners, commands that select attached secrets are refused, and live Git state is not tracked for
these folders. Docker workspaces and a bot's Docker compute
are started by the workload user's runner, which then needs Docker access — root-equivalent on that
host, and therefore the end of this separation.

## Team deployment mode

Team mode turns one Happy Agent daemon into an organization-authenticated service. It replaces the
private Unix socket and local token with a TCP HTTP listener authenticated by WorkOS access tokens
or, with [JWT authentication](#jwt-team-authentication), by the organization's own OAuth server.
Configure it only in the user-wide `happy.toml`:

```toml
[feature.team]
enabled = true
host = "0.0.0.0"
port = 3000
workos_client_id = "client_01KZD3XE9YAFAMT0P8TD4HP73E"
workos_organization_id = "org_01EXAMPLE"
owner_workos_user_id = "user_01EXAMPLE"
```

On a standalone Happy Agent connected to the intended owner's Happy Cloud account, ask an active
admin bot to call `get_happy_workos_state`. Copy its `workos_client_id` and `workos_user_id` into
`workos_client_id` and `owner_workos_user_id` respectively. Although the client setting defaults to
Happy Cloud production, configure the reported value explicitly so the deployment does not infer
which WorkOS project authenticated the owner.

| Setting                  | Default                               | Meaning                                                                                 |
| ------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------- |
| `enabled`                | `false`                               | Selects team deployment mode.                                                           |
| `authentication`         | `"workos"`                            | `"workos"`, or `"jwt"` for [JWT authentication](#jwt-team-authentication).              |
| `host`                   | `"0.0.0.0"`                           | TCP interface for the HTTP listener.                                                    |
| `port`                   | `3000`                                | TCP port; `0` asks the operating system to choose an ephemeral port.                    |
| `workos_client_id`       | `"client_01KZD3XE9YAFAMT0P8TD4HP73E"` | WorkOS client whose issuer and JWKS authenticate access tokens.                         |
| `workos_organization_id` | required when enabled                 | Exact `org_id` claim required in every accepted token.                                  |
| `owner_workos_user_id`   | required when enabled                 | WorkOS identity whose user receives the owner flag when their profile is first created. |

The daemon verifies RS256 signatures and required WorkOS claims locally after retrieving and
caching that client's JWKS. A token must match both the configured client and organization. Every
HTTP request, including health, requires `Authorization: Bearer <access-token>`; only
`GET /v0/authentication` is public.

Team mode does not seed users. A valid member of the configured WorkOS organization can read health,
onboarding, and their current profile before a local user exists. Their first profile update must
provide a non-null `name`; that update creates the durable user and derives its owner flag from
`owner_workos_user_id`, or `owner_user_id` with JWT authentication. All other product routes require
an onboarded user. The existing profile wire contract remains unchanged: Happy Agent splits the
first token of `name` into the stored first name and stores the trimmed remainder as the optional
last name.

### JWT team authentication

With `authentication = "jwt"`, members sign in with the organization's own OAuth 2.0 authorization
server, such as its identity provider, instead of WorkOS. The apps use the authorization code flow
with PKCE and optional refresh, talking to that server directly; the daemon only verifies the JWT
access tokens and never receives codes or refresh tokens. The WorkOS settings above must not be
set. [Set up enterprise JWT sign-in](recipe/enterprise-jwt-authentication.md) walks through the
whole deployment.

```toml
[feature.team]
enabled = true
authentication = "jwt"
owner_user_id = "user-123"

[feature.team.jwt]
name = "Acme SSO"
authorization_url = "https://sso.acme.example/oauth/authorize"
token_url = "https://sso.acme.example/oauth/token"
refresh_url = "https://sso.acme.example/oauth/token"
client_id = "happy"
scope = "openid"
issuer = "https://sso.acme.example"
audience = "https://happy.acme.example"
user_id_claim = "sub"
algorithms = ["RS256"]
jwks_url = "https://sso.acme.example/.well-known/jwks.json"
jwks_refresh_interval_sec = 3600
```

| Setting                     | Default        | Meaning                                                                                        |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `owner_user_id`             | required       | User ID (from `user_id_claim`) whose user receives the owner flag when first created.          |
| `name`                      | required       | Sign-in button label, 1–64 printable characters.                                               |
| `authorization_url`         | required       | Authorization endpoint the apps open in the system browser.                                    |
| `token_url`                 | required       | Token endpoint where the apps exchange the authorization code.                                 |
| `refresh_url`               | none           | Endpoint for refresh tokens, on any origin. Without it, apps sign in again when tokens expire. |
| `client_id`                 | required       | Public OAuth client ID registered for the Happy apps.                                          |
| `scope`                     | none           | Space-separated scope requested at sign-in.                                                    |
| `issuer`                    | required       | Exact `iss` claim required in every access token.                                              |
| `audience`                  | required       | Value the `aud` claim must equal or contain; use a unique value per deployment.                |
| `user_id_claim`             | `"sub"`        | Claim holding a stable, never-reused user ID.                                                  |
| `algorithms`                | required       | Accepted signing algorithms; `none` is never accepted.                                         |
| `jwks_url`                  | one key source | JWKS the daemon downloads at startup and refreshes; recommended.                               |
| `jwks_refresh_interval_sec` | `3600`         | Seconds between JWKS downloads, 60–86,400; only with `jwks_url`.                               |
| `public_key`                | one key source | One PEM public key, instead of a JWKS.                                                         |
| `secret_env`                | one key source | Environment variable holding a shared HS256/384/512 secret of at least 32 bytes.               |

Configure exactly one of `jwks_url`, `public_key`, and `secret_env`. Asymmetric sources accept the
RS, PS, ES, and EdDSA algorithms; `secret_env` accepts only HS256, HS384, and HS512. A shared
secret lets the daemon mint tokens itself, so prefer asymmetric keys. Every URL must use `https`,
or plain `http` only on a loopback host. Clients discover the method without a token through
`GET /v0/authentication` and from the `authentication` field of any `401`.

With either authentication method, `[feature.team.members]` may list people before they first
sign in, keyed by their user ID (the `user_id_claim` value, or the WorkOS user ID). Startup creates
each one who has no user yet and fills only the fields an existing user has not set; at most 256
entries.

```toml
[feature.team.members."steve"]
name = "Steve"
email = "steve@acme.example"
role = "Billing engineer"
follows = "Billing, invoices, and Stripe webhooks"
auto_join_tasks = false
```

| Setting           | Default  | Meaning                                                                  |
| ----------------- | -------- | ------------------------------------------------------------------------ |
| `name`            | required | Display name, split like a profile name.                                 |
| `email`           | none     | Email address.                                                           |
| `role`            | none     | What the person does, at most 64 characters, shown to agents.            |
| `follows`         | none     | What the person follows, at most 500 characters, shown to agents.        |
| `auto_join_tasks` | `true`   | `false` starts the person with `tasks.autoJoin` off; they can change it. |

Run a team deployment with `happy-agent run` under a process supervisor. Local socket-based daemon
management and the macOS menu bar integration are disabled. The listener serves plain HTTP, so put
it behind TLS-capable ingress before exposing it outside a trusted network. See
[team-mode.md](team-mode.md) for the complete deployment and onboarding behavior, or
[tailcat.md](tailcat.md) to expose it through Tailcat.

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
repository list replaces that default for its workspaces. The daemon records
the list it reads from a project's own `happy.toml` on that project
(`workspaceSetupCommands` in the API) and re-reads the file when it changes, so
a client such as Happy can show what a new workspace will run. The file stays
the source of truth; the API does not write it.

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
  Unix-socket bridge. Happy Agent keeps the sockets under an empty network
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
Bedrock credential locations, so their `type` is inferred. Disabled providers remain
in the catalog with their known models marked disabled. Those models are omitted
from the model picker and the agent's available-model guidance. Startup credential
discovery reads local state and does not ping provider servers.

Every provider accepts an optional friendly `name`, including built-in accounts and smart pools.
Built-in `claude`, `codex`, and `grok` default to **Current CLI**; custom accounts without a name
use a readable version of their ID. Names are trimmed, nonblank, and at most 256 characters, then
displayed verbatim. They never change credentials, routing, or account IDs.

Add any number of named instances when you need separate accounts. The section suffix remains
the provider ID accepted by `defaults.provider` and pool membership. Custom instances must set
`type`; all parameters stay flat in the same section. The built-in Claude Code
provider ID is `claude`:

```toml
[providers.work_codex]
type = "codex"
name = "Work"
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

Every provider accepts `enabled`, `hidden`, `include_models`, `exclude_models`,
`include_subagent_models`, and `exclude_subagent_models`. Filters use exact Happy Agent model IDs;
exclusions win when a model appears in both matching lists. `include_models` and `exclude_models`
control ordinary availability everywhere, including the model picker. The subagent-specific pair
only narrows which otherwise available model/provider routes agents may choose when creating new
subagents, including through workflows; it does not remove those models from ordinary sessions.
Omitting both subagent fields allows every ordinarily available model.

GPT-6 Sol on Codex is opt-in now that GPT-6.1 Sol replaces it. It stays enabled, so sessions
already on it keep running turns and compaction, but it is hidden: it never stands in as the
default and is not offered to the phone or for new subagents. Naming it in a Codex account's
`include_models`, beside every other model that account should offer, offers it again there; a
pool offers it when the pool or one of its members names it. A `[defaults]` model or
`include_subagent_models` entry naming it is honored as written. Bedrock keeps offering it
because Bedrock does not serve GPT-6.1 Sol.

Codex instances also accept `auth_file`, `base_url`, and `transport`.
Claude Code instances accept `config_dir`, `executable`, and `oauth_token`.
Run `claude setup-token` while signed in to the additional Claude account to
create the long-lived token used by `oauth_token`. The token applies only to
that provider instance. Grok instances
accept `auth_file` and `base_url`. [OpenAI-compatible](#openai-compatible-endpoints) instances
accept `base_url`, `api_key` or `api_key_env`, `models`, `model_overrides`, `request`,
`headers`, `reasoning_field`, and `model_metadata`. Bedrock instances
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
inference-profile IDs and request metadata. [Reload the daemon](#applying-configuration-changes) after
changing providers. Repository `happy.toml` files cannot change these
machine-level choices or credential paths.

A client may choose a different provider, model, effort, or permission mode when it creates a
session; the `[defaults]` values apply otherwise.

### Harnesses

A provider is an account; a harness is who runs the agent loop on it. `[harnesses.happy]`, Happy's
own loop on every provider, exists by default. `[harnesses.claude_code]` runs Claude Code itself
(through the Claude Agent SDK) and `[harnesses.codex_cli]` runs Codex itself (through
`codex app-server`) on the `claude` or `codex` providers they list, by default all of that type.
`[harnesses.antigravity]`, `[harnesses.opencode]`, and any `type = "acp"` harness with a `command`
are agents with their own login, each offered as an account named after its harness. Every
harness accepts `enabled`, `include_models`, and `exclude_models`; `happy`, `claude_code`, and
`codex_cli` accept `providers`; the agents with their own login accept `name`, `hidden`,
`command`, `args`, and `api_key`, and `acp` harnesses `env`. Their models are the ones each agent
reports, under `<harness type>/<model>` IDs. The [harnesses recipe](recipe/harnesses.md)
covers setup, models, steering, and sub-agents.

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
provider's native tools, including Claude's unchanged `WebSearch` tool. [Reload
the daemon](#applying-configuration-changes) after adding or changing the key.

## Extra skill folders

Skills are always discovered under `~/.agents/skills` and each project's
`.agents/skills`. To scan more folders, list them under `[skills]`. Each entry
is a container of skill directories, each holding a `SKILL.md`, exactly like the
standard roots.

```toml
# User happy.toml: folders on this machine.
[skills]
directories = ["/opt/shared-skills", "/home/me/team-skills"]
```

```toml
# Project happy.toml: folders that ship with the repository.
[skills]
directories = ["tools/skills"]
```

Prefer absolute paths. They mean the same thing wherever discovery runs and
never depend on which home or project a path happens to be resolved against.
Relative forms exist as a convenience with a fixed meaning: in the user file, an
entry starting with `~/` or a bare relative path is resolved against the home
folder; in a project file, a bare relative path is resolved against that
project's root. A project file should use a relative entry only for a folder
inside the repository itself; anything outside it should be absolute.

The two lists add together. A project cannot remove a machine folder, and a
machine folder cannot hide a project one. A skill in a configured folder ranks
below a skill of the same name in a standard root. Machine folders are scanned
only when the agent runs on the daemon's own filesystem, since they name paths
on this machine; a Docker or remote session sees only its project's folders.
A missing or invalid project file adds nothing and hides nothing.

### Hiding providers

To keep an account available behind a smart provider without allowing direct selection, set `hidden = true`
in its table in the user-wide `happy.toml`, then [reload the daemon](#applying-configuration-changes):

```toml
[providers.codex]
enabled = true
hidden = true

[providers.router]
type = "smart"
providers = ["codex"]
enabled = true
```

`hidden` defaults to `false` and works for built-in, named, and smart providers. It is a
machine-wide, file-only setting: repository configuration cannot change it, and there is no
mutation for hiding. `GET /v0/config` reports it as each provider's `hidden` field.

Hiding is display-only. Clients omit a hidden provider and its models from model selection, the
daemon leaves it out of the model guidance and the model choices for new subagents, and a default
never falls back to it. `enabled` is unaffected: it says only whether the account is on and may be
routed to. Sessions already on a hidden provider keep running turns and compaction as before. In
the example above, select `router`: it routes through the hidden `codex` account. Set
`enabled = false` to stop both direct and routed inference through an account, and delete its table
to remove it entirely.

Account-quota polling and explicit provider verification continue normally for hidden accounts.
Vendor quota readings remain attached to concrete accounts; a smart provider does not synthesize a
combined quota. Consumed-token accounting is not duplicated between the smart provider and its
backing accounts.

So clients can still show what a pool is made of, `GET /v0/config` and `GET /v0/usage` report a
smart provider's `pool`: its strategy and its members in failover order, hidden members included.
Each account's `GET /v0/usage` entry carries `signIn` (`signed_in`, `signed_out`, or `unknown`),
and a pool that has no account left lists each member it set aside, with the reason, in its
`no_account_available` failure.

Set `hidden = false` or remove the setting and reload the daemon to show the provider again.

The [accounts and models recipe](recipe/accounts-and-models.md) walks through adding an account and
pooling accounts behind a smart provider, and covers model filters, defaults, and switching sessions.

## Docker-backed sessions

A session can run against a running container or a session container created from an image
already present in Docker. Machine-wide Docker defaults belong in the user `happy.toml`:

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
and bearer tokens are supported. Live tool discovery lets a session use tools
added after startup. The OAuth keys are accepted but interactive OAuth is not
implemented, so a server that sets them fails to connect.

When a server asks for input during a tool call, the request appears as a
question on the agent that called the tool. It names the server, and only a
person can answer it. `tool_timeout_sec` does not count time spent waiting for
that answer. See [Elicitation](extending.md#elicitation) for how fields map to
questions and what the server receives.

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
```

Then select `xai/grok-build` in the model picker, or make it the default:

```toml
[defaults]
provider = "grok"
model = "xai/grok-build"
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
omitted with either file, Happy Agent uses the `default` profile. [Reload an
already-running daemon](#applying-configuration-changes) after changing these settings or variables.
The available model list follows AWS regional availability. GPT-5.6 Sol, Terra,
and Luna use Amazon Bedrock's Responses API and its 272,000-token context limit.
Sol is available in `us-east-1` and `us-east-2`; Terra and Luna are also
available in `us-west-2`. See the current
[OpenAI Bedrock guide](https://developers.openai.com/api/docs/guides/amazon-bedrock)
and [AWS launch announcement](https://aws.amazon.com/about-aws/whats-new/2026/07/openai-gpt-sol-terra/).
Anthropic models use the native Messages API, prefer the Anthropic-compatible
Mantle endpoint where available, fall back to Bedrock Runtime, and support
Bedrock's native server-side compaction.

## OpenAI-compatible endpoints

Any vendor that serves OpenAI's Chat Completions API with a bearer key is configuration, not
code: OpenRouter, Together, Fireworks, DeepSeek, vLLM, LM Studio, and the like. Give each one a
`type = "openai_compatible"` table in the user `happy.toml`:

```toml
[providers.openrouter]
type = "openai_compatible"
name = "OpenRouter"
enabled = true
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
models = ["deepseek/deepseek-v4.1-flash-1017"]
reasoning_field = "reasoning"

# Sent with every request, verbatim.
[providers.openrouter.request]
reasoning = { enabled = true }

# Optional; each field overrides what the vendor reports.
[providers.openrouter.model_overrides."deepseek/deepseek-v4.1-flash-1017"]
name = "DeepSeek V4.1 Flash"
```

| Setting           | Meaning                                                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base_url`        | The API base. Requests go to `<base_url>/chat/completions` with streaming and tool calls.                                                                                                                                                            |
| `api_key_env`     | The daemon environment variable holding the key, read when a session needs it. Prefer it to `api_key`, which stores the key in the file. Set exactly one.                                                                                            |
| `models`          | The chat models this account serves, by the vendor's own IDs. They become agent models as listed; Happy Agent never discovers models from the vendor.                                                                                                |
| `request`         | Extra top-level request fields passed through unchanged, such as OpenRouter's `reasoning`, `provider` routing, or `temperature`. Fields the protocol owns (`model`, `messages`, `stream`, `stream_options`, `tools`, `response_format`) are refused. |
| `headers`         | Extra request headers, such as OpenRouter's `HTTP-Referer` and `X-Title`.                                                                                                                                                                            |
| `reasoning_field` | Where earlier assistant reasoning is replayed: `"reasoning"` (OpenRouter), `"reasoning_content"` (DeepSeek and Kimi style), or `"none"`, the default, which leaves it off the wire. Streamed reasoning is read under either name.                    |
| `model_metadata`  | `false` stops Happy Agent from reading the vendor's `/models` details. Defaults to `true`.                                                                                                                                                           |

After the daemon starts, it asks `<base_url>/models` in the background about the configured models.
That only fills in each model's name, context window, image input, and reasoning efforts; it never
adds or removes a model and never blocks startup or a session. A vendor without the endpoint, or
with `model_metadata = false`, keeps the defaults: the model ID as its name, a 128,000-token window,
text-only input, and no effort sent. `model_overrides."<model>"` wins over both, field by field:
`name`, `context_window`, `auto_compact_window` (85% of the window by default), `input`
(`["text"]` or `["text", "image"]`), `efforts` and `default_effort` (from `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`; sent as `reasoning_effort`, with `off` sent as `none`), and a
per-model `request` table merged over the provider's. A text-only model rejects images before the
request is sent.

These models run on Claude Code's harness shape: its non-Claude lean system prompt, its Bash,
Read, Edit, Write, Glob, and Grep function tools with a text-only reader, and its compaction
prompt. That applies even when a gateway model ID looks native, such as `openai/...` on OpenRouter.
Native Codex and Claude tools need their own protocols. Switching between two models on these
accounts starts a fresh context. Prices are not shown; run cost stays `null`, as for every other
provider.

Repository `happy.toml` files cannot configure these providers. [Reload the
daemon](#applying-configuration-changes) after changing them, from a shell whose environment holds
the `api_key_env` variable.

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

## Happy Desktop colors

`[theme]` colors the terminal. Happy Desktop's window has its own palette,
chosen in its own preferences file, `~/.happy/desktop/config.json`. Its
appearances are System, Light, Dark, Midnight, and Custom. Custom is a built-in
palette with any color roles replaced. When a person asks to make the app
darker, warmer, or a different accent color, edit this file. Happy Desktop
watches it and applies each accepted change while it runs, with no reload or
restart.

The file belongs to Happy Desktop, so it is on the computer and in the user
account where Happy Desktop runs. The path is in that user's home and does not
move with `HAPPY_HOME_DIR`. An agent on a remote machine, in a container, or in
team mode reaches a different home, and editing that one changes nothing. The
path is outside your workspace, so a sandboxed write is reviewed or refused.
It needs a Happy Desktop build that supports Custom. Older builds do not show
Midnight or Custom, and older installed builds reset their preferences when
they read these values.

Read the file and merge these fields into the existing object. Keep every
other field, including ones you do not recognize. Do not write a separate
`theme.json`.

```json
{
    "version": 1,
    "appearance": "custom",
    "customTheme": {
        "base": "midnight",
        "colors": {
            "groupped-background": "#1d1a17",
            "surface": "#25211d",
            "text": "#ebdbb2",
            "text-secondary": "#a89984",
            "text-link": "#d79921"
        }
    }
}
```

- `version` is the number `1`.
- `appearance` is `system`, `light`, `dark`, `midnight`, or `custom`. Custom
  only shows while it is selected, so set it in the same edit or have the person
  pick it in Settings → General → Theme, the status bar theme menu, or the
  command palette.
- `base` is `light`, `dark`, or `midnight` and defaults to `midnight`. Every
  role not listed in `colors` comes from it, and so does the window's light or
  dark color scheme.
- `colors` maps role names to `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa`
  values. It may be omitted. The Windows title bar only takes `#rgb` and
  `#rrggbb`.
- The app ignores fields it does not recognize and keeps them on disk.
- An unknown role or a value that is not hex is dropped alone. The other roles
  still apply.
- A field with the wrong type keeps its last good value, or its default at
  startup, and the other fields still apply.

Write the file by renaming a complete temporary file over it, and make one edit
at a time. The app rereads the file before it saves and merges only what it
changed. If the file is not valid JSON, the app keeps the last good preferences
and stops saving until it is fixed.

After writing, wait about a second, then read
`~/.happy/desktop/config.error.txt` if it exists. It names each ignored field or
role and why. Fix `config.json`, not that file, which the app deletes once the
preferences are clean. A missing error file is not proof the edit applied:
nothing checks the file while Happy Desktop is not running.

The roles that shape the overall look:

| Role                                               | Paints                                               |
| -------------------------------------------------- | ---------------------------------------------------- |
| `groupped-background`                              | The window floor: sidebar, rail, settings background |
| `surface`                                          | The main content panel, tabs, and cards              |
| `surface-high`                                     | Recessed areas such as code blocks                   |
| `surface-selected`, `surface-pressed`              | Selected and pressed rows                            |
| `header-background`                                | Panel headers; on Windows, also the title bar        |
| `divider`                                          | Hairlines between areas                              |
| `input-background`, `sidebar-search-background`    | The composer, inputs, and the sidebar search         |
| `user-message-background`                          | The person's own chat bubbles                        |
| `text`, `agent-message-text`, `user-message-text`  | Main text                                            |
| `text-secondary`, `groupped-section-title`         | Quieter text and section headings                    |
| `text-link`                                        | The accent: links and active states                  |
| `button-primary-background`, `button-primary-tint` | The main action button and its label                 |
| `composer-send-background`, `composer-send-icon`   | The round send button in the composer and its arrow  |
| `terminal-background`, `diff-context-bg`           | Terminal and diff backgrounds                        |

Keep a visible step between surfaces: on a dark base, `surface` and
`input-background` should be slightly lighter than `groupped-background`, and
the primary button must stay readable against the surfaces around it.

Permission buttons and warning and error boxes (`permission-*`, `box-error-*`,
`box-warning-*`) cannot be recolored, so a theme cannot disguise an approval or
hide a warning. The complete list of roles:

`text`, `text-destructive`, `text-secondary`, `text-link`, `delete-action`, `warning-critical`, `warning`, `success`, `stem-cell-membrane`, `stem-cell-core`, `surface`, `surface-ripple`, `surface-pressed`, `surface-selected`, `surface-pressed-overlay`, `surface-high`, `surface-highest`, `surface-inverse`, `text-inverse`, `divider`, `shadow-color`, `shadow-subtle`, `shadow-rail`, `shadow-floating`, `shadow-elevated`, `shadow-activity-card`, `overlay-backdrop`, `overlay-panel`, `groupped-background`, `groupped-chevron`, `groupped-section-title`, `header-background`, `header-tint`, `header-tint-secondary`, `switch-track-active`, `switch-track-inactive`, `switch-thumb-active`, `switch-thumb-inactive`, `fab-background`, `fab-background-pressed`, `fab-icon`, `radio-active`, `radio-inactive`, `radio-dot`, `modal-border`, `button-primary-background`, `button-primary-tint`, `button-primary-ripple`, `button-primary-disabled`, `button-secondary-tint`, `composer-send-background`, `composer-send-icon`, `input-background`, `sidebar-search-background`, `sidebar-search-border`, `input-text`, `input-placeholder`, `review-accent`, `status-connected`, `status-connecting`, `status-disconnected`, `status-error`, `status-default`, `diff-outline`, `diff-success`, `diff-error`, `diff-added-bg`, `diff-added-border`, `diff-added-text`, `diff-removed-bg`, `diff-removed-border`, `diff-removed-text`, `code-comment`, `code-string`, `code-number`, `code-keyword`, `code-type`, `code-function`, `code-variable`, `code-constant`, `code-operator`, `code-punctuation`, `code-gutter`, `code-gutter-active`, `code-caret`, `code-selection`, `code-active-line`, `code-reveal`, `terminal-selection`, `diff-context-bg`, `diff-context-text`, `diff-line-number-bg`, `diff-line-number-text`, `diff-hunk-header-bg`, `diff-hunk-header-text`, `diff-leading-space-dot`, `diff-inline-added-bg`, `diff-inline-added-text`, `diff-inline-removed-bg`, `diff-inline-removed-text`, `user-message-background`, `user-message-text`, `agent-message-text`, `agent-event-text`, `syntax-keyword`, `syntax-string`, `syntax-comment`, `syntax-number`, `syntax-function`, `syntax-bracket-1`, `syntax-bracket-2`, `syntax-bracket-3`, `syntax-bracket-4`, `syntax-bracket-5`, `syntax-default`, `git-branch-text`, `git-file-count-text`, `git-added-text`, `git-removed-text`, `git-status-new`, `git-status-modified`, `git-status-renamed`, `git-status-deleted`, `file-code`, `file-data`, `file-style`, `file-image`, `file-video`, `file-audio`, `file-shell`, `file-secret`, `file-archive`, `file-prose`, `file-config`, `file-directory`, `file-other`, `file-path-text`, `terminal-background`, `terminal-prompt`, `terminal-command`, `terminal-stdout`, `terminal-stderr`, `terminal-error`, `terminal-empty-output`

## Heap snapshots

Full heap snapshots near the memory limit are opt-in because they are large and
can contain prompts, tool results, credentials held in memory, and other
sensitive process data. Enable them only in the machine-level config and then
[reload the daemon](#applying-configuration-changes):

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
