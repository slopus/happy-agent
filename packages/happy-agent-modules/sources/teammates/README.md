# Teammates

The people on a team, as a task's agent sees them, and telling one of them about that task.

- `list_teammates` lists every member who signs in (guests left out) with their Happy user ID,
  name, `role`, and what they `follow`. Members set `role` and `follows` through
  `PATCH /v0/profile`; a machine can seed them under `[feature.team.members.<subject>]`.
- `notify_teammate { userId, reason }` forwards the mention to that member's own Prioritizing
  (Focus) as a waking notice that carries the task, the reason, and the member's role and follows.
  Nothing joins here. A member without Stem Cells has no Prioritizing, and the tool says so.
  The tool returns the `<happy-user id="…"/>` mention tag either way.
- The member's Prioritizing decides. Its `join_task { taskId, note }` (owned by Spaces) joins its
  own person through `TasksModule.loopIn`, which clears an explicit leave, ignores
  `tasks.autoJoin`, and marks the membership `unread` with `reason: "looped_in"`. The row then
  arrives as new work for it to place.
- The mark is the member's own. It travels on their membership in task reads, the desktop
  bootstrap, and `task.joined` / `task.membership.updated` events. It clears with
  `POST /v0/tasks/:taskId/read` or the task agent's `POST /v0/agents/:agentId/read`.

Kirill's design: "forward this message to their focus agent — everyone has their own focus
agent." Only a person's own Prioritizing changes how their sidebar is organized, so another
person's agent never adds them to work directly. This works in team mode only, because a standalone
installation has one person, and only a task's agent gets the tools.
