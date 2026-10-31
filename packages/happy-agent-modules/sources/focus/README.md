# Focus

Focus arranges one person's task list while they have `tasks.focus` on: one long-running,
unlisted agent of Happy per person, whose instructions are `FOCUS_INSTRUCTIONS` and whose only
tool is `organize_tasks`. What to move or hide is Focus's decision, made through its prompt; the
code enforces only that a person's own placement wins.

```ts
const focus = new FocusModule(
    config,
    durableFunctions,
    richTasks,
    tasks,
    bots,
    collaboration,
    userSettings,
);
```

| Module                   | Why                                                            |
| ------------------------ | -------------------------------------------------------------- |
| `ConfigModule`           | The installation's default model, which a new Focus runs on    |
| `DurableFunctionsModule` | `focus.brief`, which creates or briefs Focus after commit      |
| `RichTasksModule`        | `tasks.focus`, and `tasks.sections` for showing sections       |
| `TasksModule`            | The list it reads and arranges, and the events that wake Focus |
| `BotsModule`             | Happy, Focus's parent, and telling bots apart from tasks       |
| `CollaborationModule`    | Creating Focus as an unlisted agent of Happy                   |
| `UserSettingsModule`     | Turning Focus on and off                                       |

## Waking

Notices collect per person; the first arms a two-second timer, so a burst of turns becomes one
brief. When it fires while Focus is mid-turn, the brief waits for that turn to end. The brief is
the person's whole list, top first, with their sections while `tasks.sections` is on and each
task's status line, open question, unread, hidden, and held marks, then what changed since the
last brief. Notices come from:

- a task joining the person's list, or getting its first message;
- a task's status line changing, or its agent asking a question;
- a person writing to a task's agent;
- the person moving, hiding, showing, or sectioning a row, which holds it;
- a task being archived;
- `noticeTask`, for other modules' news, such as a story posted.

Focus's own writes run in a transaction marked by a context namespace and never notice anything.
Notices live in memory: a restart drops the ones still collecting, and the next brief carries the
whole list anyway. The decided brief itself is a durable call, so it survives a restart.

## Held rows

A task the person moved, hid, or sectioned is held for them: `organize_tasks` skips moving or
hiding it as `held_by_person`. The hold ends when the task's status line changes, for every person.
Holds are recorded for everyone, Focus or not, so turning Focus on later still respects them.

## On and off

Turning `tasks.focus` on invokes `focus.brief`: it creates Focus under Happy with the brief as its
opening message, or briefs the existing one. Turning it off drops the person's pending notices and
stops a running turn; the arrangement Focus made stays, and the same Focus resumes when it is
turned on again. A Focus the person archived is replaced by a new one at the next brief.

## `organize_tasks`

`{ ops, note? }`, with `move` (a task, after a task, at the top, or first in a section) and `hide`
(a task, or a bot by `botId`), applied in order in one transaction through the Tasks and Bots
modules' own operations, so every change publishes its usual events after commit. Bots always stay
in their own section above the tasks: a `move` or task `hide` naming a bot is `bots_not_allowed`.
A bot the person hid or showed themselves is held through the bots module's own `held` flag, which
lasts until one of the bot's loop-ins shows it to them again; the brief lists every active bot
with its unread, hidden, and held marks. A skipped operation reports `held_by_person`,
`not_found`, or `bots_not_allowed`; the rest still apply. A call made after `tasks.focus` went off
answers `{ "error": "off" }`. It needs no review in Auto: it only rearranges the person's own list.

Deferred: creating, renaming, moving, and removing sections, and child visibility. Focus files
tasks under sections the person already has, such as "Shipped".

## Storage

Migration `001-focus` creates `happy_agent_module_focus_agents`, each person's Focus agent, and
`happy_agent_module_focus_held`, one row per person and held task.
