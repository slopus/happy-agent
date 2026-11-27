# Surfaces learnings

## Default membership must respect deliberate departures

Team members now join new and existing catalog Surfaces by default through the independent
`surfaces.autoJoin` preference. Surfaces persists explicit leaves even when membership is absent;
only a manual join clears them. The creator always joins. Guests and withdrawn types remain
excluded, and reference membership never affects target permissions. Creation reserves its
notification before transactional membership callbacks and returns the final stored head, keeping
creation, derived version events, and the response consistent. Startup reads missing memberships
in bounded SQL batches rather than decoding historical content.

## A Surface is an instance, not a singleton feature

The initial design used `todo` as a singleton ID. Each Surface instead has a CUID2 identity and
a predefined type, allowing several independently named todo lists with optional managed images.
Todo operations require the instance ID under `/v0/surfaces/todo/:surfaceId` and cannot cross lists.

Surface IDs must use the generator's exact 24-character CUID2 form. The earlier loose alphabet
check admitted route words such as `todo`, `join`, and `image`, making membership and content
paths ambiguous. Creation and reorder anchors now share the strict client schema, and every
Surface path checks it before parsing a body or version: malformed body IDs return 400, while
malformed paths return 404. Existing generated identities remain unchanged; no IDs are rewritten.

## Members belong inside their Surface

A separate response-level membership array duplicated relationships and complicated the model.
Each Surface now contains its member records, with each person's order key and join time.
An empty array alone means nobody joined; a standalone member remains an object using the existing
null user-ID convention. Joining and leaving change sidebar inclusion, never shared data.

## Administration is explicit and type-specific

Generic model creation hid differences between feature types. Active admin bots receive
`create_todo_surface`, with a name and optional image, and add/remove-user tools. Execution
rechecks authority; ordinary todo use cannot grant membership administration or create lists.

## Any agent can create a document for the person it works for

Creation of every type was admin-only, so an ordinary agent asked for an editable document could
only publish a static artifact. Kirill reported it as "we cant even create new editable docs -
only static artefacts". `create_document_surface` now sits with the document tools every agent
receives. An agent that is not an admin bot may only name the person it is working for as the
creator, or null when it works for nobody, so it cannot make someone it is not working for the
author of a document; the refusal says which value to pass. Who else sees the new document follows
each teammate's own join setting, exactly as when the person creates it themselves. An active admin bot still names anyone. The rule is checked
before the image is read and again inside the creating transaction. Creation of the other types and
all membership changes stay with admin bots, and creation is still reviewed in Auto.

## Sections live inside a todo list, not in the sidebar

A `separator` Surface type was built as a contentless sidebar section. That misread the request:
the happy-list `#` separator is a heading row inside a todo list, which todos already support with
the `# ` prefix. The type and its admin tool are withdrawn. Rows an earlier daemon stored are kept
unchanged rather than rewritten, but the catalog read filters them out, so every list, route, and
chat treats their IDs as not found and creation with one of their IDs is refused.

## Names and pictures can change after creation

Surfaces were named and pictured only at creation, so an agent that generated an icon for an
existing document could not apply it and told the person to do it by hand. Steve asked that agents
can rename a Surface and change or remove its picture. `PATCH /v0/surfaces/:surfaceId` and the
ordinary `update_surface` tool now do both for every Surface type, for any person or agent, like
other shared Surface data. Equal values are exact no-ops, so a repeated picture or name appends no
version or event; an image is equal when its normalized bytes match. `surface.updated` carries the
new `name` or `image` only when it changed. The tool reads its image outside the transaction,
keeps the bytes in its call state for replay, and settles its result in the edit's transaction.

## References resolve their target on every read

Copying a bot's, task's, or artifact's title into the Surface would drift as soon as the target
was renamed. A reference Surface instead keeps its own label, edited only through the ordinary
Surface edit, and a separately stored target binding. Reads resolve the target's live name, image
flag, and own version; the Surface's version and events stay unchanged when only the target
changes. Every authenticated person can already read every bot, task, and artifact, so
availability follows the target's lifecycle alone. Deleted or archived targets read as unavailable
with no identifying fields, and creation refuses them as not found. Shared creation events carry
only the stored record, so a caller-relative projection is never published. A reference joins
nobody to the target and grants no rights.

