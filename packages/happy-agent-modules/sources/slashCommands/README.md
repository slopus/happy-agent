# Slash commands module

`SlashCommandsModule` merges the ordered command definitions returned by its contributing modules.
It keeps the owner and optional image bytes private while exposing lightweight public descriptors,
refreshes discovery when agents start and turns begin, and records a complete replacement event
when either descriptors or image content change.

```text
Compactions ─┐
             ├─> SlashCommandsModule ─> API catalog, events, image bytes
Skills ──────┘              │
                            └─> direct invocation on the owning module
```

Invocation always refreshes first, resolves the command's owning module, and calls that module's
public `invokeSlashCommand` operation directly. The dispatcher does not interpret names or kinds.
