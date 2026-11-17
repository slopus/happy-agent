# Master plan 29: Windows

## Big picture

Happy Agent runs on Windows as a quiet background program. A person using it on Windows should
never see a console or PowerShell window flash open because Happy Agent started something.

## Hard rule

Every child process launch must go through the shared hidden-window helper; never spawn
directly; no console window may ever be shown.

The helper is `hiddenChildProcess.ts` (`spawnHidden`, `spawnSyncHidden`, `execFileHidden`,
`execFileSyncHidden`). It always sets `windowsHide: true`, and no caller can turn it off. The
published packages cannot share code, so each package that starts programs carries an identical
copy of it.

The one exception is a program started under a pseudo-terminal. It is attached to a console that
has no window, and hiding it would cut it off from that terminal.

## Done when

A window no longer flashes on Windows, fixed centrally rather than one call site at a time, and
it cannot come back: `scripts/windows/hiddenChildProcess.test.ts` fails on any program a shipped
package starts outside the helper, and on any copy of the helper that differs from the others.
