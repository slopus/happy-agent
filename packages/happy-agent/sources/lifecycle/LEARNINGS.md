# Daemon lifecycle learnings

## Supervisor integration tests own a separate process

The crash-and-kill integration fixture ran the supervisor inside the test worker. Lifecycle
commands intentionally ignore a supervisor whose PID is their own, so the fixture skipped the
real stand-down step. Kill cleanup could then consume the stop record before that supervisor
read it, making it restart and hanging the test. Integration fixtures now run the supervisor in
an owned child process, preserving the actual stop-before-kill behavior and verifying both
processes exit. Their bounded timeout includes startup polling and process shutdown.

## Additive protocols do not require replacing a matching daemon

Local readiness and daemon identity checks used exact equality with the SDK's newest protocol,
so a protocol 31 daemon was rejected by its own CLI built against a protocol 30 SDK. Both checks
now accept every protocol from the published minimum, 22, onward. Product-version mismatches
still request replacement, and protocols below the minimum remain incompatible. Feature callers
gate capabilities using their required protocol instead of requiring global protocol equality.

## The daemon starts in the home directory

The detached daemon inherited its launcher's working directory. Happy.app launched from Finder
starts in `/`, so every child that did not name its own directory started there. Claude Code
then read across the whole disk, including other apps' containers, and macOS asked the user
whether Happy could access data from other apps. The daemon now always starts in the user's
home directory, whoever launches it. Children that read their working directory on startup
still need a narrower folder of their own; the home directory only stops the root default.
A consequence is that the local `happy.toml` layer is read from the home directory, not from
the folder `happy-agent start` was run in.

## Background launchers hide their own Windows console

A desktop launch can have no visible terminal, so inheriting a caller's standard
streams does not keep a Windows console application hidden. Git probes and other
background launchers need their own hiding options; a parent's launch options do not
apply automatically to later child processes.

## Reload must outlive the daemon it replaces

A session ran foreground `happy-agent reload` while adding a provider account. Draining waited
for the session, then API shutdown stopped the daemon without starting its replacement. Desktop
returned 502 until an independent caller restarted the selected binary. Session-owned processes
die with their daemon, so reload now checks the caller's process ancestry before draining and
rejects a caller owned by the target daemon. An unavailable ancestry check also leaves it running.
External reloads still wait for shutdown and replacement readiness. Preserve the database and
verify session progress after recovery; a working session may legitimately await a question.

Documentation then told agents they could never reload their own daemon, while a developer reload
script did exactly that with a detached process, so users asking an agent to reload were bounced.
`reload --detach` is now the one supported path: the worker waits for its caller to exit, is
reparented outside the daemon, and passes the same ancestry check. The refusal's hint names it.

## The JavaScript JIT stays enabled

After live crashes in Bun's exception handling, the CLI re-executed itself with the
baseline, DFG, and FTL JIT tiers disabled before loading the daemon. That did not fix
the incident: later crash reports reached the same assertion through the interpreter,
and the cause was the native working-tree watcher releasing JavaScript references on a
worker thread during missing-directory cleanup. Parcel now carries a pnpm native patch
that finalizes those references on their owning thread.

Meanwhile the guard cost every request: the daemon serves all work from one JavaScript
thread, and interpreted code turned schema checks, JSON handling and history
projection into multi-second event-loop stalls on busy team nodes. The settings were
also inherited by every child, so a user's own Bun commands in agent shells ran
without JIT. At the user's direction the guard is removed and the daemon runs with
Bun's default tiers. Bun 1.4.3 is the minimum. Bun 1.4.0 aborts while resuming
optimized async functions after caught exceptions, and `test:bun:runtime` still gates
every platform build on that regression. Bun 1.4.2 crashes the bytecode executable when
a debugger client connects after `/v0/debug/inspector` opened the inspector.

Verify the selected managed executable, its build revision, resolved published
SDKs, and native binding before testing a recovery. Reloading an older local
binary does not pick up fixes synced to main. A Node source launch also uses its
installed native addon, while a standalone build embeds the separately built
addon. These are different artifacts until their identities are checked.

Verify authenticated profile and project requests and the actual Desktop view,
then observe real session work. A health response or a short transport smoke
alone cannot establish recovery from an intermittent native crash. Preserve the
live database and reproduce against an isolated copy whenever possible.

## Reload reports its own phases in reload.json

Desktop could show progress only for updates it ran itself, so a CLI or agent reload looked like a
dead connection. The daemon can't report the gap between stopping and starting. `happy-agent reload`,
including the `--detach` worker, therefore writes `<happyHome>/agent/reload.json` itself. The
file is mode 0600, written to a temporary file and renamed, and carries an operation ID, the
start time, the phase (draining, stopping, starting, done, failed), the daemon's drain report
during draining, and where and why a reload failed. It is rewritten at least every two seconds
while running, so a reader treats a running phase as abandoned once `pid` has exited or
`updatedAt` stops moving. It is never deleted. A refused reload, such as one from inside the
daemon, writes nothing. Writing the file is optional reporting that never fails a reload. The
detached worker's `reload.log` gets timed `reload:phase` lines, and a terminal reload leaves
them out. The daemon also logs `daemon:ready` with its startup time.

## A crashed daemon restarts itself; an intentional stop never does

