# Feed learnings

## Everything about a Surface is one subject

The design first gave todo lists and documents subjects of their own beside the Surface's
creation. That split "Shopping created" from "Shopping: 5 new todos" into two rows and made
opening the list mark only one of them seen. Every Surface change now has the subject
`{ type: "surface", id }`; new todos and document edit sessions are updates to it.

## Your own change folds into your newest entry

Steve's rule is that a person's own direct change counts as seen. Opening a new seen entry for
every one of them would fill a person's feed with their own work, one row per todo they typed.
Their change folds into their newest entry for the subject, open or seen, and leaves it seen; a
new seen entry opens only when they have none. An agent's change never counts as seen, even
when it acts for that person, because agent work is what the Feed is for.

## Entries are replaced whole and ordered by their own version

Seeing an entry does not move its `cursor`, so the cursor cannot order two copies of it.
Entries carry a UUIDv7 `version` minted at every change, and `feed.item.updated` carries the
whole entry; clients keep the greater version.

## Fan-out is serial, and joining is ordered with it

Every fan-out holds the single lock key `feed.fanout`, so changes reach feeds in log order. A
reader records the newest change in the log when they join, and fan-out skips that change and
everything older for them, because seeding already covered it. Startup enrollment holds the same
lock, so a pending fan-out cannot race a reader's seeding.

## Background announcements answer no request

Fan-out, enrollment, and the task and agent read routes emit Feed events outside the request's
mutation scope. Only `POST /v0/feed/seen`, read-all, and subscribing echo a `mutationId`.
