# Spaces — learnings

## Focus is the default name and lives under Happy

The sidebar helper used to be created as Prioritizing. New helpers are now named Focus; an
existing conversation keeps its stored title, including a name the person chose. Display and
batch notes read that stored title, with Focus only as the fallback. No title migration runs.

A top-level Focus row right after Happy was tried and rejected. Kirill: "focus should not be shown
on its own why the funck i need it? we only need it if i open it when unfolding happy". Focus now
keeps its conversation nested under Happy as a session, never unfolds Happy, and removes a
top-level row of its own unless the person placed it. That removal applies without a proposal, the
one daemon change; where Focus stands is otherwise only its prompt, and the revision rise tells
existing helpers on their next start.

## Focus arranges by the person's stated priorities (revision 4)

An eval of Focus prompts on Kirill's real week picked "compass v2", and Kirill said "ship it". The
prompt now keeps its structure: Now (at most 3 rows serving the priorities), Tell people (shipped,
no post yet), one row per neglected priority, Waiting on you, In hand (rows written in during the
last 30 minutes), and one folded Later; at most 10 rows shown and 6 sections, each label once.
"Doing nothing is usually right" and the topic-section, Bots/Tasks, Distractions, and Stale rules
are gone; over budget is no longer a resting state. The eval hardcoded Kirill's four priorities;
in the product they are what the person stated in their own words, kept as a "Priorities: …" line
in Focus's own replies (its notes), changed only by their words, and guessed aloud until stated.
Shipping needs explicit evidence (released, published, or the person said done; approval is not
shipping), and Focus never nudges about releases, regressions, or bug fixes. The first run under
this revision makes one bold proposal rebuilding an old-style sidebar; no code migration runs, only
the update notice and the prompt.

Focus heard only the messages in work that began as a stem cell, about a third of what the person
wrote, so it could not tell what they were pushing. Every message the person writes in any of their
rows, or a session under one, is now briefed with the agent's last text before it, bounded to a few
hundred characters each and batched as before. Agents' messages, lifecycle, and status from other
sessions are still not forwarded.

## Focus archives shipped work itself (revision 8)

Kirill asked that Focus archive a task itself once it has explicitly shipped or finished, kept
narrow; revision 5's "never archives by itself" otherwise stands. `archive_shipped_task` archives
the task behind one of the person's own task rows, with their archive authority, and names what
shipped. The judgement is the prompt's: shipped means on main or released, or the person said it is
done, with nothing still waiting; approval, a passing test, or a quiet chat is not shipping. Every
other archive still goes through a proposal's Archive block.

## A teammate's mention goes through their own Focus (revision 8)

Kirill: "For mentions, we can just forward this message to their focus agent — everyone has their
own focus agent." Another person's agent never joins someone to its task. `notify_teammate`
(Teammates) calls `forwardMention`, which queues a waking notice for that member's Prioritizing.
The notice names the task and the reason, plus the member's role and follows. That Prioritizing
decides, and `join_task` joins its own person and marks the task new for them. The row then arrives
as ordinary new work to place. Only a person's own Prioritizing changes their sidebar, and declining
means doing nothing.

