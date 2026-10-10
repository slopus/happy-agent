# Native daemon lifecycle helpers

Detached reload starts the same Happy Agent executable in its own Unix session:

```text
reload --detach -> private verified handoff -> caller exits -> graceful reload
```

The private worker verifies its live parent, executable, process start identity, session,
and exact daemon instance before acknowledging the caller. This allows a Linux subreaper
daemon to adopt the orphan without weakening the ordinary foreground reload ancestry guard.
Windows follows Source and requires reload from an independent terminal.

`schema-export.mjs` captures the private TypeBox handoff schema in `schemas.json` for the
native validator. This is an internal process protocol, outside the public Agent API.
