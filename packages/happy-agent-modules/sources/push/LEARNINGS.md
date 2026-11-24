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

## The agent says what happened; the server decides when it leaves

Kirill pointed out that a local Happy Agent on a desktop with the new native phone app is the
majority of new users, and they got no push at all: the module could deliver but nothing asked it
to. Agents now hold `send_push_notification`, with the same name, schema, and description as
Happy Cloud. His rule for when it is sent: "ONLY send pushes when a top level task or agent
becomes idle - including subtasks". So the call sends nothing. It leaves a record in the agent's
run store, the last call of a run wins, and the transaction that settles the run hands the record
to `send`. An agent that calls it mid-work and keeps going notifies nobody until it stops.

The run store is the right home because Agent Base erases it in the settling transaction: the
record cannot outlive its run, and the send and the erasure commit together. A separate table
would have needed its own cleanup on every way a run can end.

## A run that did not end by the agent's choice tells nobody

A run store survives a crash so a resumed run can read it, which would have sent a notification
written before the restart, possibly hours later. The record is dropped when a run is restored by
a new process, when a turn is stopped, and when the run settles with an error. The resumed run can
call the tool again. Dropping on a stop follows the collaboration module, whose interrupted run
owes its creator no report either.

## Only agents a person can see hold the tool

The tool is offered to an agent with no parent, or a subtask. The API projects `userVisible` from
list membership that only it can read; the facts underneath are that every root agent was started
by a person, the API, a task, or a bot, and that a child agent is hidden unless Subtasks made it.
Hidden helpers cannot call the tool at all, so "a forced call reads ok" from the cloud's contract
is not reachable here: Agent Base refuses a tool the agent does not hold. The settling hook checks
visibility again so a record on a hidden agent can never send.

## The agent never learns the outcome, so the operator must

The tool answers `{ "ok": true }` whatever happens next, and the first version of delivery returned
silently when the person had turned notifications off or had no phone. Nobody could then tell why
a notification did not arrive. Every such ending now writes one log line with the notification and
agent IDs. The title and subtitle never reach a log.
