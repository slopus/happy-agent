# Live module learnings

## Voice belongs to one desktop window

Binding voice to a coding agent exposed the wrong tools and hid desktop navigation. A call acts only
in the window that started it, through fixed tool arrays: read-only sidebar tools, five desktop
actions, plus `taskCreate` and `sessionModelChange` only when the desktop negotiated them.
Workspace, conversation and bot creation were removed from the surface (they remain in the wire
union for compatibility) because voice should open what exists, start work as a task whose first
message is the person's words, and change models rather than build structure. `sessionWatch` went
with the notices it fed. Voice acts only on this daemon's conversations; another server's
connection is refused. No permission answers, private reasoning, or arbitrary execution enters Live.

## Voice is the person's long-running subtask

Each call used to open its own hidden controller conversation. It forgot everything when the call
ended, could not read the sidebar or other conversations, and its work was invisible. Voice is now
one long-running, unreported subtask of Happy per person, created with their first call through
`SubtasksModule.create`, the path every subtask takes. A conversation subtask without an opening
task was considered and dropped: Kirill had already rejected that shape as not a true subtask.
Voice's opening task only confirms it is set up, and runs on the voice settings' controller as new
agents are offered it, because a pool's frozen member is hidden from new agents. Every later call
hands requests to the same Voice until the person archives it; the next call creates a new one.
Live supplies Voice's instructions and fixed tool arrays through its own hooks, sends each request
as an agent-originated message on the call's frozen route, and watches Voice's turn through
`messageAccepted`, `beforeInference`, `onEvent` and `afterAgentSettled`. A restart that would
resume an interrupted Voice turn stops it instead: speech from a finished call must not act later.

Voice keeps what it was told in its own conversation, including the speech it was handed; the
person chose that over a hidden history. Each request carries only speech fragments Voice has not
seen, the call's first context only when Voice has not seen that exact text (tracked by hash), the
context updates voice was told since Voice's last request, and `personSaid`, every turn the person
spoke since voice last sent something. Without `personSaid`, "send that" after two spoken thoughts
sent only the last one, because the earlier thought had reached Voice in an earlier request.

A request runs in its own named lifetime, detached from the provider event that queued it. The first
version detached without carrying the agent database, so every request failed at its first read;
the request context now carries the database explicitly.

## The controller route comes from voice settings

The controller was pinned to GPT-6 Luna on the default provider, which made a slower or unavailable
model impossible to change. `[voice]` settings now choose the controller account, model, effort and
speed. Kirill chose GPT-6.2 Sol at the Ultrafast speed where the account's plan allows it, else the
fastest speed it allows, configurable as Regular, Fast or Ultrafast like the model picker; the
older fast-mode boolean still reads as Fast or Regular when no speed is stored. Ultrafast
eligibility comes from the same account service-tier cache the model picker uses. Runtime changes
from `PATCH /v0/config` or the admin-bot tools live in generated `runtime.toml` and override the
machine file; the built-in voice prompt is never stored, and a prompt identical to it removes the
override. The route, effort, service tier and voice prompt are frozen when a call starts. A stored
speed the route does not offer falls to the fastest one below it, and the notice says so. The
explicitly selected voice credential stays separate. Controller inference is the slowest part of a
delegated request: earlier evals measured 3–10 s to the first tool on GPT-6.1 Sol low against about
2 s on GPT-6 Luna, varying between runs, while desktop round trips took milliseconds.

## Default account pools resolve once, onto an account that works

Rejecting every smart default prevented voice from starting when ordinary conversations used an
account pool. Live selects one enabled compatible account from that pool at startup and holds its
concrete provider for the whole call; the provider registry and a call-local lifetime still enforce
disablement and daemon shutdown. A random first choice once froze a call onto a pool member whose
Codex sign-in could no longer be renewed while the other member was healthy. Choosing well at call
start is allowed; switching later is not. The pool freezes onto the voice credential's own account
when the pool includes it; otherwise it prefers an account whose latest inference did not end in a
typed authentication or out-of-tokens failure within fifteen minutes, and only when every account
has failed does it fall back to them. Once frozen, the account is never rotated, a failed
delegation is never retried, and credential kinds never cross.

