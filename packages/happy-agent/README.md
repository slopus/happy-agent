# `@slopus/happy-agent`

The Happy Agent daemon.

All agent behavior lives in `@slopus/happy-agent-modules`: configuration, databases, storage
locks, module composition, events, HTTP routing, Happy synchronization, files, Git, terminals, and
the Agent System itself. This package owns the daemon process and its whole lifecycle:

- start the modules-owned runtime;
- in standalone mode, bind its API to the configured Unix domain socket;
- in team mode, bind its API to the configured TCP host and port;
- forward HTTP, WebSocket upgrades, and `CONNECT` tunnels to the API module;
- secure and remove the local socket when one is used;
- stop the active transport and runtime cleanly;
- spawn, observe, restart, and stop the detached daemon process.

## Command line

The agent is its own daemon. Products invoke these commands instead of managing the process:

```sh
happy-agent start    # start the daemon when none is running, replacing one that does not match
happy-agent stop     # ask the running daemon to shut down
happy-agent kill     # immediately kill the daemon recorded in daemon.pid
happy-agent status   # report whether the daemon is running
happy-agent reload   # stop the running daemon, then start a fresh one
happy-agent run      # run the daemon in the foreground of this process
happy-agent --version
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

## Standalone binaries

The repository can compile Happy Agent into one Bun executable for the current platform:

```sh
pnpm build:bun
```

`pnpm build:bun:all` produces macOS and Linux binaries for arm64 and x64 under
`packages/happy-agent/dist/bin/`. The normal TypeScript package stays Node-compatible; native
libraries, WebAssembly, workers, and provider executables are adapted only at the binary build
boundary.

Releases are created from the manual **Release Happy Agent** GitHub Actions workflow on `main`.
The workflow takes a semantic version without the leading `v` and Markdown release notes, runs the
Happy Agent checks and tests, builds and smokes all four binaries, and only then publishes the
GitHub Release and its `v<version>` tag. Happy Terminal's npm releases use the separate
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

Use `@slopus/happy-agent-client` to call the API. The complete HTTP contract is specified in
[`API.md`](API.md).
