# Chat UI

Chat UI is the components a conversation shows, such as a sign-in, a phone pairing code, or a row
of pictures, and every click on them. Every action is silent: it changes server state and never
becomes the person's words. The module also owns quick replies, the answers a person can send with
one tap. `packages/happy-agent/API.md` ("Chat UI" and "Quick replies") is the contract, and
`@slopus/happy-agent-client` holds the catalog: each component's props, actions, payloads, results,
permissions, and `Secret` fields, plus the checks both sides run.

`ChatUiModule` takes Config, History, and Durable Functions. Other modules take it and
`contribute` the components they serve; a component nobody contributes is not offered.

| Component                 | Contributed by   |
| ------------------------- | ---------------- |
| `file_tree`               | Chat UI itself   |
| `default_model`           | Chat UI (Config) |
| `media`                   | Compute          |
| `provider_sign_in`        | Provider CLIs    |
| `phone_app`, `phone_pair` | Mobile Connector |

A contribution (`ChatUiContribution.ts`) has the model-facing `prompt`, the `fallback` line older
clients read instead, an optional `prepare` (such as `media` snapshotting files into chat media)
and `check`, an optional Auto `shouldReview`, `guestSafe` for exported bots' guests, and one hook
per action. A hook returns `accepted` (with an optional hidden `note`, `wake`, and typed
`result`) or `rejected` with a code and a reason; a throw or 15 seconds fails the attempt.

## Two ways in

- **`show_ui`**, the tool a model shows UI with. It is deferred, lists every contributed
  component's prompt and props, and builds the document through `document`: catalog, bundle,
  `prepare`, the catalog's own prop checks, and `check`. A problem is a sentence the model can act
  on, and nothing is shown. The result is a `ui` tool presentation that History keeps.
- **`post`**, for a message the daemon writes itself, such as onboarding's opening: an assistant
  message with optional text, a `ui` block, and a `quick_replies` block.

## Quick replies

`suggest_replies` is the tool a model suggests answers with, offered wherever `show_ui` is. Its
options are normalized and checked by `replies` (the client's `normalizeQuickReply` and
`quickRepliesProblems`), and its result is a `quick_replies` presentation. A tap is an ordinary
`send` whose `text` is the option and whose `quickReply` names it: `{ messageId, toolCallId?,
index }`. `ApiModule` asks `quickReplyProblem` before storing anything: the message must be a visible
agent message here holding that suggestion (the named `suggest_replies` result, or the message's own
`quick_replies` block when no call is named), with an option at `index` equal to `text` exactly;
otherwise `400`. There is no liveness, once, or audience check. The pending row and the message
metadata carry `quickReply`, and History copies it onto the accepted message.

### Reply components

An option may carry a reply component, a small display-only drawing beside its text, such as an
AI's mark and live sign-in state. The catalog lives in the client under `sources/replies/`. Modules
serve a type with `contributeReply(bundle, { prompt, check? })`: `suggest_replies` teaches each
served type's prompt and props, `capabilities.chatUi.replies` lists them, and `replies` checks each
option's `ui` against the catalog, the served types, and the module's `check`. The stored form keeps
`options` as strings and adds `ui`, one entry per option, null for a bare one, left out when no
option has one, so older clients and the `quickReply` check never see a difference.

| Reply component | Contributed by |
| --------------- | -------------- |
| `provider`      | Provider CLIs  |

## Notes

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

`act` then takes one click per component at a time, so a retried ID and the rate limit see what the
click before stored. Over 20 actions a minute on one component is `429`. The attempt is stored as
`pending`, with its record (a service message with one `action` block) in a finished run of its own
(`history.recordStandalone`), and the `chat-ui.attempt` Durable Function is invoked; then the hook
runs, and its outcome is applied in one transaction: the record's outcome and any note.
`onRecordUpdated` lets the API announce the changed record.

If the daemon stops while a hook runs, `chat-ui.attempt` runs again at start and marks the attempt
`failed` with `interrupted`.

Secrets are never stored, evented, logged, or given to the model: the payload is redacted before
the record is written, and a hook's error is logged by kind only.

## Storage

`happy_agent_chat_ui_attempts` holds one row per attempt (redacted payload and status), indexed for
the rate limit and the restart sweep. Its `once` and `person_message_id` columns are left from
message actions and are always `0` and null.
`happy_agent_chat_ui_notes` holds the notes waiting for a turn.