When the frozen account's sign-in is rejected or its usage runs out, the failed request gets a
fixed explanation naming that cause and what the person can do, instead of a generic failure they
would only retry. `controller.failed` diagnostics record the provider error `type` beside its
`kind`, because `kind` alone could not tell authentication, rate limits and unclassified errors
apart.

## Voice says why a call failed and which accounts can carry one

A desktop could only show a failed call's sanitized text, and offered every OpenAI account as a
Codex subscription, so an API-key account was refused. With client 0.0.183 a failed status frame
carries a typed `reason` (sign-in, API key, usage, timeouts, lost connection or control, restart)
to desktops that negotiate `failureReasons`, the session keeps it as `failureReason`, and
`config.voice` reports `accounts`, each with the credential kind `liveCredential` accepts, beside
the controller's `speed` and the `speeds` its route offers. A stopping daemon fails its calls with
`restart` before closing their control sockets, so the desktop can say what happened.

## Setup errors identify which selection failed

One generic controller-and-credential error hid an invalid voice credential after the controller
was fixed. Live reports controller setup separately from credential setup and explicitly explains a
proven account-pool credential selection. Only that fixed configuration-owned error is forwarded;
arbitrary provider diagnostics stay private.

## The native endpoint ignores `instructions`; startup developer messages carry the prompt

For a week every voice prompt change (delegation, thinking aloud, greeting, hang-up) moved nothing,
and a prompt saying there was no backend still delegated six of six status questions. A probe
settled it: with the voice prompt replaced by "start every reply with Banana; your name is Pickle",
the native Codex call never said either; with the same text as a startup developer message, every
reply began "Banana". The native calls endpoint ignores `session.instructions` and follows startup
developer messages, which OpenAI's prompting guide documents for startup guidance. Native calls give
the voice prompt as the first startup item, before the first context, and it comes out of the same
24 KiB startup budget; the public session keeps `instructions`. Results measured before this fix
reflect the endpoint's own defaults, which tell the model to delegate everything; conclusions drawn
from them about what the prompt can do are void.

Once the prompt was actually read, voice stopped delegating at all and claimed "Sent." for work it
never handed off. The delegation section now follows OpenAI's GPT-Live template: the backend's tools,
when to delegate, and when not to, and voice never says something was done until an outcome says so.
Because every prompt token now costs startup budget, each rule is stated once.

## The native Codex endpoint chooses its model

The native calls endpoint accepted `gpt-live-1-codex`, `gpt-live-1.1-codex` and a nonsense id alike,
and `session.started` reports no model, so the served model is the endpoint's choice; Live keeps
Codex's own `gpt-live-1-codex`. The public transport requests `gpt-live-1.1`, the API's latest
GPT-Live model since November 19, 2026.

## Voice is told what the phones tell their voice agent

GPT-Live was first given Markdown AppState pushed on every change, and treated some pushes as
something to talk about. It was then cut to sidebar names alone, so every status, time or content
question became a five-second delegation, a failed run or a pending question was invisible, and
voice had no memory of the last call. Kirill decided to do what mobile does for most context
management, with mobile's caps.

Voice gets the phones' model, built from this daemon's own records rather than the desktop's
projection: a first context with the call's start on the person's clock, the recap of recent calls,
the conversation on screen with its last five timed turns, and the directory with order-key
references, status, the pending question, a failed last run and last activity; then silent JSON
updates for directory changes, focus with turns voice has not seen, status changes, and replies and
errors from the last four conversations on screen or sent to. Each piece is told once and nothing is
replayed. Only GPT-Live's limits change the phones' numbers: startup input is 8,192 tokens, so the
first context is 24 KiB instead of 32 KiB, and appends are split at 500 bytes. Kirill's rule that an
opened conversation's recent turns go into context at once adds turns to `focus`, which the phones
do not send. Voice receives the same first context and updates, so it starts from what voice knows
instead of listing and reading again. With that context, status, listing, time and content
questions are answered without delegation (S1 21/21 in every after-run).

## The directory lists 100; search finds the rest

