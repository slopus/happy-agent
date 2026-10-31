# Stories

A story is one image or video a task's or bot's agent posts on its card for a day, or a person
reposts. Each is an artifact of type `story` (entry `story.json`, plus a repost's round video),
made only here; the artifact catalog hides it from everyone who does not ask for `type=story`.

```ts
const stories = new StoriesModule(artifacts, tasks, bots, team, richTasks, focus, history);
```

| Module            | Why                                                              |
| ----------------- | ---------------------------------------------------------------- |
| `ArtifactsModule` | Stores each story as a `story` artifact and reads the frame file |
| `TasksModule`     | The posting task and its owner, its name, and the member key     |
| `BotsModule`      | The posting bot, its name, and un-hiding it for those it reaches |
| `TeamModule`      | Team members, the team owner, and a reposter's name              |
| `RichTasksModule` | Tools follow `tasks.rich`; the person a bot's turn answers       |
| `FocusModule`     | A posted task story wakes Focus                                  |
| `HistoryModule`   | Replies, read back and counted from the reply agent's chat       |

## Posting

`set_story` names an image or video artifact (its latest version and entry by default); agents
publish a screenshot or recording with `create_artifact` first. Each poster has one live story
per audience: posting marks the last one `replaced`, `null` marks it `taken_down`. `"owner"` is the
person the agent works for; `"team"` is everyone and is always reviewed in Auto, allowed only when
a person asked. The story artifact's ID lives in the call's KV, so a repeated call finds it.

## Reading

Owner-audience stories are visible only to their person, team stories to every member. That one
rule (`canSee`) decides the `/v0/stories` routes, `?type=story` artifact reads, and who receives
`story.changed`. `expired` is never stored: a live story past `expiresAt` reads as expired.
`get_card` gives the agent its own card: title and icon with who set them, its status line, its
stories (live first, then those ended in the last 7 days), and the task's child choices.

## Replies

A reply is the replier's own message to the story's `replyAgentId`, sent with `replyTo` and
stored in History like any other. The API checks the replier may see the story and that it was
sent to that agent. Just before the message, the agent gets one system line naming the story it
answers. History finds replies by an index on `replyTo.artifactId`, for the replies route and the
`replies` count; a reply counts once accepted.

## Storage

Migration `001-stories`: `happy_agent_module_stories` holds each story's record by artifact ID with
its poster key (`agent:<id>` or `user:<member>`), and `happy_agent_module_story_seen` one row per
story and member who opened it.
