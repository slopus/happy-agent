# Daemon launcher

Happy Terminal is a client of the standalone Happy Agent daemon. This module owns only the local launch
boundary: it probes the daemon's Unix socket, starts the selected managed binary, installs a released
executable when nothing is selected yet, and invokes daemon lifecycle commands.

```text
Happy Terminal starts
   |
   +-- live ~/.happy/agent/server.sock --------------------> connect
   |
   +-- ~/.happy/dist/config.json selected binary ----------> start binary
   |
   `-- no selected binary --> latest GitHub release
                                |
                                `-- ~/.happy/dist/version/<version>/happy-agent
```

Downloads are streamed to a unique staging directory and verified against GitHub's SHA-256
digest. A completed version directory and `config.json` each become visible through an atomic
rename. `install.lock` serializes first-run downloads across Happy Terminal processes; the staged install and
atomic config replacement remain safe even if a process exits midway.

Released installations check GitHub for a newer Agent without blocking terminal startup and cache a
successful lookup in `~/.happy/dist/latest.json` for 20 hours. Daemons that do not match the
selected managed binary are never offered a release update. A locally linked `0.0.0` Agent is
offered the published release so `happy-terminal upgrade` can leave the local install. That command
downloads and selects the newest verified release, then crosses the existing `reload` boundary to
drain, stop, and restart the daemon.

The standalone daemon atomically records its process ID at `~/.happy/agent/daemon.pid`. Graceful
`stop` waits for both the Unix socket and that exact process to exit. `happy-terminal daemon kill` reads the
same owner-only file, sends `SIGKILL`, waits for exit, and removes the stale record. `status` reports
a persisted process that is still alive but no longer answers its socket. Named shutdown-step logs
are written to `~/.happy/agent/observation/agent.log`; daemon commands print that path as the
shutdown log.

`reload` is also the replacement boundary used when switching downloaded Agent releases. It gives
the authenticated old daemon five seconds to shut down gracefully. If the old release removed its
socket but kept running, Happy Terminal reports the exact PID it is forcing, sends `SIGKILL`, waits for process
exit, clears only that PID's stale record, and then starts the selected replacement. Plain `stop`
never escalates automatically; the explicit `kill` command remains its recovery path.