## A Surface chat is reserved before it is prepared

A shared chat has to come out the same under concurrent opens, lost responses, restarts, and a
slow or failing folder. Opening one reserves its agent, workspace, and folder in one transaction
with a durable preparation intent keyed by the Surface, so every retry resumes those identities.
The daemon, not the HTTP request, makes the folder; the agent, its indexes, and the Surface's
`chatAgentId` commit together only afterwards. The caller waits a bounded time and otherwise
gets `503 not_initialized`, never a partial association. The chat's agent is announced after its
initial slash-command discovery and before the `surface.updated` that names it, like bot and task
agents. The Surface owns the chat's lifetime, so agent
and workspace archive, reorder, rename, child creation, and attaching another agent all conflict.
The agent works for each message's sender and holds no admin role. The only Surface it can create is
a document for that sender, and it cannot change who has joined a Surface.

## A Surface chat works from the Surface's current state

The first chat context only named the Surface and listed tools, with nothing for chat Surfaces,
and nothing told the agent to reread concurrent edits or stay on the Surface. Steve asked that it know
it is the side chat of one specific Surface, how to read that Surface's current state, that it
stays focused on it, and that it acts differently per type. The context now names the Surface,
requires a fresh read with that type's exact calls in every turn that depends on its contents,
keeps replies short and away from the repository, and gives every chat-enabled type its own
rules: todos are acted on and completed rather than deleted, documents get minimal co-author
edits, by exact replacement or against the read `seq`, calendars confirm ambiguous times and
whole-series edits, chat Surfaces are read but never posted to, System Monitors are read-only,
and references inspect their live target. A unit test checks that every tool the context names
exists and none is an admin tool.

The document rules first said writes are refused whenever a read reports content Markdown
cannot show, such as comments or colors. That was wrong and kept Surface chats from editing
commented documents: hidden content stays in place, and only content outside the content model
refuses a write. The rules now say so.

## Attribution is explicit and remains separate from audit actors

Todo records and Surfaces did not retain their author or creator. Todos now carry immutable
`authorUserId` in every snapshot and Surfaces carry immutable `creatorUserId`, using local Happy
user IDs or null. HTTP uses the authenticated caller; creation tools require an explicit ID or
null and never infer it from the agent's current message. Non-null IDs must identify existing
sign-in-capable team users. The explicit Surface creator joins its sidebar; team null creates
no member, while standalone null joins the local person. Older snapshots read as null without
inferring from members or revision actors or rewriting permanent history. Revision actors still
record the actual mutation context independently of attribution.

## Ordering reuses the existing implementation

Duplicating the workspace fractional-key helper was unnecessary. The algorithm now lives in a
shared utility used by tasks, bots, connections, subtasks, projects, workspaces, and Surfaces,
preserving its decimal format. New projects append fractional keys too; existing keys and
released migrations remain untouched.

New todos enter at the top through both HTTP and model tools, using a fractional key before the
first active item without rewriting its neighbours. Reactivating an existing todo remains a
different operation: it appends at the end with a fresh key, preserving the restoration rule.

## Section headings are a text convention, not another record type

An active todo beginning with exact `# ` is a section heading with no checkbox and does not count
as outstanding work. The daemon preserves the entire text without trimming or interpreting other
Markdown syntax. Creation, editing, ordering, state changes, and permanent history use the same
todo operations. Clients edit the full text so removing the prefix returns the row to an ordinary
task; historical row styling remains a client choice.

## Documents are collaborative, not guarded Markdown

