# Export a bot to any chat service

Use this recipe when the user wants people to talk to a bot from a chat service Happy Agent does
not have built in, such as Slack, Discord, Matrix, or their company's chat. A small program called
a bridge carries messages between that service and Happy Agent over one WebSocket. Happy keeps the
conversations, the allowlist, and the replies still owed; the bridge owns everything about the
service. Telegram is built in and has [its own recipe](exported-bot-telegram.md). The
[bridge protocol](../exported-bot-protocol.md) is the bridge's specification, and
[Configuration](../configuration.md#exported-bots) is the reference.

## A separate bot, not the Chief of Staff

Export a bot of its own, made for the job, and never the Chief of Staff, which is you. Everyone
who talks to the bot through the bridge gets a conversation that works in that bot's folder with
what it can reach, so the bot they reach should have only the folder and purpose the user chose
for them.

You take part in two ways only: you export the bot, change its export, and stop exporting it,
with the bot's `botId`, which every changing tool requires; and you decide who gets in, because
access requests for every exported bot arrive in your conversation. These tools are yours because
you are an admin bot; the exported bot never has them. Every change applies immediately, without
a reload.

| Tool                        | Use                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `set_bridge_exported_bot`   | Export a bot and write its token, or change its allowlist, token, strangers, or pause. |
| `get_exported_bot_status`   | See whether the bridge is connected, who is allowed, and who is waiting to be let in.  |
| `approve_exported_bot_user` | Let in a person who asked, once the user said yes.                                     |
| `deny_exported_bot_user`    | Turn away a person who asked, once the user said no.                                   |
| `remove_exported_bot`       | Stop exporting (`kind: "bridge"`), delete the token, and drop unsent replies.          |

## What the user does, and what you do

| Step                                     | Who                                         |
| ---------------------------------------- | ------------------------------------------- |
| Choose or create the Happy bot           | You, with the user's name                   |
| Export the bot and write its token file  | You                                         |
| Write or choose the bridge, and run it   | The user, or you in a project they agree to |
| Give the bridge the service's own access | The user                                    |
| Send the bot a message on the service    | The user                                    |
| Approve the user's access request        | You, once they confirm                      |
| Verify a reply arrives                   | Both                                        |

## 1. Choose the bot

Call `get_exported_bot_status` first. If the bot is already exported through a bridge, this is a
change: skip to the step that applies. A bot has at most one bridge export; a second service needs
a second bot.

If the user names an existing bot other than you, find its ID with `list_bots`. Otherwise create
one with `create_bot`, with a name for its job; ask the user for a name if they have no
preference. Give it a name either way: people reach it only through the bridge, so it never
receives the first message that would otherwise name it.

## 2. Export the bot

Call `set_bridge_exported_bot` with:

- `botId`, the bot from step 1.
- `service`, the chat service as people know it, such as `Slack`. It names their conversations,
  such as "Ada Lovelace on Slack".
- `tokenFile`, where the bridge will read its token: absolute, or relative to your working
  directory, such as inside the bridge's project. Writing outside your workspace is reviewed.
- `allowedUsers`, only if the user already gave you the service's user IDs, exactly as the bridge
  will send them. Leave `unknownSenders` out so it stays `"ask"`.

The result says the export **is waiting for its bridge to connect**, names the token file, and
gives the connect URL. The token is written to that file, readable only by its owner, and shown
nowhere else: Happy keeps only a digest of it. Never print, copy, or paste the token, and if the
file sits in a Git repository, make sure it is ignored before anything is committed.

## 3. Run a bridge

[`exported-bot-bridge.mjs`](exported-bot-bridge.mjs) ships beside this recipe, normally in
`~/.happy/docs/recipe/`. It is a complete bridge for a pretend service, the terminal: each line
typed is a message from one person, `/attach <path> [text]` sends a file, `/as <user ID> [name]`
switches who is typing, and replies are printed with the person they are for. It is the quickest
way to see an export work, and the starting point for a real bridge. Copy it into a folder of its
own, install the `ws` package there, and run it with the token file and the connect URL:

```sh
pnpm add ws
node exported-bot-bridge.mjs /path/to/bridge.token 'ws+unix:///path/to/daemon.sock:/v0/exported-bots/connect' terminal "Ada Lovelace"
```

The third and fourth arguments are the user ID and name it sends. A real bridge keeps the same
shape and replaces the terminal with the service's API:

1. Open a WebSocket to the connect URL with the header `Authorization: Bearer <token>`. A
   standalone daemon listens on its Unix socket, which the Node `ws` package reaches with the
   `ws+unix://` URL; a team daemon listens on TCP.
2. After the `hello` frame, send each one-to-one message as a `message` frame with an `id` unique
   forever, the sender's `userId`, the `chatId` to answer in, their `name`, and `text` or
   `attachments`. Send messages that were not answered when a connection ended again, with the
   same `id`.
3. Post each `reply` frame's text and files to the service, then answer with `ack` and its `seq`.
   Skip a `seq` already delivered. Show `typing` frames as the service's typing indicator.
4. Reconnect with backoff when the connection closes. Stop on `401`, which means the token was
   rotated or the export removed, and on close code `4000`, which means another bridge took over.

Files never cross the WebSocket; both sides exchange absolute paths. Run the bridge on the
daemon's machine, as a user that can read Happy's files and whose saved files Happy can read.
Happy shows pictures people send to the bot, and sends back the images the bot generates and the
files it shows with `present_files`. A bridge on another machine can still exchange text.

## 4. Let the user in

1. Ask the user to send the bot a message on the service. While they are not allowed, the bridge
   receives one reply for them with this fixed notice, and nothing reaches the bot yet:

    > Thanks for your message. This bot only talks to people its owner has approved, so your
    > request was sent to them. If they approve it, the bot will answer the message you just sent.

2. An access request arrives in your conversation. It names the bot and the sender's user ID,
   username, and display name as the bridge sent them, never what they wrote. Ask the user to
   confirm that this is them.
3. Call `approve_exported_bot_user` with `kind: "bridge"`, the bot's `botId`, and the `userId`
   from the request. They become a guest, their held message goes to their new subtask, and the
   bot answers it.

Other people who write to the bot are asked about the same way. Tell the user who is asking and on
which bot, ask whether to let them in unless the user already told you, and never approve someone
on your own judgment of them.
[Access requests](exported-bot-telegram.md#access-requests-from-other-people) in the Telegram
recipe describes the rest, which is the same for every exported bot.

## 5. Verify

Check that:

1. `get_exported_bot_status` says the export **is connected** and lists the user's conversation.
2. A subtask named "<their name> on <service>" appeared under the bot, not under you.
3. The user received a reply on the service.

| What you see                                     | What to do                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Status: is waiting for its bridge to connect     | The bridge is not running or cannot reach the daemon. Read its output.                         |
| The bridge is refused with `401`                 | Wrong file, or the token was rotated or removed. Rotate it with `rotateToken` and `tokenFile`. |
| The bridge is refused with `503`                 | The export is turned off or its bot is archived. Turn it on or restore the bot.                |
| The bridge is closed with `4000`                 | Two bridges use the same token. Run only one.                                                  |
| A message is rejected because of its attachment  | The bridge must save files on this machine and send absolute paths to regular files.           |
| Status: Ignored a message from …                 | Strangers are ignored. Set `unknownSenders: "ask"`, or allow their ID directly.                |
| A request names an ID that differs from the list | IDs are compared exactly as the bridge sends them. Allow the ID from the request.              |

## Later changes

Every change names the exported bot's `botId`. `get_exported_bot_status` takes it too, to show one
bot.

| Change                      | How                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| Let a person in             | `approve_exported_bot_user`, or `set_bridge_exported_bot` with the full new `allowedUsers`.          |
| Take a person off the list  | `set_bridge_exported_bot` with the full new `allowedUsers`. Their subtask and guest stay.            |
| Turn a person away for good | `deny_exported_bot_user`. They are taken off the list too.                                           |
| Stop or resume requests     | `set_bridge_exported_bot` with `unknownSenders: "ignore"` or `"ask"`.                                |
| Start someone's chat afresh | Archive their subtask. Their next message starts a new one.                                          |
| Pause the export            | `set_bridge_exported_bot` with `enabled: false`. The bridge is disconnected; replies are kept.       |
| Replace a leaked token      | `set_bridge_exported_bot` with `rotateToken: true` and `tokenFile`. The old token stops at once.     |
| Stop exporting              | `remove_exported_bot` with `kind: "bridge"`. The token stops working and unsent replies are dropped. |

## What the user should know

- Everyone let in is a guest: a person Happy knows by name, who can never sign in to Happy or
  open the app. A guest's messages are their own requests and never count as the user's
  instructions, including when Auto permissions decide whether an action is allowed, and they
  always run in Auto. The bot still works for them with whatever it can reach, so allow only
  people the user trusts with the bot's folder and tools.
- Whoever holds the token can send messages as any allowed guest. Keep the token file private,
  and rotate the token if it may have leaked.
- The bridge receives every reply and every file the bot shows. Run only a bridge the user trusts.
- Nothing a stranger writes reaches any bot before they are approved; you see only who they are.
- Each person sees only their own conversation. Their subtask works in the bot's folder, which is
  why the export has a bot of its own. A bridge's user IDs belong to that bridge, so the same
  person on two bridges is two guests.
- Replies wait in Happy until the bridge confirms them, so a bridge that was offline catches up
  when it reconnects. Everything the bot writes is sent, including short notes on its progress
  while it works, and the files it shows arrive with its last reply to each message.
