# API persistence

Team composer drafts retain one current value and timestamp per user and agent, separate from
the standalone draft in agent metadata. Clears retain their timestamp to reject stale devices.

```text
Authenticated request → transaction → (agent ID, user ID) draft
                                  → private event after commit
```

The API module owns the migration. Reads and last-write-wins mutations compose with the caller's
transaction; no existing global draft is assigned to a team user.