Documents first stored whole Markdown replaced under `If-Match`, so two people editing at once
had one save rejected and had to redo it. The request was a WYSIWYG editor with real-time editing
on a good CRDT. A document is now a Yjs document edited with BlockNote. Changes merge, every
accepted change is a permanent log entry with its `seq`, actor, source, and mutation ID, and any
version is the log replayed to that entry. A repeated mutation ID returns its original `seq`,
which is how a client recovers a change whose response was lost. Nothing is deleted or restored:
reverting writes an old version's content as a new change. Live changes and presence ride the
existing event stream as frames that never enter the journal, so a desktop opens no extra
connection and a reconnect's cursor is unaffected.

Presence sent through a stream that does not follow the document relays nothing and is not an
error. A window's throttled presence can land just after it closed the document, and answering
with a conflict would only produce noise while relaying it would bring that presence back.

## The daemon reads documents through the editor's exact schema

Markdown, agent writes, and the content check all convert the Yjs fragment through BlockNote's
schema, so the daemon and the desktop editor must run the same BlockNote. A unit test fails when
the installed or declared `@blocknote/core` differs from the version the desktop pins (0.51.4);
upgrade both together. Conversion runs on a private copy because y-prosemirror deletes nodes it
cannot place, and any such delete marks content outside the model. That content is still stored
and relayed unchanged and left out of Markdown, and an agent's Markdown write to such a document
is refused with an error saying why, because rewriting from Markdown would delete what Markdown
cannot see.

## A document nobody has edited is empty, not unreadable

A new document Surface holds no blocks until someone writes to it, and the content check read
that as content outside the model, because the editor's schema wants at least one block. Kirill
found that agents could not write to an empty document at all: every `update_document` with
`seq` 0 was refused until a person typed something. A document with no blocks now reads as the
empty document. Content the model cannot place is still caught, because dropping it is what
marks a document as outside the model, whether or not anything else is left.

## Agent writes are differences from the version the agent read

An agent sends full Markdown and the `seq` it read. Replacing the content outright would erase
whatever people typed since, and would drop block IDs, comments, colors, and nesting that
Markdown cannot express. The write instead aligns blocks between that version and the agent's
Markdown, keeps unchanged blocks and their invisible attributes, and applies only the computed
difference to the current document in the write transaction. Unchanged Markdown appends nothing.

## A small change is an exact replacement, not a rewrite

`update_document` takes the entire Markdown and returns the entire document, so changing one
word in a 5 KB document cost about 10 KB of tokens. Kirill asked for editing to be as cheap as
the file edit tools. `edit_document` replaces exact text in the latest version's Markdown with
the same `old_string`, `new_string`, and `replace_all` those tools take, then goes through the
same block-level difference as a full write, so other blocks, their identities, and what
Markdown cannot show stay as they were. It needs no `seq` because it reads and writes in one
transaction. It answers with the new `seq`, whether anything changed, and how many replacements
it made, never the text. An edit whose Markdown reads back as the same document reports
`changed: false` instead of failing. `update_document` still returns the full text: a rewrite
is where the agent most needs to see what its Markdown became and what people merged in.

## Blank lines are empty paragraphs an agent can add and remove

An empty paragraph shows in Markdown only as two more blank lines. The parser dropped blank
runs, and the difference kept every block that showed as nothing. Kirill found what that did:
agents could not remove the empty lines people left, a full rewrite stranded the old ones in the
middle of the new text, and writing into a cleared document left one above the new content.
Blank lines now mean what the projection writes. Blocks are one blank line apart, and every two
blank lines beyond that are one empty paragraph, at the start, between blocks at any depth, and
at the end. One stray blank line adds nothing, so loosely spaced Markdown does not litter the
document. An empty paragraph that stays keeps its identity and its nesting, which blank lines
cannot show; a new one sits right before the block that follows it. Blank text that would be a
single empty paragraph is no content, because one empty paragraph and no blocks both read as
empty text. Other blocks that show as nothing, such as a file block with no file, still cannot
be removed by an agent that cannot see them.

## Markdown escapes only what would change the meaning