A native Bun trap killed the detached daemon. Nothing watched it, so Desktop returned 502 until
someone ran `happy-agent start` by hand. On macOS and Linux, `start` now spawns its `run` process
with `HAPPY_AGENT_SUPERVISE=1`, which makes it a crash supervisor: it loads none of the agent
runtime, runs the daemon as its child with that variable removed, and restarts it only after an
abnormal exit, with exponential backoff and a give-up after repeated quick failures that it
publishes in `agent/supervisor.json`.

A supervisor in the same binary was chosen over a LaunchAgent or a systemd user unit. The daemon
depends on the environment its launcher computes, which a unit would freeze to disk; registering a
background item changes login behavior, raises macOS background-item notices, and would happen
again for every versioned binary and every temporary Happy home in tests. The supervisor's own
crash risk is small because the crashes come from the runtime it never loads, but nothing
restarts the supervisor itself.

Exit status alone cannot tell a crash from an intentional forced kill: Desktop and `kill` may
SIGKILL a daemon that is already stopping. The daemon therefore writes its PID to
`agent/stop-intent` synchronously as soon as any shutdown begins, and `kill` writes it too after
standing the supervisor down; the supervisor consumes the record and lets that exit stand. A start
that times out signals the detached process group, so a stalled daemon never outlives the
supervisor that was told to stop. Windows has no process group to do that with and stays
unsupervised until it gets its own mechanism.

## Data a newer release migrated is refused once, never restarted

The desktop app can put an older daemon on data a newer one migrated, through a switch from
preview to stable, a pulled release, or a manual pick. Its migration check threw, `run` exited 1,
and the crash supervisor restarted it with backoff until it gave up. Each `start` then began the
same loop again. The daemon now refuses with `HappyAgentNewerDataError` and exits 65
(`EX_DATAERR`) with "This data was written by a newer Happy Agent (version X); update to
continue." The supervisor treats 65 as final, even after a stop intent: it publishes `refused`
with the stamp's versions and exits 65. `start` and `reload` fail at once with the same message
and status, which is what the desktop's `execFile(start)` sees.

Releases that already shipped cannot refuse cleanly, so `agent/data-version.json` lets the
installer avoid them. `minimumVersion` is raised before the first migration runs, so a crash in
the middle of a migration still leaves older releases blocked. It starts at the first stamping
release's own version, even when that blocks a downgrade that would have worked: keeping a newer
daemon is safe, and handing data to an older one is not. The stamp is advisory only; the
migration ledger inside each database decides. The supervisor and the CLI read the stamp through
`@slopus/happy-agent-modules/data-version`, so neither loads the runtime.

## Every drain says whether the daemon is coming back

A CLI reload looked like a dead daemon to every Desktop window that had not started it: the drain
said nothing about why. The first drain or shutdown of a process now records a drain object at the
API module's single drain entry, before admission closes: `intent` restart or shutdown, a `cause`,
the daemon's own version, and the version a restart will start. `reload`, and its `--detach`
worker, sends restart with the CLI's own version, since the replacement is that executable, with
`update` as the cause when it differs from the running daemon. `stop` sends shutdown; the drain
signal and SIGTERM record shutdown by signal, and `POST /v0/shutdown` without a drain records
shutdown through the API. Health, the stream hello, and `daemon.draining` carry it; nothing is
persisted. Desktop's own installer still drains without a body, so other clients see its restarts
as shutdowns until the Electron host passes an intent. How long a client waits for a replacement
is the client's policy; the daemon promises nothing about it.

## Start replaces a Happy Agent it can no longer reach

A reinstall left a 0.4.86 daemon serving `server.sock` after its `token` and `daemon.pid` were
deleted. Every `start` then wrote a fresh token, database, and runtime settings, spawned a daemon
that exited 1 on the busy socket, and gave up after five supervisor restarts; the old daemon
rejected the new token with 401, `status` said "not running", and `kill` had no PID. Desktop
showed "Starting…" for minutes and then "Can't reach Happy Agent", blocking onboarding.

`start` and `reload` now inspect the socket before writing anything. A listener that rejects the
token on disk, or answers while there is no token, is identified from the kernel's peer
credentials on a connected socket (`LOCAL_PEERPID` and `getpeereid` on macOS, `SO_PEERCRED` on
Linux, through Bun's FFI because neither runtime exposes them). It is stopped only when it belongs
to this user and is a Happy Agent: a `happy-agent` executable, or Node or Bun running a
`happy-agent` package's CLI entry. Its crash supervisor, the parent running the same executable,
gets SIGTERM first; the daemon gets SIGTERM, then SIGKILL after five seconds. The CLI prints and
logs "Stopped Happy Agent X (PID N), which this installation could no longer reach." Anything
else, or a listener that cannot be identified (Node, Windows), is left running and `start` fails
at once with exit 69 (`EX_UNAVAILABLE`) and the PID when known. A daemon that finds its socket
served also exits 69, before touching any state; the supervisor treats 69 as final, and `start`
looks at the socket once more, since another start may simply have won the race. `status`
names an unreachable listener, `stop` refuses it, and `kill` falls back to it when `daemon.pid` is
missing.

A running daemon also checks every 30 seconds that `server.sock` is still the file it bound and
the token file still holds its token. When either is gone or replaced, nobody can reach it, so it
shuts down and its supervisor stands down with the clean exit. Releases before this one have no
such check, which is why `start` must still be able to replace them.
