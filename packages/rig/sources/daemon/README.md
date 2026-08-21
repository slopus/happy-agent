# Daemon launcher

Rig is a client of the standalone Happy Agent daemon. This module owns only the local launch
boundary: it probes the daemon's Unix socket, chooses local source code in a repository checkout,
installs a released executable for a published Rig package, and invokes daemon lifecycle commands.

```text
Rig starts
   |
   +-- live ~/.happy/agent/server.sock --------------------> connect
   |
   +-- Happy Agent source checkout ------------------------> run local sources
   |
   +-- ~/.happy/dist/config.json selected binary ----------> start binary
   |
   `-- no selected binary --> latest GitHub release
                                |
                                `-- ~/.happy/dist/version/<version>/happy-agent
```

Downloads are streamed to a unique staging directory and verified against GitHub's SHA-256
digest. A completed version directory and `config.json` each become visible through an atomic
rename. `install.lock` serializes first-run downloads across Rig processes; the staged install and
atomic config replacement remain safe even if a process exits midway.
