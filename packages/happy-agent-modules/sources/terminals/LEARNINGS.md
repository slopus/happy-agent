# Terminals — learnings

## Use the runtime's own PTY

Loading node-pty's native binding in a compiled Bun executable is not enough: its JavaScript layer
depends on Node TTY stream behavior and can terminate otherwise healthy children immediately. Node
uses `@lydell/node-pty`; Bun uses `Bun.Terminal` and `Bun.spawn`. Bun applies terminal-protocol
backpressure by stopping and continuing the child process because `Bun.Terminal` has no read-pause
operation.
