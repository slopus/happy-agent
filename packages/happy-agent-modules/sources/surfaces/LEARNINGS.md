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
The agent works for each message's sender, holds no admin role, and never joins anyone.

## A Surface chat works from the Surface's current state

The first chat context only named the Surface and listed tools, with nothing for chat Surfaces,
and nothing told the agent to reread concurrent edits or stay on the Surface. Steve asked that it know
it is the side chat of one specific Surface, how to read that Surface's current state, that it
stays focused on it, and that it acts differently per type. The context now names the Surface,
requires a fresh read with that type's exact calls in every turn that depends on its contents,
keeps replies short and away from the repository, and gives every chat-enabled type its own
rules: todos are acted on and completed rather than deleted, documents get minimal co-author
edits against the read `seq`, calendars confirm ambiguous times and whole-series edits, chat
Surfaces are read but never posted to, System Monitors are read-only, and references inspect
their live target. A unit test checks that every tool the context names exists and none is an
admin tool.

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

## Agent writes are differences from the version the agent read

An agent sends full Markdown and the `seq` it read. Replacing the content outright would erase
whatever people typed since, and would drop block IDs, comments, colors, and nesting that
Markdown cannot express. The write instead aligns blocks between that version and the agent's
Markdown, keeps unchanged blocks and their invisible attributes, and applies only the computed
difference to the current document in the write transaction. Unchanged Markdown appends nothing.

## Markdown escapes only what would change the meaning

Escaping every punctuation character made `a_snake_name` read back as `a\_snake\_name`, which
agents then copied into their writes. Escaping is now decided by context: intraword underscores,
lone asterisks, and ordinary punctuation stay literal, and each formatted run is checked by
parsing the result back, falling back to plainer output when the parse would differ.

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
