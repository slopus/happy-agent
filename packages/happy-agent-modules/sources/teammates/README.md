# Teammates

The people on a team, as a task's agent sees them, and looping one of them into that task.

- `list_teammates` lists every member who signs in (guests left out) with their Happy user ID,
  name, `role`, and what they `follow`. Members set `role` and `follows` through
  `PATCH /v0/profile`; a machine can seed them under `[feature.team.members.<subject>]`.
- `loop_in_teammate { userId, reason }` adds that member to the agent's own task through
  `TasksModule.loopIn`. They join it even when `tasks.autoJoin` is off, an explicit leave is
  cleared, and their membership is marked `unread` with `reason: "looped_in"` and the agent's
  one-sentence reason. Someone already in the task keeps their place and is marked again. The tool
  returns the `<happy-user id="…"/>` mention tag.
- The mark is the member's own: it travels on their membership in task reads, the desktop
  bootstrap, and `task.joined` / `task.membership.updated` events, and clears with
  `POST /v0/tasks/:taskId/read` or the task agent's `POST /v0/agents/:agentId/read`.

Team mode only, and only a task's agent gets the tools: a standalone installation is one person.
Whether someone should be looped in is the agent's judgement, made through its instructions.
