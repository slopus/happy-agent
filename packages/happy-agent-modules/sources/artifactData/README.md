# Artifact data

Realtime key-value data for HTML artifacts, so a page can be a small shared app: a to-do list, a
poll, a board. Each artifact has one store. Every version of the artifact uses it, and so does
everyone using the daemon: every device and client, and in team mode every member.

```ts
const artifactData = new ArtifactDataModule(config, artifacts, profile, team, bots);
```

Config names each store's file. Artifacts says whether an artifact still serves data, and tells
the module when one is deleted. Profile and Team say who the caller is, and Bots names the agents
that write.

## Tools

| Tool                  | Behavior                                                                                                                                    | Auto review | Durability                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------ |
| `read_artifact_data`  | One key with up to 64 KiB of its value, or a page of keys under a prefix with 4 KiB of each value, each with its version, author, and time. | Never.      | Reloadable.                                |
| `write_artifact_data` | Sets a key from JSON text or deletes it as the calling agent, optionally only at a version (`ifVersion`) or while absent (`ifAbsent`).      | Never.      | Durable; the call ID derives the write ID. |
| `read_artifact_logs`  | The artifact's debug log, newest first, filtered by least severe level, user, and time, with each reporter's name and the version then.     | Never.      | Reloadable.                                |

An agent's writes carry `agentAuthorId(agentId)`, a stable opaque ID, as `updatedBy`. The store
remembers which agent is behind it, so `users` resolves it within that artifact to the agent's bot
name, or "Agent", with `kind: "agent"`; the agent's own ID never reaches a page.

## Storage

`impl/ArtifactDataStores` is the one engine behind both the daemon and the development server: it
opens each artifact's files, serializes calls per file, delivers committed changes, and bounds the
debug log. The module adds only whether an artifact serves data and who the callers are.

Each store is its own SQLite file in WAL mode with full sync, at
`artifacts/_data_/<artifactId>/kv.sqlite` (`ConfigModule.artifactDataPath`), outside the main
database. A file is created by the first write; reading a store nobody wrote to creates nothing.
A deleted artifact's file stays on disk. At most 32 files are open at once; the least recently
used one closes first.

A store holds one row per key (a tombstone has a `NULL` value), one row per remembered write ID,
and `meta` with the newest version minted, the tombstone horizon, and live key and byte counts.
Every write commits its entry, its write record, the counters, and any pruning in one transaction.

## Versions

Each write mints a UUIDv7 from the store's persisted high-water mark, so versions keep increasing
across restarts and clock rollback. A version orders changes, resumes a change feed, and carries
the write's time in its first 48 bits; `updatedAt` is that time.

## Public operations

- `get`, `list`, and `changes` read one key, live keys by prefix in key order, and changed keys
  after a version in version order (tombstones included, each key once as it is now). Each also
  returns the store's cursor from the same snapshot.
- `set` and `delete` take an author (a user ID, or an agent ID), an optional `writeId`, and an optional condition
  (`ifVersion` or `ifAbsent`). A write ID repeated by the same user within 24 hours answers its
  first result with `replayed: true`. A failed condition throws `ArtifactDataConflictError`
  carrying the current entry.
- `subscribe(artifactId, listener)` hears each committed change in version order, then `closed`
  when the artifact is deleted or the module closes.
- `userId`, `me`, `users(ctx, artifactId, ids)`, and `userPhoto` describe people, and agents
  that wrote, the way a page may see them.
- `clientScript()` is the browser SDK served at `/api/v1/client.js`.
- `impl/artifactStandardFiles.ts` holds the standard styles (`/api/v1/style.css`), components
  (`/api/v1/components.js`), and the diagram renderer they load (`/api/v1/diagrams.js`), which
  every artifact page may load and which do not depend on the store. The renderer is Beautiful
  Mermaid, bundled into `impl/artifactDiagramsScript.ts` by `scripts/build-artifact-diagrams.mjs`;
  regenerate it rather than editing it. The code renderer `<happy-diff>` and `<happy-code>` use
  is not the daemon's: they import `/api/v1/code.js` from the page's host, which Happy Desktop
  provides, and draw plain numbered lines where it is missing.

- `appendLogs(ctx, artifactId, batch)` keeps a page's report as the caller, with the artifact's
  newest version; `readLogs` reads the log newest first.

Limits are in `ARTIFACT_DATA_LIMITS`: 512-character keys, 256 KiB values, 1 MiB requests,
100,000 keys and 64 MiB per store, 24 hours of write IDs, and 30 days of tombstones.

## Debug log

Pages report problems to `POST /api/v1/debug/log`: the SDK sends uncaught errors, unhandled
rejections, `console.error` and `console.warn`, its own sync trouble, and `happy.debug.log` calls,
in batches it drops rather than retries. Each artifact's log is `logs.sqlite` beside its store, in
WAL mode with normal sync, because losing the last few reports in a crash costs nothing. It keeps
the newest 1,000 entries of the last 7 days, pruned on every append, and accepts 120 entries per
user per artifact per minute (`ARTIFACT_LOG_LIMITS`); the rest are counted as dropped.

## Development server

`ArtifactDataDevelopment` serves one artifact's data from any folder over the same
`ArtifactDataStores`, for `happy-agent artifact dev`. Its callers are made-up people named by the
request (`as` in the context), each with a stable ID derived from the name and a generated SVG
photo. It also dumps, loads, and resets data and clears the log, which the daemon never does.
`ApiArtifactData` serves either one, so the development server answers with the daemon's routes.

## HTTP

The API module serves `/v0/artifacts/:artifactId/api/v1/*` through `ApiArtifactData`, as
`packages/happy-agent/API.md` specifies. A client shows the page at its own origin and forwards
`/api/*` there unchanged. The agent-facing guide is `docs/recipe/artifact-apps.md`.
