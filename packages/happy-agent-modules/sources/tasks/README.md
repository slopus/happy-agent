# Tasks

A task is a persistent, user-visible conversation with a dedicated folder of its own. It is
modeled on a bot and works like one: one root agent for its whole life, one immutable folder,
a dedicated workspace identity, archival and restoration, and messaging from other agents. It
differs from a bot in four ways:

- it has no avatar, no administrator status, and no system key;
- it records its owner, the team user whose message led to its creation, and the agent that
  created it;
- it has no catalog order: each person who joins it keeps it in their own ordered list;
- it is a root of subtasks, exactly like a bot: task → subtask → subtask.

```ts
const tasks = new TasksModule(
    config,
    abort,
    projects,
    workspaces,
    runners,
    compute,
    durableFunctions,
);
```

`BotsModule` and `SubtasksModule` take this module. The tasks module does not know about bots.

## Folders

A task's folder is `~/Happy/Tasks/<folderName>`, beside `~/Happy/Bots`, or the same layout under
the default runner's home while runners are configured. `folderName` is derived from the display
name in snake_case, with a numeric suffix on collision, and never changes. Creation is one
transaction: the row, the root agent (titled with the task name, working in the folder), the
folder, and the optional opening message. The folder is made after the unique columns accept the
row, and an existing directory left by a rolled-back creation is taken up again.

## Owner

The module records, per agent, the latest human sender in consumption order: a user message
marked as human origin sets it to the message's team `userId`, or clears it when the human is
unidentified. Agent-generated messages never change it. A task created through `create_task`
takes the acting agent's current sender as `ownerUserId`. A standalone installation has no team
user IDs, so its tasks have no owner. A caller creating a task directly passes `ownerUserId`
itself. The owner is shown to models as the installation-local user ID, which team sender
notifications already pair with the person's name.

## Memberships

Any person may join any task, archived ones included, and leave it again. A membership puts the
task in that person's own list and holds its place there with an order key that belongs to that
person alone, so `reorder` moves a task only in the caller's list. A new membership goes to the
top. The owner joins when the task is created; on a standalone installation the one person,
`STANDALONE_TASK_MEMBER`, joins every task created there. In team mode a task created without an
identified person joins nobody. `memberFor(userId)` maps a person to their member key: the user ID
in team mode, the standalone member otherwise. `join` and `leave` are idempotent; moving a task to
the place it already holds changes nothing. The global list is every task, oldest first.

## Tools

Offered to every root agent that is not a task, which means bots and human-owned roots. Tasks and
subagents receive none: a task delegates through subtasks.

- `create_task` — `{ name, text? }`. Creates the task owned by the current sender, with the acting
  agent as `creatorAgentId`. `text` is delivered from the creator as the task's first message in
  the creating transaction, using the task's agent ID as its message ID. Durable: the task ID is
  minted once in the call's own store.
- `list_tasks` — `{ scope?, status?, offset?, limit? }`. A bounded page of at most 50 tasks with
  owner, creator, and folder; follow `nextOffset`. `scope: "all"` (the default) lists every task,
  oldest first; `scope: "joined"` lists the tasks joined by the person the conversation works for,
  in that person's order, and fails when no person is identified in team mode.
- `send_task_message` — `{ taskId, text }`. Delivers into an active task's conversation, keyed by
  the tool call ID.
- `archive_task` — `{ taskId }`. Only the creating agent may archive through the tool. Reviewed
  in Auto, never elevated.

A task's own agent receives its identity prompt from this module. `BotsModule` gives it
`list_bots` and `send_bot_message` (never `create_bot`) and, when a bot created it, names that bot
so the task reports back to it. `SubtasksModule` gives it the same coordinator guidance and
`create_subtask` eligibility as a bot.

## Public operations

`list`, `listForMember`, `get`, `membership`, `memberFor`, `forAgent`, `forWorkspace`,
`hasIdentity`, `create`, `createWithResult`, `sendMessage`, `rename`, `join`, `leave`, `reorder`,
`archive`, `archiveForAgent`, `unarchive`, and `onEvent`. Task mutations take an expected version
and raise `TaskConflictError` when the row moved; memberships are unversioned because each list
has one writer. `task_created`, `task_updated`, `task_joined`, `task_reordered`, and `task_left`
events are published after commit.

Archival aborts the task's agent and descendants, marks the agent archived, and invokes the
`tasks.archive` durable function, all in one transaction; the function ends the archived agent's
machine and background processes after commit and survives restarts. Restoration cancels pending
cleanup and clears the agent's archival. The folder is never deleted.

## Storage

`happy_agent_module_tasks` holds the catalog, with unique `folder_name`, `workspace_id`,
`agent_id`, and `path` columns. `happy_agent_module_task_members` holds one row per task and
member with that member's order key. The module name once belonged to a per-agent checklist; its
released `001-task-state` migration stays first, `002-task-list-removed` drops that table, and
`003-task-catalog` creates the catalog and memberships.

The HTTP contract for tasks is specified in the Tasks chapter of `packages/happy-agent/API.md`
and typed in `@slopus/happy-agent-client`; the daemon routes, events, and bootstrap fields follow
once that client version is published.