A teammate writing in the person's work used to be briefed as "the person wrote", which was wrong,
and it woke nothing once the row was placed. A turn that ends wakes nothing either, so the person's
Focus never heard about it. The brief now names the teammate ("their teammate Steve wrote in row …,
not the person") and wakes Prioritizing, because someone else's message is news to the person. The
person's own messages still wait for the next brief.

## Focus cleans up aggressively (revision 5)

Kirill: "10 things on screen - rest is beyond human capacity to understand", subtasks "tend to
explode and never cleaned out - be more agressive with cleanup in general, usually this stuff can
be recovered anyway", but "DONT archive automatically". In a live run Focus nested every new
subtask under Happy: the new-session notice told it to show the session "if the person should see
it", the prompt showed any session changing code, the model reasoned that folded Happy hid them,
and Kirill now unfolds Happy to reach Focus. Nothing took them out again, and sessions from a bulk
Show subtasks counted as the person's, so Focus left them.

The notice now states only that a session started under a row. The prompt shows a session only
while it waits on the person, never for running code, under Happy too, and takes it out as soon as
it stops waiting; sessions the person showed, bulk ones included, go out through the proposal,
which is their consent. Ten shown rows is a real target. Every proposal ends with an Archive block
of shipped, idle-over-48-hours, greeting-only, and superseded tasks, and Focus never archives by
itself. Two proposals sat open 12 to 19 hours and grew to 13 and 20 versions, so `list_sidebar`
now says when the open proposal was opened, and the prompt shrinks one undecided for about 12
hours instead of adding to it. From research on project-named sections, only "never a section
named for the project nearly all the work belongs to" and stable section IDs carried over; its
topic-section rules conflict with the state-first layout.

## Prioritizing decides from its prompt; the daemon keeps integrity

Evaluation replays kept finding proposals that did something unwanted (folded recent work, put
bots into Stale, moved a row the person kept at the top, moved the separator to the end), and each
was answered with a daemon rule that dropped such edits. The rules piled up, fought each other, and
cost Prioritizing revision after revision of refused edits; the row anchor and its startup repair
moved its own row for it. Kirill: "its ITS decision - just a prompt - no hardcoded rules - THATS
ONE OF THE CORE PRINCIPLES across the board", unless it is a direct user action. Where work goes,
which sections exist and what they are called, what is folded, what is offered for Stale or
Archive, and where Prioritizing's own row stands are now only in `formatPrioritizingInstructions`.
When a run gets one wrong, fix the prompt, not the review.

The daemon still enforces only integrity, each for one reason:

- the document is valid and every ID is unique and known, or clients cannot draw it;
- a session stands only under its own parent, because a subtask never changes parent;
- what the person last set (place, fold, name, fold ribbon, widget, a revealed session) is never
  overridden, in the sidebar or in their edits of a proposal, because that is their direct action;
- larger changes need the person's consent (`reviewDirectOperation`), and nothing is archived
  unless they accept a proposal, and then only task rows under the `Archive` heading, whose label
  is fixed because accepting acts on it.

## The document is the sidebar, and everything in it is an item

The first experimental document was HTML with sections that walled rows off, plain markup, a
`tree` flag for live subtasks, and an "Older" section that read as "done". Kirill: the sidebar is
"kinda literally HTML, that's the state"; everything must be draggable, separators included, and
Search and Create too; a separator is a visual cue, not a hint. The document is now one `<nav>` of
`happy-search`, `happy-create`, `happy-section`, `happy-separator`, and `happy-space` items in one
flat order. Nested `happy-space` elements are sessions (subtasks and collaborators) by agent ID, so
what Prioritizing writes is exactly what is shown: absent means hidden, `expanded` shows a row's
sessions. Attributes are quoted and switches are `"true"`, so HTML and XML parsers read the same
tree. `fold-ribbon` lets Prioritizing choose whether a foldable row's ribbon shows on hover or
always.

Sections and separators are different things. Folding the titled sections into untitled separators
lost what Kirill liked about them, so both exist: a `happy-section` has an ID and a required label,
heads the rows after it up to the next section or separator, and folds them with `collapsed`; a
`happy-separator` is a plain rule with an ID only, cannot fold, and ends a section's run. The prompt
says a label names a subject, never age or status, and is unique; the person may name sections
freely. First-grammar documents are rewritten
once on read, keeping order: sections become sections with their labels and folds, the old "Older"
bucket becomes a plain separator, and plain markup is dropped.

Validation runs through ordinary artifact tools too. A nested node must be a session of the
conversation it sits under. The person may move anything. Prioritizing may not undo the
person's moves or folds. An item that now sits under another
section or separator has moved even if its order among the other items did not; otherwise
inserting one above a row the person placed would regroup it unnoticed.

A section is its heading plus the rows after it, up to the next section or separator, and Kirill
asked that it always move as one block. A row-level diff blamed whichever side of a swap had fewer
rows, so dragging a big section past a small one marked the small section's rows as hand-placed.
A `move` of a section now carries its block, and the client's `diffSpaceSidebar` turns a whole
document into the fewest moves, moving a block whole when it travelled whole. Only the heading
becomes the mover's, its rows are carried, and the batch note names the section ("Moved
Research."). Carried rows still count as moving, so Prioritizing cannot carry off a row the
person placed by moving the section around it.

## Writes are operations by node ID

Whole-document writes with compare-and-swap made every concurrent change a conflict: a person's
drag while Prioritizing's batch waited discarded the batch, and a drag racing the apply was
refused. Kirill approved moving to operations ("lets make these changes"). Every node has a stable
ID, and every write is a batch of `insert`, `move`, `remove`, and `set` by ID, applied with the
client's `applySpaceSidebarOperations` — the same function clients use for optimistic updates, so
both sides compute identical documents. A batch applies to the current version, rebased from the
one it was made against: an anchor that still exists is used where it is now; an `after` anchor
that is gone falls back to the nearest node that preceded it in the base and is still under the
same parent, else first under that parent; removing what is gone is a no-op. Only an operation on
a node that is gone, or an insert of an ID that exists now, is a conflict, named by its index.
Removing a section removes its heading only, so its rows join the block above instead of
vanishing.

Authorship is recorded per node and aspect (place, fold, label, fold ribbon, widget content), so
"Prioritizing never overrides the person" is a lookup. Inserting sets every aspect the new node
starts with: a section the person added keeps its label. Prioritizing's operation that touches a
person-set aspect, or breaks its other rules, is dropped with a note and the rest still applies.
At queue time the notes come back in `edit_sidebar`'s result (an edit with nothing left is an
error); when the batch applies the queued operations are reviewed again against the current version and
drops go into the next brief. Daemon lifecycle changes record nobody, and their removals take the
authorship along. Authorship keeps the 2,000 most recently set nodes.

Prioritizing still reads and writes HTML: `list_sidebar` shows the current version with its queued
proposals drawn in, at the current version plus one per proposal, and each edit is diffed by ID
against that view into operations. A stale `edit_sidebar` still applies when every old text occurs
exactly once; a stale whole-document artifact update is a conflict. Each queued proposal applies
as its own version, rebased from the version it was queued against with the earlier proposals
drawn in, and a person's change no longer discards them.

