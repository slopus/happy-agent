# Artifacts

An artifact is finished work published to one global catalog: a Markdown document or an HTML page
with the pictures, styles, scripts, and other files it uses, an image, an ordered series of images,
a video, or a document such as a PDF. Every change makes a new immutable version, every version is
kept, and deletion leaves a tombstone. Each artifact records where it was made — a bot, task,
project, workspace, or bare conversation — and who made and changed it.

```ts
const artifacts = new ArtifactsModule(
    config,
    durableFunctions,
    compute,
    projects,
    workspaces,
    bots,
    tasks,
);
```

Projects, workspaces, bots, and tasks answer where an agent works. Compute reads the files an agent
copies in from its own machine. Durable Functions removes uploads nobody used.

## Bundles

Every version is a small tree of files, each named by a relative `path` such as `index.md`,
`images/chart.png`, or `assets/site.css`, and one of them is the version's `entry`, the file a
client opens. Every file of a version is served under one URL prefix, so a relative reference in
an entry — `![](images/chart.png)` or `<img src="img/hero.jpg">` — resolves to its file without
rewriting.

| Type           | Entry               | Files                                           |
| -------------- | ------------------- | ----------------------------------------------- |
| `markdown`     | `index.md`, UTF-8   | the entry and up to 255 other files of any kind |
| `html`         | `index.html`, UTF-8 | the entry and up to 255 other files of any kind |
| `image`        | its one file        | one image                                       |
| `image_series` | the first file      | 1–64 images, shown in path order                |
| `video`        | its one file        | one video                                       |
| `document`     | its one file        | one document                                    |

