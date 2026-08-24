# User input learnings

## A question must survive the daemon that asked it

`request_user_input` used to be declared `durable: false`, so a call interrupted by a restart came
back to the model as "The tool call was interrupted by a restart and was not retried." A person may
take days to answer; losing their question to a daemon restart is the opposite of what the Inbox is
for.

The tool is now `durable: true`. Re-executing it is safe rather than merely tolerable, because the
request ID is Agent Base's generated tool-call CUID2 and Base restores that ID with the stored call:
the second execution's `ask` resumes the very request the first one created instead of asking
again, and its `wait` returns immediately when the person answered while the daemon was down.
Deadlines are absolute — `autoResolutionMs` counts from `createdAt` — so a resumed wait cannot
silently extend the window a restart interrupted.

## A parked wait is reloadable and does not hold graceful shutdown open

`request_user_input` is both durable and reloadable. During graceful drain, Agent Base aborts the
current execution lifetime without recording a tool result and leaves the same pending call in
storage. The next daemon re-executes that call with the same Base CUID2, so `ask` rejoins the one
durable request instead of creating another and `wait` returns immediately if the person answered
while the daemon was down.

Do not turn drain into an ordinary return or thrown tool failure. Either would commit a permanent
tool result and prevent the next daemon from resuming the question. The reloadable boundary is
what makes shutdown prompt while preserving both the pending tool call and request identity.

## Agent questions use natural labels and relative timeouts

Short means concise, not twelve characters. Agent-facing question headers allow up to 64
characters so ordinary labels such as “Release scope” and “Client release” remain valid. Batched
questions carry shared Markdown context once on the request and question-specific headers and
options on each question.

The direct module API can accept an absolute `deadlineAt`, but the agent tool does not expose it.
An agent does not share the daemon's authoritative wall clock and should request the bounded
relative `autoResolutionMs` instead, avoiding deadlines that precede request creation.

## Model-facing questions stay flat and always use the questions array

The request tool once wrapped a union of ask and detail-read inputs inside an `input` property so
providers would see an object at the schema root. In a real Codex call, the model produced the
complete valid ask object at the root and omitted only that artificial wrapper, so validation
rejected the question before it could reach the person.

`request_user_input` now has one flat object with shared `context`, a required `questions` array
even for one question, and optional `autoResolutionMs`. Bounded detail paging belongs to the
separate flat `read_user_input` tool. The module's direct API still accepts singular asks, but the
agent surface favors one obvious provider-compatible shape over an overloaded tool contract.

## Asking is meaningful session activity

A user-facing question advances a session's meaningful activity at the request's durable
`createdAt`. Settling the request does not advance it again and does not erase it: consumers that
sort conversations must see the same timestamp while the question is pending, after it is
answered, and after a daemon restart. User input exposes the newest question timestamp directly so
callers do not page through model-bounded list output or duplicate knowledge of its storage.
