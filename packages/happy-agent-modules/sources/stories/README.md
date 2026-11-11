# Retired Stories

Stories has been removed from the runtime, API routes, tools, and prompts. Activity is a better
version of Stories today. A Stories-like feed may return for the latest updates in Activity.

Only the immutable released migration definitions remain here, covered by the migration-history
test. The runtime does not register this module or run these migrations. Existing Stories rows,
the migration ledger, and media are left untouched. Historical message quotes and their still
frames remain readable through History and the message API. Published client protocol types
remain available for older daemons.

```text
runtime -> Activity / Feed
history -> historical story quotes -> chat-media snapshots
stories/storyMigrations.ts -> historical migration tests only
```
