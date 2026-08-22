# Terminals — learnings

## Closing a terminal is instant and violent

`stop` used to send the hangup and then wait for the process to exit, with no bound. A shell that
stays through the hangup held the request open forever, and because an HTTP mutation holds the
daemon's drain open, one stubborn terminal could leave a daemon draining and never finishing.

Closing a terminal is now immediate: `kill` sends `SIGKILL`, with no grace period and no polite
first ask, so the terminal is gone the moment the user closes it. `stop` waits only for the kill
to be reaped, and after two seconds fails with `unavailable` instead of waiting. Disposing a
terminal ignores that failure so a folder, a workspace, or a shutting-down daemon still closes.

## Use the runtime's own PTY

Loading node-pty's native binding in a compiled Bun executable is not enough: its JavaScript layer
depends on Node TTY stream behavior and can terminate otherwise healthy children immediately. Node
uses `@lydell/node-pty`; Bun uses `Bun.Terminal` and `Bun.spawn`. Bun applies terminal-protocol
backpressure by stopping and continuing the child process because `Bun.Terminal` has no read-pause
operation.
