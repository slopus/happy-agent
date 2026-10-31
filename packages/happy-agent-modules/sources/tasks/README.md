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
    titles,
    projects,
    workspaces,
    runners,
    compute,
    durableFunctions,
    collaboration,
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
`STANDALONE_TASK_MEMBER`, joins every task created there. `TaskAutoJoinModule` additionally joins
every enrolled team member to active tasks by default unless their `tasks.autoJoin` preference is
boolean `false`; guests are excluded. This includes tasks created without an identified owner.
`memberFor(userId)` maps a person to their member key: the user ID
in team mode, the standalone member otherwise. `join` and `leave` are idempotent; moving a task to
the place it already holds changes nothing. The global list is every task, oldest first. Leaving
never archives a task, not even when its owner or its last member leaves, and archiving never
removes a membership.

Explicit leaves are retained separately, including leaving before joining. Automatic membership
never reverses one, across restarts or preference changes; an explicit join clears the exclusion.
`joinAutomatically` joins at most 100 missing active tasks per call, or one specified task, leaving
existing order untouched. Startup catch-up invokes it in bounded transactions, while live task,
profile, and preference mutations compose participation inside their originating transaction.

A member may also hide a task (`setHidden`): it keeps its place and stays in every list. Sections
(`sections`, `replaceSections`) are a member's own headers, keyed in the same space as their
memberships: a task belongs to the last header below its key, so `reorder` after a task or into a
section changes only the moved task's key, and an older client sees the same order. Moving a section
takes the tasks under it along; removing one leaves every key alone. New memberships go above the
first header.

A task's child choices (`children`, `setChild`) say whether one workspace, agent, or artifact shows
under it: `"shown"`, `"hidden"`, or `null` to forget the choice and return to the default. They are
shared by every member, at most 200 per task, and a change advances the task's version and publishes
`task_updated` with the whole `children` array. The module stores them without checking that the
child exists; `ApiModule` checks on a choice and leaves out choices whose child is gone.

## Name and icon

An unnamed task starts as `New Task`. With rich tasks off, its first text-bearing message starts
the ordinary durable `tasks.name` title job. `RichTasksModule` supplies the current owner setting
through `decideIdentityWith`: a rich task chooses both fields itself with the ordinary tools
owned by `TaskIconsModule`, and no naming job runs. An already-running job rechecks before writing.

`update` applies a person's title, icon (`null` for none), or both. `setIdentityForAgent` resolves
the calling agent's own task and uses the same write path. A person's choice is final for that
field, including submitting the same title or clearing an icon. `nameAgentChosen` marks a title
a model chose, the task's own or the naming job's, so the task can refine it until a person
chooses one. Icons remain logical slugs in storage; the API
derives the artwork digest from the current bundled catalog.

## Tools

Offered to every root agent that is not a task, which means bots and human-owned roots. Tasks and
subagents receive none: a task delegates through subtasks. A bot kept inside its own tree by its
settings receives none either, and a task an agent creates stays governed by that agent's bot.

- `create_task` — `{ name, text? }`. Creates the task owned by the current sender, with the acting
  agent as `creatorAgentId`. `text` is delivered from the creator as the task's first message in
  the creating transaction, using the task's agent ID as its message ID. Durable: the task ID is
  minted once in the call's own store.
- `list_tasks` — `{ scope?, status?, offset?, limit? }`. A bounded page of at most 50 tasks with
  owner, creator, and folder; follow `nextOffset`. `scope: "all"` (the default) lists every task,
  oldest first; `scope: "joined"` lists the tasks joined by the person the conversation works for,
  in that person's order, and fails when no person is identified in team mode.
- `send_task_message` — `{ taskId, explanation, text }`. Delivers into an active task's
  conversation, keyed by the tool call ID. `explanation` is 2–8 words saying what the message says,
  stamped as `senderAgentExplanation`; the opening message of a named task uses the task's name.
- `archive_task` — `{ taskId }`. Only the creating agent may archive through the tool. Reviewed
  in Auto, never elevated.

The same agents are told to mention a task as `[name](happy://agents/<agentId>)` with the task's
agent ID, never its task ID; `create_task` and `list_tasks` give that exact link. Clients show the
task's live name as the link text.

A task's own agent receives its identity prompt from this module. `BotsModule` gives it
`list_bots` and `send_bot_message` (never `create_bot`) and, when a bot created it, names that bot
so the task reports back to it. `SubtasksModule` gives it the same coordinator guidance and
`create_subtask` eligibility as a bot.

## Public operations

`list`, `listForMember`, `get`, `membership`, `memberFor`, `forAgent`, `forWorkspace`,
`hasIdentity`, `create`, `createWithResult`, `sendMessage`, `update`, `setIdentityForAgent`, `decideIdentityWith`, `join`, `joinAutomatically`, `leave`, `reorder`, `setHidden`, `sections`, `replaceSections`, `children`, `setChild`,
`archive`, `archiveForAgent`, `unarchive`, `purge`, and `onEvent`. Task mutations take an expected version
and raise `TaskConflictError` when the row moved; memberships are unversioned because each list
has one writer. `task_created`, `task_updated`, `task_joined`, `task_reordered`, `task_left`,
`task_membership_updated` (with the membership before and after), and `task_sections_updated` events
are published after commit.

Archival aborts the task's agent and descendants, marks the agent archived, and invokes the
`tasks.archive` durable function, all in one transaction; the function ends the archived agent's
machine and background processes after commit and survives restarts. Restoration cancels pending
cleanup and clears the agent's archival. The folder is never deleted by archival.

`purge(ctx, taskId)` deletes an archived task for good, for an admin's permanent deletion: its
folder, then its row with every membership and recorded leave in one transaction that cancels any
pending archive cleanup and publishes `task_deleted`. Its agent is the caller's to erase first.

## Storage

`happy_agent_module_tasks` holds the catalog, with unique `folder_name`, `workspace_id`,
`agent_id`, and `path` columns. `happy_agent_module_task_members` holds one row per task and
member with that member's order key. The module name once belonged to a per-agent checklist; its
released `001-task-state` migration stays first, `002-task-list-removed` drops that table, and
`003-task-catalog` creates the catalog and memberships.
Migration `005-task-explicit-leaves` adds a per-member/task exclusion table for automatic joining.
Migration `008-task-icon` adds the nullable `icon` slug and `icon_configured`, set once a person
picks the icon.
Migration `011-task-agent-title-choice` adds `name_agent_chosen`, set by the task's own and the
naming job's titles; a person's title update clears it.
Migration `009-task-sections` adds the nullable membership `hidden` flag and
`happy_agent_module_task_sections`, one row per section with its member and order key.
Migration `010-task-children` adds `happy_agent_module_task_children`, one row per task and child
with its visibility, who chose it, and when.

The HTTP contract for tasks is specified in the Tasks chapter of `packages/happy-agent/API.md`
and typed in `@slopus/happy-agent-client`. `ApiModule` serves it from this module's public
operations: the list, read, join, leave, reorder, archive, and unarchive routes, the `task.*`
events (membership events private to their member in team mode), and the bootstrap `tasks` and
`taskMemberships`. People archive through the API only when they own the task or own the team;
on a standalone installation the one person may archive every task.
