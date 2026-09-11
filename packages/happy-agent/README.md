# `@slopus/happy-agent`

The Happy Agent daemon.

All agent behavior lives in `@slopus/happy-agent-modules`: configuration, databases, storage
locks, module composition, events, HTTP routing, Happy synchronization, files, Git, terminals, and
the Agent System itself. This package owns the daemon process and its whole lifecycle:

- start the modules-owned runtime;
- in standalone mode, bind its API to the local Unix domain socket or Windows named pipe;
- in team mode, bind its API to the configured TCP host and port;
- attach either API transport to the modules-owned Tailcat tunnel controller;
- forward HTTP, WebSocket upgrades, and `CONNECT` tunnels to the API module;
- secure and remove the local socket when one is used;
- stop the active transport and runtime cleanly;
- spawn, observe, restart, and stop the detached daemon process.

## Command line

The agent is its own daemon. Products invoke these commands instead of managing the process:

```sh
happy-agent start    # start the daemon when none is running, replacing one that does not match
happy-agent drain    # signal the local daemon, report progress, and wait without tokens or shutdown
happy-agent stop     # ask the running daemon to shut down
happy-agent kill     # immediately kill the daemon recorded in daemon.pid
happy-agent status   # report whether the daemon is running
happy-agent reload   # stop the running daemon, then start a fresh one
happy-agent run      # run the daemon in the foreground of this process
happy-agent --version
# Windows only:
happy-agent sandbox status          # inspect configuration without provisioning
happy-agent sandbox setup           # explicitly initialize the sandbox
happy-agent sandbox setup --retry   # retry a failed setup deliberately
```

`start` spawns a detached runtime process, redirects its output to the rotated daemon log, and
waits until health reports ready. The Node-compatible package runs `node <cli> run`; a standalone
binary relaunches itself. A running daemon whose reported version does not match the CLI is
replaced. `stop` waits for both the socket and the exact daemon PID to disappear. All state lives
under the Happy home (`~/.happy` or `HAPPY_HOME_DIR`), in its `agent/` directory: `server.sock`,
`token`, `daemon.pid`, the raw process `daemon.log`, and the structured runtime log at
`observation/agent.log`. The socket and token exist only in standalone mode. Shutdown records name
every cleanup step and report its duration; a step still running after one second emits a slow-step
warning.

`happy-agent drain` is a local macOS/Linux control command for both standalone and team daemons.
Run it as the service account (or an authorized administrator with the same `HAPPY_HOME_DIR`). It
uses the PID, an owner-only ephemeral `agent/drain.json` status record, and `SIGUSR2`; it never reads
the API token or connects to HTTP. The process identity is checked against the record before a
signal is sent, so a stale PID or an older daemon without advertised support is rejected. Progress
comes from the same API drain barrier, including admitted HTTP mutations and agent/reviewer work.
Successful completion leaves the daemon alive and draining; repeating the command is safe.

For maintenance, drain first, then stop through the existing supervisor. `SIGTERM` and `SIGINT`
request graceful shutdown and named cleanup, but do not first drain active work. Draining does not
wait for terminal/background jobs to finish. Never send `SIGUSR2` to an unsupported older daemon
or signal the entire service process group. See the shipped
[upgrade recipe](../../docs/recipe/upgrade-happy-agent.md) for the complete sequence.

Windows sandbox setup uses the matching supervisor included with Happy Agent. Its default
state directory is `.happy/windows-sandbox` under the actual Windows profile, independent of
`HAPPY_HOME_DIR`, `HOME`, and `USERPROFILE`. Advanced local development can select one existing
state directory with an absolute `HAPPY_WINDOWS_SANDBOX_HOME`; do not create separate
provisioning roots per project or test. Setup may request UAC once. A failed or cancelled
attempt is retained, so further commands fail with an actionable error rather than repeatedly
requesting elevation; `sandbox setup --retry` deliberately permits another attempt.
`HAPPY_WINDOWS_SANDBOX_NO_PROVISION=1` prevents all provisioning, including explicit setup;
read-only `sandbox status` still works. It does not disable sandbox enforcement.

Automatic first setup is allowed only for the canonical Windows state when no Happy
sandbox accounts exist. An explicit missing development state requires deliberate
`sandbox setup`. After setup returns cancellation or failure, `--retry` may retry it
directly. If a helper is still pending or its outcome is unknown in the current boot,
finish the existing Windows prompt or restart Windows before retrying; a retry never
overlaps that helper.

Sandbox status checks the setup version, saved identities and enabled accounts.
A restricted command verifies that those credentials can actually log on and execute.
Explicit development state overrides still refer to the same global Happy accounts;
they are not independent sandbox installations.

## Standalone binaries

The repository can compile Happy Agent into one Bun executable for the current platform:

```sh
pnpm build:bun
```

