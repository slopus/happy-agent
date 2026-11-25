# Desktop Live

`LiveModule(ConfigModule, DurableFunctionsModule, BotsModule, SubtasksModule, TasksModule,
HistoryModule, EventsModule, TeamModule, UserInputModule, ProjectsModule, WorkspacesModule)` owns
window-scoped voice sessions, the machine's voice settings, and each person's Voice. The browser
owns WebRTC media; this module owns one credential-selected provider call, its sideband, durable
status, and a typed desktop control socket. GPT-Live is the voice; Voice is the text agent it hands
requests to.

[GPT-Live context-management research](research/gpt-live-context-management.md) records source links, verification limits and sidebar hypotheses.

## Voice

Voice is one long-running, unreported subtask of Happy per person, created through
`SubtasksModule.create` with the person's first call and reused by every later call until they
archive it; the next call then creates a new one. Its opening task only confirms it is set up, on
the voice settings' controller as new agents are offered it; each request runs on its call's frozen
route. `happy_live_voice_agents` maps the
person to Voice and, in its `outline_sent` column, holds the hash of the first context Voice was
last given.

Live's hooks make Voice one job: `VOICE_AGENT_INSTRUCTIONS` replace its instructions, and its tools
are fixed arrays merged in order: the read-only sidebar tools in `impl/voiceSidebarTools.ts`
(`list_sidebar` and `read_conversations`), the five desktop actions in `impl/liveDesktopTools.ts`, then `taskCreate`
and `sessionModelChange` only when the serving call negotiated them. Desktop tools are never
durable and need no review: the desktop verifies each action, and an interrupted one is never run
again. A person typing to Voice gets a text answer; without an active call its desktop tools refuse.