The person's batches are recorded by mutation ID with a digest of the request (the latest 500 per
person), so a retry answers with the first result without applying again, also when retries race.
The document rules (known space IDs, sessions under their parent) are checked only on the nodes a
batch places, so a stale node nobody touched never blocks the person. Every version is announced
with `space.sidebar.changed` carrying its operations; `artifact.updated` is still emitted for
older clients.

Older clients keep working unchanged, which was the simpler choice over refusing them: `PUT
/v0/spaces/sidebar` stays, with CAS and no rebase, and is diffed into the person's operations so
authorship and events match. Widgets are invisible to them: `GET` leaves widgets out unless
`widgets=true`, a `PUT` may not contain one, and widgets it leaves out stay where they are.

`happy-widget` is the one escape hatch: a leaf of opaque HTML (16 KiB, never nested, ending at the
first `</happy-widget` in any case) that moves, folds, and counts toward the budget like a row and
is drawn isolated by clients. Prioritizing may add or update widgets, rarely, for a compact card
that says more than rows can.

New rows go right below Happy, after everything nested under it, where the person expects new
work; or after the section or separator they were made under. When Happy is gone, nested, or
inside a collapsed section, they go right after Create instead, so new work is never hidden.
Archived rows and sessions leave the document with everything nested under them. Demo and daemon
setup must use manager placement, not the person-only legacy PATCH route, which records
`manual_at`.

Maintenance notes have durable runs without provider events. Live API delivery must announce the
terminal run as well as its message so an open chat can render exactly the note found after reload.

## Work carries its lists, and its subtasks only show

Kirill wanted a task's own agent, and Prioritizing, to "add stuff to the sidebar as subsections",
such as a todo list or a chat with another person under the work it belongs to. A nested
`happy-space` may now also name one of the person's rows, an attachment. IDs are unique, so a
space stands in one place only and attaching moves it. Taking an attachment out never deletes it:
the daemon rewrites that `remove` into a move to the top level right after its row, for the
person, Prioritizing, and whole-document writes alike, and a leaving row lifts its attachments
out before its sessions go with it. An attached todo, document, or calendar Surface keeps its row
while empty (`attachedSurfaceIds`) until the person leaves it; chat Surfaces have rows on
membership. `attach_to_my_row` is the conversation's tool, offered only when its person has Stem
Cells on; it applies at once as Prioritizing's write, so the person's placements still win and a
dragged-out attachment is never put back. People outside the installation cannot be invited, so a
chat with someone is a chat Surface they are a member of.

Steve likes reviewing the code a subtask changes, so subtasks must be easy to see, but a subtask
must never move to another row. Sessions still stand only under their own parent on every write
path. Prioritizing now shows a session the person likely wants (one changing code, or one waiting
for review), not only one blocked on them. The person reveals a row's sessions with an ordinary
insert batch; that records the sessions' place as theirs, and Prioritizing may not take them out,
fold the row, or fold a section over them.

## Turning Spaces on moves nothing

Kirill asked that new people start from the sidebar they already know, with Prioritizing proposing
changes only afterwards. The first document is Search, Create, Happy, the joined Surfaces in
member order, a `divider` separator, a `bots` section labelled Bots with the other active bots, and
a `tasks` section labelled Tasks with joined tasks in membership order, each row with its active
subtasks nested and shown. Kirill moved Happy out of Bots so new work lands right below it. Bots
and Tasks are default sections, present even when empty and kept stable: Prioritizing is told to
keep them, and Bots especially stable (long-term responsibilities). The fixed IDs let the desktop apply the
person's classic folds, which live only on the desktop, with one write. The owner state carries `sidebarSeed` until that write or Prioritizing's
next notice, and Prioritizing's writes are refused while it is set; its opening turn only gives
icons.

## A stem cell stays one until the person speaks

Kirill saw new work turn into something before saying what it was. The row was briefed to
Prioritizing on insertion, and its opening and later briefs let it give an icon and place the row.
Now insertion of untouched new work briefs nothing, an icon for a stem cell whose first message
has not arrived is refused (`briefedAt` marks that message), and the prompt says it waits for that
message.

## Sessions are hidden by default, and every one gets an icon

Showing working subtasks under their rows, and seeding every row with its subtasks expanded, made
the sidebar long. Kirill: give every session an icon, but don't show sessions. Subtasks and
collaborators are still created as before. The seed shows rows only, and Prioritizing leaves
sessions out of the document unless there is a strong reason to show one, such as a session
waiting on the person; a shown session counts toward the visible budget. The grammar keeps nested
sessions, so the person or Prioritizing can still show one. Session icons live in the owner state
by agent ID, are served as `agentIcons` beside the document, and Prioritizing is briefed when a
session starts under one of the person's rows.

## About ten rows are shown

A sidebar that showed everything was not prioritized. Prioritizing aims for at most ten shown rows
as a hard target: rows outside collapsed sections plus shown sessions, not counting Search,
Create, Happy, headings, separators, or new work waiting for its first message. `list_sidebar`
reports `visibleRows: {shown, budget}` for the document including pending edits. The daemon does
not refuse a batch over budget: work waiting on the person, recent work, and the person's own
moves and folds may alone exceed it, and refusing would leave Prioritizing no valid edit.

