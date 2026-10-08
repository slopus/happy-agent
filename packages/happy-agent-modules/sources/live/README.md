# Desktop Live

`LiveModule(ConfigModule, DurableFunctionsModule)` owns window-scoped voice sessions. The browser
owns WebRTC media; this module owns one credential-selected provider call, its sideband, durable
status, a typed desktop control socket, and bounded side inference. It never creates a coding agent.

The text controller takes the first enabled configured-default model route and effort once. A smart
default chooses one enabled compatible account at startup and keeps it for the entire call, without
account rotation or failover. Voice separately uses the explicitly selected official OpenAI API key
or Codex subscription credential. There is no credential, account, model, or old-Realtime fallback.
Native credentials are reloaded once from the selected provider-owned sign-in store before the
single allocation; a rejected sign-in never triggers another allocation or an OAuth refresh here.
Controller and credential setup failures have separate sanitized explanations. Selecting an
account pool as the voice credential reports that an individual OpenAI account is required.

A failed controller delegation returns a bounded safe explanation to voice and leaves the call
active for the next request. An uncertain action is never retried; its identity remains remembered
and late results are ignored. Connection/protocol loss, account disablement, response delivery failure,
and the lifetime action limit still end the call. Categorized diagnostics exclude provider text.

The fixed controller tool array and literal model prompts live in `impl/runLiveController.ts` and
`impl/livePrompts.ts`. Desktop context, provider fragments, selected public session snapshots and
native delegation text enter a JSON data envelope, never a trusted instruction or authorization.
`sessionSend` ends after exact text staging; only a separate human Send submits it.

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
one action waits at a time, and each wait has a 60-second deadline. Uncertain actions are not replayed.
Context revisions are immutable; selected public snapshots remain separate and bounded. Overflow
ends voice visibly. Native and public append framing, transcript timing, and close semantics remain
separate in `impl/liveProviderTransport.ts`.

The public [Live event reference](https://developers.openai.com/api/reference/resources/live/)
requires numeric `start_ms` and `end_ms`. Exact integer intervals are forwarded; valid fractional
intervals use the approved untimed fragment variant because the desktop contract accepts integer
milliseconds and forbids invented timing. Thus a provider sending only fractional intervals will
produce only untimed fragments. Native transcript items are also untimed. Display deduplication
evicts old keys; it does not limit call length. Full streaming snapshots stay out of voice context;
short status summaries are best-effort, and busy delegations do not terminate the active request.

## Verification

The Live module, controller, configuration and provider transport tests are targeted unit coverage.
`tests/runtime/liveDesktopTransport.test.ts` uses the complete runtime and real HTTP/WebSockets with
scripted provider inference. It can export its sanitized actual controller request through the
test-only `HAPPY_LIVE_CAPTURE_FILE` environment variable. Bun transport smoke coverage lives in
the Agent package; targeted API gym scenarios live in `packages/gym-tests/tests/happy_api_live.test.ts`.
These fixtures do not prove microphone/media negotiation or account entitlement against OpenAI.
