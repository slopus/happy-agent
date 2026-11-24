# Push — learnings

## Self-hosted and team servers register phones the way Happy Cloud does

Kirill reported that mobile push notifications did not arrive, and wanted them from self-hosted
and team servers too, not only Happy Cloud. The daemon had nowhere to keep a member's phone
registration and nothing that could send. The module now serves Happy Cloud's registration
contract unchanged, under the same `/v0/cloud/push` paths, with the same validation, limits,
30-day expiry, and status codes, so the mobile apps reuse the client code they already have. The
paths keep the `cloud` prefix for that reason only; the module has nothing to do with the Cloud
account module.

## The token is a capability, so it cannot be printed

Whoever holds a `HappyPushToken[...]` can send to that phone. A branded string would still print,
so the token is a class whose text is a private field: every way of printing it yields
`HappyPushToken[redacted]`, and only the stored row and the relay request read the text. No
operation returns a token, no error repeats one, and no event carries one. The relay's own answer
text is never returned, thrown, or logged either, because it may echo the token; only fixed outcome
words leave the sender.

## Sending is a durable intent, not a call that returns a result

A first design had `send` make the relay requests and return their outcomes. A caller holding a
transaction would then have kept the database for up to eight seconds per phone, and every caller
would have needed its own machinery to survive a restart. `send` now writes one Durable Functions
call with the caller's transaction and delivers after commit. Calls for one person share a lock
key, so two notifications reach the relay in the order they were sent and a later one can replace
an earlier one on the phone.

The outcomes are not returned because nobody may act on them: the agent that asks for a
notification is never told whether, where, or to how many phones it was delivered.

## Never a second request to the same phone

Happy Cloud sends each phone one request and never retries, because a request whose fate is
unknown may already have been shown. Durable Functions runs a call again after a restart, which
would have resent to every phone. Each phone is therefore marked in the call's state, and that
write made durable, before its request. A restart carries on with the phones not yet tried.

## One person never touches another's phone

Registration, removal, and settings take their owner from the caller's context. An ID another
person holds answers not found rather than revealing or replacing it, and a removal that names
someone else's registration, or a version since renewed, succeeds without removing anything.

## Matching Happy Cloud means matching what it tolerates, too

An independent check against Happy Cloud found three places where the first version was stricter or
counted differently: an uppercase `If-Match` UUID was refused where the cloud answers `204`, a
`null` locale was refused where the cloud takes it as none, and a schema `maxLength` counted UTF-16
units where the cloud counts characters. The module now reads the version in either letter case and
compares it in lowercase, takes a `null` locale as none, and counts every length with a pattern
that charges a surrogate pair once. That pattern's alternatives must never overlap: a first draft
let one pair also match as two single units and took minutes to refuse a 65-emoji string.

## `send` enforces the notification's bounds

The first schema accepted an empty title and 4,096 characters of each line, leaving the limits to
whatever would call `send` later. The limits belong to the notification, so `send` now refuses a
title outside 1–80 characters or a body over 160, before anything is recorded. Every caller
inherits the same contract instead of restating it.