Voice runs on the controller route from the `[voice]` settings: `controller_provider`, `controller_model`,
`controller_effort` and `controller_speed` (`regular`, `fast` or `ultrafast`; the older
`controller_fast_mode` still means fast or regular when no speed is stored), defaulting to GPT-6.2
Sol at low effort on the configured default account at the fastest speed the route offers:
Ultrafast where the account's plan offers it (`ProviderServiceTiers`), else Fast, else Regular. `ConfigModule` stores runtime changes in generated
`runtime.toml`, which overrides the machine file, and resolves the route; this module reports them
as `config.voice`, applies `PATCH /v0/config` voice changes for the API, and gives active admin bots
`get_voice_settings` and `set_voice_settings`. `system_prompt` replaces the voice model's built-in
prompt; the built-in prompt is never stored. A pool chooses one enabled compatible account at startup
and keeps it for the entire call, without account rotation or failover: the voice credential's own
account when the pool includes it, otherwise one without a sign-in or usage failure in the last
fifteen minutes, and a failed account only when every account has failed. Route, effort, service tier
(the speed's tier, never faster than asked) and voice prompt are frozen per call. Voice separately uses the explicitly selected official OpenAI API key
or Codex subscription credential. There is no credential, account, model, or old-Realtime fallback.
Native credentials are reloaded once from the selected provider-owned sign-in store before the
single allocation; a rejected sign-in never triggers another allocation or an OAuth refresh here.
Controller and credential setup failures have separate sanitized explanations. Selecting an
account pool as the voice credential reports that an individual OpenAI account is required.

A failed controller delegation returns a bounded safe explanation to voice and leaves the call
active for the next request. A rejected controller sign-in or exhausted usage says so and what the
person can do; `controller.failed` records the provider error type. An uncertain action is never retried; its identity remains remembered
and late results are ignored. Connection/protocol loss, account disablement, response delivery failure,
and the lifetime action limit still end the call. Categorized diagnostics exclude provider text.

Local diagnostics are on at the default `info` log level in
`~/.happy/agent/observation/agent.log` (replace `~/.happy` with `HAPPY_HOME_DIR` when set).
Filter JSON lines by `module: "live"` and `voiceSessionId`; the `msg` field contains a JSON
metadata record with an `event`, desktop context revision, elapsed time, and suppressed count.
Records describe lifecycle, frozen model routing, accepted desktop IDs and counts, selected
session snapshots, delegations, actions and results, and fixed failure categories and phases.
They exclude transcript and message text, composer contents, names and titles, audio, SDP,
credentials, and raw errors. Frequent context,
transcript, and snapshot records are limited to ten per second per kind and 1,024 combined per
call; action and delegation diagnostics follow Live's existing lifetime limits. Each metadata
record is at most 32 KiB. Observation keeps the current log and one previous generation,
with a bounded write queue; Unix log files are readable only by their owner. Logs respect
the existing observation settings, including disabling logs or selecting a higher log level.

Each delegation becomes one message to Voice: a JSON envelope (`provenance`, `delegation`,
`transcripts`, `thisMachine`, `refs`, `context` only when Voice has not seen that call's first
context, by hash, and `updates`, the context lines voice was told since Voice's last request) with
only the speech fragments Voice has not been given, bounded to 64 KiB by dropping the oldest
updates, then the oldest fragments. It
carries agent-origin metadata, so speech is never the person's authorization, and the call's frozen
provider, model, effort and service tier. One first-in, first-out queue per person runs one request
at a time across all of their calls, and Voice's turn settles before the next request reaches it.
`sessionSend` sends to its named conversation without changing the screen; the desktop answers
`ack` when it sent and `staged` when it can only stage, and the outcome says which.
`composerDraftAppend` names its conversation; when it is not focused, the daemon first requests
`desktopOpen` for it and appends only after that open succeeds. Actions run one at a
time in the order Voice called them, each on the latest accepted revision, and a batch stops at the
first that does not succeed. Following OpenAI's client delegation, each confirmed terminal action
(open, send, draft append, model change, task creation) is said at once on the request's
delegation, from `impl/liveOutcome.ts`, so "open A, then B" says each. When Voice's turn ends and
everything succeeded after something was said, Voice's final text and the later-request reminder
go quietly (`thinking`); otherwise voice hears Voice's final text, or a fixed explanation. Voice acts only on this daemon's conversations: another
server's connection is refused. "This machine" is the call's `localConnectionId`, accepted on its
own, else AppState's local server, else the context's only connection; Voice gets it with every
request because connection IDs are window-relative. An agent target (`{ kind: "agent" }`) needs the
`agentTargets` capability, which needs `appState` and `localConnectionId`; without it, an agent the
window's AppState lists is sent as that entry's own target, and any other is refused. Voice's
`end_call` (`impl/voiceCallTools.ts`) closes its call two seconds after the turn settles, without a
spoken outcome, when the person asked to hang up.

AppState is never pushed to voice: it only resolves names and targets and validates models, and
`sessionUpdate` frames are validated and ignored. With `voiceFocus`, the daemon highlights a
uniquely named target before Voice runs and before each targeted action, and clears it when the
request ends.

## Voice context

GPT-Live is told what the phones tell their voice agent (happy `docs/agent-voice-call.md`), from
this daemon's own records and never from the desktop's projection. Voice receives the same first
context and every line voice was told since its previous request, so it starts from what voice
already knows. API.md specifies only that this context exists; its format is the daemon's own.

**The directory** (`impl/readVoiceDirectory.ts`) is the person's conversations in sidebar order:
Happy, the other active bots, the person's active tasks, then each project's root conversations
and its workspaces' conversations under project and workspace heading lines, and under any
conversation its live subtasks at any depth. Workspaces a bot or task owns are not listed again,
and the person's own Voice is the call itself. Search (`list_sidebar`) covers all of it, bounded
only at 5,000 rows against runaway installations. Each conversation has a reference
(`impl/VoiceRefs.ts`), `s` and a decimal order key: references compare as text in sidebar order
(`s4` < `s49` < `s5`), the first directory gets the shortest keys its length allows, and a later
conversation gets a key between its neighbours. A reference is its conversation's for the whole
call and never handed to another. Voice holds only the references it was told: the listed
conversations, the ones added during the call, and any it was introduced to by name.

**The first context** (`impl/renderVoiceCallContext.ts`) is plain text, at most 24 KiB, a
developer message in the session's startup input because GPT-Live takes 8,192 tokens of startup
input and the native endpoint ignores `instructions`; there the voice prompt is a startup item
too and comes out of the same budget.

```text
Now: 2026-11-06T09:15+01:00 (the person's local time, Europe/Berlin)
focusRevision: 3

Previous voice conversation (earlier calls, oldest first: only what the person said; nothing they asked for then is done in this call):
- 3 minutes ago, the person: Remember the word pineapple.
- 2 minutes ago: the person ended the call

On screen: Fix cache race — subtask, ref s3, under Release notes
Working: yes. Needs the person: no.
Last turns, oldest first:
1. The person (5 minutes ago): Why does the cache race?
   Agent (3 minutes ago): Two writers share the lock …

Conversations in the app, in the sidebar's order:
- Happy — bot, ref s1, last active 2 minutes ago (09:13)
- Release notes — task, ref s2, needs the person (asks: Which branch?), last active an hour ago (08:10)
  - Fix cache race — subtask, ref s3, working, last active 3 minutes ago (09:12)
- App — project
  - Feature — workspace
    - Feature chat — conversation, ref s5, failed (Rate limited.), last active 20 minutes ago (08:55)
… and 27 more not listed; ask your backend to find one by name.
```

`Now` is when the call started, on AppState's `timeZone` or this machine's. The recap
(`persistence/liveCallHistory.ts`) is the latest 30 lines across recent calls, only what the person said
(voice's words and the backend's outcomes are left out: later calls copied them as claims), each at
most 1 KiB within 8 KiB, with how each call ended; a stopped daemon records the call as dropped.
The conversation on screen comes with its last five turns (`impl/readVoiceTurns.ts`), the
person's cut at 2 KiB and the agent's at 8 KiB after a whole word. The directory lists at most 100
conversations within 12 KiB, heading lines included in the bytes: the one on screen and the
followed ones, then the most recently active, each kept subtask with its parents, shown in sidebar
order and the rest counted. When the whole is too big, the older turns give way first, then the
directory's tail, then the recap's older lines, and the newest turn last. Every cut keeps whole
characters.

Once the call is active, one speakable cue (`LIVE_GREETING_CUE`, "Hi, Happy here.") makes Happy
speak first; a line in the startup context alone did not reliably start speech.

**Updates** are silent appends, one JSON line each with keys sorted. GPT-Live has no channel that
guarantees silence, so they wait, in order, for the first words of the person's next turn (within
1.5 seconds of the person speaking, when voice answers anyway) and while a request lacks its
delivered outcome. Times in them are `{ago, at}`, rendered when they go.

- `directory` (`impl/voiceDirectoryUpdate.ts`): `added`, `removed`, `renamed`, `moved` among the
  conversations voice holds references for, settled for a second, at most 20 changes within 4 KiB
  with the rest counted in `more`. An addition says `after` only when its reference does not sort
  into place.
- `focus`: the conversation in front, with turns voice has not been told, at most 16 KiB, or
  `"title":null`.
- `status`: conversations whose working, needs-the-person, question or failure changed, settled
  for a second, at most 20 within 4 KiB. An unlisted conversation is told only once it works,
  needs the person or fails, and then with its `kind`, which introduces it.
- `assistant_text` and `session_error`: complete pieces of the four conversations most recently on
  screen or sent to, newest first, each piece once; a piece over 8 KiB is cut with
  `"truncated":true`, an error at 1 KiB. What a conversation held when first followed counts as
  known, and nothing is ever replayed.

## Lifecycle

Reservation and durable startup intent commit together. Allocation runs once after commit and
returns SDP after sideband attachment, before browser negotiation. Active status requires a real
provider readiness event. Interrupted startup and restart fail without replay. Call allocation and
attachment share 30 seconds; readiness has another 30 seconds; desktop control must attach within
15 seconds after allocation. Four nonterminal calls per principal and one per window are allowed.

Public close waits at most 15 seconds for an actual terminal event and final usage. Only a requested
`close_requested` event is an orderly end. Native close sends the native command then closes the
socket, with no fabricated final usage. Closing voice never closes coding tasks. Terminal records
are retained seven days, at most 1,000 per principal. Only owner-filtered status reaches the journal.

Control frames are at most 256 KiB. At most 256 action identities remain for the call's lifetime,
and the call permits one outstanding desktop action with a 60-second deadline starting at dispatch.
A request may run 120 seconds in Voice and eight inferences; the ninth is refused with a fixed
explanation. A stopped turn is given ten seconds to settle before the next request reaches Voice.
Provider response frames retain atomic append ordering, with a 30-second limit for each socket
write; stalled delivery ends the broken transport without replay. Uncertain actions are not
replayed. Queued requests expire after 120 seconds without starting an action. Context revisions
are immutable. Protocol or action-ledger overflow ends voice visibly. A daemon restart fails the
call and stops a Voice turn it would otherwise resume. Voice's conversation, including the speech
it was handed, is kept like any agent's; voice diagnostics still exclude it.
Native and public append framing, transcript timing, and close semantics remain
separate in `impl/liveProviderTransport.ts`.

The public [Live event reference](https://developers.openai.com/api/reference/resources/live/)
requires numeric `start_ms` and `end_ms`. Exact integer intervals are forwarded; valid fractional
intervals use the approved untimed fragment variant because the desktop contract accepts integer
milliseconds and forbids invented timing. Thus a provider sending only fractional intervals will
produce only untimed fragments. Native transcript items are also untimed. Display deduplication
evicts old keys; it does not limit call length. Full streaming snapshots stay out of voice context;
short status summaries are best-effort, and overlapping delegations never produce a busy refusal.

## Verification

`tests/liveModule.test.ts` drives Live's real hooks with a scripted Voice turn;
`tests/liveVoiceContext.test.ts` covers references, directory updates, times, cuts and the first
context's budgets, and AppState helper, configuration and provider transport tests are targeted
unit coverage.
`tests/runtime/liveDesktopTransport.test.ts` uses the complete runtime, the real Voice agent and
real HTTP/WebSockets with scripted provider inference. It can export Voice's sanitized requests
through the test-only `HAPPY_LIVE_CAPTURE_FILE` environment variable. A daemon started with the
test-only `HAPPY_LIVE_CONTEXT_CAPTURE_FILE` appends each text pushed to the voice model (`context`,
`directory`, `focus`, `status`, `reply`, `error`, `greeting` or `outcome`) as a JSON line `{at, kind, text, speakable}`, so a gym can prove an answer was in context
before the question; the log's matching `context.pushed` record holds only kind, size and speakable, and `context.built` times building the first context apart from allocating the provider call. Bun transport smoke coverage lives in
the Agent package; targeted API gym scenarios live in `packages/happy-agent-gym-tests/tests/happy_api_live.test.ts`.
These fixtures do not prove microphone/media negotiation or account entitlement against OpenAI.

Real-audio evaluations run from the desktop gym (`live-voice-evals` for scenarios S1–S6,
`live-voice-latency --scenarios deep` for a 524-conversation remote); their results and what they
taught are in `LEARNINGS.md`.
