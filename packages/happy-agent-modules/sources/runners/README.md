# Runners

`RunnersModule` owns the runners this installation works on. A runner is a separate machine that
holds project folders and runs everything that touches them, while this daemon keeps the database,
provider credentials, and inference. The protocol between them lives in
`@slopus/happy-agent-compute` (`sources/runner/README.md`); this module is the daemon's side of it.

`[runners.<id>]` in machine `happy.toml` lists each runner with a name and a fixed token, and
`[runners] default` picks the one new folders go to. `default = "local"` keeps this machine the
default instead: folders that name no runner stay here, and only folders created with a `runnerId`
go to a runner. `local` is reserved and cannot name a runner. The configuration module validates
the entries; this module only reads them. There is no join step: whoever deploys a node writes the
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

- `localExecution` — false once a runner is the default: nothing runs on this machine then, and
  `assertLocalExecution()` refuses with `409 local_execution_disabled`. It stays true with no
  runners, or with runners and `default = "local"`.
- `defaultRunnerId` / `place(runnerId?)` — the runner a new folder goes to: the one named, the
  default runner, or none, which means this machine.
- `machine(runnerId?)` — the machine Happy's own work on a folder runs on: this machine when no
  runner is named (refused while a runner is the default), or the runner's product machine. Folder
  management, setup commands, Git, terminals, file reads and watches, the workspace proxy, and
  MCP stdio servers are each written once against this compute, whichever machine it is. A
  runner's machine is created once and kept.
- `run(ctx, runnerId, options)` — one bounded program on that machine, for Git and copying.
- `agentMachine(ctx, …)` — one agent's machine in its workspace folder, optionally in a Docker
  container on the runner. Agent commands never run on the product machine.

## Runners on other operating systems

A runner may run macOS, Linux, or Windows whatever the daemon runs. `platform(runnerId?)` is the
platform the runner last reported, and `paths(runnerId?)` the matching `node:path` rules —
`path.win32` for a Windows runner, `path.posix` otherwise. Every path on a runner is joined, split,
and compared with these, never with the daemon's own `node:path`, and folders are laid out the way
that platform lays out a local installation (`Happy\Projects`, `happy\workspaces`, and so on on
Windows). `environment(runnerId, cwd)` is the `AgentEnvironment` an agent in such a folder is given:
the runner's platform, so its system prompt carries that platform's guidance — PowerShell for
Windows — rather than the daemon's.

Runners speaking protocol 3 also report their operating system release and shell in `ready`. The
daemon will store and use them once it depends on a compute release that carries them; until then
the environment names the platform (`Windows`, `macOS`, `Linux`) and leaves the shell to the
platform's guidance.

Work on a runner that is not connected, or no longer configured, fails with
`RunnerUnavailableError`, which the API reports as `503 runner_unavailable`. A request whose
connection ended before the runner answered fails with `RunnerDisconnectedError`, which the API
reports the same way. Nothing falls back to this machine. `assertConnected(runnerId)` is for callers
that would otherwise answer from something read a moment ago, or cannot tell a failed read from a
missing runner — Git's snapshot cache and its scans.

## Noticing a runner that is gone

Either side that stops on purpose says goodbye. `close()` sends it on every link first, waits up to
`RUNNER_CLOSE_FLUSH_MS` for each runner WebSocket to finish closing, and only then disposes its
machines; the runner releases everything at once and starts reconnecting. A runner stopped with
`SIGTERM` does the same in `happy-agent runner`, and closes its Tailcat carrier only after its own
WebSocket has closed. The daemon's Tailcat exposure is closed only after this module, so the
goodbye leaves through it. A goodbye is seen within about a second on either side.

A silent loss — a cable, a sleeping laptop, a relay that stops forwarding — is noticed by the ping
both sides send every `RUNNER_PING_INTERVAL_MS` (5 s) and the idle timeout `RUNNER_IDLE_TIMEOUT_MS`
(20 s) after which a silent connection is closed: at most about 25 s, inside the 30 s an HTTP
request waits. The constants live in `liveness.ts` so the daemon and the runner agree on them.

A call made right after a runner went away still waits up to ten seconds for it to come back, as
`createRunnerCompute` bridges a brief drop; a runner that is away longer than that fails every call
at once.

## Parity with this machine

Every API reads and changes a runner folder, or a workload user's folder, the way it does a folder
here, written once against `machine(runnerId)`. Where this machine has a native fast path, the
runner's own facility does the same job.

