# Feed

Each person's list of what happened on the installation: new tasks, bots, and Surfaces, new
todos, document edit sessions, and new and changed artifacts. Changes to one subject that the
person has not seen fold into one entry; seeing the subject closes it, so the next change opens
another. The contract is the Feed chapter of `packages/happy-agent/API.md`.

```ts
const feed = new FeedModule(
    durableFunctions,
    team,
    tasks,
    bots,
    surfaces,
    artifacts,
    projects,
    workspaces,
);
```

| Module                   | Why                                                                  |
| ------------------------ | -------------------------------------------------------------------- |
| `DurableFunctionsModule` | `feed.fanout`, one change at a time, and `feed.enroll` after startup |
| `TeamModule`             | Who has a feed, enrollment, and the person a request belongs to      |
| `TasksModule`            | Task creation and permanent deletion, and task cluster names         |
| `BotsModule`             | Bot creation and permanent deletion, and bot cluster names           |
| `SurfacesModule`         | Surface and todo creation, document changes, and Surface names       |
| `ArtifactsModule`        | Artifact creation and new versions                                   |
| `ProjectsModule`         | Project cluster names                                                |
| `WorkspacesModule`       | Workspace cluster names                                              |

## Delivery

Each source module calls the Feed's transactional listener in the transaction that makes the
change. The Feed appends the change to the shared log there and invokes `feed.fanout` with the
single lock key `feed.fanout`, so fan-outs run after commit, one at a time, in log order, and
survive a restart. The fan-out folds the change into every reader it reaches, in one transaction,
and announces the entries to their readers after commit.

A reader is an enrolled member who can sign in (never a guest), or `standalone`. A change reaches
a reader when its audience includes them, none of its clusters is muted, and they are subscribed
to `*` (the default) or to one of its clusters. A reader's own direct change (their user ID, no
agent) folds into their newest entry for the subject and leaves it seen.

Document edits arrive through Surfaces' document-change hook. One edit session per document and
actor records one change, at its first edit; it ends after 10 minutes without that actor's edits.

## Joining and seeding

Members join on profile enrollment, inside that transaction; people already present when the
Feed first runs join through `feed.enroll`. Joining records the newest change in the log, which
fan-out skips for them, and seeds the last 30 days, at most 200 subjects, as seen entries.
Subscribing to a cluster seeds that cluster the same way. Peeking folds the same history without
writing anything.

## Storage

Migration `001-feed`:

- `happy_agent_feed_changes` — the shared log, with the subject, `occurred_at`, and
  `audience_users` (a JSON array, or `NULL` for everyone) as columns for filtering in SQL;
  `happy_agent_feed_change_clusters` indexes each change by cluster. Kept 90 days.
- `happy_agent_feed_items` — each reader's entries. A partial unique index keeps at most one open
  entry per reader and subject. Each feed keeps its newest 1,000 entries within 90 days.
- `happy_agent_feed_readers` — who joined, and the newest change when they did.
- `happy_agent_feed_subscriptions` — each reader's `subscribed` or `muted` choices by cluster.
- `happy_agent_feed_edit_sessions` — the open document edit sessions.

Permanent deletion of a task or bot removes its changes and every entry for it, announcing
`feed.item.removed` to each reader who held one.
