# Desktop Live

`LiveModule(ConfigModule, DurableFunctionsModule, BotsModule, SubtasksModule, TasksModule,
SurfacesModule, HistoryModule, EventsModule, TeamModule)` owns
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
person to Voice and holds the hash of the sidebar outline Voice was last given.

Live's hooks make Voice one job: `VOICE_AGENT_INSTRUCTIONS` replace its instructions, and its tools
are fixed arrays merged in order: the read-only sidebar tools in `impl/voiceSidebarTools.ts`
(`list_sidebar` and `read_conversations`), the five desktop actions in `impl/liveDesktopTools.ts`, then `taskCreate`
and `sessionModelChange` only when the serving call negotiated them. Desktop tools are never
durable and need no review: the desktop verifies each action, and an interrupted one is never run
again. A person typing to Voice gets a text answer; without an active call its desktop tools refuse.

Voice runs on the controller route from the `[voice]` settings: `controller_provider`, `controller_model`,
`controller_effort` and `controller_fast_mode`, defaulting to GPT-6.1 Sol at low effort on the
configured default account, with fast mode off. `ConfigModule` stores runtime changes in generated
`runtime.toml`, which overrides the machine file, and resolves the route; this module reports them
as `config.voice`, applies `PATCH /v0/config` voice changes for the API, and gives active admin bots
`get_voice_settings` and `set_voice_settings`. `system_prompt` replaces the voice model's built-in
prompt; the built-in prompt is never stored. A pool chooses one enabled compatible account at startup
and keeps it for the entire call, without account rotation or failover: the voice credential's own
account when the pool includes it, otherwise one without a sign-in or usage failure in the last
fifteen minutes, and a failed account only when every account has failed. Route, effort, service tier
(priority only when fast mode is on and the route offers it) and voice prompt are frozen per call. Voice separately uses the explicitly selected official OpenAI API key
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
`transcripts`, and `sidebar` only when the outline changed since Voice last saw it) with only the
speech fragments Voice has not been given, bounded to 64 KiB by dropping the oldest fragments. It
carries agent-origin metadata, so speech is never the person's authorization, and the call's frozen
provider, model, effort and service tier. One first-in, first-out queue per person runs one request
at a time across all of their calls, and Voice's turn settles before the next request reaches it.
`sessionSend` and `composerDraftAppend` name their conversation; when it is not focused, the daemon
first requests `desktopOpen` for it and stages only after that open succeeds. Actions run one at a
time in the order Voice called them, each on the latest accepted revision, and a batch stops at the
first that does not succeed. When every action succeeded and all were terminal (open, staging, draft
append, model change, task creation), voice receives a fixed outcome from `impl/liveOutcome.ts` at
Voice's next inference, and nothing later from that turn is spoken. Otherwise voice hears Voice's
final text, or a fixed explanation. `sessionSend` ends after exact text staging; only a separate
human Send submits it. Voice acts only on this daemon's conversations: another server's connection
is refused, and an agent target (`{ kind: "agent" }`) needs the `agentTargets` capability, which
needs `appState` and the desktop's `localConnectionId`.

GPT-Live is told the sidebar as an outline of names (`impl/renderVoiceOutline.ts` over
`impl/readVoiceOutline.ts`): Happy, the other bots, the person's tasks and the Surfaces they joined,
with no status, activity, messages or IDs. Startup is bounded to 8 KiB with a count of omitted
entries. A bot, task or Surface event re-reads it; only changed text is pushed, coalesced for 250
milliseconds with one push in flight, split into appends of at most 500 bytes, and held while a
request lacks its delivered outcome. AppState is never pushed: it only resolves names and targets
and validates models. Desktop context revisions are accepted for actions, and `sessionUpdate` frames
are validated and ignored; there are no background notices. With `voiceFocus`, the daemon highlights
a uniquely named target before Voice runs and before each targeted action, and clears it when the
request ends.

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

`tests/liveModule.test.ts` drives Live's real hooks with a scripted Voice turn; outline, AppState
helper, configuration and provider transport tests are targeted unit coverage.
`tests/runtime/liveDesktopTransport.test.ts` uses the complete runtime, the real Voice agent and
real HTTP/WebSockets with scripted provider inference. It can export Voice's sanitized requests
through the test-only `HAPPY_LIVE_CAPTURE_FILE` environment variable. Bun transport smoke coverage lives in
the Agent package; targeted API gym scenarios live in `packages/happy-agent-gym-tests/tests/happy_api_live.test.ts`.
These fixtures do not prove microphone/media negotiation or account entitlement against OpenAI.

A real native audio call, before voice v2, verified one Luna LOW provider session across two requests, text-only
retained history, sequential navigation and staging, and exactly one submission after human Send.
The same call failed both quiet navigation checks: channel-less snapshots produced unrequested
speech. The complete append timeline excluded separate speakable status notifications in those
intervals. Those failures remain recorded. The user subsequently chose proactive background facts
with model discretion over useful notices; current acceptance evaluates relevance and truthfulness,
rather than the former zero-audio gate. This does not establish native hard silence or constitute
completed voice release validation. Live queued overlap and
extra calls in one reply remain covered by deterministic fixtures, rather than that audio call.

A subsequent real call passed the new policy case: routine navigation produced no speech, and an
explicitly requested completion notice followed the real coding agent's completed run, focused
running-to-idle update, and speakable status candidate. Human Send submitted once while voice was
active, and End closed the call. This observes a useful, truthful model choice without guaranteeing
silence or a notice for every background update.