The directory first left out project and workspace conversations, where most of a person's work
lives; it now nests them under project and workspace headings as the phones do. Kirill's cap is
mobile's: at most 100 conversations within 12 KiB, never the whole sidebar. When more exist it keeps
the one on screen, the followed ones and the most recently active, says how many more exist, and the
prompt tells voice to delegate a search by name for one it cannot find rather than say it does not
exist. Voice's `list_sidebar` searches every conversation, a page of 50 within 24 KiB at a time.
The directory read once stopped at 500 rows, so on a 524-conversation remote the last project's
conversations were invisible to search and every lookup returned nothing; the read is now bounded
only at 5,000 rows, and a test puts the target past 600. Heading lines are not conversations: a
context listing 100 conversations under 23 project headings has 124 lines.

Voice holds references only for what it was told. Updates once named conversations outside the 100
by references voice never received; now directory changes cover only the conversations voice holds,
and an unlisted conversation is told only once it starts work, needs the person or fails, when the
line names it with its kind and voice holds its reference from then on.

## Building the first context must not slow the call's start

The first context is built before the call is allocated, because it is the session's startup input.
Ranking the directory first read every conversation's latest message, and the realistic remote eval
(524 conversations, 60 ms round trip) measured press-to-active growing by 326 ms at the median. Last
activity now comes from one query over every conversation's latest run, pending questions are read
only for the conversations that will be listed, and the directory reads each list's configurations
and every conversation's subtasks together. A regression test asserts that starting a call reads no
conversation's history except the one on screen.

Timing the build then showed the reads were not the cost: on that remote the directory took 50 ms
of a 459 ms build, and rendering took the rest. Over budget, the render gave way five rows at a
time starting from all 527 rows although it lists at most 100, and re-measured every kept line for
each candidate, so a large sidebar with a full recap took 17 seconds in a test. It now gives way
from the cap and sizes the directory incrementally, with byte-identical output; the build is 67 ms.
Run activity is read once, beside the directory and the recap, instead of twice in sequence.
`context.built` logs the build's bytes, rows and times.

## GPT-Live has no silent channel, so background context waits for the person's turn

The native protocol appends context on three channels (none, `commentary`, `speakable`) and the
public one on thinking, commentary and instructions; none guarantees silence. Evals heard pushed
replies spoken right after the greeting and a focus update spoken after a click, and spoken notices
were tried and dropped because they made calls chatty. Background lines are silent appends, the
prompt says they need no answer, and they are held until the first words of the person's next turn
(within 1.5 s), when voice answers anyway, and while a request lacks its outcome. An earlier
eight-second window let a click made while the person was still speaking land mid-request. Times
are rendered as `{ago, at}` when the line goes, so "ago" is true then. `sessionUpdate` frames are
validated and ignored; the daemon follows its own agents instead.

## Outcomes come from verified results

Two-action requests spoke a generic "Done" before staging finished, because a background push
reached voice mid-request. A request whose actions all succeed and end in a terminal action gets a
fixed outcome composed from the verified results ("Opened Garden notes.", "Sent to Release notes."),
and nothing later from that turn is spoken; a request that read state or was refused is answered with
Voice's own final text. All-success accounting covers the whole request, so a later success cannot
turn an earlier refusal into a claim of success. The fixed outcome waits for Voice's next
inference's first output: delivered as soon as that inference began, "open release notes, then the
cache task" ended after one open; a tool call means more actions, and text or a finished inference
delivers it.

## An outcome must not swallow a later request

A transient provider error failed a request while the person had already made a second one; voice
reported the failure and never handed off the second. A successful open later lost a following
draft request the same way. Every outcome now reminds voice to delegate any later request it has not
handed off, and the prompt says each request is delegated when made and never cancelled by an
earlier failure. The reminder made voice re-delegate pending work once, so outcomes read the
accepted-request count just before delivery: while later requests are pending voice is told they are
in progress and will each get an outcome, and only the last outcome carries the reminder. Both
notices stay outside Voice's history. The failed request itself is never retried. No transcript or
action-payload deduplication was added; duplicate delegation is not ruled out by any eval.

## Sends really send; drafts open their own conversation

