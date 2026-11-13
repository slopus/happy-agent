# Attachments

Files people attach to their messages. The wire shape is Happy Cloud's conversation attachments,
extended with chunked uploads and cancelling.

```ts
const attachments = new AttachmentsModule(config, durableFunctions, chatMedia, computeModule);
```

Configuration owns the private attachments folder. Durable Functions runs the hourly maintenance
pass. Chat media classifies and measures a finished file the same way it measures a presented one.
Compute is the agent's machine, where `read_attachment` saves a copy when asked.

## Flow

```text
PUT /v0/agents/:id/attachments?name=           whole body ─▶ uploads/<fileId>, hashed as it arrives
PUT /v0/agents/:id/attachments/:sha?name=      Content-Range chunk ─▶ uploads/<fileId> at its offset
        │   (any order, in parallel; one request at a time merges the range into the upload row)
        │ last missing byte: hash == :sha?  no ─▶ 409 hash_mismatch, upload discarded
        ▼
  chatMedia.describe (AVIF stays a file) ─▶ <agentHome>/attachments/content/<sha[0..2]>/<sha>   row (agent, sha)
        │
POST /v0/agents/:id/send { content: [{ type: "file", attachment: sha, name }] }
        │ send(): each must be a live attachment of this conversation ─▶ sent, never expires
        ▼
  history block { type: "file", attachment, name, mimeType, size, kind, width?, … }
  model input   "[Attachment <sha>: "name", mime, size. Open it with read_attachment.]"
        │
GET    /v0/agents/:id/attachments/:sha          bytes; Range, ETag, immutable cache
DELETE /v0/agents/:id/attachments/:sha          cancel an upload or discard an unsent attachment
```

- An attachment's ID is the SHA-256 of its bytes, keyed per conversation. Uploading the same
  bytes again answers the same attachment and keeps an unsent one another 24 hours.
- A chunk is written at its own offset with no lock, then fsynced. Only the bookkeeping, merging
  its range into the upload row and finishing, runs one request at a time per ID. A chunk whose
  body has the wrong length adds no bytes. Every request carrying bytes is counted against its
  upload under that lock before it writes, and the 4,097th is refused. Each upload gets a fresh
  private file, so a chunk still writing when its upload is cancelled lands in a file nothing
  reads.
- `Content-Range: bytes */size` with no body starts the upload when there is none and answers
  where it stands; any request for an ID the conversation already holds answers the attachment
  without reading the body.
- The API stores the blocks `send` returns in the pending row, which History records as the
  accepted message's blocks; Agent Base receives a text note in place of each file.
- Unsent attachments and unfinished uploads expire 24 hours after they last received bytes.
  Anyone who may send to the agent may upload, send, and cancel; anyone who may read the
  conversation may download. Sent attachments cannot be removed yet.
- Content is stored once per digest across conversations. Every time a digest might become unused
  it gets a garbage row; `collect` deletes the bytes only when no attachment row still holds the
  digest. Storing and collecting share one in-process lock, so a digest is never deleted between
  storing it and recording the row that holds it.
- `maintain` runs every hour as the durable `attachments.maintain` chain. It discards expired
  attachments and uploads, collects garbage, and deletes upload files older than a day that no
  upload owns, such as an interrupted whole-file upload. Erasing an agent deletes its rows and
  notes their digests as garbage. Archiving keeps everything.

## The tool

`read_attachment { attachment_id, path?, overwrite?, offset?, limit? }` reads a sent attachment of
the agent's own conversation from the daemon's copy. Images are shown, fitted to 2000 px and at
most 3 MiB; UTF-8 text up to 1 MiB comes back as numbered lines, at most 2000 lines or 60,000
characters per read; any other file is described.

With `path`, the tool also saves a copy there on the agent's machine through Compute, so local,
runner, and Docker agents all get a file their own tools can open. Relative paths start from the
working directory, and missing folders are created. The write runs under the turn's permissions,
so the sandbox decides in Read only and Workspace write, and in Auto the tool asks for review, then
full access, exactly when Compute says a write to that path needs it. An existing file is replaced
only with `overwrite: true`, and files over 512 MiB are not copied. Without `path`, nothing is
written.

## Tables

- `happy_agent_module_attachments`: one row per conversation and digest. `sent_at` is null until
  a message sends it, and `expires_at` is null after.
- `happy_agent_module_attachment_uploads`: one row per chunked upload still missing bytes, with
  its merged byte ranges, how many requests carried bytes to it, and the private file they
  accumulate in.
- `happy_agent_module_attachment_garbage`: digests that may have become unused, and when they may
  be deleted.
