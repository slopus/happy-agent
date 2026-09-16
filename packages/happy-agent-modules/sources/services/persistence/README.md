# Service persistence

`ServiceRecords` receives the module's shared AgentKV. It owns complete transactional reservation,
update, admission-close, and catalog-read operations; it opens no database and creates no SQL schema.

```text
service ID -> one metadata/execution record
owner      -> immutable workspace ID -> bounded active records for abort decisions
workspace  -> bounded header: active IDs, admission state, creation sequence
           -> 256-ID history pages -> bounded point reads of service records
```

The history index is append-only. A monotonic creation timestamp keeps its order equal to the API's
newest-created order even during concurrent starts or clock adjustments. Query reads never list a
historical KV prefix. Terminal transitions require the runtime's explicit confirmed-teardown proof;
only then is the active-capacity slot released. Metadata remains after termination.
