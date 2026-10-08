# Terminals — learnings

## Closing a terminal is instant and violent

`stop` used to send the hangup and then wait for the process to exit, with no bound. A shell that
stays through the hangup held the request open forever, and because an HTTP mutation holds the
daemon's drain open, one stubborn terminal could leave a daemon draining and never finishing.

Closing a terminal is now immediate: `kill` sends `SIGKILL`, with no grace period and no polite
first ask, so the terminal is gone the moment the user closes it. `stop` waits only for the kill
to be reaped, and after two seconds fails with `unavailable` instead of waiting. Disposing a
terminal ignores that failure so a folder, a workspace, or a shutting-down daemon still closes.

## Archiving must not wait for shells to die

`closeScope` and `closeProject` existed but nothing called them, so archiving a workspace left its
shells standing in a folder that was about to be deleted. They are now driven from the two catalogs'
archival events — the catalogs still know nothing about terminals.

The subscription must not be awaited by the archival, though. Both catalogs invoke post-commit
subscribers with `await`, and disposing a terminal can take the full two-second reap timeout per
session, so an archival that awaited its closures would answer minutes late for a folder full of
stubborn shells. Each closure is started and tracked instead, and `close()` waits for the tracked
set so shutdown still ends only once they are done.

Closing behind the archival opens a race with `create`, which resolves its folder and starts a
pseudo-terminal without holding the scope lock. A collection therefore knows it has been disposed,
and a session that arrives after that is disposed and refused rather than joining a collection
nobody holds. Closing takes the same lock that installs a collection, so the two orders are the
only two possible, and neither leaves a live shell in an archived folder.

## A terminal runs on its folder's machine

Terminals used to spawn a pseudo-terminal on the daemon's machine, through node-pty under Node and
`Bun.Terminal` under Bun. Once folders can live on runners, a shell on the daemon would stand in a
folder that is not there. A terminal is now one of the folder's machine's product programs: the
module asks the runners module for that machine — this one, or the runner holding the folder — and
starts the shell with `processes.start` under a terminal. Local and runner terminals share that one
path, and the module carries no pseudo-terminal code of its own.

The compute starts terminals only under Bun, the runtime the Happy Agent binary runs on; node-pty is
for the gym's own harness, not the product. Without a named shell, a POSIX machine runs its own
`$SHELL`, which only that machine knows, so the terminal starts `/bin/sh` and execs it there.
