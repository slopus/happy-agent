# Rich tasks

`RichTasksModule` interprets the reserved `tasks.rich` user setting, so the settings store stays
opaque and Tasks needs no path to it. Work follows the setting of the person it belongs to: a
task's owner in team mode, or the standalone installation's one person. Only JSON `true` turns it
on.

```ts
const richTasks = new RichTasksModule(tasks, team, userSettings);
```

| Module               | Why                                                       |
| -------------------- | --------------------------------------------------------- |
| `TasksModule`        | Asks this module whether naming should pick a task's icon |
| `TeamModule`         | Reads a team member's settings as that member             |
| `UserSettingsModule` | The setting itself                                        |

The daemon serves the rich-task fields and routes to every client with `capabilities.taskSections`;
this setting alone decides what a person's agents are given and asked, and with it off they get
exactly what they got before rich tasks.

## Public methods

- `isOn(ctx, userId)` — whether rich tasks are on for a team member, or for the standalone person
  when `userId` is absent.
