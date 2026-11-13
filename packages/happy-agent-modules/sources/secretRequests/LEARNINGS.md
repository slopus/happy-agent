# Secret requests learnings

## The request does not block, and the agent hears back by message

Steve's flow is "Hey, I want to add Stripe": the agent asks for the secret and gets on with its
turn. The blocking question `secretRequest` in API.md was not used for this: it holds the run open
and its answer is only a secret ID. `request_secret` publishes a card and returns at once; the
person may save it minutes later, from the chat, an artifact viewer, or another device, and the
agent learns of it from a steered system message.

## The daemon trusts only the stored action

A client sends the element key and the form, never the action. The action, and what it asked for,
is read from the version's stored render document, so a client cannot widen what was asked or
point a save at an agent of its choosing. The agent given the secret is the one the version's
`createdBy` names: the author, not the chat the version was made in, so a card a person published
gives no agent anything.

## Names cross, values never do

Values pass straight to the secrets module. The save table, the notice, the response, and every
error hold names only. The gym scenario asserts the raw values appear nowhere in inference
requests or the event journal.

## A save is idempotent by the client's ID

The client mints one ID per save. A retry answers the first save's outcome without saving or
messaging again, and the ID is the steered message's ID, so the agent hears once. Reusing an ID for
another element is a conflict rather than a silent replay.
