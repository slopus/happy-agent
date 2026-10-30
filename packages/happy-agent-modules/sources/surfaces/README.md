# Surfaces

Shared typed feature instances, including todo lists, collaborative documents, calendars, and
references to artifacts, bots, and tasks, with each person's sidebar order on the nested member record. Heads and
immutable revisions live in module-owned AgentKV storage; document change logs live in their own
tables beside it.

Team members join catalog Surfaces by default through `SurfaceAutoJoinModule`, unless their
independent `surfaces.autoJoin` preference is false. Creators always join. Deliberate leaves persist
until a manual join; opting out preserves existing memberships. Membership controls sidebar
inclusion only. Guests and withdrawn types are excluded, and reference joins grant no target rights.

```text
HTTP / model tools -> SurfacesModule -> one composing database transaction
                                      |- head + immutable revision
                                      `- Durable Functions notification -> API journal
```

The transaction lock serializes compare-version-and-write, fractional ordering, and membership
changes across lists. History pagination selects only a bounded prefix range. Durable tools use
Agent Base's transactional settlement; image creation retains a call-stable ID and image bytes.
The admin tools check active admin authority at selection and execution. Images pass through
Compute's filesystem boundary and bounded managed normalization, never an arbitrary served path.
Anyone may rename a Surface or replace or remove its image afterwards; the edit, its image bytes,
and `surface.updated` commit together, and equal values change nothing.

Separators are withdrawn. Rows an earlier daemon stored stay untouched, but the catalog read
filters them out, so listing, membership, ordering, content routes, and chats all treat their IDs
as not found, and a creation request reusing one is refused rather than echoing it back.

Document Surfaces are Yjs documents edited with BlockNote. `documents/` owns them: every accepted
change is appended to a permanent log with its `seq`, actor, source, and mutation ID, and the head
and periodic snapshots let any version be rebuilt by replaying from the nearest snapshot. Changes
merge, so writes need no version guard; a repeated mutation ID returns its first `seq`. Markdown
is a read-only projection made by converting the Yjs fragment through BlockNote's schema on a
private copy, so content outside that schema is detected and left out instead of deleted. Agent
writes compare their Markdown with the version they read, block by block, and apply only the
difference to the current document inside the write transaction. A document stored as Markdown
by an earlier daemon converts on first touch; its Markdown revisions stay readable.

Live changes and presence ride the API's existing event stream as unjournaled frames. The module
keeps which streams follow which documents in memory and publishes a change only after its
transaction commits; the API checks that a stream belongs to the caller before routing to it.
Ordinary models can read, update, and list changes; only active admin bots create documents.

Calendar Surfaces hold series records, never stored occurrences. `calendar/` owns them: each
event's current record lives in its own table with conservative instant bounds of everything the
series can cover, so a range read filters in SQL before decoding and expands only those events.
Expansion walks local dates in the event's own zone through `Intl`, keeps the wall-clock start
across daylight-saving changes, skips months without the start's day, and numbers occurrences
from the event's own timing. Every change also appends an immutable full revision, and an
earlier state is restored by sending its fields through ordinary update. Tools speak local ISO
8601 date-times with an IANA zone, so models never convert instants or expand repeats.

Reference Surfaces store only an immutable binding to their target beside the shared record.
Every read resolves it against the owning Artifacts, Bots, or Tasks module, so the live name,
image flag, and target version are never copied or synchronized. A missing, deleted, or archived
target reads as unavailable without its ID. Shared events carry the stored record alone, never
the resolved projection. The three admin creation tools share the image and replay handling of
the other typed creation tools.

System Monitor Surfaces share one daemon-host sampler in `systemMonitor/`. Reads lazily start
independent bounded probes for CPU, GPU, memory, disks, and live processes. Its five-minute
history stays in memory, sampling stops after a minute without reads, and telemetry never writes
catalog versions or journal events. Process lists expose names and resource measurements only,
never arguments or environments. The common read tool summarizes the top CPU and memory users;
active admin bots can create named monitors through the ordinary managed-image creation path.

Every Surface type can own one shared chat, created only when a person opens
it. The request reserves the agent ID, workspace ID, and folder path in `chat.*` and invokes the
durable `surfaces.prepareChat` function in the same transaction. Preparation belongs to the
daemon's lifetime: it makes the folder under Configuration's `Surfaces` root on the task-layout
runner, then creates the parentless agent, writes the agent and workspace indexes, and names the
agent on the Surface in one transaction. The HTTP caller only waits, at most 20 seconds, for that
commit. Tasks, bots, files, terminals, services, bridges, and the API ask this module whether an
agent or workspace belongs to a chat; the Surface, not those catalogs, owns its lifetime. The chat
agent receives the ordinary, non-admin Surface tools. Its context names the Surface, tells it to
read the Surface's current state with that type's tools before every answer or change, keeps it on
that Surface, and gives each type its own working rules.

Document Surfaces can be the installation's important documents. `promptDocuments/` keeps one
installation-wide list of marked documents in its own table, each with the admin's description,
an optional display name, its first mark time, and the marking agent. Every agent's instructions
end the Surface section with an `# Important documents` list modeled on the skills catalog:
name (the given one, else the Surface's live name), description, `surface_id`, and
`happy://surfaces/<id>` link, oldest mark first with ties broken by Surface ID, plus guidance to
read matching documents with `read_document` before acting, re-read them when work touches them
again, and let the user's direct request win over a conflicting document. Missing or non-document
Surfaces are left out. The list is read on every request, so a change reaches each agent's next
turn. Only active admin bots receive `list_prompt_documents`, `mark_prompt_document`, and
`unmark_prompt_document`; authority is rechecked on execution, and mark and unmark are durable,
transactional, Auto-or-Full-access tools that are always reviewed as an installation-wide
instruction change. Re-marking keeps the first mark time, and at most 32 documents are marked.
Every document Surface the module presents carries `promptDocument`, `null` or the description
and given name, resolved on read like a reference target, so shared events never carry it and
marking changes no Surface version; `read_document` adds it for a marked document.
