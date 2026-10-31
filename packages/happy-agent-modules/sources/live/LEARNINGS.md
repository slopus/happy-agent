# Live module learnings

## Voice belongs to one desktop window

Binding voice to a coding agent exposed the wrong tools and hid desktop navigation. A call acts only
in the window that started it, through fixed tool arrays: read-only sidebar tools, five
desktop actions, plus `taskCreate` and `sessionModelChange` only when the desktop negotiated them.
Workspace, conversation and bot creation were removed from the surface (they remain in the wire
union for compatibility) because voice should open what exists, start work as a task with an unsent
draft, and change models rather than build structure. `sessionWatch` went with the notices it fed.
Voice acts only on this daemon's conversations; another server's connection is refused. No
permission answers, private reasoning, or arbitrary execution enters Live.

## Voice is the person's long-running subtask

Each call used to open its own hidden controller conversation. It forgot everything when the call
ended, could not read the sidebar or other conversations, and its work was invisible. Voice is now
one long-running, unreported subtask of Happy per person, created with their first call through
`SubtasksModule.create`, the path every subtask takes. A conversation subtask without an opening
task was considered and dropped: Kirill had already rejected that shape as not a true subtask.
Voice's opening task only
confirms it is set up, and runs on the voice settings' controller as new agents are offered it,
because a pool's frozen member is hidden from new agents. Every later call hands
requests to the same Voice until the person archives it; the next call creates a new one. Live
supplies Voice's instructions and fixed tool arrays through its own hooks, sends each request as
an agent-originated message on the call's frozen route, and watches Voice's turn through
`messageAccepted`, `beforeInference`, `onEvent` and `afterAgentSettled`. A restart that would
resume an interrupted Voice turn stops it instead: speech from a finished call must not act later.

Voice keeps what it was told in its own conversation, including the speech it was handed; the
person chose that over a hidden history. Each request carries only speech fragments Voice has not
seen, and the sidebar outline only when it changed since Voice last saw it, tracked by hash.

A request runs in its own named lifetime, detached from the provider event that queued it. The first
version detached without carrying the agent database, so every request failed at its first read and
voice heard only the generic failure; the request context now carries the database explicitly.

## The controller route comes from voice settings

The controller was pinned to GPT-6 Luna on the default provider, which made a slower or unavailable
model impossible to change. `[voice]` settings now choose the controller account, model, effort and
fast mode, defaulting to GPT-6.1 Sol at low effort on the configured default account. Runtime changes
from `PATCH /v0/config` or the admin-bot tools live in generated `runtime.toml` and override the
machine file; the built-in voice prompt is never stored, and a prompt identical to it removes the
override. The route, effort, service tier and voice prompt are frozen when a call starts. Fast mode
requests the priority tier only when the selected route offers it, and otherwise is reported as ignored.
The explicitly selected voice credential stays separate.

## Default account pools resolve once, onto an account that works

Rejecting every smart default prevented voice from starting when ordinary conversations used an
account pool. Live now selects one enabled compatible account from that pool at startup and holds
its concrete provider for the whole call. The regular provider registry and a call-local lifetime
still enforce pool or account disablement and daemon shutdown. A missing credential or later
failure never rotates accounts, and the explicitly selected voice credential stays separate.

The first selection was random. On October 24, 2026 it froze a call onto a pool member whose Codex
sign-in could no longer be renewed, while the other member was healthy and was even the call's
voice credential; the first request failed in under a second at round 0, and ordinary agents had
been surviving the same dead account only through router failover, which voice may not use.
Choosing well at call start is allowed; switching later is not. The pool now freezes onto the
voice credential's account when the pool includes it, since the call cannot start unless that
account is signed in. Otherwise it prefers an account whose latest inference anywhere in the daemon
did not end in a typed authentication or out-of-tokens failure within fifteen minutes, or whose
construction found no credential; configuration observes this on every concrete provider run and
clears it on the next completed response. Only when every enabled account has failed does it fall
back to them, and the choice among equals stays random. Once frozen, the account is never rotated,
a failed delegation is never retried, and credential kinds never cross.

