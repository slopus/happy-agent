# Chat UI — learnings

## Chat UI ships alone, before anything that uses it

An earlier branch built chat UI together with onboarding, team components, reply components, and
several unrelated changes, and a review could not tell what the API was. Kirill split the work
into stages: chat UI first, with a few components that show what the API looks like and make it
easy to extend. This module therefore holds only the mechanism and two components, and nothing in
it knows about onboarding, flows, or pacing.

## Written as if nothing came before

Kirill asked for the code to be written as though no earlier version was ever run. There is one
creating migration, each table holds only the columns the code reads, and no code path or comment
handles rows or designs an earlier build could have left.

## The wire is open, the server is strict

A closed union of component types on the wire meant every client had to be rebuilt before a server
could add one. A document now carries `{ id, type, fallback, props }` for any type; a client draws
what it knows and shows `fallback` for the rest, and the daemon checks every component against its
bundle before it writes a document. The client checks take a bundle lookup, so the daemon checks
against the bundles it serves, which need not be in the catalog: a test contributes a component the
catalog has never heard of and changes no shared code.

## Only `show_ui` makes a model's offer

Any tool can return a `presentation`. `/actions` accepted a `ui` presentation from whichever tool
carried one, so a tool a person added through MCP could have written a document whose clicks the
daemon would handle. An offer is now a `ui` block the daemon wrote or the presentation of a
successful `show_ui` call, and `show_ui`'s result type holds nothing but that presentation. The
same rule holds for `suggest_replies` and a tapped reply.

## An attempt never stays pending

A hook returning a `code` or `reason` longer than the record's schema made the outcome's write
fail and left the record `pending` forever, as did a wake that threw. The stored `code` and
`reason` are clipped to 64 and 500 characters, and when the outcome's transaction fails the
attempt settles as `failed`. A note from that outcome is not kept, since the outcome it belonged to
was not applied.

## A click's ID is the conversation's, not only the attempts'

A click whose `id` equalled an existing message's ID was stored under it and replaced that message
in clients. It answers `409` now, for a stored message and a queued one, as `send` does.

## No tools where nobody can press

An agent managed by another agent was offered `show_ui`, although `/actions` and `send` answer
`409` for it. It gets neither tool. Whether an agent is a subtask is read from its metadata here
rather than asked of Subtasks, because Subtasks is built on Compute, which contributes to this
module.

## Notes keep the order they were left in

Notes were ordered by a millisecond timestamp and then a random ID, so two notes left in the same
millisecond reached the model in either order. They are ordered by an insertion sequence.

## The patterns sign-in was to show are proven by a test component

`provider_sign_in` is on hold while its design changes, so the daemon serves no component with
several actions, a secret, a typed result, or a waking note. Those paths are exercised end to end
by `service_key`, a component only the tests contribute, which is also the README's worked example.

## Left for later

- Attempt rows and their records are never removed.
- A hook that times out is not cancelled; its attempt fails and its work may still finish.
- The attempts table repeats what the records hold; reading the rate limit and the replay from
  History instead would remove it.
