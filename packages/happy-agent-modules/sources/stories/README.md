# Stories

An image or short video a task's or bot's own agent posts for 24 hours, shown on that row's icon,
and people's reposts and replies. A person sees stories only while their `stories` user setting is
`true`.

```ts
const stories = new StoriesModule(config, chatMedia, compute, tasks, bots, team, userSettings);
```

| Module               | Why                                                               |
| -------------------- | ----------------------------------------------------------------- |
| `ConfigModule`       | Where a story's snapshot is kept, to serve it                     |
| `ChatMediaModule`    | Snapshots the posted file, like `present_files`, and round videos |
| `ComputeModule`      | Reads the file from the agent's machine under its permissions     |
| `TasksModule`        | The posting task, and who is a member of it                       |
| `BotsModule`         | The posting bot                                                   |
| `TeamModule`         | Every member a post may reach, and the person an agent works for  |
| `UserSettingsModule` | The `stories` setting, read for each person                       |

## Posting

`post_story { path, caption? }` is offered only to a task's or bot's own agent, and only while
the person it works for has stories on: the latest identified human sender in its conversation,
recorded by this module as messages are accepted, else a task's owner (a task created by another
agent hears only agents), or a standalone installation's one person. When the latest human was an
exported bot's guest, the agent works for nobody and gets no tool. The call checks again before
posting. The file is measured before it is read: it must be a non-empty regular file within the
chat media limit, named as an image (one that decodes) or with an `.mp4` extension; a video's bytes must open with
an MP4 `ftyp` box and carry an `avc1` or `avc3` sample entry. The tool
call's ID is the story's ID: a replayed call returns the story it first posted, even an ended one,
without inserting or announcing anything. Media is served only while its snapshot is present.

The same agent also gets `list_stories` (its live stories and reposts of them, with seen and reply
counts and the latest 50 replies) and `delete_story` (one of its own stories, with its reposts).

## Reposts, replies, and deleting

A repost copies the original's agent, task or bot, and media, so the original's audience and row
carry over unchanged; only its caption, optional round MP4 (16 MiB, checked like a posted video),
reposter, and lifetime are its own. A reply is stored with the story and sent to the story's agent
as the replier's own user message quoting the story, delivered in the agent's current mode, so the
agent answers it like anything the person typed. `canDelete` is computed per reader: a task's owner
deletes their task's agent stories, a person their own reposts, and anyone standalone; a bot's
stories are deleted only by its agent's tool. Deleting ends the story and its reposts (they read
as missing at once) and announces `story.removed` to everyone who saw them.

## Reading

A task's story reaches its members, a bot's story every member, while the task or bot is active;
each reader must also have stories on. Hiding an archived one's stories also keeps a reply from
waking its archived agent. The agent's `list_stories` and `delete_story` check `canPost` again when
they run. Anything else reads as missing, so the API answers `404`. Each post computes, inside its
transaction, the copy every eligible reader is served, and announces them after commit; seen state
is per reader, so `story.changed` and `story.removed` are delivered to one reader at a time.

## Storage

Migration `001-stories`: `happy_agent_module_stories` holds each story's record with its
`expires_at`, and `happy_agent_module_story_seen` one row per story and person who opened it.
Migration `002-story-replies` adds `happy_agent_module_story_replies`. A deleted story is ended by
setting its `expires_at` to 0 and dropping its seen and reply rows. Ended stories are never served
and are deleted with their seen and reply rows on the next post. Media and round bytes live in chat
media's content-addressed store.