When the frozen account's sign-in is rejected or its usage runs out, the failed request gets a
fixed explanation naming that cause and what the person can do (sign in again, wait for usage, or
choose another controller account and start a new call), instead of the generic failure they would
only retry. `controller.failed` diagnostics record the provider error `type` beside its `kind`,
because `kind` is `unknown` for authentication, rate limits and unclassified errors alike and the
log of that call could not tell them apart.

## Setup errors identify which selection failed

One generic controller-and-credential error hid an invalid voice credential after the controller
was fixed. Live now reports controller setup separately from credential setup and explicitly
explains a proven account-pool credential selection. Only that fixed configuration-owned error is
forwarded; arbitrary provider diagnostics stay private. A pool can select the frozen controller,
but voice still requires an explicitly selected individual OpenAI credential.

## Voice is told the sidebar as an outline of names

The voice prompt previously delegated navigation and actions but omitted questions about the current
desktop, and in a real audio call it made an unsupported claim about missing context. Voice then
received Markdown AppState with statuses, activity times and the focused conversation's latest
message, pushed as diffs and refreshed every ten minutes. That pushed text on every navigation and
streaming change, and voice treated some pushes as something to talk about.

GPT-Live is now told only the person's sidebar as names: Happy, the other bots, the person's tasks
and the Surfaces they joined, without status, activity, messages or IDs. Startup is bounded to
8 KiB with a count of omitted entries. A bot, task or Surface event re-reads it; only changed text is
pushed, coalesced for 250 ms with one push in flight and split into appends of at most 500 bytes,
and voice counts as told only after every part is appended. Anything deeper, such as what a
conversation said, is a request for Voice. AppState is never pushed; it only resolves names and
targets for focus and fixed outcomes and validates models. Startup and pushes are attributed data,
not instructions. Ambiguous names require clarification.

## Background pushes wait for the requested outcome

Two-action requests spoke a generic "Done" before staging finished: a background push reached
voice mid-request, and voice treated it as the outcome. A changed outline is now held while any
accepted request lacks a delivered outcome, and pushed after it; a request that starts between the
parts of a push holds the rest. A request whose actions all succeed and end in a terminal action
gets a fixed outcome composed from the verified results, such as "Opened Garden notes." or a staged
message that has not been sent, delivered at Voice's next inference; nothing later from that turn
is spoken. A request that read state or received a refusal is answered with Voice's own final text.
All-success accounting covers the whole request, so a later successful action cannot turn a
previous refusal into a claim of staging. Outcome delivery and focus cleanup remain inside that
request's turn; the next request cannot start navigation or lose its own highlight while the
previous outcome is being appended. An agent target's name in a fixed outcome comes from the
outline.

## Sends and drafts open their own conversation

Voice v2's first real-audio eval (October 13, 2026) asked voice to stage a message or a draft in a
conversation that was not on screen. In 3 of 3 runs, on GPT-6.1 Sol and on GPT-6 Luna, the
controller's first response held only `desktopOpen`, although the prompt asked it to batch the open
with the staging. The lone open's fixed outcome ended the request; nothing was staged, and voice,
which had already said "I'll stage that there", told the person the text was staged. The desktop
stages and appends only in the focused conversation, so the daemon now opens a named, unfocused
target itself before `sessionSend` or `composerDraftAppend`, in the same request and with the
usual highlight before navigation. A refused open is that action's result, and nothing is staged.
The controller is told never to open before a send, and to open alone only when the request is just
to open something. The voice prompt allows only a neutral acknowledgment while waiting and requires
reporting exactly what the delivered outcome states. An omitted action stays unknown unless the
controller confirms it was not started; a failure after a successful action never implies that
nothing happened. Delegations preserve the operation, named target and dictated payload unchanged.
The controller stages supplied message text directly and reads existing messages only when needed
to answer a question about them, without asking whether staging means sending.
The rerun staged every off-screen message and draft and made no false claim. Appending "Nothing else
was done." to a lone open was tried and dropped: voice spoke it, which sounded odd right before the
next request's result, and the prompt already covers unmentioned parts.

## An outcome must not swallow a later request

