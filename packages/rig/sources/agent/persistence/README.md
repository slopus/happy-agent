# Agent persistence

This directory owns the standalone SQLite store used only by
`@slopus/happy-agent-base`.

```text
AgentSystemLocal
        |
     AgentStorage
        |
SqliteAgentPersistence
        |
 .happy/agent/sessions.sqlite
```

The main Rig database remains separate and continues to store application
entities such as projects, folders, documents, and protocol session metadata.
There is no migration or fallback from the old Rig conversation tables.
