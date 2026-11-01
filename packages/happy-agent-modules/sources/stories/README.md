# Stories

An image or short video a task's or bot's own agent posts for 24 hours, shown on that row's icon.
A person sees stories only while their `stories` user setting is `true`.

```ts
const stories = new StoriesModule(config, chatMedia, compute, tasks, bots, team, userSettings);
```

| Module               | Why                                                              |
| -------------------- | ---------------------------------------------------------------- |
| `ConfigModule`       | Where a story's snapshot is kept, to serve it                    |
| `ChatMediaModule`    | Snapshots and measures the posted file, like `present_files`     |
| `ComputeModule`      | Reads the file from the agent's machine under its permissions    |
| `TasksModule`        | The posting task, and who is a member of it                      |
| `BotsModule`         | The posting bot                                                  |
| `TeamModule`         | Every member a post may reach, and the person an agent works for |
| `UserSettingsModule` | The `stories` setting, read for each person                      |

## Posting

`post_story { path, caption? }` is offered only to a task's or bot's own agent, and only while
the person it works for has stories on: the latest identified human sender in its conversation,
recorded by this module as messages are accepted, else a task's owner (a task created by another
agent hears only agents), or a standalone installation's one person. When the latest human was an
exported bot's guest, the agent works for nobody and gets no tool. The call checks again before
posting. The file is measured before it is read: it must be a non-empty regular file within the
chat media limit, named as an image (one that decodes) or with an `.mp4` extension. The tool
call's ID is the story's ID: a replayed call returns the story it first posted, even an ended one,
without inserting or announcing anything. Media is served only while its snapshot is present.

## Reading

A task's story reaches its members, a bot's story every member; each reader must also have stories
on. Anything else reads as missing, so the API answers `404`. Each post computes, inside its
transaction, the copy every eligible reader is served, and announces them after commit; seen state
is per reader, so `story.changed` is delivered to one reader at a time.

## Storage

Migration `001-stories`: `happy_agent_module_stories` holds each story's record with its
`expires_at`, and `happy_agent_module_story_seen` one row per story and person who opened it.
Ended stories are never served and are deleted with their seen rows on the next post. The media
bytes live in chat media's content-addressed store.