In that rerun, a transient Codex `internal_error` failed a request before any action, while the
person had already made a second request. Voice said the first had not gone through, asked what to do
next, and never handed off the second, so it was lost. Every failure explanation now tells voice to
still hand off any later request the person already made, and the voice prompt says each request is
delegated when made, queued behind earlier ones, and never cancelled by an earlier failure. The failed
request itself is still never retried: the controller opens its provider session with no inference
retries, and a provider retry is treated as a failure.

A later real-audio run hit the same shape and confirmed the fix: after a round-0 failure, voice said
nothing had started and handed off the later request 2.7 s afterwards. When that one also failed, voice
re-delegated it on its own, which is harmless only because no action had started. Codex failed 3 of 7
controller calls at round 0 in that session (`internal_error` twice, `unknown` once). Whether the
controller should allow one provider retry before any action is an open decision. Diagnostics still
record only the delegation text's length, so a re-phrasing that made the controller ask an unneeded
clarifying question could not be inspected; logging that text would reverse the rule that voice
diagnostics never contain spoken or authored text. A final regression without provider errors passed
the off-screen send and the open-then-draft follow-up on GPT-6.1 Sol. In one GPT-6 Luna run, where the
transcript blurred where the quoted text began, the controller read the conversation instead of
staging, and voice truthfully said nothing was staged; the same request had passed on Luna before. The
missing delegation text again kept it from showing whether voice or the controller misread the request.

The final review's open-then-draft audio case exposed the same loss after a successful open. Transcript
fragment IDs prove the later Garden notes draft request began after the first delegation and was never
handed off; voice said it would put the text there but produced no second delegation. The initial fix
added a reminder to every successful or failed requested outcome to delegate later requests not yet
handed off. The reminder is added only at delivery and stays outside controller history. The voice
prompt also requires delegating every request before promising work. Both instructions explicitly
forbid handing off a request again, because an outcome may arrive while a later request is already
queued. Neither the lone-open result nor uncertain-action retry policy changed, and transcript text
creates no actions.

The bounded final audio check on Agent `76f1f110` passed cases `c`, `hc`, and unquoted `hv`,
but failed `g`: the Greenhouse open completed and the later Garden draft was never delegated.
The one authorized `g` rerun on Agent `72750632` staged exactly `check the orchid humidity`
once and sent nothing, but still failed strict acceptance: voice created three delegations for
two requests. The third repeated the staging action and was refused because the draft already
existed. Voice then gave an unnecessary correction about the existing draft. It never spoke the
reminder, and the call, focus, isolated daemon and socket all cleaned up. This is one sample,
not a verified fix for duplicate delegation.

The rerun's controller durations were 3,272 ms for the open, 3,976 ms for staging, and 7,024 ms
for the repeated request including its refusal response. First-tool delays were 3,257, 3,446,
and 4,630 ms. Desktop round trips were 1 ms for the first open, 522 ms for the Garden open
including its highlight hold, and 0 ms for both staging attempts. The controller used GPT-6.1
Sol at low effort with Fast off. Production diagnostics retained metadata only; authored text
was not logged. No inference retry, automatic send, alternate model, or extra audio rerun was used.

The duplicate's input snapshot contained the first outcome's assistant fragments and no new user
speech. Receipt time was not recorded: the last included fragment arrived 19,960 ms into the case,
and the duplicate began running at 21,373 ms, just after the draft request finished at 21,334 ms.
The blanket reminder and the prompt's unconditional "delegate first, then report" order may have
encouraged another handoff of pending work. Outcomes now read
the actual accepted-request count immediately before delivery: while later requests remain pending,
voice is told they are in progress and each will receive its own outcome. Only the last outcome
reminds voice about requests it has not handed off. The prompt follows that distinction while still
delegating every new request immediately. Both notices stay outside controller history. Metadata-only
diagnostics record delegation receipt and the pending count and hint chosen at outcome delivery;
they contain no authored request or response text. No transcript or action-payload deduplication was added.

