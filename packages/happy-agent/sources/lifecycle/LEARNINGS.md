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

## Runtime restarts must hide their Windows console

The safe Bun runtime restart inherited its caller's standard streams but omitted
`windowsHide`. A desktop launch can have no visible terminal, so stream inheritance
alone does not keep a Windows console application hidden. The restart now explicitly
hides its console while preserving arguments, JIT settings, signals and exit status.
Git probes and other background launchers still need their own hiding options; a
parent's launch options do not apply automatically to later child processes.

## Reload must outlive the daemon it replaces

A session ran foreground `happy-agent reload` while adding a provider account. Draining waited
for the session, then API shutdown stopped the daemon without starting its replacement. Desktop
returned 502 until an independent caller restarted the selected binary. Session-owned processes
die with their daemon, so reload now checks the caller's process ancestry before draining and
rejects a caller owned by the target daemon. An unavailable ancestry check also leaves it running.
External reloads still wait for shutdown and replacement readiness. Preserve the database and
verify session progress after recovery; a working session may legitimately await a question.

## A runtime safeguard needs verification against the installed build

Bun 1.4.2 passes the reduced optimizer regression that crashes Bun 1.4.0. That
result did not establish that the live daemon was fixed: later crash reports
reached the same exception assertion through both the baseline JIT and the
interpreter. Disabling baseline, DFG, and FTL prevents those JIT tiers from
running; it does not prove that all native crashes are resolved. The settings
must be present before VM initialization, which is why the CLI re-executes.

The incident was reproduced in the native working-tree watcher's missing-directory
cleanup: it released JavaScript references on a worker thread and corrupted later
runtime operations. Parcel now carries a pnpm native patch that finalizes those references
on their owning JavaScript thread, and the temporary macOS built-in watcher fallback is
removed. The runtime upgrade and JIT guard alone could not fix the dependency's cleanup.

Verify the selected managed executable, its build revision, resolved published
SDKs, and native binding before testing a recovery. Reloading an older local
binary does not pick up fixes synced to main. A Node source launch also uses its
installed native addon, while a standalone build embeds the separately built
addon. These are different artifacts until their identities are checked.

Verify authenticated profile and project requests and the actual Desktop view,
then observe real session work. A health response or a short transport smoke
alone cannot establish recovery from an intermittent native crash. Preserve the
live database and reproduce against an isolated copy whenever possible.
