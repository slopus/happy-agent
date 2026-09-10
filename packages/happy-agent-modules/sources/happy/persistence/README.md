# Happy mobile persistence

Personal-connection migrations retain standalone records under the empty owner and make the
authenticated team user part of every connection, project, session, and outbox storage key.
Existing migration bodies remain unchanged.

```text
owner → integration state
      → project bindings
      → agent sessions → delivery outbox
```
