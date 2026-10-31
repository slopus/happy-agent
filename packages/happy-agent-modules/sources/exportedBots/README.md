# Exported bots

Exporting a bot makes it reachable from a chat service, in the OpenClaw sense: the bot keeps
living in Happy, and people talk to it from somewhere else. There are two kinds, `telegram`,
built in, and `bridge`, which an outside bridge program serves for any other service. A bot is
exported at most once per kind, and one service account serves at most one bot.

An export is meant for a bot of its own, created for the job, not for the Chief of Staff. The
Chief of Staff only holds the admin tools: it exports other bots, and it is where every access
request arrives.

## Kinds

Everything kinds share lives in `ExportedBotsModule`: saved exports, the allowlist, guests, access
requests, conversations, durable replies, typing, and status. A kind is an `ExportedBotAdapter` in
its own folder that knows only its service: how to name an export, whether its user IDs are
global, how to keep a connection open and turn what arrives into `InboundMessage`s, how to split
and send a reply, and its own setup tool. `createExportedBotAdapters` lists the kinds; adding one
adds an adapter there and nothing else.

| Kind       | Folder      | Connection                                                                                           |
| ---------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `telegram` | `telegram/` | Long-polls `getUpdates` with the bot token from @BotFather.                                          |
| `bridge`   | `bridge/`   | A bridge connects to `GET /v0/exported-bots/connect` and speaks `docs/exported-bot-protocol.md`, v1. |

Every ID a service supplies, whether a person, a chat, or a message, is an opaque string, so a
kind never has to fit another service's number format. Telegram's numeric IDs are stored as their
decimal strings.

## Managing exports

Every tool goes only to an active admin bot. Every tool that changes an export requires `botId`,
the bot people will talk to, with no default to the calling bot, so an export never lands on the
Chief of Staff by omission. `get_exported_bot_status` takes it as an optional filter, and lists
every export, with everyone waiting to be let in, without it.

| Tool                        | What it does                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `set_telegram_exported_bot` | Exports a bot with a @BotFather token, or changes its allowlist, token, or settings.     |
| `set_bridge_exported_bot`   | Exports a bot through a bridge and writes its token to a file, or rotates or changes it. |
| `remove_exported_bot`       | Stops one kind of export and deletes its credentials. Conversations and guests stay.     |
| `get_exported_bot_status`   | Shows each export's state, allowlist, waiting and refused people, and conversations.     |
| `approve_exported_bot_user` | Lets in a person who asked as a guest, and delivers the message they were waiting with.  |
| `deny_exported_bot_user`    | Turns a person away, discards their held message, and takes them off the allowlist.      |

Exports live in `happy_agent_module_exported_bots`, and every change is reconciled into the running
connections at once, with no reload. Exporting, changing, removing, and approving are reviewed in
Auto and need Auto or Full access, because a guest can have the bot use whatever it can reach and
an export reaches outside Rig's sandbox; each review names the bot and the people being let in,
never a credential. Denying needs the same access but no review, because it only takes access
away. `get_exported_bot_status` is read-only and skips review.

A Telegram token is checked with `getMe` before it is saved and is read only to talk to Telegram;
no tool result, log line, error, status, or Durable Function argument contains it. It reaches the
tool through the conversation, so it stays in that conversation's history. A bridge token is made
by the tool and written to a file the admin bot names, created with mode `0600` before anything
is written into it. Only its SHA-256 digest is stored, compared in constant time, so it never
enters history, the database, or a log. Writing the file outside the workspace is the one step
that runs with Full access in Auto. A token is `heb1.<account>.<secret>`; the account survives
rotation, so people keep their conversations.

The only configuration is `[telegram] api_url` in the user `happy.toml`, for a self-hosted Bot API
server. A tool cannot set it, because that server receives every Telegram token.

## Guests

Everyone an export lets in is a guest: a `TeamModule` user with the `guest` authentication, made
through `TeamModule.createGuest`, which no sign-in method can prove and which is never the owner.
A guest is created when an admin approves the person, or when someone an admin put on the
allowlist first writes. `happy_agent_module_exported_bot_guests` maps the person to their guest by
kind, scope, and service user ID. The scope comes from the adapter's `guestScope`: empty for
Telegram, whose user IDs are global, so a person has one guest on every bot exported to Telegram;
the export's account for a bridge, whose IDs mean something only to that bridge. The guest's name
is the one the service gives, renamed through `TeamModule.renameGuest` when the service gives a
new one. Removing someone from an allowlist, turning them away, or removing the export keeps the
guest, so their messages keep their author.

A guest's message is stamped with `GUEST_MESSAGE_ORIGIN_METADATA` and their `userId`. History
shows it as a user message by that guest, and Team announces them as an outside guest in both
modes; everything that grants trust asks for the user origin, so Auto review reads the message as
untrusted context and it authorizes nothing. Every guest message also carries the `auto`
permission mode, so a mode the owner chose for a message of their own never applies to a guest's.
Messages from bots and from group chats never reach an agent.