`pnpm build:bun:all` selects macOS/Linux arm64/x64 and Windows x64 under
`packages/happy-agent/dist/bin/`; every selected target requires its native assets.
Windows source builds need the explicit native build steps in
[the build-script guide](scripts/README.md#native-windows-11-x64). The ordinary TypeScript
package stays Node-compatible; native libraries, WebAssembly, workers and provider
executables are adapted at the standalone build boundary. Each target embeds its
matching Tailcat v0.4.0 asset.

Windows 11 x64 is the native Windows target. Happy ships one agent executable
containing its own supervisor and matching sandbox helpers, with no separate
Codex server installation. Read the build-script guide for its supported policy
limits, one-time UAC setup, local run commands and native verification. Windows
public publishing/signing, WSL, and Claude onboarding validation are separate work.

Releases are created from the manual **Release Happy Agent** GitHub Actions workflow on `main`.
The workflow takes a semantic version without the leading `v` and Markdown release notes, runs the
Happy Agent checks and tests, builds and smokes all four binaries, Developer ID-signs and notarizes
the macOS Happy Agent and embedded Tailcat executables, and only then publishes the GitHub Release
and its `v<version>` tag. Happy Terminal's npm releases use the separate
`happy-terminal-v<version>` tag namespace.

## Library

The same lifecycle is available programmatically:

```ts
import { ensureAgentDaemon, startHappyAgentDaemon } from "@slopus/happy-agent";

// Connect to the daemon, starting or replacing one as needed.
const { client, paths, token } = await ensureAgentDaemon();

// Or embed the daemon in the current process.
const daemon = await startHappyAgentDaemon({ happyHome: "/path/to/.happy" });
console.log(daemon.socketPath);
await daemon.close();
```

A product that bundles this package names its own daemon entrypoint:
`ensureAgentDaemon({ entrypoint })` spawns `node <entrypoint> run`, which is expected to run the
CLI's `run` command. Happy Terminal can ship the bundled CLI as `agent.js` beside its own bundle
and pass that path.

In standalone mode, the runtime exposes starting health before Agent System restoration completes.
Every request, including health, uses the bearer token persisted at the token path. The socket and
token are owner-only.

## Team deployment mode

Set `enabled = true` under `[feature.team]` in the global `happy.toml` to select team deployment
mode. In this mode Happy Agent does not bind, create, or retain its private local API socket and
bearer token, and it does not start the socket-dependent macOS menu bar app. Run it in the
foreground with `happy-agent run` under the deployment's process supervisor; local commands and
clients that start and connect to the private socket are intentionally unavailable. The daemon
instead listens on `host` and `port` from `[feature.team]` (default `0.0.0.0:3000`) and accepts
production Happy Cloud WorkOS access tokens for members of the configured organization. Set
`workos_client_id` in the same section to authenticate against another WorkOS project. Team mode
also requires `workos_organization_id` and `owner_workos_user_id`; the matching owner receives the
owner flag during profile onboarding.

Before deploying a team server, a standalone Happy Agent connected to Happy Cloud can use
`list_happy_teams`, `create_happy_team`, and `update_happy_team` to manage the current user's WorkOS
organizations. Creation requires the stable server endpoint and registers it immediately; updates
can change that endpoint. HTTP, HTTPS, Tailcat, WS, and WSS endpoints are accepted. Human-owned root
agents and admin bots can perform these operations; non-admin bots are refused. An active admin bot
also receives `get_happy_workos_state`, which returns the exact WorkOS user and client IDs needed by
team-mode configuration without coupling them to organization creation. Happy Cloud independently
requires the connected WorkOS user to be an active organization administrator before it writes an
endpoint. These tools are omitted from a daemon already running in team mode. The binary-first
Tailcat and systemd deployment walkthrough ships in `dist/docs/team-mode.md`.

## Tailcat exposure

Enable the machine-only transport in the global `happy.toml`:

```toml
[feature.tailcat]
enabled = true
port = 24779
```

The daemon generates one fixed-region Tailcat key on first start and keeps it at
`~/.happy/agent/tailcat/default.private.json`. The resulting connection address is stable across
restarts. While the tunnel is open, `address` and `port` files in that directory identify the live
endpoint; both disappear on clean shutdown while the key remains. Tailcat is supervised and
reopened after an unexpected exit. The forwarded port defaults to the fixed, IANA-unassigned port
`24779`; the machine-wide setting can choose another nonzero port. Tailcat fails clearly when that
exact port is occupied and never falls back to a random port.

Tailcat can wrap either the standalone Unix socket or the team HTTP listener. It is a dedicated,
account-free transport and applies no Tailcat client allowlist, but it does not bypass Happy Agent
authentication: standalone requests still need the local bearer token, and team requests still
need a valid WorkOS token. A client with Tailcat v0.4.0 can reach the endpoint with:

```sh
address="$(cat ~/.happy/agent/tailcat/address)"
port="$(cat ~/.happy/agent/tailcat/port)"
token="$(cat ~/.happy/agent/token)"
tailcat socks "$address" curl \
  -H "Authorization: Bearer $token" \
  "http://server.tailcat:$port/v0/health"
```

Set a team listener's `host` to `127.0.0.1` when Tailcat should be its only network path.

An active admin bot can change the persisted setting without restarting the daemon with
`set_tailcat_enabled`, then read the live state and stable address with `get_tailcat_status`.
Ordinary bots, archived admins, human-root agents, and subagents do not receive either tool.

Use `@slopus/happy-agent-client` to call the API. The complete HTTP contract is specified in
[`API.md`](API.md).
