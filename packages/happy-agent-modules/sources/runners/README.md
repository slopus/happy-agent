# Runners

`RunnersModule` owns the runners this installation works on. A runner is a separate machine that
holds project folders and runs everything that touches them, while this daemon keeps the database,
provider credentials, and inference. The protocol between them lives in
`@slopus/happy-agent-compute` (`sources/runner/README.md`); this module is the daemon's side of it.

`[runners.<id>]` in machine `happy.toml` lists each runner with a name and a fixed token, and
`[runners] default` picks the one new folders go to. The configuration module validates the
entries; this module only reads them. There is no join step: whoever deploys a node writes the
same token to the node and to the runner.

A runner dials `GET /v0/runners/connect` with its token. The API asks `authenticate` which runner
the token belongs to, refuses anything else before the upgrade, and hands the WebSocket to
`acceptWebSocket`. Each runner has one `RunnerLink` for the life of the daemon process; a newer
connection replaces an older one, and a drop within the lease finds everything where it was.

The public list — names, connection status, the machine each runner last reported, and the
protocol in use — is one persisted snapshot. `getSnapshot(ctx)` reconciles it with configuration
inside the caller's transaction and `onUpdated` fires after commit; the API forwards it as
`runners.updated`. The stored machine report survives restarts, so a runner's home directory is
known before it reconnects.

Other modules ask this one where work runs:

- `enabled` — once any runner is configured nothing runs on this machine, and
  `assertLocalExecution()` refuses with `409 local_execution_disabled`.
- `place(runnerId?)` — the runner a new folder goes to: the one named, or the default.
- `machine(runnerId?)` — the machine Happy's own work on a folder runs on: this machine when no
  runner is named (refused once runners are configured), or the runner's product machine. Folder
  management, setup commands, Git, terminals, file reads and watches, the workspace proxy, and
  MCP stdio servers are each written once against this compute, whichever machine it is. A
  runner's machine is created once and kept.
- `run(ctx, runnerId, options)` — one bounded program on that machine, for Git and copying.
- `agentMachine(ctx, …)` — one agent's machine in its workspace folder, optionally in a Docker
  container on the runner. Agent commands never run on the product machine.

Work on a runner that is not connected, or no longer configured, fails with
`RunnerUnavailableError`, which the API reports as `503 runner_unavailable`. Nothing falls back to
this machine.