In a live run Prioritizing stopped at 14 and called it the floor, though folding Releases and Bots
would have reached 9. It had read "placed by the person" as "must stay shown", and treated quiet
rows whose last reply offered more help as waiting on the person. The prompt now says placing
protects position, not visibility; that waiting means the work cannot go on without the person,
and still counts; and that over budget it folds whole quiet sections first, Bots included, then
puts quiet work into Distractions one row per batch, then removes what the rules allow.

## Rows mirrored from the classic sidebar start placed

The first document mirrors rows the person already knows, but they kept the `pending` placement
of new rows. A pending row's move counts as a first placement, which applies without a proposal,
so Prioritizing could have reshuffled the whole mirrored sidebar, and `list_sidebar` called every
row "not placed yet". Creating the document now records every mirrored row, except untouched new
work, as placed.

## Prioritizing hears the person, and reads threads by turn

Placing by title and timestamps alone misjudged what work was about and whether it was done.
Reading one row at a time, newest message first, made tidying slow and drowned it in replies.
Kirill asked for a reader that is "easier to filter, remove the tool calls, and limit to only the
last X assistant messages per turn". `read_conversations {ids, turns, replies}` reads up to twelve
rows or sessions at once: each with its title and last activity, then its latest turns oldest
first, a turn being one message from the person or another agent and the agent's last text
replies to it. Tool calls, reasoning, and hidden messages are left out, and each message (1,200
characters), conversation (about 4,000), and answer (about 24,000) is bounded
(`formatConversationTurns`).

Reading every thread made each turn long, and the first message alone often said too little to
place new work. Kirill: send every message the person writes in stem-cell chats to the focus
agent, "and the last text message before", so it has enough context. Each later message the person
writes is now a short notice quoting the agent's last text reply and the message, without tool
calls (widened from stem-cell work to every row, and shortened to 240 and 400 characters, in
revision 4 above); a session under stem-cell work that stops is one too, with its last reply. Only the latest three
notices per row wait, so a busy chat never crowds the rest out. They wait for the next wake rather
than causing one, except while the work still waits for its first placement, when a message may
make its subject clear. Stem-cell origin is read from the subject-naming mark, which only
`createStemCell` sets and which covers chats under it.

## Sections are the layout, and Prioritizing inserts rather than reshuffles

Prioritizing barely used sections and treated new work as something to rank among the rest.
Kirill: sections are "one of the core components"; keep "a bucket for distractions" folded by
default; place a stem cell "when there's enough signal"; and "we want minimal reordering. We just
want insertion usually", with no major reorganisation unless the person asks. The prompt now makes
topic sections the layout, keeps one `distractions` section labelled Distractions and collapsed for
work outside the person's focus, places new work once its messages make the subject clear, adds a
new section where no existing row changes section, and moves a placed row only for a strong reason.
A session that needs the person (review, approval, an answer) is nested under its row, expanded,
and taken out again afterwards. A move limit per batch came first; it is replaced by consent (see
below). In the first live run Prioritizing still filed related work beside a row in the default
Tasks section instead of making a topic section; the prompt now says Bots and Tasks are defaults,
not topics. The prompt was rewritten shorter, from about 9,600 to about 5,000 characters.

## Larger changes are proposals the person accepts

Kirill: "We should not just completely replace the sidebar without the consent of the person.
Similar style to Arc." Prioritizing's own batches now apply only small changes
(`reviewDirectOperation`): new work's first placement, the folded Distractions section, its own
row, and what is nested under a row (sessions, attachments, `expanded`). Everything else is dropped
with a note naming `propose_sidebar`, unless the person asked in their own words. A proposal is a
`sidebar_proposal` artifact whose version 1 is the sidebar it was drafted from, shown inline at
full height in Prioritizing's conversation. The person edits it live through the proposal
operations route, and the aspects they set are recorded on the proposal so Prioritizing's
revisions keep them (`reviewProposalOperations`). Accepting applies the difference between its
first and latest version as the person's batch, rebased one operation at a time, so what the person
accepted is theirs; declining changes nothing. At most one is open.

The user then made the card a preview only: no checkboxes, Accept, or Decline in it. The decision is
the chat button Good to go (`sidebar.proposalAccept`), pressed as the person's message in Happy's
chat or Focus's; the accept and decline routes stay for compatibility. Changes are typed and Focus
revises. A proposal may offer chats the person does not have yet as `newRows`: Focus names them
`new-…`, the daemon reserves a space ID for each at once, and accepting creates each still placed in
the proposal with its final title and icon, then sends its first message read-only.

Kirill also asked it to "offer to completely archive the stuff that looks completed based off the
agents' history" and to put unfinished quiet work "in a new section called Stale". A proposal may
carry a `<happy-section id="archive" label="Archive"/>` block of top-level task rows that are
neither new nor active in the last two hours; accepting archives those tasks with the person's own
archive authority and leaves the block out of the sidebar. `Stale`, exactly, is the one age label
Prioritizing may use, and never a required one. The heuristics (finished means the last reply
reports it done, the person acknowledged or never followed up, and nothing waited for two days)
live in the prompt. Kirill also suggested a recipe for the prompt; this repository has no recipe
runtime that carries a system prompt and tool set, so the prompt stays in
`formatPrioritizingInstructions`, and the example arrangement in it is advice, never a rule the
daemon enforces.

