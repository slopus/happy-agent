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

## Use the runtime's own PTY

Loading node-pty's native binding in a compiled Bun executable is not enough: its JavaScript layer
depends on Node TTY stream behavior and can terminate otherwise healthy children immediately. Node
uses `@lydell/node-pty`; Bun uses `Bun.Terminal` and `Bun.spawn`. Bun applies terminal-protocol
backpressure by stopping and continuing the child process because `Bun.Terminal` has no read-pause
operation.