The fresh, authorized `g` check on Agent `b61686db` passed all 15 strict assertions in one run:
exactly two completed delegations, the exact Garden draft text once, no send, no early or false
claim, no busy refusal or spoken internal notice, and complete call, focus and installation cleanup.
All three Desktop actions succeeded. Receipt diagnostics show the second delegation arrived
193 ms after the first outcome was delivered; both outcomes therefore used the later-request
reminder with one request in flight. This call did not exercise the queued notice and cannot
establish why the previous duplicate disappeared. The old-code-failing deterministic two-request
regression covers that branch; the affected suite also verifies failure handling, history isolation
and metadata privacy.
The passing audio sample does not establish a general duplicate-delegation guarantee.

That final call's controller durations were 4,057 and 4,018 ms, with first tools at 4,045 and
3,490 ms. Controller completion to the first assistant transcript took 321 and 711 ms; these are
transcript arrivals, not acoustic onset. Desktop round trips were 0 ms for the Greenhouse open,
519 ms for the Garden open including its hold, and 0 ms for staging. The actual highlight paint
preceded navigation by 4,037 and 511 ms. The executable was `0.4.90+voice.b61686db`, its hash
was unchanged throughout the check, and the controller remained GPT-6.1 Sol low with Fast off.
This call finished before the person's subsequent mute instruction; no later call was made.

Voice evaluations must keep the isolated Desktop fixture's physical speaker muted while virtual
microphone clips and voice transcript processing continue. This follows the person's testing
preference; it does not change production playback or the computer's volume. Transcript arrival
still measures model output, not when a person hears it.

## GPT-6.1 Sol low is the slowest part of a request

In the same eval, the controller's first inference took 7,634–10,122 ms on GPT-6.1 Sol at low
effort (six requests) and 3,334 ms on GPT-6 Luna at low effort (one request). Because verified
terminal actions skip a second inference, that first inference was the whole controller time.
Desktop round trips took 0–39 ms, except 520 ms for an open that waited for its conversation to
load. The controller's finish to the first spoken outcome took 563–799 ms, the person's end of
speech to voice's first audio transcript took 0.9–1.5 s, and speech start to the delegation took
2.1–4.3 s. The samples are small and not production percentiles, but Sol's first tool dominates
every action. The rerun measured GPT-6.1 Sol low at 3,981–5,864 ms to its first tool (three requests) and GPT-6 Luna
low at 1,891 ms (one request), below the first eval's numbers; provider latency varies between runs. The
default stays GPT-6.1 Sol until the person decides otherwise.

## Voice focus is decorative

Voice talked about entities without the desktop showing which one. With the `voiceFocus`
capability, the daemon highlights a target as soon as it is uniquely resolved: from a whole-word,
case-insensitive name match against AppState before the controller runs (names along one sidebar path
resolve to the deepest; anything else is ambiguous and sends nothing), and again before each targeted
action, as `navigation` before `desktopOpen`. The highlight is cleared when the request ends. It never
authorizes or opens anything.

## Background notices were dropped

A real audio call acknowledged a workspace switch after a channel-less native context append, and
three real calls, including an explicit snapshot marker and OpenAI's GPT-Live prompt structure,
failed strict silence checks: neither the thinking channel nor a prompt guarantees silence. Voice
was then allowed to choose brief notices about a focused or watched conversation's completion,
error, or need for input. The person later decided against notices altogether: they made calls
chatty and depended on churn the desktop should not have to send. There are no notices now.
`sessionUpdate` frames are validated against the active session and ignored, `sessionWatch` is not
offered, and selected-session status never reaches voice or Voice.

## Staging is not sending

Generated voice text is not human authorization. `sessionSend` stages exact visible text and ends
with the staged result; an independent human Send is required. Pending questions block both staging
and that later Send. Voice never routes generated text through the question-answer shortcut.

## Native and public Live have different lifecycles

HTTP success and connected media are not provider readiness. Native attachment follows Codex's
passive existing-call path and waits for an actual started or updated event; public startup settings
are immutable. Native transcript fragments may include provider timestamps; the adapter currently
emits the supported untimed variant and ignores aggregate turn events to avoid duplicate text. Native orderly close
does not prove usage finalization; public close requires its actual terminal event. Neither path
retries allocation or silently switches credential, model, account, or transport.