`ARTIFACT_TYPE_RULES` holds each type's entry, media types, file counts, and size limits; a new
type is one more entry there. A file's media type comes from its path's extension alone
(`artifactMimeTypeForPath`), `application/octet-stream` when the extension is unknown. Manifests
are kept in path order by Unicode code point. Paths are `/`-joined segments of 1–255 characters,
none empty, `.`, or `..`, with no `\` or control characters, so no path can name anything outside
the artifact; a version never holds a file at a path another of its files uses as a folder.

## Backgrounds

Clients show an artifact on a transparent slot, so the surface around it shows through. A version
may name a `background` instead, a hex colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) stored in
lowercase and nothing else, for content that needs one fixed canvas. It is part of the version, so
an older version keeps the canvas it was made for, and a new version keeps the latest one's unless
the change names another or clears it. The catalog row mirrors the latest version's.

## Display

A version may name how its author wants it shown in a chat: `inline_compact`, `inline_expanded`,
or `side`; absent leaves it to the client. It behaves exactly like a background: part of the
version, kept by a new version unless the change names another or clears it with `null`, mirrored
on the catalog row. Only agents set it, through `create_artifact` and `update_artifact`.

## Versions

Every version has an integer `number`, its identity everywhere, and a `major.minor` label. The first
version is 1.0, and every change makes the next minor of the same major. `update` with `major`
makes that version `major.0` instead: `major` must be exactly one more than the latest major, and
the latest version must be a minor one, so a major version always follows a change. Migration
`004-artifact-version-labels` labelled versions made before labels existed 1.0, 1.1, and so on.

## Writing files

Agents write an artifact's files with tools of their own that work directly on the catalog. There
is one copy, the catalog's, and nothing on any machine to sync, so the tools are the same for every
agent whatever model or harness runs it, including agents whose file tools Happy Agent does not
execute. They follow the file tools agents already know: `write_artifact_file` writes a whole text
file, `edit_artifact_file` replaces exact text the way `Edit` does, with the same uniqueness rule
and `replace_all`, and `read_artifact_file` reads numbered lines with `offset` and `limit`. Binary
files and files an agent built with the shell arrive with the `fromPath` files of
`create_artifact` and `update_artifact`, read through the agent's own machine.

Each writing call makes one minor version through `commitFileChanges`, keyed by the call ID, so a
call repeated after a restart finds its version and changes nothing; the tools check that with
`madeByOperation` before reading anything, since an edit replayed against text it already changed
would otherwise fail. An edit reads the latest text with `readText` and names the revision it read,
so a version someone made meanwhile refuses the edit instead of being undone. A file written
exactly as it is makes no version. One agent makes at most
`MAX_AGENT_ARTIFACT_VERSIONS_PER_HOUR` (100) versions of one artifact in an hour through its tools,
so a model stuck repeating an edit cannot bury an artifact's history.

Writing an artifact the agent created itself is never reviewed. Writing one someone else made —
another agent or a person — publishes a version everyone sees: Auto reviews it, Workspace write
refuses it, and Full access allows it. Read only refuses every write, creation included. None of
this needs the agent's machine, so only a `fromPath` crossing the workspace boundary is lent Full
access.

## Tools

Every agent gets eight tools. The author and source of a change are always the calling agent and
the place it works in, found by `actorFor`.

| Tool                  | Behavior                                                                                                                                                                                        | Auto review                                                                      | Durability                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| `create_artifact`     | Issues the ID and makes version 1.0. A Markdown or HTML artifact starts from a short entry; `files` copies files from the agent's machine in, which an image, series, video, or document needs. | Only when a `fromPath` crosses the workspace boundary.                           | Durable; the artifact ID is kept in the call's KV.  |
| `write_artifact_file` | Writes one whole text file, adding it or replacing the one at that path.                                                                                                                        | Only for an artifact the agent did not create.                                   | Durable; the call ID is the version's operation ID. |
| `edit_artifact_file`  | Replaces exact text in one text file of the latest version.                                                                                                                                     | Only for an artifact the agent did not create.                                   | Durable; the call ID is the version's operation ID. |
| `update_artifact`     | Changes the title, background, or display, copies files in with `fromPath`, removes files, and marks a major version.                                                                           | For an artifact the agent did not create, or a `fromPath` crossing the boundary. | Durable; the call ID is the version's operation ID. |
| `list_artifacts`      | Pages the catalog newest first, everything or only what was made `here`, by type, with tombstones on request.                                                                                   | Never.                                                                           | Reloadable.                                         |
| `read_artifact`       | One version's metadata and whole manifest, with a Markdown or HTML entry's first 64 KiB.                                                                                                        | Never.                                                                           | Reloadable.                                         |
| `read_artifact_file`  | One file by path: text as numbered lines, 2,000 at a time from `offset`; raster images shown to the model scaled to 2,048 pixels; other binary files described only.                            | Never.                                                                           | Reloadable.                                         |
| `delete_artifact`     | Leaves a tombstone for everyone.                                                                                                                                                                | Always, because deletion is final.                                               | Durable and transactional.                          |

Agents mention an artifact in their replies by its reference tag, `<happy-artifact id="…"/>`, with
`version="N"` to point at one version. The module's instructions tell every agent so, and
`create_artifact`, `update_artifact`, `read_artifact`, and `list_artifacts` hand back the exact tag.
Clients show the artifact's live title as a link in its place (API.md, "Reference tags").

A successful `create_artifact` or `update_artifact` result also carries an `artifact` presentation
— the artifact's ID, type, title, and the version the call made — which History records with the
call, so the chat shows a card that opens it. `create_artifact` presents the artifact as it goes on
to change, so the versions its file writes make appear there; `write_artifact_file` and
`edit_artifact_file` present nothing of their own. The model is told the card is visible in its own
chat only, not in parent or child chats.

A `fromPath` that leaves the workspace or resolves through a symlink outside it is reviewed and,
when allowed, read with temporary Full access, through Compute's shared `shouldReviewPath`. Files
are read and written one at a time through the agent's own machine, so an artifact made on a runner
or in a container is published by the daemon like any other, and each file is bounded by what its
type accepts before it is read.

## Public operations

- `stageUpload(ctx, bytes)` and `stageText(ctx, text)` receive one file's bytes as an upload.
  `stageFiles(ctx, files)` turns `{ path, text }` and `{ path, uploadId }` descriptions into
  placements, staging each text. Each commits on its own, so call them outside a transaction.
- `create(ctx, { id?, type, title, files, background?, display?, author, source? })` places
  uploads at paths and makes the first version. Repeating `id` returns the existing artifact
  unchanged.
- `update(ctx, { artifactId, expectedRevision?, operationId?, title?, background?, display?, files?, remove?, replaceAll?, major?, author, source? })`
  makes the next version from the latest one's files, background, and display; a `null`
  background or display clears it, and `major` makes it a major version. Unchanged files carry
  over by digest. A repeated `operationId` returns the artifact without making another version.
- `commitFileChanges(ctx, { agentId, artifactId, expectedRevision?, operationId, writes, removes })`
  makes one agent's file changes the next minor version, skipping files written as they were and
  holding the agent to its hourly budget; `readText` and `madeByOperation` serve the tools around
  it. It runs outside a transaction, since it stages uploads.
- `delete(ctx, { artifactId, expectedRevision?, author, source? })` leaves a tombstone; repeating
  it changes nothing.
- `get`, `list`, `listVersions`, and `getVersion(ctx, artifactId, number | "latest")` read the
  catalog. Versions of a deleted artifact are not served.
- `storedFile(ctx, artifactId, number | "latest", path)` returns one file and where its bytes
  are, matching only an exact manifest path; `readFile` reads a bounded window of it.
- `actorFor(ctx, agentId)` decides an agent's author and source; `resolveSource(ctx, input)` checks
  a source a person names and fills a workspace's project.
- `onEvent(listener)` reports `artifact_created`, `artifact_updated`, and `artifact_deleted` after
  commit, each with the artifact, and with the previous artifact and the new version where they
  apply.

Every mutation composes with a caller's transaction and publishes its event only after the
outermost commit.

## Storage

Content lives under the daemon's private `artifacts/` folder, which Config owns:
`artifacts/content/<first two hex digits>/<sha256>` holds each distinct content once, and
`artifacts/uploads/<uploadId>` holds bytes while they arrive. Nothing is ever written into a
working directory.

Four tables hold the catalog: one row per artifact with its latest entry, file count, size,
background, display, indexed source and creator, and revision; one row per version with its title,
entry path, background, display, author, source, and the operation ID that made it; one row per
version file keyed by path, indexed by digest; and one row per upload, whose size, digest, and
UTF-8 flag stay empty until its bytes arrive. The artifact and version rows carry the `major.minor`
labels.

An upload is recorded together with the durable call that removes it before any of its bytes are
written. The bytes are written, synced, hashed, and checked for UTF-8; the digest is recorded; and
only then are the bytes renamed into content storage, or dropped when that content is already
stored. Placing an upload deletes its row and cancels its removal in the same transaction as the
version. An unused upload expires after 24 hours: its row and file go, and its content goes too
unless a version file or another upload holds the same digest. A refused upload is removed at
once. Deleting an artifact keeps its content on disk.

## HTTP

The API module serves the routes `packages/happy-agent/API.md` specifies: `/v0/artifacts` and
`/v0/artifact-uploads`, with file bytes under
`/v0/artifacts/:artifactId/versions/:number|latest/files/*path`. A person's change is authored as
the authenticated user and names its source only when the request does; the API turns
`onEvent` into `artifact.created`, `artifact.updated`, and `artifact.deleted` for every connection.

## Data for HTML apps

An `html` artifact can keep live, shared data through the Artifact Data module
(`../artifactData`): one key-value store per artifact ID, shared by every version and everyone
using the daemon, in `artifacts/_data_/<artifactId>/kv.sqlite`, served to the page at `/api/*` of
its own origin. That module listens to `onEvent` to close a deleted artifact's change streams and
asks `get` whether an artifact still serves data. The writing tools' guidance points agents at
`docs/recipe/artifact-apps.md` and tells them to put no files under `api/`, to try an app with
`happy-agent artifact dev` before publishing, and to read `read_artifact_logs` after. Its debug
log, `logs.sqlite`, sits beside the store and records each report with `latestVersion` at the time.