## What evaluation replays taught the prompt

Replays on real sidebars (Opus, 21 and then 18 runs) showed proposals that folded work active
minutes earlier, put bots, shared lists, and finished tasks into Stale, kept a 17-row "Active"
catch-all, moved rows the person kept above the separator, moved the separator to the end, left 16
to 19 rows shown, and pasted the proposal's tag into replies; none offered clearly finished tasks
for archiving, because the prompt said never to touch rows the person placed, which mirroring made
nearly all of them. Each of these was first enforced by the daemon, and the rules fought: guarding
a kept row's section blocked renaming the catch-all over it, and one run took 7 revisions and 31
dropped edits. They are all prompt guidance now (see the first learning). The prompt lets a
proposal regroup and fold rows the person placed, since accepting is their consent; asks it to
section an unsectioned sidebar or a catch-all (Kirill: "if it's not sectioned, probably should
offer to section it") and fold quiet sections until within budget; sends finished work to Archive
and only unfinished tasks to Stale; and asks for a one-sentence reply saying what changed, since
replies ran 80 to 250 words. `propose_sidebar` returns the proposal's ID without its reference
tag, and `list_sidebar` marks rows with nothing to read.

With the prompt alone (18 runs), proposals took one version each with no dropped edits, in about
half the time and tokens. Three lines needed sharpening. "Keeps rows below every separator" froze
the rows under the person's separator, which were the Archive and Stale candidates, so offers
nearly vanished; the prompt now keeps at least one row below each separator and lets the others go
under Archive or Stale. "A busy bot may sit above Bots" let it fold Bots over a busy bot; the
prompt now says to move such a bot above Bots first. A row the person kept above the separator was
still folded with a quiet neighbour in 5 of 18 runs, even with "never in a folded section", because
the model had to work out which rows the line meant from authorship and document order.
`list_sidebar` marks them `keepInPlace: true` again, as information only, and the prompt names the
mark. With it the row stayed shown in every run, but "never move" was read loosely, since
regrouping around the row moves it; what matters is that it stays shown at the top, so the line is
now "never folds a row marked keepInPlace or moves it below the separator". One run folded work
active 1.7 hours ago that `list_sidebar` rounded to "2 h ago", right at the two hours the prompt
counts from; ages now read in minutes up to three hours.

The first `read_conversations` batch of a large sidebar passes its 24,000-character bound, and in
some runs Prioritizing never read the left-out rows again despite "read again any it left out";
those were the quiet rows below the separator, so it offered no Archive or Stale. The answer now
ends with one line naming every left-out row by its heading and saying to read them before deciding
where they go. Another run moved a bot active an hour ago into a folded section, so the prompt says
never to fold away recent work "even when you move it into a section".

With rows read again, Prioritizing still filed the quiet tasks into folded topic sections rather
than Archive or Stale, since the prompt only said they "may go" there, and once more folded a bot
active an hour ago, not counting a bot as work. The prompt now says to offer a finished task under
Archive and an unfinished quiet one under Stale rather than folding it into a topic section, and
never to fold away anything active in the last two hours, "bot or task".

On Kirill's install, after the update notice, Prioritizing (on GPT-5.6 Sol) tried to restore its
row by moving the row between it and Happy below its own row; that move is not allowed without a
proposal, so it gave up and left its row third. The prompt now says to move its own row, never the
rows in between, and the refusal of a move placed right after its own row says to move its own row
instead. `list_sidebar` also marked its own row `noConversation`, though it has one; only shared
Surfaces carry that mark now.

## Prioritizing has its own conversation

Notes in Happy's chat interrupted the main agent: "the focus agent normally should never bother the
main Happy agent". Prioritizing has a space of its own (role `focus`, target kind `agent`). It was
first shown as a top-level row so the person learns a proposal exists; the prompt now keeps that
row out (see "Focus is the default name and lives under Happy"), and what follows is its history. The daemon makes the space but never puts it in the
document; Prioritizing inserts it, even during the seed, whenever it finds it missing, unless the
person removed it. Inserting it twice is a duplicate ID. A Prioritizing from before its row gets
the space on the first start of a newer daemon, and one upgrade notice; what to do from there it
decides from its own conversation. Archiving Prioritizing removes its row.

On Kirill's install new work kept going in right after Happy, so the row slid down to third and
further: "why the focus agent does not show up under my happy agent". A daemon anchor and a startup
repair that moved the row back were tried and removed, since where the row stands is
Prioritizing's call (Kirill: "it should move ITSELF"). The prompt keeps the row right under Happy
unless the person put it elsewhere, moving its own row applies without a proposal and is never
capped, and a row the person placed is theirs. Raising `PRIORITIZING_REVISION` when the
instructions change tells each running Prioritizing once, on the next start, to check the sidebar
against them, starting with its row. Six prompt changes shipped without raising it, so Kirill's
Prioritizing was never told and its row stayed third; the revision now lives beside the prompt, and
a unit test pins it to the prompt's digest, so a prompt change without a new revision fails.

## Prioritizing runs on the default model from Settings

Prioritizing ran on the cheapest model at the lowest effort, and its grouping and choices were
poor. It now runs on `happy-desktop.model.default`, the model a new chat starts with, at that
model's own default effort, read through the person's own context in team mode; without a chosen
model still served, the installation's default model. Titles likewise no longer uses a cheap
route; it writes names with the chat's own model (see the Titles learnings).

That default is only what a new Prioritizing is made on. Every notice also named the current default
model, so on Kirill's install, where Opus 5.5 had been chosen in Prioritizing's own conversation and
its mode reported it, every wake ran on the Settings default (GPT-5.6 Sol) instead. Dropping the
model from notices was not enough: a message without one keeps the model of the last message that
named one, and that was the old daemon's last notice, so after the update the notice wakes still ran
on GPT-5.6 Sol until Kirill wrote in the chat. The mode an agent reports is its `lastMode`, which
only the person's messages set. Each notice now carries that mode while it is still offered, and
names no model only when there is none.

## Clients report nothing about what the person sees

`POST /v0/spaces/sidebar/observations` sent which rows were in the viewport. Visibility was never
permission to move anything, folds already live in the document, and the reports only woke
Prioritizing, so the route, its schema, and its brief were removed. An older desktop that still
sends it gets a 404 and ignores it.

## Batch notes are one factual line in Prioritizing's conversation

Kirill and the UX review asked for terse notes such as "Put Preview viewer release in Releases."
with no narration; folded work is "tucked away", never "Older", because quiet is not done. Prioritizing no longer writes free text: the note is composed from the batch's
own diff, so it can only describe what moved; a batch of several moves names two and counts the
rest. Prioritizing gives no reasons: a cheap model's clause ("Hid Quick Sanity Check finished
one-off check.") broke the line, and nothing else read them.

## Events wake Prioritizing; attention does not

Batches once waited for a calm moment: the client reported `interacting` and `calm`, and the daemon
fell back to five idle minutes. Rows still moved under a person reading between clicks, and work
sat unplaced while they kept typing. Once larger changes needed consent, the hover gate protected
nothing, and Kirill asked for it to go: Prioritizing is now woken by events and its changes apply
when its turn ends. The person's committed sidebar changes, new work or sessions appearing, new
work's first message, proposal edits and decisions, placement requests, and Tidy wake it; other
notices wait for the next wake. Its own writes never wake it, so it cannot loop. A wake waits two
seconds for the rest of its burst, a wake during a turn waits for that turn to end, and the
fifteen-second check only picks up what a restart or a lost timer left. `POST /v0/spaces/attention`
is still accepted so older desktops keep working: `calm` applies a waiting batch, `interacting`
does nothing. Every row a batch folds out of view is named in its note, because that is the change
the person can no longer see.

## Notices stay owed until a run succeeds

Live, a Prioritizing whose model had no credentials failed nine runs in a row, and every notice
from that time was lost: a brief cleared its notices when the delivery was enqueued. A brief now
moves them to `sidebarBriefSent`; a run that ends well clears them, and a failed run puts them
back for the next wake. A failure never wakes it by itself, so a broken model cannot spin.

## Work another agent creates is placed too

Tasks made with `create_task` sat under Happy forever: only the person's messages were briefed, a
task's first message arrived before its row existed, and the prompt said to wait for a first
message. A new row's notice now carries its title and wakes Prioritizing, the first message of the
conversation counts whoever wrote it (a later report from a subtask does not), a row made after its
first message is told that message at once, and the prompt says pending work is placeable once its
subject is clear.

## A separator's pin is only the person's

Kirill wanted the person to pin a separator to the top or bottom of their sidebar, as their own data
in the document: `<happy-separator id pin="top|bottom"/>`, absent when unpinned, changed with
`set {pin}` (`null` unpins). Unlike folds or labels, which Prioritizing may set until the person
does, a pin is never Prioritizing's: any operation of its that sets, changes, or clears one, or
inserts a pinned separator, is dropped, in batches and proposals alike. So a proposal never carries a
pin change, and accepting one (the difference between its first and latest version) keeps whatever
pin the person has now, even one set after the proposal was drafted. The prompt says the same in one
line, so Prioritizing does not keep trying.

## A set that changes nothing is still the person's

The desktop sends `set {expanded: true}` for "Show subtasks" on a row that may already be open. The
client drops an operation that changes no value, so the person was never recorded as the fold's
author and Prioritizing could fold the row later. The person's requested `set`s now record their
named aspects as the person's even when nothing changed (`affirmSidebarAuthorship`).

## A row's `working` follows its conversation

`working` was computed only when something else about the row changed, so a row kept shimmering
after its conversation stopped, aborted runs above all. The module now listens for `loop.started`
and `loop.settled` and, 300 ms after the first of a burst, publishes every row whose target is that
conversation with a greater version and `working` read then, after the settled run has left the
journal's active runs. It publishes even when it last published the same value, because every row
event carries `working` live: the naming update during a run, for one, already showed the row
working. The row's `updatedAt` stays, so folded rows keep their order.

## People who never opted in are untouched

Spaces is an experiment, and a person who has not turned it on must see the daemon behave exactly
as before. The first sidebar read or write, or the first stem cell creates
the person's owner state and sidebar document; Prioritizing additionally requires the person's
Stem Cells setting as described below. Everything else (lifecycle
inserts, new-session and new-work briefs, the wake check, batch notes) works from that
state and so does nothing without it. The `request_space_placement` tool is offered only to
conversations whose person has a live Prioritizing, and asking for a placement never creates an
owner.

Naming follows the same line. Short subject names (one to three words from the chat's own model)
were first made the naming for every chat, and that changed every person's task, bot and workspace
names. Now only a stem cell is named that way: `createStemCell` marks its agent through
`TitlesModule.nameBySubject` in the same transaction, and every other chat keeps the standard
naming it always had.

## Prioritizing follows each person's Stem Cells setting

Reading the sidebar used to activate Prioritizing, and switching Stem Cells off in the desktop
left that helper running. Prioritizing now requires the literal boolean `true` in the person's
`happy-desktop.experiments.stemCells` user setting. Missing, cleared, false, or malformed values
leave it off. A sidebar document can still exist without the helper. Team lookups resolve the
row owner's settings, never whichever caller happens to be processing an event.

Disabling atomically clears pending layout edits and notices and aborts that person's helper.
A persisted generation invalidates already queued durable notices even if the person enables it
again. Creation, briefing, tools, artifact writes, and batch application all check the setting;
restart also stops disabled helpers. Ordinary task, bot, and chat naming remains independent, and
existing names are never changed by the toggle.

## The sidebar format is marked by a migration

`006-sidebar-document-format` changes no data a reader depends on (it drops the old visibility
reports), but its key is what an older build that knows Spaces sees as unknown, so it refuses the
database cleanly instead of failing on the flat document. Any later change older builds cannot
read needs its own marker migration. `007-sidebar-operations` is the next: it adds the mutation
log and turns each person's manual lists into authorship (a placed or named item keeps place and
label, a set switch keeps its fold). Queued Prioritizing proposals were whole documents and are
dropped with a note rather than converted, since converting would need the version each was
written against; Prioritizing reads the sidebar again at its next notice.

## Stored state survives a rollback

A desktop swapped a database written by a newer build to release 0.4.104, whose strict read of
each person's state rejected the new fields; the throw ran at startup and the supervisor restarted
it forever. Reading stored owner state now drops fields this build does not know, so a newer build
that only adds fields stays readable. State that still does not fit makes Spaces unavailable for
that one person: it is logged, skipped by the background work, and every route for them answers
with a plain error the desktop can show. It never stops the daemon. Releases up to 0.4.104 cannot
be fixed this way; protecting them belongs to whatever installs daemon releases.

## One row per piece of work, enforced by the store

A stem cell made before the sidebar was ever read collided with its own seeded row: the seed saw
the new task, the stem cell took that row over, but the emptied row kept its content key and the
insert failed. Every write now recomputes the key from the row's contents, and seeding is an
insert-if-absent on `(owner, content key)`, so concurrent or repeated seeds can never make a
second row for the same work. Rows that merely share a title are different conversations and are
never merged.

A stem-cell ID reserves both its row and conversation inside one database transaction. Replays
check ownership before creating work and return the stored task's agent; an existing ID never
creates a second task or discloses another person's row.

## New work is named by the client, so it appears in the click's frame

The daemon answered in about 20 ms, yet the desktop could select the new chat and focus its
composer only after the reply, because the daemon chose the task, workspace, and agent IDs. Kirill:
"must be instant - so must happen on the client i guess? hmmm we need optimistic writes". New work
now also takes `taskId`, `workspaceId`, and `agentId`, checked exactly as task creation checks
them, and health advertises `stemCellIdentities`. The space ID stays the only retry key: a replay
must name the same conversation or is a conflict, and a child ID arriving under a new space ID is
always a conflict, never a second row over an existing task.

## Unnamed work has no title, and untouched work can be removed

The desktop labels a row "New" itself, so a task still carrying its placeholder name is served
with `title: null` instead of "New Task"; notes call it "a new chat". Rows
are otherwise never deleted, but a stem cell the person left without writing anything is not
work: removing it (`PATCH` with `removed: true`) deletes the row and archives its task, and is
refused (409) as soon as the conversation holds any message.

## Section names are unique by the prompt

On clean data a cheap model created a "Movies" section for each of two new rows in one turn. The
daemon once refused a section label that repeated another's; it now only refuses duplicate IDs,
and the prompt says labels are unique.

## Archived work leaves the sidebar

Archiving a task only hid its row, which still came back from `GET /v0/spaces` and looked like a
leftover to clients. Archiving (or leaving) work now removes its rows and anything queued for
them, with `space.removed`; unarchiving adds a fresh pending row for each member. `hidden`
remains Prioritizing's choice for live work it tucks away.

Bots follow the same restoration rule: a transition from archived to active adds one pending row
for each already-seeded owner. The content-key constraint makes repeated notifications harmless;
system bots remain outside the ordinary bot listener.

Removing untouched work archives its task, so owning a sidebar row is insufficient authority.
The API checks the same task-owner or team-owner policy as task archival inside the transaction
that removes the row, before any row or task changes.

## Surfaces keep following membership after the first read

Seeding only once left newly created or joined Surfaces absent and left stale rows after leaving.
Spaces now owns a Surfaces event subscription and reconciles each seeded owner's membership in
one transaction, emitting private row events and refreshing names and pictures. Durable events
read current membership so a delayed join cannot undo a later leave; closing Spaces unsubscribes.

Todo lists, documents, and calendars contribute rows once populated; other supported kinds,
including existing reference Surfaces, keep their membership-based seeding. Content events reconcile
current membership and current content, removing empty rows and restoring populated ones without
moving rows that remain eligible. Startup reconciles already seeded owners too. Document edits
have a durable internal notification independent of editor subscriptions; completed todos count
as content, deleted records do not, and calendar existence does not depend on a displayed range.
System monitors remain outside Spaces.

## The API is only what the desktop uses

Kirill reviewed the contract before it was specified. Everything the desktop did not read was
removed rather than kept "in case": the organiser's row, a row's own name, section context lines,
batch reasons and section diffs, revisions, the pending-batch count, focus reports, single-row
reads, and the organiser-model setting. Space events carry whole objects, so they need no
`previousVersion`.

## Happy is an ordinary row

A `role` field and Happy-specific IDs made clients special-case Happy. The API now shows Happy as
an ordinary row whose target is Happy's bot. The prompt keeps Prioritizing off it, and the person
may drag it. Sessions under a row are part of the document, not drawn by clients from `subtasks`;
worktrees are still drawn by clients under the session that works in them.

## The person's changes are PATCHes; tidy is one message

Separate move, discard, and collapse routes were replaced by `PATCH /v0/spaces/:id` (`sectionId`,
`afterId`, `visibility`, or `removed`) and `PATCH /v0/spaces/sections/:id`, like other resources.
Tidy had its own apply-at-once machinery; it is now only the automatic message "Tidy the sidebar
now." in Prioritizing's conversation, and its changes apply when that turn ends like any other
batch.

## The organiser is Prioritizing, a real subtask of Happy

The organiser was a hidden child agent called "Sidebar manager", invisible in Happy's tree. It
then became a conversation subtask (`createConversation`, with its own metadata), which Kirill
still saw as not a true subtask. It is now made through `SubtasksModule.create`, exactly as Happy
makes any subtask, with an opening task and nothing special-cased; it is found by the agent ID in
the person's bookkeeping. It is created with the person's first stem cell, a tidy request, or
onboarding's Discover — never on seed or a read of the sidebar. As an ordinary subtask it reported
every reply into Happy's chat, so it is created `unreported`, and batch notes go to its own
conversation. Happy hears from it only when Happy asked: a message from Happy (or the task
onboarding started it with) marks the owner `happyAsked`, and when that turn ends Spaces sends Happy
one message naming the open proposal and what Focus said. Its opening task alone does not count,
so a tidy-started Focus never writes into Happy's chat.

Onboarding starts it through `startFocus`, which also shows it at once: its session under Happy
with the `goals` icon, Happy unfolded unless the person set the fold, as the daemon's one sidebar
change. The person consents to reading their work at Discover (`allowDiscovery`); only then is
`discover_work` among Focus's tools.

## Recent work stays in view by the prompt

Six tidy requests in a row led a cheap model to hide every row but Happy, including a task that
was running. The daemon then refused to fold or hide work active in the last two hours; that rule
is gone, and the prompt says never to fold away recent work. Folding is a proposal the person
accepts, so a bad fold reaches the sidebar only with their consent.

## Voice reads the sidebar and asks Prioritizing to change it

Voice, the person's voice-call agent, needed to know and talk about the sidebar without becoming a
second organiser. It has its own row (role `voice`), made by the daemon below Happy or below
Prioritizing's row, settled and never briefed as work, and only read tools; moving, folding or
hiding goes to Prioritizing through `request_space_placement`, and tidying through
`request_sidebar_tidy`, which tells Voice when nothing organizes the sidebar yet. Kirill chose that
Voice may read any conversation's public text on this machine, so `read_conversations` has a
`machine` scope; on a team installation "this machine" holds other members' work, so the scope
stays the person's own there.

## New work after Happy must not grow keys

New and moved work goes to the top of a section, right after Happy, so every arrival took the
midpoint between Happy and the previous top row, a digit longer every three arrivals toward the
256-character bound. A key right after Happy, whether for new work or an explicit placement after
it, now sits just below the previous top row, leaving the room after Happy for the next arrival;
other placements keep the shortest midpoint. With nothing below Happy the key is still the midpoint
to the end, `5` after Happy's `1`, because Prioritizing's and Voice's rows are made at `2` and `3`
and the first stem cell can be made before them; a step to `2` would tie with Prioritizing's row.
The `011-space-order-keys-renumbered` migration gives a sidebar that already grew a key past half
the bound fresh keys in its order, rows and sections alike, advancing each changed row's version so
clients holding the old row take the new key.
