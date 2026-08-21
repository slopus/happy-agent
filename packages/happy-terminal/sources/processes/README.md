# processes

Process lifecycle helpers and the native-process manager. This module owns
starting, observing, and stopping operating-system processes; domain modules
use it without depending on the daemon.

```text
caller
  |
  +--> NativeProcessManager --> child process lifecycle
  +--> isProcessRunning -----> asynchronous liveness check
  +--> isTargetProcessAlive -> synchronous terminal-target check
  +--> waitForProcessExit --> polling boundary
```

`isTargetProcessAlive` is intentionally synchronous because terminal rendering
uses it while deriving the current attachment state.
