# Rich tasks

`RichTasksModule` interprets the reserved `tasks.rich`, `tasks.sections`, and `tasks.focus` user
settings, so the settings store stays opaque and Tasks needs no path to it. Work follows the
setting of the person it belongs to: a task's owner, a bot's person for the turn, or the
standalone installation's one person. Only JSON `true` turns a setting on.

```ts
const richTasks = new RichTasksModule(tasks, team, userSettings);
```

| Module               | Why                                                       |
| -------------------- | --------------------------------------------------------- |
| `TasksModule`        | Asks this module whether naming should pick a task's icon |
| `TeamModule`         | Reads a team member's settings as that member             |
| `UserSettingsModule` | The settings themselves                                   |

The daemon serves the rich-task fields and routes to every client with `capabilities.taskSections`;
these settings alone decide what a person's agents are given and asked, and with them off agents
get what they got before rich tasks, apart from `set_status`, which needs `tasks.rich`.

## Card tools

A module that gives an agent a card tool (`set_status` today) gates it at tool assembly with
`isOnForAgent`, never with a refusal at run time, so with the setting off the tool is simply not
offered. A task agent follows its task's owner. Any other agent follows the person whose message
its turn answers, which module stores cannot share, so the gating module also calls `notePerson`
from its own `messageAcceptedTransact` hook to keep that person in its own store.

## Public methods

- `isOn(ctx, userId, setting?)` — whether a setting, `tasks.rich` by default, is on for a team
  member, or for the standalone person when `userId` is absent.
- `isOnForAgent(ctx, scope, setting?)` — the same for the person an agent's turn works for.
- `notePerson(ctx, kv, accepted)` — records a person's message as the one the agent's turn answers.
