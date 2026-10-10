# Daemon lifecycle learnings

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
Bun's default tiers. Bun 1.4.2 remains the minimum because Bun 1.4.0 aborts while
resuming optimized async functions after caught exceptions, and `test:bun:runtime`
still gates every platform build on that regression.

Verify the selected managed executable, its build revision, resolved published
SDKs, and native binding before testing a recovery. Reloading an older local
binary does not pick up fixes synced to main. A Node source launch also uses its
installed native addon, while a standalone build embeds the separately built
addon. These are different artifacts until their identities are checked.

Verify authenticated profile and project requests and the actual Desktop view,
then observe real session work. A health response or a short transport smoke
alone cannot establish recovery from an intermittent native crash. Preserve the
live database and reproduce against an isolated copy whenever possible.
