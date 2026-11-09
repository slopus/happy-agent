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

## Message actions might move to `send`

Kirill is weighing whether actions that become the person's words (`choice`, `checklist`,
`text_field`) should be sent through `send` with the text explicit and an action reference the
server verifies, and whether offers get an audience. `resolveOffer` is kept as one method so either
route can use it.
