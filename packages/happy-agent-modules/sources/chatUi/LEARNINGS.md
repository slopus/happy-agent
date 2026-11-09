# Chat UI learnings

## Models show UI through a tool, never through markup in their text

Inline actions taught models an HTML grammar (`<menu>`, `<button data-action>`, `<figure>`) that the
server had to parse back out of prose, store choices for, and resolve presses against by block
index. Kirill replaced it with chat UI: a model calls `show_ui` with typed components, the daemon
checks them before anything is shown, and a click names the document by `uiId` and component.
HTML or JSON in a reply's text is never drawn.

## Each component belongs to the module that does its work

Sign-in lives with Provider CLIs, pairing with the Mobile Connector, images with Compute. Each
module contributes its own components and handles their actions by calling itself, never its own
HTTP routes. Chat UI owns only the shared path: the tool, the attempt records, permissions,
redaction, and the restart sweep. It takes no Team module, because Team is built after the modules
that contribute; the API route works out the clicker's permissions and passes them in.

## A click is checked under the clicker's authority, against the stored offer

Nothing in the request is trusted beyond its IDs and payload: the component and its props come
from the stored message, and the permission is the one the catalog declares for that action,
checked against the person who clicked, at the time they clicked. A refusal stores nothing.

## Attempts are history, but never model input

Every action leaves a service record with its outcome, so every client shows the same result and a
retry with the same ID replays it. Records sit in finished runs of their own so they never close or
join the model's run, and they are not model input; what the model should know arrives as a note.

## Secrets are redacted before anything is written

A pasted token or sign-in code is a `Secret` field: the hook receives it, and nothing else does.
The record, the attempt row, events, logs, and the model see the payload without it, and a hook's
error is logged by kind only, because an error message can quote the request.

## Suggested answers are quick replies, sent like typing

Message actions (`choice`, `checklist`, `text_field`) made a press become the person's words
through `/actions`: words rebuilt from stored labels, an optimistic bubble, offers that closed once
answered or once the person typed, and a "Not sent" state. Kirill split answers out of chat UI.
Every component action is silent now. A suggested answer is a quick reply: the model calls
`suggest_replies`, and a tap is the ordinary `send` with `text` equal to the option and
`quickReply` naming it. The daemon checks only that the option exists in a visible agent message
here and that the text matches it exactly, then sends it like any typed message (mode, delivery,
steering, pending, retry by ID). Anyone who can send may use any visible suggestion, any number of
times: it is the same as typing it. `resolveOffer` stays as the one place `/actions` checks an offer.

## A note says whether it is worth a turn

A note joins the conversation's next turn. A module passes `wake` when what happened should be
answered now, such as an AI connected from a sign-in widget; the wake takes every waiting note into
one hidden message, so several wakes at once start one turn.
