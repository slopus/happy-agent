# Attachments — learnings

## Pictures from the phone must not echo back

A 2 MB picture sent inline moved about 8 MB: base64 up, then again in the send response and in
`message.created`. Kirill asked for raw-byte uploads that a message only references. The file is
uploaded once, and every message representation carries a small `file` block describing it.

## Stay compatible with Happy Cloud

Kirill chose Happy Cloud's shipped attachments as the contract: `PUT /attachments?name=` with the
raw bytes, the SHA-256 of the bytes as the ID, `{ type: "file", attachment, name }` in `send`, and
`GET /attachments/:id` for the bytes. Everything this module adds is additive: `kind` and the image
measurements, chunked uploads, cancelling, and Range and ETag on downloads.

## Small files go whole, large files go in chunks that may run in parallel

Kirill wanted a small file sent in one cluster-style request and anything larger resumable, with a
protocol that allows parallel chunks later. Chunks are addressed by the ID the client computes
before sending, placed by `Content-Range`, and recorded as merged ranges, so they may arrive in any
order. Only the bookkeeping is serialized; the writes themselves are not.

## Both servers share one set of limits

The daemon first allowed 2 GiB files and 256 MiB requests while Happy Cloud allowed 1 GiB and
25 MiB. Kirill aligned the daemon to Happy Cloud: an attachment is at most 1 GiB, one request
carries at most 25 MiB, and an upload takes at most 4,096 requests carrying bytes, counted before
any byte is written, so a client cannot grow an upload's bookkeeping without bound.

## Late writes and rollbacks must not reach stored content

The pre-merge review found two ways stored bytes could disagree with their digest or their rows.
A resent chunk could hold the upload's file open after the last byte arrived and write into the
content stored under its digest, so a finished upload is now copied, and the copy is checked and
stored. Filesystem effects also ran inside transactions a caller could roll back, so a rollback
could leave stored bytes nothing held or remove bytes a restored row still needed; every file
effect now runs after its transaction commits.

Work that runs after a commit is lost in a crash and its failures are only logged, so each one
keeps a durable record until it is done: an attachment row names its unstored file in
`pending_file_id`, and a garbage row stays until its bytes are gone. Recovery and retries store
bytes only after their own transaction commits too. A collection skips its removals when any bytes
were stored since it began; it keeps no per-digest state that a rollback could strand, and the
garbage rows retry it. A finished file is recorded only after rechecking, in the recording
transaction, that its upload is still live and its agent still exists.

A migration, once written, keeps its name and contents even before release: Agent Base checks
applied migration names, so renaming one breaks every database that already ran it. New columns go
in a new migration.

## AVIF is a plain file

Happy Cloud would need a C AV1 decoder in its API process to read AVIF. Kirill chose to treat AVIF
attachments as plain files on both servers rather than add it, so an attachment is described the
same wherever it is uploaded. Pictures an agent presents itself still decode AVIF.

## Attachments never reach the model as bytes

A turn is replayed to the provider every time, and an attachment can be 1 GiB. The model receives
one line per file and opens it with `read_attachment` when it needs it. The stored message keeps
the `file` block, so clients show the file, while Agent Base keeps only the note.

## Agents get a copy where they ask, never the stored file

Kirill wanted agents to have a real path to an attachment without being able to delete it.
`read_attachment` takes an optional `path` the agent chooses and copies the file there through
Compute, under the turn's own permissions and Auto review, and refuses to replace an existing file
without `overwrite: true`. The stored file is content-addressed and shared, so it is never handed
out.
