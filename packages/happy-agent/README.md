# `@slopus/happy-agent`

The standalone Happy agent daemon.

All agent behavior lives in `@slopus/happy-agent-modules`: configuration, databases, storage
locks, module composition, events, HTTP routing, Happy synchronization, files, Git, terminals, and
the Agent System itself. This package owns the daemon process and its whole lifecycle:

- start the modules-owned runtime;
- bind its API to the configured Unix domain socket;
- forward HTTP, WebSocket upgrades, and `CONNECT` tunnels to the API module;
- secure and remove the socket;
- stop the socket and runtime cleanly;
- spawn, observe, restart, and stop the detached daemon process.

## Command line

The agent is its own daemon. Products invoke these commands instead of managing the process:

```sh
happy-agent start    # start the daemon when none is running, replacing one that does not match
happy-agent stop     # ask the running daemon to shut down
happy-agent status   # report whether the daemon is running
happy-agent reload   # stop the running daemon, then start a fresh one
happy-agent run      # run the daemon in the foreground of this process
```

`start` spawns a detached runtime process, redirects its output to the rotated daemon log, and
waits until health reports ready. The Node-compatible package runs `node <cli> run`; a standalone
binary relaunches itself. A running daemon whose reported version does not match the CLI is
replaced. All state lives under the Happy home (`~/.happy` or `HAPPY_HOME_DIR`), in its `agent/`
directory: `server.sock`, `token`, and `daemon.log`.

## Standalone binaries

The repository can compile Happy Agent into one Bun executable for the current platform:

```sh
pnpm build:bun
```

`pnpm build:bun:all` produces macOS and Linux binaries for arm64 and x64 under
`packages/happy-agent/dist/bin/`. The normal TypeScript package stays Node-compatible; native
libraries, WebAssembly, workers, and provider executables are adapted only at the binary build
boundary.

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
CLI's `run` command. Rig ships the bundled CLI as `agent.js` beside its own bundle and passes that
path.

The runtime exposes starting health before Agent System restoration completes. Every request,
including health, uses the bearer token persisted at the token path. The socket and token are
owner-only.

Use `@slopus/happy-agent-client` to call the API. The complete HTTP contract is specified in
[`API.md`](API.md).
