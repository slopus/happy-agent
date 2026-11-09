# Chat UI

Chat UI is the components a conversation shows, such as a choice of buttons, a sign-in, or a
phone pairing code, and every click on them. `packages/happy-agent/API.md` ("Chat UI") is the
contract, and `@slopus/happy-agent-client` holds the catalog: each component's props, actions,
payloads, results, permissions, and `Secret` fields, plus the checks both sides run.

`ChatUiModule` takes Config, History, and Durable Functions. Other modules take it and
`contribute` the components they serve; a component nobody contributes is not offered.

| Component                                        | Contributed by   |
| ------------------------------------------------ | ---------------- |
| `choice`, `checklist`, `text_field`, `file_tree` | Chat UI itself   |
| `default_model`                                  | Chat UI (Config) |
| `images`                                         | Compute          |
| `provider_sign_in`                               | Provider CLIs    |
| `phone_app`, `phone_pair`                        | Mobile Connector |

A contribution (`ChatUiContribution.ts`) has the model-facing `prompt`, the `fallback` line older
clients read instead, an optional `prepare` (such as `images` snapshotting files into chat media)
and `check`, an optional Auto `shouldReview`, `guestSafe` for exported bots' guests, and one hook
per action. A hook returns `accepted` (with an optional hidden `note`, `wake`, and typed
`result`) or `rejected` with a code and a reason; a throw or 15 seconds fails the attempt.

## Two ways in

- **`show_ui`**, the tool a model shows UI with. It is deferred, lists every contributed
  component's prompt and props, and builds the document through `document`: catalog, bundle,
  `prepare`, the catalog's own prop checks, and `check`. A problem is a sentence the model can act
  on, and nothing is shown. The result is a `ui` tool presentation that History keeps.
- **`post`**, for a document the daemon writes itself, such as onboarding's opening: an assistant
  message with optional text and a `ui` block.

`note` leaves the model a sentence about server state. Notes wait in this module's table and join
the next turn as one hidden `<happy-note>` system message (`beforeTurn`); with `wake` they start a
turn now on the conversation's last mode.

## A click

`POST /v0/agents/:agentId/actions` is routed by `ApiModule`, which checks that the caller can read
the conversation, works out their permissions (standalone: all; team owner: all; member:
`UI_MEMBER_PERMISSIONS`; a guest: guest-safe components only), and calls `act`. `resolveOffer` is
the one place an action is checked against the stored offer, so any other route can share it:

1. Find the component in a visible agent message: a `ui` block or a completed `show_ui` result.
2. Check the action's declared permission under the clicker's own authority (`403`).
3. A request ID already stored replays that attempt (idempotency).
4. No such offer is `404`; a payload or action the component does not take is `400`.
5. Leave every `Secret` field out of the payload.
6. Decide whether the offer is still open: a `once` action takes one answer, and a person's message
   after the offer closes it.

`act` then takes one click per component at a time, so two never both answer a `once` offer. A
`"message"` action needs a valid mode. Over 20 actions a minute on one component is `429`. A closed
offer is recorded as `rejected` with `offer_closed` and the answer that won. Otherwise the attempt
is stored as `pending`, with its record (a service message with one `action` block) in a finished
run of its own (`history.recordStandalone`), and the `chat-ui.attempt` Durable Function is invoked;
then the hook runs, and its outcome is applied in one transaction: the record's outcome, the
person's message for an accepted `"message"` action (its words from the catalog's `uiActionText`,
queued and sent like a typed message), and any note. `onRecordUpdated` lets the API announce the
changed record.

If the daemon stops while a hook runs, `chat-ui.attempt` runs again at start and marks the attempt
`failed` with `interrupted`.

Secrets are never stored, evented, logged, or given to the model: the payload is redacted before
the record is written, a hook's error is logged by kind only, and the catalog refuses `Secret`
fields on `"message"` actions.

## Storage

`happy_agent_chat_ui_attempts` holds one row per attempt (redacted payload, status, the person's
message), indexed for the open-offer check, the rate limit, and the restart sweep.
`happy_agent_chat_ui_notes` holds the notes waiting for a turn.