`sessionSend` used to stage text for an independent human Send and moved the screen first. That
broke the hands-free flow the phones have ("Sent. It'll dig into the cache race."). Kirill decided
that a send really sends, like mobile, and leaves the screen where it is: the desktop submits
through its own send path and answers `ack`; a desktop that can only stage answers `staged`, and
the outcome says so. The conversation sent to becomes a followed one, so its reply reaches voice.
Pending questions still block a send. `taskCreate` likewise gives the new task the person's words
as its first message. "Send that to X" once became an open plus a draft, so Voice is told a send is
always `sessionSend` with the person's exact words, never a draft or an open first.

An early eval asked for a draft in a conversation not on screen, and the controller's response held
only `desktopOpen`, so the lone open's outcome ended the request with nothing drafted. The daemon
therefore opens a named, unfocused target itself before `composerDraftAppend`, and a refused open is
that action's result.

## Thinking aloud is a turn-taking problem the instructions own

Voice answered the person thinking aloud with 26–57 words of news, and sometimes delegated it.
`semantic_vad`, `eagerness`, `create_response` and `interrupt_response` belong to the
`gpt-realtime` models; GPT-Live has no turn-detection setting, the server owns turn-taking, and
Kirill ruled out playback gating and microphone tricks. The prompt follows OpenAI's GPT-Live
template ("keep listening while the user pauses to think", "save ideas until invited") and meerkat's
wording: a pause or filler is not the end of a turn, thinking aloud is not a turn, and voice says
nothing or one "Mm-hm.". The strict eval accepts nothing more; it now passes. Mobile gets the same
effect from ElevenLabs' `skip_turn`, which GPT-Live has no equivalent of.

## Speakable text is said, not followed; Happy greets first

A greeting line in the startup context started speech in some calls and not others, so the daemon
cues one hello once the call is active, as the phones cue their agent. The cue was first an
instruction on the speakable channel ("Say a short hello now…"), which voice paraphrased into "Hi,
I'm ChatGPT."; speakable text is what voice says, so the cue is the words themselves, "Hi, Happy
here.". When the person speaks within a second or two, the hello can merge into the first answer.

## Ending a call is Voice's tool

Asking to hang up got a goodbye and no end, because GPT-Live has no end-call tool. Voice delegates
"End the call." and Voice's `end_call` closes the call two seconds after the turn settles, so the
goodbye is heard, without a spoken outcome. The timer belongs to the call and is cleared when the
call ends first.

## The recap holds only what the person said

