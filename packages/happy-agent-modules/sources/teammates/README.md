# Teammates

The people on a team, as a task's agent sees them, and looping one of them into that task.

- `list_teammates` lists every member who signs in (guests left out) with their Happy user ID,
  name, `role`, and what they `follow`. Members set `role` and `follows` through
  `PATCH /v0/profile`; a machine can seed them under `[feature.team.members.<subject>]`.
- `loop_in_teammate { userId, reason }` adds that member to the agent's own task through
  `TasksModule.loopIn`. They join it even when `tasks.autoJoin` is off, an explicit leave is
  cleared, and their membership is marked `unread` with `reason: "looped_in"` and the agent's
  one-sentence reason. Someone already in the task keeps their place and is marked again. The tool
  returns the `[name](happy://users/<userId>)` mention link.
- The mark is the member's own: it travels on their membership in task reads, the desktop
  bootstrap, and `task.joined` / `task.membership.updated` events, and clears with
  `POST /v0/tasks/:taskId/read` or the task agent's `POST /v0/agents/:agentId/read`.

A bot's agent gets the same tools while the person its turn answers has `tasks.rich` on
(`RichTasksModule.isOnForAgent`, fed by `notePerson` from this module's own message hook). Looping
someone in from a bot joins them to nothing: `BotsModule.updateMembership` shows the bot to that
person again and marks it unread with the reason, in one change and one event, and nobody else's
state moves. That is how a hidden bot running on its own schedule comes back for the one person it
picked.

Team mode only: a standalone installation is one person. Whether someone should be looped in is
the agent's judgement, made through its instructions.

```ts
const teammates = new TeammatesModule(tasks, team, bots, richTasks);
```
