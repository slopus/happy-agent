# session

Everything Rig knows about a conversation with an agent: the live session model,
the two stores that own sessions, the append-only event log each session keeps,
and the small derivations that turn events into status, transcripts, unread
marks and usage.

The daemon and the HTTP protocol live in `server`. They call into this module;
this module never reaches back into request handling. Database work belongs to
`persistence/session`, so no SQL of any kind appears here.

```
   server (HTTP + daemon)          happy sync          product modules
            |                          |                        |
            v                          v                        v
   +-------------------------------------------------------------------+
   |                              session                              |
   |                                                                   |
   |   SessionStore  <-- interface implemented by both stores          |
   |        ^                                                          |
   |        |                                                          |
   |   InMemorySessionStore          PersistentSessionStore            |
   |   (private in-memory SQLite)    (durable SQLite, the daemon)      |
   |        |                                 |                        |
   |        +--------------+------------------+                        |
   |                       v                                           |
   |                 InMemorySession        product/session facade     |
   |                       |                                           |
   |                       v                                           |
   |                 SessionEventLog        append-only, in memory     |
   |                       |                                           |
   |     +-----------------+------------------+                        |
   |     v                 v                  v                        |
   | sessionActivity   sessionTranscript   usage/                      |
   | AfterEvent        Window              (token and quota totals)    |
   +-------------------------------------------------------------------+
                                  |
                                  v
                        persistence/session (SQLite)
```

## Ownership

`InMemorySession` is the product/session facade. It owns protocol projections and
the non-agent state used by terminals, folders, workspaces, secrets, applets and
other host modules. `RigAgentService` routes agent operations through Agent Base;
`RigProtocolFeature` projects their results into this facade. The facade does not
own inference, compaction, tool execution or an agent run queue.

Every product-state change follows the persistence contract: the database write
happens first through `InMemorySessionPersistence`, and only then does memory
change.

`PersistentSessionStore` implements both `SessionStore` and
`InMemorySessionPersistence`. It is the daemon's store: it restores sessions from
SQLite, writes every event and snapshot through `persistence/session`, and
publishes global events after the transaction commits.
`InMemorySessionStore` implements the same `SessionStore` interface against a
private in-memory SQLite database, so nothing survives the process. Tests and
the gym use it when they need the real persistence contract without durable
state.

`SessionEventLog` is the per-session event history. Events are appended, never
edited, and the log keeps the derived indexes a session needs to answer questions
quickly: message identity, permission reviews, shell command state, provider
quotas, and a retention window over older events.

`SessionTerminalTracker` records which terminals are attached to which session
and which one is focused, so the HTTP layer can report presence and suppress
unread marks for a session someone is watching.

## Layout

```
session/
    index.ts                        the module's public shape
    InMemorySession.ts              product state and protocol projection facade
    InMemorySessionStore.ts         volatile store
    PersistentSessionStore.ts       durable store
    SessionStore.ts                 the interface both stores implement
    SessionEventLog.ts              per-session event history
    SessionTerminalTracker.ts       attached and focused terminals
    SessionConfigurationError.ts    rejected session configuration
    configureSessionRequest.ts      validates and resolves a create request
    isLiveOnlySessionEvent.ts       events that are never persisted
    retriedSession.ts               answers a create whose identity already exists
    selectRecentSessionEvents.ts    trims an event list to recent messages
    sessionActivityAfterEvent.ts    status and activity derived from an event
    sessionSummaryWithTerminalPresence.ts  presence applied to a summary
    sessionTranscriptWindow.ts      turns events into transcript entries
    impl/                           secondary helpers used only in here
    usage/                          token and quota aggregation
    tests/                          tests for the files above
```