Escaping every punctuation character made `a_snake_name` read back as `a\_snake\_name`, which
agents then copied into their writes. Escaping is now decided by context: intraword underscores,
lone asterisks, and ordinary punctuation stay literal, and each formatted run is checked by
parsing the result back, falling back to plainer output when the parse would differ. A heading's
text and a table cell cannot start a block, so `## 1. Setup` and a `#` header cell are written
without backslashes.

## Writing back what a document reads as changes nothing

Kirill asked for the odd cases around document editing to be checked. Reading a document and
writing the same Markdown back changed it in many of them, and some did real damage: a link
whose text was code, or bold code, stored marks the editor forbids together and locked every
agent out of the document; a paragraph ending in a line break gained a visible backslash; an
empty check item became a bullet reading `[ ]`; an empty bullet took the text of the bullet
nested beneath it; and a bold run ending in a space made its whole block read without
formatting, which an agent edit then removed for good. The rule the module now holds is that
the Markdown a document reads as parses back to the same blocks. Code is code alone and plain
text inside a link. Formatted runs are joined before escaping and keep whitespace outside their delimiters.
Empty quotes, check items, and nested list items read and write as themselves. A seeded
property test generates editor documents, Markdown, and edits and holds all three directions
to this; set `DOCUMENT_ROUND_TRIP_SEED` and `DOCUMENT_ROUND_TRIP_RUNS` to search further. One
case CommonMark cannot write is left: a block that is not a list, nested beneath a list item
with no text, reads as that item's next sibling and is stored that way after an agent write.

A second pass against the cases the cloud's documents assert found more. Italic inside bold,
the commonest nested formatting, read back as plain text: a run's trailing space closed every
open delimiter and delimiters opened in a fixed order. A run's trailing space is now written
after only the formatting that ends there has closed, formatting that lasts longest opens
first, and formatting that overlaps instead of nesting ends at the spaces beside each change
before any of it is dropped. Whitespace runs in a row count as one when their emphasis is
chosen. A list item without text is its marker alone and an empty nested paragraph is an empty
line, because trailing spaces show as nothing but an exact replacement must match them. Spaces
at the edge of code stay inside its code span. A carriage return in text is written as a
character reference.

## A newline inside a block is a line break

Documents followed CommonMark for line breaks: a newline inside a paragraph joined the two lines
with a space, and a line break was a backslash before the newline. The cloud's documents read
every newline inside a block as a line break, so the same Markdown meant different documents in
the two products. Kirill decided "align, do what cloud does". A newline inside a paragraph, list
item, or quote is now a line break, read and written as a bare newline. Trailing spaces or a
backslash before the newline add nothing. An empty line inside a block, between two breaks or
at either end, is a line holding only a backslash, because a blank line would end the block; a
quote writes it as its mark alone, and a backslash a person typed is written escaped. So a line
break that ends a block now shows, where it used to be left out. A heading and a table cell are
one line: a break inside them reads as a space and the read says some line breaks are not
shown, as it does for a block that holds nothing but line breaks, which reads as empty. The
editor reports a line break beside a link, or between two links to one place, as part of one
link's text, so a link is written once on each line it covers. The `update_document` description
says how line breaks are written.

## Spaces at the edges of a line are left out

Spaces at the start or end of a block's text, or of a line inside it, were written as `&#32;`
so that reading the Markdown back gave the same spaces. Nobody sees those spaces, an agent had
to copy the character references to make an exact replacement, and the cloud's documents leave
them out. Kirill decided the two products read the same. A line now reads without the spaces
at its edges, a paragraph holding only spaces reads as an empty paragraph, and a line of only
spaces inside a block reads as an empty line. Spaces inside a line stay, including every space
between two formatted runs, because dropping one would join words. Code keeps its spaces. The
stored document keeps its edge spaces until an agent rewrites that block: a block the agent
left alone is matched by its Markdown and never rewritten. A paragraph of only spaces can be
removed like any empty paragraph.

## Calendars expand recurrence on the daemon, from series records

