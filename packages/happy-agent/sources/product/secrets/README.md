# Native Secrets

This owner implements the installation catalog, immutable direct grants, and command provisioning.
It depends only on Config, Runtime, Durable Functions, and Events. Its six common tools are captured
from the original TypeBox definitions at build time. Runtime validation uses those serialized
schemas; the native owner never starts JavaScript.

```text
API or common tool -> catalog / grants -> original SQLite tables
                           |
                           +-> safe events in the caller's transaction

Compute scope + selected IDs -> resolution -> environment and names to remove
```

`persistence/` owns the three original migrations, catalog updates, grant pagination, and bounded
resolution. `tools.rs` owns permission disclosure and tool execution. `dotenv.rs` owns bounded,
non-blocking regular-file reads and the native Node dotenv grammar. Tests exercise real SQLite,
restart, rollback, file reads, and the actual common tool definitions.
