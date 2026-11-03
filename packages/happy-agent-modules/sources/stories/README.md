# Stories

Images and videos a task's own agent publishes to everyone who joined the task for 24 hours, shown
on that row's icon, and people's reposts and replies. A person sees stories only while their
`stories` user setting is `true`.

```ts
const stories = new StoriesModule(
    config,
    chatMedia,
    compute,
    tasks,
    bots,
    team,
    userSettings,
    artifacts,
);
```

| Module               | Why                                                               |
| -------------------- | ----------------------------------------------------------------- |
| `ConfigModule`       | Where a story's snapshot is kept, to serve it                     |
| `ChatMediaModule`    | Snapshots the posted file, like `present_files`, and round videos |
| `ComputeModule`      | Reads the file from the agent's machine under its permissions     |
| `TasksModule`        | The posting task and its owner                                    |
| `BotsModule`         | The posting bot and its Stories switch                            |
| `TeamModule`         | Every member a post may reach, and the person an agent works for  |
| `UserSettingsModule` | The `stories` setting, read for each person                       |
| `ArtifactsModule`    | The shared streamed upload a person's story files arrive through  |

## Posting

`post_story { path, caption?, replaces? }` is offered only to a task's own agent when the task owner has
stories on, checked once when assembling the turn's tools. There is no last-sender rule or
execution-time recheck. A bot's own agent gets the same tools only when its bot's Stories switch
is on (off by default). The file is measured before it is read: it must be a non-empty regular file within the
chat media limit, named as an image (one that decodes) or with an `.mp4` extension; a video's bytes must open with
an MP4 `ftyp` box and carry an `avc1` or `avc3` sample entry. The tool
call's ID is the story's ID: a replayed call returns the story it first posted, even an ended one,
without inserting or announcing anything. Media is served only while its snapshot is present.
An agent may keep any number of live frames; the prompt asks for one frame per part of a multipart
update and states the 9:16 viewer's safe area. `replaces` names up to twenty own live originals to remove with their reposts in the posting
transaction; other IDs are ignored, and the result names the replaced originals.

The same agent also gets `list_stories` (its live stories and reposts of them, with seen and reply
counts and the latest 50 replies) and `delete_story` (one of its own stories, with its reposts).

## Reposts, replies, and deleting

A person may also post their own image or H.264 MP4. Current clients stream each file through
`POST /v0/artifact-uploads` and post JSON referencing the uploads: the base media and up to eight
media layers, each its own stored file with its own placement. The daemon reads each upload's kind
from its bytes, checks a video's box headers without reading its frames, and links the bytes into
chat media's store; nothing is composed or re-encoded. Older clients still send binary multipart
with optional text and round layers. These stories have no agent, task, or bot; every non-guest member with
stories on sees them, only their poster deletes them, and their replies stay with the story.
Layer positions are normalized centers, persisted separately from the media. `agentId` remains
the chat target for agent stories and reposts and is null for person originals.

A repost references the original's agent, task, media, and media layers, copying no bytes, and
reaches every non-guest team member with stories on; it may add media layers of its own, and
shows the original's text when it has none; its caption, optional round MP4 (16 MiB, checked like a posted video),
reposter, and lifetime are its own. A reply is stored with the story and sent to the story's agent
as the replier's own user message quoting the story, delivered in the agent's current mode, so the
agent answers it like anything the person typed. `canDelete` is computed per reader: a task's owner
deletes their task's agent stories, a person their own stories and reposts, and anyone standalone.
The agent deletes its own originals. Deleting ends the story and its reposts (they read
as missing at once) and announces `story.removed` to everyone who saw them.

## Reading

A task agent's original reaches everyone who joined the task while it is active and their stories
are on. Joining, leaving, archiving, and unarchiving send each affected reader `story.changed` or
`story.removed` for the task's live originals, so nobody refetches. The desktop bootstrap carries
`storiesEnabled` and the same feed `GET /v0/stories` lists. A bot's originals reach non-guest teammates with personal stories on while the bot is active
and its Stories switch is on. Hiding an archived task's originals keeps a reply from waking its archived agent. Person
stories and reposts reach every non-guest teammate with stories on. Anything else reads as
missing, so the API answers `404`. Each post computes, inside its
transaction, the copy every eligible reader is served, and announces them after commit; seen state
is per reader, so `story.changed` and `story.removed` are delivered to one reader at a time.

## Storage

Migration `001-stories`: `happy_agent_module_stories` holds each story's record with its
`expires_at`, and `happy_agent_module_story_seen` one row per story and person who opened it.
Migration `002-story-replies` adds `happy_agent_module_story_replies`. A deleted story is ended by
setting its `expires_at` to 0 and dropping its seen and reply rows. Ended stories are never served
and are deleted with their seen and reply rows on the next post. Media, round, and media layer bytes
live in chat media's content-addressed store and are served by the shared `sendStoredFile`, with
byte ranges, ETags, and immutable caching. A legacy round is also served as the media layer
`round`.
