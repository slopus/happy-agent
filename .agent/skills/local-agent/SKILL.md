---
name: local-agent
description: Build, install, select, and reload Happy Agent from this checkout, or switch back to the latest released Agent. Use when asked to link, relink, install, reload, or stop using a local Happy Agent build.
---

# Local Happy Agent

Run checks before installation, then from the repository root run:

```bash
pnpm link:global
```

This builds the checkout, globally links Happy Terminal, installs and selects Agent version
`0.0.0`, and runs its `happy-agent reload --detach`. The graceful reload starts once that command
exits and logs to `~/.happy/agent/reload.log`.

Make `pnpm link:global` the turn's final tool call and return immediately after it. Do not poll the
reload from the agent being reloaded.

To switch back, use Happy Desktop's Agent version picker to download or select the latest release.
No unlink script is needed.
