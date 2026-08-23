# User input

`UserInputModule` gives an agent one common `request_user_input` tool for asking a human a
question and waiting for the answer. The module owns its request table in the Agent Base database.
Nothing external mediates a wait: whoever has the answer calls `answer`, `cancel`, or `complete`
on this module, and the settling transaction wakes every wait parked on that request once it
commits.

```ts
import { PresenceModule, UserInputModule } from "@slopus/happy-agent-modules";

const userInput = new UserInputModule(presence);
userInput.onEventTransactional(async (ctx, event) => {
    await auto.recordUserInputEventTransactional(ctx, event);
});
userInput.onEvent(async (ctx, event) => {
    await events.record(ctx, { type: "user-input.event", payload: event });
});
```

The module takes the [presence](../presence/README.md) module and nothing else. It asks presence
for the person's answer-wait policy and subscribes to changes while a wait is in flight; nothing
sits between the two modules. Every character and count bound is a `MAX_USER_INPUT_*` constant,
and request and event identities are the module's own.

Each create and settlement transition uses `ctx.inTx`; storage reads and writes the database facade
on `ctx.db`. stdlib `afterCommit(ctx, callback)` registers post-commit event delivery against the
outermost Agent Base transaction, which is also where a parked wait is handed its committed
outcome. UserInputModule never holds a database transaction open while it waits. A wait registers
itself before it reads, then re-reads storage once, so a settlement that commits first is never
missed; a wait started in a later process finds the terminal request already stored.

Requests contain one to four related questions, each with an optional short header and labeled
choices, plus bounded Markdown context. They have a discriminated outcome: `pending`, `answered`,
`cancelled`, `away`, or `timed_out`. Answer payloads can be free-form text or structured selected
labels plus text; batched requests settle with one answer map. Answer, cancellation, timeout, and
away transitions are single-settlement operations.

The `request_user_input` and `cancel_ask` tools never enter Auto-mode review. The request tool is
durable: a person may take days to answer, so a call interrupted by a restart is executed again
rather than failed. Running it again is safe because Agent Base's generated tool-call CUID2 is the
request ID and Base restores it with the stored call — the second execution resumes the same
request and returns immediately when it was answered while the daemon was down. It accepts an
optional `autoResolutionMs` window from 60 to 240 seconds for questions where the model may
continue with its best judgement, measured from when the request was created rather than from when
a wait resumed. `cancel_ask` accepts `requestId` (and the legacy `ask_id` spelling) plus an optional
reason. The tool creates or resumes that request in one transaction, then waits outside a
transaction. After a terminal result, the same tool can read bounded detail pages by request ID and
cursor so long answers remain available to the model.

Host callers can use `ask`, `wait`, `listPage`/`list`, `get`/`getPage`, `answer`, `cancel`, and
`complete`. `formatForModel`, `formatPageForModel`, `formatDetailPageForModel`, and
`formatUserInputForModel` provide the same bounded model-facing rendering for host reuse.
List pages carry the absolute source `cursor` of their first returned row; `nextCursor` is always
computed from that position and the rows actually shown.

Cross-agent reads and settlement are denied unless the agents are related. Self-access is always
allowed, and an agent may reach a request made by one of its descendants: the answer comes from
the agent collection `beforeStart` hands the module, walked up from the asking agent through
`parentOf`. Anything else is refused, including every access before the module has started.

Presence supplies the per-state `answerWaitMs`, the guidance shown to the model, and the changes
that re-evaluate a wait already in flight. Immediate-away and timeout results carry that guidance
so the model is told to continue with its best judgement and can withdraw the Inbox request with
`cancel_ask`. When presence has no state, a wait simply waits.

`onEventTransactional(listener)` and `onEvent(listener)` subscribe to request events inside the
settling transaction and after it commits; both return the function that stops the subscription.
A transactional listener that throws rolls the change back. A post-commit listener that throws is
reported through `ctx.log.warn` and never undoes a committed settlement.