A calendar keeps one record per series and no stored occurrences, because there are no
per-occurrence exceptions: editing or deleting changes the whole series. The daemon expands
occurrences for every range read and tool, and clients never compute repeats, so desktop and
models cannot disagree with the daemon about month ends, leap days, or daylight saving. Timed
series repeat the start's wall-clock time in the event's own zone, using Temporal's
`compatible` rule for skipped and repeated hours; index 0 is always the event's own timing, so a
start outside a weekly rule's weekdays still occurs once. Range reads stay cheap by keeping the
current record in its own table with padded instant bounds, filtering in SQL before decoding.

## System Monitors observe the daemon host and keep probes independent

A System Monitor is a Surface instance, but its readings describe the daemon's machine and are
shared by every monitor. Telemetry has no catalog mutation or journal event: clients poll a
bounded in-memory history while visible. A single lazy sampler owns its named daemon lifetime,
stops after a minute without reads, and gives each slow probe one bounded outstanding operation
so process scans or mounted volumes cannot stall CPU and memory updates or accumulate work.
Memory follows OS available accounting rather than counting reclaimable cache as occupied.
When native accounting fails, the required memory totals use Node's total/free counters with
cache null; this fallback can include reclaimable cache in used memory.

Steve asked for a live task list alongside the charts. That means the host's processes: the
union of its top CPU and memory users, with whole-machine CPU percentages, resident memory,
and start identities that reset reused PIDs. Every authenticated person and model may read
Surfaces, so process probes collect executable names only and never command-line arguments or
environments. The read tool includes the top five by CPU and memory. Cache is a separate
measurement, not another disjoint segment to stack with used and available memory.

## Calendar history restores through ordinary update

Steve asked that event history allow anything to be restored, like todos. Every create, edit,
recurrence change, and deletion appends a full immutable snapshot, and update can set every
field a snapshot holds: blank titles, cleared notes, location, and rules, timed or all-day
timing, and active status to undelete. Restoring is reading a revision and sending its fields
with the current version, which appends exactly one revision and rewrites none.

## Calendar titles may be blank

Steve chose Google Calendar's behavior: an event may have an empty or blank title, and clients
show their own placeholder. The title is always a string, never null, so a revision restores it
exactly, and it is stored without trimming.

## Older documents convert once, on first touch

Documents an earlier daemon stored as Markdown become collaborative the first time they are read
or written, in that transaction, as entry 1 with source `conversion` and no actor. Their Markdown
revisions stay readable as history and are never written again. The withdrawn `PUT` returns
`405` without reading its body, so an older client stops instead of retrying a save forever.

## Nothing historical is destroyed

The legacy list hard-deleted todos and allowed reorder to revive completed items. Every change
now appends an immutable full revision, including deletion and reorder. Inactive todos cannot
reorder, and restoration appends with a fresh key instead of recycling historical positions.

## Previous states use ordinary updates

Separate restore, revert, and unarchive commands duplicated state changes. History exposes the
immutable old values; the agent applies desired text and status with the current version through
ordinary update, and active placement through reorder. Lifecycle timestamps remain server-owned.

## Managed pictures share one normalization function

A Surface-specific normalizer duplicated node and bot WebP processing. All three now use one
shared managed-image function, while each module owns permissions, persistence, and error mapping.

## Deferred tools own their discovery descriptions

Shared capability text and missing keywords obscured the differences between Surface tools.
Every definition now declares its own concise capability and search terms directly, so listing,
editing, history, and administration can be found independently without a metadata wrapper.

## Auto review requires an action description on the tool

Surface mutation tools requested Auto review without describing their permission action, so
the runtime refused them before the reviewer ran. Every reviewed Surface tool now describes
its shared-data or membership write boundary. A structural check covers directly reviewable
module tools, and the real daemon gym proves that an approved edit commits while a denied edit
leaves the todo and its history unchanged. Review requirements and filesystem elevation remain
unchanged.

## Important documents are one installation-wide list that admin bots manage

