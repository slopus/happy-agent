# Chat UI

Components in a conversation: the `show_ui` tool a model shows them with, the documents the daemon
writes itself, and every click on them. It also owns quick replies. The wire contract is "Chat UI",
"Quick replies", and `POST /v0/agents/:agentId/actions` in `packages/happy-agent/API.md`; each
component's schemas live in `@slopus/happy-agent-client` under `sources/ui/`.

```ts
const chatUi = new ChatUiModule(config, history, durableFunctions);
const compute = new ComputeModule(config, secrets, runners, botSettings, chatMedia, chatUi);
const api = new ApiModule(/* … */, chatUi);
```

Chat UI is built before every module that contributes a component, because a module contributes
while it is constructed. It serves two components itself, `file_tree` and `default_model`; Compute
contributes `media`.

## The pieces

```text
client package                         this module                         contributing module
──────────────                         ───────────                         ───────────────────
defineUiComponent(bundle)  ──────────▶ contribute(bundle, contribution) ◀── prompt, fallback, hooks
  props, input, actions                  │
  payload, result, permission            ├─ show_ui ──▶ document() ──▶ ui presentation on the call
                                         ├─ post()  ──▶ document() ──▶ ui block in an agent message
uiActionRequest(bundle, …) ─ /actions ─▶ act() ──▶ attempt record ──▶ hook ──▶ outcome
                                         ├─ suggest_replies ──▶ quick_replies presentation
                                         └─ quickReplyProblem() ◀── send naming a quick reply
```

- A **bundle** is the contract: a component's props, and each action's payload, optional result,
  and permission. It is defined once, in the client package, and every client and server reads it.
- A **contribution** is the server side of one bundle: what `show_ui` teaches about it, its
  fallback line, its own checks, and one hook per action.
- A **document** is 1–16 components. `document()` checks each against its bundle and its
  contribution and computes every fallback; nothing is stored unless all of it holds.

## Adding a component

Four steps. The code below is a whole component, `service_key`, which
`tests/chatUi/support/serviceKeyComponent.ts` contributes and `tests/chatUi/examples.test.ts` runs.

**1. Define the bundle**, in `packages/happy-agent-client/sources/ui/components/`:

```ts
export const serviceKeyComponent = defineUiComponent({
    type: "service_key",
    description: "One outside service's API key: paste it to connect the service, or remove it.",
    props: Type.Object(
        { service: Type.String({ minLength: 1, maxLength: 80 }) },
        { additionalProperties: false },
    ),
    actions: {
        save: {
            // A secret is never stored, announced, logged, or given to a model.
            payload: Type.Object(
                { key: UiSecret(Type.String({ minLength: 1, maxLength: 4_096 })) },
                { additionalProperties: false },
            ),
            // Returned to the caller alone and never stored.
            result: Type.Object({ replaced: Type.Boolean() }, { additionalProperties: false }),
            permission: "providers.own",
        },
        remove: {
            payload: Type.Object({}, { additionalProperties: false }),
            permission: "providers.manage",
        },
    },
});
```

Every object is strict (`additionalProperties: false`). An action that names no permission needs
`content.write`. A component whose model-written input differs from its stored props gives
`input` as well, as `media` does.

**2. Add it to the catalog**, one line in `uiComponents` in `sources/ui/catalog.ts`, and export it
from `sources/ui/index.ts`. The known-component union, the action union, and `ui.schema.json` are
derived from that list. Advance `UI_CATALOG_VERSION`, then regenerate the fixtures other clients
read:

```sh
pnpm --filter @slopus/happy-agent-client write:ui-fixtures
```

**3. Contribute it** from the module that does the work, in that module's constructor. The module
takes `ChatUiModule` as a constructor dependency. The test keeps its keys in a map; a module keeps
them in the store it owns:

```ts
const keys = new Map<string, string>();
chatUi.contribute(serviceKeyComponent, {
    prompt: "One outside service's API key: the person pastes it to connect the service, or removes it. Show one per service you need a key for. A saved key reaches you as a hidden note, in a turn of its own.",
    fallback: (props) => `Connect ${props.service} in Happy on your computer`,
    actions: {
        save: (_ctx, offer, payload) => {
            // A refusal is the person's answer, not an error: the widget shows the reason.
            if (!payload.key.startsWith("key-")) {
                return Promise.resolve({
                    status: "rejected",
                    code: "key_rejected",
                    reason: `That doesn't look like a ${offer.props.service} key.`,
                });
            }
            const replaced = keys.has(offer.props.service);
            keys.set(offer.props.service, payload.key);
            return Promise.resolve({
                status: "accepted",
                // The model reads this in a hidden turn that starts now.
                note: `${offer.props.service} is connected.`,
                wake: true,
                result: { replaced },
            });
        },
        remove: (_ctx, offer) => {
            keys.delete(offer.props.service);
            // Without `wake`, the note waits for the conversation's next turn.
            return Promise.resolve({
                status: "accepted",
                note: `${offer.props.service} was disconnected.`,
            });
        },
    },
});
```

The props, payloads, and results are typed from the bundle; a missing hook, or a result of the
wrong shape, does not compile. Nothing else is registered anywhere: `show_ui` now accepts and
teaches the type, `capabilities.chatUi.components` lists it, and `/actions` hands its clicks to
these hooks. A contribution may also give:

- `prepare` — turn the model's input into stored props, and return the media those props name;
- `check` — problems beyond the schema, as sentences the model can act on;
- `shouldReview` and `reviewAccess` — whether showing this input needs an Auto review, and what the
  reviewer is told it reaches.

**4. Describe it**: a row in API.md's catalog table, which needs a person's approval like every
API.md change, and a drawer in each client. A client without one shows the component's `fallback`.

**A live component names what it is drawn from.** A component that shows server state carries no
copy of that state in its props. It names one read and one event, such as `GET /v0/config` and
`config.updated`, in API.md's catalog table, and the client package must already type both, so a
client draws it from the same state as its settings do and it stays current on every device. A
module whose action changes that state must announce the event, whoever changed it.

### Which component shows which pattern

| Pattern                                                                | Where to read it                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------ |
| Display only, no actions                                               | `file_tree` (`impl/basicComponents.ts`)                |
| Live from a read and an event; one action with a permission; a refusal | `default_model` (`impl/basicComponents.ts`)            |
| Contributed by another module                                          | `media` (`compute/impl/mediaComponent.ts`)             |
| Input that differs from props, media items, an Auto review             | `media`                                                |
| Several actions, a secret payload field, a typed result, a waking note | `service_key` (`tests/chatUi/support/`), in tests only |

## The API in five examples

`tests/chatUi/examples.test.ts` runs these against the real module, with real Config, History, and
Durable Functions on a real database. A change that breaks one changes the contract.

1. A model shows UI with `show_ui`, and the completed call carries the document; a bad call fails
   with every problem as a sentence, and nothing is shown.
2. A module shows UI with no model: `post()` writes an agent message with a `ui` block, text, and
   quick replies, and starts no turn.
3. A click with a secret is recorded, handled, and leaves the secret in no table, announcement,
   hidden message, or log line.
4. Quick replies are suggested by the model, and a tap is checked against the stored option.
5. A new component is one bundle and one contribution, with nothing else changed; a client with no
   drawer for it shows its fallback.

## Showing

`show_ui` and `suggest_replies` are the same two tools for every model. An agent a person cannot
answer, one managed by another agent, gets neither: `send` and `/actions` answer `409` for it, so
nothing shown there could be pressed. A subtask is created by an agent and still answered by a
person, so it gets both.

`show_ui` returns `{ presentation: { type: "ui", ui, items } }`, which History records on the
completed call. `items` is the document's one media list; a component that names media is told in
`prepare` where its first item lands. `post(ctx, agentId, { text?, components?, replies? })` writes
the daemon's own message instead. It carries no media, joins the conversation's open run or is
stored in a finished run of its own when none is open, and throws on a document or replies that
do not hold, because the daemon wrote them.

## A click

`act()` is what the `/actions` route calls once it has authenticated the caller and found that
they can read the conversation and that the agent takes messages. One component's clicks are taken
one at a time. In order:

1. `403` when the person lacks the action's permission, read against the stored offer.
2. A request `id` that is already an attempt answers that attempt's record, with no result.
3. `409` when the `id` is any other stored or queued message of the conversation.
4. `404` when the offer is not in the daemon's own copy: a visible agent message holding the
   document in a `ui` block, or in the `ui` presentation of a successful `show_ui` call. No other
   tool's result is an offer, whatever presentation it carries (`impl/findOffer.ts`).
5. `400` when the action is not the component's or the payload is not the action's.
6. `429` beyond 20 actions a minute on one component.

A refusal stores nothing. Otherwise, in one transaction, the attempt's row is inserted, its record
is stored `pending` in a finished run of its own (`HistoryModule.recordStandalone`, which marks
the run `kind: "standalone"` so clients do not take it for a turn), and a
`chat-ui.attempt` Durable Function call is made for it. The hook then runs with the whole payload,
for at most 15 seconds. Its outcome is applied in one transaction: the note, the wake, and the
record's outcome.

An attempt never stays `pending`:

| What happened                                     | Outcome                                 |
| ------------------------------------------------- | --------------------------------------- |
| The hook threw, or answered something else        | `failed`                                |
| The hook took longer than 15 seconds              | `failed`, `timeout`                     |
| The outcome's transaction or its wake threw       | `failed`; the note is not kept          |
| The daemon stopped while the hook ran             | `failed`, `interrupted`, when it starts |
| The hook's `code` or `reason` is longer than held | stored clipped to 64 and 500 characters |

The record holds the payload with its secrets left out, built from the schema's declared fields
only. A hook's error is logged by its kind alone, because its message may describe the request.

## Notes and wakes

A note is a sentence the server writes about its own state. It waits in
`happy_agent_chat_ui_notes` and joins the conversation's next turn as a hidden system message,
`<happy-note>…</happy-note>`, in the order the notes were left. With `wake`, a turn starts for
every waiting note now, on the conversation's last mode, or the installation's default for a
conversation that has none. `note(ctx, agentId, text, wake?)` is for a module that learns
something outside a hook, such as an operation that finished later.

## Quick replies

`suggest_replies` takes plain strings, stores each with its whitespace collapsed, and returns a
`quick_replies` presentation. A tap is an ordinary `send` naming the option; the API asks
`quickReplyProblem()`, which checks only that the option exists in a visible agent message of the
conversation and that the text equals it exactly (`impl/findSuggestion.ts`).

## Storage

| Table                          | Holds                                                            |
| ------------------------------ | ---------------------------------------------------------------- |
| `happy_agent_chat_ui_attempts` | One row per attempt: its ID, its component, when, and its status |
| `happy_agent_chat_ui_notes`    | Notes waiting for a conversation's next turn, in the order left  |

The rate limit and the replay by `id` read the attempts table; the action itself lives only in the
record. Nothing else is kept in memory across requests.
