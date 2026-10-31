# Exported bot bridge protocol

Exporting a Happy bot through a bridge lets people reach it from any chat service. The bridge is a
small program that sits between the service and Happy Agent: it receives people's messages from
the service, hands them to the daemon over one WebSocket, and delivers the bot's replies back.
Happy Agent keeps the conversations, the allowlist, and the replies that are still owed; the
bridge owns everything about the service itself, including files. Telegram is built in and needs
no bridge.

This document is the normative specification of protocol version 1. The
[bridge recipe](recipe/exported-bot-bridge.md) is the walkthrough, with a reference bridge.

## Connecting

An admin bot, normally the Chief of Staff, exports another bot with `set_bridge_exported_bot`,
which writes a new bridge token to a file the admin bot names. The daemon keeps only the token's
SHA-256 digest, so the token cannot be shown again; rotating it writes a new one. A bridge token
identifies exactly one exported bot and is accepted nowhere else in the API.

The bridge opens a WebSocket to `GET /v0/exported-bots/connect` with the header
`Authorization: Bearer <bridge token>`:

- A standalone daemon serves it on its Unix socket, `paths.socketPath`. With the Node `ws`
  package the URL is `ws+unix:///absolute/path/to/socket:/v0/exported-bots/connect`.
- A team daemon serves it on its TCP listener, such as
  `ws://host:3000/v0/exported-bots/connect`.

The optional `protocol` query parameter selects the protocol version and defaults to `1`, the only
version so far. Before the upgrade the daemon may refuse with an HTTP status and a JSON error body:

| Status | `code`                     | Meaning                                                        | The bridge should             |
| ------ | -------------------------- | -------------------------------------------------------------- | ----------------------------- |
| `400`  | `unsupported_protocol`     | This daemon does not speak the requested version.              | Stop.                         |
| `401`  | `unauthorized`             | The token is unknown, was rotated, or the bot is not exported. | Stop until given a new token. |
| `503`  | `exported_bot_unavailable` | The export is turned off or its bot is archived.               | Retry later, with backoff.    |
| `503`  | `not_initialized`          | The daemon is still starting.                                  | Retry soon, with backoff.     |

An exported bot has at most one bridge connection. A new connection with the same token replaces the older
one, which is closed with code `4000`.

## Frames

Every frame is a UTF-8 text frame holding one JSON object of at most 1 MiB, with a string `type`.
Receivers ignore frame types and fields they do not know, so later additions do not break older
bridges or daemons. A binary frame closes the connection with `1003`, and text that is not a JSON
object closes it with `1007`.

Identifiers the bridge supplies (`id`, `userId`, `chatId`) are its own opaque strings of 1–256
characters without control characters. Happy Agent never interprets them, and compares them
exactly.

### From the daemon

**`hello`** is always the first frame on a connection.

```json
{ "type": "hello", "protocol": 1, "bot": { "id": "k3v9x2m8q1w7e5r4t6y0u2i8", "name": "Scout" } }
```

**`ack`** answers one `message` once it is taken in, durably. It is also the answer for a message
from someone who is not on the allowlist, which never reaches the bot (see Strangers), and for a
message with an `id` already taken in, which changes nothing.

```json
{ "type": "ack", "id": "1718000000.000100" }
```

**`reject`** answers one `message` that will never be taken in, such as one with an invalid field
or an attachment that cannot be read. `id` is present when the refused frame carried a string
`id`. Sending the same message again gets the same answer.

```json
{ "type": "reject", "id": "1718000000.000100", "reason": "Attachment 1 is not a regular file." }
```

**`reply`** is something the bot said to one person. `seq` is a positive integer that only grows
over the export's life; it is never reused, and it is not contiguous. `userId` and `chatId` are
the person and the chat of their latest message. A reply has `text`, `attachments`, or both.

```json
{
    "type": "reply",
    "seq": 42,
    "userId": "U024BE7LH",
    "chatId": "D024BE91L",
    "text": "Here is the chart you asked for.",
    "attachments": [
        {
            "path": "/Users/ada/.happy/agent/media/3f/3f5a…",
            "mimeType": "image/png",
            "name": "chart.png",
            "size": 48211
        }
    ]
}
```

**`typing`** says the bot is working on an answer for this person. It is not durable, and it is
repeated about every four seconds while the bot works.

```json
{ "type": "typing", "userId": "U024BE7LH", "chatId": "D024BE91L" }
```

### From the bridge

**`message`** is one thing a person said to the bot.

```json
{
    "type": "message",
    "id": "1718000000.000100",
    "userId": "U024BE7LH",
    "chatId": "D024BE91L",
    "name": "Ada Lovelace",
    "username": "ada",
    "text": "Can you plot last week's numbers?",
    "attachments": [{ "path": "/var/bridge/files/numbers.csv", "mimeType": "text/csv" }]
}
```

- `id` — unique for this exported bot, forever. Happy Agent derives the conversation message from it,
  so sending a message again, for example after a reconnect, never delivers it twice.