On a remote where the same "open Lighthouse Ledger" call had run several times, later calls'
voice answered "Open it." with "Okay, opening it. On it. That's open." and, in 2 of 5 calls, no
delegation: nothing opened. The recap held voice's own earlier "That's open." lines, and voice
copied them. Restoring the prompt rule the dedupe had dropped (only the backend makes anything
happen; nothing is done until this request's outcome says so) and saying the recap is never an
outcome did not stop it. Replacing voice's lines with the backend's outcomes ("your backend
reported: Opened Lighthouse Ledger.") passed 5 of 5, then failed once those lines had piled up:
voice said "Opened Lighthouse Ledger." word for word and delegated nothing. The recap now holds
only the person's words and how each call ended; its heading says nothing asked for then is done
in this call, and the prompt says announcing an action does not do it. The person's words are
enough to carry on ("remember pineapple").

## The recap survives a dropped call

A daemon that stops mid-call ends the call and waits for its recap, recorded as dropped, and a
restart records that an unfinished call dropped, since a killed daemon writes nothing. Recaps join
whole native transcript items with a space, as `personSaid` does, so the next call does not read
glued words. The recap carries across calls, so evals that rely on separate calls being independent
must account for it.

## Agent targets need the window's consent

Voice, given agent IDs through `refs`, named conversations by agent in a window without the
`agentTargets` capability, and every such action was refused. The daemon now sends the window's own
target for an agent its AppState lists and refuses any other. "This machine" is the call's
`localConnectionId`, accepted on its own, else AppState's local server, else the context's only
connection; connection IDs are window-relative, so Voice gets the current one with every request.

## Voice focus is decorative

With the `voiceFocus` capability the daemon highlights a target as soon as it is uniquely resolved:
from a whole-word, case-insensitive name match against AppState before Voice runs, and again before
each targeted action, as `navigation` before `desktopOpen`. The highlight is cleared when the request
ends. It never authorizes or opens anything.

## Native and public Live have different lifecycles

HTTP success and connected media are not provider readiness. Native attachment follows Codex's
passive existing-call path and waits for an actual started or updated event; public startup settings
are immutable. Native transcript items are untimed, and aggregate turn events are ignored to avoid
duplicate text. Native orderly close does not prove usage finalization; public close requires its
actual terminal event. Neither path retries allocation or silently switches credential, model,
account, or transport.

## GPT-Live refuses Realtime voices as an access error

Sending the Realtime voice `marin` made every subscription call connect and then fail with
`Voice session access denied.` (`forbidden`), which looked like a missing entitlement. Codex sends a
GPT-Live voice. GPT-Live voices are juniper, maple, spruce, ember, vale, breeze, arbor, sol and cove;
Live sends `cove`.

## Accepted desktop context is immutable for its revision

Changing message text under the same desktop revision made identical-revision checks reject
ordinary streaming. Accepted desktop context stays immutable for its revision; a conflicting context
under the same revision ends the call as invalid control data. Each action takes the latest accepted
revision; capturing one revision for a whole delegation made navigation invalidate every later
action.

## Ordinary conversation must not exhaust limits or sound busy

Transcript deduplication evicts old display-only keys rather than ending a call after a few hundred
fragments, and public fractional transcript times stay untimed rather than rounded into invented
intervals. A call-wide controller guard once refused a new delegation while an earlier one was still
composing, and voice spoke a busy warning. Requests now queue first-in, first-out per person across
all of their calls, one at a time, and Voice's turn settles before the next request reaches it. A
request has 120 seconds and eight inferences; past either, Voice's turn is stopped and voice gets a
fixed explanation. Queued requests expire after 120 seconds without starting an action.

## A failed controller request does not end voice

Controller errors, invalid actions, bounded-request limits and uncertain desktop timeouts once ended
the whole call under one generic error. Each failed delegation returns a fixed, sanitized
explanation that states whether any action began and preserves uncertainty, and never authorizes
replay. Timed-out action identities stay remembered and their late results are ignored. A delivery
failure, account disablement, connection loss, invalid desktop data and the lifetime action limit
still end the call.

## Voice needs a local diagnostic timeline

A live call that described the wrong window could not be traced, so Live emits bounded metadata at
the default info level into the rotating local log: call and window identities, accepted revisions,
the controller route, transcript roles and lengths, delegation, action and result identities,
lifecycle, and fixed failure categories. Names, titles, text, drafts, audio, SDP, credentials and raw
errors never enter it. Each push logs `context.pushed` with its kind, size and speakable flag; only a
daemon started with the test-only `HAPPY_LIVE_CONTEXT_CAPTURE_FILE` writes the pushed text itself, so
evals can prove an answer was in context before the question. Diagnostics still lack provider
turn-end, output-audio onset and per-round boundaries; latency evals measure transcript arrival, not
when a person hears it.

## Unexpected control loss is not a deliberate End

A failed WebSocket upgrade ends its single-use claim immediately. Losing an attached desktop
controller tears down provider media and settles failed, even if native transport closes normally.
An already requested close stays deliberate, and final usage still requires actual provider proof.

## Voice reads the classic sidebar on its own

Voice's outline and sidebar tools once came from the Spaces sidebar, with a Voice row and placement
tools. When Spaces were removed, Live took over its own reads, straight from the bots, tasks,
projects, workspaces and subtasks modules (Surfaces are left out, as the phones leave them out).
`read_conversations` reads any live conversation on a standalone machine, or with a team only a
sidebar row's conversation or a session under one. Voice never rearranges the sidebar.

## Evals keep the speakers muted

Voice evaluations keep the isolated desktop fixture's physical speaker muted while virtual
microphone clips and transcript processing continue, at the person's request. One lane runs at a
time.
