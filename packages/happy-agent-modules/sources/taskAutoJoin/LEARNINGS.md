# Automatic task participation — learnings

## Default participation belongs to each enrolled person

People previously saw only tasks they created or joined manually. Every enrolled team member now
joins active tasks by default, including existing tasks, unless their `tasks.autoJoin` setting is
boolean `false`. Guests never acquire shared task memberships. Disabling preserves the person's
list; re-enabling fills missing active tasks. Explicit leaves persist until a manual join so a
restart or preference change cannot undo a person's decision to close a task.

The coordination lives in its own module because Team already depends on Tasks. Making Tasks
depend on user settings would close that cycle. Transactional events keep enrollment, applied
preference changes, and task creation atomic with participation while the settings store stays
opaque. Startup catch-up uses Durable Functions and bounded batches that recheck the preference.

## Seeded members can start opted out

A demo team needed a member who does not join every task. A member listed under
`[feature.team.members]` with `auto_join_tasks = false` gets `tasks.autoJoin = false` saved when
their profile is first created, only if the setting was never written, before the first catch-up
join. It is the ordinary setting afterwards, so the member can turn it back on. An agent's
`loop_in_teammate` still adds them to a task: looping in is a direct choice, not automatic joining.
