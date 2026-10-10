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

Projects, workspaces, bots, and tasks answer where an agent works. Compute reads the files an
agent publishes from its own machine. Durable Functions removes uploads nobody used.

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

## Tools

Every agent gets six tools. The author and source of a change are always the calling agent and
the place it works in, found by `actorFor`.

| Tool                 | Behavior                                                                                                                                                                                             | Auto review                                            | Durability                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| `create_artifact`    | Publishes a new artifact from `files`: each a `path` with inline `content` text or `fromPath`, a file on the agent's machine. Text defaults to the type's entry path, a copied file to its own name. | Only when a `fromPath` crosses the workspace boundary. | Durable; the artifact ID is kept in the call's KV.  |
| `update_artifact`    | Makes a new version from the latest one: `files` adds or replaces paths, `remove` takes paths out, `replaceAll` starts from no files, `title` renames.                                               | Only when a `fromPath` crosses the workspace boundary. | Durable; the call ID is the version's operation ID. |
| `list_artifacts`     | Pages the catalog newest first, everything or only what was made `here`, by type, with tombstones on request.                                                                                        | Never.                                                 | Reloadable.                                         |
| `read_artifact`      | One version's metadata and whole manifest, with a Markdown or HTML entry's first 64 KiB.                                                                                                             | Never.                                                 | Reloadable.                                         |
| `read_artifact_file` | One file by path: text 64 KiB at a time from an offset, ending on whole characters; raster images shown to the model scaled to 2,048 pixels; other binary files described only.                      | Never.                                                 | Reloadable.                                         |
| `delete_artifact`    | Leaves a tombstone for everyone.                                                                                                                                                                     | Always, because deletion is final.                     | Durable and transactional.                          |

A path that leaves the workspace or resolves through a symlink outside it is reviewed and, when
allowed, read with temporary Full access, through Compute's shared `shouldReviewPath`. Files are
read one at a time through the agent's own machine, so an artifact made on a runner or in a
container is published by the daemon like any other, and each file is bounded by what its type
accepts before it is read.

## Public operations

- `stageUpload(ctx, bytes)` and `stageText(ctx, text)` receive one file's bytes as an upload.
  `stageFiles(ctx, files)` turns `{ path, text }` and `{ path, uploadId }` descriptions into
  placements, staging each text. Each commits on its own, so call them outside a transaction.
- `create(ctx, { id?, type, title, files, author, source? })` places uploads at paths and makes
  the first version. Repeating `id` returns the existing artifact unchanged.
- `update(ctx, { artifactId, expectedRevision?, operationId?, title?, files?, remove?, replaceAll?, author, source? })`
  makes the next version from the latest one's files. Unchanged files carry over by digest. A
  repeated `operationId` returns the artifact without making another version.
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
project or workspace.

Four tables hold the catalog: one row per artifact with its latest entry, file count, size,
indexed source and creator, and revision; one row per version with its title, entry path, author,
source, and the operation ID that made it; one row per version file keyed by path, indexed by
digest; and one row per upload, whose size, digest, and UTF-8 flag stay empty until its bytes
arrive.

An upload is recorded together with the durable call that removes it before any of its bytes are
written. The bytes are written, synced, hashed, and checked for UTF-8; the digest is recorded; and
only then are the bytes renamed into content storage, or dropped when that content is already
stored. Placing an upload deletes its row and cancels its removal in the same transaction as the
version. An unused upload expires after 24 hours: its row and file go, and its content goes too
unless a version file or another upload holds the same digest. A refused upload is removed at
once. Deleting an artifact keeps its content on disk.

## HTTP

`packages/happy-agent/API.md` specifies the artifact routes and `artifact.*` events, and
`@slopus/happy-agent-client` implements them. The daemon routes in the API module wait for that
client to be published, following the API release flow.