## Accepted desktop context is immutable for its revision

Using changing message text under the same desktop revision made identical-revision checks reject
ordinary streaming. Accepted desktop context remains immutable for its revision; a conflicting
context under the same revision ends the call as invalid control data.

## Routine conversation must not exhaust lifetime display limits

Transcript deduplication now evicts old display-only keys rather than ending a call after a few
hundred fragments. Follow-up delegations queue instead of refusing ordinary speech. Public
fractional transcript times remain untimed rather than rounded into invented millisecond intervals.
Invalid intervals still fail closed.

## A failed controller request does not end voice

Controller inference errors, invalid model actions, bounded-request limits, and uncertain desktop
timeouts previously ended the entire call under one generic error. Each failed delegation now
returns a fixed, sanitized explanation to that delegation's voice context without cancelling sibling
requests. The explanation states when no action began and preserves uncertainty about earlier or still-running actions
and never authorizes automatic replay. Timed-out action identities remain remembered, and their late
results are ignored. Logs retain safe failure metadata, never raw provider errors or transcripts.
Sending the result back is a separate operation: a delivery failure
ends the broken transport without trying another append. Account disablement, connection loss,
invalid desktop protocol data, and the lifetime action-capacity boundary still end the call.

## A completed action must not make ordinary voice sound busy

The call-wide controller guard refused a new native delegation even after a desktop action had
completed, while the earlier controller was still composing its response. A real audio test
reproduced the spoken busy warning with one request and a three-millisecond successful staging
action. Requests now queue first-in, first-out per person, across all of their calls, and one runs
at a time; Voice's turn settles before the next request reaches it, so two requests never share a
turn. The desktop has at most one outstanding action, and Voice's actions run one at a time in the
order it called them. Duplicate delegation identities are ignored and uncertain mutations are never
replayed. A request has 120 seconds and eight inferences; past either, Voice's turn is stopped,
voice gets a fixed explanation, and the stopped turn has ten seconds to settle before the next
request reaches Voice. Queued requests expire after 120 seconds without starting an action. Short
response-frame ordering is separate from inference; it never waits for playback or a desktop
acknowledgement.

## Voice needs a local diagnostic timeline

The default daemon log had no voice context or action timeline, so a live call that described the
wrong window could not be traced after the fact. Live now emits bounded metadata at the default
info level into the existing rotating local log: call/window identities, accepted revisions and
desktop IDs/counts, chosen controller route, transcript roles and lengths, selected snapshot counts,
delegation/action/result identities, lifecycle, and fixed failure phases/categories. Names, titles,
public text, drafts, audio, SDP, credentials, and raw errors never enter these records. Streaming
diagnostics have both rate and lifetime limits; invalid records and failed writes are dropped
without affecting voice. Arbitrary catalog samples and duplicated failure details made diagnostics
larger without helping identify the active window. Logs retain active IDs and counts and one
structured failure record instead. The shared writer opens and tightens Unix files to owner-only permissions,
so new metadata and rotated generations do not become readable to other local users.

## Each desktop action uses the current accepted revision

Capturing one revision for an entire delegation made navigation invalidate every later action.
Each action now takes the latest accepted desktop revision; ordered context-before-result frames
advance it before the controller continues. Transcript attribution remains fixed to the delegation.

## Measure controller delay separately from speech and Desktop work

The retained October 8–9, 2026 Desktop gym artifacts cover 26 isolated roots, 25 results and
15 calls with a control hello. Six calls contain Live diagnostics for eight started delegations;
four also contain provider observers for eleven Luna round windows. The other nine calls lack
the instrumentation needed to reconstruct controller timings. The installed user's retained
`~/.happy/agent/observation/agent.log`, its `.1` rotation, `daemon.log`, `reload.log` and
`local-reload.log` contain no matching Live diagnostic records. They cannot establish user-call
latency. This review used existing artifacts and made no new calls.

Measured boundaries below are milliseconds. Case names identify the retained artifact directories;
request numbers distinguish delegations within a call. Luna used low effort; the older Astra calls
used medium effort. A controller finish can report a refused Desktop action; the failure row is
explicitly marked. “Outcome text” means the first fragment that actually described staging,
refusal or failure, rather than a generic acknowledgment. It does not measure audible playback.

