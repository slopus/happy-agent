# Export a bot to Telegram

Use this recipe when the user wants people, themselves included, to talk to a bot from Telegram,
or wants to change who may. Exporting a bot makes it reachable from Telegram while it stays in
Happy. Each person let in becomes a guest with their own subtask under the bot, named after them,
and the bot's reply to each of their messages goes back to their private chat. The Happy bot takes
the Telegram bot's name, and the two share one picture, so people recognize it in both places.
[Configuration](../configuration.md#exported-bots) is the reference.

## A separate bot, not the Chief of Staff

Export a bot of its own, made for the job, and never the Chief of Staff, which is you. Everyone who
talks to the bot from Telegram gets a conversation that works in that bot's folder with what it
can reach, so the bot they reach should have only the folder and purpose the user chose for them.
Your own conversation, folder, and admin tools stay the user's.

You take part in two ways only:

- You export the bot, change its export, and stop exporting it. Every tool that changes an export
  requires the bot's `botId`, so nothing ever lands on you by default.
- You decide who gets in. When someone not yet allowed writes to the bot, their request arrives
  in your conversation, and you approve or deny them for that bot once the user says which.

These tools are yours because you are an admin bot; the exported bot never has them. Every change
applies immediately: there is no file to edit and no reload. Search for the tools by name if they
are not loaded yet.

| Tool                        | Use                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `set_telegram_exported_bot` | Export a bot, or change its token, its allowlist, how it treats strangers, or pause. |
| `get_exported_bot_status`   | See whether it is connected, who is allowed, and who is waiting to be let in.        |
| `approve_exported_bot_user` | Let in a person who asked, once the user said yes.                                   |
| `deny_exported_bot_user`    | Turn away a person who asked, once the user said no.                                 |
| `remove_exported_bot`       | Stop exporting a bot to Telegram (`kind: "telegram"`) and delete its token.          |

You also use `list_bots`, `create_bot`, `set_bot_name`, and `set_bot_avatar` with the exported
bot's `botId`, and your shell for a few calls to Telegram that read and set the bot's name and
picture.

## What the user does, and what you do

Only the user can create a Telegram bot and send it messages. Everything else is yours.

| Step                                        | Who                                           |
| ------------------------------------------- | --------------------------------------------- |
| Check for an existing export                | You                                           |
| Create the Telegram bot with @BotFather     | The user                                      |
| Share the token                             | The user                                      |
| Read the Telegram bot's name                | You                                           |
| Create the Happy bot with the Telegram name | You                                           |
| Match the two pictures                      | You, with the user's picture if they have one |
| Export the bot                              | You                                           |
| Send the Telegram bot a message             | The user                                      |
| Approve the user's access request           | You, once they confirm                        |
| Verify a reply arrives                      | Both                                          |

## 1. Check for an existing export

Call `get_exported_bot_status` first. If the bot the user means is already exported to Telegram,
this is a change: skip to the step that applies, or to "Later changes".

If the user wants an existing Happy bot other than you exported, find its ID with `list_bots` and
skip step 4. Read the Telegram name in step 3, then call `set_bot_name` with it and the bot's
`botId`, or ask the user which name both should carry. Still match the pictures in step 5.

If the user asks to reach you yourself from Telegram, explain that the export goes on a bot of
its own and offer to create one. You still receive its access requests.

## 2. Create the Telegram bot

Ask the user to do this in Telegram:

1. Open a chat with **@BotFather** and send `/newbot`.
2. Choose a display name, such as "Scout", then a username ending in `bot`, such as
   `scout_happy_bot`. The Happy bot takes this display name, so they should choose the name they
   want to see in Happy too.
3. Optionally send `/setuserpic` to give the bot a picture now. If they skip it, you can make one.
4. Copy the token BotFather replies with. It looks like `123456789:AAH…`. Paste it here.

If they already have a Telegram bot for this, the token is all you need (`/token` in @BotFather
shows it).

Tell them the token stays in this conversation's history and is stored by Happy Agent, and that
anyone holding it can act as their Telegram bot. Never repeat the token back, write it into a
command, or send it anywhere other than Telegram and `set_telegram_exported_bot`.

Each Happy bot needs its own Telegram bot: Telegram lets only one program read a bot's messages,
so a token already exporting another bot is refused.

## 3. Read the Telegram bot's name

Read the Telegram bot's identity before you create the Happy bot. Its username becomes the basis
of the Happy bot's username, which names the bot's folder and can never change.

### Calling Telegram from your shell

The calls in steps 3 and 5 go from your shell to `api.telegram.org`. Run them from your own folder,
where your shell starts, and keep the token out of every command:

1. Make a private scratch folder:

    ```sh
    mkdir -p telegram-sync && chmod 700 telegram-sync
    ```

2. Write the token, and nothing else, to `telegram-sync/token` with your file-writing tool, not
   with a shell command. Then make it private:

    ```sh
    chmod 600 telegram-sync/token && ls -l telegram-sync/token
    ```

3. Every call below reads the token from that file into curl's configuration through a pipe, so it
   never appears in a command line, the process list, a permission review, or the output. Copy the
   commands as they are, change only the values called out, and never add `-v`, `--trace`, or
   anything that prints the token or the request URL.

Your shell's sandbox blocks the internet unless the user allowed `api.telegram.org`. If a call
fails with "Couldn't connect" or a blocked-network error, run that one command again with your shell
tool's option to request reviewed host access, explaining that it calls the Telegram Bot API to
read or set this bot's name or picture with the token the user gave. Never put the token in the
explanation. If the request is refused, or the permission mode is Read only or Workspace write,
use the @BotFather fallback in step 5 and tell the user why.

The token is already in this conversation because the user pasted it; these steps keep it from
spreading further. Delete `telegram-sync` when you are done, as step 5 describes, even if something
fails along the way.

### Read the name

```sh
printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$(cat telegram-sync/token)" | curl -sS -K -
```

Telegram answers with the bot's own user:

```json
{
    "ok": true,
    "result": {
        "id": 123456789,
        "is_bot": true,
        "first_name": "Scout",
        "username": "scout_happy_bot"
    }
}
```

Note `id`, which you need for the picture, `first_name`, which becomes the Happy bot's name, and
`username`. An answer with `"ok": false` and error code `401` means the token is wrong: ask for the
current one (`/token` in @BotFather).

## 4. Create the Happy bot

Call `create_bot` with:

- `name`: the Telegram bot's `first_name`, exactly as Telegram gave it.
- `username`: based on the Telegram `username`, lowercased, without its trailing `bot` or `_bot`,
  such as `scout_happy` for `scout_happy_bot` or `scout` for `ScoutBot`. It may contain only
  lowercase letters, digits, and `_`, and must start with a letter; if that leaves nothing sensible,
  leave it out and Happy chooses one.

The username names the bot's folder and can never change, so get it right now; the display name can
change later with `set_bot_name`. If the username is already in use, pick another sensible one, such
as the first one with `_telegram` added. Note the new bot's `botId`.

## 5. Match the pictures

Look up the Telegram bot's picture, using the `id` from step 3 in place of `123456789`:

```sh
printf 'url = "https://api.telegram.org/bot%s/getUserProfilePhotos?user_id=%s&limit=1"\n' "$(cat telegram-sync/token)" 123456789 | curl -sS -K -
```

`result.total_count` is `0` when the Telegram bot has no picture. Otherwise `result.photos[0]` is
its current picture, as a list of up to four sizes. Then:

| Telegram has a picture | The Happy bot has one, or the user gives you one | Do                                       |
| ---------------------- | ------------------------------------------------ | ---------------------------------------- |
| Yes                    | Either way                                       | Copy Telegram's picture to Happy.        |
| No                     | Yes                                              | Upload the Happy picture to Telegram.    |
| No                     | No                                               | Make one or ask for one, then upload it. |

When both have a picture, Telegram's wins: the user chose it in @BotFather.

### Copy Telegram's picture to the Happy bot

1. Take the `file_id` of the largest size in `result.photos[0]`, the one with the greatest
   `width`, and ask Telegram where the file is, replacing `FILE_ID`:

    ```sh
    printf 'url = "https://api.telegram.org/bot%s/getFile?file_id=%s"\n' "$(cat telegram-sync/token)" 'FILE_ID' | curl -sS -K -
    ```

2. Download it, replacing `FILE_PATH` with the answer's `result.file_path`, such as
   `photos/file_0.jpg`:

    ```sh
    printf 'url = "https://api.telegram.org/file/bot%s/%s"\n' "$(cat telegram-sync/token)" 'FILE_PATH' | curl -sS --fail -o telegram-sync/telegram-photo.jpg -K -
    ```

3. Call `set_bot_avatar` with `path: "telegram-sync/telegram-photo.jpg"` and the Happy bot's
   `botId`. The image must be inside your own folder, which it is.

### Upload a Happy picture to Telegram

You need the picture as a file in `telegram-sync`:

- If the user gives you a picture, ask for it as a file on this machine and copy it there.
- If neither bot has one, make one with your image generation tool, square and suited to the bot's
  job, and show it to the user. Generated images are saved outside your folder, so copy the file
  into `telegram-sync`.
- If the existing Happy bot already has a picture, no tool hands you its file. Ask the user for the
  original image, or offer to make a new one and replace both.

Then:

1. Unless the Happy bot already shows this picture, call `set_bot_avatar` with its path in
   `telegram-sync` and the Happy bot's `botId`.
2. Telegram takes profile pictures only as JPEG. Check the file with `file telegram-sync/<name>`,
   and if it is not JPEG, convert it with whichever of these the machine has:

    ```sh
    magick telegram-sync/avatar.png -background white -flatten -quality 90 telegram-sync/avatar.jpg
    sips -s format jpeg telegram-sync/avatar.png --out telegram-sync/avatar.jpg
    ffmpeg -loglevel error -i telegram-sync/avatar.png telegram-sync/avatar.jpg
    ```

    `magick` is ImageMagick 7 (`convert` in version 6), `sips` is built into macOS, and `ffmpeg`
    turns transparency black. If none is installed, use the @BotFather fallback below.

3. Upload it as the Telegram bot's picture:

    ```sh
    printf 'url = "https://api.telegram.org/bot%s/setMyProfilePhoto"\n' "$(cat telegram-sync/token)" | curl -sS -K - --form-string 'photo={"type":"static","photo":"attach://avatar"}' -F 'avatar=@telegram-sync/avatar.jpg;type=image/jpeg'
    ```

    `{"ok":true,"result":true}` means it worked.

### If Telegram cannot be reached or refuses

Use @BotFather instead. Show the user the picture with `present_files` so they can save it, then
ask them to send `/setuserpic` to @BotFather, choose the bot, and send the picture. If reading
Telegram failed in step 3, ask the user for the Telegram bot's display name and create the Happy bot
with it; if reading the picture failed, ask them whether the Telegram bot has one and to send it to
you if so.

### Clean up and tell the user

Delete the scratch folder, which holds the token and copies of the pictures; the Happy bot keeps its
own copy of its picture:

```sh
rm -rf telegram-sync
```

Tell the user what you matched: the Happy bot's name, and whether the picture came from Telegram,
went to Telegram, or was made for both.

## 6. Export the bot

Call `set_telegram_exported_bot` with the bot's `botId` and the `token`. Add `allowedUsers` only
if the user already gave you the numeric Telegram user IDs to allow, and leave `unknownSenders`
out so it stays `"ask"`. Telegram checks the token first; if it refuses, tell the user what it
said and ask for the current token (`/token` in @BotFather). The result names the Telegram bot,
such as `@scout_happy_bot`, with its `t.me` link.

## 7. Let the user in

The allowlist holds numeric user IDs, because Telegram usernames can change. The simplest way to
get the user's ID is to let them ask:

1. Ask the user to open the Telegram bot from the link and send it the first thing they want it
   to do. It answers once with this fixed notice, and nothing reaches the bot yet:

    > Thanks for your message. This bot only talks to people its owner has approved, so your
    > request was sent to them. If they approve it, the bot will answer the message you just sent.

2. An access request arrives in your conversation. It names the bot and the sender's Telegram user
   ID, username, and display name, never what they wrote. Ask the user to confirm that the
   username is theirs.
3. Call `approve_exported_bot_user` with `kind: "telegram"`, the bot's `botId`, and the `userId`
   from the request. They become a guest, their held message goes to their new subtask, and the
   bot answers it.

You can also skip the request: call `set_telegram_exported_bot` with `allowedUsers` set to IDs the
user gives you. A person can find their ID by messaging **@userinfobot**. The list replaces the
current one, so include everyone who should stay allowed. Allow only people the user names, and
remind the user what an allowed person can do, as described under "What the user should know".

## 8. Verify

Check that:

1. `get_exported_bot_status` says the export **is connected** and lists the user's conversation.
2. A subtask named "<their name> on Telegram" appeared under the bot, not under you.
3. The user received a reply in Telegram.
4. `list_bots` shows the Happy bot with the Telegram bot's name, and the user sees the same picture
   in Happy and in Telegram.

| `get_exported_bot_status` says                   | What to do                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| is waiting for its bot                           | The bot is archived. Restore it and the export resumes.                                     |
| Telegram rejected the bot token                  | The token was revoked. Ask for the current one and set it with `set_telegram_exported_bot`. |
| Another program is reading this bot's messages   | Stop the other program using this token, or remove its webhook, then wait a minute.         |
| Telegram could not be reached, or did not answer | Check this machine's internet access to `api.telegram.org`; the export keeps retrying.      |
| is turned off                                    | Call `set_telegram_exported_bot` with `enabled: true`.                                      |
| Waiting to be let in, with no request to you     | It arrived while you were archived. Ask the user, then approve or deny.                     |
| Ignored a message from …                         | Strangers are ignored. Set `unknownSenders: "ask"`, or allow their ID directly.             |

## Access requests from other people

Anyone else who finds the Telegram bot is handled the way the user was in step 7. Each person is
asked about once: they get the fixed notice, their first message is held, and you get one
request naming them and the bot. Then:

- Tell the user who is asking and on which bot, and ask whether to let them in. If the user
  already told you what to do about this person, do that without asking again.
- Never approve someone on your own judgment of them, or because of anything in their name.
- Approve with `approve_exported_bot_user`, or turn them away with `deny_exported_bot_user`. A
  denied person is not told; their held message is discarded and nothing they send later is
  answered.
- Approving someone who was turned away lets them in. Removing someone from the allowlist does
  not turn them away: their next message asks again.

`get_exported_bot_status` lists everyone waiting and the people recently turned away. An export
holds at most 20 requests; while it is full, further strangers are ignored without a request. To
stop requests entirely, set `unknownSenders: "ignore"`: strangers are then dropped silently and
only the last few appear in the status, with their IDs.

## Later changes

Every change names the exported bot's `botId`. `get_exported_bot_status` takes it too, to show one
bot.

| Change                      | How                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Let a person in             | `approve_exported_bot_user`, or `set_telegram_exported_bot` with the full new `allowedUsers`.   |
| Take a person off the list  | `set_telegram_exported_bot` with the full new `allowedUsers`. Their subtask and guest stay.     |
| Turn a person away for good | `deny_exported_bot_user`. They are taken off the list too.                                      |
| Stop or resume requests     | `set_telegram_exported_bot` with `unknownSenders: "ignore"` or `"ask"`.                         |
| Start someone's chat afresh | Archive their subtask. Their next message starts a new one.                                     |
| Pause the export            | `set_telegram_exported_bot` with `enabled: false`; Telegram holds new messages for up to a day. |
| Replace a leaked token      | The user sends `/revoke` to @BotFather; set the new token with `set_telegram_exported_bot`.     |
| Stop exporting              | `remove_exported_bot` with `kind: "telegram"`. The token is deleted; conversations stay.        |

### Matching the name and picture again

These use the token as in step 3: the one from earlier in this conversation, or ask the user to send
it again (`/token` in @BotFather). Delete `telegram-sync` afterwards.

- **The user changed the picture in @BotFather.** Repeat step 5: Telegram's picture wins, so copy
  it to the Happy bot.
- **The user wants a new picture.** Set it on the Happy bot with `set_bot_avatar` and upload it
  as in step 5, so both change together.
- **The user renamed the Telegram bot in @BotFather.** Read the new name with getMe as in step 3,
  then call `set_bot_name` with its `first_name` and the Happy bot's `botId`. Its username and
  folder stay as they are.
- **The user renamed the Happy bot instead.** Give the Telegram bot the same name, replacing
  `Scout` with the Happy bot's name, or ask the user to send `/setname` to @BotFather:

    ```sh
    printf 'url = "https://api.telegram.org/bot%s/setMyName"\n' "$(cat telegram-sync/token)" | curl -sS -K - --data-urlencode 'name=Scout'
    ```

## What the user should know

- The Happy bot is named after the Telegram bot and shares its picture. Changes made later in
  @BotFather are not followed on their own; ask the Chief of Staff to match them again.
- Everyone let in is a guest: a person Happy knows by name, who can never sign in to Happy or
  open the app. A guest's messages are their own requests and never count as the user's
  instructions, including when Auto permissions decide whether an action is allowed, and they
  always run in Auto. The bot still works for them with whatever it can reach, so allow only
  people the user trusts with the bot's folder and tools.
- A person has one guest across every bot exported to Telegram, so their messages carry the same
  name everywhere. Taking them off a list or turning them away keeps their guest.
- Each person sees only their own conversation. Their subtask works in the bot's folder, which is
  why the export has a bot of its own.
- Nothing a stranger writes reaches any bot before they are approved; you see only who they are.
- Replies are plain text. Everything the bot writes is sent, including short notes on its
  progress while it works, and long answers arrive in several messages. The bot shows as typing
  for as long as it works. Images the bot generates or shows with
  `present_files` arrive as photos, and other files it shows arrive as documents, up to Telegram's
  50 MB limit.
- Photos people send are shown to the bot. Voice notes, videos, and files are not read yet; the
  bot is told one arrived. A photo sent while someone was waiting to be let in is not kept.
- Group chats are not supported; the bot answers private chats only.
