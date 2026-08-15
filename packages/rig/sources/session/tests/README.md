# session/tests

Tests for the session module's top level: the model, both stores, the event log
and the derivations built on top of them.

```
InMemorySession.test.ts             the core model: runs, messages, permissions
InMemorySession.abort.test.ts       aborting a run and its descendants
InMemorySession.configuration.test.ts   model, effort, tier and mode changes
InMemorySession.goal.test.ts        goals and their titles
InMemorySession.mcp.test.ts         MCP servers attached to a session
InMemorySession.messageIdentity.test.ts  stable message and submission ids
InMemorySession.metadata.test.ts    generated titles and summaries
InMemorySession.quota.test.ts       observed provider quotas
InMemorySession.reset.test.ts       resetting a conversation
InMemorySession.rewind.test.ts      rewinding to an earlier message
InMemorySession.runError.test.ts    failed runs and their reporting
InMemorySession.status.test.ts      status and activity transitions
InMemorySession.subagentUsage.test.ts   usage attributed to subagents
InMemorySession.transcriptWindow.test.ts  the window the session exposes

PersistentSessionStore.test.ts      durable store: persistence and restore
SessionEventLog.test.ts             appends, indexes and retention
SessionTerminalTracker.test.ts      attach, focus, heartbeat and sweep
transcriptSince.test.ts             catching a client up from its last message

configureSessionRequest.test.ts     create request validation
generateSessionMetadata.test.ts     title and summary generation
selectRecentSessionEvents.test.ts   trimming an event list to recent messages
sessionActivityAfterEvent.test.ts   activity derived from a single event
sessionSummaryWithTerminalPresence.test.ts  presence applied to a summary
sessionTranscriptWindow.test.ts     events turned into transcript entries

importedSessionCompaction.live.test.ts  live-only, runs against a real database
```

`PersistentSessionStore.test.ts` opens a real SQLite database in a temporary
directory, so it exercises `persistence/session` as well. The live test only runs
under `pnpm test:live` and needs a fixture database plus credentials.