Steve asked for a list of important documents in agents' system prompts, rendered like skills,
telling agents to read them to understand how and what to do. Attaching documents to individual
agents, as secrets attach, was rejected, and so was naming them in the machine `happy.toml`,
which needed a restart. The list is one table in this module. Every agent sees it; only active
admin bots can list, mark, or unmark it, rechecked on every execution. It lives here rather than in
its own module because the catalog and `read_document` report whether a document is important,
and a separate module that needed Surfaces could not also be asked by Surfaces.

Steve asked for a stable order: by first mark time, oldest first, ties broken by Surface ID.
Re-marking replaces the description and name but keeps the first mark time, so rewording never
reshuffles every prompt. A stored name is null unless the admin gives one, and a null name is
read from the Surface on every request, so renaming the document is reflected without copying.

## Vault writes are reversible, so they are not Auto-reviewed

Every vault write makes a new version, and deletion goes to a Trash that keeps the item for the
retention's `trashDays`, so an agent's change is always recoverable from the vault itself. Agent
writes therefore skip Auto review. Only `import_vault_file`, `export_vault_file`, and
`write_vault_artifact` with `fromPath` read or write the agent's machine, so they go through
Compute's filesystem review and elevation for that path, like any other file tool. A burst
budget of 100 agent versions per hour per agent is the one guard against a looping agent filling
the history.

## Vault content is addressed by digest and collected later, never in the writing transaction

Content files are named by their SHA-256 and shared across vaults, so a copy or restore records a
new version row pointing at the same digest instead of moving bytes. Agents copy the same way
through `copy_vault_file`, so copying a large file never sends its bytes through the agent's
machine. Deletion happens only in the
collector: a digest whose last reference goes away is queued with a not-before time an hour out,
and the collector deletes the file only if nothing names it when that time passes. Bytes written
before their version commits are queued the same way, so a failed transaction leaves no orphan.
Post-commit background work must not start from the commit callback, because that callback runs
inside the committing operation and a new transaction there collides with it; the collector is a
durable function invoked inside the transaction instead.

## Folders and files are two kinds, not one "entry"

The first vault API spoke of "entries" with a `kind`, which Steve rejected: people think in
folders and files, and must be able to make an empty folder. The API, events, and tools now name
the two kinds apart (`/folders` and `/files`, `vault.folder.*` and `vault.file.*`,
`move_vault_folder` beside `move_vault_file`), listings return both as items with folders first,
and `create_vault_folder` makes empty folders that stay until deleted. The tables keep their
internal entry naming; only what crosses the API changed.

## An artifact is recognizable by its `.artifact` name and file

Steve asked that artifacts be detectable on sight. Only an artifact's name ends in `.artifact`,
and every create, rename, restore, and copy refuses a name that disagrees with its kind, so the
suffix alone tells people, clients, and agents what an item is, and the name decides the kind of
a new file. An artifact travels as a `.artifact` file: a zip with `artifact.json`
(`format: "happy.artifact"`, `formatVersion: 1`, `type`, `entry`) beside its files. The manifest
is never stored as an app file; the daemon keeps type and entry on the version and writes the
manifest again on download, with every record at the version's creation time, so a downloaded
`.artifact` file uploads back as identical content and makes no new version. Uploads must carry a
manifest; a higher format version is refused as made by a newer Happy. Agent bundles from a
folder or plain zip may leave it out and take their type from `index.html` or `index.md`, and a
file written into an artifact keeps the artifact's type.

## An artifact is a vault app, not a site

Steve corrected the wording: "it is not site it is app". Every description, error, tool, and prompt
calls an artifact a vault app, a small web app kept as one `.artifact` file and served from its
zip bundle. Only the prose changed: `kind: "artifact"`, the `artifact` fields, the routes, and the
`.artifact` suffix of the stored name stay. Clients hide that suffix and tell a vault app apart by
its preview and name, but the daemon and its API always carry the full name.

## A new version is safe to repeat by its operation ID