## Conversations

```text
Bot (Scout)
├── Ada on Telegram     ← subtask, metadata exportedBot = { kind, botId, userId, chatId }
└── Grace on Slack
```

Each guest gets one conversation subtask under the bot, created on their first message through
`SubtasksModule.createConversation`. It shares the bot's folder, does not report its runs to the
bot, and carries `exportedBot` metadata naming the person and their chat. The
`happy_agent_module_exported_bot_conversations` table maps bot, kind, account, and person to that
subtask, so every later message, including after a restart, reaches the same conversation. When a
person's subtask is archived, their next message starts a fresh one. The conversation's
instructions say who it is talking to and that they are a guest.

## Access requests

Someone not on the allowlist is handled by the export's `unknownSenders` setting. With `ignore`,
their message is dropped and the last few are kept in memory for the status, so an admin can read
their ID. With `ask`, the default:

1. Their first message is held in `happy_agent_module_exported_bot_senders` as a pending request:
   at most 32,000 characters and a count of its attachments. Their files are never opened.
2. The active Chief of Staff is sent one message, with the agent origin, naming the kind, the bot,
   and the person's ID, username, and display name, never what they wrote. While the Chief of
   Staff is archived or missing, the request is only recorded.
3. The person is sent one fixed notice, written in source rather than by a model, through the
   reply function like any reply.
4. Until someone decides, the person's later messages are dropped silently.

`approve_exported_bot_user` adds the person to the allowlist, makes or finds their guest, removes
the request, and delivers the held message to a new conversation in the same transaction.
`deny_exported_bot_user` records a refusal, discards the held message, and takes the person off
the allowlist; their later messages are dropped silently. Approving a refused person lets them in,
and taking someone off the allowlist does not refuse them. An export holds at most 20 requests and
remembers 1,000 refusals.

Whenever any export exists, the Chief of Staff's instructions tell it to tell the user who is
asking and ask, unless the user already decided, and never to approve on its own judgment.

## Delivery

Each enabled export whose bot is active runs in its own `<kind>-exported-bot` context, restarted
after a failure; exporting, changing credentials, pausing, removing, or archiving the bot starts
or stops it. Every message a connection hands over is taken in by one transaction that reads the
export, routes the message, and advances the connection's durable cursor in
`happy_agent_module_exported_bot_cursors`, so an allowlist change applies to the next message and
a restart neither drops nor repeats one. The queued message's ID is derived from the kind,
account, and service message ID, which makes any repeated delivery a no-op. Attached files are
read before that transaction and only for admitted senders: regular files only, opened without
following links, at most 10 of at most 32 MiB each. Pictures are shown to the model; other files
are named by path.

Every text block the run writes is a reply. A block waits in the run store only until the next
block or a tool call follows it, and is then owed in the transaction that keeps what followed, so a
note written before a tool call reaches the person before that tool runs. The run's last block is
its answer: it is owed when the run settles, together with the images the run generated or read
and the files it showed with `present_files`. The tool calls are noted as they end, because
tool-call hooks see only call-scoped stores, and their media is read from
`ChatMediaModule.storedItems` at settlement. Each reply is owed through the `exportedBots.reply`
Durable Function under one lock per chat, so replies go out in the order they were owed, and is
sent after commit through the adapter in the pieces it chooses. Progress is kept per piece, so a
restart resumes where sending stopped, and a refusal the service will never accept drops the
rest. A block that is exactly `NO_REPLY` is never sent, and a run whose answer is `NO_REPLY` sends
no media either.

While a conversation works, the service shows the bot as typing. The indicator starts when the
run's loop starts and is renewed every `typing.intervalMs` the adapter gives, and again right after
each reply, since a service may hide it once the bot speaks, until the run settles. It runs in a
`<kind>-exported-bot-typing` context of its own, is never durable, and stops after an hour even if
the run never settles; the next inference starts it again.

- **Telegram** sends text in pieces of at most 4,000 characters, images as photos up to 10 MB,
  and other files as documents up to 50 MB. A photo from an admitted sender is downloaded into
  `ConfigModule.exportedBotFilesPath` with mode `0600`, handed over, and removed.
- **Bridge** puts each reply in `happy_agent_module_exported_bot_outbox`, in the reply function's
  transaction, and sends it to the bridge as a `reply` frame with a growing `seq`. The bridge's
  `ack` removes it; every unconfirmed reply is sent again after the next `hello`, and at most 1,000
  are kept. The WebSocket itself is accepted by the API module, which hands it to
  `ExportedBotsModule.prepareSocket`; a bridge token authenticates that route and nothing else.