| Feature                               | On a runner or as a workload user                                                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File read, write, tree, revisions     | Same calls on the folder's machine.                                                                                                                                                                                                       |
| File search                           | The runner lists the folder with Git's ignore-aware `ls-files` and the daemon ranks it (`MachineFileIndex`), in place of the FFF index. A file created through the API refreshes the listing.                                             |
| `files.updated`                       | One recursive watch per folder on the runner, shared with live Git (`GitModule.watchWorkingTree`). A directory inside a skipped tree, such as `node_modules/x`, gets a watch of its own while it is shown.                                |
| Git snapshot, `GET …/git`             | Scanned on the runner with the hardened scanner, including untracked line counts and binary bytes read through the runner's filesystem. Used to be `404`.                                                                                 |
| `POST /v0/git/watch`, `git.updated`   | Tracked like a local folder, driven by the runner's watch of the working tree and of the Git directory (HEAD, index, refs, packed-refs, the common directory of a worktree). Fingerprint stale checks unchanged. Used to be absent.       |
| Happy integration Git state           | Scanned on the folder's machine. Used to be refused.                                                                                                                                                                                      |
| Worktrees, clones, branch renames     | Run on the runner with its own Git authentication.                                                                                                                                                                                        |
| Terminals, processes, workspace proxy | Run on the runner. The native Bun proxy fast path is this machine's only.                                                                                                                                                                 |
| MCP stdio servers                     | A folder's own and the user-wide servers run on the runner of the agent's folder, one process per server and runner, without the SDK's restricted-environment transport. HTTP servers, `localhost` included, are reached from the daemon. |
| Port bridges, both directions         | Available. A `workspaceToLocal` listener is the runner's own, admitting only the runner's user on Linux; needs runner protocol 4.                                                                                                         |
| USB and Bluetooth bridges             | `runner_compute`, permanently: "USB and Bluetooth are not supported on runners." Clients hide them.                                                                                                                                       |
| Secrets attached to commands          | Resolved on the daemon and sent with that one command (`forwardAttachedSecrets`); the runner forgets them once the process has spawned. Needs runner protocol 4. Containers still refuse.                                                 |
| Workspace services                    | Retired product-wide (the routes answer `501`), so not built for runners.                                                                                                                                                                 |
| Runner loss                           | `503 runner_unavailable` on every route, including a request cut off mid-way and a Git snapshot served from cache.                                                                                                                        |

## Attached secrets on a runner

Steve confirmed that runners receive attached secrets, forwarded per request. A command on a runner
machine, or on a workload user's runner, that selects secrets is resolved by the daemon when it
starts (`compute/impl/forwardAttachedSecrets.ts`), and only that command's `shell.run` or
`shell.startSession` request carries the values, as its `environment`. The guarantees, each covered
by `tests/compute/impl/forwardAttachedSecrets.test.ts`:

- The runner writes the values nowhere: not to disk, its log, or its private state. Its handler
  empties the request's environment once the process has it, the host shell scrubs its merged
  copy after the spawn, and the runner logs no request's parameters.
- Nothing is cached between commands. Each command gets exactly its own selection; a concurrent or
  later command that selected other secrets, or none, never sees these. Every other attached
  secret's variable is sent as a removal, so the runner's own environment cannot stand in for one.
- Nothing is resent. A request in flight when its connection drops fails as an unknown outcome and
  is never replayed — not after a reconnect, and never to another runner, since a machine belongs
  to one runner's link. The agent decides whether to run the command again, which resolves the
  selection afresh.

While a command runs, its values live in its process, readable by the runner's user and root
there, as on any machine.

## Work as separate Linux users

`[execution]` in machine `happy.toml` names the Linux user agent work runs as on this machine, and
`[execution.bots.<botId>] user` gives specific bots a user of their own. For each user, the module
starts a local runner through sudo — `sudo -n -u <user> -- <executable> runner --stdio`, built by
`impl/sudoRunnerCommand.ts` with a fixed `PATH` and nothing else from the daemon's environment —
and speaks the same runner protocol over its standard input and output (`stdio.ts`, a 4-byte
big-endian length before each frame). `impl/LocalUserRunner.ts` owns that process: it starts it on
first use, explains why it would not start, and restarts it with backoff if it stops later.

Before any work runs there, the module runs `id -un` on the runner and stops it unless the answer
is the configured user; a user that is the daemon's own is refused. The default user's runner is
started while the daemon starts, so a missing sudo rule shows up in the log at once, but a failure
does not stop the daemon.

Nothing about this is visible in the API: folders stay on this machine with no runner, and
`native(runnerId?)` is what other modules ask before taking a fast path that works in the daemon's
own process. It is true only when no runner is named and `[execution]` is not configured.
Otherwise `machine()` returns the default user's product machine, `machineHome()` its home
directory (which is where new folders go), and `localAgentMachine()` an agent's machine as the
user `userFor(ctx, agentId)` chooses. `BotsModule` binds bots to users with `bindBots` while it
starts and `bindBot` as each bot is created; until then `userFor` refuses rather than guessing.
A runner that will not start fails the work with `RunnerUnavailableError`, whose message names the
user and the reason. Nothing falls back to the daemon's user.