A client whose response to `POST /files/:fileId/versions` was lost could not tell whether its
version was made, and a blind retry made a second one. Steve approved an optional `operationId`:
the daemon records, in the version's own transaction, whether each ID used on a file made a version
and which, and keeps the record until the file is purged. A repeat answers with that outcome,
the original 201 or 200 and the version as it is now or null once pruned, before If-Match or
the upload is looked at, so it uses up nothing and emits no event. A differing body is replayed
silently, as creation ids are: one ID per attempt is the client's contract. IDs are scoped per
file. Vault tools send `tool:<callId>`, so a call repeated after a restart finds its version.

## Vault search ranks words with BM25 in tiers

Steve asked for search to find vault files by name and by content, ranked with BM25. Substring
search through the trigram index found text but ranked it poorly, so search now ranks words with
FTS5 bm25() over two unicode61 indexes, which fold case and diacritics: one row per item with its
name and the folders above it, and one row per text that keeps no copy of the text. Results come in
tiers: words in the item's own name, then words in content, then words found only in the folders
above, then the old substring matches. Path-only matches come after content, because a word in a
folder name such as "Docs" would otherwise rank every file below it above real content hits. Query
words match by prefix and are never stemmed, so a half-typed word keeps matching (porter would
index "planning" as "plan" and lose "planni"). The indexes change in the same transaction as
entries and texts, and renaming or moving a folder rewrites the folder paths below it. Vaults made
before the indexes are filled by the maintenance pass in bounded transactions, which copy text out
of the trigram index instead of reading files.

## Vaults are searched only through the node's one search

Steve asked for one search over everything in the node, `POST /v0/search`, which clients run
locally and fuse with the daemon's answer, and then for vault search to go entirely. There is no
per-vault search route and no vault-wide one; `glob_vault` and `grep_vault` keep the trigram
index. `SurfaceVaults.search` is the vault provider: every vault's live items, each once under its
best tier, reported as `match: "path"` when only the folders above matched (and for a substring
found only in the path). Desktop found HTML vault apps answering with their source as the snippet,
and matching words that only appeared in tags. An `.html` file, by a plain file's name or a vault
app file's inner path, is now indexed and snippeted as the text a reader sees, stripped as artifact
search strips it; the trigram index keeps the source, so `grep_vault` still reads markup. A plain
file renamed across `.html` has its words indexed again, and texts indexed as source before this
are reindexed once by the maintenance backfill, limited to HTML. Surfaces search their catalog's names in memory; todo text, and calendar
event titles beside their location and notes, live in contentless word indexes changed in the same
transaction; a document's Markdown and the text of its live comments are indexed in a durable job
just after each edit, so typing never waits for the projection to be rebuilt. A comment match has
a snippet and no line. A document marked while that job finishes runs it again from its
`onSuccess`. Existing todos, events, and documents are indexed by a bounded durable backfill after
upgrade.

## The default vault retention is Time Machine

Steve chose Time Machine's schedule as the default: every version for a day, one a day until 30
days, one a week after that, and 30 days in the Trash. Pinned versions and the newest version
are never pruned. A vault's settings replace the whole policy, and pruning runs when a version is
made and in the hourly maintenance pass.

## A Gen UI item in a vault is a gen_ui app, a bundle like any vault app

A first cut treated loose `*.genui.json` files as Gen UI documents with a media type of their
own. Steve corrected that a vault keeps entities as bundles, as artifacts do, so a Gen UI item is
a `gen_ui` vault app: `index.genui.json`, the pictures it shows, and `.genui/render.json`, the
render document clients draw. Every bundle that makes a version, whether an upload, a folder, a
zip, or a tool write, goes through the gen_ui artifact pipeline before its transaction: the
artifacts module validates the entry, measures the pictures, and compiles it, and the vault stores
the result beside the other files. The compiler is deterministic, so `.genui` files that arrive in
an upload or a folder are dropped and compiled again, and a downloaded `.artifact` file still
uploads back as the same content. Inline files and vault paths that name `.genui` are refused, and
the vault tools never list or read it, nor does search index it.
