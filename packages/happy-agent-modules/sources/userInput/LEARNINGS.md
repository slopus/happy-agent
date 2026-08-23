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

## A parked wait holds a graceful shutdown open, and that is what makes durability work

Once the process is shutting down, Agent Base treats close as "stop at the next safe edge" and
deliberately does not abort a tool that is already running. A wait parked on a question therefore
keeps the agent's loop open until the shutdown coordinator times out and the process exits. That is
the intended bound, and it is also what leaves the call unanswered in the store — which is exactly
what a durable tool needs in order to be retried by the next daemon.

Do not try to end the wait early to speed shutdown up. Returning or throwing from `execute` commits
a tool result, and a committed result is a permanent answer: the question would come back as a
failure after every restart instead of being asked again.

A consequence for tests: the API gym cannot restart a daemon that has a question in flight. Its
daemon runs in the test process, so when the shutdown times out the SQLite process lock is never
released and the next daemon refuses to open the database. Cover this behavior at the module
boundary — a fresh module instance replaying the same Base tool-call CUID2 over the same database
is what a restart actually looks like.

## Agent questions use natural labels and relative timeouts

Short means concise, not twelve characters. Agent-facing question headers allow up to 64
characters so ordinary labels such as “Release scope” and “Client release” remain valid. Batched
questions carry shared Markdown context once on the request and question-specific headers and
options on each question.

The direct module API can accept an absolute `deadlineAt`, but the agent tool does not expose it.
An agent does not share the daemon's authoritative wall clock and should request the bounded
relative `autoResolutionMs` instead, avoiding deadlines that precede request creation.