- `userId` — the person, as the service identifies them. The allowlist holds these values. Each
  person on it becomes a guest in Happy with their own conversation, so send only one-to-one
  messages; mixing several people into one `userId` mixes them into one guest and one
  conversation.
- `chatId` — where replies to this person go. A later message may change it.
- `name` — optional, at most 256 characters: how to address the person. It names their guest and
  their conversation in Happy.
- `username` — optional, at most 64 characters: the person's handle on the service, shown as
  `@username`.
- `text` — optional, at most 32,000 characters.
- `attachments` — optional, at most 10, each `{ "path", "mimeType"?, "name"? }`. See
  Attachments.

A message has `text`, at least one attachment, or both. The daemon takes messages in one at a time,
in the order they arrive on the connection, and answers each with exactly one `ack` or `reject`,
in the same order. A bridge keeps at most 64 messages unanswered; one more closes the connection
with `1008`. A message that was unanswered when a connection ended may or may not have been taken
in, so send it again with the same `id`.

**`ack`** confirms that the bridge has finished with a reply: it was delivered, or the bridge has
given up on it for good. The daemon then forgets the reply.

```json
{ "type": "ack", "seq": 42 }
```

## Strangers

A message from someone not on the allowlist is acknowledged like any other, and the export's
`unknownSenders` setting decides the rest:

- `ask`, the default: the first message from that person is held, the Chief of Staff is told who
  is asking, never what they wrote, and the person is sent one `reply` with a fixed notice that
  their request was passed on. Until someone approves them, later messages are acknowledged and
  dropped. On approval, the person becomes a guest and the held message goes to the bot, which answers it.
  An exported bot holds at most 20 requests at once; while it is full, further strangers are dropped without a notice.
- `ignore`: every message from that person is acknowledged and dropped without an answer.

Attachments from strangers are never opened, in either mode.

## Replies are durable

A reply waits in the daemon until the bridge acknowledges it. After every `hello`, the daemon sends
every unacknowledged reply in `seq` order, then new replies as the bot writes them, so a bridge
that was offline loses nothing. Delivery is at least once: a reply may arrive again after a
reconnect, and a bridge that keeps the highest `seq` it delivered can skip repeats. The daemon
keeps at most 1,000 unacknowledged replies per exported bot and discards the oldest beyond that.
Removing the export discards them; turning it off or rotating its token keeps them.

## Attachments

No file bytes cross the WebSocket. An attachment is an absolute path on the daemon's machine, so
the bridge must run where it can read and write the same files, as the same user or one with
access to them. A bridge that connects from another machine cannot exchange attachments.

- **From the bridge**, the bridge writes the file and sends its path. It must be a regular file,
  not a symbolic link or directory, of 1 byte to 32 MiB. Images the daemon can decode — PNG,
  JPEG, GIF, and WebP — are shown to the bot as pictures. Any other file is given to the bot as
  its path, name, type, and size, so keep it while the conversation may need it. Files from
  people not on the allowlist are never opened. The daemon never changes or deletes these files.
- **From the daemon**, `path` is a read-only copy in Happy's private data folder, named by its
  content. Read it, and do not change, move, or delete it. `mimeType`, `name`, and `size` describe
  it. Attachments are the images the bot generated and the files it presented while writing the
  reply.

## Closing

The daemon pings every 30 seconds and closes a connection that did not answer the previous ping.
WebSocket libraries answer pings on their own. These close codes are the daemon's:

| Code   | Meaning                                                               | The bridge should            |
| ------ | --------------------------------------------------------------------- | ---------------------------- |
| `1001` | The daemon is stopping.                                               | Reconnect with backoff.      |
| `1003` | The bridge sent a binary frame.                                       | Fix the bridge.              |
| `1007` | The bridge sent text that is not a JSON object.                       | Fix the bridge.              |
| `1008` | The bridge left more than 64 messages unanswered.                     | Wait for answers.            |
| `1009` | A frame was larger than 1 MiB.                                        | Fix the bridge.              |
| `4000` | Another connection with this token replaced this one.                 | Stop.                        |
| `4001` | The export was changed or removed, for example by rotating its token. | Reconnect; `401` means stop. |
| `4002` | The export was turned off or its bot archived.                        | Reconnect with backoff.      |

## Security

- The bridge token is a credential. Whoever holds it can send messages as any guest on the
  allowlist, and the bot works for a guest with whatever it can reach. A guest's message is never
  the owner's instruction or authorization, including in Auto permission review, and it always
  runs in Auto. Keep the token file private, and rotate the token if it leaks.
- The bridge receives every reply and every file the bot attaches. An attachment can be any file
  the bot can read and chose to present, under the same permission review as showing it in Happy.
- Happy Agent enforces the allowlist itself. A bridge does not need to filter senders: a message
  from someone else never reaches the bot, and the only thing ever sent back to them before they
  are approved is the fixed notice described under Strangers.

## Versioning

Version 1 changes only by addition: new frame types and new optional fields, which receivers
ignore until they understand them. Anything incompatible becomes a new version that a bridge asks
for with `protocol`; a daemon keeps speaking version 1 to bridges that do not ask.
