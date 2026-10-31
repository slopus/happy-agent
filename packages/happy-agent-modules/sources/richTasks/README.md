# Rich tasks

`RichTasksModule` interprets the reserved `tasks.rich` user setting, so the settings store stays
opaque and Tasks needs no path to it. Work follows the setting of the person it belongs to: a
task's owner in team mode, or the standalone installation's one person. Only JSON `true` turns it
on, and only while the daemon serves rich tasks.

```ts
const richTasks = new RichTasksModule(config, tasks, team, userSettings);
```

| Module               | Why                                                       |
| -------------------- | --------------------------------------------------------- |
| `ConfigModule`       | `taskSections`: whether rich tasks are served at all      |
| `TasksModule`        | Asks this module whether naming should pick a task's icon |
| `TeamModule`         | Reads a team member's settings as that member             |
| `UserSettingsModule` | The setting itself                                        |

Rich tasks are built in steps and switched on together with `capabilities.taskSections`. Until
then `ConfigModule.taskSections` is false unless `HAPPY_AGENT_TASK_SECTIONS=1`, and with it off
nothing here changes what the daemon does.

## Public methods

- `isOn(ctx, userId)` — whether rich tasks are on for a team member, or for the standalone person
  when `userId` is absent.
