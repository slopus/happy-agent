# Titles

Automatic chat titles, plus combined first-message naming for eligible placeholder workspaces.

A chat opened without a title gets one from its first accepted text-bearing `user` message. The
message role is the whole trigger: provenance is not inspected, so the behavior is identical when
the message came through the API, a tool, or another in-process caller. When the chat belongs to an
eligible placeholder workspace, the same request gives its workspace and Git branch a slug.

Initial naming starts after the accepting transaction commits and runs through a detached
module-owned context and async resource. Message acceptance and the agent's real inference proceed
in parallel with it; the workspace and branch are renamed asynchronously when the slug arrives.
The second accepted user message triggers one detached title refinement from committed history
including that new message. Later messages do not generate naming requests.

## How a name is written

Combined initial naming sends only the first user message. It does not include history, agent
output, tool output, or transport metadata. It resolves the workspace attached to the agent or one
of its ancestors and asks for the workspace slug in the same request as the title. The folder and
Git branch share that slug because they are the same piece of work under two filesystems. A title
or workspace name someone deliberately chose is never replaced.

The request runs on its own provider session, outside the agent loop, so nothing it says reaches the
history a person reads or the context the agent works from. Each of the first two user-message
positions can launch at most one request.

The model is the cheapest one served by the account the chat already runs on — that account is the
only one known to be signed in and paid for — at the least reasoning effort the model accepts.
Writing three words does not deserve a reasoning budget.

Each name is asked for as its own tag, `<title>…</title>` and `<slug>…</slug>`, because that is the
shape models answer most reliably, and only the names still wanted are asked for. A greeting, a code fence or a closing remark around it is ignored; an answer with no tag at
all is read as the name itself. A chat title is bounded to six words and 80 characters; a workspace
or branch name is reduced to lower-case kebab-case and bounded to 48 characters. Text that is merely
too long is shortened rather than rejected — a slightly long name beats no name.

## The second look

A first message is a request, and a request is often not what the work turns out to be: the question
that became a rewrite, the bug report that became a design. The second user message is the one point
where the module looks again. By then committed history includes the opening request, any work
recorded between the two messages, and the new request itself.

The second look is the same cheap model on the same account, reading the conversation instead of the
opening message, and asked a different question: not "name this" but "is this still what it is
called". The title it was given is the answer unless the conversation plainly contradicts it, because
a title that keeps moving is worse than one that was slightly wrong — a person looking for the chat
again is looking for the name they last saw.

Only the exact title automatic naming last wrote is eligible. A title supplied during agent
creation, or one a user or agent changed afterwards, has no generated-title provenance and is
final. Refinement checks that provenance both when the second message commits and immediately
before inference, so a deliberate rename racing the task still wins.

It happens once and off the critical path. The per-agent user-message counter advances in the same
transaction that accepts each message, so restarts and concurrent sends cannot buy duplicate title
requests. If the second message arrives before initial naming finishes, its refinement waits behind
that naming task while the agent itself keeps working.

The workspace and the branch get no second look at all. A folder and a Git ref are named once,
because renaming either would move it out from under agents already working there.

## What it depends on

`new TitlesModule(config, history, workspaces)`.

| Module                                        | Why                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`ConfigModule`](../config/README.md)         | The accounts a name is written on, and the catalog the cheapest model comes from.   |
| [`HistoryModule`](../history/README.md)       | The committed conversation read after the second accepted user message.             |
| [`WorkspacesModule`](../workspaces/README.md) | Agent placement and the catalog that applies a generated workspace and branch name. |

Nothing else is passed in. One name may take ten seconds, and that is a constant here rather than
a setting: it bounds detached naming work and is the module's own. The message and agent do not
wait on this clock.

## Public methods

- `nameFromFirstMessage(ctx, { firstMessage, providerId?, sessionNamed?, workspace? })` —
  the combined operation used by automatic initial naming. It settles what is still wanted, hands
  the folder name to the workspaces catalog itself, and answers with the chat title. It never
  throws: the message and turn it is naming are already on their way.
- `suggestNames(ctx, { firstMessage, wanted, providerId? }, { signal? })` — the names alone, without
  writing any of them anywhere.
- `refineChat(ctx, { transcript, currentTitle?, providerId? }, { signal? })` — the second look, given
  the conversation as plain text. It answers with the title to use, which is usually the one it was
  given.
- `workspaceWasNamed(ctx, workspaceId)` / `markWorkspaceNamed(ctx, workspaceId)` — the durable fact
  that a workspace has already taken the name of a chat.

## Storage

No tables. The per-agent `title-user-messages` key records whether one or two text-bearing user-role
messages have committed. It is capped at two because later messages never trigger title work. The
shared Agent KV store retains generated-title provenance and the workspace naming fact.

Under `generated-titles` is the exact title automatic naming last wrote for each agent. A different
current title is deliberate and cannot be refined over.

Under `named` are the workspaces that have already been named from a chat. A workspace takes the name
of its first chat once and never again; the key is only written once a name has actually arrived, so
an attempt that failed leaves the next chat free to try.

A name is never a failure. Every method answers with `undefined` rather than raising when the model
declines, times out, or says nothing usable, and the message that would have been named is already
on its way.
