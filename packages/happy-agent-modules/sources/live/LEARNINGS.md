# Live module learnings

## Voice belongs to one desktop window

Binding voice to a coding agent exposed the wrong tools and hid desktop navigation. Live now uses
the initiating window's bounded visible context and a fixed nine-action controller. The controller
uses one frozen configured-default model route; the explicitly selected voice credential is separate.
No coding-agent runtime, permission answers, private reasoning, or arbitrary execution enters Live.

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

## Streaming snapshots do not rewrite accepted desktop context

Using changing message text under the same desktop revision made identical-revision checks reject
ordinary streaming. Accepted desktop context remains immutable for its revision. Selected public
session snapshots have a separate bounded store and enter each controller request explicitly, so
fresh task text does not become stale or silently change the revision's meaning. Routine progress is
quiet; only a newly observed completion, error, or request for input may be spoken.

## Routine conversation must not exhaust lifetime display limits

Transcript deduplication now evicts old display-only keys rather than ending a call after a few
hundred fragments. A second delegation while the controller is working receives a bounded busy
reply instead of terminating voice. Full streaming snapshots remain local to controller context;
only short status transitions enter the voice model, and optional update backpressure is dropped.
Public fractional transcript times remain untimed rather than rounded into invented millisecond
intervals. Invalid intervals still fail closed.

## Each desktop action uses the current accepted revision

Capturing one revision for an entire delegation made navigation invalidate every later action.
Each action now takes the latest accepted desktop revision; ordered context-before-result frames
advance it before the controller continues. Transcript attribution remains fixed to the delegation.

## Unexpected control loss is not a deliberate End

A failed WebSocket upgrade now ends its single-use claim immediately. Losing an attached desktop
controller tears down provider media but settles failed, even if native transport closes normally.
An already requested close remains deliberate, and final usage still requires actual provider proof.

## GPT-Live refuses Realtime voices as an access error

Sending the Realtime voice `marin` made every subscription call connect and then fail with
`Voice session access denied.` (`forbidden`), which looked like a missing entitlement. Official
Codex succeeded with the same account because it sends a GPT-Live voice (`cove`). GPT-Live voices
are juniper, maple, spruce, ember, vale, breeze, arbor, sol and cove; Live sends `cove`.