| Case / request                        | Model | Delegate → first tool | Controller duration | Desktop round trips | Controller end → outcome text |
| ------------------------------------- | ----- | --------------------: | ------------------: | ------------------- | ----------------------------: |
| persistent-luna-1791584477244 / 1     | Luna  |                 5,875 |               9,905 | 4                   |                         1,344 |
| persistent-luna-1791584810348 / 1     | Luna  |                 2,824 |      4,697 (failed) | 4                   |                         1,610 |
| persistent-luna-1791585162146 / 1     | Luna  |                 2,878 |               4,633 | 5                   |                         1,589 |
| persistent-luna-1791585162146 / 2     | Luna  |                 1,913 |               5,667 | 9, 3                |                           534 |
| voice-composer-1791496990699 / 1      | Astra |                 3,341 |               5,875 | 3                   |                         3,130 |
| voice-composer-1791497794445 / 1      | Astra |                 2,918 |               5,038 | 4                   |                         1,214 |
| voice-composer-1791497794445 / 2      | Astra |                 3,437 |               5,496 | 1 (refused)         |                         3,426 |
| voice-notice-policy-1791586650322 / 1 | Luna  |                 1,824 |               2,792 | 4                   |                         1,862 |

The completed Luna controller median was 5,150 ms across four requests; its first-tool median
was 2,824 ms across five requests, including the failed controller. Astra's three completed
requests had medians of 5,496 ms and 3,341 ms respectively. These small samples use different
requests and builds and do not establish a model comparison or production percentiles. Desktop
round trips took 1–9 ms. Where the native append was captured, it followed controller end in
0–1 ms; the next assistant fragment arrived 182–766 ms later. The controller exchange therefore
dominates the measured delegation path, while outcome generation adds further delay.

There is no recorded input-turn-end/VAD event, exact inference-end timestamp, audio-onset boundary
or service tier. Speech-start offsets include speaking time, and creation-to-delegation offsets
include fixture pauses and navigation; neither measures delay after the person stops speaking.
Observer round windows include tool work and SDK continuation overhead, so they are not pure
inference durations. Missing service-tier metadata does not prove Fast was off. One historical
Astra action lacks a delegation ID and was attributed only within its single active delegation.
The two-action Luna request produced a generic “Done” before staging; only the later explicit
outcome counts as completion. That premature “Done” is now prevented by holding background pushes
during a request and answering verified terminal actions with a fixed outcome.

The next diagnostic improvement should record supported provider turn-end events, request queue
and provider-open/run boundaries, each round's first output and terminal event, the selected
service tier, native append completion, and actual output-audio onset. Correlate them with stable
call, delegation and round IDs and a monotonic clock; keep records bounded and free of authored
text or audio. This is an identified measurement gap, not implemented instrumentation.

## Unexpected control loss is not a deliberate End

A failed WebSocket upgrade now ends its single-use claim immediately. Losing an attached desktop
controller tears down provider media but settles failed, even if native transport closes normally.
An already requested close remains deliberate, and final usage still requires actual provider proof.

## GPT-Live refuses Realtime voices as an access error

Sending the Realtime voice `marin` made every subscription call connect and then fail with
`Voice session access denied.` (`forbidden`), which looked like a missing entitlement. Official
Codex succeeded with the same account because it sends a GPT-Live voice (`cove`). GPT-Live voices
are juniper, maple, spruce, ember, vale, breeze, arbor, sol and cove; Live sends `cove`.

## Voice reads the classic sidebar on its own

Voice's outline, `list_sidebar` and `read_conversations` came from the Spaces sidebar, along with
a Voice row, `request_space_placement` and `request_sidebar_tidy`. When Spaces and stem cells were
removed before a stable release, Live took over its own reads: the outline is the built-in bot, the other
bots, the person's tasks and joined Surfaces, read straight from those modules, and
`read_conversations` reads any live conversation on a standalone machine, or with a team only a
sidebar row's conversation or a session under one. Voice no longer rearranges the sidebar.
